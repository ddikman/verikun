import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { actionNodes, instructionLines, lintPlan, looksTruncated, tailAnchors } from '../src/agent/lint';
import { resolveIncludes } from '../src/agent/include';
import { Plan, PlanNode } from '../src/agent/ir';

const leaf = (command: string, positionals: string[] = [], flags: { name: string; value: string }[] = []): PlanNode => ({
  type: 'command',
  command,
  positionals,
  flags,
});
const plan = (...steps: PlanNode[]): Plan => ({ version: 1, steps });

// --- fresh-start directive ------------------------------------------------------------
// Observed for real: the same prose compiled `launch <pkg> --clear` on one run and plain
// `launch <pkg>` on the next. The plan looked fine; the test failed several steps later on
// a screen that only appears when you are already logged in.

test('lintPlan: flags a cleared-data test whose plan launches without --clear', () => {
  const nl = 'Launch the `com.x` app **with its data cleared** so it starts logged-out.';
  const findings = lintPlan(nl, plan(leaf('launch', ['com.x'])));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /--clear/);
});

test('lintPlan: passes once the plan carries --clear', () => {
  const nl = 'Launch the `com.x` app with its data cleared so it starts logged-out.';
  const findings = lintPlan(nl, plan(leaf('launch', ['com.x'], [{ name: 'clear', value: 'true' }])));
  assert.deepEqual(findings, []);
});

test('lintPlan: does not fire on an unrelated use of the word "clear"', () => {
  // "--clear" on a text field is a completely different thing; a lint that fired here
  // would burn a recompile on every form-filling test.
  const nl = 'Type the email, clearing the field first, then tap Sign in.';
  assert.deepEqual(lintPlan(nl, plan(leaf('launch', ['com.x']))), []);
});

// --- conditional prose ----------------------------------------------------------------

test('lintPlan: flags conditional prose that compiled to an all-unconditional plan', () => {
  const nl = 'Tap Start. If a permission dialog appears, allow it. Then assert Home is visible.';
  const findings = lintPlan(nl, plan(leaf('tap', ['@start']), leaf('assert', ['text:Home'])));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /if-present/);
});

test('lintPlan: satisfied by a control node anywhere, including nested in a body', () => {
  const nl = 'Answer each question. If a Continue button appears, tap it.';
  const nested = plan({
    type: 'repeat',
    selector: 'text:Review',
    cap: 10,
    body: [{ type: 'when', branches: [{ selector: '@multi', body: [{ type: 'if-present', selector: '@cont', body: [leaf('tap', ['@cont'])] }] }] }],
  });
  assert.deepEqual(lintPlan(nl, nested), []);
});

test('lintPlan: stays quiet on prose with no directives to check', () => {
  const nl = 'Tap Start, then assert the Home tab is visible.';
  assert.deepEqual(lintPlan(nl, plan(leaf('tap', ['@start']))), []);
});

test('lintPlan: reports both findings at once', () => {
  const nl = 'Launch com.x with its data cleared. If a promo appears, dismiss it.';
  const findings = lintPlan(nl, plan(leaf('launch', ['com.x'])));
  assert.equal(findings.length, 2);
});

// --- coverage: only a PREFIX of the test compiled (issue #127) -------------------------
// A truncated compile is the one compiler failure that presents as a PASS: the short plan
// asserts nothing, so it fails nothing, and it is then cached green and replayed against
// every later build. Both rules below are `fatal` for that reason.

/** Prose in the shape these tests are really written in: a numbered list of steps.
 *  Identifiers are zero-padded so `row_01` is not a substring of `row_19` — matching is
 *  deliberately forgiving, and unpadded fixtures would cross-match by accident. */
const id = (i: number): string => `row_${String(i).padStart(2, '0')}`;
const numbered = (n: number): string =>
  Array.from({ length: n }, (_, i) => `${i + 1}. Tap the row (\`${id(i + 1)}\`).`).join('\n');

const taps = (n: number): PlanNode[] => Array.from({ length: n }, (_, i) => leaf('tap', [`@${id(i + 1)}`]));

