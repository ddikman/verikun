import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSelector } from '../src/ui/selector';
import { assertStateSupported, unsupportedStateAttrs } from '../src/ui/state-support';
import { CliError } from '../src/errors';

// A state modifier the platform cannot populate does not fail — it narrows the pool to
// zero, burns the whole auto-wait window, and reports "No element matched selector",
// which is a claim about the screen that is not true. That is the same false signal the
// modifier exists to prevent, so it is refused instead.
//
// Measured on the fixture's @vk_state screen (iPhone 17 Pro simulator): a selected and an
// unselected segment came back identical apart from label and frame, and `idb ui
// describe-all --json` has no `selected` or `focused` key in its schema at all.

test('unsupportedStateAttrs: android reports every state attribute', () => {
  const sel = parseSelector('@x', { enabled: true, selected: true, checked: true, focused: true });
  assert.deepEqual(unsupportedStateAttrs(sel, 'android'), []);
});

test('unsupportedStateAttrs: ios cannot report selected or focused', () => {
  assert.deepEqual(unsupportedStateAttrs(parseSelector('@x', { selected: true }), 'ios'), ['selected']);
  assert.deepEqual(unsupportedStateAttrs(parseSelector('@x', { focused: false }), 'ios'), ['focused']);
});

test('unsupportedStateAttrs: ios DOES report enabled and checked', () => {
  // enabled is a raw idb key; checked is derived from type + AXValue, and @vk_remember
  // reports it correctly on the simulator. Only the structurally-absent ones are refused.
  const sel = parseSelector('@x', { enabled: true, checked: false });
  assert.deepEqual(unsupportedStateAttrs(sel, 'ios'), []);
});

test('unsupportedStateAttrs: an unpinned attribute is not flagged', () => {
  assert.deepEqual(unsupportedStateAttrs(parseSelector('@x'), 'ios'), []);
});

test('assertStateSupported: refusal is an ENVIRONMENT error (exit 3), not a usage error', () => {
  // Exit 3 the way clearApp/currentApp already refuse on iOS: the plan is fine, the
  // platform cannot run it. Exit 2 would read as "you typed it wrong".
  assert.throws(
    () => assertStateSupported(parseSelector('@x', { selected: true }), 'ios'),
    (e: unknown) => e instanceof CliError && e.exitCode === 3,
  );
});

test('assertStateSupported: the message names both polarities of the flag', () => {
  // --not-selected is refused for the same reason as --selected; naming only the
  // attribute reads as though the wrong flag was typed.
  assert.throws(
    () => assertStateSupported(parseSelector('@x --not-selected'), 'ios'),
    (e: unknown) => e instanceof CliError && /--selected\/--not-selected/.test(e.message),
  );
});

test('assertStateSupported: a supported selector passes through', () => {
  assertStateSupported(parseSelector('@x --checked'), 'ios');
  assertStateSupported(parseSelector('@x --not-selected'), 'android');
});
