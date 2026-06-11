import { Driver, DeviceInfo, Element, Platform } from '../types';
import { CliError } from '../errors';
import { runText, runBinary } from '../exec';
import { parseHierarchy } from '../ui/android-parse';

const ADB = process.env.ADB || 'adb';

// Named keys -> Android keycodes. Numeric codes are also accepted directly.
const KEYCODES: Record<string, number> = {
  enter: 66,
  back: 4,
  home: 3,
  tab: 61,
  space: 62,
  del: 67,
  delete: 67,
  backspace: 67,
  forward_del: 112,
  escape: 111,
  esc: 111,
  menu: 82,
  search: 84,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  dpad_center: 23,
  power: 26,
  app_switch: 187,
  recents: 187,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  move_home: 122,
  move_end: 123,
  page_up: 92,
  page_down: 93,
};

const DUMP_PATHS = ['/sdcard/window_dump.xml', '/data/local/tmp/window_dump.xml'];

/**
 * Escape a string for `adb shell input text <arg>`. The argument is parsed twice
 * before it reaches the field: once by the on-device shell (mksh), then by
 * `input`, which maps the literal token "%s" back to a space.
 *
 * Strategy is an ALLOWLIST: leave ASCII letters/digits and any non-ASCII bytes
 * untouched, and backslash-escape EVERY ASCII punctuation/symbol. For a char mksh
 * treats as ordinary (e.g. @ . + _ - , : /) the backslash is a no-op (\x -> x),
 * so `input` receives the same character; for one mksh would interpret
 * (quote, backtick, $ & | ; < > ( ) * ? ~ # ! { } [ ] backslash) the escape keeps
 * it literal. So bob@mail.com (or a value with + = % # & ;) types verbatim.
 * Spaces are encoded last as the token %s, which `input` decodes back to a space.
 * (One inherent limit of that convention, unchanged here: a literal "%s" in the
 * text also decodes to a space. The backslash on % only guards the shell, not
 * `input`'s own %s handling.)
 *
 * Arbitrary Unicode (accents, emoji) is a known limitation of `input text` and is
 * passed through unchanged; use an IME like ADBKeyboard for that — see SKILL.md.
 */
