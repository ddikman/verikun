// `--devices` — the device-pool spec, shared by `vk server` and `vk suite`.
//
// It lives in its own module because BOTH commands take the flag and they must agree on
// what it means. They did not, once: `vk server --devices all` pooled every usable
// device while `vk suite --devices all` read the word as a literal serial, wrote a claim
// file for a device that does not exist, and failed every test against `adb -s all`. A
// comment asserted the two must agree; nothing enforced it. This file does.
//
// `parseDevicePool` is PURE (a flag string in, a spec out). `poolSerials` makes exactly
// one device enumeration — the same `listDevices()` call `vk devices` makes — and is the
// only impure thing here.

import { CliError } from '../errors';
import { getDriver } from '../drivers';
import { err } from '../output';
import { isUsableState } from './failover';
import { Flags, flagBool, flagStr } from '../args';
import type { Platform } from '../types';

export interface DevicePoolSpec {
  /** Every usable device of the platform, rather than a named list. */
  all: boolean;
  /** The named serials, when `all` is false. */
  serials: string[];
  /** Platform pinned by the `all-android` / `all-ios` spelling. */
  platform?: Platform;
}

/**
 * Parse `--devices all | all-android | all-ios | <serial>,<serial>`.
 *
 * `all-android` / `all-ios` both SELECT and pin the platform, so the intent is one
 * self-documenting flag rather than `--android --devices all` read as a pair — and,
 * more usefully, so a bare `--devices all` on a Mac with both emulators and simulators
 * attached cannot silently resolve to whichever platform happened to be the default.
 */
export function parseDevicePool(flags: Flags): DevicePoolSpec | undefined {
  const raw = flags['devices'];
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new CliError("--devices needs a value: 'all', 'all-android', 'all-ios', or a comma-separated list of serials.", 2);
  const entries = csvList(raw);
  if (!entries.length) {
    throw new CliError("--devices needs a value: 'all', 'all-android', 'all-ios', or a comma-separated list of serials.", 2);
  }
  const alls = entries.filter((e) => /^all(-android|-ios)?$/i.test(e));
  if (alls.length && entries.length > 1) {
    throw new CliError(`--devices '${alls[0]}' selects every device, so it cannot be combined with named serials.`, 2);
  }
  if (alls.length) {
    const suffix = /^all(?:-(android|ios))?$/i.exec(alls[0])![1];
    return { all: true, serials: [], ...(suffix ? { platform: suffix.toLowerCase() as Platform } : {}) };
  }
  return { all: false, serials: entries };
}

/** Was a platform named on the command line, as opposed to defaulted? */
export function platformWasNamed(flags: Flags): boolean {
  return flagBool(flags, 'ios') || flagBool(flags, 'android') || !!flagStr(flags, 'platform');
}

/**
 * The spec, and the platform the pool will actually be resolved against.
 *
 * `all-android` / `all-ios` both SELECT and pin, so they can contradict an explicit
 * `--ios` / `--android` — and a contradiction is an operator error, never a silent
 * winner. Lives here, with the parser, because `vk server` and `vk suite` both take the
 * flag and a rule enforced in one command and not the other is exactly the divergence
 * this module exists to close. Pure.
 */
export function resolvePoolPlatform(flags: Flags, fallback: Platform): { spec?: DevicePoolSpec; platform: Platform } {
  const spec = parseDevicePool(flags);
  if (spec?.platform && platformWasNamed(flags) && fallback !== spec.platform) {
    throw new CliError(`--devices all-${spec.platform} contradicts the platform flag (${fallback}). Pass one or the other.`, 2);
  }
  return { ...(spec ? { spec } : {}), platform: spec?.platform ?? fallback };
}

/** Split a comma-separated flag value into trimmed, de-duplicated entries. ONE copy,
 *  because `--devices`, `--servers`, `--allow-device-control` and `--allow-failover` all
 *  take this shape and had drifted on whether duplicates collapse. */
export function csvList(raw: string | boolean | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Resolve a spec against what is actually attached.
 *
 * A NAMED serial that is not attached is fatal rather than skipped: the operator asked
 * for that phone, and quietly serving the rest would hand back less capacity than was
 * requested with nothing saying so.
 */
export function poolSerials(platform: Platform, spec: DevicePoolSpec): string[] {
  const attached = getDriver(platform, undefined).listDevices();
  // `isUsableState`, not a hand-rolled `state === 'device'`: iOS never uses that string —
  // simctl states arrive lowercased as `booted`/`shutdown` — so the naive check made
  // `--devices all-ios` report "no usable ios device is attached" with simulators running,
  // while `failoverCandidates` in this same module would happily move ONTO one.
  const usable = attached.filter((d) => isUsableState(d.state));
  if (spec.all) {
    // Virtual devices win when both kinds are attached, exactly as `IdbDriver`'s own
    // auto-selection already does. A pool is meant to be interchangeable devices, and a
    // simulator and a plugged-in iPhone are not: log capture is unsupported on the phone
    // (see guides/platform-support.md), so a suite dealt across both would produce
    // archives that carry logs and archives that silently do not. `all` also has no
    // business reaching for somebody's personal handset when a simulator is running.
    const virtual = usable.filter((d) => d.kind === 'emulator' || d.kind === 'simulator');
    const chosen = virtual.length ? virtual : usable;
    if (!chosen.length) throw new CliError(`--devices: no usable ${platform} device is attached.`, 3);
    if (virtual.length && virtual.length < usable.length) {
      err(`[verikun] --devices: pooling the ${virtual.length} virtual device(s); name a serial to pool a physical one.`);
    }
    return chosen.map((d) => d.serial);
  }
  const missing = spec.serials.filter((x) => !usable.some((d) => d.serial === x));
  if (missing.length) {
    throw new CliError(
      `--devices: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not attached. ` +
        `Usable ${platform} devices: ${usable.length ? usable.map((d) => d.serial).join(', ') : '(none)'}`,
      3,
    );
  }
  return spec.serials;
}

