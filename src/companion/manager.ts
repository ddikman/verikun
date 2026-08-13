// Lifecycle for the on-device companion: get one running, prove it agrees with the
// platform, use it, and get out of its way the moment anything goes wrong.
//
// The whole design is shaped by one constraint, measured on-device: only ONE UiAutomation
// may be connected per device, and the newcomer is SIGKILLed. So unlike `screenshotRaw()`,
// this cannot be a per-call try/catch — while the companion holds the connection the stock
// path is not merely slower, it is *unavailable* (exit 137). Every failure route here
// therefore gets the companion off the connection BEFORE the caller falls back.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runText, sleepSync } from '../exec';
import { err } from '../output';
import { NoWindowError } from '../errors';
import { VERSION } from '../version';
import {
  CompanionState,
  DimensionSource,
  dumpCommand,
  isHierarchy,
  parseState,
  portForSerial,
  requestSync,
} from './protocol';

const DEVICE_JAR = '/data/local/tmp/verikun-companion.jar';
/** What we learned about this device last time, kept ON the device because that is what the
 *  knowledge is about — it survives every `vk` process, every working directory, and a
 *  disposable CI runner. See readDeviceNote/writeDeviceNote. */
const DEVICE_NOTE = '/data/local/tmp/verikun-companion.note';
/** How long to let the process that claimed calibration finish before giving up on it.
 *  Generous: calibration is ~5s, and being patient costs one slow read while being impatient
 *  costs the mutual-SIGKILL contention the claim exists to prevent. */
const CALIBRATION_WAIT_MS = 30000;
const SOCKET = 'verikun-companion';
const MAIN_CLASS = 'dev.verikun.companion.CompanionApp';
/** uiautomator.jar supplies UiAutomationShellWrapper + AccessibilityNodeInfoDumper, which the
 *  companion borrows so its XML is byte-identical to `uiautomator dump`'s. */
const DEVICE_CLASSPATH = [
  '/system/framework/android.test.runner.jar',
  '/system/framework/uiautomator.jar',
  DEVICE_JAR,
].join(':');

/** Cold start measured at ~1.5s on a physical SM-A415F; the margin is for slower devices. */
const START_TIMEOUT_MS = 12000;

/** The companion's way of saying getRootInActiveWindow() returned null. */
const NULL_ROOT_REPLY = /null root node/i;
const START_POLL_MS = 150;

export interface CompanionDeps {
  adb: string;
  serial: string;
  /** Run a stock `uiautomator dump` and return its XML. Injected rather than imported so
   *  calibration compares the companion against exactly the implementation the rest of
   *  verikun would otherwise have used — and so this module needs no driver. */
  stockDump(): string;
}

/** The packaged companion jar: shipped in the npm tarball, and present in a source checkout
 *  once `tools/verikun-companion/build.sh` has run. Absent means "no companion available",
 *  which is a normal state, not an error. */
export function companionJarPath(): string | null {
  // dist/companion/manager.js → repo root is two levels up.
  const candidate = resolve(__dirname, '..', '..', 'tools', 'verikun-companion', 'prebuilt', 'verikun-companion.jar');
  return existsSync(candidate) ? candidate : null;
}

/**
 * ON by default; `VERIKUN_COMPANION=0` opts out.
 *
 * It started opt-in, and that was wrong: a hierarchy read is the dominant cost of every
 * Android run, nobody discovers an environment variable they have not been told about, and
 * the people who most need the speedup are the least likely to go looking for it. Being
 * fast by default is the whole point.
 *
 * What makes that safe is that a failure cannot cost a test: the stock path is always there
 * and every failure route hands the UiAutomation connection back before using it. What
 * makes it not *slow* is the on-device note — a device where the companion cannot run says
 * so once, and is never probed again.
 *
 * The real cost is that the companion holds the device's single UiAutomation connection
 * while it runs, so Appium, Layout Inspector and TalkBack cannot attach. `VERIKUN_COMPANION=0`
 * or `vk companion stop` hands it back.
 */
