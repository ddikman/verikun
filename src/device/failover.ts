// Should `vk server` move off the device it is bound to, and which device next?
//
// PURE — no fs, no spawn, no timers, no Driver. It classifies strings some driver has
// already produced and filters a list somebody else enumerated, so the whole matrix is
// unit-testable with no device. Platform-agnostic by design, like `device/settings.ts`
// and `device/claims.ts`; the probing and the rebinding live in `server.ts`.
//
// THE POLARITY IS THE DESIGN, so read this before touching the tables.
//
// `install X onto Y` has exactly two operands, so a failure is about the FILE or about
// the DEVICE — there is no third thing. The file-attributable set is small, closed and
// decade-stable (a parser's verdict on a byte sequence is identical on every device).
// The device-attributable set is open-ended, OEM-specific and unknowable in advance —
// the failure that prompted this (issue #99) carried no `INSTALL_FAILED_*` code at all,
// just a raw `java.io.IOException: Requested internal only, but not enough space`.
//
// So the ENUMERABLE side is the one we enumerate, and the default falls the other way:
// an install failure moves unless it matches the artifact denylist. The named
// device-state strings below are a FAST PATH and documentation, never the gate —
// deleting one changes the reason text, never the decision. That is what makes this
// survive phrasings nobody has met yet, and it is the property `tests/failover.test.ts`
// pins by feeding the classifier pure gibberish and asserting it still moves.
//
// `exec`/`elements` keep the OPPOSITE default, and that asymmetry is deliberate rather
// than sloppy: it is the same "which operand is at fault?" question with a different
// answer. There the operand is the app under test, and the exit-3 population is
// dominated by transient device noise (a flaky uiautomator dump, NoWindowError, a
// keyguard read). Moving on those would rotate the pool on ordinary flake, so that arm
// moves only on an unreachable device or one a probe confirms is dead.

import { CliError, NoWindowError } from '../errors';
import type { DeviceInfo } from '../types';

export type FailoverKind =
  /** The device is gone or not answering — transport, not package manager. */
  | 'unreachable'
  /** Present, but cannot serve this operation (full disk, wrong ABI, conflicting install). */
  | 'device-state'
  /** The INPUT is broken; every device fails identically. Retrying elsewhere burns minutes. */
  | 'artifact'
  /** Clears by itself within a second or two (NoWindowError, a mid-launch gap). */
  | 'transient'
  /** adb/idb missing or broken — no other device on this host helps. */
  | 'toolchain'
  /** exit 1: the app failed, not the device. */
  | 'app'
  /** exit 2: the caller is wrong (usage, ambiguity, a device another job holds). */
  | 'usage'
  /** exit 3 with nothing recognisable. Polarity differs by arm — see the header. */
  | 'unknown';

export interface FailoverVerdict {
  /** Move to another device? */
  move: boolean;
  kind: FailoverKind;
  /** One line for stderr and the wire, e.g. "device full (INSTALL_FAILED_INSUFFICIENT_STORAGE)". */
  reason: string;
  /**
   * The message alone is not decisive — ask the device (`driver.preflight()`) before
   * deciding. Keeps the timing-dependent probe out of this pure module.
   *
   * NEVER set on `transient` or `toolchain`: a device mid-`launch --clear` can fail a
   * probe and must not move, and with adb missing every probe fails, so probing would
   * wrongly upgrade "no toolchain" into "move to a device we equally cannot drive".
   */
  probe?: boolean;
  /** No fast-path string matched. Logged distinctly so real-world strings surface in CI
   *  logs and get promoted into a table deliberately, instead of the tables rotting. */
  unclassified?: boolean;
}

/** A message fragment and the reason text it earns. Order matters only for readability;
 *  the first match wins, and no two entries here are ambiguous with each other. */
type Rule = readonly [pattern: RegExp, reason: string];