export function escapeText(s: string): string {
  return s
    // Backslash-escape every ASCII punctuation/symbol the device shell might
    // interpret. Ranges cover all ASCII punctuation, excluding space (\x20),
    // 0-9, A-Z, a-z. $& is the matched char.
    .replace(/[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g, '\\$&')
    // `input` maps the literal token %s back to a space, so encode spaces last.
    .replace(/ /g, '%s');
}

export class AdbDriver implements Driver {
  readonly platform: Platform = 'android';
  private readonly requested?: string;
  private cachedSerial?: string;

  constructor(serial?: string) {
    this.requested = serial;
  }

  listDevices(): DeviceInfo[] {
    const { stdout } = runText(ADB, ['devices', '-l']);
    const devices: DeviceInfo[] = [];
    for (const line of stdout.split('\n').slice(1)) {
      const t = line.trim();
      if (!t || t.startsWith('*')) continue;
      const fields = t.split(/\s+/);
      const serial = fields[0];
      const state = fields[1];
      if (!serial || !state) continue;
      const info: DeviceInfo = { serial, state, platform: 'android' };
      for (const kv of fields.slice(2)) {
        const idx = kv.indexOf(':');
        if (idx < 0) continue;
        const k = kv.slice(0, idx);
        const v = kv.slice(idx + 1);
        if (k === 'model') info.model = v;
        if (k === 'product') info.product = v;
      }
      devices.push(info);
    }
    return devices;
  }

  resolvedSerial(): string {
    if (this.cachedSerial) return this.cachedSerial;
    if (this.requested) {
      this.cachedSerial = this.requested;
      return this.cachedSerial;
    }
    const all = this.listDevices();
    const usable = all.filter((d) => d.state === 'device');
    if (usable.length === 0) {
      if (all.length) {
        const states = all.map((d) => `${d.serial}=${d.state}`).join(', ');
        throw new CliError(`No usable Android device (states: ${states}). Authorize/reconnect it.`, 3);
      }
      throw new CliError('No Android devices/emulators connected. Start one, then `verikun devices`.', 3);
    }
    if (usable.length > 1) {
      const list = usable.map((d) => '  ' + d.serial + (d.model ? ` (${d.model})` : '')).join('\n');
      throw new CliError(`Multiple devices connected; pass --device <serial> (or set VERIKUN_DEVICE):\n${list}`, 2);
    }
    this.cachedSerial = usable[0].serial;
    return this.cachedSerial;
  }

  private withSerial(args: string[]): string[] {
    return ['-s', this.resolvedSerial(), ...args];
  }

  private shell(args: string[], timeout?: number): string {
    return runText(ADB, this.withSerial(['shell', ...args]), { timeout }).stdout;
  }

  getElements(opts: { all?: boolean } = {}): Element[] {
    return parseHierarchy(this.dumpXml(), opts);
  }

  private dumpXml(): string {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = DUMP_PATHS[Math.min(attempt, DUMP_PATHS.length - 1)];
      const dump = runText(ADB, this.withSerial(['shell', 'uiautomator', 'dump', path]), { timeout: 15000 });
      const cat = runBinary(ADB, this.withSerial(['exec-out', 'cat', path]));
      const xml = cat.stdout.toString('utf8');
      if (xml.includes('<hierarchy')) return xml;
      lastErr = `${dump.stdout} ${dump.stderr} ${cat.stderr}`.replace(/\s+/g, ' ').trim();
    }
    throw new CliError(
      `Failed to capture UI hierarchy after 3 attempts. ${lastErr}\n` +
        'Tip: disable animations (`verikun doctor --fix`) and ensure the screen is idle.',
      3,
    );
  }

  screenshot(): Buffer {
    const r = runBinary(ADB, this.withSerial(['exec-out', 'screencap', '-p']));
    if (r.stdout.length < 8 || r.stdout[0] !== 0x89 || r.stdout[1] !== 0x50) {
      throw new CliError(`screencap did not return a PNG. ${r.stderr}`.trim(), 3);
    }
    return r.stdout;
  }

  screenSize(): { width: number; height: number } {
    const out = this.shell(['wm', 'size']);
    const lines = out.split('\n');
    const override = lines.find((l) => /Override size/i.test(l));
    const physical = lines.find((l) => /Physical size/i.test(l));
    const m = /(\d+)x(\d+)/.exec(override ?? physical ?? out);
    if (!m) throw new CliError(`Could not determine screen size from: ${out.trim()}`, 3);
    return { width: +m[1], height: +m[2] };
  }

  tap(x: number, y: number): void {
    this.shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void {
    this.shell([
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.round(durationMs)),
    ]);
  }

  inputText(text: string): void {
    if (!text) return;
    this.shell(['input', 'text', escapeText(text)]);
  }

  pressKey(name: string): void {
    const code = KEYCODES[name.toLowerCase()] ?? (/^\d+$/.test(name) ? Number(name) : undefined);
    if (code === undefined) {
      throw new CliError(
        `Unknown key '${name}'. Known: ${Object.keys(KEYCODES).join(', ')}, or a numeric keycode.`,
        2,
      );
    }
    this.shell(['input', 'keyevent', String(code)]);
  }

  launch(appId: string): void {
    // monkey launches the default LAUNCHER activity without needing its name.
    this.shell(['monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'], 15000);
  }

  stop(appId: string): void {
    this.shell(['am', 'force-stop', appId]);
  }

  clearApp(appId: string): void {
    // `pm clear` deletes the app's data dirs (shared-prefs, databases, caches) and
    // force-stops it — resetting it to a just-installed state (logged out, no local
    // data). It prints "Success", or "Failed" if the package is unknown/protected.
    const result = this.shell(['pm', 'clear', appId]);
    if (!/success/i.test(result)) {
      throw new CliError(
        `Failed to clear app data for '${appId}': ${result.trim() || 'no output from pm clear'}`,
        3,
      );
    }
  }

  currentApp(): string {
    const resumed = /mResumedActivity[^\n]*?\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.]+)/.exec(
      this.shell(['dumpsys', 'activity', 'activities']),
    );
    if (resumed) return resumed[1];
    const focus = /mCurrentFocus[^\n]*?\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.]+)/.exec(this.shell(['dumpsys', 'window']));
    return focus ? focus[1] : '(unknown)';
  }
}