export function companionEnabled(): boolean {
  const v = (process.env.VERIKUN_COMPANION ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Ask any companion on this device to drop the UiAutomation connection, so a stock
 * `uiautomator dump` can run. Best-effort and silent: no companion is the normal case.
 *
 * Called from the STOCK dump path when it fails, including when the caller never opted in.
 * A companion started by an earlier `VERIKUN_COMPANION=1` command outlives that process, so
 * a plain `vk tap` afterwards would otherwise be SIGKILLed for as long as the companion
 * lives. verikun's own helper must never be the reason verikun cannot read the screen.
 *
 * `release`, not `quit`: the process stays warm, so the next opted-in command re-acquires in
 * ~1s instead of paying a full cold start.
 */
export function releaseCompanionOn(serial: string): boolean {
  try {
    requestSync(portForSerial(serial), 'release', 4000);
    return true;
  } catch {
    return false;
  }
}

export class Companion {
  private readonly port: number;
  /** Latched off for the rest of this process once anything goes wrong: a companion that
   *  has already failed is not worth re-probing per read, since the retry would cost more
   *  than the stock dump it is trying to avoid. */
  private unusable = false;
  private dims?: DimensionSource;

  constructor(private readonly deps: CompanionDeps) {
    this.port = portForSerial(deps.serial);
  }

  private adb(args: string[], timeout = 15000) {
    return runText(this.deps.adb, ['-s', this.deps.serial, ...args], { timeout });
  }

  /**
   * What we concluded about this device last time: `<verikun version>|<app|real|unsupported>`.
   *
   * Kept on the DEVICE rather than in `.verikun/`, because it is a fact about the phone, not
   * about a working directory — it survives a `cd`, and a disposable CI runner inherits it
   * instead of starting cold. Keyed by verikun version so an upgrade re-tries a device that
   * an older build could not use.
   */
  private readDeviceNote(): 'unsupported' | DimensionSource | undefined {
    const r = this.adb(['shell', `cat ${DEVICE_NOTE} 2>/dev/null`], 5000);
    const [version, verdict] = r.stdout.trim().split('|');
    if (version !== VERSION) return undefined;
    if (verdict === 'unsupported' || verdict === 'app' || verdict === 'real') return verdict;
    return undefined;
  }

  private writeDeviceNote(verdict: 'unsupported' | DimensionSource): void {
    // Single-quoted, and every value here comes from a closed set — nothing caller-supplied
    // reaches the device shell.
    this.adb(['shell', `echo '${VERSION}|${verdict}' > ${DEVICE_NOTE}`], 5000);
  }

  /**
   * The hierarchy XML, or null when the companion cannot serve it — in which case the
   * UiAutomation connection has already been handed back, so the caller's stock dump will
   * work rather than being SIGKILLed.
   */
  dump(idleMs: number): string | null {
    if (this.unusable) return null;
    try {
      if (!this.dims) {
        this.dims = this.ensureReady();
        if (!this.dims) return null;
      }
      const reply = requestSync(this.port, dumpCommand(idleMs, this.dims));
      if (!isHierarchy(reply)) {
        // The companion reports its own failures as plain text (`ERROR …`, `released —
        // call acquire first`). Those must never reach the XML parser as though they were
        // a screen: an unparseable "hierarchy" reads as zero elements, which is the
        // "absent" lie that silently skips a guard.
        const detail = reply.toString('utf8').trim().slice(0, 200) || 'empty reply';
        // A null root is the DEVICE having no window, not the companion malfunctioning.
        // Standing down for it would release a perfectly healthy connection and drop the
        // whole process onto the 2.4s path — measured after every `launch --clear`, which
        // leaves exactly this gap.
        if (NULL_ROOT_REPLY.test(detail)) {
          throw new NoWindowError(
            'No window to read: the app has not drawn yet (force-stopped, or mid-launch).',
          );
        }
        throw new Error(detail);
      }
      return reply.toString('utf8');
    } catch (e) {
      if (e instanceof NoWindowError) throw e; // transient screen state — the companion is fine
      this.standDown(`companion dump failed (${(e as Error).message})`);
      return null;
    }
  }

  /** Get a calibrated companion running, or give up for this process. */
  private ensureReady(): DimensionSource | undefined {
    // FAST PATH, and the only one that needs no coordination: a companion that is already
    // running AND calibrated. Note the `dims` check — an uncalibrated companion is NOT ready,
    // because calibrating it needs the UiAutomation connection exclusively, and that has to
    // happen under the lock below like every other exclusive use.
    const live = this.probeState();
    if (live.usable && live.dims) {
      // Alive but NOT holding the connection: something asked it to let go — the stock dump
      // path does exactly that when it fails, and `vk companion stop` is not the only route.
      // Take the connection back before using it, or every read here answers "released" and
      // silently falls through to the 2.4s path for the rest of the run.
      if (!live.held && !this.acquire()) return undefined;
      return live.dims;
    }

    // Nothing listening. Before paying a start + calibration, ask the device what happened
    // last time — this is what stops a phone the companion cannot run on from costing every
    // single command a doomed start attempt now that this is on by default.
    const note = this.readDeviceNote();
    if (note === 'unsupported') {
      this.unusable = true;
      return undefined;
    }

    return this.startAndCalibrate(note, live);
  }

  /** Wait for the process that claimed calibration to publish its verdict. */
  private waitForCalibration(): DimensionSource | undefined {
    const deadline = Date.now() + CALIBRATION_WAIT_MS;
    while (Date.now() < deadline) {
      sleepSync(START_POLL_MS);
      const state = this.probeState();
      if (!state.usable) return undefined; // it died; our caller falls back
      if (!state.dims) continue;           // still working — do NOT touch the connection
      if (!state.held && !this.acquire()) return undefined;
      return state.dims;
    }
    return undefined;
  }

  private startAndCalibrate(note: 'app' | 'real' | undefined, state: CompanionState): DimensionSource | undefined {
    if (!state.usable && !this.start()) {
      // Only record "this phone cannot run it" when the phone is genuinely the problem, and
      // only after looking once more. Two ways this verdict could otherwise be wrong, and it
      // is STICKY — every later command on this device would skip straight to the 2.4s path:
      //   - the jar is missing, which is a fault of THIS checkout, not of the device;
      //   - several `vk` processes cold-started at once and collided, which is transient and
      //     usually leaves a perfectly good companion running (started by whoever won).
      if (companionJarPath() && !this.probeState().usable) this.writeDeviceNote('unsupported');
      this.unusable = true;
      return undefined;
    }
    // A remembered verdict skips calibration entirely — worth ~4.7s of the cold start, and
    // the companion idle-shuts-down every 15 minutes, so restarts are routine.
    if (note === 'app' || note === 'real') {
      try {
        requestSync(this.port, `calibrated ${note}`, 4000);
        return note;
      } catch {
        /* fall through and calibrate properly */
      }
    }

    // ONLY ONE PROCESS MAY CALIBRATE. It works by releasing the UiAutomation connection to
    // take a real `uiautomator dump`, so a second process doing it concurrently SIGKILLs the
    // first one's dump — MEASURED as five concurrent first reads exiting [3,3,0,3,3]. The
    // claim is granted by the companion itself, whose single-threaded accept loop makes it
    // genuinely atomic; the obvious host-side lock does not work, because Android's toybox
    // `mkdir` SUCCEEDS on an existing directory and so grants itself to every caller.
    const already = this.probeState();
    if (already.dims) return already.dims;
    if (!this.claimCalibration()) return this.waitForCalibration();
    return this.calibrate();
  }

  private claimCalibration(): boolean {
    try {
      return requestSync(this.port, 'claim-calibration', 8000).toString('utf8').trim() === 'granted';
    } catch {
      return false;
    }
  }

  /** Retake the UiAutomation connection. ~1.05s: the cold-bridge idle wait, paid once. */
  private acquire(): boolean {
    try {
      requestSync(this.port, 'acquire', 20000);
      return true;
    } catch (e) {
      this.standDown(`companion could not reacquire the connection (${(e as Error).message})`);
      return false;
    }
  }

  private probeState(): CompanionState {
    try {
      return parseState(requestSync(this.port, 'state', 4000));
    } catch {
      return { usable: false, held: false };
    }
  }

  /** Push the jar, forward the socket, spawn detached, wait for it to answer. */
  private start(): boolean {
    const jar = companionJarPath();
    if (!jar) {
      // Nothing to push. A source checkout that has not run tools/verikun-companion/build.sh
      // lands here, and so would a broken install — neither is a fact about the device.
      return false;
    }

    // Look once more before tearing anything down. Between our probe and now, another `vk`
    // process may have started a perfectly good companion — and stopStale() below would kill
    // it, so two processes racing could ping-pong indefinitely, each killing the other's.
    if (this.probeState().usable) return true;

    // A companion left by an older verikun answers with a different protocol number. It is
    // not merely useless — it is still holding the connection, so it must be stopped.
    this.stopStale();

    if (this.adb(['push', jar, DEVICE_JAR], 30000).code !== 0) return false;
    if (this.adb(['forward', `tcp:${this.port}`, `localabstract:${SOCKET}`]).code !== 0) return false;

    // Detached, and stdio fully redirected: every `vk` call is its own process, so a
    // companion tied to this adb shell would die before the next command could reuse it —
    // which is the entire point of it existing.
    this.adb(['shell', `nohup env CLASSPATH=${DEVICE_CLASSPATH} app_process / ${MAIN_CLASS} >/dev/null 2>&1 &`]);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.probeState().usable) return true;
      sleepSync(START_POLL_MS);
    }
    err('[verikun] companion did not start; using the stock hierarchy dump');
    return false;
  }

  private stopStale(): void {
    try {
      requestSync(this.port, 'quit', 3000);
    } catch {
      /* nothing listening, or it is wedged — killByName is the backstop */
    }
    this.killByName();
  }

  /**
   * Prove the companion's dump matches the platform's own before trusting it.
   *
   * The dumper clips every node's bounds to a display size, and which size the platform
   * uses varies by build: AOSP's `DumpCommand` reads `getRealSize()`, while a physical
   * SM-A415F's stock dump matches `getSize()`. Guessing wrong does not fail loudly — it
   * shifts every element near the bottom of the screen, and the resulting tap lands
   * somewhere else while still reporting success, which is the worst failure a testing
   * tool has. So do not guess: take one real `uiautomator dump` and adopt whichever
   * source reproduces it byte for byte.
   *
   * Costs one stock dump (~2.4s) plus a reconnect (~1.05s), once per companion — not once
   * per process, because the verdict is stored in the companion itself.
   */
  private calibrate(): DimensionSource | undefined {
    try {
      // The stock dump cannot run while we hold the connection — it would be SIGKILLed.
      requestSync(this.port, 'release', 5000);
      const stock = this.deps.stockDump().trim();
      requestSync(this.port, 'acquire', 20000);

      for (const dims of ['app', 'real'] as DimensionSource[]) {
        const reply = requestSync(this.port, dumpCommand(0, dims));
        if (isHierarchy(reply) && reply.toString('utf8').trim() === stock) {
          requestSync(this.port, `calibrated ${dims}`, 4000);
          this.writeDeviceNote(dims);
          return dims;
        }
      }
      // Neither matched. Usually the screen simply moved between the two dumps, but it
      // could equally be a device whose bounds we would get wrong — and being slow is
      // strictly better than tapping the wrong pixel, so decline rather than pick one.
      this.standDown('companion output did not match the platform dump; using the stock path');
      return undefined;
    } catch (e) {
      this.standDown(`companion calibration failed (${(e as Error).message})`);
      return undefined;
    }
  }

  /** Hand the UiAutomation connection back, and stop using the companion in this process. */
  private standDown(reason: string): void {
    this.unusable = true;
    err(`[verikun] ${reason}`);
    try {
      requestSync(this.port, 'release', 4000);
    } catch {
      // It cannot be asked, so it has to be taken: while it holds the connection the stock
      // dump is SIGKILLed, and the caller is about to depend on the stock dump.
      this.killByName();
    }
  }

  /** Kill by command line rather than a remembered pid — the companion outlives the process
   *  that started it, so whoever needs it gone usually never had the pid. */
  private killByName(): void {
    this.adb(['shell', `pkill -f ${MAIN_CLASS}`], 5000);
  }

  /** Explicit teardown: `vk companion stop`. */
  stop(): void {
    try {
      requestSync(this.port, 'quit', 4000);
    } catch {
      this.killByName();
    }
    this.adb(['forward', '--remove', `tcp:${this.port}`]);
  }

  /** For `vk companion status`. */
  describe(): string {
    try {
      const state = requestSync(this.port, 'state', 4000).toString('utf8').trim();
      return `running on port ${this.port} (${state})`;
    } catch {
      return 'not running';
    }
  }
}