// --- the artifact denylist: the ONLY thing that blocks an install failover -----
//
// Every entry is a property of the FILE. A parser verdict on a byte sequence is the
// same on every device, so a second attempt elsewhere is a guaranteed second failure.
const ARTIFACT_RULES: readonly Rule[] = [
  // One prefix covers all ten INSTALL_PARSE_FAILED_* variants (NOT_APK, BAD_MANIFEST,
  // NO_CERTIFICATES, INCONSISTENT_CERTIFICATES, MANIFEST_MALFORMED, …).
  [/INSTALL_PARSE_FAILED_(\w+)/, 'the APK does not parse'],
  [/INSTALL_FAILED_INVALID_APK/, 'the APK is not a valid package'],
  [/INSTALL_FAILED_INVALID_URI/, 'the install path is not valid'],
  [/INSTALL_FAILED_PACKAGE_CHANGED/, 'the APK changed between staging and commit (corrupt upload)'],
  [/INSTALL_FAILED_TEST_ONLY/, 'the APK is marked test-only (needs `adb install -t`)'],
  // Dexopt CAN OOM, but the dominant cause is a bad build, and a wrong move costs a
  // full install per device and still ends red. Flip it if the field disagrees.
  [/INSTALL_FAILED_DEXOPT/, 'the APK failed dexopt (usually a bad build)'],
  // The server's OWN temp file, not the device's storage — a host bug. Moving would
  // burn the whole pool on a problem no device can fix.
  [/adb: failed to stat|can't find '[^']*\.(?:apk|ipa)'/i, 'the server could not read the uploaded file'],
];

/** Clears by itself; the device is not exhausted. */
const TRANSIENT_RULES: readonly Rule[] = [[/INSTALL_FAILED_ABORTED/, 'the install session was aborted']];

// --- fast paths: name the reason and skip the probe. NEVER the gate. ----------

const UNREACHABLE_RULES: readonly Rule[] = [
  [/device (?:'[^']*' )?not found/i, 'the device is not attached'],
  [/no devices\/emulators found/i, 'no device is attached'],
  [/device offline/i, 'the device is offline'],
  [/device (?:still authorizing|unauthorized)/i, 'the device is not authorized'],
  [/error: closed|protocol fault|failed to get feature set/i, 'the adb connection dropped'],
  [/is not ready \(/, 'the device is not ready'],
];

const DEVICE_STATE_RULES: readonly Rule[] = [
  // Both spellings of a full disk. The second is the one from #99, and it arrives with
  // NO INSTALL_FAILED_* code — which is precisely why the denylist, not this list, is
  // what decides. Keep both: they only shape the message.
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, 'the device is out of space'],
  [/Requested internal only, but not enough space|not enough space/i, 'the device is out of space'],
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/, 'a differently-signed build of this package is installed on the device'],
  [/INSTALL_FAILED_VERSION_DOWNGRADE/, 'the device holds a newer build of this package'],
  [/INSTALL_FAILED_ALREADY_EXISTS/, 'the package is already installed on the device'],
  [/INSTALL_FAILED_DUPLICATE_PERMISSION/, 'another app on the device declares one of these permissions'],
  [/INSTALL_FAILED_CONFLICTING_PROVIDER/, 'another app on the device owns one of these provider authorities'],
  [/INSTALL_FAILED_UID_CHANGED|INSTALL_FAILED_SHARED_USER_INCOMPATIBLE/, "the existing install's identity on the device conflicts"],
  [/INSTALL_FAILED_USER_RESTRICTED/, 'this device or profile disallows installs'],
  [/INSTALL_FAILED_MEDIA_UNAVAILABLE/, "the device's storage is not mounted"],
  [/INSTALL_FAILED_VERIFICATION_(?:FAILURE|TIMEOUT)/, "the device's package verifier rejected the build"],
  // Device-RELATIVE, so another device genuinely takes it.
  [/INSTALL_FAILED_MISSING_SHARED_LIBRARY/, 'the device lacks a shared library this build needs'],
  [/INSTALL_FAILED_NO_MATCHING_ABIS/, "the build has no native code for this device's ABI"],
  [/INSTALL_FAILED_OLDER_SDK/, "the build needs a newer Android than this device runs"],
  [/INSTALL_FAILED_INTERNAL_ERROR/, "the device's package manager failed internally"],
];

/** adb/idb itself is missing or broken. Matched on the wording `exec.ts` and the tool
 *  probes produce — a hint string is the reliable marker, since the detail varies. */
const TOOLCHAIN_RULES: readonly Rule[] = [
  [/was not found on PATH/i, 'the device toolchain is not installed'],
  [/install the Android platform-tools/i, 'adb is missing or broken'],
  [/brew install idb-companion|xcode-select --install/i, 'the iOS toolchain is missing or broken'],
];

/** First matching rule, or undefined. */
function firstMatch(message: string, rules: readonly Rule[]): string | undefined {
  for (const [pattern, reason] of rules) {
    const m = pattern.exec(message);
    if (m) return m[0].startsWith('INSTALL_') ? `${reason} (${m[0]})` : reason;
  }
  return undefined;
}

/** The exit code a thrown value carries, or 3 for a non-CliError (matching `run()`). */
function exitCodeOf(e: unknown): number {
  return e instanceof CliError ? e.exitCode : 3;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''));

/**
 * The arms share everything except what an unrecognised exit-3 means, so they share
 * this and differ only in `fallback`.
 */
