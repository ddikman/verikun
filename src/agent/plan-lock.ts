// Serialise the COMPILE of one plan-cache key across processes that share one plan cache.
//
// The failure it closes (issue #117): `vk suite` across a device pool runs N lanes, each a
// CHILD `vk ai` process, and a child inherits the cwd — so all N share ONE ./.verikun/plans.
// On a COLD cache all N reach `readPlan()` for the SAME `@include`d preamble in the same
// instant, all miss, and all call the model. That is N x the tokens for prose the segment
// cache exists to pay for once, and — worse — N DIFFERENT nondeterministic compiles of one
// text alive in a single suite run: each lane runs its own draw, and `renameSync`'s
// last-writer-wins decides which draw later tests replay. Measured on one 14-test suite:
// 80 / 84 / 144 top-level steps for three tests sharing one preamble.
//
// A lock is one file per key under ./.verikun/plan-locks/. Load-bearing properties:
//
//   * BESIDE THE CACHE, NOT IN IT. `.verikun/plans` is the path our own CI docs and
//     `.github/workflows/suite.yml` tell users to restore with `actions/cache`. A lock
//     packed into that tarball comes back on a fresh runner as a foreign-host corpse — on
//     exactly the cold-cache run this exists to make cheap. A sibling directory also keeps
//     `rm -rf .verikun/plan-locks` from being one keystroke away from deleting the cache.
//     Cwd-relative, matching what it protects: the plan cache is per working directory, so
//     two worktrees must never block each other.
//   * TAKEN ONLY ON A MISS. The steady state is all cache hits and does zero lock I/O.
//   * IT CAN NEVER BE A NEW WAY TO FAIL. Every failure — an unwritable directory, a holder
//     that outlives the ceiling, a corrupt lock — returns `held: false` and the caller
//     compiles anyway. That is the pre-lock behaviour, which `VERIKUN_NO_PLAN_LOCK=1`
//     restores exactly (the bisectability contract `VERIKUN_NO_CLAIM` is held to).
//   * LIVENESS IS THE PID, WITH A CEILING. There is no heartbeat and there cannot be one: a
//     CLI provider compiles through a 180s blocking `spawnSync` (cli-provider.ts), so a
//     `setInterval` in the holder could not fire, and a pure TTL would declare a healthy
//     holder dead exactly while it is busiest. Same reasoning, same words, as claims.ts's
//     `isLive`: A LIVE PID ALWAYS MEANS LIVE.
//
// This is NOT claims.ts under another name, and the asymmetry is the whole design argument.
// A device claim fences host-global hardware, where two winners means two jobs driving one
// phone — unrecoverable, and misdiagnosed as a regression. Here two winners means one
// duplicate compile: bounded, self-healing (writePlan is atomic), and precisely the state
// that exists today. That is why the takeover token claims.ts needs is deliberately absent
// below, and why the primitives are shared but the mechanisms are not.

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { artifactDir } from '../output';
import { VERSION } from '../version';
import { pidAlive, writeExclusive } from '../device/claims';
import { pollUntil } from '../wait';
import { CacheKeyInput, planKey } from './cache';

/** How often a waiter re-probes a held lock. The probe is an `existsSync` plus a ~200-byte
 *  read — microseconds, which is what `pollUntil`'s contract asks for — and the same order
 *  as the selector auto-wait's 300ms. It bounds the dead time after a holder releases. */
const POLL_MS = 250;

/**
 * The longest a waiter will EVER block, before the run-timeout derivation narrows it.
 *
 * Sized against `CliProvider`'s 180s hard per-call ceiling, so the common worst case — a
 * codex/cursor compile timing out — is fully covered and the waiter learns the outcome
 * instead of duplicating work it is about to repeat anyway.
 */
const MAX_WAIT_MS = 240_000;

/**
 * How long a LOCK is trusted at all, however alive its pid looks.
 *
 * A different question from how long we WAIT, and deliberately a much larger number: a
 * Claude compile is 120s x 5 attempts plus backoff plus a honoured `Retry-After`, so a
 * legitimate holder can run past ten minutes. Below this only a dead pid on our own host
 * makes a lock stale; above it, nothing is trusted — which is what stops a RECYCLED pid, or
 * a lock written by a machine that is not this one, wedging one cache key forever.
 * claims.ts's PID_TRUST_MAX_MS is six hours because a claim is held for a whole job; this
 * covers one model call.
 */
