package dev.verikun.companion;

import android.app.UiAutomation;
import android.graphics.Point;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.File;
import java.io.OutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

/**
 * A resident UI-hierarchy dumper, run under app_process as the shell user.
 *
 * WHY THIS EXISTS. `adb shell uiautomator dump` costs ~2.4s on a mid-range phone, and
 * only ~0.1s of that is work. The rest is paid fresh on every single invocation:
 *
 *   ~1.22s  starting ART and loading uiautomator.jar (it is not in the boot image, so it
 *           is verified from scratch each time)
 *   ~1.00s  AOSP's DumpCommand hardcodes `uiAutomation.waitForIdle(1000, 10000)` — a
 *           mandatory second of accessibility silence, even on a frozen screen. Its own
 *           comment says it is partly there because "the bridge needs time to be ready"
 *           after connecting, which is a cost a warm connection simply does not have.
 *
 * Staying resident and holding one UiAutomation open removes both. This does NOT cache
 * the hierarchy — every request walks the live tree, exactly as before. It caches the
 * *connection*, which is a different thing, and leaves verikun's "re-capture fresh every
 * command" rule intact.
 *
 * Deliberately no APK: pushed to /data/local/tmp and started via app_process, the same
 * shape scrcpy uses. Nothing is installed, no root, and the package list is untouched.
 */
public final class CompanionApp {

    /** Bumped whenever the wire protocol or dump format changes. The host compares it via
     *  `ping` and restarts a daemon left behind by an older verikun, rather than talking to
     *  something that will answer in a shape it no longer understands. */
    private static final String PROTOCOL_VERSION = "1";

    /** Abstract socket name; the host reaches it with `adb forward tcp:PORT localabstract:NAME`.
     *  One daemon per device, so the name is fixed — the port on the host side is what varies. */
    private static final String SOCKET_NAME = "verikun-companion";

    /** Shut down after this long with no request, so a forgotten daemon does not hold a
     *  UiAutomation connection (and the accessibility suppression that comes with it) for
     *  the rest of the day. Any read starts a fresh one in ~1.5s. */
    private static final long IDLE_SHUTDOWN_MS = 15 * 60 * 1000;

    private static UiAutomation uiAutomation;
    /** The UiAutomationShellWrapper we are holding, so release() can disconnect it. */
    private static Object heldWrapper;
    private static Class<?> wrapperClass;
    private static Method dumpMethod;
    private static volatile long lastRequestAt = System.currentTimeMillis();
    /** Which display size the host calibrated this device to, or null until it has.
     *  Held HERE rather than in a file on the host: the companion outlives any single `vk`
     *  process, so a later process can just ask instead of re-deriving (or worse, keeping a
     *  host-side cache that can disagree with the process actually serving dumps). */
    private static volatile String calibratedDims;
    /** When some process claimed the right to calibrate, or 0 if nobody holds it.
     *
     *  Calibration needs the device's ONE UiAutomation connection exclusively — it works by
     *  RELEASING the connection to take a real `uiautomator dump` — so two processes doing it
     *  at once SIGKILL each other's dump. The lock lives here, in the single-threaded accept
     *  loop, because the obvious host-side primitive does not work: Android's toybox `mkdir`
     *  SUCCEEDS on an existing directory, so a `mkdir` lock silently grants itself to
     *  everyone. */
    private static volatile long calibrationClaimedAt;

    /** A claimer that dies mid-calibration must not wedge every later process. Comfortably
     *  longer than a calibration (~5s) and far shorter than a person waiting. */
    private static final long CLAIM_STALE_MS = 45_000;

    public static void main(String[] args) throws Exception {
        // app_process gives us no main Looper; UiAutomation needs one to deliver callbacks on.
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();

        connect();
        resolveDumper();

        LocalServerSocket server = new LocalServerSocket(SOCKET_NAME);
        System.out.println("verikun companion listening on " + SOCKET_NAME + " (protocol " + PROTOCOL_VERSION + ")");
        System.out.flush();

        startIdleWatchdog();

        for (;;) {
            LocalSocket client = server.accept();
            try {
                serve(client);
            } catch (Throwable t) {
                // One bad request must never take the daemon down: the host would silently
                // fall back to `uiautomator dump` and lose the speedup for the whole run.
                System.err.println("request failed: " + t);
                // ANSWER, even in failure. Writing nothing leaves the host with an empty
                // reply, which is exactly what a dead process looks like through `adb
                // forward` — so a live companion with a fixable complaint ("released — call
                // acquire first") was being misdiagnosed as gone, and every later read fell
                // back to the slow path without anyone being able to see why.
                try {
                    client.getOutputStream().write(("ERROR " + t + "\n").getBytes("UTF-8"));
                    client.getOutputStream().flush();
                } catch (Throwable ignored) { }
            } finally {
                try { client.close(); } catch (Throwable ignored) { }
            }
        }
    }