function classify(e: unknown, fallback: FailoverVerdict): FailoverVerdict {
  // Identity first, never message text: NoWindowError is exit 3 and its wording could
  // plausibly be matched by another rule, and getting this one wrong means rotating the
  // pool every time an app is mid-launch.
  if (e instanceof NoWindowError) {
    return { move: false, kind: 'transient', reason: 'the app has not drawn yet — this clears on its own' };
  }
  const code = exitCodeOf(e);
  if (code === 0 || code === 1) return { move: false, kind: 'app', reason: 'the app failed, not the device' };
  if (code === 2) return { move: false, kind: 'usage', reason: 'the request was refused, not the device' };

  const message = messageOf(e);
  const toolchain = firstMatch(message, TOOLCHAIN_RULES);
  if (toolchain) return { move: false, kind: 'toolchain', reason: toolchain };

  const transient = firstMatch(message, TRANSIENT_RULES);
  if (transient) return { move: false, kind: 'transient', reason: transient };

  const unreachable = firstMatch(message, UNREACHABLE_RULES);
  if (unreachable) return { move: true, kind: 'unreachable', reason: unreachable };

  return { ...fallback };
}

/** Nothing matched, and the message has no opinion. Ask the device instead of guessing. */
const UNKNOWN_STAY: FailoverVerdict = {
  move: false,
  kind: 'unknown',
  reason: 'the device may still be fine — asking it',
  probe: true,
  unclassified: true,
};

/**
 * The generic arm: `exec`, `elements`, and anything that is not an install.
 *
 * STAY unless the device is provably unreachable, or a probe says so. Accepts `unknown`
 * so a `catch (e)` binding passes straight in, mirroring `isEnvError`.
 */
export function classifyFailure(e: unknown): FailoverVerdict {
  return classify(e, UNKNOWN_STAY);
}

/**
 * The install arm: MOVE unless the failure is provably about the FILE.
 *
 * `handleInstall` knows it just ran an install and calls this explicitly — sniffing the
 * message to pick an arm would couple the classifier to a message format that is free
 * to change.
 */
export function classifyInstallFailure(e: unknown): FailoverVerdict {
  const code = exitCodeOf(e);
  // Only an environment failure is ever the device's fault; a usage error (a rejected
  // extension, an unreadable path) is the caller's and no device fixes it.
  if (code === 3 && !(e instanceof NoWindowError)) {
    const message = messageOf(e);
    // Same order as `classify` below, so the two arms can only ever differ in their
    // DEFAULT — which is the one difference between them that is meant to exist.
    const artifact = firstMatch(message, ARTIFACT_RULES);
    if (artifact) return { move: false, kind: 'artifact', reason: artifact };

    const toolchain = firstMatch(message, TOOLCHAIN_RULES);
    if (toolchain) return { move: false, kind: 'toolchain', reason: toolchain };

    const transient = firstMatch(message, TRANSIENT_RULES);
    if (transient) return { move: false, kind: 'transient', reason: transient };

    const unreachable = firstMatch(message, UNREACHABLE_RULES);
    if (unreachable) return { move: true, kind: 'unreachable', reason: unreachable };

    const named = firstMatch(message, DEVICE_STATE_RULES);
    if (named) return { move: true, kind: 'device-state', reason: named };

    // The inversion. Not in the denylist ⇒ it is about the device, even though we have
    // never seen this wording. Bounded by MAX_FAILOVER_HOPS, and the caller reports the
    // FIRST device's error on exhaustion, so a wrong guess costs time, not diagnosis.
    return { move: true, kind: 'device-state', reason: 'the device could not install this build', unclassified: true };
  }
  return classify(e, UNKNOWN_STAY);
}

/**
 * Which attached devices could take over, in preference order.
 *
 * Listing order is preserved for the same reason `selectAndClaim` documents it: a device
 * that worked last time is the one most likeliest to work now, and round-robining would
 * spread a flaky run across the whole pool.
 *
 * Claim status is deliberately NOT a filter — deciding "this one is free" and then
 * claiming it is the exact read-then-write race `device/claims.ts` exists to prevent.
 * The caller claims as it walks.
 */
export function failoverCandidates(
  devices: readonly DeviceInfo[],
  opts: { exclude: readonly string[]; allow?: readonly string[] },
): DeviceInfo[] {
  const excluded = new Set(opts.exclude.filter(Boolean));
  const allow = opts.allow ?? [];
  return devices.filter((d) => {
    // An unbooted AVD is { serial: '', state: 'shutdown' } and has no adb address.
    // Failover is lateral, never upward: booting is `vk devices start`'s job.
    if (!d.serial) return false;
    if (!isUsableState(d.state)) return false;
    if (excluded.has(d.serial)) return false;
    // Name OR serial: an operator writes `Pixel_6_API_34` for an AVD and a raw serial
    // for a phone, and being forced to know which is which is a papercut with teeth.
    if (allow.length && !allow.includes(d.serial) && !(d.name && allow.includes(d.name))) return false;
    return true;
  });
}

/**
 * Is this device drivable right now? The two platforms spell it differently.
 *
 * Deliberately DUPLICATED from `isRunning` in drivers/lifecycle.ts rather than imported:
 * that module imports adb.ts and ios.ts, so importing it here would drag both platform
 * backends into a module whose whole value is being pure. One line of duplication is the
 * cheaper side of that trade.
 */
function isUsableState(state: string): boolean {
  return state === 'device' || state === 'booted';
}
