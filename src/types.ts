// Shared types for verikun. The Element model is normalized across platforms so
// the selector / formatting / command layers are fully platform-agnostic — each
// Driver is responsible only for producing Element[] from its native source.

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
  /** Center of bounds — the point used for taps. */
  center: Point;
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
}

/**
 * A platform backend. Android is implemented via `adb`; iOS via `simctl`
 * (screenshots today) and `idb` (interaction — planned).
 */
export interface Driver {
  readonly platform: Platform;
  /** List attached devices/simulators (does not require a single device to be resolved). */
  listDevices(): DeviceInfo[];
  /** Resolve the concrete device serial/udid this driver will act on (throws if ambiguous). */
  resolvedSerial(): string;
  /** Capture + parse the current UI hierarchy into normalized elements. */
  getElements(opts?: { all?: boolean }): Element[];
  /** Raw PNG bytes of the current screen. */
  screenshot(): Buffer;
  screenSize(): { width: number; height: number };
  tap(x: number, y: number): void;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void;
  /** Type into the currently focused field. */
  inputText(text: string): void;
  pressKey(name: string): void;
  launch(appId: string): void;
  stop(appId: string): void;
  /** Wipe the app's locally stored data (login/session, prefs, caches) — a fresh-install state. */
  clearApp(appId: string): void;
  /** Best-effort current foreground app/activity, for verification. */
  currentApp(): string;
}