    /**
     * Borrow the platform's own UiAutomationShellWrapper rather than reimplementing the
     * hidden UiAutomation(Looper, IUiAutomationConnection) dance. It ships in
     * /system/framework/uiautomator.jar on every device that has `uiautomator dump` at all,
     * which is exactly the set we are trying to be faster than. Reflection is only needed to
     * *construct* it — what comes back is a plain android.app.UiAutomation.
     */
    private static void connect() throws Exception {
        wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
        Object wrapper = wrapperClass.getConstructor().newInstance();
        wrapperClass.getMethod("connect").invoke(wrapper);
        // Verbose (uncompressed) hierarchy — the same default `uiautomator dump` uses, and the
        // one verikun's selectors expect. Compressed drops nodes an author may be selecting on.
        try {
            wrapperClass.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
        } catch (NoSuchMethodException ignored) {
            // Older platforms without the toggle already default to verbose.
        }
        uiAutomation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
        // The one unavoidable idle wait: right after connecting, the bridge genuinely is not
        // ready and calls into it throw. Paid ONCE per daemon, not once per read.
        uiAutomation.waitForIdle(1000, 10000);
        heldWrapper = wrapper;
    }

    /**
     * Drop the UiAutomation connection but stay running.
     *
     * This is what makes a fallback possible at all. Only ONE UiAutomation may be connected
     * per device, and the newcomer loses: while we hold it, `adb shell uiautomator dump`
     * is SIGKILLed (exit 137). So the host cannot simply "try the companion, else run the
     * stock command" the way it can for screenshots — it has to get us off the connection
     * first. Releasing rather than exiting keeps the warm ART process, so re-acquiring
     * later costs a reconnect instead of a whole cold start.
     */
    private static void release() throws Exception {
        if (heldWrapper == null) return;
        wrapperClass.getMethod("disconnect").invoke(heldWrapper);
        heldWrapper = null;
        uiAutomation = null;
    }

    /** AccessibilityNodeInfoDumper is what `uiautomator dump` itself serialises with, so
     *  reusing it means the XML on the wire is identical to what verikun already parses —
     *  no parser changes, no format drift. Its signature has moved across releases, so bind
     *  by shape rather than by an exact arg list. */
    private static void resolveDumper() throws Exception {
        Class<?> dumperClass = Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper");
        for (Method m : dumperClass.getMethods()) {
            Class<?>[] p = m.getParameterTypes();
            if (m.getName().equals("dumpWindowToFile") && p.length == 5
                    && p[0] == AccessibilityNodeInfo.class && p[1] == File.class) {
                dumpMethod = m;
                return;
            }
        }
        for (Method m : dumperClass.getMethods()) {
            Class<?>[] p = m.getParameterTypes();
            if (m.getName().equals("dumpWindowToFile") && p.length == 2
                    && p[0] == AccessibilityNodeInfo.class && p[1] == File.class) {
                dumpMethod = m;
                return;
            }
        }
        throw new IllegalStateException("no usable AccessibilityNodeInfoDumper.dumpWindowToFile");
    }

