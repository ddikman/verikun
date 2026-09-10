import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  MIN_BARRIER_COVERAGE,
  barrierClause,
  describeBarrier,
  isBarrierShaped,
  isInert,
  modalBarrierOnly,
} from '../src/ui/barrier';
import { makeEl } from './helpers';

// The shapes below are transcribed from real dumps of example/flutter-app's `@vk_modal`
// screen on a physical SM-A415F (1080x2400, app window 1080x2184) — see the README's
// measured facts. The detection is structural on purpose: the barrier's label is localised
// ("Scrim", "Gitter", "Fond", "スクリム"), so a label match would only work on the devices
// it was written on.

const VP = { width: 1080, height: 2400 };

/** `android:id/content` — in every Android dump, says nothing about the app. */
const content = () =>
  makeEl({ class: 'android.widget.FrameLayout', type: 'FrameLayout', id: 'android:id/content', idShort: 'content', bounds: { x1: 0, y1: 0, x2: 1080, y2: 2184 } });

/** A sheet's barrier once the sheet is up: clipped to the area ABOVE the sheet. */
const scrim = (desc = 'Scrim') =>
  makeEl({ class: 'android.view.View', type: 'View', desc, clickable: true, bounds: { x1: 0, y1: 0, x2: 1080, y2: 1620 } });

/** A dialog's barrier: the whole window. */
const dismiss = () =>
  makeEl({ class: 'android.view.View', type: 'View', desc: 'Dismiss', clickable: true, bounds: { x1: 0, y1: 0, x2: 1080, y2: 2184 } });

const sheetButton = () =>
  makeEl({ class: 'android.view.View', type: 'View', id: 'vk_sheet_confirm', idShort: 'vk_sheet_confirm', desc: 'Confirm', clickable: true, bounds: { x1: 63, y1: 1791, x2: 1017, y2: 1917 } });

// --- isInert ---------------------------------------------------------------

test('isInert: a container with only an id is inert — the id names nothing the app said', () => {
  assert.equal(isInert(content()), true);
  assert.equal(isInert(makeEl({ class: 'android.view.View' })), true);
});

test('isInert: anything readable or actionable is not', () => {
  assert.equal(isInert(makeEl({ text: 'Hello' })), false);
  assert.equal(isInert(makeEl({ desc: 'Back' })), false);
  assert.equal(isInert(makeEl({ clickable: true })), false);
  assert.equal(isInert(makeEl({ checkable: true })), false);
  assert.equal(isInert(makeEl({ scrollable: true })), false);
  assert.equal(isInert(makeEl({ longClickable: true })), false);
});

test('isInert: an empty input field is never inert', () => {
  // isInteresting() keeps a field by class even when it has no text; a screen with a bare
  // field on it is a screen, not a barrier.
  assert.equal(isInert(makeEl({ class: 'android.widget.EditText' })), false);
  assert.equal(isInert(makeEl({ class: 'TextField' })), false);
});

// --- isBarrierShaped -------------------------------------------------------

test('isBarrierShaped: a sheet scrim clipped to the top ~68% of the display still counts', () => {
  // 1080x1620 of 1080x2400 = 0.675, above the floor. "Covers the whole screen" would miss it.
  assert.equal(isBarrierShaped(scrim(), VP), true);
  assert.ok(MIN_BARRIER_COVERAGE < 0.675);
});

test('isBarrierShaped: a dialog barrier covers the window', () => {
  assert.equal(isBarrierShaped(dismiss(), VP), true);
});

test('isBarrierShaped: a lone ordinary button is not a barrier', () => {
  // The floor exists for exactly this: a near-empty screen with one button on it.
  const ok = makeEl({ desc: 'OK', clickable: true, bounds: { x1: 390, y1: 1100, x2: 690, y2: 1200 } });
  assert.equal(isBarrierShaped(ok, VP), false);
  // Nor a full-width banner button: wide, but a tenth of the screen tall.
  const banner = makeEl({ desc: 'Continue', clickable: true, bounds: { x1: 0, y1: 2100, x2: 1080, y2: 2340 } });
  assert.equal(isBarrierShaped(banner, VP), false);
});

