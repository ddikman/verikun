import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { Driver, DeviceInfo, Element, Platform, ToolProbe, Viewport } from '../types';
import { CliError, probeFailure } from '../errors';
import { runText } from '../exec';
import { parseIosHierarchy } from '../ui/ios-parse';
import { viewportFor } from '../ui/viewport';
import {
  SettingKey,
  canonicalFontScale,
  contentSizeToFontScale,
  fontScaleToContentSize,
} from '../device/settings';
import { err } from '../output';

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

// Tool probes, shared by `vk doctor --ios` (which renders every one and keeps going)
// and IdbDriver.preflight() (which throws on the first failure) so the two can't drift
// on what "the iOS toolchain works" means — or on the install hints.

const IDB_HINT = 'needed for ui/tap/text/swipe/key/logs — install: `brew install idb-companion` then `pip install fb-idb`';
const XCRUN_HINT = 'if the Xcode command-line tools are not installed: `xcode-select --install`';

export function probeXcrun(): ToolProbe {
  try {
    const r = runText(XCRUN, ['simctl', 'list', 'devices', 'booted']);
    // runText only throws when the binary can't be SPAWNED, so a tool that exists but
    // fails (broken install, missing Xcode selection) needs the exit code checked too.
    if (r.code !== 0) {
      return { name: 'xcrun', ok: false, detail: `xcrun simctl exited ${r.code}: ${r.stderr.trim()}`, hint: XCRUN_HINT };
    }
    return { name: 'xcrun', ok: true, detail: r.stdout.trim() || '(no booted simulators)' };
  } catch (e) {
    // Not necessarily missing: runText also throws on a spawn timeout or other exec
    // failure, so surface the real reason rather than always claiming "NOT FOUND".
    return { name: 'xcrun', ok: false, detail: (e as Error).message, hint: XCRUN_HINT };
  }
}

export function probeIdb(): ToolProbe {
  try {
    const r = runText(IDB, ['--help']); // idb has no --version; --help confirms the binary runs
    if (r.code !== 0) return { name: 'idb', ok: false, detail: `idb --help exited ${r.code}: ${r.stderr.trim()}`, hint: IDB_HINT };
    return { name: 'idb', ok: true, detail: 'present' };
  } catch (e) {
    return { name: 'idb', ok: false, detail: (e as Error).message, hint: IDB_HINT };
  }
}

