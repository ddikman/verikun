import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { lintPlan } from '../src/agent/lint';
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
