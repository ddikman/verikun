import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CliError, NoWindowError, isEnvError } from '../src/errors';

// `launch --clear` force-stops and wipes the app, so for a moment there is no window and
// getRootInActiveWindow() returns null. That is an observation about the screen, not a broken
// machine — and the difference is what stopped `wait --timeout 120000` aborting at ~20s with
// 100 seconds of its budget unspent.

test('NoWindowError is a CliError, so an unabsorbed one still exits 3', () => {
  const e = new NoWindowError('no window');
  assert.ok(e instanceof CliError);
  assert.equal(e.exitCode, 3, 'a caller with no wait budget keeps the old behaviour');
});

test('NoWindowError is distinguishable from every other capture failure', () => {
  // The whole fix hinges on this: pollers absorb THIS and nothing else. A missing adb or a
  // wedged dumper must still surface immediately rather than be polled for two minutes.
  assert.ok(new NoWindowError('x') instanceof NoWindowError);
  assert.equal(new CliError('adb not found', 3) instanceof NoWindowError, false);
});

test('NoWindowError still counts as an environment error for run recording', () => {
  // isEnvError drives whether failure evidence capture stays quiet — a screen with no window
  // cannot be screenshotted either, so the quiet path is right.
  assert.equal(isEnvError(new NoWindowError('no window')), true);
});

test('NoWindowError carries an actionable message, not just a stack', () => {
  const e = new NoWindowError('No window to read: the app has not drawn yet.');
  assert.match(e.message, /no window/i);
});
