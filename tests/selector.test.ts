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

test('matchElements: an out-of-range --index on the text tier does not fall back to desc', () => {
  // The text tier hits once, so index 1 is out of range there — and that is a definite
  // (empty) answer. The desc tier has two hits, so falling through to it would wrongly
  // return the third element.
  const els = [
    makeEl({ text: 'Item', desc: '' }),
    makeEl({ text: '', desc: 'Item' }),
    makeEl({ text: '', desc: 'Item' }),
  ];
  const r = matchElements(els, parseSelector('Item', { index: 1 }));
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

// --- state modifiers: selected / checked / focused, in both polarities ----------------
// The negative form is the load-bearing half. A segmented control whose options share one
// handler FLIPS on any tap, so "tap the option I want" lands on the other one whenever it
// was already chosen — exit 0, no heal, and the run exercises the opposite mode. Measured
// on the fixture's @vk_state screen; see example/flutter-app/README.md fact 15.

test('matchElements: --selected keeps only the current option', () => {
  const els = [
    makeEl({ idShort: 'mode_photo', selected: false }),
    makeEl({ idShort: 'mode_video', selected: true }),
  ];
  const r = matchElements(els, parseSelector('@mode', { selected: true }));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].idShort, 'mode_video');
});

test('matchElements: --not-selected is the guard form, not the absence of --selected', () => {
  const els = [makeEl({ idShort: 'mode_video', selected: true })];
  assert.equal(matchElements(els, parseSelector('@mode_video')).matches.length, 1);
  assert.equal(matchElements(els, parseSelector('@mode_video', { selected: false })).matches.length, 0);
});

test('matchElements: an UNSET state attribute means "do not care", not false', () => {
  // The trap this pins: flagBool() returns false for an absent flag, so passing it
  // straight through would turn every selector into "must be unselected/unchecked".
  const els = [makeEl({ idShort: 'mode_video', selected: true, checked: true, focused: true })];
  assert.equal(matchElements(els, parseSelector('@mode_video')).matches.length, 1);
});

test('matchElements: --checked and --not-checked both work off the raw attribute', () => {
  const on = [makeEl({ idShort: 'remember', checkable: true, checked: true })];
  const off = [makeEl({ idShort: 'remember', checkable: true, checked: false })];
  assert.equal(matchElements(on, parseSelector('@remember', { checked: true })).matches.length, 1);
  assert.equal(matchElements(on, parseSelector('@remember', { checked: false })).matches.length, 0);
  assert.equal(matchElements(off, parseSelector('@remember', { checked: false })).matches.length, 1);
});

test('matchElements: --not-checked does NOT also require checkable', () => {
  // Deliberate under-filtering, same lesson as --enabled and clickable: an extra conjunct
  // the platform reports unreliably turns the modifier into phantom "not found" misses.
  const els = [makeEl({ idShort: 'row', checkable: false, checked: false })];
  assert.equal(matchElements(els, parseSelector('@row', { checked: false })).matches.length, 1);
});

test('matchElements: --focused picks the field that holds input focus', () => {
  const els = [
    makeEl({ idShort: 'user', focused: false }),
    makeEl({ idShort: 'pass', focused: true }),
  ];
  assert.equal(matchElements(els, parseSelector('@user', { focused: true })).matches.length, 0);
  const r = matchElements(els, parseSelector('@pass', { focused: true }));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].idShort, 'pass');
});

test('matchElements: state modifiers combine (all must hold)', () => {
  const els = [
    makeEl({ idShort: 'opt_a', selected: true, enabled: false }),
    makeEl({ idShort: 'opt_b', selected: true, enabled: true }),
  ];
  const r = matchElements(els, parseSelector('@opt', { selected: true, enabled: true }));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].idShort, 'opt_b');
});

test('matchElements: a state filter applies BEFORE the tier ladder', () => {
  // Same property --enabled has: a selected EXACT match must not shadow an unselected
  // PARTIAL one, or the guard turns a resolvable tap into a miss.
  const els = [
    makeEl({ idShort: 'mode', selected: true }),
    makeEl({ idShort: 'mode_photo', selected: false }),
  ];
  const r = matchElements(els, parseSelector('@mode', { selected: false }));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].idShort, 'mode_photo');
  assert.equal(r.tier, 'partial');
});

// --- state modifiers embedded in the selector STRING ---------------------------------
// A control node (if-present / when / repeat / while-present / read) holds a bare
// `selector: string` with nowhere to put a flag — and guards are exactly where the
// toggle case needs one. So the string carries them.

test('parseSelector: strips a trailing state modifier off the selector string', () => {
  const sel = parseSelector('id:mode_video --not-selected');
  assert.equal(sel.kind, 'id');
  assert.equal(sel.value, 'mode_video');
  assert.equal(sel.selected, false);
});

test('parseSelector: keeps the ORIGINAL string in raw, modifiers included', () => {
  // What error messages, heal notes and the run report echo back — a candidate list that
  // dropped the modifier would misreport why a selector matched nothing.
  const sel = parseSelector('@mode_video --selected');
  assert.equal(sel.raw, '@mode_video --selected');
  assert.equal(sel.value, 'mode_video');
});

test('parseSelector: strips several stacked modifiers', () => {
  const sel = parseSelector('@submit --enabled --not-selected');
  assert.equal(sel.value, 'submit');
  assert.equal(sel.enabled, true);
  assert.equal(sel.selected, false);
});

test('parseSelector: only strips at the END, and only after whitespace', () => {
  // A value that merely CONTAINS the token stays a value — otherwise a legitimate label
  // could be silently truncated into a different selector.
  assert.equal(parseSelector('text:--selected').value, '--selected');
  assert.equal(parseSelector('text:a --selected b').value, 'a --selected b');
});

test('parseSelector: a contradictory string is a usage error, never a guess', () => {
  assert.throws(
    () => parseSelector('@x --selected --not-selected'),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});

test('parseSelector: an explicit option beats one embedded in the string', () => {
  const sel = parseSelector('@x --not-selected', { selected: true });
  assert.equal(sel.selected, true);
});

test('parseSelector: stripping the modifiers must leave a real value', () => {
  assert.throws(
    () => parseSelector('@ --selected'),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});