export function probeIdbCompanion(): ToolProbe {
  try {
    // Spawn-only on purpose: idb_companion prints its usage to stderr and exits 1 for
    // --help, so its exit code says nothing about health. Presence is all we can cheaply
    // assert here — idb itself is the probe that has to actually work.
    runText('idb_companion', ['--help']);
    return { name: 'idb_companion', ok: true, detail: 'present' };
  } catch (e) {
    return { name: 'idb_companion', ok: false, detail: (e as Error).message, hint: 'install: `brew install idb-companion`' };
  }
}

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
  /** null = asked and failed. Memoized because screenSize()'s fallback path runs a
   *  SECOND full hierarchy dump, which auto-wait would otherwise pay every poll. */
  private cachedScreen?: { width: number; height: number } | null;

  constructor(device?: string) {
    // 'booted' is a simctl-only alias idb can't address, so treat it as "auto-resolve".
    this.requested = device && device !== 'booted' ? device : undefined;
  }

  preflight(): void {
    // resolvedSerial() shells to simctl, so it already covers a missing xcrun, no
    // booted simulator / connected device, and an ambiguous target (exit 2).
    this.resolvedSerial();
    // idb is required to drive iOS AT ALL — simulator or not. simctl covers launch,
    // stop and screenshots, so without this a missing idb goes unnoticed until the
    // first step that reads the hierarchy, long after a compile has been paid for.
    //
    // `describe` rather than doctor's `idb --help`: one round-trip that proves idb runs
    // AND that the target is still reachable through its companion. That second half is
    // what lets `vk suite`'s mid-run re-probe notice a simulator that died — `--help`
    // would keep answering happily with the device long gone. (doctor keeps `--help`
    // because it must report on idb with no device booted at all.)
    let r;
    try {
      // Default 30s timeout, same as screenSize()'s identical call: preflight is the
      // FIRST idb call of the process, so it is the one that pays idb_companion's
      // cold start — the last place to shave the budget.
      r = runText(IDB, ['describe', '--udid', this.udid()]);
    } catch (e) {
      throw probeFailure({ name: 'idb', ok: false, detail: (e as Error).message, hint: IDB_HINT });
    }
    if (r.code !== 0) {
      const why = r.stderr.trim().split('\n')[0] || `exit code ${r.code}`;
      throw probeFailure({ name: 'idb', ok: false, detail: `idb cannot reach ${this.udid()}: ${why}`, hint: IDB_HINT });
    }
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
    return parseIosHierarchy(this.idbText(['ui', 'describe-all'], { timeout: 15000 }), {
      ...opts,
      screen: this.screenOrNull() ?? undefined,
    });
  }

  viewport(): Viewport | null {
    const screen = this.screenOrNull();
    // No orientation signal from idb, so viewportFor uses the max(w,h) square: exact
    // on the vertical axis lists scroll on, permissive across it.
    return screen ? viewportFor(screen) : null;
  }

  /** screenSize() memoized, failure included — see AdbDriver.screenOrNull. */
  private screenOrNull(): { width: number; height: number } | null {
    if (this.cachedScreen === undefined) {
      try {
        this.cachedScreen = this.screenSize();
      } catch {
        this.cachedScreen = null;
      }
    }
    return this.cachedScreen;
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

  install(appPath: string): void {
    // idb install handles both simulators and physical devices, and both .ipa
    // archives and .app bundles locally. (The REMOTE install path accepts only
    // single-file .ipa uploads in v1 — a .app is a directory, which the streamed
    // upload can't carry; see server.ts.) Installs can take minutes.
    this.idbText(['install', appPath], { timeout: 10 * 60 * 1000 });
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

  getLogs(opts: { lines?: number; appId?: string; since?: string; scopedOnly?: boolean } = {}): string {
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
    } else if (opts.scopedOnly) {
      // scopedOnly without an appId can't mean anything on iOS — empty rather than
      // a full dump (mirrors Android's "couldn't scope" behaviour).
      return '';
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

  // --- device settings ------------------------------------------------------
  //
  // Only two of the five keys exist on iOS, and only on a SIMULATOR: `simctl ui`
  // offers appearance / content_size / increase_contrast and nothing else, while
  // `idb ui` is purely interaction (tap/text/key/swipe/describe). A physical device
  // has no scriptable settings surface at all. Rather than fake the gap — a
  // status-bar override would repaint the wifi glyph without cutting any traffic —
  // the unsupported keys refuse with exit 3 and name the manual equivalent, the way
  // clearApp does.

  /** `simctl ui <udid> <option>` with no argument reads the current value. */
  private simctlUi(option: string, value?: string): string {
    const args = ['simctl', 'ui', this.udid(), option, ...(value ? [value] : [])];
    const r = runText(XCRUN, args);
    if (r.code !== 0) {
      throw new CliError(`simctl ui ${option} failed: ${r.stderr.trim() || `exit code ${r.code}`}`, 3);
    }
    return r.stdout.trim();
  }

  /** Shared refusal for a key iOS cannot honor. */
  private unsupportedSetting(key: SettingKey, detail: string): never {
    throw new CliError(`Device setting '${key}' is not supported on iOS.\n${detail}`, 3);
  }

  private assertSimulator(key: SettingKey): void {
    if (!this.isSimulator()) {
      this.unsupportedSetting(
        key,
        'A physical iOS device exposes no scriptable settings surface (simctl drives simulators ' +
          'only, and idb covers interaction, not preferences). Change it by hand in Settings.',
      );
    }
  }

  getDeviceSetting(key: SettingKey): string | null {
    // Best-effort by contract: never throw, so a snapshot of a key this platform
    // cannot answer simply declines to restore it rather than aborting the run.
    try {
      if (!this.isSimulator()) return null;
      switch (key) {
        case 'dark': {
          const v = this.simctlUi('appearance').toLowerCase();
          return v === 'dark' ? 'on' : v === 'light' ? 'off' : null;
        }
        case 'font-scale': {
          // simctl also answers 'unknown' / 'unsupported'; both map to null.
          const scale = contentSizeToFontScale(this.simctlUi('content_size'));
          return scale === null ? null : canonicalFontScale(scale);
        }
        case 'airplane':
        case 'rotation':
        case 'stay-awake':
          return null;
      }
    } catch {
      return null;
    }
  }

  setDeviceSetting(key: SettingKey, value: string): void {
    switch (key) {
      case 'dark': {
        this.assertSimulator(key);
        this.simctlUi('appearance', value === 'on' ? 'dark' : 'light');
        return;
      }
      case 'font-scale': {
        this.assertSimulator(key);
        // iOS has named Dynamic Type categories where Android has a float, so the
        // value is mapped — and the category we actually applied is echoed, because
        // silently landing on a different size than asked for would be a lie.
        const category = fontScaleToContentSize(Number(value));
        this.simctlUi('content_size', category);
        err(`note: font-scale ${value} applied on iOS as content size '${category}'`);
        return;
      }
      case 'stay-awake':
        // Honest no-op: a simulator never sleeps, so the intent is already satisfied.
        this.assertSimulator(key);
        err('note: stay-awake is a no-op on iOS — simulators do not sleep');
        return;
      case 'airplane':
        return this.unsupportedSetting(
          key,
          'A simulator has no radio to switch off (`simctl status_bar override --wifiMode failed` ' +
            'only repaints the status bar). Use Xcode > Open Developer Tool > Network Link ' +
            "Conditioner, or toggle the host Mac's own network — the simulator shares it.",
        );
      case 'rotation':
        return this.unsupportedSetting(
          key,
          'Neither `simctl ui` (appearance/content_size/increase_contrast only) nor `idb ui` ' +
            'exposes orientation. Rotate the Simulator window by hand (Cmd+Left / Cmd+Right).',
        );
    }
  }
}
