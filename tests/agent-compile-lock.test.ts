import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { takePlanLock, planLocksDir, planLocksEnabled, planLockWaitMs, PlanLockFile } from '../src/agent/plan-lock';
import { planKey, CacheKeyInput } from '../src/agent/cache';

// The plan-compile lock: which process is already paying the model for this cache key.
//
// Locks live under ./.verikun/plan-locks (cwd-relative), so each test runs inside a
// throwaway temp dir — the same pattern as agent-cache.test.ts, and node:test runs a file's
// tests sequentially, so chdir is safe.
//
// `host` is injected everywhere a test cares about it, because the staleness rule treats our
// own host (judge by pid) differently from a foreign one (judge by age only).

const KEY: CacheKeyInput = { nl: 'launch and sign in', pkg: 'com.x', platform: 'android' };
const OTHER: CacheKeyInput = { ...KEY, nl: 'a different chunk' };
const HOST = 'test-host';

/** A pid that cannot be running. Same value, same reason, as device-claims.test.ts. */
const DEAD_PID = 4194304;

const lockPath = (k: CacheKeyInput = KEY): string => join(planLocksDir(), `${planKey(k)}.lock`);

/** Plant a lock file by hand — a corpse, a foreign holder, or a live one. */
function plant(over: Partial<PlanLockFile> = {}, k: CacheKeyInput = KEY): void {
  mkdirSync(planLocksDir(), { recursive: true });
  const rec: PlanLockFile = {
    key: planKey(k),
    pid: process.pid,
    host: HOST,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    version: '0.0.0-test',
    ...over,
  };
  writeFileSync(lockPath(k), JSON.stringify(rec, null, 2));
}

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-planlock-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

// --- the uncontended path ---------------------------------------------------

test('takePlanLock: an uncontended take holds it, waits for nothing, and releases cleanly', async () => {
  const lock = await takePlanLock(KEY, { host: HOST });
  assert.equal(lock.held, true);
  assert.equal(lock.waitedMs, 0);
  assert.equal(lock.degraded, undefined);
  assert.ok(existsSync(lockPath()), 'the lock file is published');

  const written = JSON.parse(readFileSync(lockPath(), 'utf8')) as PlanLockFile;
  assert.equal(written.pid, process.pid);
  assert.equal(written.key, planKey(KEY));

  lock.release();
  assert.equal(existsSync(lockPath()), false);
  // Idempotent and silent: release runs from a finally, usually while something else has
  // already gone wrong, so a second call must never throw.
  lock.release();
});

test('takePlanLock: a different key never waits — the lock is per key, not global', async () => {
  const held = await takePlanLock(KEY, { host: HOST });
  // A global lock would serialise a suite's genuinely distinct compiles and quietly undo
  // the pool, so this is not a detail.
  const other = await takePlanLock(OTHER, { host: HOST, ceilingMs: 50, pollMs: 5 });
  assert.equal(other.held, true);
  assert.equal(other.waitedMs, 0);
  held.release();
  other.release();
});

// --- waiting ----------------------------------------------------------------

test('takePlanLock: a second take for the same key waits for the first to release', async () => {
  const first = await takePlanLock(KEY, { host: HOST });
  setTimeout(() => first.release(), 60);

  const second = await takePlanLock(KEY, { host: HOST, pollMs: 5 });
  assert.equal(second.held, true);
  assert.ok(second.waitedMs > 0, `expected a wait, got ${second.waitedMs}ms`);
  second.release();
});

test('takePlanLock: giving up at the ceiling degrades to compile-anyway and leaves the holder alone', async () => {
  const first = await takePlanLock(KEY, { host: HOST });

  const second = await takePlanLock(KEY, { host: HOST, ceilingMs: 40, pollMs: 5 });
  assert.equal(second.held, false, 'the caller is told to compile unserialised');
  assert.ok(second.degraded?.includes('plan lock'), `expected a degrade reason, got ${second.degraded}`);
  // A waiter that gives up must NEVER delete a live lock — that would hand the key to
  // everybody at once, which is the bug this mechanism exists to stop.
  assert.ok(existsSync(lockPath()), 'the live holder still owns the file');
  // And its no-op release must not remove somebody else's lock either.
  second.release();
  assert.ok(existsSync(lockPath()));
  first.release();
});

// --- staleness --------------------------------------------------------------

test('takePlanLock: a dead pid on our own host is taken over within one poll', async () => {
  plant({ pid: DEAD_PID });
  const lock = await takePlanLock(KEY, { host: HOST, ceilingMs: 500, pollMs: 5 });
  assert.equal(lock.held, true);
  const written = JSON.parse(readFileSync(lockPath(), 'utf8')) as PlanLockFile;
  assert.equal(written.pid, process.pid, 'the corpse was replaced, not merely ignored');
  lock.release();
});

