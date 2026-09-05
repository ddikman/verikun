// Auto-wait on selector lookups. A selector-resolving command does not fail the instant
// a lookup misses: it re-captures the hierarchy and retries until the (lenient) match
// succeeds or a wait window elapses (default 5s). A straightforward flow can then skip
// explicit `wait` calls — fewer round-trips, fewer tokens — while `--no-wait` / `--wait 0`
// restores fail-fast. Ambiguity (a present-but-plural match) is never waited on: the
// elements are already there, so it surfaces at once.
//
// Matching stays a pure function of one snapshot (ui/selector.ts is time-free); only the
// waiting lives here. The rules a new selector-resolving command must follow are in
// CLAUDE.md, "Selector auto-wait".

import { Flags, flagBool, flagNum } from '../args';
import { CliError, NoWindowError, SelectorNotFoundError } from '../errors';
import type { Element } from '../types';
import { MatchResult, MatchTier, Selector, matchElements, resolveOne } from '../ui/selector';
import { sleep } from '../wait';
import type { Ctx } from './context';

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 300;

/** Parse a duration: a bare number is milliseconds (CLI convention), or `5s` / `800ms`. */
export function parseDuration(raw: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(raw.trim());
  if (!m) throw new CliError(`--${flag} must be a duration like 5000, 5s, 800ms, or 15m; got '${raw}'`, 2);
  const n = Number(m[1]);
  const scale = m[2] === 's' ? 1000 : m[2] === 'm' ? 60000 : 1;
  return Math.max(0, Math.round(n * scale));
}

/** Wait window (ms) for selector lookups: `--no-wait`/`--wait 0` → 0; else `--wait <dur>`, else 5s. */
export function waitWindowMs(flags: Flags): number {
  if (flagBool(flags, 'no-wait')) return 0;
  const v = flags['wait'];
  if (v === undefined || v === true) return DEFAULT_WAIT_MS; // absent, or bare `--wait` → default
  return parseDuration(String(v), 'wait');
}

/** A short note appended to a confirmation when the action had to wait for its target. */
export function waitNote(ms: number): string {
  return ms >= 100 ? ` (waited ${(ms / 1000).toFixed(1)}s)` : '';
}

/** Poll interval (ms) for auto-wait, capped so a sleep never overshoots the deadline. */
export function pollStep(flags: Flags, deadline: number): number {
  const interval = flagNum(flags, 'interval') ?? DEFAULT_POLL_MS;
  return Math.min(interval, Math.max(0, deadline - Date.now()));
}

/**
 * Read the hierarchy for a caller that is polling, treating "no window yet" as "nothing on
 * screen yet" rather than a fatal environment error.
 *
 * A `NoWindowError` means the device genuinely had nothing to show — `launch --clear` and
 * `launch` both leave a gap where the app has been stopped and has not drawn. That clears in
 * a second or two, so a caller that has a wait budget should keep polling; escalating to
 * exit 3 throws away the budget it was explicitly given. MEASURED: a `wait --timeout 120000`
 * used to abort at ~20s with 100 seconds unspent.
 *
 * Every OTHER capture failure still propagates untouched — a missing adb, an unauthorised
 * device or a wedged dumper is a machine to fix, and polling it for two minutes helps nobody.
 */
export function readForPoll(ctx: Ctx, opts: { all?: boolean } = {}): Element[] {
  try {
    return ctx.driver.getElements(opts);
  } catch (e) {
    if (e instanceof NoWindowError) return [];
    throw e;
  }
}

/**
 * matchElements with auto-wait: re-capture + re-match until at least one element
 * matches or the window elapses. Returns the final result either way (empty on miss).
 */
export async function matchWaiting(ctx: Ctx, sel: Selector, opts: { all?: boolean } = {}): Promise<MatchResult> {
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  for (;;) {
    const res = matchElements(readForPoll(ctx, opts), sel);
    if (res.matches.length > 0 || Date.now() >= deadline) return res;
    await sleep(pollStep(ctx.flags, deadline));
  }
}

/**
 * resolveOne with auto-wait: poll until exactly one element resolves. A hit (1) or
 * an ambiguous (>1) match returns/throws at once via resolveOne — only an empty
 * result is retried. On a final miss, throws not-found (exit 1), noting the wait.
 */
export async function resolveOneWaiting(
  ctx: Ctx,
  sel: Selector,
  opts: { all?: boolean } = {},
): Promise<{ element: Element; tier: MatchTier; waitedMs: number; elements: Element[] }> {
  const windowMs = waitWindowMs(ctx.flags);
  const start = Date.now();
  const deadline = start + windowMs;
  for (;;) {
    const els = readForPoll(ctx, opts);
    if (matchElements(els, sel).matches.length >= 1) {
      const { element, tier } = resolveOne(els, sel); // 1 → resolved; >1 → throws ambiguity
      // The snapshot rides along: scroll-into-view needs the scrollable containers
      // from the SAME dump the element came from, and re-capturing to find them
      // would both cost a round-trip and risk describing a screen that moved on.
      return { element, tier, waitedMs: Date.now() - start, elements: els };
    }
    if (Date.now() >= deadline) {
      const waited = windowMs > 0 ? ` after ${(windowMs / 1000).toFixed(1)}s` : '';
      throw new SelectorNotFoundError(
        `No element matched selector '${sel.raw}'${waited}. Run \`verikun ui\` to inspect the current screen.`,
      );
    }
    await sleep(pollStep(ctx.flags, deadline));
  }
}
