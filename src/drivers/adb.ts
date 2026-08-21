import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Driver, DeviceInfo, Element, HierarchySource, LockKind, Platform, ScreenState, ToolProbe, Viewport,
  StartOpts, StartResult, StopOpts, StopResult,
} from '../types';
import type { RawImage } from '../image';
import { Companion, companionEnabled, releaseCompanionOn } from '../companion/manager';
import { CliError, NoWindowError, probeFailure } from '../errors';
import { runText, runBinary, sleepSync, commandExists, spawnDetached, TextResult } from '../exec';
import { parseHierarchy, parseRotation } from '../ui/android-parse';
import { viewportFor } from '../ui/viewport';
import {
  SettingKey,
  ROTATION_AUTO,
  canonicalFontScale,
  rotationToUserRotation,
  userRotationToRotation,
} from '../device/settings';
import { assertClaimable, claimsEnabled, selectAndClaim } from '../device/claims';
import { err } from '../output';
import { pollUntil, throttledProgress } from '../wait';

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


/**
 * What kind of screen lock a `dumpsys lock_settings` dump describes. Pure, and exported so
 * the two measured rules below are unit-testable without a device.
 *
 *   * MATCH CASE-INSENSITIVELY. The string changed between releases — `CredentialType: Pin`
 *     on API 32, `CredentialType: PIN` on API 35.
 *   * NEVER read the neighbouring `Quality` field. It reported 196608 on API 32 and 0 on API
 *     35 for two devices that BOTH had a PIN set, so trusting it would report a locked phone
 *     as unlocked — and "no lock" is exactly what licenses us to walk past a keyguard.
 *
 * Anything unrecognized is `unknown`, never `none`: a failed read must not be able to grant
 * permission that a successful read would have withheld.
 *
 * MEASURED GAP: API 29 does not print `CredentialType` at all — its dump is just
 * `SP Enabled` / `SP Handle` / `SID` — so this returns `unknown` there and `vk doctor` stays
 * silent about the lock. That is the honest degrade and it costs nothing important, because
 * the read-time protection in `AdbDriver.onKeyguard` keys off `dumpsys trust`'s `deviceLocked`,
 * which works on API 29. `SID` looks like a usable substitute but is not: only the
 * credential-present case has been observed, so reading it could only ever be a guess.
 */
export function parseLockKind(dump: string): LockKind {
  const m = /CredentialType:\s*(\w+)/i.exec(dump);
  switch (m?.[1].toLowerCase()) {
    case 'none':
      return 'none';
    case 'pin':
      return 'pin';
    case 'pattern':
      return 'pattern';
    case 'password':
      return 'password';
    default:
      return 'unknown';
  }
}

const SYSTEMUI_ID_PREFIX = 'com.android.systemui:id/';
/** The platform's own namespace. Neutral evidence — see `looksLikeSystemUi`. */
const FRAMEWORK_ID_PREFIX = 'android:id/';

/**
 * Is every package-qualified resource-id in this hierarchy the system's rather than an app's?
 *
 * The free half of the keyguard check (see `AdbDriver.onKeyguard`). Pure, and exported so the
 * discriminator is unit-testable without a device.
 *
 * Two rules, both measured on a locked Pixel 3a (API 32):
 *
 *   * Nodes with no package-qualified id are SKIPPED, not counted either way. Most nodes have
 *     no resource-id at all, and a Flutter app has none anywhere, so the answer hinges on
 *     whether any APP id appears rather than on a ratio.
 *   * `android:` is NEUTRAL, not disqualifying. The lock screen inflates framework notification
 *     layouts inside SystemUI's rows — `android:id/status_bar_latest_event_content`,
 *     `android:id/icon` — so treating the platform namespace as "this must be an app" made the
 *     check pass on a bare keyguard and fail once a notification was on it. One third-party
 *     package id is proof we are looking at an app; none, plus at least one SystemUI id, is the
 *     keyguard's signature.
 *
 * False positives are cheap and safe: they cost one `dumpsys trust`, which then reports the
 * device unlocked and the elements are returned untouched.
 */
export function looksLikeSystemUi(els: Element[]): boolean {
  let sawSystemUi = false;
  for (const e of els) {
    if (!e.id.includes(':id/')) continue;
    if (e.id.startsWith(SYSTEMUI_ID_PREFIX)) {
      sawSystemUi = true;
      continue;
    }
    if (e.id.startsWith(FRAMEWORK_ID_PREFIX)) continue;
    return false;
  }
  return sawSystemUi;
}