test('lintPlan: rejects a plan that covers only the beginning of the test', () => {
  const findings = lintPlan(numbered(20), plan(...taps(2)));
  const fatal = findings.filter((f) => f.fatal);
  assert.equal(fatal.length, 2, 'both the length floor and the missing tail should fire');
  assert.match(fatal[0].message, /2 step\(s\).*about 20 instruction\(s\)/);
});

test('lintPlan: a plan that covers the whole test is clean', () => {
  assert.deepEqual(lintPlan(numbered(20), plan(...taps(20))), []);
});

test('lintPlan: 20% short is ordinary variation, not a truncation', () => {
  // The widest run-to-run variation measured between two PASSING compiles of the same test
  // was ~20%. The floor has to sit far below that or it rejects healthy plans. Note what
  // "shorter" means here: the SAME test expressed in fewer nodes — it still runs to the end.
  // A plan missing its last four steps is a truncation, not variation, and is caught below.
  const fewer = taps(20).filter((_, i) => i < 6 || i >= 10);
  assert.equal(fewer.length, 16);
  assert.deepEqual(lintPlan(numbered(20), plan(...fewer)), []);
});

test('lintPlan: screenshots do not count toward coverage', () => {
  // The grammar tells the model to insert screenshots liberally as review evidence. Counting
  // them would let a stub padded with 30 screenshots clear the floor.
  const padded = plan(...taps(2), ...Array.from({ length: 30 }, () => leaf('screenshot')));
  assert.ok(lintPlan(numbered(20), padded).some((f) => f.fatal));
});

test('lintPlan: a control node counts its body, not just itself', () => {
  // `plan.steps.length` is TOP-LEVEL only, so this plan reads as 1 step. Judging coverage on
  // that number would reject every plan built around one loop.
  const loop = plan({ type: 'repeat', selector: '@done', cap: 10, body: taps(20) });
  assert.deepEqual(lintPlan(numbered(20), loop), []);
});

test('lintPlan: too small a test for the ratio to mean anything stays quiet', () => {
  // One step for five stated instructions is a 0.2 ratio — well under the floor, if the floor
  // applied. It must not: a short test legitimately compiles to fewer steps than it has
  // sentences, and the absolute numbers are so small that a ratio says nothing.
  assert.deepEqual(lintPlan(numbered(5), plan(leaf('tap', [`@${id(5)}`]))), []);
  // One instruction more and the same plan IS judged — that is where the gate sits.
  assert.ok(lintPlan(numbered(6), plan(leaf('tap', [`@${id(6)}`]))).some((f) => f.fatal));
});

test('lintPlan: unordered bullets are explanation, and must not inflate the expectation', () => {
  // In this project's prose style `-` bullets carry rationale far more often than steps.
  // Counting them would raise the expected size and reject a correct plan.
  const nl = [
    '1. Tap the Login row (`vk_nav_login`).',
    '2. Confirm the login screen (`vk_login`) is showing.',
    '',
    'Some notes on why:',
    ...Array.from({ length: 30 }, (_, i) => `- the field is prefilled, reason ${i}`),
  ].join('\n');
  assert.deepEqual(lintPlan(nl, plan(leaf('tap', ['@vk_nav_login']), leaf('assert', ['@vk_login']))), []);
});

test('lintPlan: rejects a long preamble whose plan never reaches the test body', () => {
  // The reported shape: the shared sign-in preamble compiles fine and is long enough to clear
  // the length floor on its own, while the feature the test exists to exercise is dropped.
  const nl = [numbered(12), '13. Tap the Load button (`vk_load`).', '14. Confirm the spinner (`vk_spinner`) is gone.'].join('\n');
  const findings = lintPlan(nl, plan(...taps(12)));
  const fatal = findings.filter((f) => f.fatal);
  assert.equal(fatal.length, 1, 'the length floor is satisfied; only the missing tail catches this');
  assert.match(fatal[0].message, /vk_load|vk_spinner/);
});

test('lintPlan: the tail check matches an identifier the plan spells differently', () => {
  // Prose writes `vk_spinner`; the compiler may emit id:spinner, @spinner or text:Spinner for
  // the same element. Matching has to be forgiving in both directions or it rejects good plans.
  const nl = [numbered(12), '13. Confirm the spinner (`vk_spinner`) is gone.'].join('\n');
  for (const selector of ['id:spinner', '@vk_spinner', 'text:Spinner', 'id:com.x:id/vk_spinner']) {
    const p = plan(...taps(12), leaf('assert', [selector], [{ name: 'gone', value: 'true' }]));
    assert.deepEqual(lintPlan(nl, p), [], selector);
  }
});

