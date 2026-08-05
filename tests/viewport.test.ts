import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  clipRegion,
  isFullyVisible,
  isOccluded,
  isOffscreen,
  reachablePoint,
  screenRect,
  scrollPlan,
  scrollSurface,
  swipeVector,
  tapPoint,
  viewportFor,
  visibleFraction,
  visibleRect,
} from '../src/ui/viewport';
import { Bounds } from '../src/types';
import { makeEl } from './helpers';

const PHONE = { width: 1080, height: 2400 };
const b = (x1: number, y1: number, x2: number, y2: number): Bounds => ({ x1, y1, x2, y2 });
/** The whole screen as a clip region — what most of these cases are asked against. */
const SCREEN = screenRect(viewportFor(PHONE, 0));

// --- viewportFor ----------------------------------------------------------

test('viewportFor: portrait rotations pass the screen through unchanged', () => {
  assert.deepEqual(viewportFor(PHONE, 0), PHONE);
  assert.deepEqual(viewportFor(PHONE, 2), PHONE);
});

test('viewportFor: landscape rotations swap the axes', () => {
  // `wm size` always reports the NATURAL orientation, so without this every element
  // past x=1080 on a landscape screen would look off-screen and every tap would
  // try to scroll sideways.
  assert.deepEqual(viewportFor(PHONE, 1), { width: 2400, height: 1080 });
  assert.deepEqual(viewportFor(PHONE, 3), { width: 2400, height: 1080 });
});

test('viewportFor: an unknown rotation degrades to the permissive square', () => {
  // iOS has no orientation signal. The square is never SMALLER than the real
  // viewport, so it can only under-detect — never strand a reachable element.
  assert.deepEqual(viewportFor({ width: 390, height: 844 }), { width: 844, height: 844 });
});

// --- isOffscreen / visibleRect / isFullyVisible ---------------------------

test('isOffscreen: only zero overlap counts', () => {
  const vp = SCREEN;
  assert.equal(isOffscreen(b(0, 2500, 1080, 2600), vp), true, 'entirely below the fold');
  assert.equal(isOffscreen(b(0, -200, 1080, -10), vp), true, 'entirely above');
  assert.equal(isOffscreen(b(1080, 100, 1300, 200), vp), true, 'entirely to the right');
  assert.equal(isOffscreen(b(0, 2300, 1080, 2600), vp), false, 'straddling the bottom edge');
  assert.equal(isOffscreen(b(0, 0, 1080, 200), vp), false, 'fully visible');
});

test('isOffscreen: an element flush against the far edge has no visible pixel', () => {
  // x1 === width means the first column is one past the last drawable one.
  assert.equal(isOffscreen(b(1080, 0, 1200, 100), SCREEN), true);
});

test('visibleRect: clips to the screen', () => {
  assert.deepEqual(visibleRect(b(-50, 2300, 1200, 2600), SCREEN), {
    x1: 0,
    y1: 2300,
    x2: 1080,
    y2: 2400,
  });
});

test('isFullyVisible: tolerates a pixel of rounding, not a real overhang', () => {
  const vp = SCREEN;
  assert.equal(isFullyVisible(b(0, 0, 1080, 2400), vp), true);
  assert.equal(isFullyVisible(b(-1, 0, 1081, 2401), vp), true, 'a rounded edge is not worth a swipe');
  assert.equal(isFullyVisible(b(0, 0, 1080, 2450), vp), false);
});

test('visibleFraction: reports how much of the element the screen shows', () => {
  const vp = SCREEN;
  assert.equal(visibleFraction(b(0, 0, 100, 100), vp), 1);
  assert.equal(visibleFraction(b(0, 2350, 100, 2450), vp), 0.5, 'half below the fold');
  assert.equal(visibleFraction(b(0, 2500, 100, 2600), vp), 0);
});

// --- tapPoint -------------------------------------------------------------