    private static void serve(LocalSocket client) throws Exception {
        lastRequestAt = System.currentTimeMillis();
        String request = readLine(client.getInputStream());
        OutputStream out = client.getOutputStream();

        String[] parts = request.trim().split("\\s+");
        String command = parts.length > 0 ? parts[0] : "";

        if (command.equals("ping")) {
            out.write(("verikun-companion " + PROTOCOL_VERSION + "\n").getBytes("UTF-8"));
        } else if (command.equals("size")) {
            Display d = realDisplay();
            Point real = new Point(), app = new Point();
            d.getRealSize(real);
            d.getSize(app);
            out.write(("real=" + real.x + "x" + real.y + " app=" + app.x + "x" + app.y
                    + " rotation=" + d.getRotation() + "\n").getBytes("UTF-8"));
        } else if (command.equals("state")) {
            // Everything the host needs to decide in ONE round trip: is this ours and current
            // (name + protocol), has it been calibrated, and is it holding the connection.
            // Two calls used to be needed, and each costs a spawned client process on the host.
            out.write(("verikun-companion " + PROTOCOL_VERSION + " "
                    + (calibratedDims == null ? "uncalibrated" : "ready " + calibratedDims) + " "
                    + (uiAutomation == null ? "released" : "held") + "\n").getBytes("UTF-8"));
        } else if (command.equals("claim-calibration")) {
            // Single-threaded accept loop: exactly one caller can be inside this branch at a
            // time, which is the whole point — this is the atomicity the shell could not give.
            boolean granted;
            long now = System.currentTimeMillis();
            if (calibratedDims != null) {
                granted = false; // already done; the caller should just read `state`
            } else if (calibrationClaimedAt == 0 || now - calibrationClaimedAt > CLAIM_STALE_MS) {
                calibrationClaimedAt = now;
                granted = true;
            } else {
                granted = false;
            }
            out.write((granted ? "granted\n" : "denied\n").getBytes("UTF-8"));
        } else if (command.equals("calibrated")) {
            calibratedDims = parts.length > 1 && parts[1].equals("real") ? "real" : "app";
            calibrationClaimedAt = 0;
            out.write(("calibrated " + calibratedDims + "\n").getBytes("UTF-8"));
        } else if (command.equals("release")) {
            release();
            out.write("released\n".getBytes("UTF-8"));
        } else if (command.equals("acquire")) {
            if (uiAutomation == null) connect();
            out.write("acquired\n".getBytes("UTF-8"));
        } else if (command.equals("dump")) {
            // Idle window is the CALLER's policy, not ours. The stock command's flat 1000ms is
            // most of what makes a read slow, and with a warm bridge it is buying much less
            // than it costs — but a mid-transition screen is a real failure mode, so the host
            // decides. 0 = dump immediately.
            long idleMs = parts.length > 1 ? Long.parseLong(parts[1]) : 0L;
            // Which display size to clip node bounds to. NOT a detail: the dumper clips every
            // node to it, so it decides the geometry verikun taps and scrolls against, and the
            // platform's own choice varies by build (AOSP's DumpCommand reads getRealSize();
            // an SM-A415F's stock dump matches getSize()). Rather than guess, the host
            // calibrates once against a real `uiautomator dump` and then always says which.
            boolean useReal = parts.length > 2 && parts[2].equals("real");
            out.write(dump(idleMs, useReal));
        } else if (command.equals("quit")) {
            out.write("bye\n".getBytes("UTF-8"));
            out.flush();
            System.exit(0);
        } else {
            out.write(("ERROR unknown command: " + command + "\n").getBytes("UTF-8"));
        }
        out.flush();
    }

    private static byte[] dump(long idleMs, boolean useRealSize) throws Exception {
        // Never silently reconnect here. A released companion means the host deliberately
        // handed the connection to something else; quietly taking it back would SIGKILL
        // whatever it handed it to. The host re-acquires explicitly.
        if (uiAutomation == null) throw new IllegalStateException("released — call acquire first");
        if (idleMs > 0) uiAutomation.waitForIdle(idleMs, 10000);

        AccessibilityNodeInfo root = uiAutomation.getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("null root node");

        Display display = realDisplay();
        Point size = new Point();
        if (useRealSize) display.getRealSize(size);
        else display.getSize(size);

        // The dumper writes to a File; /data/local/tmp is app-private-ish and on ext4, and the
        // write measured as noise next to everything else. Streaming it would need a
        // reimplementation of the serialiser and a second format to keep in sync.
        File tmp = new File("/data/local/tmp/verikun-companion-dump.xml");
        if (dumpMethod.getParameterTypes().length == 5) {
            dumpMethod.invoke(null, root, tmp, display.getRotation(), size.x, size.y);
        } else {
            dumpMethod.invoke(null, root, tmp);
        }
        return readAll(tmp);
    }

    private static Display realDisplay() throws Exception {
        Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object instance = global.getMethod("getInstance").invoke(null);
        return (Display) global.getMethod("getRealDisplay", int.class)
                .invoke(instance, Display.DEFAULT_DISPLAY);
    }

    private static void startIdleWatchdog() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                for (;;) {
                    try { Thread.sleep(30_000); } catch (InterruptedException e) { return; }
                    if (System.currentTimeMillis() - lastRequestAt > IDLE_SHUTDOWN_MS) {
                        System.out.println("idle, shutting down");
                        System.exit(0);
                    }
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1 && c != '\n') buf.write(c);
        return new String(buf.toByteArray(), "UTF-8");
    }

    private static byte[] readAll(File f) throws Exception {
        try (InputStream in = new java.io.FileInputStream(f)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }

    private CompanionApp() { }
}
