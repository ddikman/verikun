import { Driver, DeviceInfo, Element, Platform, ToolProbe, Viewport } from '../types';
import type { RawImage } from '../image';
import { CliError, probeFailure } from '../errors';
import { runText, runBinary, sleepSync, TextResult } from '../exec';
import { parseHierarchy, parseRotation } from '../ui/android-parse';
import { viewportFor } from '../ui/viewport';
import {
  SettingKey,
  ROTATION_AUTO,
  canonicalFontScale,
  rotationToUserRotation,
  userRotationToRotation,
} from '../device/settings';
import { err } from '../output';

const ADB = process.env.ADB || 'adb';
const ADB_HINT = 'install the Android platform-tools (`brew install --cask android-platform-tools`), or point ADB at the binary';

/** Is `adb` present and runnable? Shared by `vk doctor` and AdbDriver.preflight() so
 *  the two can't drift on what "the Android toolchain works" means. */
export function probeAdb(): ToolProbe {
  try {
    const r = runText(ADB, ['version']);
    // runText only throws when the binary can't be SPAWNED, so a broken-but-present adb
    // needs its exit code checked too — otherwise it reports as healthy.
    if (r.code !== 0) {
      return { name: 'adb', ok: false, detail: `adb version exited ${r.code}: ${r.stderr.trim()}`, hint: ADB_HINT };
    }
    return { name: 'adb', ok: true, detail: r.stdout.split('\n')[0] };
  } catch (e) {
    // Not necessarily missing: runText also throws on a spawn timeout or other exec
    // failure — surface the real reason rather than always claiming "NOT FOUND".
    return { name: 'adb', ok: false, detail: (e as Error).message, hint: ADB_HINT };
  }
}


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

/** Header sizes `screencap` writes before the pixels: width/height/format, plus a
 *  colorspace word since Android 9. Newest first — see `screenshotRaw`. */
const RAW_HEADER_SIZES = [16, 12];
/** android.graphics.PixelFormat.RGBA_8888 */
const PIXEL_FORMAT_RGBA_8888 = 1;

const DEFAULT_LOG_LINES = 200;

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

/** How adb reaches the device. Only `tcp` rides the device's own wifi. */
export type AdbTransport = 'usb' | 'tcp' | 'emulator';

/**
 * Classify a device serial by transport. Exported for the unit suite.
 *
 * Load-bearing default: an UNRECOGNIZED shape is `usb`. USB serials are the
 * open-ended set (any vendor string), while TCP serials have exactly two forms —
 * `host:port` and Android 11+ wireless-debugging mDNS names. This classifier only
 * feeds a foot-gun guard, not a security boundary, so the failure we must avoid is
 * misreading a real USB serial as wireless and blocking a legitimate run.
 */
export function adbTransport(serial: string): AdbTransport {
  const s = serial.trim();
  // An emulator is reached over a host-local console port, not through the guest's
  // network stack, so cutting the guest's wifi cannot sever it.
  if (/^emulator-\d+$/.test(s)) return 'emulator';
  if (/_adb-tls-(connect|pairing)\._tcp\.?$/.test(s)) return 'tcp';
  if (/:\d+$/.test(s)) return 'tcp';
  return 'usb';
}

/**
 * Would applying this setting sever adb's own link to the device? Only cutting the
 * radios over a wireless transport does: the command would kill the channel carrying
 * the next command, and nothing could turn it back on remotely.
 */
export function severanceRisk(transport: AdbTransport, key: SettingKey, value: string): boolean {
  return transport === 'tcp' && key === 'airplane' && value === 'on';
}

/** How long a written setting has to read back before we call it refused. These are
 *  local writes, so they land in well under a second or not at all. */
const VERIFY_TIMEOUT_MS = 4000;
const VERIFY_INTERVAL_MS = 200;

export class AdbDriver implements Driver {
  readonly platform: Platform = 'android';
  private readonly requested?: string;
  private cachedSerial?: string;
  /** null = asked and failed. Cached either way: getElements runs on a ~300ms poll
   *  during auto-wait, and a broken `wm size` must not cost a round-trip every time. */
  private cachedScreen?: { width: number; height: number } | null;
  /** Rotation of the most recent dump — see viewport(). */
  private lastRotation?: number;

  constructor(serial?: string) {
    this.requested = serial;
  }

