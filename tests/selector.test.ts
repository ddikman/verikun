import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSelector, matchElements, resolveOne } from '../src/ui/selector';
import { CliError } from '../src/errors';
import { makeEl } from './helpers';

// --- parseSelector --------------------------------------------------------

test('parseSelector: @ shorthand is an id selector', () => {
  const sel = parseSelector('@login');
  assert.equal(sel.kind, 'id');
  assert.equal(sel.value, 'login');
});

test('parseSelector: explicit kind prefixes', () => {
  assert.equal(parseSelector('text:Hi').kind, 'text');
  assert.equal(parseSelector('desc:Submit').kind, 'desc');
  assert.equal(parseSelector('class:Button').kind, 'class');
  assert.equal(parseSelector('id:login').kind, 'id');
});

test('parseSelector: a bare string defaults to a text selector', () => {
  const sel = parseSelector('Sign in');
  assert.equal(sel.kind, 'text');
  assert.equal(sel.value, 'Sign in');
});

test('parseSelector: a value containing a colon after a known prefix keeps the tail', () => {
  const sel = parseSelector('id:com.app:id/login');
  assert.equal(sel.kind, 'id');
  assert.equal(sel.value, 'com.app:id/login');
});

test('parseSelector: an empty value throws CliError(2)', () => {
  assert.throws(() => parseSelector('@'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  assert.throws(() => parseSelector('text:'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

test('parseSelector: carries contains/index options', () => {
  const sel = parseSelector('x', { contains: true, index: 2 });
  assert.equal(sel.contains, true);
  assert.equal(sel.index, 2);
});

// --- matchElements: healing tiers ----------------------------------------

test('matchElements: exact tier wins (case-insensitive, trimmed)', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  const r = matchElements(els, parseSelector('text:sign up'));
  assert.equal(r.tier, 'exact');
  assert.equal(r.matches.length, 1);
});

test('matchElements: falls to partial (substring) when no exact match', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  const r = matchElements(els, parseSelector('text:Sign'));
  assert.equal(r.tier, 'partial');
  assert.equal(r.matches.length, 1);
});

test('matchElements: falls to normalized (punctuation/space-insensitive) last', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  const r = matchElements(els, parseSelector('text:signup'));
  assert.equal(r.tier, 'normalized');
  assert.equal(r.matches.length, 1);
});

test('matchElements: no match yields empty set and null tier', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  const r = matchElements(els, parseSelector('text:Logout'));
  assert.equal(r.tier, null);
  assert.equal(r.matches.length, 0);
});

test('matchElements: --contains drops the exact tier', () => {
  // The element text equals the selector exactly, but --contains forces substring,
  // so the documented behavior is to report the looser `partial` tier.
  const els = [makeEl({ text: 'Sign Up' })];
  const r = matchElements(els, parseSelector('Sign Up', { contains: true }));
  assert.equal(r.tier, 'partial');
  assert.equal(r.matches.length, 1);
});

test('matchElements: --index N picks the Nth match within the winning tier', () => {
  const els = [makeEl({ index: 0, text: 'Item' }), makeEl({ index: 1, text: 'Item' })];
  const first = matchElements(els, parseSelector('Item', { index: 0 }));
  const second = matchElements(els, parseSelector('Item', { index: 1 }));
  assert.equal(first.matches[0].index, 0);
  assert.equal(second.matches[0].index, 1);
});

test('matchElements: an out-of-range --index yields no match', () => {
  const els = [makeEl({ text: 'Item' })];
  const r = matchElements(els, parseSelector('Item', { index: 5 }));
  assert.equal(r.matches.length, 0);
  assert.equal(r.tier, null);
});

test('matchElements: text selector falls back to desc when no text matches', () => {
  const els = [makeEl({ text: '', desc: 'Close' })];
  const r = matchElements(els, parseSelector('text:Close'));
  assert.equal(r.matches.length, 1);
  assert.equal(r.tier, 'exact');
});

// --- matchElements: id and class kinds -----------------------------------

test('matchElements: id selector matches the short id, full id, or "/suffix"', () => {
  const els = [makeEl({ id: 'com.app:id/login', idShort: 'login' })];
  assert.equal(matchElements(els, parseSelector('@login')).matches.length, 1);
  assert.equal(matchElements(els, parseSelector('id:com.app:id/login')).matches.length, 1);
  assert.equal(matchElements(els, parseSelector('@log')).tier, 'partial');
});

test('matchElements: class selector matches the simple type or ".suffix"', () => {
  const els = [makeEl({ class: 'android.widget.Button', type: 'Button' })];
  assert.equal(matchElements(els, parseSelector('class:Button')).tier, 'exact');
  assert.equal(matchElements(els, parseSelector('class:android.widget.Button')).tier, 'exact');
  assert.equal(matchElements(els, parseSelector('class:widget')).tier, 'partial');
});

// --- resolveOne -----------------------------------------------------------

test('resolveOne: returns the single match and its tier', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  const { element, tier } = resolveOne(els, parseSelector('text:sign up'));
  assert.equal(element.text, 'Sign Up');
  assert.equal(tier, 'exact');
});

test('resolveOne: throws CliError(1) when nothing matches', () => {
  const els = [makeEl({ text: 'Sign Up' })];
  assert.throws(
    () => resolveOne(els, parseSelector('text:Nope')),
    (e: unknown) => e instanceof CliError && e.exitCode === 1,
  );
});

test('resolveOne: throws CliError(2) (ambiguous) when more than one matches', () => {
  const els = [makeEl({ text: 'Item' }), makeEl({ text: 'Item' })];
  assert.throws(
    () => resolveOne(els, parseSelector('Item')),
    (e: unknown) => e instanceof CliError && e.exitCode === 2 && /matched 2 elements/.test(e.message),
  );
});

// --- --enabled: "actionable right now", not merely present ---------------------------
// Evidenced by a real flow: a Check button is present from the moment the question
// renders but stays disabled until an option is picked. Tapping presence taps a dead
// control, the flow silently does nothing, and the failure surfaces several steps later
// as a timeout on whatever should have appeared next.

test('matchElements: --enabled skips a present-but-disabled control', () => {
  const els = [makeEl({ idShort: 'check', enabled: false, clickable: false })];
  assert.equal(matchElements(els, parseSelector('@check')).matches.length, 1);
  assert.equal(matchElements(els, parseSelector('@check', { enabled: true })).matches.length, 0);
});

test('matchElements: --enabled accepts it once it becomes actionable', () => {
  const els = [makeEl({ idShort: 'check', enabled: true, clickable: true })];
  assert.equal(matchElements(els, parseSelector('@check', { enabled: true })).matches.length, 1);
});

test('matchElements: --enabled keeps a non-clickable CONTAINER that is enabled', () => {
  // Regression guard. Requiring clickable here filtered out real tap targets — many are
  // containers whose tappable child is inside — which turned --enabled into a source of
  // phantom "not found" misses that then burned model repairs on a live device.
  const els = [makeEl({ idShort: 'submit', enabled: true, clickable: false })];
  assert.equal(matchElements(els, parseSelector('@submit', { enabled: true })).matches.length, 1);
});

test('matchElements: --enabled filters the pool BEFORE the tier ladder', () => {
  // A disabled EXACT match must not shadow an enabled PARTIAL one — otherwise the filter
  // would turn a resolvable tap into a miss rather than into the right element.
  const els = [
    makeEl({ idShort: 'submit', enabled: false, clickable: false }),
    makeEl({ idShort: 'submit_button', enabled: true, clickable: true }),
  ];
  const r = matchElements(els, parseSelector('@submit', { enabled: true }));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].idShort, 'submit_button');
  assert.equal(r.tier, 'partial');
});
