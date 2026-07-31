import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { runPlan, EngineDeps, ExecFn, ExecOutcome } from '../src/agent/engine';
import { Plan, PlanNode, LeafStep, IfPresentNode, RepeatNode } from '../src/agent/ir';
import { SelectorNotFoundError, AmbiguousSelectorError } from '../src/errors';
import { CostTracker } from '../src/agent/cost';
import { AgentProvider } from '../src/agent/provider';
import { makeEl, asLeaf } from './helpers';

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
    // 0 by default so the fakes never sleep: these tests assert guard SEMANTICS
    // (runs / skips / heals), not timing. The settle window has its own tests below,
    // which set a small explicit window.
    guardSettleMs: 0,
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

test('runPlan: a repair that returns a control node (not a leaf command) is rejected', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  const controlProvider: AgentProvider = {
    async compile() {
      throw new Error('compile not used in these tests');
    },
    // Structurally valid per validateNode, but NOT a leaf command — must be rejected
    // by the engine's `node.type !== 'command'` guard, never spliced into the plan.
    async repair() {
      return { replaceStep: { type: 'if-present', selector: 'text:x', body: [] } as unknown as LeafStep, usage: {} };
    },
  };
  const r = await runPlan(plan(leaf('tap', ['@x'])), deps({ exec: fn, provider: controlProvider }));
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /repair failed/);
});

test('runPlan: aborts when the run deadline has already passed', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(plan(leaf('tap', ['@a'])), deps({ exec: fn, deadline: Date.now() - 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.abortedForTimeout, true);
  assert.equal(calls.length, 0); // deadline is checked before the first step runs
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

test('runPlan: a repeat that exhausts its cap without ever seeing the target FAILS', async () => {
  // Inverted deliberately. This used to pass green: the loop "finished", so the run was
  // ok even though the thing it was waiting for never appeared. A scroll-until that never
  // finds its row has not succeeded, and inside a branching body it is the reachable
  // false green (a `when` with else:[] does nothing, the loop spins, everyone reports ok).
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
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /without '@target' ever appearing/);
  assert.equal(calls.n, 3); // it still tried the full cap before failing
});

test('runPlan: a repeat that bails on no-progress without reaching the target FAILS', async () => {
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@target', cap: 10, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements: () => [makeEl({ text: 'static' })] }), // identical structure each call
  );
  // Several consecutive identical snapshots, not one or two. This check only saves time
  // (the loop fails on the missing target either way), so it is tuned to almost never
  // fire on an animating screen — measured: at 2 strikes it bailed a loop that was
  // legitimately answering questions.
  assert.equal(calls.n, 4);
  assert.equal(r.ok, false); // stopping early is still not the same as succeeding
});

test('runPlan: an empty (mid-transition) screen read is not counted as "no progress"', async () => {
  // Measured on a real app: `ui` reported zero elements while tap's auto-wait found its
  // target 3.1s later. Two such frames used to hash identically and look like a stall.
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  let n = 0;
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@target', cap: 6, body: [leaf('swipe', ['up'])] }),
    // Empty, empty, then the target: a naive check bails on the two empties and fails.
    deps({ exec, getElements: () => (++n >= 3 ? [makeEl({ idShort: 'target' })] : []) }),
  );
  assert.equal(r.ok, true);
  assert.ok(calls.n >= 1, 'the loop should have kept going through the blank frames');
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

// --- control-body heal persistence (regression for #18) --------------------
// A heal applied to a leaf INSIDE an if-present/repeat body must be spliced back
// into the plan object exactly like a top-level heal (see "a selector MISS heals"
// above), so it persists on green via writePlan(result.plan). Guards against the
// "vk ai doesn't persist repeat-body heals" misdiagnosis in #18 — where the
// recurring heal was actually a flaky selector re-missing, not a dropped repair.

test('runPlan: a heal inside an if-present body is spliced into the persisted plan (#18)', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Go', body: [leaf('tap', ['@login'])] }),
    deps({ exec: fn, getElements: () => [makeEl({ text: 'Go' })], provider: fakeProvider(leaf('tap', ['@signin'])) }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.modelRepairs, 1);
  // the repaired BODY leaf is written back into the control node (what gets persisted on green)
  assert.equal(asLeaf((r.plan.steps[0] as IfPresentNode).body[0]).positionals[0], '@signin');
});

test('runPlan: a heal inside a repeat body is spliced into the persisted plan (#18)', async () => {
  const { fn } = execFrom([{ code: 1, error: new SelectorNotFoundError('miss') }, { code: 0 }]);
  // The loop must legitimately REACH its target, because the splice only matters for a
  // plan that gets persisted, and only a green run is persisted. 'Done' appears once the
  // body has run, so iteration 2's exit check succeeds.
  let bodyRuns = 0;
  const r = await runPlan(
    plan({ type: 'repeat', selector: 'text:Done', cap: 5, body: [leaf('tap', ['@login'])] }),
    deps({
      exec: async (c, p) => {
        bodyRuns++;
        return fn(c, p, {});
      },
      getElements: () => [makeEl({ text: bodyRuns > 0 ? 'Done' : 'row' })],
      provider: fakeProvider(leaf('tap', ['@signin'])),
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.modelRepairs, 1);
  assert.equal(asLeaf((r.plan.steps[0] as RepeatNode).body[0]).positionals[0], '@signin');
});

// --- when: ordered n-way dispatch (issue #33's loop-that-branches) -------------------

test('runPlan: when runs the FIRST matching branch and only that one', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({
      type: 'when',
      branches: [
        { selector: '@nope', body: [leaf('tap', ['@a'])] },
        { selector: '@here', body: [leaf('tap', ['@b'])] },
        { selector: '@here', body: [leaf('tap', ['@c'])] }, // also matches, must NOT run
      ],
    }),
    deps({ exec: fn, getElements: () => [makeEl({ idShort: 'here' })] }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.positionals[0]), ['@b']);
});

test('runPlan: when with NO matching branch and no else FAILS (never silently skips)', async () => {
  // The false green this node exists to prevent: inside a repeat, a silent skip would
  // spin to the cap doing nothing and report success.
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'when', branches: [{ selector: '@a', body: [leaf('tap', ['@a'])] }] }),
    deps({ exec: fn, getElements: () => [makeEl({ idShort: 'something_else' })] }),
  );
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /no branch matched/);
  assert.equal(calls.length, 0);
});

