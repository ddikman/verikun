import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { ENTRY_TIMING, EntryTiming, TextEntry, enterText } from '../src/commands/text-entry';
import type { Ctx } from '../src/commands/context';
import { CliError, SelectorNotFoundError } from '../src/errors';
import { setErrSink } from '../src/output';
import type { Recorder } from '../src/run';
import type { Element, Platform } from '../src/types';
import { makeDriver, makeEl } from './helpers';

// `vk text`'s orchestration (#151), against a driver that records every call and serves
// scripted reads. What is pinned is the CALL SEQUENCE: whether the field is tapped, what is
// typed, how often, and what the step ends as.

const FAST: EntryTiming = { ...ENTRY_TIMING, tapSettleMs: 0, clearSettleMs: 0, verifyMinMs: 0, verifyPollMs: 1, verifyMaxMs: 50, retapSettleMs: 0 };

const EDIT = 'android.widget.EditText';
const title = makeEl({ index: 0, text: 'Sign in', bounds: { x1: 40, y1: 100, x2: 600, y2: 180 } });
const field = (o: Partial<Element> = {}): Element =>
  makeEl({ index: 1, class: EDIT, id: 'app:id/email', idShort: 'email', bounds: { x1: 40, y1: 400, x2: 1040, y2: 540 }, ...o });
/** The screen after typing: the field focused and holding `text`. */
const after = (text: string, o: Partial<Element> = {}): Element[] => [title, field({ focused: true, text, ...o })];

interface Rig {
  ctx: Ctx;
  calls: string[];
  notes: string[];
  reads: () => number;
}

/** A ctx whose driver logs calls and serves `snapshots` in order (repeating the last). A
 *  snapshot of `'throw'` makes that read fail. */
function rig(snapshots: (Element[] | 'throw')[], platform: Platform = 'android'): Rig {
  const calls: string[] = [];
  const notes: string[] = [];
  let i = 0;
  const driver = makeDriver({
    platform,
    tap: (x, y) => void calls.push(`tap ${x},${y}`),
    inputText: (t) => void calls.push(`text ${JSON.stringify(t)}`),
    pressKey: (k) => void calls.push(`key ${k}`),
    getElements: () => {
      const s = snapshots[Math.min(i++, snapshots.length - 1)];
      if (s === 'throw') throw new Error('dump failed');
      return s;
    },
  });
  const record = { note: (n: { message?: string }) => void (n.message && notes.push(n.message)) } as unknown as Recorder;
  return { ctx: { driver, platform, positionals: [], flags: {}, record }, calls, notes, reads: () => i };
}

function entry(o: Partial<TextEntry> = {}): TextEntry {
  const target = o.target ?? field();
  return { selector: '@email', target, elements: [title, target], point: target.center, value: 'me@example.com', clear: false, ...o };
}

const TYPE = (v: string) => ['text " "', 'key backspace', `text ${JSON.stringify(v)}`];
const TAP = `tap ${field().center.x},${field().center.y}`;

let stderr: string[] = [];
setErrSink((l) => void stderr.push(l));
afterEach(() => {
  stderr = [];
});

test('happy path: tap, prime, type, one read that holds the value', async () => {
  const r = rig([after('me@example.com')]);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(r.calls, [TAP, ...TYPE('me@example.com')]);
  assert.deepEqual(out, { verified: true, retried: false });
  assert.equal(r.reads(), 1);
});

test('#151: a field that already has focus is not tapped again', async () => {
  const r = rig([after('me@example.com')]);
  await enterText(r.ctx, entry({ target: field({ focused: true }) }), FAST);
  assert.deepEqual(r.calls, TYPE('me@example.com'));
});

test('focus on something that is not an input still taps', async () => {
  const button = makeEl({ index: 1, class: 'android.widget.Button', id: 'app:id/email', focused: true, bounds: field().bounds });
  const r = rig([after('me@example.com')]);
  await enterText(r.ctx, entry({ target: button }), FAST);
  assert.equal(r.calls[0], TAP);
});

test('#151: nothing landed → one re-tap and a retype, then it passes', async () => {
  const r = rig([after(''), after(''), after(''), after('me@example.com')]);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(r.calls, [TAP, ...TYPE('me@example.com'), TAP, ...TYPE('me@example.com')]);
  assert.deepEqual(out, { verified: true, retried: true });
  assert.ok(stderr.some((l) => /did not land — retyping it once/.test(l)));
  assert.ok(!stderr.some((l) => l.includes('me@example.com')), 'the note carries no value');
});

test('a read that trails the keys is not a miss: no retype', async () => {
  const r = rig([after(''), after('me@example.com')]);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(r.calls, [TAP, ...TYPE('me@example.com')]);
  assert.deepEqual(out, { verified: true, retried: false });
});