test('isBarrierShaped: a node the app named, or one with text, is never a barrier', () => {
  assert.equal(isBarrierShaped({ ...scrim(), id: 'com.app:id/overlay', idShort: 'overlay' }, VP), false);
  assert.equal(isBarrierShaped({ ...scrim(), text: 'Loading' }, VP), false);
});

test('isBarrierShaped: a non-clickable node is never a barrier', () => {
  // iOS reports Flutter's barrier without a tappable type, so `clickable` is false there
  // and the check does not fire — measured: the sheet's content is in the first read
  // on the simulator anyway, so there is nothing to settle.
  assert.equal(isBarrierShaped({ ...scrim(), clickable: false }, VP), false);
});

test('isBarrierShaped: with no viewport the size check is skipped, never inverted', () => {
  // A wrong "barrier" costs one extra read; a wrong "not a barrier" is the false miss
  // this exists to prevent.
  const small = makeEl({ clickable: true, bounds: { x1: 0, y1: 0, x2: 10, y2: 10 } });
  assert.equal(isBarrierShaped(small, null), true);
  assert.equal(isBarrierShaped(small, { width: 0, height: 0 }), true);
});

test('isBarrierShaped: coverage is measured inside the viewport', () => {
  // Bounds that run off the display (a landscape dump read against the natural size)
  // must not inflate the covered area beyond the screen.
  const huge = makeEl({ clickable: true, bounds: { x1: -5000, y1: -5000, x2: 5000, y2: 5000 } });
  assert.equal(isBarrierShaped(huge, VP), true);
  const offscreen = makeEl({ clickable: true, bounds: { x1: 2000, y1: 3000, x2: 9000, y2: 9000 } });
  assert.equal(isBarrierShaped(offscreen, VP), false);
});

// --- modalBarrierOnly ------------------------------------------------------

test('modalBarrierOnly: the measured mid-entrance tree — content frame + Scrim — is barrier-only', () => {
  const b = modalBarrierOnly([content(), scrim()], VP);
  assert.ok(b);
  assert.equal(b.desc, 'Scrim');
});

test('modalBarrierOnly: the landed sheet is not — its controls are readable', () => {
  assert.equal(modalBarrierOnly([content(), sheetButton(), scrim()], VP), null);
});

test('modalBarrierOnly: two barriers (a dialog over a sheet, mid-transition) are one shape', () => {
  const b = modalBarrierOnly([content(), scrim(), dismiss()], VP);
  assert.ok(b);
  assert.equal(b.desc, 'Scrim', 'the first barrier in document order is the one named');
});

test('modalBarrierOnly: an unlabelled barrier still counts', () => {
  // ModalBarrier(semanticsLabel: null) leaves a node with an action and nothing else.
  const b = modalBarrierOnly([content(), scrim('')], VP);
  assert.ok(b);
  assert.equal(describeBarrier(b), 'an unlabelled full-screen tap target');
});

test('modalBarrierOnly: an empty tree is NOT barrier-only', () => {
  // A blank dump is a different signal (a bad read) with its own handling; conflating
  // the two would make every mid-transition blank read claim a modal is up.
  assert.equal(modalBarrierOnly([], VP), null);
  assert.equal(modalBarrierOnly([content()], VP), null);
});

test('modalBarrierOnly: any readable node beside the barrier means the screen is a screen', () => {
  assert.equal(modalBarrierOnly([scrim(), makeEl({ text: 'Title' })], VP), null);
  assert.equal(modalBarrierOnly([scrim(), makeEl({ class: 'android.widget.EditText', clickable: true })], VP), null);
});

test('modalBarrierOnly: the Swedish/German/Japanese label is irrelevant to the verdict', () => {
  for (const label of ['Scrim', 'Gitter', 'Fond', 'スクリム', 'Stäng']) {
    const b = modalBarrierOnly([content(), scrim(label)], VP);
    assert.ok(b, label);
    assert.equal(describeBarrier(b), `desc=${JSON.stringify(label)}`);
  }
});

// --- the message ------------------------------------------------------------

test('barrierClause: names the barrier and whether it was there for the whole wait', () => {
  const whole = barrierClause(scrim(), true);
  assert.match(whole, /only a modal barrier \(desc="Scrim"\) for the whole wait/);
  assert.match(whole, /sheet or dialog is up/);
  const late = barrierClause(dismiss(), false);
  assert.match(late, /\(desc="Dismiss"\) on the last read/);
});
