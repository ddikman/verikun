// The device claim store — "which attached device is another job already driving?".
//
// Parallel agents (separate worktrees of one repo) share one pool of phones, emulators
// and simulators. Nothing coordinated the assignment, so two jobs would land on the same
// device and BOTH die: one `install` of the same package with a different build silently
// replaces the app under the other's feet, and it presents as an ordinary assertion
// failure, indistinguishable from a real regression until someone goes digging.
//
// A claim is a small JSON file per device under `~/.verikun/devices/`, saying who is
// driving it and when they were last seen. HOST-global, not workspace-local: run state
// lives in `./.verikun/` because it describes a working directory, but a device is a fact
// about the machine, and the jobs that collide are in DIFFERENT directories by definition.
//
// Load-bearing properties, each of which has a failure mode behind it:
//
//   * ONE FILE PER SERIAL, never one shared map. The whole premise is concurrent writers;
//     independent files make every write atomic with no read-modify-write race.
//   * ACQUISITION IS `wx`. An exclusive create is the only way two agents starting at the
//     same instant don't both pick the first free device. Losing that race is not an
//     error — the caller just moves to the next candidate.
//   * READS ARE TOLERANT. An unreadable or corrupt claim reads as UNCLAIMED (same posture
//     as run.ts's loadState and the plan cache): a poisoned file must never be able to
//     brick a device permanently.
//   * LIVENESS IS PID-FIRST WHERE IT CAN BE. See `isLive` — a timeout alone is either too
//     short (steals a device mid-run) or too long (parks a crashed job's phone).
//   * `VERIKUN_NO_CLAIM=1` DISABLES READS AND WRITES, restoring the pre-claim behaviour
//     exactly — including the old exit-2-on-multiple-devices — and making this job
//     invisible to others. That equivalence is the thing to preserve when debugging.
//
// Platform-agnostic by design, like `device/settings.ts` and `ui/`: it never touches
// adb/xcrun. The drivers know which devices exist; this knows which are taken.

import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CliError } from '../errors';
import { err } from '../output';
import type { Platform } from '../types';
import { VERSION } from '../version';

/** What one device's claim file holds. */
export interface DeviceClaim {
  serial: string;
  platform: Platform;
  /** VERIKUN_SESSION / TERM_SESSION_ID, when the environment provides one. */
  session?: string;
  /** The owning job's working directory — the identity that always exists. */
  cwd: string;
  pid: number;
  /** os.hostname(): a pid is only meaningful liveness evidence on the host that wrote it. */
  host: string;
  /**
   * Whether ONE process owns this claim for the whole job (`ai`/`suite`/`batch`/`server`)
   * rather than a one-off command that exits immediately. See `isLive` — it decides whether
   * the pid is exact evidence or merely a hint.
   */
  processScoped: boolean;
  /** ISO — when this owner first took the device (survives heartbeats). */
  since: string;
  /** ISO — refreshed by every recorded step. */
  heartbeat: string;
  /** verikun that wrote it. Diagnostics only; never gates anything. */
  version: string;
}

/** A claim as reported by `vk devices`, with the display label resolved. */
export interface ClaimSummary extends DeviceClaim {
  /** Short label for the holder — the workspace directory name, else the session id. */
  by: string;
  /** Whether this claim belongs to the current job. */
  mine: boolean;
}

/** The minimum a driver has to tell us about a device it could pick. */
export interface ClaimCandidate {
  serial: string;
  model?: string;
}

/**
 * `ok: true` means "drive it" — an exclusive create succeeded, the claim on disk is already
 * ours, or the store was unusable and coordination degraded out of the way.
 *
 * `held` is null when the device is contended but nobody could be named: repeated rounds
 * lost to a claim that keeps being cleared. Refusing without a name is still better than
 * reporting success we cannot back with a published claim.
 */
export type ClaimResult = { ok: true; claim: DeviceClaim } | { ok: false; held: DeviceClaim | null };

export interface SelectOutcome {
  serial: string;
  /** Candidates skipped because another live job holds them. `held` is null where the
   *  device was contended but no holder could be read — see `ClaimResult`. */
  skipped: Array<{ candidate: ClaimCandidate; held: DeviceClaim | null }>;
  /** How many candidates were on the table — drives whether an auto-pick is worth announcing. */
  total: number;
}