test('runPlan: when falls through to else when given one', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'when', branches: [{ selector: '@a', body: [leaf('tap', ['@a'])] }], else: [leaf('tap', ['@fallback'])] }),
    deps({ exec: fn, getElements: () => [makeEl({ idShort: 'other' })] }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.positionals[0]), ['@fallback']);
});

test('runPlan: a repeat containing a when dispatches per iteration (the #33 shape)', async () => {
  // Two different "question types" in sequence, then the target appears. A flat unioned
  // body — what the compiler emitted before `when` existed — would tap both every round.
  const calls: string[] = [];
  let step = 0;
  const exec: ExecFn = async (_c, p) => {
    calls.push(p[0]);
    step++;
    return { code: 0 };
  };
  const screens = [['multi'], ['pairs'], ['multi'], ['done']];
  const r = await runPlan(
    plan({
      type: 'repeat',
      selector: '@done',
      cap: 10,
      body: [
        {
          type: 'when',
          branches: [
            { selector: '@multi', body: [leaf('tap', ['@answer_multi'])] },
            { selector: '@pairs', body: [leaf('tap', ['@answer_pairs'])] },
          ],
        },
      ],
    }),
    deps({ exec, getElements: () => [makeEl({ idShort: screens[Math.min(step, screens.length - 1)][0] })] }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['@answer_multi', '@answer_pairs', '@answer_multi']);
});

// --- while-present + ctx counter (index-addressed lists of unknown length) ------------

test('runPlan: while-present walks an index-addressed list via its bound counter', async () => {
  // Three bubbles exist; the plan does not know that at compile time.
  const present = new Set(['bubble_0', 'bubble_1', 'bubble_2']);
  const calls: string[] = [];
  const exec: ExecFn = async (_c, p) => {
    calls.push(p[0]);
    return { code: 0 };
  };
  const r = await runPlan(
    plan({
      type: 'while-present',
      selector: 'id:bubble_{{ctx.i}}',
      bind: 'i',
      cap: 10,
      body: [leaf('tap', ['id:bubble_{{ctx.i}}'])],
    }),
    deps({ exec, getElements: () => [...present].map((idShort) => makeEl({ idShort })) }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['id:bubble_0', 'id:bubble_1', 'id:bubble_2']);
});

// --- read + {{ctx.*}} interpolation ---------------------------------------------------

test('runPlan: read captures a tree value into ctx for a later step to type', async () => {
  // The "hidden correct option" case: the answer is only knowable at runtime.
  const typed: string[] = [];
  const exec: ExecFn = async (_c, p) => {
    typed.push(p.join(' '));
    return { code: 0 };
  };
  const r = await runPlan(
    plan(
      { type: 'read', selector: '@correct', field: 'text', into: 'answer' },
      leaf('text', ['@input', '{{ctx.answer}}']),
    ),
    deps({ exec, getElements: () => [makeEl({ idShort: 'correct', text: 'bonjour' })] }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(typed, ['@input bonjour']);
});

test('runPlan: an unset {{ctx.*}} fails the step instead of typing an empty string', async () => {
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(plan(leaf('text', ['@input', '{{ctx.missing}}'])), deps({ exec: fn }));
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /not set/);
  assert.equal(calls.length, 0); // never reached the device
});

test('runPlan: {{uuid}} is generated once per run and reused across steps', async () => {
  const seen: string[] = [];
  const exec: ExecFn = async (_c, p) => {
    seen.push(p[1]);
    return { code: 0 };
  };
  const r = await runPlan(
    plan(leaf('text', ['@email', 'u-{{uuid}}@example.com']), leaf('text', ['@confirm', 'u-{{uuid}}@example.com'])),
    deps({ exec }),
  );
  assert.equal(r.ok, true);
  assert.equal(seen[0], seen[1]); // same address in both fields, or signup fails
  assert.match(seen[0], /^u-[0-9a-f-]{36}@example\.com$/);
});

test('runPlan: a missing {{env.*}} fails loudly rather than substituting empty', async () => {
  delete process.env.VK_TEST_ABSENT_VAR;
  const { fn } = execFrom([{ code: 0 }]);
  const r = await runPlan(plan(leaf('text', ['@pw', '{{env.VK_TEST_ABSENT_VAR}}'])), deps({ exec: fn }));
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /not set in the environment/);
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
  // "Gracefully" means a clean reported failure, not a thrown exception that aborts the
  // whole run as an environment error. It is still a failure: a loop whose target never
  // appeared did not succeed, and a device we cannot read is not evidence that it did.
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /ever appearing/);
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
  // Note the deps default guardSettleMs=0: the THROW retry is orthogonal to the settle
  // window, so it must still happen with the window closed.
});

// --- the guard settle window (issue #33: an interstitial that animates in) -----------
//
// Before this window existed, present() took ONE dump and trusted a successful-but-empty
// result, so an `if-present` guard was strictly less patient than a bare `tap` (which
// auto-waits ~5s) — and a dialog that animated in was missed by the very construct meant
// to catch it.

test('runPlan: if-present waits out the settle window for a guard that appears late', async () => {
  let n = 0;
  // Absent on the first two dumps, then the dialog lands — exactly the animating-in case.
  const getElements = () => (++n >= 3 ? [makeEl({ text: 'Allow' })] : []);
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements, guardSettleMs: 2000 }),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1); // the body ran — the guard did not give up on dump 1
});

