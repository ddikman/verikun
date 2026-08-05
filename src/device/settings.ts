// The device-settings capability table — what `vk device set` can change, on which
// platform, and what a value is allowed to be.
//
// This module is DATA plus pure functions, and it is deliberately platform-agnostic:
// like ui/ and image.ts it never touches adb/xcrun. The table says *what* is supported
// and *why not*; the drivers know *how*. That split is what lets one place drive all
// four consumers — argument validation, the driver switch, `vk device caps`, and the
// `vk ai` plan validator — so a new setting is a table row rather than an edit in five
// files, and a platform gap can never be documented in one place and forgotten in another.
//
// Load-bearing rule: a gap is declared, never silently absorbed. Every 'unsupported'
// entry carries the MANUAL EQUIVALENT the user should reach for instead, and every
// 'noop' carries the reason it was unnecessary. A test that believes it went offline
// while the app is still online is the worst outcome a testing tool can produce, so
// there is no fourth state that means "we tried".

import { CliError } from '../errors';
import type { Platform } from '../types';

export type SettingKey = 'airplane' | 'dark' | 'font-scale' | 'rotation' | 'stay-awake';

/**
 * - `supported`   — apply it, then verify by reading it back.
 * - `unsupported` — refuse with exit 3 and name the manual equivalent.
 * - `noop`        — succeed with a stderr note; the intent is already satisfied.
 */
export type Support = 'supported' | 'unsupported' | 'noop';

export interface SettingSpec {
  key: SettingKey;
  /** One line for `vk device caps` and the usage text. */
  describe: string;
  /** Human-readable value domain, shown verbatim in usage errors. */
  values: string;
  /** Validate + canonicalize a raw value. Throws CliError(…, 2) on anything else. */
  parse(raw: string): string;
  /** Per-platform support. `ios` describes a SIMULATOR; a physical iOS device has no
   *  scriptable settings surface at all, which the driver reports when it resolves one. */
  support: Record<Platform, Support>;
  /** Required wherever support is 'unsupported' — what to do by hand instead. */
  manual: Partial<Record<Platform, string>>;
  /** Required wherever support is 'noop', plus any platform caveat worth printing. */
  note: Partial<Record<Platform, string>>;
}

// --- value parsers ----------------------------------------------------------

const ON_OFF_ALIASES: Record<string, string> = {
  on: 'on', off: 'off',
  true: 'on', false: 'off',
  yes: 'on', no: 'off',
  enable: 'on', disable: 'off',
  enabled: 'on', disabled: 'off',
  '1': 'on', '0': 'off',
};

function parseOnOff(key: string, raw: string): string {
  const v = ON_OFF_ALIASES[raw.trim().toLowerCase()];
  if (!v) throw new CliError(`Invalid value '${raw}' for '${key}': expected on|off.`, 2);
  return v;
}

// Bounds, not taste: below ~0.5 the UI is unreadable and above ~3.0 Android's own
// accessibility slider stops, so a stray `font-scale=100` is far likelier to be a typo
// than an intent — and it would leave the device unusable enough to be hard to undo
// through the UI. Refuse it here rather than after it has been written.
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 3.0;

/**
 * Canonical string form of a scale. EVERY path that produces a font-scale value —
 * parse, the 'default' alias, and the driver's readback — must go through this, or a
 * write and its verification would compare unequal strings for the same number
 * ('1.0' vs '1') and report a perfectly good change as refused.
 */
export function canonicalFontScale(n: number): string {
  return String(n);
}

const FONT_SCALE_DEFAULT = 1.0;

function parseFontScale(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === 'default') return canonicalFontScale(FONT_SCALE_DEFAULT);
  if (!/^\d+(\.\d+)?$/.test(t)) {
    throw new CliError(`Invalid value '${raw}' for 'font-scale': expected a number like 1.3, or 'default'.`, 2);
  }
  const n = Number(t);
  if (n < FONT_SCALE_MIN || n > FONT_SCALE_MAX) {
    throw new CliError(
      `Invalid value '${raw}' for 'font-scale': must be between ${FONT_SCALE_MIN} and ${FONT_SCALE_MAX}.`,
      2,
    );
  }
  // Canonicalize so '1.30', '1.3' and '1.300' all snapshot/compare identically.
  return canonicalFontScale(n);
}

