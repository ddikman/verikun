// CliError carries the process exit code so the dispatcher can map failures to
// stable, agent-readable exit statuses:
//   0  success / found / assertion passed
//   1  not found / assertion failed / wait timeout
//   2  usage error or ambiguous selector (caller must refine)
//   3  environment error (adb/simctl missing, no/multiple devices, dump failed)

import type { Element } from './types';

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