/** Screen-lock kind for a serial WITHOUT building a driver — and therefore without taking a
 *  claim, which is what lets `vk doctor` report it while staying the read-only survey it is. */
export function lockKindOf(serial: string): LockKind {
  try {
    return parseLockKind(runText(ADB, ['-s', serial, 'shell', 'dumpsys', 'lock_settings']).stdout);
  } catch {
    return 'unknown';
  }
}

/** Short probes only — a boot poll must not block the event loop (see wait.ts). */
const PROBE_TIMEOUT_MS = 5000;
/** The boot animation lags sys.boot_completed; waiting it out makes dumps less flaky,
 *  but it is advisory — never fail a boot because the animation is still running. */
const BOOTANIM_TIMEOUT_MS = 15000;

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
  // `power` is a TOGGLE, so it cannot express "make sure the screen is on". sleep/wakeup
  // are the directional pair, and they are what the wake-before-dump path below uses.
  power: 26,
  sleep: 223,
  wakeup: 224,
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

/** Idle window the companion waits for before dumping. Kept at the stock command's own
 *  1000ms so behaviour is unchanged — and it is free: on a warm accessibility bridge the
 *  screen has already been quiet, so waitForIdle returns at once (measured: `dump 1000`
 *  costs the same ~10ms as `dump 0`). The stock path pays a full second for it only
 *  because a freshly connected bridge has no history of quiet to draw on. */
const COMPANION_IDLE_MS = 1000;

/** What both capture paths say when there is no window to read: AOSP's DumpCommand prints
 *  "ERROR: null root node returned by UiTestAutomationBridge." and writes no file, and the
 *  companion reports the same condition from getRootInActiveWindow(). Transient — see
 *  NoWindowError. */
const NULL_ROOT = /null root node/i;

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

/** How long to let the screen settle after a wakeup before reading it. Long enough for
 *  the unlock/wake animation, short enough that it is noise next to the dump it precedes. */
const WAKE_SETTLE_MS = 600;

/** The three `global` scales behind the `animations` setting. All must be zero for it to
 *  read `off` — one live scale is enough to make a dump flaky. */
const ANIMATION_SCALES = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
/**
 * Parse `adb devices -l` output into DeviceInfo[]. PURE — exported for unit tests
 * and reused by the device-lifecycle layer, which needs the attached-device list
 * without a resolved driver.
 */