/**
 * Injection seam. Defaults are the real process/host/clock; every parameter exists so the
 * unit suite can drive this without a real `$HOME` or a fake timer. Mirrors
 * `defaultPluginStatePath(env, home)` in update-check.ts — there is no injectable clock
 * anywhere in this repo, so each entry point takes `now` instead.
 */
export interface ClaimOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
  cwd?: string;
  host?: string;
}

/** Default TTL for a claim whose owner is not a single long-lived process, in minutes. */
const DEFAULT_TTL_MIN = 5;

/**
 * Ceiling on trusting a pid, however alive it looks. Pids are recycled, and a
 * process-scoped run heartbeats every step, so a genuinely running job is never anywhere
 * near this old — it only stops a recycled pid resurrecting an abandoned claim forever.
 */
const PID_TRUST_MAX_MS = 6 * 60 * 60 * 1000;

// --- process-wide latch -----------------------------------------------------

let processScoped = false;

/**
 * Serials this process has successfully claimed, so a teardown can hand them all back
 * without threading a driver handle through every `finally`. `cmdBatch` in particular
 * never holds a Driver — it dispatches through `executeParsed` — so asking the claim
 * store what it took is the only way it can release anything.
 */
const acquired = new Set<string>();

/** Give back every device this process claimed. Best-effort; teardown must never throw. */
export function releaseOwnClaims(o: ClaimOpts = {}): string[] {
  const released: string[] = [];
  for (const serial of [...acquired]) {
    if (releaseClaim(serial, { ...o, mineOnly: true })) released.push(serial);
  }
  return released;
}

/**
 * Declare that this process owns its device for its whole run — `ai`, `suite`, `batch`,
 * `server`. That turns the owning pid into EXACT liveness evidence (see `isLive`), so a
 * `kill -9` frees the device immediately instead of parking it until the TTL expires.
 *
 * A process-wide latch rather than a parameter because the claim is acquired lazily, deep
 * inside `Driver.resolvedSerial()`, long after the command that knows this was dispatched.
 * `setOutputQuiet` in output.ts is the same shape for the same reason.
 */
export function setProcessScoped(v: boolean): boolean {
  const prev = processScoped;
  processScoped = v;
  return prev;
}

// --- environment ------------------------------------------------------------

/** Claims are on unless `VERIKUN_NO_CLAIM` is set to anything non-empty (mirrors VERIKUN_NO_RUN). */
export function claimsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VERIKUN_NO_CLAIM;
}

/** How long a one-off command's claim survives without a heartbeat. `0` disables the TTL. */
export function claimTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VERIKUN_CLAIM_TTL_MIN;
  if (raw === undefined) return DEFAULT_TTL_MIN * 60000;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MIN) * 60000;
}

// --- paths ------------------------------------------------------------------

export function claimsDir(o: ClaimOpts = {}): string {
  return join(o.home ?? homedir(), '.verikun', 'devices');
}

/**
 * Filename for a serial: readable enough to eyeball the directory, with a hash suffix so
 * two serials that sanitize alike (`192.168.1.5:5555` vs `192.168.1.5_5555`) can never
 * collide onto one file and silently share a claim.
 */
function fileFor(serial: string): string {
  const safe = serial.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  return `${safe}-${createHash('sha1').update(serial).digest('hex').slice(0, 8)}.json`;
}

function pathFor(serial: string, o: ClaimOpts): string {
  return join(claimsDir(o), fileFor(serial));
}

// --- identity ---------------------------------------------------------------

/** Session identity, same source `run.ts` uses for rollover. Absent in a fresh shell. */
function currentSession(env: NodeJS.ProcessEnv): string | undefined {
  return env.VERIKUN_SESSION || env.TERM_SESSION_ID || undefined;
}

/**
 * Is this claim the current job's?
 *
 * EITHER the session matches OR the working directory does — deliberately forgiving,
 * because the only unsafe error here is falsely accusing your own job. An agent harness
 * may run every command in a fresh shell with no stable session id (which is why session
 * alone will not do), and two terminals deliberately sharing one checkout are one job
 * (which is why cwd alone will not do either).
 */
export function isMine(c: DeviceClaim, o: ClaimOpts = {}): boolean {
  const env = o.env ?? process.env;
  const session = currentSession(env);
  if (session && c.session && c.session === session) return true;
  return c.cwd === (o.cwd ?? process.cwd());
}

