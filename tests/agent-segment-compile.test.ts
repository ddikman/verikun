import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFromSegments, obtainPlan, assertBudgetForCompile } from '../src/cli';
import { CostTracker, Price } from '../src/agent/cost';
import { Segment } from '../src/agent/include';
import { CacheKeyInput } from '../src/agent/cache';
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
