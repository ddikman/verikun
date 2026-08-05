import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseHierarchy, isInteresting, parseRotation } from '../src/ui/android-parse';
import { makeEl } from './helpers';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Hello &amp; World" resource-id="com.app:id/title" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" bounds="[100,200][980,300]" />
    <node index="1" text="" resource-id="com.app:id/login" class="android.widget.Button" content-desc="Log in" clickable="true" enabled="false" bounds="[100,400][980,500]" />
    <node index="2" text="" resource-id="" class="android.view.View" content-desc="" clickable="false" bounds="[0,600][1080,700]" />
  </node>
</hierarchy>`;

test('parseHierarchy: keeps only "interesting" nodes by default', () => {
  const els = parseHierarchy(XML);
  // The root FrameLayout and the empty View container are dropped; title + button stay.
  assert.equal(els.length, 2);
  assert.deepEqual(els.map((e) => e.type), ['TextView', 'Button']);
});

test('parseHierarchy: {all:true} keeps every node', () => {
  const els = parseHierarchy(XML, { all: true });
  assert.equal(els.length, 4);
});

test('parseHierarchy: decodes XML entities in text', () => {
  const [title] = parseHierarchy(XML);
  assert.equal(title.text, 'Hello & World');
});

test('parseHierarchy: parses bounds and computes the tap center', () => {
  const [title] = parseHierarchy(XML);
  assert.deepEqual(title.bounds, { x1: 100, y1: 200, x2: 980, y2: 300 });
  assert.deepEqual(title.center, { x: 540, y: 250 });
});

test('parseHierarchy: derives idShort, simplified type, and booleans', () => {
  const els = parseHierarchy(XML);
  const button = els[1];
  assert.equal(button.id, 'com.app:id/login');
  assert.equal(button.idShort, 'login');
  assert.equal(button.type, 'Button');
  assert.equal(button.clickable, true);
  assert.equal(button.enabled, false); // explicit enabled="false"
});

test('parseHierarchy: enabled defaults to true when the attribute is absent', () => {
  const els = parseHierarchy('<node class="X" bounds="[0,0][10,10]" text="hi" />');
  assert.equal(els[0].enabled, true);
});

test('parseHierarchy: reassigns a stable 0..n index over the produced list', () => {
  const els = parseHierarchy(XML);
  assert.deepEqual(els.map((e) => e.index), [0, 1]);
  const all = parseHierarchy(XML, { all: true });
  assert.deepEqual(all.map((e) => e.index), [0, 1, 2, 3]);
});

test('parseHierarchy: tracks nesting depth', () => {
  const all = parseHierarchy(XML, { all: true });
  assert.equal(all[0].depth, 0); // root FrameLayout
  assert.deepEqual(all.slice(1).map((e) => e.depth), [1, 1, 1]); // its children
});

test('parseHierarchy: decodes numeric and hex character references', () => {
  const els = parseHierarchy('<node class="T" bounds="[0,0][9,9]" text="A&#66;&#x43;" />');
  assert.equal(els[0].text, 'ABC');
});

test('parseHierarchy: a quote escaped to &quot; inside a value does not end the tag', () => {
  const els = parseHierarchy('<node class="T" bounds="[0,0][9,9]" text="say &quot;hi&quot;" />');
  assert.equal(els[0].text, 'say "hi"');
});

// --- rotation + off-screen marking ----------------------------------------

// A screen with a row scrolled below the fold and one hanging over the edge.
const SCROLLED_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.ScrollView" resource-id="com.app:id/feed" scrollable="true" bounds="[0,0][1080,2400]">
    <node index="0" text="Visible row" resource-id="com.app:id/row_1" class="android.widget.TextView" bounds="[0,100][1080,300]" />
    <node index="1" text="Half row" resource-id="com.app:id/row_2" class="android.widget.TextView" bounds="[0,2300][1080,2500]" />
    <node index="2" text="Below the fold" resource-id="com.app:id/row_3" class="android.widget.TextView" bounds="[0,3000][1080,3200]" />
  </node>
</hierarchy>`;

test('parseRotation: reads the hierarchy rotation, or undefined when absent', () => {
  assert.equal(parseRotation(SCROLLED_XML), 0);
  assert.equal(parseRotation('<hierarchy rotation="3"><node /></hierarchy>'), 3);
  assert.equal(parseRotation('<hierarchy><node /></hierarchy>'), undefined);
});

test('parseHierarchy: without a screen size nothing is marked off-screen', () => {
  // The safe degradation: a device whose size could not be read behaves exactly as
  // it did before viewport awareness existed.
  assert.ok(parseHierarchy(SCROLLED_XML).every((e) => e.offscreen === undefined));
});

test('parseHierarchy: marks only rows with no visible pixel', () => {
  const els = parseHierarchy(SCROLLED_XML, { screen: { width: 1080, height: 2400 } });
  const byId = (short: string) => els.find((e) => e.idShort === short);
  assert.equal(byId('row_1')?.offscreen, undefined, 'fully visible');
  assert.equal(byId('row_2')?.offscreen, undefined, 'straddles the bottom edge — still partly seen');
  assert.equal(byId('row_3')?.offscreen, true, 'entirely below the fold');
});

test('parseHierarchy: a landscape dump is read in landscape coordinates', () => {
  // `wm size` reports 1080x2400 whichever way up the device is. Without honouring
  // rotation, this row at x=1500 would be called off-screen and every tap on a
  // landscape app would start swiping.
  const xml = SCROLLED_XML.replace('rotation="0"', 'rotation="1"').replace(
    '[0,3000][1080,3200]',
    '[1500,100][2300,300]',
  );
  const els = parseHierarchy(xml, { screen: { width: 1080, height: 2400 } });
  assert.equal(els.find((e) => e.idShort === 'row_3')?.offscreen, undefined);
});

// --- isInteresting --------------------------------------------------------

test('isInteresting: zero-area nodes are never interesting', () => {
  assert.equal(isInteresting(makeEl({ text: 'hi', bounds: { x1: 5, y1: 5, x2: 5, y2: 5 } })), false);
});

test('isInteresting: text, desc, or id makes a node interesting', () => {
  assert.equal(isInteresting(makeEl({ text: 'hi' })), true);
  assert.equal(isInteresting(makeEl({ desc: 'label' })), true);
  assert.equal(isInteresting(makeEl({ id: 'com.app:id/x' })), true);
});

test('isInteresting: interactive flags make a node interesting', () => {
  assert.equal(isInteresting(makeEl({ clickable: true })), true);
  assert.equal(isInteresting(makeEl({ scrollable: true })), true);
  assert.equal(isInteresting(makeEl({ checkable: true })), true);
});

test('isInteresting: an editable class is interesting even when empty', () => {
  assert.equal(isInteresting(makeEl({ class: 'android.widget.EditText' })), true);
});

test('isInteresting: a bare layout container is not interesting', () => {
  assert.equal(isInteresting(makeEl({ class: 'android.widget.FrameLayout' })), false);
});
