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

/**
 * How long a TRANSIENT stand-down suppresses the companion before it is retried.
 *
 * The point of a stand-down is that re-probing on every read would cost more than the stock
 * dump it avoids — but "never again" is only correct for a process that exits after one
 * command. `vk server` runs for days, and the companion shuts ITSELF down after 15 minutes
 * idle, so a daemon that latched off permanently spent the rest of its life on the 2.4s path
 * next to a perfectly healthy companion (issue #77). One retry a minute is cheap enough to be
 * invisible and frequent enough that a suite recovers within its first test.
 */
const TRANSIENT_RETRY_MS = 60000;

/**
 * How long a run of null-root replies must last before the connection is suspected of being
 * wedged rather than the screen being genuinely blank.
 *
 * A real mid-launch gap resolves in well under this; a stale UiAutomation connection never
 * does. MEASURED on a Pixel 3a: after `vk launch` force-stops and restarts the app, the
 * companion returned a null root for 30s+ while a stock dump read the same screen fine.
 */
const WEDGE_AFTER_MS = 3000;

const NOT_RUNNING = 'not running';

export type NullRootAction = 'propagate' | 'recycle' | 'fallback';

/**
 * What to do about a null root, given how long the current run of them has lasted.
 *
 * Pure so the escalation can be unit-tested without a device. The order matters and each step
 * is deliberately conservative:
 *   - `propagate` — the normal case. A null root is the DEVICE having no window (mid-launch,
 *     force-stopped), not a companion fault, so it goes up to the caller's auto-wait.
 *   - `recycle`  — long enough to be suspicious. Release and re-acquire the connection, which
 *     is exactly what unwedges it, and cheap (~1.05s) relative to being wrong.
 *   - `fallback` — recycling did not help. Hand the connection back and let the stock dump
 *     answer. It can read screens the wedged companion cannot, and a slow read beats a
 *     selector command failing on a screen that is plainly there.
 */
