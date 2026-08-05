import { Bounds, Element, Point, Viewport } from '../types';

// Viewport geometry: is this element actually visible, where should a tap land, and
// which swipe brings it into view. Pure math over Bounds — no device, no time, no
// platform — so it unit-tests without a phone, like ui/selector.ts and image.ts.
//
// WHY THIS EXISTS: an element scrolled out of view is still in the hierarchy with
// coordinates, so `tap` used to press them and hit whatever was actually at that
// point — reporting success. Nothing here filters or hides such an element; it gives
// the action layer enough geometry to SCROLL IT INTO VIEW first.
//
// MEASURED, and the reason a plain screen check is not enough (emulator API 34,
// Flutter fixture): Android's dumper drops a node it considers invisible and clips
// the rest to the DISPLAY — `getVisibleBoundsInScreen`. So a row scrolled just past
// the fold arrives as a 13px sliver flush against the bottom edge, whose centre sits
// on the navigation bar, not on the row. Nothing in its bounds says "clipped". What
// does say it is the row overflowing its own SCROLL CONTAINER, which is why the
// visibility question below is asked against a region — screen ∩ scroll container —
// rather than against the screen alone.

export type Direction = 'up' | 'down' | 'left' | 'right';

/** A swipe as two device points. */
export interface SwipeVector {
  from: Point;
  to: Point;
}

/** How much of a region a directional swipe drags across, as a fraction of its span. */
export const DEFAULT_SWIPE_FRACTION = 0.6;

/** Below this the gesture reads as a tap rather than a drag, so scrolling by less
 *  than this is refused — pressing the wrong control is exactly what we are fixing. */
const MIN_DRAG_PX = 40;

/** Bounds within a pixel of the viewport edge count as inside: uiautomator rounds,
 *  and a 1px overhang is not a reason to swipe a screen. */
const EDGE_TOLERANCE_PX = 1;

/**
 * The screen rectangle a dump's coordinates live in.
 *
 * `rotation` is Android's `<hierarchy rotation="N">` (Surface.ROTATION_*): `adb shell
 * wm size` always reports the NATURAL orientation, so on a landscape device (1/3) the
 * axes must be swapped — without that, everything past the portrait width looks
 * off-screen and every tap on a landscape app would try to scroll.
 *
 * `undefined` means no orientation signal (iOS: `idb describe` has none). Rather than
 * guess, use the max(w,h) square: it can never be SMALLER than the true viewport, so
 * it can only under-detect off-screen elements — i.e. degrade to today's behaviour —
 * and never claim a visible element is out of view.
 */
export function viewportFor(screen: { width: number; height: number }, rotation?: number): Viewport {
  const w = Math.max(0, Math.round(screen.width));
  const h = Math.max(0, Math.round(screen.height));
  if (rotation === undefined) {
    const square = Math.max(w, h);
    return { width: square, height: square };
  }
  return rotation === 1 || rotation === 3 ? { width: h, height: w } : { width: w, height: h };
}

/** The screen as a rectangle — the outermost clip region. */
export function screenRect(vp: Viewport): Bounds {
  return { x1: 0, y1: 0, x2: vp.width, y2: vp.height };
}

/** No overlap with the region at all — there is no honest point to press. */
export function isOffscreen(b: Bounds, region: Bounds): boolean {
  return b.x2 <= region.x1 || b.y2 <= region.y1 || b.x1 >= region.x2 || b.y1 >= region.y2;
}

/** The part of `b` inside the region (empty rect when there is no overlap). */
export function visibleRect(b: Bounds, region: Bounds): Bounds {
  return {
    x1: Math.max(b.x1, region.x1),
    y1: Math.max(b.y1, region.y1),
    x2: Math.min(b.x2, region.x2),
    y2: Math.min(b.y2, region.y2),
  };
}

/** Entirely within the region — the state "scroll into view" aims for. */
export function isFullyVisible(b: Bounds, region: Bounds): boolean {
  return (
    b.x1 >= region.x1 - EDGE_TOLERANCE_PX &&
    b.y1 >= region.y1 - EDGE_TOLERANCE_PX &&
    b.x2 <= region.x2 + EDGE_TOLERANCE_PX &&
    b.y2 <= region.y2 + EDGE_TOLERANCE_PX
  );
}

const area = (b: Bounds): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

/** 0..1 — how much of the element the region shows. 1 when fully visible (or degenerate). */
export function visibleFraction(b: Bounds, region: Bounds): number {
  const total = area(b);
  if (total <= 0) return isOffscreen(b, region) ? 0 : 1;
  return area(visibleRect(b, region)) / total;
}

/**
 * Where a tap on this element should land.
 *
 * The centre of the VISIBLE part, not of the raw bounds: an element straddling an
 * edge has a geometric centre that can sit outside it, and pressing that is the blind
 * tap this module exists to prevent. Identical to `el.center` whenever the element is
 * fully visible (or no region is known), so the ordinary path is unchanged.
 */
