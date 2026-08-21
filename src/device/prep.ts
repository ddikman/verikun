// Test-device provisioning — "make this phone a good place to run tests, once".
//
// The distinction that shapes everything here is PREP vs `device set`:
//
//   * `device set` is TRANSIENT. It snapshots into the run file and the `finally` in
//     ai/suite/batch puts it back, because a test that goes offline must come back online.
//   * PREP is STICKY. Turning animations off and the display timeout up is not part of a
//     test, it is what makes tests readable at all — so it must survive the run that
//     established it, and be undone only when someone explicitly asks.
//
// That is why the snapshot lives HOST-GLOBALLY here rather than in `RunState.deviceOverrides`,
// and why no `finally` may touch it.
//
// Deliberately in its own directory (`~/.verikun/prepared/`) rather than beside the claims in
// `~/.verikun/devices/`: claims are churn — created, taken over and deleted constantly, and
// `rm ~/.verikun/devices/*` is a thing people genuinely do to clear a stuck one. A prep record
// is the ONLY copy of the values needed to put a borrowed phone back, so it must not sit in
// the directory whose contents are routinely swept.
//
// Platform-agnostic like `settings.ts` and `claims.ts`: it never touches adb/xcrun. The table
// says what a knob is, this says which knobs prep establishes and what they used to be, and
// the drivers know how.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../errors';
import { err } from '../output';
import type { DeviceKind, Platform } from '../types';
import { VERSION } from '../version';
import { deviceFileStem } from './claims';
import type { SettingKey } from './settings';

/** One knob prep establishes, with the reason it earns a place in the set. */
export interface PrepKnob {
  key: SettingKey;
  value: string;
  /** Which concrete failure this prevents. Printed by `--dry-run`; keep it measured. */
  why: string;
}

/**
 * How long a prepped device's display stays on with nothing driving it.
 *
 * Long enough to span the gap between two commands of the same flow — an agent's turn, a model
 * repair round-trip — and short enough that a phone nobody is using goes dark. A LONGER gap is
 * not a failure: `getElements()` probes wakefulness before every read and wakes the device
 * (clearing a swipe keyguard on the way), which is what makes sleeping safe to allow at all.
 */
export const PREP_SCREEN_TIMEOUT = '1m';

/** Knobs every prep applies, whatever the display policy is. */
const CORE_KNOBS: readonly PrepKnob[] = [
  { key: 'animations', value: 'off', why: 'a live animation makes `uiautomator dump` return a stale or empty screen' },
  { key: 'dnd', value: 'on', why: 'a heads-up notification lands on top of the app and steals the next tap' },
  { key: 'doze', value: 'off', why: 'battery idle suspends the background work a test is waiting on' },
];

/**
 * The default display policy: the device parks ITSELF once nobody is driving it.
 *
 * Both knobs move together, and that is the whole point. `stay-awake=on` is
 * `stay_on_while_plugged_in`, which keeps the screen up while CHARGING — and a device on USB
 * adb is always charging — so leaving it on makes `screen-timeout` inert and "never sleeps" the
 * real policy. That is what verikun used to do, and it is why teardown had to switch the display
 * off by hand, blanking the screen between every two commands of a burst (#101).
 */
const SLEEPY_DISPLAY: readonly PrepKnob[] = [
  {
    key: 'stay-awake',
    value: 'off',
    why: 'it overrides the display timeout while charging, so a tethered device would never sleep',
  },
  {
    key: 'screen-timeout',
    value: PREP_SCREEN_TIMEOUT,
    why: "the stock 15-30s blanks the display between two commands of one flow; a longer gap is woken on the next read",
  },
];

/** `--no-sleep-when-idle`: the display never turns off, which is the older prep behaviour. */
const AWAKE_DISPLAY: readonly PrepKnob[] = [
  { key: 'stay-awake', value: 'on', why: 'asked for explicitly — the display must stay lit while the device is charging' },
  { key: 'screen-timeout', value: 'max', why: 'the same, for a device that is not plugged in' },
];

/**
 * The prep set.
 *
 * Every entry has to name a failure `vk` actually has. This is not "sensible defaults for a
 * phone" — it is the shortest list that makes a hierarchy read trustworthy, and anything that
 * merely feels tidy belongs in the user's own `device set` call instead.
 *
 * The two display sets cover the SAME keys, so `--revert` restores the same surface whichever
 * policy was applied — including on a device prepped one way and then the other.
 */
export function prepKnobs(sleepWhenIdle: boolean): readonly PrepKnob[] {
  return [...CORE_KNOBS, ...(sleepWhenIdle ? SLEEPY_DISPLAY : AWAKE_DISPLAY)];
}