export function parseAdbDevices(stdout: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  // The first line is the "List of devices attached" header.
  for (const line of stdout.split('\n').slice(1)) {
    const t = line.trim();
    if (!t || t.startsWith('*')) continue;
    const fields = t.split(/\s+/);
    const serial = fields[0];
    const state = fields[1];
    if (!serial || !state) continue;
    const info: DeviceInfo = {
      serial,
      state,
      platform: 'android',
      // adb addresses emulators as emulator-<console-port>; everything else is
      // a real handset, which verikun never power-cycles.
      kind: serial.startsWith('emulator-') ? 'emulator' : 'physical',
    };
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

/** Attached Android devices/emulators. Device-unbound (no serial needed). */
export function listAdbDevices(): DeviceInfo[] {
  return parseAdbDevices(runText(ADB, ['devices', '-l']).stdout);
}

// --- emulator (AVD) lifecycle ----------------------------------------------

/**
 * Locate the SDK's `emulator` binary. PURE given `exists` — exported for unit tests.
 * Returns null when nothing is found; THROWS when VERIKUN_EMULATOR is set but
 * unusable, because silently ignoring an explicit override is how you spend an hour
 * wondering which binary ran.
 *
 * Mirrors `const ADB = process.env.ADB || 'adb'`, but needs the extra fallbacks:
 * unlike `adb`, the SDK installer does not put `emulator` on PATH, and ANDROID_HOME
 * is frequently unset on a developer laptop.
 */
export function resolveEmulatorBinary(opts: {
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  platform: NodeJS.Platform;
  home: string;
}): string | null {
  const { env, exists, platform, home } = opts;
  const bin = platform === 'win32' ? 'emulator.exe' : 'emulator';

  const override = env.VERIKUN_EMULATOR;
  if (override) {
    if (!exists(override)) {
      throw new CliError(`VERIKUN_EMULATOR is set to '${override}', which is not an executable file.`, 3);
    }
    return override;
  }
  if (exists(bin)) return bin;

  const candidates: string[] = [];
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (root) candidates.push(join(root, 'emulator', bin));
  }
  // When ADB points into an SDK tree, its sibling emulator/ dir is the right one.
  const adb = env.ADB;
  if (adb && (adb.includes('/') || adb.includes('\\'))) {
    candidates.push(join(dirname(adb), '..', 'emulator', bin));
  }
  if (platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Android', 'sdk', 'emulator', bin));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local) candidates.push(join(local, 'Android', 'Sdk', 'emulator', bin));
  } else {
    candidates.push(join(home, 'Android', 'Sdk', 'emulator', bin));
    candidates.push(join(home, 'android-sdk', 'emulator', bin));
    candidates.push(join('/usr', 'lib', 'android-sdk', 'emulator', bin));
  }
  return candidates.find(exists) ?? null;
}

/** Resolve the emulator binary or explain, actionably, how to point us at it. */
export function requireEmulatorBinary(): string {
  const bin = resolveEmulatorBinary({
    env: process.env,
    exists: commandExists,
    platform: process.platform,
    home: homedir(),
  });
  if (bin) return bin;
  throw new CliError(
    'Could not find the Android `emulator` binary (needed to start an AVD).\n' +
      'Looked on PATH, $ANDROID_HOME / $ANDROID_SDK_ROOT, next to $ADB, and the default SDK location.\n' +
      'Set VERIKUN_EMULATOR=/path/to/emulator, or install the SDK\'s "emulator" package.',
    3,
  );
}

/**
 * Parse `emulator -list-avds`. PURE — exported for unit tests. Some setups
 * interleave `INFO |`/`Warning:` chatter, so keep only lines that look like an
 * AVD name (the charset avdmanager permits).
 */
export function parseAvdList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
}

/** AVD names defined on this host. [] when the emulator binary is missing. */
export function listAvds(): string[] {
  let bin: string;
  try {
    bin = requireEmulatorBinary();
  } catch {
    return []; // listing degrades; only ACTING on a device fails loudly
  }
  try {
    return parseAvdList(runText(bin, ['-list-avds'], { timeout: 15000 }).stdout);
  } catch {
    return [];
  }
}

/** Parse `adb emu avd name`, which prints the name then an `OK` status line. PURE. */
export function parseEmuAvdName(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^(OK|KO)\b/.test(l));
  return line ?? '';
}

/** Which AVD is running as `serial`? '' when it can't be determined (console not
 *  up yet, auth token missing, not an emulator). Never throws. */
export function avdNameOf(serial: string): string {
  try {
    const r = runText(ADB, ['-s', serial, 'emu', 'avd', 'name'], { timeout: 3000 });
    return r.code === 0 ? parseEmuAvdName(r.stdout) : '';
  } catch {
    return '';
  }
}

/** Serials of running emulators whose AVD name matches `name`. */
function runningSerialsFor(name: string): string[] {
  return listAdbDevices()
    .filter((d) => d.kind === 'emulator')
    .filter((d) => avdNameOf(d.serial).toLowerCase() === name.toLowerCase())
    .map((d) => d.serial);
}