  preflight(): void {
    const adb = probeAdb();
    if (!adb.ok) throw probeFailure(adb);
    // Resolving the serial is the other half of "can I drive anything?": it throws
    // exit 3 with no device attached and exit 2 when several are and none was chosen.
    const serial = this.resolvedSerial();
    // …but that answer is cached, so ask the device itself. That is what lets a suite's
    // mid-run re-probe notice a phone that was unplugged or an emulator that died,
    // rather than replaying the resolution it made before anything went wrong.
    const state = runText(ADB, ['-s', serial, 'get-state']);
    const got = state.stdout.trim();
    if (state.code !== 0 || got !== 'device') {
      throw probeFailure({
        name: 'adb',
        ok: false,
        detail: `device ${serial} is not ready (${got || state.stderr.trim().split('\n')[0] || `adb get-state exited ${state.code}`})`,
        hint: 'reconnect it (check `verikun devices`); an unauthorized device needs the USB-debugging prompt accepted',
      });
    }
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
    const xml = this.dumpXml();
    // Read off the dump we already have: free, and it refreshes every capture, so a
    // device rotated mid-run is handled without re-asking for the screen size.
    this.lastRotation = parseRotation(xml);
    return parseHierarchy(xml, { ...opts, screen: this.screenOrNull() ?? undefined });
  }

  viewport(): Viewport | null {
    const screen = this.screenOrNull();
    return screen ? viewportFor(screen, this.lastRotation) : null;
  }

  /** screenSize() memoized, failure included — the parser uses it to mark elements
   *  scrolled out of view, and "we could not tell" must degrade to "all visible". */
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

