import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  attributeField,
  beforeText,
  deletesFor,
  isMaskedValue,
  judgeReadBack,
  normalizeTyped,
  notLandedMessage,
  retryPlan,
  sameScreen,
  valueLanded,
} from '../src/ui/field-check';
import type { Element } from '../src/types';
import { makeEl } from './helpers';

// The judgement half of `vk text`'s read-back (#151). Every "cannot tell" must come out as
// UNVERIFIED rather than a miss: a miss fails the step, so a misjudged one is a new red.

const EDIT = 'android.widget.EditText';
const field = (o: Partial<Element> = {}): Element =>
  makeEl({ index: 2, class: EDIT, id: 'app:id/email', idShort: 'email', bounds: { x1: 40, y1: 400, x2: 1040, y2: 540 }, ...o });
const title = makeEl({ index: 0, text: 'Sign in', bounds: { x1: 40, y1: 100, x2: 600, y2: 180 } });
const submit = makeEl({ index: 3, id: 'app:id/submit', idShort: 'submit', text: 'Continue', clickable: true, bounds: { x1: 40, y1: 700, x2: 1040, y2: 820 } });
const screen = (f: Element): Element[] => [title, f, submit];

test('normalizeTyped: keeps letters and digits of every script, drops case, space and punctuation', () => {
  assert.equal(normalizeTyped('Bob+Tag@Mail.com'), 'bobtagmailcom');
  assert.equal(normalizeTyped('あいう'), 'あいう'); // the selector's `strip` would erase these
  assert.equal(normalizeTyped('Café'), 'café');
  assert.equal(normalizeTyped('ＡＢＣ１２'), 'abc12'); // full-width folds via NFKC
  assert.equal(normalizeTyped('(555) 123-4567'), '5551234567');
});

test('valueLanded: an empty or --clear field must hold exactly the value', () => {
  const exact = (after: string, value: string) => valueLanded({ before: '', after, value, clear: false });
  assert.equal(exact('someone@example.com', 'someone@example.com'), true);
  assert.equal(exact('', 'someone@example.com'), false, 'nothing landed (#151)');
  assert.equal(exact('omeone@example.com', 'someone@example.com'), false, 'a dropped first character');
  assert.equal(exact('someone@example.comm', 'someone@example.com'), false, 'a doubled last character (#46)');
  assert.equal(exact('(555) 123-4567', '5551234567'), true, 'a phone mask only adds punctuation');
  assert.equal(exact('Hello', 'hello'), true, 'auto-capitalisation');
  assert.equal(exact('$1,234.00', '1234'), false, 'a currency formatter changes the digits — the accepted red');
  assert.equal(exact('', 'あいう'), false, 'non-ASCII that never typed (#85) is not "equal" to an empty field');
  assert.equal(exact('あいう', 'あいう'), true);
  assert.equal(exact('', '👍'), false, 'an all-emoji value compares raw, not as an empty string');
  assert.equal(exact('👍', '👍'), true);

  const clear = (before: string, after: string, value: string) => valueLanded({ before, after, value, clear: true });
  assert.equal(clear('old@example.com', 'new@example.com', 'new@example.com'), true);
  assert.equal(clear('old@example.com', 'old@example.comnew@example.com', 'new@example.com'), false, 'the clear did not happen');
  assert.equal(clear('same', 'same', 'same'), true, 're-entering the value a field already holds');
});

test('valueLanded: typing into a field that held text must change it and leave the value in it', () => {
  const append = (before: string, after: string, value: string) => valueLanded({ before, after, value, clear: false });
  assert.equal(append('Hello', 'Hello world', ' world'), true);
  assert.equal(append('Hello', 'Hel worldlo', ' world'), true, 'the cursor was mid-text');
  assert.equal(append('Hello', 'Hello', 'world'), false, 'nothing landed');
  assert.equal(append('Search', 'Search', 'search'), false, 'a native field still showing a hint that contains the value');
  assert.equal(append('abc', 'abcdd', 'd'), true, 'a doubled character is not caught when appending');
  assert.equal(valueLanded({ before: 'x', after: 'x', value: '', clear: false }), true, 'an empty value is never checked');
});

test('isMaskedValue: bullets and asterisks only', () => {
  assert.equal(isMaskedValue('••••••'), true);
  assert.equal(isMaskedValue('●●●'), true);
  assert.equal(isMaskedValue('****'), true);
  assert.equal(isMaskedValue(''), false);
  assert.equal(isMaskedValue('pa••'), false);
});

test('beforeText: reads the input inside a wrapper target, else the target itself', () => {
  const wrapper = makeEl({ index: 1, id: 'app:id/email_layout', bounds: { x1: 0, y1: 380, x2: 1080, y2: 560 } });
  const inner = field({ id: '', idShort: '', text: 'old@example.com' });
  assert.equal(beforeText([title, wrapper, inner], wrapper), 'old@example.com');
  assert.equal(beforeText(screen(field({ text: 'x' })), field({ text: 'x' })), 'x');
  const two = [wrapper, inner, field({ index: 4, id: '', text: 'other', bounds: { x1: 40, y1: 400, x2: 500, y2: 540 } })];
  assert.equal(beforeText(two, wrapper), '', 'two inputs inside it: no guess');
});

