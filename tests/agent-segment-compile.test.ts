import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFromSegments, obtainPlan, assertBudgetForCompile, cachedSegment } from '../src/cli';
import { CostTracker, Price } from '../src/agent/cost';
import { Segment } from '../src/agent/include';
import { CacheKeyInput, planKey, writePlan } from '../src/agent/cache';
import { AgentProvider, CompileInput, CompileResult, RepairResult } from '../src/agent/provider';
import { InvalidPlanError, Plan, LeafStep } from '../src/agent/ir';
import { CliError } from '../src/errors';

// compileFromSegments is what makes `@include` more than a textual paste: one compile per
// chunk of prose, each cached under its own key. It writes under ./.verikun (cwd-relative),
// so each test runs inside a throwaway temp dir — same pattern as agent-cache.test.ts, and
// node:test runs a file's tests sequentially, so chdir is safe.
//
// Prices here are SYNTHETIC and round: a call bills exactly $1.00, so a ceiling is a count
// of calls. Never assert real vendor pricing — it drifts.

const PRICE: Price = { input: 1_000_000, output: 1_000_000 }; // USD per 1M tokens => 1 tok = $1
const ONE_DOLLAR = { input_tokens: 1, output_tokens: 0 };

const KEY: CacheKeyInput = { nl: 'the whole test', pkg: 'com.x', platform: 'android' };

function opts(maxCostUsd = 100): Parameters<typeof compileFromSegments>[2] {
  return { model: 'fake-model', price: PRICE, maxCostUsd, timeoutMs: 60_000, recompile: false };
}

function seg(text: string, source = 'a.md', startLine = 1, compilable = true): Segment {
  return { text, source, startLine, compilable };
}

const leaf = (command: string): LeafStep => ({ type: 'command', command, positionals: ['@x'], flags: [] });

/** A provider that answers from a scripted table keyed by the prose it is handed. */
class FakeProvider implements AgentProvider {
  readonly seen: string[] = [];
  constructor(private readonly answers: Record<string, Plan | 'no-steps'>) {}
  async compile(input: CompileInput): Promise<CompileResult> {
    this.seen.push(input.nl);
    const answer = this.answers[input.nl];
    if (answer === undefined) throw new Error(`fake provider has no answer for ${JSON.stringify(input.nl)}`);
    if (answer === 'no-steps') throw new InvalidPlanError('plan: has no steps', 'no-steps');
    return { plan: answer, usage: ONE_DOLLAR };
  }
  async repair(): Promise<RepairResult> {
    throw new Error('not used');
  }
}

const planOf = (...commands: string[]): Plan => ({ version: 1, steps: commands.map(leaf) });

