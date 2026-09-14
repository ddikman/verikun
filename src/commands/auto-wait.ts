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
import { CliError, DumpKilledError, SelectorNotFoundError, TransientReadError } from '../errors';
import type { Element } from '../types';
import { barrierClause, modalBarrierOnly } from '../ui/barrier';
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
 * Read the hierarchy for a caller that is polling, treating a read that will clear on its own
 * as "nothing on screen yet" rather than as a fatal environment error.
 *
 * A `TransientReadError` means the device could not answer *right now* — `launch --clear` and
 * `launch` both leave a gap where the app has been stopped and has not drawn (`NoWindowError`),
 * and a memory-pressured phone SIGKILLs the dumper outright (`DumpKilledError`, issue #137).
 * Both clear in seconds, so a caller that has a wait budget should keep polling; escalating to
 * exit 3 throws away the budget it was explicitly given. MEASURED: a `wait --timeout 120000`
 * used to abort at ~20s with 100 seconds unspent, and a `wait --timeout 30000` at 2.5s.
 *
 * Every OTHER capture failure still propagates untouched — a missing adb, an unauthorised
 * device or a wedged dumper is a machine to fix, and polling it for two minutes helps nobody.
 *
 * Pass the tally so the window can tell "the screen said nothing was there" from "nobody ever
 * read the screen"; see `ReadTally.rethrowIfBlind`.
 */
export function readForPoll(ctx: Ctx, tally?: ReadTally, opts: { all?: boolean } = {}): Element[] {
  try {
    const els = ctx.driver.getElements(opts);
    return tally ? tally.note(els) : els;
  } catch (e) {
    if (e instanceof TransientReadError) {
      tally?.noteBlind(e);
      return [];
    }
    throw e;
  }
}

/**
 * What every read in ONE poll window saw. This is the only layer that sees all of them, so
 * both of the things a miss message needs to be honest about live here.
 *
 * **Was the tree barrier-only?** (issue #131) A sheet's barrier that outlives the whole wait
 * made the step report "never appeared", sending the reader looking for a missing identifier
 * in app code. Naming the barrier is the cheap half of that fix.
 *
 * **Did anyone ever read the screen at all?** (issue #137) An absorbed `DumpKilledError` costs
 * a read and yields no elements, and a window made entirely of those has no grounds to call
 * anything absent — see `rethrowIfBlind`.
 */
export class ReadTally {
  private reads = 0;
  private okReads = 0;
  private barrierReads = 0;
  private last: Element | null = null;
  private blind: TransientReadError | undefined;
  private lastBlind = false;

  constructor(private readonly ctx: Ctx) {}

  /** Record one snapshot. Returns it, so it can wrap a read in place. */
  note(els: Element[]): Element[] {
    this.reads++;
    this.okReads++;
    this.lastBlind = false;
    this.last = modalBarrierOnly(els, this.ctx.driver.viewport());
    if (this.last) this.barrierReads++;
    return els;
  }

  /** The clause to append to a miss, or '' when the last read was not barrier-only. */
  clause(): string {
    if (!this.last) return '';
    return barrierClause(this.last, this.barrierReads === this.reads);
  }

  /** Record a read that never happened — a transient failure `readForPoll` absorbed as `[]`. */
  noteBlind(e: TransientReadError): void {
    this.reads++;
    this.blind = e;
    this.lastBlind = true;
    this.last = null; // a read that did not happen is not a barrier, and must not read as one
  }

  /**
   * Did the most recent read fail to happen? Then it proves NOTHING, and least of all an
   * absence — which `--gone` counts as a pass.
   *
   * Separate from `rethrowIfBlind`, and it has to be: that one asks about the whole window and
   * fires at the deadline, but a `--gone` predicate is satisfied by the FIRST empty read and
   * returns from inside the poll loop, so a window-level check never runs. MEASURED on a
   * Pixel 3a while fixing #137: `wait --gone` under a kill storm exited 0 reporting "gone".
   *
   * Both `NoWindowError` and `DumpKilledError` count here. Unlike the deadline rule, the two
   * need no asymmetry: an absorbed read yielded no elements to judge either way, so polling
   * once more is right for both and costs a merely-absent selector nothing.
   */
  lastWasBlind(): boolean {
    return this.lastBlind;
  }

  /**
   * Refuse to report an absence this window never actually observed (issue #137).
   *
   * ONLY for a killed dump. The asymmetry is the point: a null root is the device ANSWERING
   * "nothing is drawn", so "the selector is absent" is a true reading of it and
   * `NoWindowError` keeps its existing behaviour exactly. A kill is no answer at all — and
   * `assert --gone` turns "absent" into a PASS, so absorbing it silently would manufacture a
   * green from a screen nobody could read.
   *
   * Gated on `okReads === 0`, the same `everRead` rule the engine's guard grace uses: one good
   * read anywhere in the window means the screen was legible and an ordinary miss is honest.
   */
  rethrowIfBlind(): void {
    if (this.okReads === 0 && this.blind instanceof DumpKilledError) throw this.blind;
  }
}

/**
 * matchElements with auto-wait: re-capture + re-match until at least one element
 * matches or the window elapses. Returns the final result either way (empty on miss),
 * plus the barrier tally so the caller's miss message can name a barrier.
 */
export async function matchWaiting(
  ctx: Ctx,
  sel: Selector,
  opts: { all?: boolean } = {},
): Promise<MatchResult & { barrier: ReadTally }> {
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  const barrier = new ReadTally(ctx);
  for (;;) {
    const res = matchElements(readForPoll(ctx, barrier, opts), sel);
    if (res.matches.length > 0) return { ...res, barrier };
    if (Date.now() >= deadline) {
      // Before ANY caller can read this as an absence — `assert --gone` calls it a pass.
      barrier.rethrowIfBlind();
      return { ...res, barrier };
    }
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
  const barrier = new ReadTally(ctx);
  for (;;) {
    const els = readForPoll(ctx, barrier, opts);
    if (matchElements(els, sel).matches.length >= 1) {
      const { element, tier } = resolveOne(els, sel); // 1 → resolved; >1 → throws ambiguity
      // The snapshot rides along: scroll-into-view needs the scrollable containers
      // from the SAME dump the element came from, and re-capturing to find them
      // would both cost a round-trip and risk describing a screen that moved on.
      return { element, tier, waitedMs: Date.now() - start, elements: els };
    }
    if (Date.now() >= deadline) {
      barrier.rethrowIfBlind();
      const waited = windowMs > 0 ? ` after ${(windowMs / 1000).toFixed(1)}s` : '';
      throw new SelectorNotFoundError(
        `No element matched selector '${sel.raw}'${waited}.${barrier.clause()} Run \`verikun ui\` to inspect the current screen.`,
      );
    }
    await sleep(pollStep(ctx.flags, deadline));
  }
}