/** Android `user_rotation` values, by the name we expose. */
const ROTATIONS: Record<string, 0 | 1 | 2 | 3> = {
  portrait: 0,
  landscape: 1,
  'portrait-reverse': 2,
  'landscape-reverse': 3,
};

/** Auto-rotate (accelerometer_rotation=1), where no fixed orientation applies.
 *  It is a real value rather than a separate key so a snapshot can restore a device
 *  that was on auto-rotate to auto-rotate, instead of pinning it to whatever
 *  orientation it happened to be held in when the run started. */
export const ROTATION_AUTO = 'auto';

export const ROTATION_VALUES = [...Object.keys(ROTATIONS), ROTATION_AUTO];

function parseRotation(raw: string): string {
  const t = raw.trim().toLowerCase();
  // A bare integer is rejected on purpose: `rotation=2` is meaningless to someone
  // reading the run report, and the number-to-orientation mapping is Android's, not ours.
  if (t !== ROTATION_AUTO && !(t in ROTATIONS)) {
    throw new CliError(
      `Invalid value '${raw}' for 'rotation': expected ${ROTATION_VALUES.join('|')}.`,
      2,
    );
  }
  return t;
}

/** The fixed orientation a name pins to. Throws for `auto`, which has no fixed
 *  value — callers must branch on it before asking. */
export function rotationToUserRotation(name: string): 0 | 1 | 2 | 3 {
  const v = ROTATIONS[name.trim().toLowerCase()];
  if (v === undefined) {
    throw new CliError(`Invalid rotation '${name}': expected ${Object.keys(ROTATIONS).join('|')}.`, 2);
  }
  return v;
}

export function userRotationToRotation(value: string): string | null {
  const hit = Object.entries(ROTATIONS).find(([, v]) => String(v) === value.trim());
  return hit ? hit[0] : null;
}

// --- font-scale <-> iOS content size ----------------------------------------

// iOS takes a named Dynamic Type category where Android takes a float, so the two
// domains have to be reconciled somewhere. The float is canonical (it is the more
// precise of the two, and what Android natively stores); iOS maps to the nearest
// category and the driver echoes which one it applied, so a caller is never guessing.
//
// Scales are the real UIKit body point size for each category divided by 17pt (the
// `large` default), which is what makes 1.0 land exactly on `large` on both platforms.
const CONTENT_SIZES: ReadonlyArray<{ category: string; scale: number }> = [
  { category: 'extra-small', scale: 0.82 },
  { category: 'small', scale: 0.88 },
  { category: 'medium', scale: 0.94 },
  { category: 'large', scale: 1.0 },
  { category: 'extra-large', scale: 1.12 },
  { category: 'extra-extra-large', scale: 1.24 },
  { category: 'extra-extra-extra-large', scale: 1.35 },
  { category: 'accessibility-medium', scale: 1.65 },
  { category: 'accessibility-large', scale: 1.94 },
  { category: 'accessibility-extra-large', scale: 2.35 },
  { category: 'accessibility-extra-extra-large', scale: 2.76 },
  { category: 'accessibility-extra-extra-extra-large', scale: 3.12 },
];

/** Nearest Dynamic Type category for a font scale. Clamps rather than throwing —
 *  the value was already range-checked by parse(), so out-of-table just means the
 *  extreme end of the scale, not a caller error. */
export function fontScaleToContentSize(scale: number): string {
  let best = CONTENT_SIZES[0];
  for (const c of CONTENT_SIZES) {
    if (Math.abs(c.scale - scale) < Math.abs(best.scale - scale)) best = c;
  }
  return best.category;
}

/** Inverse, for readback. `unknown` / `unsupported` (both real simctl outputs) → null. */
export function contentSizeToFontScale(category: string): number | null {
  const hit = CONTENT_SIZES.find((c) => c.category === category.trim().toLowerCase());
  return hit ? hit.scale : null;
}

// --- the table --------------------------------------------------------------

