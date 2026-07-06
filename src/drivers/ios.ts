import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { Driver, DeviceInfo, Element, Platform } from '../types';
import { CliError } from '../errors';
import { runText } from '../exec';
import { parseIosHierarchy } from '../ui/ios-parse';

// iOS driver. `xcrun simctl` / `devicectl` cover device discovery and — on a
// simulator — screenshots, app lifecycle, and logs (no extra install needed).
// Everything interactive (UI hierarchy, tap, type, swipe, keys, screen size) and
// all interaction on physical devices go through Facebook's `idb`, a CLI shelled
// one-shot exactly like `adb` — so this driver keeps verikun's zero-runtime-dep,
// process-per-command shape. Install: `brew install idb-companion` + `pip install
// fb-idb` (see `vk doctor --ios`).
//
// Coordinates are in idb's point space: `idb ui describe-all` frames, `idb ui tap`,
// and `idb describe` screen_dimensions all agree, so element.center taps land.
// (simctl screenshots are pixels = points × scale — they are for viewing only and
// never feed back into a tap.)

const XCRUN = 'xcrun';
const IDB = process.env.IDB || 'idb';

const DEFAULT_LOG_LINES = 200;
const DEFAULT_LOG_WINDOW = '5m';

// Named keys -> USB-HID keyboard usage IDs, handed to `idb ui key <code>`. Numeric
// codes are accepted directly. Names mirror the adb driver so cross-platform
// batch/ai scripts share one vocabulary.
const IOS_KEYCODES: Record<string, number> = {
  enter: 40,
  return: 40,
  escape: 41,
  esc: 41,
  del: 42,
  delete: 42,
  backspace: 42,
  tab: 43,
  space: 44,
  forward_del: 76,
  move_home: 74,
  move_end: 77,
  page_up: 75,
  page_down: 78,
  right: 79,
  dpad_right: 79,
  left: 80,
  dpad_left: 80,
  down: 81,
  dpad_down: 81,
  up: 82,
  dpad_up: 82,
};

// Named hardware buttons -> `idb ui button <NAME>` (the only accepted set).
const IOS_BUTTONS: Record<string, string> = {
  home: 'HOME',
  lock: 'LOCK',
  power: 'LOCK',
  side_button: 'SIDE_BUTTON',
  siri: 'SIRI',
  apple_pay: 'APPLE_PAY',
};

function listPhysicalDevices(): DeviceInfo[] {
  const r = runText(XCRUN, ['devicectl', 'list', 'devices']);
  if (r.code !== 0) return [];
  const lines = r.stdout.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('Identifier'));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  const nameCol = header.indexOf('Name');
  const hostCol = header.indexOf('Hostname');
  const idCol = header.indexOf('Identifier');
  const stateCol = header.indexOf('State');
  const modelCol = header.indexOf('Model');
  const devices: DeviceInfo[] = [];
  for (const line of lines.slice(headerIdx + 2)) {
    if (!line.trim() || line.startsWith('-')) continue;
    const identifier = line.slice(idCol, stateCol).trim();
    const state = line.slice(stateCol, modelCol).trim();
    const name = line.slice(nameCol, hostCol).trim();
    const model = line.slice(modelCol).trim();
    if (!identifier) continue;
    const productMatch = model.match(/\(([^)]+)\)$/);
    devices.push({
      serial: identifier,
      state,
      model: name,
      product: productMatch?.[1],
      platform: 'ios',
      note: 'physical — via idb (Developer mode + idb_companion; logs limited)',
    });
  }
  return devices;
}

export class IdbDriver implements Driver {
  readonly platform: Platform = 'ios';
  private readonly requested?: string;
  private cachedSerial?: string;
  private cachedIsSim?: boolean;

  constructor(device?: string) {
    // 'booted' is a simctl-only alias idb can't address, so treat it as "auto-resolve".
    this.requested = device && device !== 'booted' ? device : undefined;
  }

  /** All available simulators (booted or shutdown) via simctl. Tolerates odd output. */
  private simulators(): DeviceInfo[] {
    const devices: DeviceInfo[] = [];
    const { stdout } = runText(XCRUN, ['simctl', 'list', 'devices', 'available', '--json']);
    try {
      const data = JSON.parse(stdout) as {
        devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
      };
      for (const [runtime, list] of Object.entries(data.devices)) {
        for (const d of list) {
          devices.push({
            serial: d.udid,
            state: d.state.toLowerCase(),
            model: d.name,
            product: runtime.split('.').pop(),
            platform: 'ios',
          });
        }
      }
    } catch {
      /* tolerate unexpected simctl output */
    }
    return devices;
  }