/** What one prepared device's record holds. */
export interface PrepRecord {
  serial: string;
  platform: Platform;
  /**
   * What each knob held BEFORE prep first touched it — the values `--revert` puts back.
   * Earliest wins (see `mergeOriginals`): prepping twice must still restore the value the
   * device had before the FIRST prep, not the one the first prep established.
   */
  original: Partial<Record<SettingKey, string>>;
  /**
   * Which display policy prep applied: `true` (the default) means the device sleeps by itself
   * after `PREP_SCREEN_TIMEOUT`, `false` (`--no-sleep-when-idle`) means it never turns off.
   */
  sleepWhenIdle: boolean;
  /** ISO — when this device was first prepared. */
  preparedAt: string;
  /** verikun that wrote it. Diagnostics only; never gates anything. */
  version: string;
}

/** Injection seam for the unit suite — same shape as `ClaimOpts`. */
export interface PrepOpts {
  home?: string;
  now?: number;
}

export function prepDir(o: PrepOpts = {}): string {
  return join(o.home ?? homedir(), '.verikun', 'prepared');
}

function pathFor(serial: string, o: PrepOpts): string {
  return join(prepDir(o), `${deviceFileStem(serial)}.json`);
}

/**
 * Read a device's prep record. Missing, unreadable or malformed all mean NOT PREPARED —
 * the same tolerant posture as `readClaim` and the plan cache. A poisoned file must not be
 * able to make a device permanently un-preppable.
 */
export function readPrep(serial: string, o: PrepOpts = {}): PrepRecord | null {
  const p = pathFor(serial, o);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, 'utf8')) as PrepRecord;
    // Guard the field every decision reads. A file that parses as JSON but is not a prep
    // record must not make `--revert` iterate undefined.
    if (typeof r?.serial !== 'string' || typeof r?.original !== 'object' || r.original === null) return null;
    return r;
  } catch (e) {
    err(`[verikun] ignoring unreadable prep record ${p} (${(e as Error).message})`);
    return null;
  }
}

export function isPrepared(serial: string, o: PrepOpts = {}): boolean {
  return readPrep(serial, o) !== null;
}

/**
 * Earliest wins. Re-prepping a device (or prepping one whose knobs have drifted) must never
 * overwrite the pre-prep value with a value prep itself established — that would make
 * `--revert` restore the device to prepped, i.e. do nothing at all, silently.
 */
export function mergeOriginals(
  prior: Partial<Record<SettingKey, string>>,
  fresh: Partial<Record<SettingKey, string>>,
): Partial<Record<SettingKey, string>> {
  const merged = { ...prior };
  for (const [k, v] of Object.entries(fresh)) {
    if (!(k in merged) && v !== undefined) merged[k as SettingKey] = v;
  }
  return merged;
}

/** Write atomically, so a concurrent reader sees the old record or the new one, never half. */
export function writePrep(rec: PrepRecord, o: PrepOpts = {}): void {
  const p = pathFor(rec.serial, o);
  mkdirSync(prepDir(o), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  renameSync(tmp, p);
}

export function clearPrep(serial: string, o: PrepOpts = {}): void {
  try {
    unlinkSync(pathFor(serial, o));
  } catch {
    /* already gone is the outcome we wanted */
  }
}

export function newPrepRecord(
  serial: string,
  platform: Platform,
  original: Partial<Record<SettingKey, string>>,
  sleepWhenIdle: boolean,
  o: PrepOpts = {},
): PrepRecord {
  return {
    serial,
    platform,
    original,
    sleepWhenIdle,
    preparedAt: new Date(o.now ?? Date.now()).toISOString(),
    version: VERSION,
  };
}

// --- the explicitness gate --------------------------------------------------

/**
 * Refuse to prep a physical device that the caller did not name.
 *
 * Emulators and simulators are disposable; a physical phone might be the one in your pocket.
 * `lifecycle.ts:203` already draws this exact line (it refuses to power-cycle a physical
 * device), and this is the second caller — hence `DeviceKind` from types.ts rather than a
 * parallel two-value type that would have to be kept in step with it.
 *
 * Naming the serial IS the opt-in — there is deliberately no `vk device trust` verb and no
 * persisted allow-list. One less piece of state to go stale, and the thing you type names the
 * phone you mean, which a flag like `--yes` never does: an agent would simply always pass it,
 * and it would stop meaning anything (the same reason device claims have no `--force`).
 *
 * `writes` is how many knobs would actually be applied. When it is zero there is nothing to
 * protect against — that is what makes `vk device prep` on iOS, where every knob is a noop or
 * unsupported, report honestly instead of refusing for no reason.
 *
 * An UNKNOWN kind is treated as physical by the caller, deliberately: the fail-safe direction
 * here is more gating, never less.
 */
export function assertPreppable(kind: DeviceKind, serial: string, named: boolean, writes: number): void {
  if (writes === 0 || kind !== 'physical' || named) return;
  throw new CliError(
    `Refusing to prepare ${serial}: it is a physical device and was not named explicitly.\n` +
      'Prep changes settings that outlive the run (animations, display timeout, Do Not Disturb), ' +
      'so it must never land on a personal phone that happened to be plugged in.\n' +
      `If this is a test device, say so by naming it:\n  verikun device prep --device ${serial}`,
    2,
  );
}