export function nullRootAction(runMs: number, alreadyRecycled: boolean): NullRootAction {
  if (runMs < WEDGE_AFTER_MS) return 'propagate';
  if (!alreadyRecycled) return 'recycle';
  return runMs >= WEDGE_AFTER_MS * 2 ? 'fallback' : 'propagate';
}

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
  /** Off for the rest of this process, for a reason that CANNOT change while it runs: this
   *  device's note says the companion does not work here, or there is no jar to push. */
  private declined = false;
  /** Off until this timestamp, for a reason that might. Re-probing per read would cost more
   *  than the stock dump it avoids, but never retrying is only right for a process that
   *  exits after one command — see TRANSIENT_RETRY_MS. */
  private retryAfter = 0;
  private dims?: DimensionSource;
  /** When the current unbroken run of null-root replies started (0 = not in one), and
   *  whether this run has already spent its one connection recycle. See nullRootAction. */
  private nullRootSince = 0;
  private nullRootRecycled = false;

  constructor(private readonly deps: CompanionDeps) {
    this.port = portForSerial(deps.serial);
  }

  /** Why the companion is not serving reads right now, for `/v1/health` and `vk companion
   *  status`. Null when it is available (or would be on the next read). */
  suppressedReason(): string | null {
    if (this.declined) return 'declined on this device';
    if (Date.now() < this.retryAfter) return 'standing by after a failure';
    return null;
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
    if (this.declined || Date.now() < this.retryAfter) return null;
    // TWO attempts, because a dead companion is routine rather than exceptional: it shuts
    // itself down after 15 minutes idle, which any long-lived process (`vk server`, a slow
    // suite) will outlive. The first attempt can therefore fail purely because `dims` is
    // cached from before that shutdown; clearing it sends the second attempt through
    // ensureReady(), which restarts from the device note in ~2.1s. Without this the process
    // stood down permanently and never touched the companion again (issue #77).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return this.attemptDump(idleMs);
      } catch (e) {
        if (e instanceof NoWindowError) throw e; // the screen's state, not the companion's
        if (attempt === 0 && this.dims) {
          this.dims = undefined;
          continue;
        }
        this.standDown(`companion dump failed (${(e as Error).message})`, 'transient');
        return null;
      }
    }
    return null;
  }

  /** One read attempt. Throws NoWindowError for a blank screen, anything else for a
   *  companion that could not serve the read. */
  private attemptDump(idleMs: number): string | null {
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
      if (NULL_ROOT_REPLY.test(detail)) return this.onNullRoot(idleMs);
      throw new Error(detail);
    }
    // A hierarchy came back, so whatever run of null roots preceded it is over.
    this.nullRootSince = 0;
    this.nullRootRecycled = false;
    return reply.toString('utf8');
  }

  /**
   * A null root is USUALLY the device having no window — mid-launch, or force-stopped — and
   * standing down for it would release a healthy connection and drop the whole process onto
   * the 2.4s path after every `launch --clear`.
   *
   * But it is not always. A long-lived UiAutomation connection can go stale and return null
   * forever for a window that is plainly there: MEASURED on a Pixel 3a, 30s+ of null roots
   * after `vk launch` while a stock dump read the screen fine. Because this error propagates
   * rather than standing down, that state never self-healed and every selector command burned
   * its full auto-wait and failed on a readable screen. So escalate by duration.
   */
  private onNullRoot(idleMs: number): string | null {
    const now = Date.now();
    if (!this.nullRootSince) this.nullRootSince = now;
    switch (nullRootAction(now - this.nullRootSince, this.nullRootRecycled)) {
      case 'recycle':
        this.nullRootRecycled = true;
        err('[verikun] companion has reported no window for a while; recycling the connection');
        if (this.recycleConnection()) return this.attemptDump(idleMs);
        break;
      case 'fallback':
        // Recycling did not help and the stock dump may well read this screen. Being slow is
        // always better than failing a selector on a screen that is there.
        this.standDown('companion still reports no window after a recycle; using the stock path', 'transient');
        return null;
      case 'propagate':
        break;
    }
    throw new NoWindowError(
      'No window to read: the app has not drawn yet (force-stopped, or mid-launch).',
    );
  }

  /** Hand the UiAutomation connection back and take it again. The one thing measured to clear
   *  a stale connection — it is what the stock path's releaseCompanionOn() does by accident. */
  private recycleConnection(): boolean {
    try {
      requestSync(this.port, 'release', 5000);
      requestSync(this.port, 'acquire', 20000);
      return true;
    } catch {
      return false;
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
      // TERMINAL: this is a recorded fact about the phone, and it cannot become false while
      // this process runs. Retrying it would be the doomed start attempt per command that the
      // note exists to prevent.
      this.declined = true;
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
      const jar = companionJarPath();
      const deviceIsAtFault = jar && !this.probeState().usable;
      if (deviceIsAtFault) this.writeDeviceNote('unsupported');
      // Only the two facts that cannot change under a running process are terminal. A start
      // that failed for any OTHER reason — most often the cold-start collision above — must
      // stay retryable, or one unlucky moment costs a daemon every read it will ever do.
      if (deviceIsAtFault || !jar) this.declined = true;
      else this.retryAfter = Date.now() + TRANSIENT_RETRY_MS;
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
      this.standDown(`companion could not reacquire the connection (${(e as Error).message})`, 'transient');
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
      // TRANSIENT precisely because "the screen moved" is the usual cause: a daemon that
      // treated one moving screen as a permanent verdict spent its whole life on the stock
      // path, which is the likeliest origin of issue #77's "no speedup at all".
      this.standDown('companion output did not match the platform dump; using the stock path', 'transient');
      return undefined;
    } catch (e) {
      this.standDown(`companion calibration failed (${(e as Error).message})`, 'transient');
      return undefined;
    }
  }

  /**
   * Hand the UiAutomation connection back, and stop using the companion — for a minute if the
   * cause could pass, for the rest of the process if it cannot.
   *
   * Releasing FIRST is the load-bearing half: while the companion holds the connection the
   * stock dump is not slower, it is SIGKILLed, and the caller is about to depend on it.
   */
  private standDown(reason: string, kind: 'terminal' | 'transient'): void {
    if (kind === 'terminal') this.declined = true;
    else this.retryAfter = Date.now() + TRANSIENT_RETRY_MS;
    // Force a fresh ensureReady() on the retry: whatever `dims` said is exactly what stopped
    // working, and the note-based restart is what recovers it.
    this.dims = undefined;
    this.nullRootSince = 0;
    this.nullRootRecycled = false;
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
    const state = this.stateSummary();
    return state === NOT_RUNNING ? state : `running on port ${this.port} (${state})`;
  }

  /** Just the device-side state (`ready app held`, or `not running`), for embedding in a
   *  one-line read-path report. */
  stateSummary(): string {
    try {
      return requestSync(this.port, 'state', 4000).toString('utf8').trim();
    } catch {
      return NOT_RUNNING;
    }
  }
}