  listDevices(): DeviceInfo[] {
    return [...this.simulators(), ...listPhysicalDevices()];
  }

  resolvedSerial(): string {
    if (this.cachedSerial) return this.cachedSerial;
    const sims = this.simulators();
    const simUdids = new Set(sims.map((d) => d.serial));

    if (this.requested) {
      this.cachedSerial = this.requested;
      this.cachedIsSim = simUdids.has(this.requested);
      return this.cachedSerial;
    }

    // No explicit device: a booted simulator is the first-class, unambiguously
    // drivable target, so prefer it. Only weigh physical devices when no simulator
    // is booted — and only genuinely "connected" ones (devicectl also lists paired-
    // but-idle devices as "available (paired)", which must not count as active).
    const bootedSims = sims.filter((d) => d.state === 'booted');
    const candidates =
      bootedSims.length > 0 ? bootedSims : listPhysicalDevices().filter((d) => /connected/i.test(d.state));
    if (candidates.length === 0) {
      throw new CliError('No booted iOS simulator or connected device. Boot one (Simulator.app / `xcrun simctl boot`), then `verikun devices`.', 3);
    }
    if (candidates.length > 1) {
      const list = candidates.map((d) => '  ' + d.serial + (d.model ? ` (${d.model})` : '')).join('\n');
      throw new CliError(`Multiple iOS targets; pass --device <udid> (or set VERIKUN_DEVICE):\n${list}`, 2);
    }
    this.cachedSerial = candidates[0].serial;
    this.cachedIsSim = simUdids.has(candidates[0].serial);
    return this.cachedSerial;
  }

  private udid(): string {
    return this.resolvedSerial();
  }

  private isSimulator(): boolean {
    this.resolvedSerial();
    return this.cachedIsSim === true;
  }

  /** Run an idb subcommand against the resolved target, returning stdout. */
  private idbText(args: string[], opts?: { timeout?: number }): string {
    const r = runText(IDB, [...args, '--udid', this.udid()], opts);
    if (r.code !== 0) {
      throw new CliError(`idb ${args.join(' ')} failed: ${r.stderr.trim() || `exit code ${r.code}`}`, 3);
    }
    return r.stdout;
  }

  getElements(opts: { all?: boolean } = {}): Element[] {
    // `idb ui describe-all` prints the accessibility tree as JSON (array or NDJSON);
    // parseIosHierarchy handles either.
    return parseIosHierarchy(this.idbText(['ui', 'describe-all'], { timeout: 15000 }), opts);
  }

  screenshot(): Buffer {
    const tmp = join(tmpdir(), `verikun-ios-${process.pid}.png`);
    if (this.isSimulator()) {
      const r = runText(XCRUN, ['simctl', 'io', this.udid(), 'screenshot', tmp]);
      if (r.code !== 0) throw new CliError(`simctl screenshot failed: ${r.stderr.trim()}`, 3);
    } else {
      this.idbText(['screenshot', tmp]);
    }
    let buf: Buffer;
    try {
      buf = readFileSync(tmp);
    } catch (e) {
      throw new CliError(`Could not read iOS screenshot: ${(e as Error).message}`, 3);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
      throw new CliError('iOS screenshot was not a PNG.', 3);
    }
    return buf;
  }

  screenSize(): { width: number; height: number } {
    // Prefer idb's target description (points, same space as tap/swipe).
    try {
      const d = JSON.parse(this.idbText(['describe', '--json'])) as {
        screen_dimensions?: { width?: number; height?: number };
      };
      const w = Number(d.screen_dimensions?.width);
      const h = Number(d.screen_dimensions?.height);
      if (w > 0 && h > 0) return { width: w, height: h };
    } catch {
      /* fall through to deriving from the hierarchy */
    }
    // Fallback: the extent of the on-screen hierarchy (the window/app root frame).
    let width = 0;
    let height = 0;
    for (const el of parseIosHierarchy(this.idbText(['ui', 'describe-all']), { all: true })) {
      width = Math.max(width, el.bounds.x2);
      height = Math.max(height, el.bounds.y2);
    }
    if (width > 0 && height > 0) return { width, height };
    throw new CliError('Could not determine iOS screen size via idb.', 3);
  }