/** Whether a pid is running. EPERM means it exists but belongs to someone else — alive. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ageMs(c: DeviceClaim, now: number): number {
  const t = Date.parse(c.heartbeat);
  // An unparseable heartbeat reads as ancient, so a malformed claim is takeable rather
  // than immortal — the same direction every other tolerance in this file leans.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now - t;
}

/**
 * Is somebody still driving this device?
 *
 * Two signals, because a heartbeat can only fire BETWEEN commands and neither signal
 * alone covers both owners:
 *
 *   * A LIVE PID always means live. The heartbeat cannot tick during a single long
 *     command — a large `install`, a `wait --timeout 600000`, a `vk ai` model repair
 *     round-trip — so without this a run would lose its device midway through work it
 *     had no opportunity to report. The pid only ever EXTENDS liveness here.
 *   * PROCESS-SCOPED owners (`ai`/`suite`/`batch`/`server`) are one process for the whole
 *     job, so a dead pid also means DONE: the device comes back the instant a `kill -9`
 *     lands, rather than being parked until a timer expires. This is the only case where
 *     the pid shortens liveness, and it is sound precisely because the process outlives
 *     every command in the job.
 *
 * Everything else falls back to idle time. A one-off command's process is gone the moment
 * it printed, so the TTL covers the only gap left: an agent thinking between two commands.
 * One minute is too tight for that (read a screenshot, decide, tap again); five is enough
 * while still handing a crashed job's phone back quickly.
 */
export function isLive(c: DeviceClaim, o: ClaimOpts = {}): boolean {
  const age = ageMs(c, o.now ?? Date.now());
  const ours = c.host === (o.host ?? hostname()) && c.pid > 0;
  // The ceiling is what stops a RECYCLED pid resurrecting an abandoned claim forever; a
  // job that is genuinely working heartbeats nowhere near this often.
  const running = ours && age <= PID_TRUST_MAX_MS && pidAlive(c.pid);
  if (c.processScoped && ours) return running;
  const ttl = claimTtlMs(o.env ?? process.env);
  return running || (ttl > 0 && age <= ttl);
}

// --- store ------------------------------------------------------------------

/** Read one device's claim. Missing, unreadable or malformed all mean UNCLAIMED. */
export function readClaim(serial: string, o: ClaimOpts = {}): DeviceClaim | null {
  return readClaimAt(pathFor(serial, o));
}

function readClaimAt(p: string): DeviceClaim | null {
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as DeviceClaim;
    // Guard the two fields every decision reads. A file that parses as JSON but is not a
    // claim must not make `isMine`/`isLive` throw deep inside device resolution.
    if (typeof c?.serial !== 'string' || typeof c?.cwd !== 'string') return null;
    return c;
  } catch (e) {
    err(`[verikun] ignoring unreadable device claim ${p} (${(e as Error).message})`);
    return null;
  }
}

/** Every claim on this host. Powers `vk devices`, and is the list a parallel scheduler reads. */
export function listClaims(o: ClaimOpts = {}): DeviceClaim[] {
  const dir = claimsDir(o);
  if (!existsSync(dir)) return [];
  const out: DeviceClaim[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const c = readClaimAt(join(dir, name));
      if (c) out.push(c);
    }
  } catch {
    /* an unreadable directory is "nothing claimed", never a failure */
  }
  return out;
}

function record(serial: string, platform: Platform, o: ClaimOpts, since?: string): DeviceClaim {
  const env = o.env ?? process.env;
  const iso = new Date(o.now ?? Date.now()).toISOString();
  return {
    serial,
    platform,
    session: currentSession(env),
    cwd: o.cwd ?? process.cwd(),
    pid: process.pid,
    host: o.host ?? hostname(),
    processScoped,
    since: since ?? iso,
    heartbeat: iso,
    version: VERSION,
  };
}

let tmpSeq = 0;

/** A scratch path in the store directory. Never ends in `.json`, so `listClaims` and
 *  `findSeed`-style scans skip it even if one is ever left behind. */
function tmpPath(p: string): string {
  return `${p}.tmp-${process.pid}-${(tmpSeq += 1)}`;
}

/** Replace a claim we are already entitled to. `rename` is atomic on POSIX, so a
 *  concurrent reader sees the old content or the new one, never a half-written file. */
function writeAtomic(p: string, c: DeviceClaim): void {
  const tmp = tmpPath(p);
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, p);
}