/** One short device-shell probe. Returns '' on any failure — "not ready yet". */
function getprop(serial: string, prop: string): string {
  try {
    const r = runText(ADB, ['-s', serial, 'shell', 'getprop', prop], { timeout: PROBE_TIMEOUT_MS });
    return r.code === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Boot an AVD and wait until it is genuinely usable (`sys.boot_completed`).
 * Idempotent: an AVD that is already running returns `started: false` immediately —
 * that is what makes "ensure a device is up" cheap for `vk server` to offer.
 */
export async function bootAvd(name: string, opts: StartOpts): Promise<StartResult> {
  const bin = requireEmulatorBinary();
  const t0 = Date.now();

  const already = runningSerialsFor(name);
  if (already.length) {
    // --wipe is rejected upstream for a running target (see lifecycle.ts), so
    // reaching here means a plain start: leave the live device alone.
    return { serial: already[0], started: false, ready: true, waitedMs: 0 };
  }

  const before = new Set(listAdbDevices().map((d) => d.serial));
  const logPath = join(tmpdir(), `verikun-emulator-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
  opts.onProgress?.(`booting AVD '${name}' — log: ${logPath}`);
  spawnDetached(bin, ['-avd', name, ...(opts.wipe ? ['-wipe-data'] : [])], {
    logFile: logPath,
    // The emulator must not hold a handle on whatever directory vk was run from.
    cwd: tmpdir(),
    onError: (e) => opts.onProgress?.(`emulator failed to start: ${e.message}`),
  });

  if (!opts.wait) {
    // Android assigns emulator-<port> at boot, so with no wait there is no serial
    // to report yet — say so rather than inventing one.
    return { serial: null, started: true, ready: false, waitedMs: Date.now() - t0, logPath };
  }

  const tick = throttledProgress(opts.onProgress, 10_000, (ms) =>
    `waiting for '${name}' to boot… ${Math.round(ms / 1000)}s`,
  );

  // Diff first (the console is not addressable in the first seconds, so `emu avd
  // name` is unavailable), then confirm by name once it answers — the confirmation
  // is what keeps two concurrent boots from claiming each other's serial.
  const serial = await pollUntil(
    () => {
      const fresh = listAdbDevices().filter((d) => d.kind === 'emulator' && !before.has(d.serial));
      if (!fresh.length) return undefined;
      const named = fresh.find((d) => avdNameOf(d.serial).toLowerCase() === name.toLowerCase());
      if (named) return named.serial;
      return fresh.length === 1 ? fresh[0].serial : undefined;
    },
    { timeoutMs: opts.timeoutMs, onTick: tick },
  );
  if (!serial) {
    throw new CliError(
      `'${name}' did not appear in \`adb devices\` within ${Math.round(opts.timeoutMs / 1000)}s ` +
        `(the emulator may still be starting; log: ${logPath})`,
      1,
    );
  }

  const remaining = () => Math.max(0, opts.timeoutMs - (Date.now() - t0));
  const booted = await pollUntil(() => (getprop(serial, 'sys.boot_completed') === '1' ? true : undefined), {
    timeoutMs: remaining(),
    onTick: tick,
  });
  if (!booted) {
    // Leave it running: a slow machine is retryable, and killing it would throw away
    // most of a boot the user is about to want.
    throw new CliError(
      `'${name}' (${serial}) did not finish booting within ${Math.round(opts.timeoutMs / 1000)}s ` +
        `— it is still starting, so retrying may succeed (log: ${logPath})`,
      1,
    );
  }

  // Advisory: dumps are flaky while the boot animation plays. Never fatal.
  await pollUntil(() => (getprop(serial, 'init.svc.bootanim') === 'stopped' ? true : undefined), {
    timeoutMs: Math.min(BOOTANIM_TIMEOUT_MS, remaining()),
  });

  const waitedMs = Date.now() - t0;
  opts.onProgress?.(`'${name}' ready as ${serial} (${(waitedMs / 1000).toFixed(1)}s)`);
  return { serial, started: true, ready: true, waitedMs, logPath };
}

/** Shut down a running emulator via its console, and wait for adb to forget it. */
export async function killEmulator(serial: string, opts: StopOpts): Promise<StopResult> {
  const present = () => listAdbDevices().some((d) => d.serial === serial);
  if (!present()) return { serial, stopped: false };

  opts.onProgress?.(`stopping ${serial}…`);
  try {
    runText(ADB, ['-s', serial, 'emu', 'kill'], { timeout: PROBE_TIMEOUT_MS });
  } catch {
    /* the console may already be gone; the poll below is the real check */
  }
  const gone = await pollUntil(() => (present() ? undefined : true), { timeoutMs: opts.timeoutMs });
  if (!gone) {
    throw new CliError(`${serial} is still attached ${Math.round(opts.timeoutMs / 1000)}s after \`emu kill\`.`, 1);
  }
  // The AVD's lock files outlive the process by a moment; booting the same AVD
  // immediately afterwards fails without this settle. (Why `restart` is one
  // primitive rather than stop-then-start composed by a caller.)
  await pollUntil(() => undefined, { timeoutMs: 1000, intervalMs: 1000 });
  opts.onProgress?.(`${serial} stopped`);
  return { serial, stopped: true };
}

export class AdbDriver implements Driver {
  readonly platform: Platform = 'android';
  private readonly requested?: string;
  private cachedSerial?: string;
  /** null = asked and failed. Cached either way: getElements runs on a ~300ms poll
   *  during auto-wait, and a broken `wm size` must not cost a round-trip every time. */
  private cachedScreen?: { width: number; height: number } | null;
  /** Rotation of the most recent dump — see viewport(). */
  private lastRotation?: number;
  /** undefined = not built yet, null = opted out. See companionOrNull(). */
  private companion?: Companion | null;

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
    return listAdbDevices();
  }

  resolvedSerial(): string {
    if (this.cachedSerial) return this.cachedSerial;
    if (this.requested) {
      // An explicit --device is trusted verbatim and costs no `adb devices` round trip —
      // so the claim check here is one small file read, and the list of free alternatives
      // for the refusal message is only paid for if we are actually going to refuse.
      if (claimsEnabled()) assertClaimable(this.requested, 'android', () => this.usableDevices());
      this.cachedSerial = this.requested;
      return this.cachedSerial;
    }
    const usable = this.usableDevices();
    if (!claimsEnabled()) {
      if (usable.length > 1) {
        const list = usable.map((d) => '  ' + d.serial + (d.model ? ` (${d.model})` : '')).join('\n');
        throw new CliError(`Multiple devices connected; pass --device <serial> (or set VERIKUN_DEVICE):\n${list}`, 2);
      }
      this.cachedSerial = usable[0].serial;
      return this.cachedSerial;
    }
    // Claims turn "ambiguous, you decide" into "one is free, take it" — and a single
    // attached device still goes through here, because "someone else is on the only
    // phone" is exactly where being told beats finding out twenty minutes later.
    const picked = selectAndClaim(usable, 'android');
    if (picked.total > 1) {
      err(`[verikun] auto-selected ${picked.serial} — ${picked.total} attached, ${picked.skipped.length} held by another job`);
    }
    this.cachedSerial = picked.serial;
    return this.cachedSerial;
  }

  /** Attached devices in a drivable state, or the honest exit-3 explanation of why none is. */
  private usableDevices(): DeviceInfo[] {
    const all = this.listDevices();
    const usable = all.filter((d) => d.state === 'device');
    if (usable.length === 0) {
      if (all.length) {
        const states = all.map((d) => `${d.serial}=${d.state}`).join(', ');
        throw new CliError(`No usable Android device (states: ${states}). Authorize/reconnect it.`, 3);
      }
      throw new CliError('No Android devices/emulators connected. Start one, then `verikun devices`.', 3);
    }
    return usable;
  }

  private withSerial(args: string[]): string[] {
    return ['-s', this.resolvedSerial(), ...args];
  }

  private shell(args: string[], timeout?: number): string {
    return runText(ADB, this.withSerial(['shell', ...args]), { timeout }).stdout;
  }

  getElements(opts: { all?: boolean } = {}): Element[] {
    // Ask whether the display is even on BEFORE dumping. Measured at ~85ms against a 278ms
    // read, and it pays for itself twice over when the answer is "no": the dump that would
    // have returned the wrong screen is skipped entirely rather than done and discarded.
    //
    // It cannot be deferred to "only if the hierarchy looks wrong", which is what this
    // originally did. A dozing device does not reliably show SystemUI: a Motorola on API 29
    // serves its VENDOR always-on display (`@clock`, `@date`, `@battery_progress`, package
    // `com.motorola.*`), which no package heuristic can tell from an app. The display being
    // off is the only signal that generalises — if it is off, the app is not on screen,
    // whoever drew what is there.
    if (this.readWakefulness() === false) {
      err('note: the display is off — waking the device before reading the screen');
      this.wakeAndUnlock();
    }

    const els = this.captureElements(opts);
    // Second net, for a device that is awake but still behind the keyguard.
    if (!this.keyguardReason(els)) return els;

    err('note: the app is not on screen — trying to dismiss the keyguard');
    this.wakeAndUnlock();

    const after = this.captureElements(opts);
    const reason = this.keyguardReason(after);
    if (!reason) return after;

    const lock = this.readLockKind();
    const what =
      reason === 'locked'
        ? `The device is on the lock screen${lock === 'unknown' ? '' : ` (${lock})`}`
        : "The device's display will not stay on";
    throw new CliError(
      `${what}, so this read would return the keyguard rather than the app — which would look ` +
        'like a successful read of the wrong screen.\n' +
        (reason === 'locked'
          ? 'Remove the screen lock on your test device (Settings > Security), then `verikun device ' +
            'prep` to stop the display sleeping in the first place.\n' +
            'verikun never asks for or stores a device PIN, so it cannot unlock this for you.'
          : 'Keep the display awake with `verikun device prep`, or wake it with `verikun key wakeup`.'),
      3,
    );
  }

  private captureElements(opts: { all?: boolean }): Element[] {
    const xml = this.dumpXml();
    // Read off the dump we already have: free, and it refreshes every capture, so a
    // device rotated mid-run is handled without re-asking for the screen size.
    this.lastRotation = parseRotation(xml);
    return parseHierarchy(xml, { ...opts, screen: this.screenOrNull() ?? undefined });
  }

  /**
   * Why is the system UI what we just read, rather than the app? `null` means it isn't — we
   * are looking at the app and the elements are good.
   *
   * MEASURED, and the reason this check exists at all: a sleeping display does not reliably
   * fail the read. The companion serves a hierarchy quite happily while the device is
   * `Dozing`, so the dump SUCCEEDS and hands back a perfectly well-formed tree of
   * `com.android.systemui` — a false green, which is worse than the hang it was assumed to be.
   *
   * TWO reasons, not one. `deviceLocked` alone is not enough: it is only true behind a SECURE
   * credential, so a phone with no lock (or a swipe lock) reports `deviceLocked=0` while
   * dozing and still shows the ambient keyguard rather than the app. Measured on a Pixel 3a
   * once its PIN was removed — exit 0 with 36 SystemUI nodes, the same false green again.
   *
   * Staged so the happy path costs nothing: `looksLikeSystemUi` reads only ids we already
   * have, and the `dumpsys` round-trips run ONLY when that says the whole screen belongs to
   * the system. That ordering is also what stops this hijacking a notification shade the
   * caller deliberately opened — the shade looks identical, but the device is neither locked
   * nor asleep, so both reasons come back false and the elements are returned untouched.
   */
  private keyguardReason(els: Element[]): 'locked' | 'display-off' | null {
    if (!looksLikeSystemUi(els)) return null;
    if (this.deviceLocked() === true) return 'locked';
    if (this.readWakefulness() === false) return 'display-off';
    return null;
  }

  /** `dumpsys trust` reports `deviceLocked=1` while the keyguard is up. `null` = could not tell,
   *  which never triggers a refusal — an unreadable probe must not block a legitimate read. */
  private deviceLocked(): boolean | null {
    try {
      const m = /deviceLocked=(\d)/.exec(this.shell(['dumpsys', 'trust']));
      return m ? m[1] === '1' : null;
    } catch {
      return null;
    }
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

  /** The resident companion, when opted in. Built lazily so a run that never reads the
   *  hierarchy never touches the device with it. */
  private companionOrNull(): Companion | null {
    if (!companionEnabled()) return null;
    if (this.companion === undefined) {
      this.companion = new Companion({
        adb: ADB,
        serial: this.resolvedSerial(),
        // Calibration compares the companion against exactly the dump the rest of verikun
        // would otherwise have used, so pass the stock path itself.
        stockDump: () => this.stockDumpXml(),
      });
    }
    return this.companion;
  }

  /** Which read path the next getElements() will take. See `Driver.hierarchySource`. */
  hierarchySource(): HierarchySource {
    if (!companionEnabled()) return { path: 'stock', detail: 'companion off (VERIKUN_COMPANION)' };
    const companion = this.companionOrNull();
    if (!companion) return { path: 'stock', detail: 'companion unavailable' };
    const suppressed = companion.suppressedReason();
    if (suppressed) return { path: 'stock', detail: `companion ${suppressed}` };
    return { path: 'companion', detail: companion.stateSummary() };
  }

  private dumpXml(): string {
    // The companion answers in ~40ms against ~2400ms for the stock path. A null here means
    // it could not serve the read AND has already handed the UiAutomation connection back —
    // which matters, because the stock dump below is SIGKILLed while it is held. A
    // NoWindowError propagates instead: there is nothing for the stock path to read either,
    // and re-asking it would only burn the caller's wait budget more slowly.
    const fast = this.companionOrNull()?.dump(COMPANION_IDLE_MS);
    if (fast) return fast;
    return this.stockDumpXml();
  }

  private stockDumpXml(): string {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = DUMP_PATHS[Math.min(attempt, DUMP_PATHS.length - 1)];
      // DELETE THE FILE FIRST, in the same device shell. `uiautomator dump` writes to a
      // fixed path and leaves the PREVIOUS dump there whenever it fails — and it fails
      // without saying so in the exit code: AOSP's DumpCommand prints "ERROR: could not get
      // idle state" and returns normally when waitForIdle times out (an animating screen),
      // and the whole process is SIGKILLed if something else holds the device's single
      // UiAutomation connection. Reading the file back then returns a stale screen that is
      // perfectly well-formed, so every check below passes and the caller taps coordinates
      // from a screen that is minutes old. MEASURED: a dump killed at 18:46 happily served
      // the 18:44 hierarchy. Removing it first makes that impossible — `cat` can only
      // succeed if THIS dump wrote it.
      const dump = runText(ADB, this.withSerial(['shell', `rm -f ${path}; uiautomator dump ${path}`]), {
        timeout: 15000,
      });
      const cat = runBinary(ADB, this.withSerial(['exec-out', 'cat', path]));
      const xml = cat.stdout.toString('utf8');
      if (xml.includes('<hierarchy')) return xml;
      lastErr = `${dump.stdout} ${dump.stderr} ${cat.stderr}`.replace(/\s+/g, ' ').trim();
      // No window is not a failed capture — it is a successful reading of a screen that has
      // nothing on it yet. Retrying it here just spends someone else's wait budget three
      // times as fast; hand it up to whoever knows how long they are willing to wait.
      if (NULL_ROOT.test(lastErr)) {
        throw new NoWindowError(
          'No window to read: the app has not drawn yet (force-stopped, or mid-launch). ' +
            'Retry, or use a command that waits (`vk wait`, or any selector lookup).',
        );
      }
      if (attempt === 0) {
        // A sleeping display is the other documented cause of a failed read, so it is checked
        // here, lazily, where it costs nothing until something has already gone wrong.
        this.wakeIfAsleep();
        // A companion holds the device's ONE UiAutomation connection and SIGKILLs anything
        // else that wants it — including this dump. It outlives the process that started it,
        // so a later command that never opted in would fail for as long as it lives. Ask it
        // to let go and try again: verikun's own helper must not be why verikun cannot read
        // the screen. No companion running is the normal case and costs one refused connect.
        releaseCompanionOn(this.resolvedSerial());
      }
    }
    throw new CliError(
      `Failed to capture UI hierarchy after 3 attempts. ${lastErr}\n` +
        'Tip: prepare the device once with `verikun device prep` (disables animations, keeps the ' +
        'display awake) and ensure the screen is idle.',
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
      case 'animations': {
        // Three separate scales, one knob: any of them still animating is enough to make a
        // dump flaky, so `off` means all three are zero and anything else reads as `on`.
        const vals = ANIMATION_SCALES.map((k) => this.readSetting('global', k));
        if (vals.some((v) => v === null)) return null;
        return vals.every((v) => Number(v) === 0) ? 'off' : 'on';
      }
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
      case 'screen-timeout':
        // Unset is not a meaningful default here (unlike font_scale, whose absence means
        // 1.0) — the device always has one. Report null so a snapshot declines rather than
        // restoring to a number we invented.
        return this.readSetting('system', 'screen_off_timeout');
      case 'dnd': {
        // zen_mode: 0 = off, 1 = priority only, 2 = total silence, 3 = alarms only. Our
        // on|off domain only claims "is anything suppressing notifications", so any
        // non-zero mode is `on` — and `set` below picks one specific mode to turn it on.
        const v = this.readSetting('global', 'zen_mode');
        return v === null ? 'off' : v !== '0' ? 'on' : 'off';
      }
      case 'doze': {
        // `dumpsys deviceidle enabled` prints a bare 1/0. Note this is whether the idle
        // MANAGER is enabled, not the momentary idle state (`get deep`, which reports
        // ACTIVE/IDLE and swings on its own) — only the former is a setting we can hold.
        const v = this.shell(['dumpsys', 'deviceidle', 'enabled']).trim();
        if (v === '1') return 'on';
        if (v === '0') return 'off';
        return null;
      }
    }
  }

  setDeviceSetting(key: SettingKey, value: string): void {
    switch (key) {
      case 'animations':
        return this.applyAndVerify(
          `animations=${value}`,
          () => {
            // One shell per scale, but only the LAST result is reported — every write here
            // is the same command against the same namespace, so a failure looks identical
            // whichever of the three refused, and the readback below is the real contract.
            let last!: TextResult;
            for (const k of ANIMATION_SCALES) {
              last = this.shellFull(['settings', 'put', 'global', k, value === 'on' ? '1' : '0']);
            }
            return last;
          },
          () => this.getDeviceSetting('animations'),
          (v) => v === value,
          'Writing global settings requires an unrestricted adb shell.',
        );
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
      case 'screen-timeout':
        return this.applyAndVerify(
          `screen-timeout=${value}`,
          () => this.shellFull(['settings', 'put', 'system', 'screen_off_timeout', value]),
          () => this.getDeviceSetting('screen-timeout'),
          (v) => v === value,
          'Writing system settings requires an unrestricted adb shell.',
        );
      case 'dnd':
        // `priority` rather than `on`/`none`: total silence also suppresses ALARMS, which
        // would be a surprising thing for a testing tool to leave on a borrowed phone.
        // Priority-only is enough to stop a heads-up notification stealing a tap.
        return this.applyAndVerify(
          `dnd=${value}`,
          () => this.shellFull(['cmd', 'notification', 'set_dnd', value === 'on' ? 'priority' : 'off']),
          () => this.getDeviceSetting('dnd'),
          (v) => v === value,
          'Setting Do Not Disturb needs `cmd notification` (API 28+); some OEM skins gate it behind ' +
            'notification-policy access.',
        );
      case 'doze':
        return this.applyAndVerify(
          `doze=${value}`,
          () => this.shellFull(['dumpsys', 'deviceidle', value === 'on' ? 'enable' : 'disable']),
          () => this.getDeviceSetting('doze'),
          (v) => v === value,
          '`dumpsys deviceidle` is refused on some locked-down builds.',
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

  // --- screen + lock state --------------------------------------------------

  /** Best-effort, never throws: this sits on the READ path, and a probe that could fail
   *  a dump would be worse than the hang it exists to prevent. */
  screenState(): ScreenState {
    return { awake: this.readWakefulness(), lock: this.readLockKind() };
  }

  private readWakefulness(): boolean | null {
    try {
      const m = /mWakefulness=(\w+)/.exec(this.shell(['dumpsys', 'power']));
      return m ? m[1].toLowerCase() === 'awake' : null;
    } catch {
      return null;
    }
  }

  private readLockKind(): LockKind {
    try {
      return parseLockKind(this.shell(['dumpsys', 'lock_settings']));
    } catch {
      return 'unknown';
    }
  }

  /** Wake the display and clear a non-secure keyguard, then let the screen settle. Never
   *  throws — deciding whether the result is good enough is `getElements`' job. */
  private wakeAndUnlock(): void {
    this.pressKey('wakeup');
    sleepSync(WAKE_SETTLE_MS);
    this.dismissKeyguard();
    sleepSync(WAKE_SETTLE_MS);
  }

  /** Only ever clears a SWIPE lock. On a secure keyguard `wm dismiss-keyguard` raises the
   *  credential prompt instead, which is why callers must check `lock` first. */
  dismissKeyguard(): boolean {
    try {
      this.shell(['wm', 'dismiss-keyguard']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wake a sleeping display before retrying a dump that already failed.
   *
   * Best-effort and never throws: refusing is `getElements`' job, which owns the ONE decision
   * about whether we are looking at the app or the keyguard. This only handles the narrower
   * case where the stock dump genuinely could not read a sleeping screen at all.
   *
   * Called lazily, after the first attempt has failed, so the happy path pays nothing — an
   * extra `dumpsys power` on every read would tax every command in the CLI to help the rare one.
   */
  private wakeIfAsleep(): void {
    // `null` means the probe could not tell. Do nothing — the dump may well be failing for an
    // unrelated reason, and pressing wakeup at random is not a fix.
    if (this.screenState().awake !== false) return;
    err('note: the display was asleep — waking it before retrying the read');
    this.pressKey('wakeup');
    sleepSync(WAKE_SETTLE_MS);
  }
}