  tap(x: number, y: number): void {
    this.idbText(['ui', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, _durationMs: number): void {
    // idb controls swipe speed via `--delta` (px per step), not a ms duration, and
    // the flag's availability varies by version — so we pass coordinates only for
    // maximum compatibility. durationMs is not honored (a documented iOS gap).
    this.idbText([
      'ui',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
    ]);
  }

  inputText(text: string): void {
    if (!text) return;
    // Passed as a single argv (spawnSync, no host shell), so no device-shell escaping
    // is needed — idb synthesizes the keystrokes itself.
    this.idbText(['ui', 'text', text]);
  }

  pressKey(name: string): void {
    const key = name.toLowerCase();
    const button = IOS_BUTTONS[key];
    if (button) {
      this.idbText(['ui', 'button', button]);
      return;
    }
    const code = IOS_KEYCODES[key] ?? (/^\d+$/.test(name) ? Number(name) : undefined);
    if (code === undefined) {
      const hint = key === 'back' ? ' (iOS has no hardware Back — tap the on-screen back control instead)' : '';
      throw new CliError(
        `Unknown iOS key '${name}'${hint}. Known keys: ${Object.keys(IOS_KEYCODES).join(', ')}; ` +
          `hardware buttons: ${Object.keys(IOS_BUTTONS).join(', ')}; or a numeric HID keycode.`,
        2,
      );
    }
    this.idbText(['ui', 'key', String(code)]);
  }

  launch(appId: string): void {
    if (this.isSimulator()) {
      const r = runText(XCRUN, ['simctl', 'launch', this.udid(), appId]);
      if (r.code !== 0) throw new CliError(`simctl launch failed: ${r.stderr.trim()}`, 3);
    } else {
      this.idbText(['launch', appId]);
    }
  }

  stop(appId: string): void {
    // Best-effort force-stop. `terminate` reports a non-zero exit when the app simply
    // wasn't running; that's a no-op success for us (parity with adb `am force-stop`,
    // which never fails), so we don't surface it — otherwise `launch`'s default
    // restart (stop-then-launch) would break whenever the app is already closed.
    try {
      if (this.isSimulator()) {
        runText(XCRUN, ['simctl', 'terminate', this.udid(), appId]);
      } else {
        runText(IDB, ['terminate', appId, '--udid', this.udid()]);
      }
    } catch {
      /* tool missing / target gone — nothing to stop */
    }
  }

  clearApp(appId: string): void {
    // Honest degrade (no clean per-app data reset on iOS): don't silently uninstall.
    throw new CliError(
      `iOS app-data clearing is not supported (requested for '${appId}').\n` +
        'iOS has no per-app data reset; the manual equivalent is uninstall + reinstall ' +
        '(`xcrun simctl uninstall <udid> <bundleId>`), which removes the app too.',
      3,
    );
  }

  currentApp(): string {
    // iOS exposes no reliable foreground-app query; degrade like adb's fallback.
    return '(unknown)';
  }

  getLogs(opts: { lines?: number; appId?: string; since?: string } = {}): string {
    if (!this.isSimulator()) {
      throw new CliError(
        'iOS physical-device log capture is not supported (simulator logs work via `log show`).\n' +
          'Use Console.app or `idb log` directly for a connected device.',
        3,
      );
    }
    // `log show` on the whole store is huge, so ALWAYS bound it: a session marker
    // (--start) or a recent window (--last). Args go through spawnSync (no shell),
    // so the marker/predicate need no escaping and can't inject.
    const args = ['simctl', 'spawn', this.udid(), 'log', 'show', '--style', 'syslog'];
    if (opts.since) {
      args.push('--start', opts.since);
    } else {
      args.push('--last', DEFAULT_LOG_WINDOW);
    }
    if (opts.appId) {
      // Best-effort process scope: the simulator process name is usually the bundle's
      // last component. A loose predicate is better than none for a crash trace.
      const proc = opts.appId.split('.').pop() || opts.appId;
      args.push('--predicate', `process CONTAINS "${proc}"`);
    }
    const out = runText(XCRUN, args, { timeout: 20000 }).stdout;
    if (opts.since) return out; // the whole session window
    // No explicit since → keep the last N lines, like adb's `logcat -t N`.
    const n = opts.lines && opts.lines > 0 ? Math.floor(opts.lines) : DEFAULT_LOG_LINES;
    const lines = out.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  }

  deviceTime(): string {
    // Simulator shares the host clock; sample it in `log show --start` format so the
    // run's log window (run.ts) can anchor on it. Physical devices → '' (no marker),
    // which disables windowing gracefully. Never throws (called at run start).
    try {
      if (!this.isSimulator()) return '';
      return runText(XCRUN, ['simctl', 'spawn', this.udid(), 'date', '+%Y-%m-%d %H:%M:%S']).stdout.trim();
    } catch {
      return '';
    }
  }
}
