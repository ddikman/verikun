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
import {
  DimensionSource,
  dumpCommand,
  isHierarchy,
  pingMatches,
  portForSerial,
  requestSync,
} from './protocol';

const DEVICE_JAR = '/data/local/tmp/verikun-companion.jar';
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
 * Opt-in, for now. The companion holds the device's single UiAutomation connection for as
 * long as it runs, which locks out Appium, Layout Inspector and a second verikun — a real
 * enough side effect to be asked for rather than assumed, until it has been seen on more
 * than a handful of devices. Flipping the default is a follow-up, not an oversight.
 */
export function companionEnabled(): boolean {
  const v = process.env.VERIKUN_COMPANION;
  return v === '1' || v === 'true';
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
        throw new Error(reply.toString('utf8').trim().slice(0, 200) || 'empty reply');
      }
      return reply.toString('utf8');
    } catch (e) {
      this.standDown(`companion dump failed (${(e as Error).message})`);
      return null;
    }
  }

  /** Get a calibrated companion running, or give up for this process. */
  private ensureReady(): DimensionSource | undefined {
    if (!this.isReachable() && !this.start()) return undefined;
    return this.readCalibration() ?? this.calibrate();
  }

  private isReachable(): boolean {
    try {
      return pingMatches(requestSync(this.port, 'ping', 4000));
    } catch {
      return false;
    }
  }

  /** What the companion itself remembers. Held on the device rather than in a host-side
   *  file because the companion outlives any single `vk` process — a host cache could
   *  disagree with the process actually serving dumps. */
  private readCalibration(): DimensionSource | undefined {
    try {
      const text = requestSync(this.port, 'state', 4000).toString('utf8').trim();
      return text.startsWith('ready ') ? (text.split(/\s+/)[1] as DimensionSource) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Push the jar, forward the socket, spawn detached, wait for it to answer. */
  private start(): boolean {
    const jar = companionJarPath();
    if (!jar) return false;

    // A companion left by an older verikun answers `ping` with a different protocol number.
    // It is not merely useless — it is still holding the connection, so it must be stopped.
    this.stopStale();

    if (this.adb(['push', jar, DEVICE_JAR], 30000).code !== 0) return false;
    if (this.adb(['forward', `tcp:${this.port}`, `localabstract:${SOCKET}`]).code !== 0) return false;

    // Detached, and stdio fully redirected: every `vk` call is its own process, so a
    // companion tied to this adb shell would die before the next command could reuse it —
    // which is the entire point of it existing.
    this.adb(['shell', `nohup env CLASSPATH=${DEVICE_CLASSPATH} app_process / ${MAIN_CLASS} >/dev/null 2>&1 &`]);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.isReachable()) return true;
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