let dir: string;
let cwd: string;
let stderr: typeof process.stderr.write;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-segments-'));
  process.chdir(dir);
  stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true; // progress is chatty and goes to stderr by contract
});
afterEach(() => {
  process.stderr.write = stderr;
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

// --- assembling ------------------------------------------------------------

test('compileFromSegments: concatenates each segment’s steps in file order', async () => {
  const provider = new FakeProvider({ 'launch it': planOf('launch'), 'tap it': planOf('tap', 'assert') });
  const plan = await compileFromSegments([seg('launch it'), seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider);
  assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['launch', 'tap', 'assert']);
});

test('compileFromSegments: a headings-only segment is never handed to the model', async () => {
  const provider = new FakeProvider({ 'tap it': planOf('tap') });
  const plan = await compileFromSegments(
    [seg('# Title\n', 'a.md', 1, false), seg('tap it')],
    KEY,
    opts(),
    new CostTracker(PRICE),
    provider,
  );
  assert.deepEqual(provider.seen, ['tap it'], 'the title chunk cost nothing');
  assert.equal(plan?.steps.length, 1);
});

test('compileFromSegments: a segment the model compiles to nothing contributes nothing, not an error', async () => {
  // A paragraph of rationale is a legitimate section of a test. parsePlan rejects a stepless
  // plan — right for a whole test, wrong for one section of one.
  const provider = new FakeProvider({ 'this test checks the thing': 'no-steps', 'tap it': planOf('tap') });
  const plan = await compileFromSegments(
    [seg('this test checks the thing'), seg('tap it')],
    KEY,
    opts(),
    new CostTracker(PRICE),
    provider,
  );
  assert.equal(plan?.steps.length, 1);
});

test('compileFromSegments: nothing compilable at all returns null, never a stepless plan', async () => {
  const provider = new FakeProvider({});
  const plan = await compileFromSegments([seg('# Title\n', 'a.md', 1, false)], KEY, opts(), new CostTracker(PRICE), provider);
  assert.equal(plan, null);
});

// --- the point of it: a shared chunk is compiled once ----------------------

test('compileFromSegments: an identical chunk in a second test is a cache hit, not a second call', async () => {
  const shared = 'launch and sign in';
  const provider = new FakeProvider({ [shared]: planOf('launch'), 'tap it': planOf('tap'), 'swipe it': planOf('swipe') });
  await compileFromSegments([seg(shared, '_p.md'), seg('tap it', 'one.md')], KEY, opts(), new CostTracker(PRICE), provider);
  await compileFromSegments([seg(shared, '_p.md'), seg('swipe it', 'two.md')], KEY, opts(), new CostTracker(PRICE), provider);
  assert.deepEqual(provider.seen, [shared, 'tap it', 'swipe it'], 'the shared preamble was compiled once');
});

// --- ...and once across CONCURRENT processes too (issue #117) --------------
//
// A pooled `vk suite` is N child processes sharing one ./.verikun, so on a cold cache every
// lane missed the same `@include`d fragment at the same instant and compiled its own — N x
// the tokens, and N different nondeterministic draws of one preamble alive in one suite run.
// These pin the caller's half of the fix; tests/agent-compile-lock.test.ts pins the lock.
//
// `FakeProvider` throws on any prose it has no answer for, so "the model was not called" is
// asserted simply by giving it no answer.

const lockDirFor = (): string => join(process.cwd(), '.verikun', 'plan-locks');
const lockFileFor = (text: string): string => join(lockDirFor(), `${planKey({ ...KEY, nl: text })}.lock`);

/** Plant a lock held by a LIVE pid — this process — so a taker must wait for it. */
function plantLiveLock(text: string): void {
  mkdirSync(lockDirFor(), { recursive: true });
  writeFileSync(
    lockFileFor(text),
    JSON.stringify({ key: planKey({ ...KEY, nl: text }), pid: process.pid, host: hostname(), cwd: process.cwd(), startedAt: new Date().toISOString(), version: '0.0.0-test' }),
  );
}

test('compileFromSegments: a cache hit takes no lock at all', async () => {
  // The steady state is all hits, and it must stay free of lock I/O entirely.
  const provider = new FakeProvider({ 'tap it': planOf('tap') });
  await compileFromSegments([seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider);
  rmSync(lockDirFor(), { recursive: true, force: true });
  await compileFromSegments([seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider);
  assert.equal(existsSync(lockDirFor()), false, 'a warm compile touched the lock directory');
});

test('compileFromSegments: a chunk another run is compiling is WAITED for, not compiled again', async () => {
  // The bug, deterministically: a live lock on the shared chunk, released a moment later
  // with the plan cached — exactly what the lane that won the race does.
  const shared = 'launch and sign in';
  plantLiveLock(shared);
  setTimeout(() => {
    writePlan({ ...KEY, nl: shared }, planOf('launch'));
    rmSync(lockFileFor(shared), { force: true });
  }, 40);

  // No answer for `shared`, so any call to the model throws.
  const provider = new FakeProvider({ 'tap it': planOf('tap') });
  const plan = await compileFromSegments([seg(shared, '_p.md'), seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider);
  assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['launch', 'tap']);
  assert.deepEqual(provider.seen, ['tap it'], 'the shared chunk came from the other run');
});

test('compileFromSegments: a chunk someone else already compiled is FREE, even past the ceiling', async () => {
  // The budget gate is asked after the under-lock re-read, not before the lock: refusing a
  // plan another lane just handed us would fail a test over somebody else's tokens.
  const shared = 'launch and sign in';
  writePlan({ ...KEY, nl: shared }, planOf('launch'));
  const cost = new CostTracker(PRICE, 0.5);
  cost.add({ input_tokens: 1, output_tokens: 0 }, 'compile'); // $1 > $0.50, already over
  const provider = new FakeProvider({});
  const plan = await compileFromSegments([seg(shared, '_p.md')], KEY, opts(0.5), cost, provider);
  assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['launch']);
});

test('compileFromSegments: a waiter that gives up at the ceiling compiles anyway', async () => {
  // The degrade must be "one duplicate compile", which is today's behaviour — never a
  // failure. --timeout 200ms gives a 50ms lock ceiling via planLockWaitMs.
  plantLiveLock('tap it'); // never released
  const provider = new FakeProvider({ 'tap it': planOf('tap') });
  const plan = await compileFromSegments([seg('tap it')], KEY, { ...opts(), timeoutMs: 200 }, new CostTracker(PRICE), provider);
  assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['tap']);
  assert.deepEqual(provider.seen, ['tap it']);
});

test('compileFromSegments: a failed compile releases its lock instead of leaving a corpse', async () => {
  const provider = new FakeProvider({}); // no answer => throws
  await assert.rejects(() => compileFromSegments([seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider));
  assert.equal(existsSync(lockFileFor('tap it')), false, 'the next lane would have timed out on it');
});

test('compileFromSegments: VERIKUN_NO_PLAN_LOCK restores the pre-lock behaviour exactly', async () => {
  plantLiveLock('tap it'); // a lock that would otherwise be waited for
  const provider = new FakeProvider({ 'tap it': planOf('tap') });
  process.env.VERIKUN_NO_PLAN_LOCK = '1';
  try {
    const plan = await compileFromSegments([seg('tap it')], KEY, opts(), new CostTracker(PRICE), provider);
    assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['tap']);
    assert.deepEqual(provider.seen, ['tap it'], 'the lock was neither taken nor honoured');
  } finally {
    delete process.env.VERIKUN_NO_PLAN_LOCK;
  }
});

// --- --recompile: ignore the disk, but not a lane racing you right now ------

test('cachedSegment: --recompile ignores a leftover entry from a previous run', () => {
  const key: CacheKeyInput = { ...KEY, nl: 'tap it' };
  writePlan(key, planOf('tap'));
  // Backdate it past this process's start: a genuine leftover.
  const p = join(process.cwd(), '.verikun', 'plans', `${planKey(key)}.json`);
  const entry = JSON.parse(readFileSync(p, 'utf8')) as { savedAt: string };
  writeFileSync(p, JSON.stringify({ ...entry, savedAt: '1970-01-01T00:00:00.000Z' }));

  assert.ok(cachedSegment(key, opts()), 'without --recompile it is still a hit');
  assert.equal(cachedSegment(key, { ...opts(), recompile: true }), null);
});

test('cachedSegment: --recompile DOES accept an entry a concurrent run just wrote', () => {
  // Three lanes must not each pay for the same fragment. An entry written after this process
  // started cannot be a leftover — it was written by a process racing this one right now.
  const key: CacheKeyInput = { ...KEY, nl: 'tap it' };
  writePlan(key, planOf('tap'));
  assert.ok(cachedSegment(key, { ...opts(), recompile: true }));
});

// --- the lint still judges the ASSEMBLED plan ------------------------------

test('compileFromSegments: a lint finding against the assembled plan drops the split', async () => {
  // "logged out" in the WHOLE test with no `launch --clear` anywhere — a question no single
  // section can answer, which is why the lint runs on the assembly.
  const key: CacheKeyInput = { ...KEY, nl: 'Start logged out.\n\nlaunch it' };
  const provider = new FakeProvider({ 'launch it': planOf('launch') });
  assert.equal(await compileFromSegments([seg('launch it')], key, opts(), new CostTracker(PRICE), provider), null);
});

// --- the budget: never an ADDITIONAL call past the ceiling -----------------

test('compileFromSegments: refuses to compile a FURTHER segment once the ceiling is crossed', async () => {
  const provider = new FakeProvider({ a: planOf('launch'), b: planOf('tap'), c: planOf('swipe') });
  const cost = new CostTracker(PRICE, 1.5); // two calls ($2) cross it
  await assert.rejects(
    () => compileFromSegments([seg('a'), seg('b'), seg('c')], KEY, opts(1.5), cost, provider),
    (e: unknown) => e instanceof CliError && e.exitCode === 1 && /cost ceiling \$1\.5/.test(e.message),
  );
  assert.deepEqual(provider.seen, ['a', 'b'], 'the third segment was never paid for');
});

test('compileFromSegments: crossing the ceiling on the LAST segment still yields a complete plan', async () => {
  // Nothing further is being asked for, so there is nothing to refuse — throwing here would
  // discard a finished compile. runAiTest declines to RUN it, with a proper budget verdict.
  const provider = new FakeProvider({ a: planOf('launch'), b: planOf('tap') });
  const cost = new CostTracker(PRICE, 1.5);
  const plan = await compileFromSegments([seg('a'), seg('b')], KEY, opts(1.5), cost, provider);
  assert.deepEqual(plan?.steps.map((s) => (s as LeafStep).command), ['launch', 'tap']);
  assert.ok(cost.exceeded());
});

// --- the guard itself ------------------------------------------------------

test('assertBudgetForCompile: silent under the ceiling, exit 1 naming the ceiling over it', () => {
  const cost = new CostTracker(PRICE, 1.5);
  assert.doesNotThrow(() => assertBudgetForCompile(cost, 1.5, 'compiling x'));
  cost.add({ input_tokens: 2, output_tokens: 0 }, 'compile'); // $2 > $1.50
  assert.throws(
    () => assertBudgetForCompile(cost, 1.5, 'compiling x'),
    (e: unknown) => e instanceof CliError && e.exitCode === 1 && /not compiling x/.test(e.message),
  );
});

// --- the whole-file fallback is an ADDITIONAL call, and asks too ------------

test('obtainPlan: a dropped split does not buy a whole-file compile once the ceiling is crossed', async () => {
  // The hole this closes: segment calls are already billed, and falling back adds a FULL
  // compile on top — so total spend passed the ceiling before runAiTest ever got to abort.
  // "logged out" with no `launch --clear` makes the lint drop the split, which is the exact
  // path that reaches the fallback.
  const key: CacheKeyInput = { ...KEY, nl: 'Start logged out.\n\na\n\nb' };
  const provider = new FakeProvider({ a: planOf('launch'), b: planOf('tap') });
  const cost = new CostTracker(PRICE, 1.5); // the two segments cost $2 between them
  await assert.rejects(
    () => obtainPlan(key, 't.md', opts(1.5), cost, provider, [seg('a'), seg('b')]),
    (e: unknown) => e instanceof CliError && e.exitCode === 1 && /as one instead/.test(e.message),
  );
  assert.deepEqual(provider.seen, ['a', 'b'], 'no third, whole-file compile was paid for');
});

test('obtainPlan: with budget left, a dropped split DOES fall back to compiling the whole test', async () => {
  const key: CacheKeyInput = { ...KEY, nl: 'Start logged out.\n\na\n\nb' };
  const provider = new FakeProvider({ a: planOf('launch'), b: planOf('tap'), [key.nl]: planOf('launch', 'tap') });
  const { plan } = await obtainPlan(key, 't.md', opts(100), new CostTracker(PRICE, 100), provider, [seg('a'), seg('b')]);
  // Four calls, and the fourth is the point: the fallback is the ORDINARY whole-file path,
  // lint-guided retry included, not a stripped-down one.
  assert.deepEqual(provider.seen, ['a', 'b', key.nl, key.nl]);
  assert.equal(plan.steps.length, 2);
});
