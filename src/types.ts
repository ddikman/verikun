// Shared types for verikun. The Element model is normalized across platforms so
// the selector / formatting / command layers are fully platform-agnostic — each
// Driver is responsible only for producing Element[] from its native source.

import type { ClaimSummary } from './device/claims';
import type { SettingKey } from './device/settings';
import type { RawImage } from './image';

export type Platform = 'android' | 'ios';

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The on-screen rectangle, in the same coordinate space as `Element.bounds`. */
export interface Viewport {
  width: number;
  height: number;
}

/** A single node in the UI hierarchy, normalized across platforms. */
export interface Element {
  /** Sequential position within the produced (filtered) list — stable for one snapshot. */
  index: number;
  /** Full class / native type, e.g. "android.widget.Button". */
  class: string;
  /** Simplified type, e.g. "Button". */
  type: string;
  /** Full resource-id / accessibility identifier, e.g. "com.app:id/login". */
  id: string;
  /** Suffix after the last '/', e.g. "login". */
  idShort: string;
  /** Visible text. */
  text: string;
  /** content-desc / accessibility label. */
  desc: string;
  bounds: Bounds;
  /** Center of bounds. Where a tap lands unless the element straddles a screen edge —
   *  see `tapPoint()` in ui/viewport.ts. */
  center: Point;
  /** Scrolled entirely outside the screen: in the tree, but nothing of it is visible.
   *
   *  OPTIONAL AND NEGATIVE on purpose. An Element that never had a viewport applied —
   *  a test fixture, or one deserialized from an older `vk server` — must read as
   *  VISIBLE, so a missing screen size can only restore the previous behaviour and
   *  never make a real element look unreachable. Set only when known to be true. */
  offscreen?: boolean;
  /** Nesting depth in the original tree (for --tree rendering). */
  depth: number;
  clickable: boolean;
  longClickable: boolean;
  checkable: boolean;
  checked: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  enabled: boolean;
  selected: boolean;
  password: boolean;
}

export interface DeviceInfo {
  serial: string;
  /** "device" | "offline" | "unauthorized" (android) | "booted" | "shutdown" (ios) */
  state: string;
  model?: string;
  product?: string;
  platform: Platform;
  /** Optional caveat shown in `vk devices` output, e.g. for partially-supported devices. */
  note?: string;
  /**
   * Which job is currently driving this device, when one is. Filled in by `cmdDevices`
   * from the host-global claim store — never by a driver, which knows what is attached
   * but nothing about who else is using it.
   */
  claim?: ClaimSummary;
}

/**
 * The result of probing one external CLI a driver depends on (`adb`, `xcrun`, `idb`).
 * Shared by `vk doctor` — which renders every probe and keeps going — and by
 * `Driver.preflight()`, which throws on the first failure.
 */
export interface ToolProbe {
  /** Display name, e.g. "adb". */
  name: string;
  /** Whether this counts as OK for the caller's verdict — doctor's exit code, preflight's throw. */
  ok: boolean;
  /** On success, a short version/status line worth showing; on failure, the error message. */
  detail: string;
  /** Install/repair hint, shown on failure and on an advisory. */
  hint?: string;
  /**
   * Worth telling the user about, but not a broken setup: rendered with its hint like a
   * failure, yet `ok` stays true so it does not change any exit code.
   *
   * Exists because an out-of-date verikun is not the same thing as a machine that cannot
   * drive a device, and exit `3` means "a machine to fix" (see the exit-code contract).
   * Only meaningful alongside `ok: true`; `preflight()` ignores it, which is correct — an
   * advisory must never abort a flow.
   */
  advisory?: boolean;
}

/**
 * A platform backend. Android is implemented via `adb`; iOS via `simctl`
 * (screenshots today) and `idb` (interaction — planned).
 */
/** How a driver is reading the UI hierarchy — see `Driver.hierarchySource`. */
export interface HierarchySource {
  /** The path itself: `companion` (the fast on-device reader) or `stock` (uiautomator dump). */
  path: 'companion' | 'stock';
  /** Short phrase saying why — a live companion state, or the reason the fast path is off. */
  detail: string;
}