/**
 * Create a claim ONLY if the device is unclaimed, and make it appear fully-formed.
 *
 * Write-then-link, not `writeFileSync(…, {flag:'wx'})`. Both are exclusive — `link()` fails
 * EEXIST just as `wx` does — but `wx` creates the file EMPTY and fills it a moment later,
 * while `link()` publishes an already-written file in one step. That difference decides who
 * owns the device, because a racer landing in the gap reads zero bytes, the tolerant reader
 * correctly calls that corrupt, and corrupt-is-takeable hands it the device too.
 *
 * The gap is microseconds on an idle box and does not reproduce there — it was observed
 * with `wx` under real load (two e2e suites plus an emulator), where six processes racing
 * for one device produced THREE winners. Load is exactly when parallel agents contend, so
 * closing it structurally beats relying on the scheduler.
 */
function writeExclusive(p: string, c: DeviceClaim): boolean {
  const tmp = tmpPath(p);
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  try {
    linkSync(tmp, p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the link succeeded or never happened; either way the scratch file is disposable */
    }
  }
}

/**
 * Take the device, or report who has it.
 *
 * The happy path is an exclusive publish (`writeExclusive`): if no claim existed, we now own
 * it, and no concurrent starter can have won the same device. Only when that fails do we
 * look at who is there — and taking over a dead claim goes unlink-then-publish for the same
 * reason, so exactly one of several racing takers wins instead of two overwriting each other
 * and both believing they own it.
 */
export function claimDevice(serial: string, platform: Platform, o: ClaimOpts = {}): ClaimResult {
  const r = claimDeviceInner(serial, platform, o);
  if (r.ok) acquired.add(serial);
  return r;
}

/**
 * How many times to re-race for a device whose claim keeps being cleared under us. Each
 * extra round costs one exclusive create against a device nobody live holds, so this is a
 * bound on pathological churn, not a retry budget anyone should hit.
 */
const CLAIM_ATTEMPTS = 4;

/**
 * Run `fn` holding the exclusive right to replace this device's claim, or return null if
 * another taker holds it.
 *
 * Why a token at all: POSIX offers no "remove this file only if it is still the one I
 * read". So "the claim is dead, unlink it and publish mine" is unsound on its own — between
 * the read and the unlink another taker can publish, and the unlink then deletes a LIVE
 * claim, handing the device to two jobs. Measured, not theoretical: 16 racers over one dead
 * claim produced two winners.
 *
 * `link()` gives a sound absent-to-present CAS, so it can elect a single taker. Holding that
 * token, the winner is the only writer of `p` and may replace it atomically — no unlink, no
 * window. The token is held across three syscalls and no I/O, so the only way to strand one
 * is to die inside it; liveness is therefore the owning PID alone, which is exact. That is
 * the difference that matters: a dead CLAIM is the routine steady state (every finished job
 * leaves one), whereas a dead TOKEN needs a crash inside a microsecond window.
 */
function withTakeover<T>(p: string, serial: string, platform: Platform, o: ClaimOpts, fn: () => T): T | null {
  const tok = `${p}.takeover`;
  const me = record(serial, platform, o);
  if (!writeExclusive(tok, me)) {
    const other = readClaimAt(tok);
    if (other && !tokenAbandoned(other, o)) return null; // a live taker is mid-takeover
    try {
      unlinkSync(tok);
    } catch {
      /* another racer cleared it first */
    }
    if (!writeExclusive(tok, me)) return null;
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(tok);
    } catch {
      /* best effort: a stray token is cleared by the next taker */
    }
  }
}

/** A takeover token outlives its process only if that process died holding it. Judged on the
 *  PID alone — no TTL — because it is never held across anything slow. */
function tokenAbandoned(t: DeviceClaim, o: ClaimOpts): boolean {
  if (t.host !== (o.host ?? hostname())) return false; // not ours to judge; leave it alone
  return !pidAlive(t.pid);
}