test('tailAnchors: the package is not an anchor, and only the LAST named instructions are', () => {
  // `launch <pkg>` names the package in every plan there is, so counting it as coverage
  // would make the rule vacuous for any test that ends by naming its app.
  const nl = [numbered(12), '13. Stop the `dev.verikun.testapp` app.'].join('\n');
  const anchors = tailAnchors(nl, { version: 1, package: 'dev.verikun.testapp', steps: [] });
  assert.ok(!anchors.includes('dev.verikun.testapp'));
  // ...and having skipped that line as naming nothing matchable, it judges the two before it.
  assert.deepEqual(anchors, ['row_12', 'row_11']);
});

test('lintPlan: the tail window does not reach back into what the prefix still covers', () => {
  // The failure this rule exists for: a plan that stops part-way. A window wide enough to
  // include instructions the prefix DID cover finds a match there and stays quiet, while the
  // actual end of the test is missing.
  const nl = numbered(20);
  assert.ok(lintPlan(nl, plan(...taps(12))).some((f) => /row_19|row_20/.test(f.message)));
  // ...while a plan that DOES reach the end is clean, so the window is not simply always red.
  assert.deepEqual(lintPlan(nl, plan(...taps(20))), []);
});

test('lintPlan: the tail check stays silent when the prose names no identifier', () => {
  const nl = [numbered(12), '13. Go back to where you started.'].join('\n');
  assert.deepEqual(lintPlan(nl, plan(...taps(12))), []);
});

test('lintPlan: VERIKUN_NO_COMPILE_CHECK=1 restores the pre-#127 behaviour exactly', () => {
  const prev = process.env.VERIKUN_NO_COMPILE_CHECK;
  process.env.VERIKUN_NO_COMPILE_CHECK = '1';
  try {
    assert.deepEqual(lintPlan(numbered(20), plan(...taps(2))), []);
    // The other two rules are unaffected — the switch is for the coverage rules alone.
    const nl = 'Launch com.x with its data cleared.';
    assert.equal(lintPlan(nl, plan(leaf('launch', ['com.x']))).length, 1);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_COMPILE_CHECK;
    else process.env.VERIKUN_NO_COMPILE_CHECK = prev;
  }
});

test('actionNodes: counts control bodies, and never screenshots', () => {
  assert.equal(actionNodes(plan(leaf('tap'), leaf('screenshot'), leaf('assert'))), 2);
  assert.equal(actionNodes(plan({ type: 'repeat', selector: '@x', cap: 3, body: taps(4) })), 5, 'the node plus its body');
});

test('looksTruncated: reports the fatal half of the lint on its own', () => {
  assert.equal(looksTruncated(numbered(20), plan(...taps(2))), true);
  assert.equal(looksTruncated(numbered(20), plan(...taps(20))), false);
  // A non-fatal finding is not a truncation — it must not disqualify a seed.
  assert.equal(looksTruncated('Launch com.x with its data cleared.', plan(leaf('launch', ['com.x']))), false);
});

// --- the false-positive gate: this repo's OWN test prose ------------------------------
// A coverage rule that rejects a correct plan is a worse defect than the truncation it
// guards against, so it is pinned against real prose rather than only against fixtures.

test('lintPlan: the repo\'s own example tests read as real instructions', () => {
  for (const file of ['example/example-test.md', 'example/example-test-devicestate.md']) {
    const { nl } = resolveIncludes(file);
    const lines = instructionLines(nl);
    assert.ok(lines.length >= 8 && lines.length <= 40, `${file}: ${lines.length} instruction(s)`);

    // One step per stated instruction, addressing what that instruction names: the shape a
    // healthy compile of this prose has. It must be clean.
    const full = plan(...lines.map((l, i) => leaf('tap', [/`([^`]+)`/.exec(l)?.[1] ?? `@step_${i}`])));
    assert.deepEqual(lintPlan(nl, full), [], file);

    // ...and the same prose truncated to its first three steps must be caught.
    assert.equal(looksTruncated(nl, plan(...full.steps.slice(0, 3))), true, file);
  }
});
