import type { Element, Viewport } from '../types';

// A modal barrier — the scrim a sheet or dialog puts in front of everything else — and
// the one tree shape it produces that reads as "empty" while the screen is plainly full.
//
// Pure functions over Element[] (no device, no time, no platform), like ui/selector.ts,
// so the shape is unit-testable and the two consumers cannot drift: the Android driver
// re-reads a tree of this shape before trusting it, and the selector commands name the
// barrier in their failure message when it outlived their wait.
//
// WHY THIS EXISTS (issue #131). Flutter's ModalBarrier is a BlockSemantics around one
// full-screen Semantics(label:, onTap:) node. BlockSemantics DROPS every node painted
// before it — the whole route underneath — on purpose: a screen reader must not reach
// content the user cannot touch. The sheet's own content joins the tree only once it is
// on screen, and Android's dumper skips what it considers invisible, so for the length
// of the entrance the hierarchy is the barrier and nothing else. MEASURED on a physical
// SM-A415F and a motorola one: the first read after `tap @vk_sheet_open` returned
// (+0.3-0.45s) held `android:id/content` and `Scrim`; the next read held the sheet.
//
// Detection is STRUCTURAL, never by label. The label is `MaterialLocalizations.scrimLabel`
// — "Scrim" in English and Swedish, "Gitter" in German, "Fond" in French, "スクリム" in
// Japanese — and `modalBarrierDismissLabel` ("Dismiss") for a dialog, so a label match
// would work on exactly the devices it was written on. What is stable is the shape: a
// clickable, id-less node with no text, large enough to be the thing you tap to dismiss.

/**
 * How much of the viewport a lone tap target must cover to read as a barrier.
 *
 * Loose on purpose. A sheet's barrier is CLIPPED to the area above the sheet once the
 * sheet is up (measured: 1620 of 2184 view px on the SM-A415F, ~68% of the 2400px display),
 * and a dialog's covers everything — so "covers the screen" would miss the sheet. What the
 * floor has to exclude is a lone ordinary button on an otherwise empty screen, which is a
 * few percent at most.
 */
export const MIN_BARRIER_COVERAGE = 0.4;

/** Input classes `isInteresting()` keeps even when empty — a field is never inert. */
const INPUT_CLASS = /EditText|AutoComplete|TextField|Edit$/;

/**
 * Nothing to read and nothing to act on: a layout container, with or without an id.
 *
 * An id alone does not make a node readable — `android:id/content` is in every Android
 * dump and says nothing about the app — which is why this looks at content and actions
 * and ignores `id`. The report behind this listed "thirteen unlabelled containers".
 */
export function isInert(el: Element): boolean {
  if (el.text.trim() || el.desc.trim()) return false;
  if (el.clickable || el.longClickable || el.checkable || el.scrollable) return false;
  return !INPUT_CLASS.test(el.class);
}

/**
 * Is this node shaped like a modal barrier: clickable (it dismisses on tap), no id (a
 * framework node, not one the app named), no text, and — when the viewport is known —
 * covering at least MIN_BARRIER_COVERAGE of it? A label is allowed but not required: an
 * app can raise a barrier with no `semanticsLabel`, and the node then has an action and
 * nothing else.
 *
 * With no viewport (the driver could not read a screen size) the size check is skipped:
 * a wrong "barrier" costs one extra read, a wrong "not a barrier" costs the false miss
 * this exists to prevent.
 */
export function isBarrierShaped(el: Element, vp: Viewport | null): boolean {
  if (!el.clickable || el.id || el.text.trim()) return false;
  if (!vp || vp.width <= 0 || vp.height <= 0) return true;
  const w = Math.max(0, Math.min(el.bounds.x2, vp.width) - Math.max(el.bounds.x1, 0));
  const h = Math.max(0, Math.min(el.bounds.y2, vp.height) - Math.max(el.bounds.y1, 0));
  return (w * h) / (vp.width * vp.height) >= MIN_BARRIER_COVERAGE;
}

/**
 * The barrier, when the tree holds one or more barrier-shaped nodes and nothing else that
 * could be read or acted on; null for any other tree — including an EMPTY one, which is a
 * different signal (a bad read) and is handled where it is met.
 *
 * Two barriers at once are one shape, not two: a dialog raised over a sheet has the
 * dialog's barrier and the sheet's in the same tree mid-transition.
 */
export function modalBarrierOnly(els: Element[], vp: Viewport | null): Element | null {
  let barrier: Element | null = null;
  for (const el of els) {
    if (isInert(el)) continue;
    if (!isBarrierShaped(el, vp)) return null;
    barrier ??= el;
  }
  return barrier;
}

/** How a message names the barrier: its label when it has one, else its shape. */
export function describeBarrier(el: Element): string {
  const label = el.desc.trim();
  return label ? `desc=${JSON.stringify(label)}` : 'an unlabelled full-screen tap target';
}

/**
 * The clause a selector failure appends when the barrier was what it kept reading.
 *
 * `every` says whether EVERY read during the wait was barrier-only (the report's case:
 * "waited 30s, never appeared") or only the last one (a sheet or dialog opened late in
 * the window). Both are worth naming; they send the reader to different places.
 */
export function barrierClause(barrier: Element, every: boolean): string {
  const when = every ? 'for the whole wait' : 'on the last read';
  return (
    ` The hierarchy held only a modal barrier (${describeBarrier(barrier)}) ${when}: a sheet ` +
    'or dialog is up and nothing inside it has reached the accessibility tree. Dismiss it, ' +
    'or wait for its contents, before this step.'
  );
}