export function tapPoint(el: Element, region?: Bounds): Point {
  if (!region || isOffscreen(el.bounds, region) || isFullyVisible(el.bounds, region)) return el.center;
  const v = visibleRect(el.bounds, region);
  return { x: Math.floor((v.x1 + v.x2) / 2), y: Math.floor((v.y1 + v.y2) / 2) };
}

/**
 * The region an element must be inside to be reliably tappable: the screen, further
 * clipped to its nearest SCROLLABLE ancestor.
 *
 * This is what catches the case the platform hides from us. Android reports a row
 * scrolled past the fold with bounds already clipped to the display, so nothing about
 * the row itself says it is cut off — but it still overflows the list it lives in,
 * and that is visible in the tree. Elements outside any scroll container (a toolbar,
 * a sticky bar) get the plain screen, so nothing pins them into a smaller box.
 *
 * The hierarchy is pre-order, so an element's ancestors are the nodes before it whose
 * depth keeps decreasing — walking back is exact, not a containment guess.
 */
export function clipRegion(els: Element[], target: Element, screen: Bounds): Bounds {
  const at = els.indexOf(target);
  let depth = target.depth;
  for (let i = at - 1; i >= 0; i--) {
    const el = els[i];
    if (el.depth >= depth) continue; // not an ancestor: a sibling or its subtree
    depth = el.depth;
    if (el.scrollable) return visibleRect(el.bounds, screen);
  }
  return screen;
}

/** The two points of a directional swipe across `region`, `frac` of its span. */
export function swipeVector(region: Bounds, dir: Direction, frac: number): SwipeVector {
  const cx = Math.floor((region.x1 + region.x2) / 2);
  const cy = Math.floor((region.y1 + region.y2) / 2);
  const dx = Math.floor(((region.x2 - region.x1) * frac) / 2);
  const dy = Math.floor(((region.y2 - region.y1) * frac) / 2);
  switch (dir) {
    case 'up':
      return { from: { x: cx, y: cy + dy }, to: { x: cx, y: cy - dy } };
    case 'down':
      return { from: { x: cx, y: cy - dy }, to: { x: cx, y: cy + dy } };
    case 'left':
      return { from: { x: cx + dx, y: cy }, to: { x: cx - dx, y: cy } };
    case 'right':
      return { from: { x: cx - dx, y: cy }, to: { x: cx + dx, y: cy } };
  }
}

/**
 * The region to swipe within to move `target`: its own scroll container when it has
 * one, else the largest scrollable that spans it, else the whole screen.
 *
 * The ancestor is exact (see clipRegion) and therefore preferred. The span-based
 * fallback picks by extent ALONG THE SCROLL AXIS, so a page-level vertical list wins
 * over a horizontal carousel nested inside it. Falling back to the screen matters: a
 * framework that never sets `scrollable` still gets a working full-screen swipe.
 */
export function scrollSurface(els: Element[], target: Element, screen: Bounds, axis: 'x' | 'y'): Bounds {
  const ancestor = clipRegion(els, target, screen);
  if (ancestor !== screen) return ancestor;

  const spans = (b: Bounds): number => (axis === 'y' ? b.y2 - b.y1 : b.x2 - b.x1);
  const crossCentre = axis === 'y' ? target.center.x : target.center.y;
  const covers = (b: Bounds): boolean =>
    axis === 'y' ? b.x1 <= crossCentre && b.x2 >= crossCentre : b.y1 <= crossCentre && b.y2 >= crossCentre;

  let best: Bounds | null = null;
  for (const el of els) {
    if (!el.scrollable || el === target) continue;
    if (isOffscreen(el.bounds, screen)) continue;
    const visible = visibleRect(el.bounds, screen);
    if (spans(visible) < MIN_DRAG_PX || !covers(el.bounds)) continue;
    if (!best || spans(visible) > spans(best)) best = visible;
  }
  return best ?? screen;
}

const contains = (b: Bounds, p: Point): boolean => p.x >= b.x1 && p.x < b.x2 && p.y >= b.y1 && p.y < b.y2;

/**
 * Where a tap on this element can actually reach it: the centre of its visible part,
 * or the nearest point to that centre which nothing else is drawn over.
 *
 * MEASURED, and the other half of the bug in #42: a row can be entirely inside the
 * screen AND inside its list, yet have a sticky bottom bar drawn across its lower
 * half — so pressing its centre presses the bar, and the step reports success having
 * tapped a completely different control. There is no occlusion flag in any dump; what
 * there IS, is order. The hierarchy is pre-order, later siblings paint over earlier
 * ones, so an element listed AFTER the target which covers the point is on top of it.
 *
 * Ancestors are excluded for free (they precede the target); descendants are the
 * contiguous run after it with greater depth, and they ARE the target for tapping
 * purposes. Returns null when every candidate point is covered — the caller warns
 * rather than failing, since this is an ordering heuristic and a wrong refusal would
 * be worse than the tap it prevents.
 */
