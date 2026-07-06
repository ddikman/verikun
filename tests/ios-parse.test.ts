import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseIosHierarchy, isInteresting } from '../src/ui/ios-parse';
import { makeEl } from './helpers';

// A representative `idb ui describe-all --json` payload: a flat list of elements.
const JSON_DUMP = JSON.stringify([
  { type: 'Window', role: 'AXWindow', AXLabel: '', frame: { x: 0, y: 0, width: 390, height: 844 }, enabled: true },
  {
    type: 'StaticText',
    role: 'AXStaticText',
    AXLabel: 'Hello & World',
    AXUniqueId: 'title',
    frame: { x: 20, y: 60, width: 200, height: 30 },
    enabled: true,
  },
  {
    type: 'Button',
    role: 'AXButton',
    AXLabel: 'Log in',
    AXUniqueId: 'auth/login',
    frame: { x: 20, y: 120, width: 350, height: 44 },
    enabled: false,
  },
  {
    type: 'SecureTextField',
    role: 'AXSecureTextField',
    AXLabel: 'Password',
    AXValue: 'secret',
    frame: { x: 20, y: 180, width: 350, height: 40 },
    enabled: true,
  },
  { type: 'Other', role: 'AXOther', AXLabel: '', frame: { x: 0, y: 300, width: 390, height: 100 }, enabled: true },
  {
    type: 'Switch',
    role: 'AXSwitch',
    AXLabel: 'Wifi',
    AXValue: '1',
    frame: { x: 20, y: 420, width: 80, height: 30 },
    enabled: true,
  },
]);

test('parseIosHierarchy: keeps only "interesting" nodes by default', () => {
  const els = parseIosHierarchy(JSON_DUMP);
  // The bare Window and Other containers are dropped; the rest stay.
  assert.deepEqual(
    els.map((e) => e.type),
    ['StaticText', 'Button', 'SecureTextField', 'Switch'],
  );
});

test('parseIosHierarchy: {all:true} keeps every node', () => {
  assert.equal(parseIosHierarchy(JSON_DUMP, { all: true }).length, 6);
});

test('parseIosHierarchy: label is kept verbatim (no XML-entity decoding)', () => {
  const [title] = parseIosHierarchy(JSON_DUMP);
  assert.equal(title.text, 'Hello & World');
});

test('parseIosHierarchy: maps frame to bounds and computes the tap center', () => {
  const [title] = parseIosHierarchy(JSON_DUMP);
  assert.deepEqual(title.bounds, { x1: 20, y1: 60, x2: 220, y2: 90 });
  assert.deepEqual(title.center, { x: 120, y: 75 });
});

test('parseIosHierarchy: derives idShort, class/type, and the clickable/enabled flags', () => {
  const button = parseIosHierarchy(JSON_DUMP)[1];
  assert.equal(button.id, 'auth/login');
  assert.equal(button.idShort, 'login');
  assert.equal(button.type, 'Button');
  assert.equal(button.class, 'AXButton');
  assert.equal(button.clickable, true);
  assert.equal(button.enabled, false); // explicit enabled: false
});

test('parseIosHierarchy: a SecureTextField is a password field labelled by AXLabel', () => {
  const field = parseIosHierarchy(JSON_DUMP)[2];
  assert.equal(field.type, 'SecureTextField');
  assert.equal(field.password, true);
  assert.equal(field.text, 'Password'); // label wins over the AXValue "secret"
});

test('parseIosHierarchy: a Switch is checkable and reads checked from AXValue', () => {
  const sw = parseIosHierarchy(JSON_DUMP)[3];
  assert.equal(sw.checkable, true);
  assert.equal(sw.checked, true); // AXValue "1"
});

test('parseIosHierarchy: falls back to AXValue for text when no label/title', () => {
  const els = parseIosHierarchy('[{"type":"StaticText","AXValue":"42%","frame":{"x":0,"y":0,"width":10,"height":10}}]');
  assert.equal(els[0].text, '42%');
});

test('parseIosHierarchy: parses the AXFrame string form when no frame object', () => {
  const els = parseIosHierarchy('[{"type":"Button","AXLabel":"Go","AXFrame":"{{10, 20}, {30, 40}}","enabled":true}]');
  assert.deepEqual(els[0].bounds, { x1: 10, y1: 20, x2: 40, y2: 60 });
});

test('parseIosHierarchy: enabled defaults to true when the field is absent', () => {
  const els = parseIosHierarchy('[{"type":"StaticText","AXLabel":"hi","frame":{"x":0,"y":0,"width":9,"height":9}}]');
  assert.equal(els[0].enabled, true);
});

test('parseIosHierarchy: reassigns a stable 0..n index and a flat depth', () => {
  const els = parseIosHierarchy(JSON_DUMP);
  assert.deepEqual(
    els.map((e) => e.index),
    [0, 1, 2, 3],
  );
  // idb's hierarchy is a flat list — every node reports depth 0.
  assert.ok(parseIosHierarchy(JSON_DUMP, { all: true }).every((e) => e.depth === 0));
});

test('parseIosHierarchy: tolerates NDJSON and skips malformed lines', () => {
  const nd =
    '{"type":"Button","AXLabel":"A","frame":{"x":0,"y":0,"width":9,"height":9}}\n' +
    'not json\n' +
    '{"type":"Button","AXLabel":"B","frame":{"x":0,"y":0,"width":9,"height":9}}';
  const els = parseIosHierarchy(nd);
  assert.deepEqual(
    els.map((e) => e.text),
    ['A', 'B'],
  );
});

test('parseIosHierarchy: empty or non-JSON input yields no elements', () => {
  assert.deepEqual(parseIosHierarchy(''), []);
  assert.deepEqual(parseIosHierarchy('garbage'), []);
});

// --- isInteresting --------------------------------------------------------

test('isInteresting: zero-area nodes are never interesting', () => {
  assert.equal(isInteresting(makeEl({ type: 'StaticText', text: 'hi', bounds: { x1: 5, y1: 5, x2: 5, y2: 5 } })), false);
});

test('isInteresting: text, desc, or id makes a node interesting', () => {
  assert.equal(isInteresting(makeEl({ type: 'Other', text: 'hi' })), true);
  assert.equal(isInteresting(makeEl({ type: 'Other', desc: 'a hint' })), true);
  assert.equal(isInteresting(makeEl({ type: 'Other', id: 'login' })), true);
});

test('isInteresting: interactive flags make a node interesting', () => {
  assert.equal(isInteresting(makeEl({ type: 'Other', clickable: true })), true);
  assert.equal(isInteresting(makeEl({ type: 'Other', scrollable: true })), true);
  assert.equal(isInteresting(makeEl({ type: 'Other', checkable: true })), true);
});

test('isInteresting: a text-input type is interesting even when empty', () => {
  assert.equal(isInteresting(makeEl({ type: 'SecureTextField' })), true);
});

test('isInteresting: a bare container is not interesting', () => {
  assert.equal(isInteresting(makeEl({ type: 'Other', class: 'AXOther' })), false);
});