const LOCK_TRUST_MAX_MS = 15 * 60_000;

/** What one lock file holds. Exported so a test can plant a corpse by hand. */
export interface PlanLockFile {
  /** The plan key this lock fences — for a human reading the directory. */
  key: string;
  pid: number;
  host: string;
  cwd: string;
  startedAt: string;
  version: string;
}

export interface PlanLockOpts {
  /** Injection seams, mirroring `ClaimOpts`: every one exists so the unit suite can drive
   *  this without a fake timer or a real second process. */
  env?: NodeJS.ProcessEnv;
  host?: string;
  pollMs?: number;
  ceilingMs?: number;
}

export interface PlanLock {
  /** True when THIS process published the lock file. False means uncoordinated — compile
   *  anyway, exactly as before this mechanism existed. */
  held: boolean;
  /** How long acquisition waited. `> 0` means somebody else was compiling this key. */
  waitedMs: number;
  /** Set ONLY for an unexpected degrade (an unwritable directory, the ceiling). Absent when
   *  the lock is simply switched off, so the disabled path prints nothing and stays
   *  byte-identical to the pre-lock behaviour. */
  degraded?: string;
  /** Idempotent, never throws, and unlinks only a file this process wrote. */
  release(): void;
}

/** Locks live BESIDE the plan cache, never inside it — see the header. */
export function planLocksDir(): string {
  return join(artifactDir(), 'plan-locks');
}

/** `VERIKUN_NO_PLAN_LOCK=1` restores the pre-lock behaviour exactly. */
export function planLocksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VERIKUN_NO_PLAN_LOCK ?? '').trim().toLowerCase();
  return v === '' || v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * The wait ceiling for a run whose own wall-clock budget is `runTimeoutMs`.
 *
 * DERIVED, not a bare constant, because `runAiTest` computes its deadline BEFORE
 * `obtainPlan` (cli.ts, `const deadline = Date.now() + opts.timeoutMs` immediately above the
 * `obtainPlan` call). Every second spent waiting here is a second the engine no longer has,
 * so a generous fixed wait would turn a healthy suite into `run timeout (900s) reached` — a
 * NEW way to fail, which is the one thing this mechanism may not introduce. A quarter is the
 * same shape, for the same reason, as `claimHeartbeatMs` deriving from `claimTtlMs`: the run
 * budget is the only window this wait is ever measured against, so the two cannot drift.
 * No floor — a tiny `--timeout` simply means we do not wait, which is a degrade, not a spin.
 */
export function planLockWaitMs(runTimeoutMs: number): number {
  return Math.min(MAX_WAIT_MS, Math.floor(runTimeoutMs / 4));
}

const unlocked = (degraded?: string): PlanLock => ({
  held: false,
  waitedMs: 0,
  ...(degraded ? { degraded } : {}),
  release: () => {},
});

/**
 * Wait until nobody else is compiling this key, then hold the right to compile it.
 *
 * Never throws and never blocks unboundedly. A `held: false` result is the caller's cue to
 * compile unserialised — i.e. to behave exactly as it did before this existed.
 */
export async function takePlanLock(input: CacheKeyInput, o: PlanLockOpts = {}): Promise<PlanLock> {
  // Off: no `degraded`, so nothing is printed and the path is byte-identical to pre-lock.
  if (!planLocksEnabled(o.env ?? process.env)) return unlocked();

  const dir = planLocksDir();
  // Same 32-hex stem as `plans/<key>.json`, so the two correlate by eye.
  const key = planKey(input);
  const path = join(dir, `${key}.lock`);
  // An unusable directory degrades, it never throws — claims.ts's "log and continue" posture.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return unlocked(`plan lock unavailable (${(e as Error).message})`);
  }

  const started = Date.now();
  const ceiling = o.ceilingMs ?? MAX_WAIT_MS;
  // Probes, not elapsed time, decide whether we WAITED. `pollUntil` probes before its first
  // sleep, so winning on probe 1 means the key was free — and reporting the few milliseconds
  // that `link()` itself costs would put a spurious "(waited 0.0s)" on an uncontended
  // compile. `waitedMs > 0` therefore means exactly "somebody else was compiling this".
  let probes = 0;
  const got = await pollUntil(
    () => {
      probes += 1;
      return tryTake(path, key, o);
    },
    { timeoutMs: ceiling, intervalMs: o.pollMs ?? POLL_MS },
  );
  if (got) {
    return { held: true, waitedMs: probes > 1 ? Date.now() - started : 0, release: () => drop(path, o) };
  }

  // The ceiling. Give up and let the caller COMPILE ANYWAY: the cost is one duplicate
  // compile, which is the state we are improving on, never a failure. It also self-limits a
  // pile-up — waiter #2's ceiling has been running while waiter #1 worked, so N waiters
  // behind a failing compile do not serialise into N sequential failures.
  return {
    held: false,
    waitedMs: Date.now() - started,
    degraded: `another run has held the plan lock for ${Math.round(ceiling / 1000)}s`,
    release: () => {},
  };
}