export function reachablePoint(els: Element[], target: Element, region: Bounds): Point | null {
  const visible = visibleRect(target.bounds, region);
  if (visible.x2 <= visible.x1 || visible.y2 <= visible.y1) return null;

  // Centre first, then inward-inset points: any interior point of a control taps it,
  // and staying inset keeps us off a neighbour's edge.
  const xs = [0.5, 0.5, 0.5, 0.25, 0.75, 0.25, 0.75];
  const ys = [0.5, 0.25, 0.75, 0.5, 0.5, 0.25, 0.75];
  for (let i = 0; i < xs.length; i++) {
    const p = {
      x: Math.floor(visible.x1 + (visible.x2 - visible.x1) * xs[i]),
      y: Math.floor(visible.y1 + (visible.y2 - visible.y1) * ys[i]),
    };
    if (contains(visible, p) && !isOccluded(els, target, p)) return p;
  }
  return null;
}

/** Is `point` covered by an element painted after `target` (and not part of it)? */
export function isOccluded(els: Element[], target: Element, point: Point): boolean {
  const at = els.indexOf(target);
  if (at < 0) return false;
  let i = at + 1;
  while (i < els.length && els[i].depth > target.depth) i++; // the target's own subtree is the target
  for (; i < els.length; i++) if (contains(els[i].bounds, point)) return true;
  return false;
}

/**
 * How long to spend dragging `distance` pixels.
 *
 * MEASURED on emulator-5554 (API 34), and the reason this is not a constant: the same
 * 1118px swipe delivered over 400ms took the app off the screen entirely — the fling
 * velocity is read as another gesture — while over 1500ms it scrolled cleanly and
 * stopped where it was put. Pacing by distance keeps a scroll a DRAG: the list lands
 * where we aimed, so the next measurement is of the screen we asked for.
 */
export function swipeDurationMs(distance: number): number {
  const PX_PER_MS = 0.75;
  return Math.min(2000, Math.max(300, Math.round(Math.abs(distance) / PX_PER_MS)));
}

/** A single swipe toward bringing an element into view. */
export interface ScrollStep extends SwipeVector {
  axis: 'x' | 'y';
  direction: Direction;
  /** How far the content should move, in px. */
  distance: number;
}

/**
 * The swipe that brings `target` into view within `surface`, or null when no useful
 * one exists (already visible, or the move would be too small to be a drag).
 *
 * Aims to CENTRE the target rather than merely nudge it past the edge: an element
 * resting against a screen edge is the case most likely to sit under a sticky app
 * bar, which no hierarchy dump can tell us about. Centring costs nothing extra —
 * the swipe is capped by the surface either way — and lands well clear of both.
 */
export function scrollPlan(
  target: Bounds,
  surface: Bounds,
  clip: Bounds,
  opts: { centre?: boolean } = {},
): ScrollStep | null {
  if (!opts.centre && isFullyVisible(target, clip)) return null;

  // Distance the CONTENT must move for the target to end up centred. Positive means
  // the target is too far down/right, so the content has to move up/left.
  const needY = Math.round((target.y1 + target.y2) / 2 - (clip.y1 + clip.y2) / 2);
  const needX = Math.round((target.x1 + target.x2) / 2 - (clip.x1 + clip.x2) / 2);
  const fitsY = target.y2 - target.y1 <= clip.y2 - clip.y1;
  const fitsX = target.x2 - target.x1 <= clip.x2 - clip.x1;
  // Only chase an axis the element is actually clipped on: a full-width row is
  // "outside the region in x" by its own size, which no sideways swipe fixes.
  // `centre` overrides that — the caller wants the element moved to the middle even
  // though it is already inside the region (something is drawn over it there).
  const wantY = fitsY && (opts.centre || target.y1 < clip.y1 || target.y2 > clip.y2) ? Math.abs(needY) : 0;
  const wantX = fitsX && (opts.centre || target.x1 < clip.x1 || target.x2 > clip.x2) ? Math.abs(needX) : 0;
  if (wantY === 0 && wantX === 0) return null;

  const axis: 'x' | 'y' = wantY >= wantX ? 'y' : 'x';
  const need = axis === 'y' ? needY : needX;
  const region = visibleRect(surface, clip);
  const span = axis === 'y' ? region.y2 - region.y1 : region.x2 - region.x1;
  if (span < MIN_DRAG_PX * 2) return null;

  const drag = Math.min(Math.abs(need), Math.floor(span * DEFAULT_SWIPE_FRACTION));
  if (drag < MIN_DRAG_PX) return null;

  // `up` scrolls the page DOWN (content moves up), revealing what was below.
  const direction: Direction = axis === 'y' ? (need > 0 ? 'up' : 'down') : need > 0 ? 'left' : 'right';
  return { ...swipeVector(region, direction, drag / span), axis, direction, distance: drag };
}
