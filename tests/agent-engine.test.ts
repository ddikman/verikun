import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runPlan, EngineDeps, ExecFn, ExecOutcome } from '../src/agent/engine';
import { Plan, PlanNode, LeafStep } from '../src/agent/ir';
import { SelectorNotFoundError, AmbiguousSelectorError } from '../src/errors';
import { CostTracker } from '../src/agent/cost';
import { AgentProvider } from '../src/agent/provider';
import { makeEl } from './helpers';

// --- builders --------------------------------------------------------------

const leaf = (command: string, positionals: string[] = []): LeafStep => ({
  type: 'command',
  command,
  positionals,
  flags: [],
});

const plan = (...steps: PlanNode[]): Plan => ({ version: 1, steps });

/** A fake exec that returns queued outcomes in order, holding the last forever. */
function execFrom(outcomes: ExecOutcome[]): { fn: ExecFn; calls: Array<{ command: string; positionals: string[] }> } {
  const calls: Array<{ command: string; positionals: string[] }> = [];
  let i = 0;
  const fn: ExecFn = async (command, positionals) => {
    calls.push({ command, positionals });
    return outcomes[Math.min(i++, outcomes.length - 1)];
  };
  return { fn, calls };
}

function fakeProvider(replaceStep: LeafStep, counter?: { n: number }): AgentProvider {
  return {
    async compile() {
      throw new Error('compile not used in these tests');
    },
    async repair() {
      if (counter) counter.n++;
      return { replaceStep, usage: {} };
    },
  };
}

function deps(over: Partial<EngineDeps>): EngineDeps {
  return {
    exec: async () => ({ code: 0 }),
    getElements: () => [],
    provider: fakeProvider(leaf('tap', ['@ok'])),
    cost: new CostTracker({ input: 1, output: 1 }),
    log: () => {},
    maxRepairs: 3,
    ...over,
  };
}

// --- the heal-vs-terminal discriminator (the load-bearing correctness invariant) ---

test('runPlan: a clean plan passes with zero model calls', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('tap', ['@a']), leaf('assert', ['text:Home'])), deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@x']), counter) }));
  assert.equal(r.ok, true);
  assert.equal(r.modelRepairs, 0);
  assert.equal(counter.n, 0);
  assert.equal(calls.length, 2);
});

test('runPlan: a selector MISS heals via the model, then succeeds', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('tap', ['@login'])), deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@signin']), counter) }));
  assert.equal(r.ok, true);
  assert.equal(r.modelRepairs, 1);
  assert.equal(counter.n, 1);
  // the repaired leaf is spliced into the plan (what gets persisted on green)
  assert.equal((r.plan.steps[0] as LeafStep).positionals[0], '@signin');
  assert.ok(r.improvements.length >= 1);
});

test('runPlan: an AMBIGUOUS match also heals (third case, not a terminal abort)', async () => {
  const { fn } = execFrom([
    { code: 2, error: new AmbiguousSelectorError('amb', [makeEl({ text: 'A' }), makeEl({ text: 'B' })]) },
    { code: 0 },
  ]);
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('tap', ['text:Item'])), deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@itemA']), counter) }));
  assert.equal(r.ok, true);
  assert.equal(counter.n, 1);
});

test('runPlan: an ASSERTION failure is terminal and is NEVER healed', async () => {
  const { fn } = execFrom([{ code: 1 }]); // exit 1 with NO error == assert returned false
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('assert', ['text:Home'])), deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@x']), counter) }));
  assert.equal(r.ok, false);
  assert.equal(counter.n, 0); // the model must NOT be asked to "heal" a real regression
  assert.equal(r.modelRepairs, 0);
});

test('runPlan: an unresolvable selector fails after maxRepairs attempts', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }]); // always misses
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('tap', ['@x'])), deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@x']), counter), maxRepairs: 2 }));
  assert.equal(r.ok, false);
  assert.equal(r.modelRepairs, 2);
  assert.equal(counter.n, 2);
});

test('runPlan: a hallucinated repair command is rejected (terminal, never executed)', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  const badProvider: AgentProvider = {
    async compile() {
      throw new Error('unused');
    },
    async repair() {
      // not a known command — must be rejected by validateNode before splicing
      return { replaceStep: { type: 'command', command: 'frobnicate', positionals: [], flags: [] }, usage: {} };
    },
  };
  const r = await runPlan(plan(leaf('tap', ['@x'])), deps({ exec: fn, provider: badProvider }));
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /repair failed/);
});

test('runPlan: a repair DECLINE (give_up) fails the test instead of substituting a wrong element', async () => {
  // The screen drifted (e.g. the wallpaper app), so no element serves the step intent.
  // The model declines (replaceStep=null) and the run must FAIL — not tap something
  // convenient and pass falsely. This is the "too kind fallback" guard.
  const { fn, calls } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  const declineProvider: AgentProvider = {
    async compile() {
      throw new Error('unused');
    },
    async repair() {
      return { replaceStep: null, declineReason: 'this is the wallpaper screen, not the camera', usage: {} };
    },
  };
  const r = await runPlan(plan(leaf('tap', ['desc:2.0X zoom'])), deps({ exec: fn, provider: declineProvider }));
  assert.equal(r.ok, false);
  assert.equal(r.modelRepairs, 0); // a decline is not a repair
  assert.match(r.failure?.reason ?? '', /drifted/);
  assert.match(r.failure?.reason ?? '', /wallpaper/); // the model's reason is surfaced
  assert.equal(calls.length, 1); // only the original failing attempt ran — no wrong substitution executed
});