function claimDeviceInner(serial: string, platform: Platform, o: ClaimOpts): ClaimResult {
  const p = pathFor(serial, o);
  try {
    mkdirSync(claimsDir(o), { recursive: true });
  } catch (e) {
    return uncoordinated(serial, platform, p, e as Error, o);
  }

  // PUBLISH FIRST, then judge. The invariant this shape exists to hold is: `ok: true` is
  // returned only when an EXCLUSIVE create actually succeeded, or the claim on disk is
  // already ours. Deciding first and writing afterwards cannot hold it — between the
  // decision and the write another racer can publish, and both would report success.
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const fresh = record(serial, platform, o);
    try {
      if (writeExclusive(p, fresh)) return { ok: true, claim: fresh };
    } catch (e) {
      return uncoordinated(serial, platform, p, e as Error, o);
    }

    // Something is there. Note that `held === null` covers BOTH "corrupt" and "vanished a
    // microsecond ago", which is why neither may be treated as ours: the only proof of
    // ownership is a create that succeeded.
    const held = readClaimAt(p);
    if (held && isMine(held, o)) {
      // Keep `since` — how long this job has held the device is the interesting number.
      const refreshed = record(serial, platform, o, held.since);
      try {
        writeAtomic(p, refreshed);
      } catch {
        /* the file is ours either way; a failed refresh only ages the heartbeat */
      }
      return { ok: true, claim: refreshed };
    }
    if (held && isLive(held, o)) return { ok: false, held };

    // Dead, or unreadable (a claim nobody can parse would otherwise hold a device forever).
    // Replacing it must be serialized — see `withTakeover` for why unlink-then-create is
    // not enough. Losing the token is not an error; the next attempt re-reads and finds
    // whoever won.
    const taken = withTakeover(p, serial, platform, o, (): ClaimResult => {
      // Re-read INSIDE the token. Another taker may have legitimately claimed the device
      // between our judgement and our turn, and this is the only point at which that
      // answer cannot change under us.
      const now = readClaimAt(p);
      if (now && isMine(now, o)) return { ok: true, claim: now };
      if (now && isLive(now, o)) return { ok: false, held: now };
      // We are the sole writer of `p` while the token is held, so an atomic replace is
      // safe here — no unlink, and therefore no window in which it could delete a claim
      // newer than the one we judged dead.
      const mine = record(serial, platform, o);
      writeAtomic(p, mine);
      return { ok: true, claim: mine };
    });
    if (taken) return taken;
  }

  // Beaten every round. Refusing is the only safe answer left: reporting success here,
  // without a published claim, is precisely how two jobs end up on one device.
  const last = readClaimAt(p);
  if (last && isMine(last, o)) return { ok: true, claim: last };
  return { ok: false, held: last };
}

/**
 * The store is unusable — unwritable home, full disk, a permissions problem. Coordination
 * is a convenience, so this degrades to "drive the device anyway" rather than becoming a
 * new way for a run to fail. The caller proceeds UNCOORDINATED, which is the honest state:
 * no claim was published, and this job is invisible to others.
 */
function uncoordinated(serial: string, platform: Platform, p: string, e: Error, o: ClaimOpts): ClaimResult {
  err(`[verikun] could not write device claim ${p} (${e.message}) — continuing unclaimed`);
  return { ok: true, claim: record(serial, platform, o) };
}

/** Refresh my heartbeat. Never throws, never steals: a claim that became someone else's is left alone. */
export function touchClaim(serial: string, platform: Platform, o: ClaimOpts = {}): void {
  if (!claimsEnabled(o.env ?? process.env)) return;
  try {
    const held = readClaim(serial, o);
    if (held && !isMine(held, o)) return;
    if (!held) {
      claimDevice(serial, platform, o);
      return;
    }
    writeAtomic(pathFor(serial, o), record(serial, platform, o, held.since));
  } catch {
    /* bookkeeping must never fail a command */
  }
}

/**
 * Drop a claim. `mineOnly` is what the automatic paths (run archive, the `ai`/`batch`/
 * `suite` teardown) pass, so a job can only ever hand back its own device; `vk device
 * release` omits it and says so on stderr, because that is the deliberate break-glass.
 */
export function releaseClaim(serial: string, o: ClaimOpts & { mineOnly?: boolean } = {}): DeviceClaim | null {
  try {
    const held = readClaim(serial, o);
    if (!held) return null;
    if (!isMine(held, o) && o.mineOnly) return null;
    unlinkSync(pathFor(serial, o));
    acquired.delete(serial);
    return held;
  } catch {
    return null;
  }
}

// --- selection --------------------------------------------------------------

/** Column form for a table: `workspace 'islamabad' · 3m ago`, or `this job` for our own. */
export function describeClaim(c: DeviceClaim, o: ClaimOpts = {}): string {
  if (isMine(c, o)) return 'this job';
  return `${holderLabel(c)} · ${fmtAge(ageMs(c, o.now ?? Date.now()))} ago`;
}

/** What to say when a device is demonstrably contended but no holder could be read — a
 *  claim being cleared and retaken faster than it can be observed. Rare, and honest. */