test('tapPoint: a fully visible element is pressed at its own centre', () => {
  const el = makeEl({ bounds: b(0, 100, 1080, 300) });
  // Byte-identical to el.center: the ordinary path must not move by a pixel.
  assert.deepEqual(tapPoint(el, SCREEN), el.center);
});

test('tapPoint: with no viewport known, nothing changes', () => {
  const el = makeEl({ bounds: b(0, 2500, 1080, 2700) });
  assert.deepEqual(tapPoint(el, undefined), el.center);
});

test('tapPoint: an element straddling the bottom edge is pressed on its visible part', () => {
  // The raw centre is at y=2450 — off the screen entirely, which is the blind tap
  // this whole change exists to prevent.
  const el = makeEl({ bounds: b(0, 2300, 1080, 2600) });
  assert.equal(el.center.y, 2450);
  assert.deepEqual(tapPoint(el, SCREEN), { x: 540, y: 2350 });
});

// --- swipeVector ----------------------------------------------------------

test('swipeVector: up drags from below the centre to above it (page scrolls down)', () => {
  const { from, to } = swipeVector(b(0, 0, 1000, 1000), 'up', 0.6);
  assert.deepEqual(from, { x: 500, y: 800 });
  assert.deepEqual(to, { x: 500, y: 200 });
});

test('swipeVector: down / left / right mirror it', () => {
  const region = b(0, 0, 1000, 1000);
  assert.deepEqual(swipeVector(region, 'down', 0.6), { from: { x: 500, y: 200 }, to: { x: 500, y: 800 } });
  assert.deepEqual(swipeVector(region, 'left', 0.6), { from: { x: 800, y: 500 }, to: { x: 200, y: 500 } });
  assert.deepEqual(swipeVector(region, 'right', 0.6), { from: { x: 200, y: 500 }, to: { x: 800, y: 500 } });
});

// --- scrollSurface --------------------------------------------------------

test('scrollSurface: falls back to the whole screen when nothing is scrollable', () => {
  const target = makeEl({ bounds: b(100, 2500, 900, 2600) });
  assert.deepEqual(scrollSurface([target], target, SCREEN, 'y'), {
    x1: 0,
    y1: 0,
    x2: 1080,
    y2: 2400,
  });
});

test('scrollSurface: prefers the container with the longest reach along the scroll axis', () => {
  // A horizontal carousel nested in a vertical feed: swiping the carousel could
  // never move a row that is below the fold.
  const feed = makeEl({ id: 'feed', scrollable: true, bounds: b(0, 200, 1080, 2200) });
  const carousel = makeEl({ id: 'carousel', scrollable: true, bounds: b(0, 300, 1080, 600) });
  const target = makeEl({ bounds: b(100, 2500, 900, 2600) });
  const surface = scrollSurface([feed, carousel, target], target, SCREEN, 'y');
  assert.deepEqual(surface, { x1: 0, y1: 200, x2: 1080, y2: 2200 });
});

test('scrollSurface: ignores a container that does not span the target', () => {
  const sidebar = makeEl({ scrollable: true, bounds: b(0, 0, 200, 2400) });
  const target = makeEl({ bounds: b(600, 2500, 900, 2600) });
  const surface = scrollSurface([sidebar, target], target, SCREEN, 'y');
  assert.deepEqual(surface, { x1: 0, y1: 0, x2: 1080, y2: 2400 }, 'falls back to the screen');
});

// --- isOccluded / reachablePoint ------------------------------------------

/** A row with a sticky bar drawn across its lower half, in paint order. */
function coveredRow() {
  const list = makeEl({ id: 'list', depth: 1, scrollable: true, bounds: b(0, 200, 1080, 2200) });
  const row = makeEl({ id: 'row', depth: 2, bounds: b(400, 1880, 660, 2012) });
  const bar = makeEl({ id: 'bar', depth: 1, bounds: b(0, 1934, 1080, 2066) });
  return { els: [list, row, bar], row, bar };
}