test('runPlan: a decline inside an if-present body fails the run (never silently skips)', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }]);
  const declineProvider: AgentProvider = {
    async compile() {
      throw new Error('unused');
    },
    async repair() {
      return { replaceStep: null, declineReason: 'wrong screen', usage: {} };
    },
  };
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Go', body: [leaf('tap', ['@go'])] }),
    deps({ exec: fn, getElements: () => [makeEl({ text: 'Go' })], provider: declineProvider }),
  );
  assert.equal(r.ok, false); // guard present -> body runs -> tap misses -> decline -> fail propagates
  assert.match(r.failure?.reason ?? '', /drifted/);
});

// --- control flow ----------------------------------------------------------

test('runPlan: if-present runs the body when the selector is present', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements: () => [makeEl({ text: 'Allow' })] }),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // body ran
});

test('runPlan: if-present skips the body when the selector is absent', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements: () => [makeEl({ text: 'Home' })] }),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0); // body skipped
});

test('runPlan: repeat runs the body up to the cap when the selector never appears', async () => {
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  let tick = 0;
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@target', cap: 3, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements: () => [makeEl({ text: `row-${tick++}` })] }), // screen changes -> no false no-progress
  );
  assert.equal(r.ok, true);
  assert.equal(calls.n, 3);
});

test('runPlan: repeat exits early when the screen stops changing (no-progress)', async () => {
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@target', cap: 10, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements: () => [makeEl({ text: 'static' })] }), // identical structure each call
  );
  assert.equal(r.ok, true);
  assert.equal(calls.n, 1); // bailed after the first no-progress iteration
});

test('runPlan: repeat stops as soon as the target selector is present', async () => {
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: 'text:Done', cap: 10, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements: () => [makeEl({ text: 'Done' })] }), // already present
  );
  assert.equal(r.ok, true);
  assert.equal(calls.n, 0); // guard met before any body run
});

// --- budget ----------------------------------------------------------------

test('runPlan: aborts for budget before spending another repair', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }]); // always misses
  const cost = new CostTracker({ input: 1000, output: 1000 }, 0.000001);
  cost.add({ input_tokens: 1_000_000 }, 'compile'); // already way over the ceiling
  const counter = { n: 0 };
  const r = await runPlan(plan(leaf('tap', ['@x'])), deps({ exec: fn, cost, provider: fakeProvider(leaf('tap', ['@x']), counter) }));
  assert.equal(r.ok, false);
  assert.equal(r.abortedForBudget, true);
  assert.equal(counter.n, 0); // never even asked for a repair it couldn't afford
});

// --- self-heal recording (a healed leaf must not read as a failure) ---

test('runPlan: markHealed fires once per successful repair', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  let healed = 0;
  const r = await runPlan(
    plan(leaf('tap', ['@login'])),
    deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@signin'])), markHealed: () => healed++ }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.modelRepairs, 1);
  assert.equal(healed, 1); // the failed attempt gets downgraded to a healed pass
});

test('runPlan: markHealed fires per repair attempt, never on the final unrecovered failure', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }]); // always misses
  let healed = 0;
  const r = await runPlan(
    plan(leaf('tap', ['@x'])),
    deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@x'])), markHealed: () => healed++, maxRepairs: 2 }),
  );
  assert.equal(r.ok, false);
  assert.equal(healed, 2); // one per repair; the final failed attempt stays a failure
});

// --- dump-failure resilience (a transient uiautomator dump failure must not abort the run) ---

test('runPlan: a UI-dump failure inside a repeat degrades gracefully (no crash)', async () => {
  const exec: ExecFn = async () => ({ code: 0 });
  const getElements = () => {
    throw new Error('uiautomator dump failed');
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@target', cap: 5, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements }),
  );
  assert.equal(r.ok, true); // bails on no-progress (empty screen) instead of throwing
});

test('runPlan: if-present re-fetches once on a transient dump failure (body still runs)', async () => {
  let n = 0;
  const getElements = () => {
    n++;
    if (n === 1) throw new Error('transient dump failure');
    return [makeEl({ text: 'Allow' })];
  };
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements }),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // present() retried the throwing dump, found Allow, ran the body
});

test('runPlan: a UI-dump failure during repair still attempts the repair with an empty hierarchy', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  let hierarchyLen = -1;
  const provider: AgentProvider = {
    async compile() {
      throw new Error('unused');
    },
    async repair(ctx) {
      hierarchyLen = ctx.hierarchy.length;
      return { replaceStep: leaf('tap', ['@ok']), usage: {} };
    },
  };
  const getElements = () => {
    throw new Error('dump failed');
  };
  const r = await runPlan(plan(leaf('tap', ['@x'])), deps({ exec: fn, getElements, provider }));
  assert.equal(r.ok, true);
  assert.equal(hierarchyLen, 0); // safeElements() returned [] instead of crashing the run
});