test('runPlan: guardSettleMs=0 keeps if-present a single-shot probe (absent → skip, one dump)', async () => {
  let n = 0;
  const getElements = () => {
    n++;
    // A real, populated screen that simply does not contain the guard — NOT an empty
    // array, which now counts as a bad read and is deliberately re-read.
    return [makeEl({ idShort: 'something_else' })];
  };
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements, guardSettleMs: 0 }),
  );
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0); // body skipped
  assert.equal(n, 1); // and it cost exactly one dump — no re-poll
});

test('runPlan: a non-zero window buys a second look even when one dump outlasts it', async () => {
  // Regression guard for a measured defect: a uiautomator dump costs ~2.4s on
  // emulator-5554, so a purely time-boxed 1.5s window returned after ONE dump — making
  // the default a silent no-op on exactly the slow devices that need it. A non-zero
  // window must always buy a second look.
  let dumps = 0;
  const getElements = async () => {
    dumps++;
    await new Promise((r) => setTimeout(r, 40)); // one dump outlasts the 10ms window
    return dumps >= 2 ? [makeEl({ text: 'Allow' })] : [];
  };
  const { fn, calls } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'if-present', selector: 'text:Allow', body: [leaf('tap', ['text:Allow'])] }),
    deps({ exec: fn, getElements, guardSettleMs: 10 }),
  );
  assert.equal(r.ok, true);
  assert.equal(dumps, 2); // looked again despite the clock already being spent
  assert.equal(calls.length, 1); // and therefore ran the body
});