/** One attempt. `undefined` is pollUntil's "not yet"; `true` means we own it. */
function tryTake(path: string, key: string, o: PlanLockOpts): true | undefined {
  // Write-then-link, NOT `writeFileSync(…, {flag:'wx'})` — see claims.ts's `writeExclusive`,
  // whose comment records six racers producing three winners under load. Lower stakes here
  // (a wasted compile, not two jobs on one phone), identical mechanism, so there is no
  // reason to re-open a question that was already answered with measurements.
  if (writeExclusive(path, record(key, o))) return true;

  const held = readLockAt(path);
  // A corrupt or vanished lock is TAKEABLE, not immortal — every tolerance in this repo
  // leans that way, because a poisoned file must not be able to wedge a key permanently.
  if (held && !stale(held, o)) return undefined; // somebody is genuinely compiling; wait

  // Clear the corpse, then re-race. The read sits immediately before the unlink, so the
  // window in which we could delete a lock that went live underneath us is one syscall wide.
  //
  // Deliberately NOT claims.ts's `.takeover` token. There, losing this race hands one phone
  // to two jobs, which is worth a second file to prevent. Here it costs one duplicate
  // compile — bounded, self-healing, and exactly today's behaviour. Buying a POSIX CAS for
  // that would be machinery bought for nothing. If this ever does need to be exact,
  // `withTakeover` in claims.ts is the shape to copy.
  try {
    unlinkSync(path);
  } catch {
    /* another waiter cleared it first — either way it is gone */
  }
  return writeExclusive(path, record(key, o)) || undefined; // EEXIST => someone won; keep waiting
}

function record(key: string, o: PlanLockOpts): PlanLockFile {
  return {
    key,
    pid: process.pid,
    host: o.host ?? hostname(),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
}

/** Tolerant read: absent, unparseable or the wrong shape all read as "no lock". */
function readLockAt(path: string): PlanLockFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlanLockFile;
    return parsed && typeof parsed === 'object' && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is this lock's holder gone?
 *
 * Two signals, and neither alone covers both cases:
 *   * A DEAD PID ON OUR HOST is exact and free — the crash case, caught within one poll.
 *   * AGE past LOCK_TRUST_MAX_MS is the only thing that can judge a lock we cannot probe: a
 *     recycled pid, or one written by another machine sharing this checkout. Unlike
 *     claims.ts's `tokenAbandoned`, a foreign host is NOT left alone forever here — a corpse
 *     we may not judge by pid would otherwise tax that key for the rest of time, and the
 *     worst case of judging it wrong is a duplicate compile.
 */
function stale(l: PlanLockFile, o: PlanLockOpts): boolean {
  const age = Date.now() - Date.parse(l.startedAt);
  // NaN (an unparseable timestamp) fails this comparison, so it reads as ancient — the same
  // direction claims.ts's `ageMs` leans, and the safe one.
  if (!(age <= LOCK_TRUST_MAX_MS)) return true;
  return l.host === (o.host ?? hostname()) && !pidAlive(l.pid);
}

/** Give the lock back. Re-reads first and unlinks ONLY a file this process wrote — a lock
 *  somebody legitimately took over after judging us stale is not ours to delete. Same guard,
 *  same reason, as `releaseClaim`'s `mineOnly`. Never throws: it runs from a `finally`,
 *  usually while something else has already gone wrong. */
function drop(path: string, o: PlanLockOpts): void {
  const held = readLockAt(path);
  if (!held || held.pid !== process.pid || held.host !== (o.host ?? hostname())) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone; a stray lock is cleared by the next taker anyway */
  }
}