test('isOccluded: a later-painted element covering the point hides it', () => {
  const { els, row } = coveredRow();
  assert.equal(isOccluded(els, row, { x: 540, y: 1947 }), true, 'the centre is under the bar');
  assert.equal(isOccluded(els, row, { x: 540, y: 1900 }), false, 'above the bar it is clear');
});

test('isOccluded: an element painted BEFORE the target is behind it, not over it', () => {
  const { row, bar } = coveredRow();
  // Same rectangles, opposite order — the bar now draws first, so it is underneath.
  assert.equal(isOccluded([bar, row], row, { x: 540, y: 1947 }), false);
});

test("isOccluded: the target's own children are part of it", () => {
  const parent = makeEl({ id: 'card', depth: 1, bounds: b(0, 100, 1080, 400) });
  const label = makeEl({ id: 'label', depth: 2, bounds: b(0, 100, 1080, 400) });
  const later = makeEl({ id: 'sibling', depth: 1, bounds: b(0, 500, 1080, 700) });
  assert.equal(isOccluded([parent, label, later], parent, { x: 540, y: 250 }), false);
});

test('reachablePoint: falls back to a part of the element nothing covers', () => {
  const { els, row } = coveredRow();
  const p = reachablePoint(els, row, SCREEN);
  assert.ok(p);
  assert.equal(isOccluded(els, row, p), false);
  assert.ok(p.y >= row.bounds.y1 && p.y < row.bounds.y2, 'the point must still be on the element');
});

test('reachablePoint: an uncovered element is pressed dead centre', () => {
  const el = makeEl({ bounds: b(0, 100, 1080, 300) });
  assert.deepEqual(reachablePoint([el], el, SCREEN), { x: 540, y: 200 });
});

test('reachablePoint: null when every candidate point is covered', () => {
  const row = makeEl({ id: 'row', bounds: b(400, 1880, 660, 2012) });
  const sheet = makeEl({ id: 'sheet', bounds: b(0, 0, 1080, 2400) });
  assert.equal(reachablePoint([row, sheet], row, SCREEN), null);
});

// --- clipRegion -----------------------------------------------------------

/** A list inside a screen, with rows as its children — pre-order, like a real dump. */
function feedTree(rowBounds: Bounds[]): { els: ReturnType<typeof makeEl>[]; rows: ReturnType<typeof makeEl>[] } {
  const root = makeEl({ id: 'root', depth: 0, bounds: b(0, 0, 1080, 2400) });
  const list = makeEl({ id: 'list', depth: 1, scrollable: true, bounds: b(0, 200, 1080, 2000) });
  const rows = rowBounds.map((bb, i) => makeEl({ id: `row_${i}`, depth: 2, bounds: bb }));
  return { els: [root, list, ...rows], rows };
}

test('clipRegion: an element inside a scroll container is judged against that container', () => {
  // The case Android hides from us: the platform already clipped this row's bounds
  // to the display, so only the list it overflows says it is cut off.
  const { els, rows } = feedTree([b(0, 300, 1080, 400), b(0, 1950, 1080, 2050)]);
  assert.deepEqual(clipRegion(els, rows[0], SCREEN), { x1: 0, y1: 200, x2: 1080, y2: 2000 });
  assert.equal(isFullyVisible(rows[0].bounds, clipRegion(els, rows[0], SCREEN)), true);
  assert.equal(
    isFullyVisible(rows[1].bounds, clipRegion(els, rows[1], SCREEN)),
    false,
    'a row overflowing its list needs scrolling even though it is on screen',
  );
});

test('clipRegion: an element outside any scroll container gets the whole screen', () => {
  // A sticky bar or toolbar must not be pinned into someone else's box.
  const { els } = feedTree([b(0, 300, 1080, 400)]);
  const sticky = makeEl({ id: 'bar', depth: 1, bounds: b(0, 2100, 1080, 2300) });
  assert.deepEqual(clipRegion([...els, sticky], sticky, SCREEN), SCREEN);
});

