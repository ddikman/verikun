import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactDir, err } from '../output';
import { VERSION } from '../version';
import { Plan, parsePlan } from './ir';
import { GRAMMAR, REPAIR_GRAMMAR } from './grammar';

// The plan cache turns "compile once, replay free" into "$0 steady state": a cache
// HIT skips the model entirely. The key includes the app build (so a stale plan is
// never replayed blindly against a changed app) and the entry records a COMPILER
// FINGERPRINT (verikun version + grammar) that read() checks — so a plan compiled by
// an older verikun is recompiled, not replayed. A MISS first tries to SEED from the
// most recent prior plan for the same (NL + package) and adapt it, so a new build
// pays at most the repair delta — never a full recompile. (Whether seeding actually
// pays off is the design doc's validation gate; the machinery is here regardless.)
//
// Reads are TOLERANT (a corrupt file is treated as a miss, never a crash — same
// posture as run.ts's loadState). Writes are ATOMIC (temp + rename). The freshly
// compiled plan is persisted immediately (so an unchanged test is never recompiled,
// even via --show-plan or after a failed run); a fully-green run then re-persists the
// healed plan. A HALF-healed plan (steps repaired mid-run, then the run failed) is
// never persisted — a failed run leaves the clean compile cached instead.

export interface CacheKeyInput {
  /** The natural-language test source, verbatim. */
  nl: string;
  /** App package / bundle id under test (when known). */
  pkg?: string;
  /** App build/version identifier (when known) — part of the key. */
  build?: string;
  platform: string;
}

export interface CacheEntry {
  /** Hash of the NL text only — stable across builds, used to find seed candidates. */
  nlHash: string;
  pkg?: string;
  build?: string;
  platform: string;
  /** verikun version that compiled this plan (human-readable; the gate is the fingerprint). */
  verikunVersion: string;
  /** Identity of the compiler (version + grammar). A mismatch on read invalidates the entry. */
  compilerFingerprint: string;
  savedAt: string;
  plan: Plan;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Fingerprint of the COMPILER that produced a plan: the verikun version PLUS the exact
 * grammar/repair prompts handed to the model. A cached plan is replayed ONLY when this
 * matches the running build — so updating verikun (a version bump, OR any change to the
 * grammar/repair instructions) invalidates stale plans and forces a recompile against
 * the current compiler, instead of silently replaying a plan the old one produced. The
 * version alone wouldn't catch unreleased grammar edits (same `0.3.0`); folding the
 * grammar text in does.
 */
export const COMPILER_FINGERPRINT = sha256([VERSION, GRAMMAR, REPAIR_GRAMMAR].join(String.fromCharCode(0))).slice(0, 16);

function plansDir(): string {
  return join(artifactDir(), 'plans');
}

/** Hash of the NL text alone — the seed-matching identity, build-independent. */
export function nlHash(nl: string): string {
  return sha256(nl);
}

/** The full cache key (filename stem): NL + package + build + platform. A new build
 *  changes this, so its plan is a distinct entry (no blind stale replay). */
export function planKey(input: CacheKeyInput): string {
  // NUL-joined: a separator that can't occur in any component, so distinct inputs never
  // collide. We build the NUL with fromCharCode(0), not a backslash-zero literal, which
  // some tools write as a real NUL byte (which makes the whole file read as "binary").
  return sha256([input.nl, input.pkg ?? '', input.build ?? '', input.platform].join(String.fromCharCode(0))).slice(0, 32);
}

function entryPath(key: string): string {
  return join(plansDir(), `${key}.json`);
}

/** Read the cached plan for this exact key. Returns null on miss OR a corrupt /
 *  unparseable file (treated as a miss so a poisoned file forces one recompile,
 *  not a permanent failure). */
export function readPlan(input: CacheKeyInput): CacheEntry | null {
  const p = entryPath(planKey(input));
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, 'utf8')) as CacheEntry;
    // A plan compiled by a DIFFERENT verikun/grammar must not be replayed — treat it as
    // a miss so it recompiles against the current compiler. (findSeed deliberately does
    // NOT apply this gate: an older plan is still a fine starting point to adapt from.)
    if (entry.compilerFingerprint !== COMPILER_FINGERPRINT) return null;
    // Re-validate the plan shape — a hand-edited or partially-written file that
    // parses as JSON but isn't a valid Plan is still a miss.
    entry.plan = parsePlan(entry.plan);
    return entry;
  } catch (e) {
    // A cache file that exists but won't parse/validate is corrupt — surface it (then
    // recompile) rather than swallow it silently.
    err(`[ai] ignoring unreadable plan cache ${p} (${(e as Error).message}) — recompiling`);
    return null;
  }
}

/** Write a plan to the cache atomically (temp + rename). Called right after a compile
 *  (caching the clean plan, so an unchanged test never recompiles) and again after a
 *  fully-green run (caching the healed plan). A half-healed plan from a failed run is
 *  never persisted — the clean compile stays cached. */
export function writePlan(input: CacheKeyInput, plan: Plan): CacheEntry {
  const dir = plansDir();
  mkdirSync(dir, { recursive: true });
  const entry: CacheEntry = {
    nlHash: nlHash(input.nl),
    pkg: input.pkg,
    build: input.build,
    platform: input.platform,
    verikunVersion: VERSION,
    compilerFingerprint: COMPILER_FINGERPRINT,
    savedAt: new Date().toISOString(),
    plan,
  };
  const target = entryPath(planKey(input));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, target);
  return entry;
}

/**
 * Find a plan to seed a new build from: the most recently saved cached plan with
 * the same NL text and package but a DIFFERENT (or unknown) build. Returns null if
 * there is no prior plan to adapt. Tolerant — unreadable entries are skipped.
 */
export function findSeed(input: CacheKeyInput): CacheEntry | null {
  const dir = plansDir();
  if (!existsSync(dir)) return null;
  const wantNl = nlHash(input.nl);
  const exactKey = planKey(input);
  let best: CacheEntry | null = null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('.') || `${file}` === `${exactKey}.json`) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), 'utf8')) as CacheEntry;
      if (entry.nlHash !== wantNl) continue;
      if ((entry.pkg ?? '') !== (input.pkg ?? '')) continue;
      entry.plan = parsePlan(entry.plan); // skip if it doesn't validate
      if (!best || entry.savedAt > best.savedAt) best = entry;
    } catch (e) {
      // A seed candidate that won't parse/validate is corrupt — warn and skip it, rather
      // than let one bad file silently vanish from seeding.
      err(`[ai] skipping unreadable cache entry ${file} (${(e as Error).message})`);
    }
  }
  return best;
}