test("runPlan: a repeat's exit check never pays the settle window (it is absent by construction)", async () => {
  // Regression guard: the loop guard is absent on EVERY iteration — that is what makes it
  // a loop. If it inherited the if-present window, a cap-25 loop would burn 25 × the window
  // (~37s at the default) discovering something already expected. Counted, not timed, so
  // the assertion is deterministic.
  let dumps = 0;
  let bodyRuns = 0;
  const getElements = () => {
    dumps++;
    // Changes every dump (no no-progress bail), and reaches the target after 2 body runs
    // so the loop ends by SUCCEEDING — otherwise the post-loop confirmation check would
    // legitimately spend the window and swamp what this test measures.
    return [makeEl({ text: bodyRuns >= 2 ? 'Done' : `row-${dumps}` })];
  };
  const exec: ExecFn = async () => {
    bodyRuns++;
    return { code: 0 };
  };
  const node: RepeatNode = { type: 'repeat', selector: 'text:Done', cap: 10, body: [leaf('swipe', ['up'])] };
  const r = await runPlan(plan(node), deps({ exec, getElements, guardSettleMs: 60_000 }));
  assert.equal(r.ok, true);
  // ~2 dumps per iteration (exit check + no-progress hash) over ~3 iterations. If the
  // exit check inherited the window it would re-poll ~400x per iteration at 150ms.
  assert.ok(dumps < 12, `expected the loop guard not to re-poll, got ${dumps} dumps`);
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

// --- best-effort review screenshots (a failed capture must never fail the run) ---

test('runPlan: a review screenshot (or shot) that fails to capture does NOT fail the run', async () => {
  // The vk ai grammar sprinkles screenshot steps around transitions; a screencap
  // hiccup returns non-zero. It is best-effort evidence, so the run stays green and
  // the model is never asked to "repair" a screenshot.
  for (const cmd of ['screenshot', 'shot']) {
    const { fn, calls } = execFrom([{ code: 3, error: new Error('screencap failed') }]);
    const counter = { n: 0 };
    let healed = 0;
    const r = await runPlan(
      plan(leaf(cmd)),
      deps({ exec: fn, provider: fakeProvider(leaf('tap', ['@x']), counter), markHealed: () => healed++ }),
    );
    assert.equal(r.ok, true, `${cmd} should be best-effort`);
    assert.equal(counter.n, 0); // never asks the model to repair a screenshot
    assert.equal(calls.length, 1); // ran once, no retry
    assert.equal(healed, 1); // the failed step is downgraded so the report stays clean
  }
});

test('runPlan: the best-effort guard is scoped to screenshot — other commands still fail terminally', async () => {
  // A launch that exits non-zero (env error, non-healable) must remain a terminal
  // failure; the guard must not swallow every command's non-zero exit.
  const { fn } = execFrom([{ code: 3, error: new Error('device offline') }]);
  const r = await runPlan(plan(leaf('launch', ['com.example.app'])), deps({ exec: fn }));
  assert.equal(r.ok, false);
  assert.match(r.failure?.reason ?? '', /device offline/);
});

test('runPlan: an EMPTY dump is a bad read, not "absent" — re-read even at settleMs 0', async () => {
  // Measured twice on a real app: a single dump returns a blank/partial tree mid-transition
  // while tap's auto-wait finds the target seconds later. Trusting it means a guard silently
  // skips, or a loop-exit check misses its target and sends the loop round again to tap
  // something that has already gone away (which is what triggered a repair storm).
  // settleMs=0 is what the loop-exit check runs at, so the re-read must not depend on it.
  let n = 0;
  const getElements = () => {
    n++;
    return n === 1 ? [] : [makeEl({ text: 'Done' })]; // blank frame, then the real screen
  };
  const { fn } = execFrom([{ code: 0 }]);
  const r = await runPlan(
    plan({ type: 'repeat', selector: 'text:Done', cap: 5, body: [leaf('swipe', ['up'])] }),
    deps({ exec: fn, getElements, guardSettleMs: 0 }),
  );
  assert.equal(r.ok, true); // saw 'Done' on the re-read instead of looping on a blank frame
});

test('runPlan: a guard that races its own body ends the body, without spending a repair', async () => {
  // if-present X { tap X } where X vanishes between the check and the tap. On a
  // fast-transitioning app this is routine, and it is exactly what the guard is for —
  // so it must not cost three model calls to conclude the optional thing is absent.
  let dumps = 0;
  const getElements = () => {
    dumps++;
    return dumps <= 1 ? [makeEl({ idShort: 'splash' })] : [makeEl({ idShort: 'next_screen' })];
  };
  const exec: ExecFn = async () => ({ code: 1, error: new SelectorNotFoundError('gone') });
  const counter = { n: 0 };
  const r = await runPlan(
    plan({ type: 'if-present', selector: '@splash', body: [leaf('tap', ['@splash'])] }),
    deps({ exec, getElements, provider: fakeProvider(leaf('tap', ['@x']), counter), guardSettleMs: 0 }),
  );
  assert.equal(r.ok, true); // the guarded body ended cleanly
  assert.equal(counter.n, 0); // and the model was never woken
});

test('runPlan: the guard-race escape does NOT swallow a miss on a different selector', async () => {
  // Narrowness matters: only the leaf targeting the guard's own selector is excused.
  // Anything else missing inside the body is a real failure and must still heal/fail.
  const getElements = () => [makeEl({ idShort: 'splash' })];
  const exec: ExecFn = async () => ({ code: 1, error: new SelectorNotFoundError('miss') });
  const declining: AgentProvider = {
    async compile() {
      throw new Error('unused');
    },
    async repair() {
      return { replaceStep: null, declineReason: 'not there', usage: {} };
    },
  };
  const r = await runPlan(
    plan({ type: 'if-present', selector: '@splash', body: [leaf('tap', ['@something_else'])] }),
    deps({ exec, getElements, provider: declining, guardSettleMs: 0 }),
  );
  assert.equal(r.ok, false);
});

test('runPlan: screens that differ ONLY in desc are not mistaken for a stalled loop', async () => {
  // Flutter maps Semantics(label:) to Android contentDescription, so on a Flutter app the
  // content lives in `desc` and `text` is empty everywhere. Measured on a live screen:
  // 14 elements, 0 with text, 8 with desc. A text-only fingerprint therefore collapsed
  // every question to the same hash, and a loop answering a different question each
  // iteration was declared stuck and failed.
  let n = 0;
  const getElements = () => {
    n++;
    // Same ids, same types, empty text — only the accessibility label changes, exactly
    // like consecutive questions of one kind.
    return n >= 7
      ? [makeEl({ idShort: 'results', id: 'app:id/results', type: 'View' })]
      : [
          makeEl({ id: 'app:id/choice', idShort: 'choice', type: 'ImageView', text: '', desc: `answer-${n}` }),
          makeEl({ id: 'app:id/question', idShort: 'question', type: 'View', text: '', desc: `question-${n}` }),
        ];
  };
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@results', cap: 10, body: [leaf('tap', ['@choice'])] }),
    deps({ exec, getElements }),
  );
  assert.equal(r.ok, true);
  assert.ok(calls.n >= 3, `loop should have kept answering, only ran ${calls.n} time(s)`);
});

test('runPlan: a genuinely unchanging screen is still detected as stalled', async () => {
  // The other side of the same coin — widening the fingerprint must not disable the guard.
  const calls = { n: 0 };
  const exec: ExecFn = async () => {
    calls.n++;
    return { code: 0 };
  };
  const r = await runPlan(
    plan({ type: 'repeat', selector: '@never', cap: 50, body: [leaf('swipe', ['up'])] }),
    deps({ exec, getElements: () => [makeEl({ id: 'app:id/row', text: 'row', desc: 'row' })] }),
  );
  assert.equal(r.ok, false);
  assert.ok(calls.n < 50, `should have bailed early, ran ${calls.n} of 50`);
});