test('a value that shows up after the re-tap is not typed twice', async () => {
  const r = rig([after(''), after(''), after('me@example.com')]);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(r.calls, [TAP, ...TYPE('me@example.com'), TAP]);
  assert.deepEqual(out, { verified: true, retried: false });
});

test('a partial value in an empty field is cleared before the retype', async () => {
  const r = rig([after('e@example.com'), after('e@example.com'), after('e@example.com'), after('me@example.com')]);
  await enterText(r.ctx, entry(), FAST);
  const deletes = 'me@example.com'.length + 2;
  assert.deepEqual(r.calls, [
    TAP,
    ...TYPE('me@example.com'),
    TAP,
    'key move_end',
    ...Array(deletes).fill('key del'),
    ...TYPE('me@example.com'),
  ]);
});

test('still missing after the retry → exit 1, terminal (not a selector error), value off line 1', async () => {
  const r = rig([after('')]);
  await assert.rejects(enterText(r.ctx, entry({ value: 'hunter2x' }), FAST), (e: unknown) => {
    assert.ok(e instanceof CliError);
    assert.equal(e.exitCode, 1);
    assert.ok(!(e instanceof SelectorNotFoundError), 'a repair would flip the step green');
    const [first] = e.message.split('\n');
    assert.doesNotMatch(first, /hunter2x/);
    assert.match(first, /did not land/);
    return true;
  });
  assert.equal(r.notes.length, 1, 'the step is re-noted with the failure');
  assert.match(r.notes[0], /did not land/);
});

test('text the user already had, mixed with part of the value: fail without retyping', async () => {
  const target = field({ text: 'Hello' });
  const r = rig([after('Hello wor')]);
  await assert.rejects(enterText(r.ctx, entry({ target, elements: [title, target], value: ' world' }), FAST), /not retyped/);
  assert.equal(r.calls.filter((c) => c === 'text " world"').length, 1, 'typed once only');
});

test('reads that fail prove nothing: the step passes unverified', async () => {
  const r = rig(['throw']);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(out, { verified: false, retried: false });
  assert.deepEqual(r.calls, [TAP, ...TYPE('me@example.com')]);
  assert.ok(stderr.some((l) => /could not check/.test(l)));
});

test('focus moved elsewhere (OTP auto-advance) passes unverified', async () => {
  const next = makeEl({ index: 5, class: EDIT, focused: true, text: 'x', bounds: { x1: 40, y1: 900, x2: 1040, y2: 1040 } });
  const r = rig([[title, field({ text: 'm' }), next]]);
  const out = await enterText(r.ctx, entry(), FAST);
  assert.deepEqual(out, { verified: false, retried: false });
});

test('a password target is never read back', async () => {
  const r = rig(['throw']);
  const out = await enterText(r.ctx, entry({ target: field({ password: true }) }), FAST);
  assert.equal(r.reads(), 0);
  assert.deepEqual(out, { verified: false, retried: false });
});

test('a wrapper whose input turns out to be a password re-notes the step redacted', async () => {
  const wrapper = makeEl({ index: 1, id: 'app:id/pass_layout', bounds: { x1: 0, y1: 380, x2: 1080, y2: 560 } });
  const inner = makeEl({ index: 2, class: EDIT, focused: true, password: true, bounds: { x1: 40, y1: 400, x2: 1040, y2: 540 } });
  const r = rig([[title, wrapper, inner]]);
  await enterText(r.ctx, entry({ target: wrapper, elements: [title, wrapper, { ...inner, focused: false }] }), FAST);
  assert.deepEqual(r.notes, ['typed «redacted»']);
});

test('--clear deletes what the field held, then must end up holding exactly the value', async () => {
  const target = field({ text: 'old' });
  const r = rig([after('new')]);
  await enterText(r.ctx, entry({ target, elements: [title, target], value: 'new', clear: true }), FAST);
  assert.deepEqual(r.calls, [TAP, 'key move_end', 'key del', 'key del', 'key del', 'key del', 'key del', ...TYPE('new')]);
});

test('iOS: exactly the old sequence, and no read (its `text` is the label)', async () => {
  const target = field({ text: 'Email', class: 'TextField' });
  const r = rig(['throw'], 'ios');
  const out = await enterText(r.ctx, entry({ target, elements: [target], clear: true }), FAST);
  assert.deepEqual(r.calls, [
    `tap ${target.center.x},${target.center.y}`,
    'key move_end',
    ...Array('Email'.length + 2).fill('key del'),
    ...TYPE('me@example.com'),
  ]);
  assert.equal(r.reads(), 0);
  assert.deepEqual(out, { verified: false, retried: false });
});
