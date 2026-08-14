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
export const notFound = (m: string) => new CliError(m, 1);
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
export class NoWindowError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = 'NoWindowError';
  }
}

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