export const SETTINGS: Record<SettingKey, SettingSpec> = {
  airplane: {
    key: 'airplane',
    describe: 'Airplane mode — cut the radios to test offline/retry handling',
    values: 'on|off',
    parse: (raw) => parseOnOff('airplane', raw),
    support: { android: 'supported', ios: 'unsupported' },
    manual: {
      ios: 'A simulator has no radio to switch off (`simctl status_bar override --wifiMode failed` ' +
        'only repaints the status bar). Use Xcode > Open Developer Tool > Network Link Conditioner, ' +
        "or toggle the host Mac's own network — the simulator shares it.",
    },
    note: {},
  },
  dark: {
    key: 'dark',
    describe: 'Dark mode / night theme',
    values: 'on|off',
    parse: (raw) => parseOnOff('dark', raw),
    support: { android: 'supported', ios: 'supported' },
    manual: {},
    note: { ios: 'simulator only — a physical iOS device has no scriptable appearance switch' },
  },
  'font-scale': {
    key: 'font-scale',
    describe: 'Text scaling factor — catches layout overflow at accessibility sizes',
    values: "a number 0.5-3.0 (e.g. 1.3), or 'default'",
    parse: parseFontScale,
    support: { android: 'supported', ios: 'supported' },
    manual: {},
    note: {
      ios: 'simulator only, and mapped to the nearest Dynamic Type category ' +
        '(iOS has named sizes, not a float) — the applied category is printed',
    },
  },
  rotation: {
    key: 'rotation',
    describe: 'Screen orientation (a fixed value also pins auto-rotate off, so it stays put)',
    values: ROTATION_VALUES.join('|'),
    parse: parseRotation,
    support: { android: 'supported', ios: 'unsupported' },
    manual: {
      ios: 'Neither `simctl ui` (appearance/content_size/increase_contrast only) nor `idb ui` ' +
        'exposes orientation. Rotate the Simulator window by hand (Cmd+Left / Cmd+Right).',
    },
    note: {},
  },
  'stay-awake': {
    key: 'stay-awake',
    describe: 'Keep the screen on while charging — a sleeping display hangs UI hierarchy dumps',
    values: 'on|off',
    parse: (raw) => parseOnOff('stay-awake', raw),
    support: { android: 'supported', ios: 'noop' },
    manual: {},
    note: { ios: 'simulators do not sleep, so there is nothing to keep awake' },
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(v: string): v is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, v);
}

// --- assignment parsing -----------------------------------------------------

export interface Assignment {
  key: SettingKey;
  /** Canonicalized by the spec's parse(). */
  value: string;
}

/**
 * Parse `key=value` positionals into validated assignments.
 *
 * `key=value` rather than `set <key> <value>` so several settings can be established in
 * one call (each needs its own snapshot entry), and so the `vk ai` compiler model has a
 * single unambiguous form to emit.
 */
export function parseDeviceAssignments(positionals: string[]): Assignment[] {
  if (positionals.length === 0) {
    throw new CliError(
      `Usage: verikun device set <key>=<value> [<key>=<value> ...]\nKeys: ${SETTING_KEYS.join(', ')}`,
      2,
    );
  }
  const out: Assignment[] = [];
  const seen = new Set<SettingKey>();
  for (const raw of positionals) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`Invalid assignment '${raw}': expected <key>=<value>, e.g. 'dark=on'.`, 2);
    }
    const key = raw.slice(0, eq).trim().toLowerCase();
    const value = raw.slice(eq + 1);
    if (!isSettingKey(key)) {
      throw new CliError(`Unknown device setting '${key}'. Known: ${SETTING_KEYS.join(', ')}.`, 2);
    }
    if (seen.has(key)) {
      throw new CliError(`Duplicate device setting '${key}' — it can only be set once per call.`, 2);
    }
    seen.add(key);
    out.push({ key, value: SETTINGS[key].parse(value) });
  }
  return out;
}

/**
 * The capability gate, applied BEFORE any device I/O so an unsupported setting fails on
 * the first step rather than midway through a flow. Returns the support state so the
 * caller can print the 'noop' note; throws CliError(…, 3) for 'unsupported'.
 */
export function checkSupport(key: SettingKey, platform: Platform): Support {
  const spec = SETTINGS[key];
  const support = spec.support[platform];
  if (support === 'unsupported') {
    const manual = spec.manual[platform];
    throw new CliError(
      `Device setting '${key}' is not supported on ${platform}.` + (manual ? `\n${manual}` : ''),
      3,
    );
  }
  return support;
}