export interface Driver {
  readonly platform: Platform;
  /**
   * Verify this driver's toolchain can actually drive the target: throws
   * `CliError(…, 3)` (with an install hint) on the FIRST missing or unrunnable tool,
   * and `CliError(…, 2)` when the device is ambiguous. Cheap — at most a couple of
   * subprocesses — so `vk ai` / `vk suite` can call it before spending money on a
   * compile instead of dying at the first step that happens to need the tool.
   *
   * Deliberately STATELESS (no memoized "already checked" flag): `vk suite` re-invokes
   * it after an environment-flavoured failure to tell a transient dump flake from a
   * genuinely broken box. Memoizing here would silently disable that.
   */
  preflight(): void;
  /** List attached devices/simulators (does not require a single device to be resolved). */
  listDevices(): DeviceInfo[];
  /** Resolve the concrete device serial/udid this driver will act on (throws if ambiguous). */
  resolvedSerial(): string;
  /** Capture + parse the current UI hierarchy into normalized elements. */
  getElements(opts?: { all?: boolean }): Element[];
  /**
   * Which read path the NEXT `getElements()` will take, and why. OPTIONAL, in the shape of
   * `screenshotRaw?()`: a backend with only one way to read the hierarchy omits it, and
   * callers then say nothing rather than inventing an answer.
   *
   * It exists because a `--server` operator had no way to tell a fast read from a slow one
   * except by timing their own steps, and so could not tell a companion that never engaged
   * from one that engaged and stopped (issue #77). A speedup nobody can observe is a
   * speedup nobody can trust.
   */
  hierarchySource?(): HierarchySource;
  /** Raw PNG bytes of the current screen. */
  screenshot(): Buffer;
  /**
   * Uncompressed pixels of the current screen, skipping the device-side PNG encode —
   * markedly faster where the platform offers it (see `pngFromRaw`). OPTIONAL, and
   * `null` is a first-class answer: a backend without a raw path omits the method,
   * and one whose capture came back in an unexpected shape returns null. Either way
   * `capturePng` falls back to `screenshot()`, so this can only ever be a speedup.
   */
  screenshotRaw?(): RawImage | null;
  screenSize(): { width: number; height: number };
  /**
   * The screen rectangle the CURRENT hierarchy's coordinates live in — i.e.
   * `screenSize()` corrected for orientation — or null when it cannot be determined.
   *
   * Separate from `screenSize()` because that one reports the device's NATURAL size
   * (`wm size` does not swap in landscape), while every geometric question about an
   * element — is it on screen, where does a tap land, which way do we scroll — has to
   * be asked in the dump's own coordinate space. Null is a real answer and means
   * "assume everything is visible": a wrong viewport would strand reachable elements.
   */
  viewport(): Viewport | null;
  tap(x: number, y: number): void;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void;
  /** Type into the currently focused field. */
  inputText(text: string): void;
  pressKey(name: string): void;
  launch(appId: string): void;
  /** Install an app build from a host-side file (`.apk` / `.ipa`; `-r` semantics —
   *  reinstall keeps data where the platform supports it). */
  install(appPath: string): void;
  stop(appId: string): void;
  /** Wipe the app's locally stored data (login/session, prefs, caches) — a fresh-install state. */
  clearApp(appId: string): void;
  /** Best-effort current foreground app/activity, for verification. */
  currentApp(): string;
  /**
   * Recent device logs as a one-shot snapshot (never a live stream).
   * @param opts.lines  max trailing log lines (newest); driver default ~200
   * @param opts.appId  scope to that app (Android: uid when known, else live pid;
   *                    iOS simulator: process-name predicate). When the app isn't
   *                    running and can't be scoped, falls back to system-wide
   *                    unless `scopedOnly` is set.
   * @param opts.since  only logs at/after this device-clock marker (see deviceTime);
   *                    takes precedence over lines. Lets a run exclude pre-session logs.
   * @param opts.scopedOnly  with `appId`, return '' instead of a system-wide dump
   *                    when the app can't be scoped (archive accordion wants this).
   */
  getLogs(opts?: { lines?: number; appId?: string; since?: string; scopedOnly?: boolean }): string;
  /**
   * Current device wall-clock in logcat's timestamp format (`MM-DD HH:MM:SS.mmm`),
   * captured at run start and later passed as `getLogs({ since })`. `''` if
   * unavailable (or unsupported, e.g. iOS) — callers treat empty as "no marker".
   */
  deviceTime(): string;
  /**
   * Read a device setting (see device/settings.ts for the key set). Best-effort:
   * never throws — an unreadable or untracked setting is `null`, like currentApp()'s
   * `'(unknown)'`. Values are the table's canonical form, so a read round-trips
   * through `setDeviceSetting` unchanged (that is what makes snapshot/restore exact).
   */
  getDeviceSetting(key: SettingKey): string | null;
  /**
   * Apply a device setting and VERIFY it landed by reading it back — the underlying
   * device commands (`svc`, `cmd`, `settings put`) are fire-and-forget and silently
   * no-op on some OEM skins, so trusting the exit code would report success for a
   * change that never happened. Throws CliError(…, 3) if the value refuses to stick
   * or the platform cannot honor it.
   */
  setDeviceSetting(key: SettingKey, value: string): void;
}
