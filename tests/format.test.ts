import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatInline, formatCompact, formatTree, toJsonShape } from '../src/ui/format';
import { makeEl } from './helpers';

test('formatInline: renders index, type, text, @id, center, and a tap flag', () => {
  const el = makeEl({
    index: 3,
    type: 'Button',
    text: 'Sign in',
    idShort: 'sign_in_btn',
    clickable: true,
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 100 },
  });
  assert.equal(formatInline(el), '[3] Button "Sign in" @sign_in_btn (540,50) tap');
});

test('formatInline: shows desc only when it is non-empty and differs from text', () => {
  const withDesc = makeEl({ desc: 'Close' });
  assert.equal(formatInline(withDesc), '[0] TextView desc="Close" (50,25)');

  const sameAsText = makeEl({ text: 'X', desc: 'X' });
  assert.ok(!formatInline(sameAsText).includes('desc='));
});

test('formatInline: emits the full flag set in order', () => {
  const el = makeEl({
    checkable: true,
    checked: true,
    focused: true,
    password: true,
    selected: true,
    enabled: false,
  });
  assert.ok(formatInline(el).endsWith('checked,focused,pwd,selected,disabled'));
});

test('formatInline: a checkable-but-unchecked element reads "unchecked"', () => {
  assert.ok(formatInline(makeEl({ checkable: true, checked: false })).includes('unchecked'));
});

test('formatInline: clips long text to 60 chars with an ellipsis', () => {
  const el = makeEl({ text: 'a'.repeat(70) });
  const clipped = 'a'.repeat(59) + '…';
  assert.equal(clipped.length, 60);
  assert.ok(formatInline(el).includes(`"${clipped}"`));
});

test('formatCompact: empty input is "(no elements)"', () => {
  assert.equal(formatCompact([]), '(no elements)');
});

test('formatCompact: joins each element on its own line', () => {
  const out = formatCompact([makeEl({ index: 0, text: 'A' }), makeEl({ index: 1, text: 'B' })]);
  assert.equal(out.split('\n').length, 2);
  assert.ok(out.includes('"A"') && out.includes('"B"'));
});

test('formatTree: indents by two spaces per depth level', () => {
  const el = makeEl({ depth: 2, text: 'Deep' });
  assert.ok(formatTree([el]).startsWith('    [0]')); // depth 2 -> 4 spaces
});

test('formatTree: empty input is "(no elements)"', () => {
  assert.equal(formatTree([]), '(no elements)');
});

// --- toJsonShape ----------------------------------------------------------

test('toJsonShape: omits empty strings and false flags, always keeps enabled', () => {
  const shape = toJsonShape(makeEl());
  assert.equal(shape.id, undefined);
  assert.equal(shape.text, undefined);
  assert.equal(shape.desc, undefined);
  assert.equal(shape.clickable, undefined);
  assert.equal(shape.checked, undefined);
  assert.equal(shape.enabled, true);
  // Undefined fields disappear under JSON serialization, keeping output compact.
  assert.ok(!('id' in JSON.parse(JSON.stringify(shape))));
});

test('toJsonShape: includes populated text/id and truthy flags', () => {
  const shape = toJsonShape(makeEl({ text: 'Hi', id: 'com.app:id/x', clickable: true }));
  assert.equal(shape.text, 'Hi');
  assert.equal(shape.id, 'com.app:id/x');
  assert.equal(shape.clickable, true);
});

test('toJsonShape: checked is reported (even when false) only for checkable elements', () => {
  assert.equal(toJsonShape(makeEl({ checkable: true, checked: false })).checked, false);
  assert.equal(toJsonShape(makeEl({ checkable: true, checked: true })).checked, true);
  assert.equal(toJsonShape(makeEl({ checkable: false })).checked, undefined);
});