  /**
   * `screencap` without `-p`: the framebuffer as-is, skipping the on-device PNG
   * encode that dominates a capture (MEASURED on an SM-A415F: 2.50s with `-p`,
   * 1.04s without — the bigger transfer is far cheaper than the deflate it avoids).
   *
   * Returns null rather than throwing on anything unexpected, so an OEM or Android
   * version that lays the buffer out differently silently falls back to the PNG
   * path. Getting a wrong-but-plausible image would be far worse than being slow.
   */
  screenshotRaw(): RawImage | null {
    const r = runBinary(ADB, this.withSerial(['exec-out', 'screencap']));
    const buf = r.stdout;
    if (buf.length < RAW_HEADER_SIZES[0]) return null;
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    const format = buf.readUInt32LE(8);
    // Only RGBA_8888 — the one format every `screencap` we have seen emits, and the
    // only one whose channel order we can assume without guessing.
    if (format !== PIXEL_FORMAT_RGBA_8888) return null;
    if (width < 1 || height < 1) return null;
    const pixelBytes = width * height * 4;
    // Android 9 added a colorspace word, so the header is 16 bytes on anything
    // modern and 12 before that. Pick whichever the payload length agrees with
    // rather than branching on an OS version we would have to go and ask for.
    const header = RAW_HEADER_SIZES.find((size) => buf.length - size === pixelBytes);
    if (header === undefined) return null;
    return { width, height, ch: 4, pixels: buf.subarray(header) };
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
    // Resolve the app's default LAUNCHER activity, then start it with `am start -n`.
    // We deliberately avoid `monkey -c LAUNCHER`: on some OEM skins (MIUI/HyperOS) it
    // hangs indefinitely rather than returning, tripping the exec timeout.
    const resolved = this.shell([
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      appId,
    ]);
    // `--brief` may print a header line before the component; the component is the
    // last non-empty line and looks like `pkg/.Activity`.
    const component = resolved
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!component || !component.includes('/')) {
      throw new CliError(`Could not resolve a launcher activity for '${appId}' (is it installed?).`, 3);
    }
    // Capture stdout+stderr+exit code: `am start` reports failures via `Error:`/`Error
    // type` (on EITHER stream) and/or a non-zero exit, but shell() returns only stdout —
    // so a failed launch would otherwise read as success. The benign `Warning: Activity
    // not started` (intent delivered to a running instance, e.g. --no-restart) is NOT a
    // failure.
    const r = runText(ADB, this.withSerial(['shell', 'am', 'start', '-n', component]));
    const combined = `${r.stdout}\n${r.stderr}`;
    const benignWarning = /Warning: Activity not started/.test(combined);
    if (/^Error\b/im.test(combined) || (r.code !== 0 && !benignWarning)) {
      throw new CliError(`Failed to launch '${appId}': ${r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`}`, 3);
    }
  }

  install(appPath: string): void {
    // `-r` reinstalls over an existing package keeping its data (the common
    // update-the-build-under-test case). A large APK can legitimately take
    // minutes to stream + install, so the timeout is far above the 30s default.
    // adb reports failures both as a non-zero exit AND as a `Failure [REASON]`
    // line on stdout with exit 0 (varies by adb version) — check both.
    const r = runText(ADB, this.withSerial(['install', '-r', appPath]), { timeout: 10 * 60 * 1000 });
    const combined = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || /^Failure\b/im.test(combined) || !/^Success\b/im.test(combined)) {
      throw new CliError(`Failed to install '${appPath}': ${combined.replace(/\s+/g, ' ').trim() || `exit code ${r.code}`}`, 3);
    }
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

  getLogs(opts: { lines?: number; appId?: string; since?: string; scopedOnly?: boolean } = {}): string {
    // One-shot dump: -d (and -t) make logcat EXIT. NEVER add -f/follow — it would
    // stream forever and hang until the spawnSync timeout. The default buffers
    // (main,system,crash) already include crash traces, so no -b needed.
    const args = ['logcat', '-d'];
    if (opts.since) {
      // A logcat timestamp is `MM-DD HH:MM:SS.mmm` — digits, space, `-`, `:`, `.` only.
      // Reject anything else so a caller-supplied `--since` cannot break out of the
      // device-shell single-quoting below into command injection (device-shell escaping
      // is the driver's job — see escapeText / CLAUDE.md).
      if (!/^[0-9 :.\-]+$/.test(opts.since)) {
        throw new CliError(`Invalid --since '${opts.since}': only a logcat timestamp (digits, space, '-', ':', '.') is allowed.`, 2);
      }
      // `-t '<time>'` prints lines at/after that time, then exits. The marker
      // contains a space and adb concatenates the post-`shell` args into one
      // device-side command line, so single-quote it for the device shell to
      // keep it a single token. (The marker is digits/`-`/`:`/`.`/space only.)
      args.push('-t', `'${opts.since}'`);
    } else {
      const n = opts.lines && opts.lines > 0 ? Math.floor(opts.lines) : DEFAULT_LOG_LINES;
      args.push('-t', String(n));
    }
    if (opts.appId) {
      // Prefer --uid: it survives process death/restart (crash traces stay under the
      // package's uid). Fall back to --pid for a live process when uid isn't known.
      // When neither works: vk log falls through to system-wide so a FATAL EXCEPTION
      // isn't missed; archive accordion passes scopedOnly to keep the dump empty.
      const uid = this.packageUid(opts.appId);
      if (uid) {
        args.push(`--uid=${uid}`);
      } else {
        const pid = this.shell(['pidof', opts.appId]).trim().split(/\s+/)[0];
        if (pid) args.push(`--pid=${pid}`);
        else if (opts.scopedOnly) return '';
      }
    }
    return this.shell(args, 15000);
  }

  /** Android userId for an installed package, or '' if unknown. Used to scope
   *  logcat across process restarts (unlike pidof, which only sees a live process). */
  private packageUid(appId: string): string {
    try {
      const out = this.shell(['dumpsys', 'package', appId], 10000);
      const m = /\buserId=(\d+)\b/.exec(out);
      return m?.[1] ?? '';
    } catch {
      return '';
    }
  }

  deviceTime(): string {
    // logcat's default timestamp is MM-DD HH:MM:SS.mmm in the device's LOCAL time.
    // Sample it from the device clock with a space-free format (so no device-shell
    // quoting is needed), then restore the space to match logcat's `-t` form.
    try {
      return this.shell(['date', '+%m-%dT%H:%M:%S.000']).trim().replace('T', ' ');
    } catch {
      return '';
    }
  }

  // --- device settings ------------------------------------------------------
  //
  // Every device token below is a constant (the value domain is a closed enum in
  // device/settings.ts), so no caller-supplied string reaches the device shell and
  // no escaping gate is needed. The one non-constant, font-scale's number, has
  // already been reduced to /^\d+(\.\d+)?$/ by the table's parse().

  /** Like shell(), but keeps stderr and the exit code — needed because a refusal
   *  ("Permission denial", "cmd: Can't find service") arrives on stderr and would
   *  otherwise be invisible in the error we raise. */
  private shellFull(args: string[], timeout?: number): TextResult {
    return runText(ADB, this.withSerial(['shell', ...args]), { timeout });
  }

  /** `settings get <ns> <key>`, with Android's literal "null" (unset) mapped to null. */
  private readSetting(ns: string, key: string): string | null {
    const v = this.shell(['settings', 'get', ns, key]).trim();
    return v === '' || v === 'null' ? null : v;
  }

  /** Poll a readback until it satisfies `ok`. Returns the final value (or null). */
  private pollSetting(read: () => string | null, ok: (v: string | null) => boolean): string | null {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last = read();
    while (!ok(last) && Date.now() < deadline) {
      sleepSync(VERIFY_INTERVAL_MS);
      last = read();
    }
    return last;
  }

  /** Apply a change, then prove it landed. `svc` / `cmd` / `settings put` are all
   *  fire-and-forget and are silently ignored on some OEM skins, so the readback is
   *  the actual contract — without it we would report success for a no-op. */
  private applyAndVerify(
    what: string,
    mutate: () => TextResult,
    read: () => string | null,
    ok: (v: string | null) => boolean,
    hint: string,
  ): void {
    const r = mutate();
    const final = this.pollSetting(read, ok);
    if (ok(final)) return;
    const why = `${r.stderr}\n${r.stdout}`.replace(/\s+/g, ' ').trim();
    throw new CliError(
      `Failed to set ${what}: the command ran but the device still reports ${JSON.stringify(final)} ` +
        `after ${VERIFY_TIMEOUT_MS}ms.` +
        (why ? `\nDevice said: ${why}` : '') +
        `\n${hint}`,
      3,
    );
  }

  getDeviceSetting(key: SettingKey): string | null {
    switch (key) {
      case 'airplane':
        return this.readSetting('global', 'airplane_mode_on') === '1' ? 'on' : 'off';
      case 'dark': {
        // `cmd uimode night` prints e.g. "Night mode: no". Some builds also report
        // "auto"/"custom", which our on|off domain cannot express — report null
        // rather than guessing, so a snapshot declines to restore it.
        const out = this.shell(['cmd', 'uimode', 'night']).trim().toLowerCase();
        if (/\byes\b/.test(out)) return 'on';
        if (/\bno\b/.test(out)) return 'off';
        return null;
      }
      case 'font-scale': {
        // Unset means Android's default of 1.0 (the setting row simply doesn't exist
        // yet). Report the effective value, not the absence, so restore is correct.
        const raw = this.readSetting('system', 'font_scale');
        const n = raw === null ? 1.0 : Number(raw);
        return Number.isFinite(n) ? canonicalFontScale(n) : null;
      }
      case 'rotation': {
        if (this.readSetting('system', 'accelerometer_rotation') === '1') return ROTATION_AUTO;
        const v = this.readSetting('system', 'user_rotation');
        return v === null ? null : userRotationToRotation(v);
      }
      case 'stay-awake': {
        // A bitmask of the charging types it applies to (1=AC, 2=USB, 4=wireless);
        // any non-zero value means "stays on", which is all our on|off domain claims.
        const v = this.readSetting('global', 'stay_on_while_plugged_in');
        return v === null ? 'off' : v !== '0' ? 'on' : 'off';
      }
    }
  }

  setDeviceSetting(key: SettingKey, value: string): void {
    switch (key) {
      case 'airplane':
        return this.setAirplane(value === 'on');
      case 'dark':
        return this.applyAndVerify(
          `dark=${value}`,
          () => this.shellFull(['cmd', 'uimode', 'night', value === 'on' ? 'yes' : 'no']),
          () => this.getDeviceSetting('dark'),
          (v) => v === value,
          'Some OEM skins override night mode from their own theme engine.',
        );
      case 'font-scale':
        return this.applyAndVerify(
          `font-scale=${value}`,
          () => this.shellFull(['settings', 'put', 'system', 'font_scale', value]),
          () => this.getDeviceSetting('font-scale'),
          (v) => v === value,
          'Writing system settings requires an unrestricted adb shell.',
        );
      case 'rotation':
        return this.setRotation(value);
      case 'stay-awake':
        return this.applyAndVerify(
          `stay-awake=${value}`,
          () => this.shellFull(['svc', 'power', 'stayon', value === 'on' ? 'true' : 'false']),
          () => this.getDeviceSetting('stay-awake'),
          (v) => v === value,
          'Some devices restrict `svc power` while a battery-saver profile is active.',
        );
    }
  }

  /**
   * Airplane mode, reconciled against the radios that can actually survive it.
   *
   * Android publishes `airplane_mode_toggleable_radios` — the radios a user is allowed
   * to switch back ON while airplane mode is active (typically `bluetooth,wifi,nfc`) —
   * and it REMEMBERS that choice. So on a phone where wifi was once re-enabled mid-
   * flight, `airplane-mode enable` leaves wifi UP. Reporting "offline" while the app is
   * still online would make an offline test pass for the wrong reason, which is the
   * worst failure mode a testing tool has. So: flip the flag, then force any toggleable
   * radio that ignored it.
   *
   * Only radios in that list are reconciled. Cellular is not one of them — the flag
   * cuts it outright — and `mobile_data` is a stored user PREFERENCE rather than live
   * radio state, so it keeps reading 1 on a SIM-less device that is plainly offline.
   * Probing it would fail a perfectly good offline state.
   *
   * The inverse is symmetric: a radio we forced off by hand will not come back on its
   * own, so leaving airplane mode re-enables it. That can turn a radio back on that the
   * user had off before the run, so it is announced on stderr rather than done quietly.
   */
  private setAirplane(on: boolean): void {
    this.applyAndVerify(
      `airplane=${on ? 'on' : 'off'}`,
      () => this.shellFull(['cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable']),
      () => this.readSetting('global', 'airplane_mode_on'),
      (v) => v === (on ? '1' : '0'),
      'Airplane mode is settable via `cmd connectivity` on API 30+; older devices need root.',
    );

    // Read the toggleable list from the device rather than assuming it — it varies by
    // build, and a device that does not let wifi survive airplane mode needs no fixup.
    const toggleable = (this.readSetting('global', 'airplane_mode_toggleable_radios') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase());
    if (!toggleable.includes('wifi')) return;

    // wifi_on is tri-state on some builds (2 = on, pending airplane-mode exit), so ask
    // "is it off?" rather than comparing against a single expected value.
    const isOff = (v: string | null) => v === null || v === '0';
    const settled = this.pollSetting(() => this.readSetting('global', 'wifi_on'), (v) => isOff(v) === on);
    if (isOff(settled) === on) return;

    err(
      `note: wifi was still ${on ? 'up' : 'down'} after airplane mode ${on ? 'on' : 'off'} — ` +
        `forcing it ${on ? 'off' : 'on'} so the device state matches the request`,
    );
    this.applyAndVerify(
      `wifi ${on ? 'off' : 'on'}`,
      () => this.shellFull(['svc', 'wifi', on ? 'disable' : 'enable']),
      () => this.readSetting('global', 'wifi_on'),
      (v) => isOff(v) === on,
      '`svc wifi` is refused by some OEM skins; toggle it in Settings instead.',
    );
  }

  /** A fixed orientation also pins auto-rotate off, or the accelerometer would
   *  immediately undo it the moment the device moves. */
  private setRotation(value: string): void {
    if (value === ROTATION_AUTO) {
      return this.applyAndVerify(
        'rotation=auto',
        () => this.shellFull(['settings', 'put', 'system', 'accelerometer_rotation', '1']),
        () => this.readSetting('system', 'accelerometer_rotation'),
        (v) => v === '1',
        'Writing system settings requires an unrestricted adb shell.',
      );
    }
    this.applyAndVerify(
      'auto-rotate off',
      () => this.shellFull(['settings', 'put', 'system', 'accelerometer_rotation', '0']),
      () => this.readSetting('system', 'accelerometer_rotation'),
      (v) => v === '0',
      'Writing system settings requires an unrestricted adb shell.',
    );
    const target = String(rotationToUserRotation(value));
    this.applyAndVerify(
      `rotation=${value}`,
      () => this.shellFull(['settings', 'put', 'system', 'user_rotation', target]),
      () => this.readSetting('system', 'user_rotation'),
      (v) => v === target,
      'Writing system settings requires an unrestricted adb shell.',
    );
  }
}