const CONTENDED = 'another job (claim contended)';

/** Sentence form, for a refusal that reads as prose rather than as a cell. */
function describeHolder(c: DeviceClaim, o: ClaimOpts): string {
  return `${holderLabel(c)} (last seen ${fmtAge(ageMs(c, o.now ?? Date.now()))} ago)`;
}

function holderLabel(c: DeviceClaim): string {
  const dir = basename(c.cwd || '');
  if (dir && dir !== '/' && dir !== '.') return `workspace '${dir}'`;
  return c.session ? `session ${c.session}` : 'another job';
}

/** Local copy of run.ts's private age formatter — five lines, and importing run.ts here
 *  would drag the whole recorder into the drivers' dependency graph for a string. */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function label(c: ClaimCandidate): string {
  return c.model ? `${c.serial} (${c.model})` : c.serial;
}

/**
 * Pick a device nobody else is driving, and claim it in the same breath.
 *
 * Candidates are tried in the backend's own listing order, so an unclaimed phone keeps
 * being reused across runs rather than round-robined — a device that worked last time is
 * the one most likely to work now. A lost `wx` race is simply the next candidate's turn.
 *
 * Throws exit 2 when every candidate is held: the shape is "you must choose", the same as
 * its sibling `Multiple devices connected`, and `--device` is the fix. Not exit 3 — the
 * machine is fine, it is just busy.
 */
export function selectAndClaim(candidates: ClaimCandidate[], platform: Platform, o: ClaimOpts = {}): SelectOutcome {
  const skipped: Array<{ candidate: ClaimCandidate; held: DeviceClaim | null }> = [];
  for (const candidate of candidates) {
    const r = claimDevice(candidate.serial, platform, o);
    if (r.ok) return { serial: candidate.serial, skipped, total: candidates.length };
    skipped.push({ candidate, held: r.held });
  }
  const width = Math.max(...skipped.map((s) => label(s.candidate).length), 0);
  const rows = skipped
    .map((s) => `  ${label(s.candidate).padEnd(width)}  ${s.held ? describeClaim(s.held, o) : CONTENDED}`)
    .join('\n');
  throw new CliError(
    `Every attached device is in use:\n${rows}\n` +
      'Wait for one, free it with `verikun device release <serial>`, ' +
      'or set VERIKUN_NO_CLAIM=1 to ignore claims.',
    2,
  );
}

/**
 * Claim the device the caller named explicitly, or refuse.
 *
 * `alternatives` is a THUNK because the Android fast path never lists devices when
 * `--device` is given — it spawns nothing at all — and paying for an `adb devices` round
 * trip only to decorate an error we are not going to raise would tax every run to help
 * the rare one. On the failure path the extra call is free in comparison.
 */
export function assertClaimable(
  serial: string,
  platform: Platform,
  alternatives: () => ClaimCandidate[] = () => [],
  o: ClaimOpts = {},
): void {
  const r = claimDevice(serial, platform, o);
  if (r.ok) return;
  // Decorating an error must never be able to replace it. Listing alternatives means
  // asking the platform what is attached, which throws its own exit 3 when nothing is
  // (a plausible state here: the device you named is claimed AND now unplugged).
  let free: ClaimCandidate[] = [];
  try {
    free = alternatives().filter((c) => c.serial !== serial && !isHeldByOther(c.serial, o));
  } catch {
    /* no suggestions, then — the refusal below is the message that matters */
  }
  const lines = [
    `${serial} is in use by ${r.held ? describeHolder(r.held, o) : CONTENDED}.`,
    ...(free.length ? [`  free now:             ${free.map(label).join(', ')}`] : []),
    `  if that job is gone:  verikun device release ${serial}`,
    '  to ignore claims:     VERIKUN_NO_CLAIM=1',
  ];
  throw new CliError(lines.join('\n'), 2);
}

function isHeldByOther(serial: string, o: ClaimOpts): boolean {
  const c = readClaim(serial, o);
  return !!c && !isMine(c, o) && isLive(c, o);
}

/** Resolve a device list into `vk devices` rows: who holds what, and is it me. */
export function summarize(serial: string, o: ClaimOpts = {}): ClaimSummary | undefined {
  const c = readClaim(serial, o);
  if (!c || !isLive(c, o)) return undefined;
  const mine = isMine(c, o);
  return { ...c, mine, by: mine ? 'this job' : describeClaim(c, o) };
}