test('clipRegion: a scrollable container itself is clipped only to the screen', () => {
  const { els } = feedTree([b(0, 300, 1080, 400)]);
  assert.deepEqual(clipRegion(els, els[1], SCREEN), SCREEN);
});

test('clipRegion: the container is clipped to the screen first', () => {
  const root = makeEl({ id: 'root', depth: 0, bounds: b(0, 0, 1080, 2400) });
  // A list that reports itself as extending past the bottom of the display.
  const list = makeEl({ id: 'list', depth: 1, scrollable: true, bounds: b(0, 200, 1080, 3000) });
  const row = makeEl({ id: 'row', depth: 2, bounds: b(0, 300, 1080, 400) });
  assert.deepEqual(clipRegion([root, list, row], row, SCREEN), { x1: 0, y1: 200, x2: 1080, y2: 2400 });
});

// --- scrollPlan -----------------------------------------------------------

test('scrollPlan: an element already in view needs no swipe', () => {
  assert.equal(scrollPlan(b(0, 100, 1080, 300), SCREEN, SCREEN), null);
});

test('scrollPlan: an element below the fold swipes up, aiming to centre it', () => {
  const plan = scrollPlan(b(100, 3000, 900, 3200), SCREEN, SCREEN);
  assert.ok(plan);
  assert.equal(plan.direction, 'up');
  assert.equal(plan.axis, 'y');
  assert.ok(plan.from.y > plan.to.y, 'the finger travels upward so the content follows');
  // Capped by the surface: 60% of a 2400px screen, not the full 1900px it would take.
  assert.equal(plan.distance, 1440);
  assert.ok(plan.from.y <= 2400 && plan.to.y >= 0, 'both endpoints stay on screen');
});

test('scrollPlan: an element above the viewport swipes down', () => {
  const plan = scrollPlan(b(100, -900, 900, -700), SCREEN, SCREEN);
  assert.ok(plan);
  assert.equal(plan.direction, 'down');
  assert.ok(plan.to.y > plan.from.y);
});

test('scrollPlan: a short overhang is scrolled by exactly what is needed, not a full page', () => {
  // 100px of a 200px row hangs below the fold; its centre is 100px past the middle
  // of the screen… so centring it is a 1300px move, capped at 60% of the screen.
  const plan = scrollPlan(b(0, 2300, 1080, 2500), SCREEN, SCREEN);
  assert.ok(plan);
  assert.equal(plan.direction, 'up');
  assert.equal(plan.distance, 1200);
});

test('scrollPlan: refuses a move too small to read as a drag', () => {
  // A 30px correction would be delivered as a tap by `input swipe` — pressing an
  // arbitrary point is exactly the failure being fixed.
  assert.equal(scrollPlan(b(0, 1170, 1080, 1230 + 30), SCREEN, SCREEN), null);
});

test('scrollPlan: does not chase an axis the element is simply too big for', () => {
  // A full-width row is "clipped" horizontally only because it is as wide as the
  // screen; swiping sideways would never help.
  const plan = scrollPlan(b(-20, 3000, 1100, 3200), SCREEN, SCREEN);
  assert.ok(plan);
  assert.equal(plan.axis, 'y');
});

test('scrollPlan: a surface too small to drag within yields nothing', () => {
  assert.equal(scrollPlan(b(0, 3000, 1080, 3200), b(0, 0, 1080, 60), SCREEN), null);
});

test('scrollPlan: {centre} moves an in-view element to the middle anyway', () => {
  // The covered-by-a-sticky-bar case: the row is entirely inside its list, so the
  // ordinary answer is "no swipe needed" — but the middle is where a touch can
  // actually reach it.
  const row = b(400, 1880, 660, 2012);
  const list = b(0, 200, 1080, 2200);
  assert.equal(scrollPlan(row, list, list), null, 'nothing to do by geometry alone');
  const plan = scrollPlan(row, list, list, { centre: true });
  assert.ok(plan);
  assert.equal(plan.direction, 'up');
  assert.equal(plan.distance, 746, 'exactly the offset from the list centre');
});