test('takePlanLock: a live pid older than the trust ceiling is taken over', async () => {
  // Our own pid, so `pidAlive` says live — only age can free this key. Without the ceiling a
  // recycled pid would wedge one cache key for the rest of the machine's life.
  plant({ startedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  const lock = await takePlanLock(KEY, { host: HOST, ceilingMs: 500, pollMs: 5 });
  assert.equal(lock.held, true);
  lock.release();
});

test('takePlanLock: a foreign host is judged by age alone, never by pid', async () => {
  // Young and foreign: we cannot probe that pid, so we must wait rather than assume.
  plant({ pid: DEAD_PID, host: 'somebody-elses-box' });
  const waited = await takePlanLock(KEY, { host: HOST, ceilingMs: 40, pollMs: 5 });
  assert.equal(waited.held, false, 'a dead-looking foreign pid is not evidence of anything');

  // Old and foreign: taken over. Unlike claims.ts's `tokenAbandoned`, a foreign corpse is
  // NOT left alone forever here — it would tax this key permanently, and the worst case of
  // being wrong is one duplicate compile.
  plant({ pid: DEAD_PID, host: 'somebody-elses-box', startedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  const taken = await takePlanLock(KEY, { host: HOST, ceilingMs: 500, pollMs: 5 });
  assert.equal(taken.held, true);
  taken.release();
});

test('takePlanLock: a corrupt lock file is takeable, not immortal', async () => {
  mkdirSync(planLocksDir(), { recursive: true });
  writeFileSync(lockPath(), '{ not json');
  const lock = await takePlanLock(KEY, { host: HOST, ceilingMs: 500, pollMs: 5 });
  assert.equal(lock.held, true);
  lock.release();
});

// --- it can never be a new way to fail --------------------------------------

test('takePlanLock: an unusable lock directory degrades, it does not throw', async () => {
  // A FILE where the directory should be, so mkdirSync fails. Portable — unlike chmod,
  // which is a no-op when CI runs as root.
  mkdirSync(join(dir, '.verikun'), { recursive: true });
  writeFileSync(planLocksDir(), 'not a directory');
  const lock = await takePlanLock(KEY, { host: HOST });
  assert.equal(lock.held, false);
  assert.ok(lock.degraded?.includes('unavailable'), `expected a degrade reason, got ${lock.degraded}`);
  lock.release(); // must not throw
});

test('planLocksEnabled: VERIKUN_NO_PLAN_LOCK restores the pre-lock behaviour exactly', async () => {
  assert.equal(planLocksEnabled({}), true);
  assert.equal(planLocksEnabled({ VERIKUN_NO_PLAN_LOCK: '1' }), false);
  // The off switch takes the same closed domain as every other boolean env var here.
  assert.equal(planLocksEnabled({ VERIKUN_NO_PLAN_LOCK: '0' }), true);
  assert.equal(planLocksEnabled({ VERIKUN_NO_PLAN_LOCK: 'off' }), true);

  const lock = await takePlanLock(KEY, { host: HOST, env: { VERIKUN_NO_PLAN_LOCK: '1' } });
  assert.equal(lock.held, false);
  // No `degraded`, so nothing is printed: the disabled path is byte-identical to pre-lock,
  // which is what makes the mechanism debuggable by bisection.
  assert.equal(lock.degraded, undefined);
  assert.equal(existsSync(planLocksDir()), false, 'disabled means no reads AND no writes');
});

// --- the wait ceiling -------------------------------------------------------

test('planLockWaitMs: derived from the run budget, because waiting spends it', () => {
  // `runAiTest` computes its deadline BEFORE obtainPlan, so a fixed generous wait would turn
  // a healthy suite into `run timeout reached` — a new way to fail.
  assert.equal(planLockWaitMs(900_000), 225_000); // the 15m default → a quarter
  assert.equal(planLockWaitMs(60_000), 15_000);
  assert.equal(planLockWaitMs(4_000_000), 240_000); // capped: covers a CLI provider's 180s
  assert.equal(planLockWaitMs(0), 0); // no floor — a tiny --timeout simply does not wait
});

// --- concurrency ------------------------------------------------------------

// Exactly one winner among processes racing for one key. Only REAL processes can show this
// — in-process calls are serialized by the event loop and would pass however the writer was
// implemented. Scope, honestly: this pins EXCLUSIVITY, not the publish window; the
// `writeFileSync(…, {flag:'wx'})` that `writeExclusive` replaced also passes here, because
// its create-then-fill gap only opens under real load. The deterministic tests above are the
// gate; this guards the invariant that would break if the exclusive create were ever swapped
// for a plain write.
//
// The winner deliberately SLEEPS while holding, because that is what a compiling process
// does. A child that took the lock and exited at once would be handing it straight back —
// its pid dies, the next prober correctly judges the lock stale and takes over, and the
// test would report several "winners" for what is really correct crash recovery. That is
// the mechanism working, not a race, and it is worth knowing it behaves that way.
//
// Device-free (it only touches a temp directory), so it belongs in the unit suite.
test('takePlanLock: 8 processes racing for one key yield exactly one holder', async () => {
  const mod = require.resolve('../src/agent/plan-lock');
  // Arguments travel by environment, not argv: under `node -e` there is no script path, so
  // argv[1] is already the first user argument and a slice(2) would silently drop one.
  const child = `
    process.chdir(process.env.VK_TEST_CWD);
    const { takePlanLock } = require(${JSON.stringify(mod)});
    takePlanLock(
      { nl: 'launch and sign in', pkg: 'com.x', platform: 'android' },
      { host: 'race-host', ceilingMs: 0, pollMs: 5 },
    ).then((l) => {
      if (!l.held) return process.stdout.write('LOST');
      // Stand in for the compile: stay alive long enough for every racer to probe.
      setTimeout(() => process.stdout.write('WON'), 800);
    });
  `;

  const { spawn } = await import('node:child_process');
  // Spawn first, then let them all run: staggering the starts would hide the race.
  const kids = Array.from({ length: 8 }, () =>
    spawn(process.execPath, ['-e', child], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, VK_TEST_CWD: dir },
    }),
  );
  const outcomes = await Promise.all(
    kids.map(
      (k) =>
        new Promise<string>((res) => {
          let out = '';
          k.stdout.on('data', (b: Buffer) => (out += b.toString()));
          k.on('close', () => res(out));
        }),
    ),
  );
  const won = outcomes.filter((o) => o === 'WON');
  assert.equal(won.length, 1, `expected exactly 1 holder, got ${won.length} of ${outcomes.length}: ${outcomes}`);
});
