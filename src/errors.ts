// CliError carries the process exit code so the dispatcher can map failures to
// stable, agent-readable exit statuses:
//   0  success / found / assertion passed
//   1  not found / assertion failed / wait timeout
//   2  usage error, ambiguous selector, or a device another job is driving (caller must refine)
//   3  environment error (adb/simctl missing, no usable device, dump failed)

import type { Element, ToolProbe } from './types';

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (m: string) => new CliError(m, 2);
export const envError = (m: string) => new CliError(m, 3);

/**
 * An environment failure (exit 3): a tool missing from PATH, no/ambiguous device, a
 * hierarchy dump or capture that failed. The one predicate every layer shares to tell
 * "the box is broken" from "the app is broken" — the agent runner aborts on it instead
 * of recording a regression, and `vk suite` stops rather than reporting N phantom
 * failures. Accepts `unknown` so `catch (e)` blocks can pass their binding directly.
 */
export function isEnvError(e: unknown): boolean {
  return e instanceof CliError && e.exitCode === 3;
}

/** Turn a failed tool probe into the environment error both drivers' preflight throws,
 *  so the install hint reads the same whether it came from `vk doctor` or a preflight. */
export const probeFailure = (p: ToolProbe): CliError => envError(`${p.detail}${p.hint ? `\n  ${p.hint}` : ''}`);

// --- Selector-resolution errors (heal triggers for the agent runner) --------
//
// A selector miss (zero matches) and an ambiguous match (>1) are still ordinary
// CliErrors with the same exit codes as before (1 and 2) — printing, exit codes,
// and `instanceof CliError` are unchanged for every existing caller. They are
// subclassed only so the `vk ai` engine can tell a *resolvable-by-repair* failure
// (these) apart from an assertion failure (`assert` returns exit 1, never throws),
// which it must never "heal" or it would mask a real regression.

/** Selector matched zero elements. Exit 1. The agent runner treats it as a heal trigger. */
export class SelectorNotFoundError extends CliError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'SelectorNotFoundError';
  }
}

/**
 * A hierarchy read that failed for a reason which CLEARS ON ITS OWN within seconds.
 *
 * The base exists so the three layers that mean "ride this out" — `readForPoll`, the engine's
 * guard grace, and the failover classifier — say so once, by class, instead of listing
 * subclasses they would each have to be remembered to update. Everything narrower than "this
 * is transient" keeps checking the concrete class (the companion only stands down for a
 * NoWindowError, not for a kill it had nothing to do with).
 *
 * Still exit 3, so a caller with NO budget is unaffected: an unabsorbed one exits exactly as
 * it did before. What the class buys is the right to be polled through, not a softer exit.
 */
export abstract class TransientReadError extends CliError {}

/**
 * There is no window to read right now — the app was just force-stopped, or is mid-launch
 * and has not drawn yet. `getRootInActiveWindow()` returns null and the platform says so.
 *
 * This is an OBSERVATION about the screen, not a broken machine, and the difference matters:
 * it clears on its own within a second or two. Every caller that has a wait budget absorbs it
 * and polls again; only a caller with no budget lets it surface (exit 3, unchanged).
 *
 * MEASURED, and this class exists because of it: `launch --clear` leaves a gap with no
 * window, and the old code escalated that to a fatal environment error after three capture
 * attempts. With the slow stock dump those three attempts spanned 7-14s and usually outlasted
 * the gap by accident; once the companion made a read ~0.2s they were spent in under a second,
 * and a `wait --timeout 120000` would abort at ~20s with 100 seconds of its budget unspent.
 * The retry belongs to the caller that knows how long it is willing to wait.
 */
export class NoWindowError extends TransientReadError {
  constructor(message: string = NO_WINDOW_MESSAGE) {
    super(message, 3);
    this.name = 'NoWindowError';
  }
}

/**
 * The one wording for "there is no window", shared by both Android read paths so they cannot
 * drift — the companion and the stock dumper are reporting the same device state.
 *
 * It names THREE causes, not two. `getRootInActiveWindow()` also returns null while the app's
 * main thread is busy mid-transition, and issue #80 was reported against a build that listed
 * only force-stop and mid-launch: the reporter went looking at app startup for a screen that
 * was drawn, present, and merely busy (device logs showed 32-121 dropped frames in the same
 * window). It also no longer ends in "use a command that waits" — every caller that hit this
 * in the wild was already doing exactly that.
 */
export const NO_WINDOW_MESSAGE =
  'No window to read: the app has no drawn window right now — force-stopped, mid-launch, or ' +
  'its main thread is busy mid-transition. This normally clears within a few seconds.';

/**
 * The dump process was SIGKILLed before it could answer (issue #137).
 *
 * NOT the same signal as NoWindowError, and the difference is the whole reason this is its own
 * class. A null root is the device ANSWERING "nothing is drawn", so "the selector is absent" is
 * a true reading of it. A kill is no answer at all, so calling the selector absent would be a
 * fabrication — which is why a poll window that never once read the screen re-throws this
 * instead of reporting a miss (`ReadTally.rethrowIfBlind`).
 *
 * MEASURED on a 4 GB-class phone (#137): the OS reaps the dumper while an app cold-starts, and
 * the driver's three attempts fired back-to-back all landed inside the same second — so a
 * `wait` holding a two-minute budget aborted at ~2.5s with 117 seconds unspent. Same rule as
 * NoWindowError: the driver hands it up, the caller spends its own clock on it.
 */
export class DumpKilledError extends TransientReadError {
  constructor(message: string = DUMP_KILLED_MESSAGE) {
    super(message, 3);
    this.name = 'DumpKilledError';
  }
}

/** The wording plus whatever the device actually said, for the one thrower that has evidence.
 *  Separate from the constructor so the wire codec can rebuild a message losslessly rather
 *  than re-prefixing one that already carries its detail. */
export const dumpKilledMessage = (detail: string): string =>
  detail ? `${DUMP_KILLED_MESSAGE} (${detail})` : DUMP_KILLED_MESSAGE;

/**
 * Names the CAUSE, because "the dump was killed" and "the device left adb" both used to arrive
 * as `Failed to capture UI hierarchy after 3 attempts` and want opposite responses from whoever
 * reads the report — wait vs go and find the phone.
 *
 * Both causes are named because both are real and the fix for each is different: memory pressure
 * (wait, or test on a device with more headroom) and a competing UiAutomation client (stop it).
 * verikun's own companion is the second one, and the driver already tries to clear that itself
 * before this is ever thrown.
 */
export const DUMP_KILLED_MESSAGE =
  'The UI hierarchy dump was killed before it could answer — the device reclaiming memory ' +
  'while an app starts, or another tool holding the one UiAutomation connection. This ' +
  'normally clears within seconds.';

/** Selector matched >1 element. Exit 2. Carries the candidates so the agent runner
 *  can ask the model to disambiguate (a heal trigger) instead of aborting. */
export class AmbiguousSelectorError extends CliError {
  constructor(
    message: string,
    public readonly candidates: Element[],
  ) {
    super(message, 2);
    this.name = 'AmbiguousSelectorError';
  }
}