test('sameScreen: half the anchors must survive; an anchorless screen never counts as the same', () => {
  assert.equal(sameScreen(screen(field()), screen(field({ text: 'typed' }))), true);
  const next = [makeEl({ text: 'Enter the code' }), makeEl({ id: 'app:id/otp' })];
  assert.equal(sameScreen(screen(field()), next), false);
  assert.equal(sameScreen([makeEl({ class: EDIT })], [makeEl({ class: EDIT })]), false);
});

test('attributeField: the focused field, tied to the target by id or by place on the same screen', () => {
  const target = field();
  // The keyboard opened and the layout moved the field: the id still ties it.
  const moved = field({ focused: true, text: 'v', bounds: { x1: 40, y1: 90, x2: 1040, y2: 230 } });
  assert.equal(attributeField([title, moved, submit], target, screen(target)), moved);

  // A wrapper target: the focused input inside it.
  const wrapper = makeEl({ index: 1, id: 'app:id/email_layout', bounds: { x1: 0, y1: 380, x2: 1080, y2: 560 } });
  const inner = field({ id: '', idShort: '', focused: true });
  assert.equal(attributeField([title, wrapper, inner, submit], wrapper, [title, wrapper, field({ id: '' }), submit]), inner);

  // OTP boxes: focus advanced to the next box, which is not ours to judge.
  const box1 = makeEl({ index: 1, class: EDIT, bounds: { x1: 0, y1: 400, x2: 150, y2: 540 } });
  const box6 = makeEl({ index: 6, class: EDIT, text: '6', focused: true, bounds: { x1: 750, y1: 400, x2: 900, y2: 540 } });
  assert.equal(attributeField([title, { ...box1, text: '1' }, box6], box1, [title, box1]), null);

  // No id, and the screen changed under it (a form that submitted to one with a field in the same place).
  const idless = field({ id: '', idShort: '' });
  const elsewhere = [makeEl({ text: 'Welcome' }), field({ id: '', idShort: '', focused: true })];
  assert.equal(attributeField(elsewhere, idless, screen(idless)), null);

  // An id is the identity: a different field in the same place (a form that submitted onto a
  // same-layout screen) is not the one typed into, even while the screen still looks the same.
  const impostor = field({ id: 'app:id/confirm', idShort: 'confirm', focused: true });
  assert.equal(attributeField([title, impostor, submit], target, screen(target)), null);

  assert.equal(attributeField([], target, screen(target)), null);
});

test('attributeField: with nothing focused, only the unique input carrying the target id', () => {
  const target = field();
  const after = field({ text: 'v' });
  assert.equal(attributeField(screen(after), target, screen(target)), after);
  assert.equal(attributeField(screen(field({ id: '' })), field({ id: '' }), screen(field({ id: '' }))), null);
});

test('judgeReadBack: password and masked fields are unverified, never a miss', () => {
  const target = field();
  const entry = { target, elements: screen(target), before: '', value: 'hunter2', clear: false };
  assert.deepEqual(judgeReadBack(screen(field({ focused: true, password: true })), entry), {
    verdict: 'unverified',
    why: 'it is a password field',
    password: true,
  });
  assert.equal(judgeReadBack(screen(field({ focused: true, text: '•••••••' })), entry).verdict, 'unverified');
  assert.equal(judgeReadBack(screen(field({ focused: true, text: 'hunter2' })), entry).verdict, 'landed');
  const miss = judgeReadBack(screen(field({ focused: true, text: '' })), entry);
  assert.equal(miss.verdict, 'missing');
});

test('retryPlan + deletesFor: retype only from a state that can be put back', () => {
  assert.equal(retryPlan({ before: 'Hello', after: 'Hello', clear: false }), 'redo', 'nothing landed');
  assert.equal(retryPlan({ before: '', after: 'omeone', clear: false }), 'clear-retype');
  assert.equal(retryPlan({ before: 'old', after: 'oldne', clear: true }), 'clear-retype');
  assert.equal(retryPlan({ before: 'Hello', after: 'Hello wor', clear: false }), 'none', "the user's text is mixed in");

  const t = { before: 'old', after: 'oldne', value: 'new', clear: true };
  assert.equal(deletesFor('first', t), 5, 'what --clear always deleted: len + 2');
  assert.equal(deletesFor('redo', t), 5);
  assert.equal(deletesFor('clear-retype', t), 8, 'the larger of what is there and what could be, + 2');
  assert.equal(deletesFor('first', { ...t, clear: false }), 0);
});

test('notLandedMessage: line 1 never carries the value or the field contents', () => {
  const msg = notLandedMessage('@vk_user', 'hunter', 'hunter2', true);
  const [first, ...rest] = msg.split('\n');
  assert.doesNotMatch(first, /hunter/);
  assert.match(first, /'@vk_user'/);
  assert.match(rest.join('\n'), /reads "hunter"/);
  assert.doesNotMatch(msg, /non-ASCII/);
  assert.match(notLandedMessage('@x', '', 'あいう', true), /non-ASCII/);
  assert.match(notLandedMessage('@x', 'ab', 'c', false), /not retyped/);
});
