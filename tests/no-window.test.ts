import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CliError,
  DUMP_KILLED_MESSAGE,
  DumpKilledError,
  NoWindowError,
  TransientReadError,
  dumpKilledMessage,
  isEnvError,
} from '../src/errors';

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

// --- a killed dump is transient too, but NOT the same signal (issue #137) ------------
//
// On a memory-constrained phone the OS reaps the dumper while an app cold-starts. The driver
// fired three attempts back-to-back, all three lost the same race, and a `wait` holding a
// two-minute budget aborted in seconds.

test('DumpKilledError is a CliError, so an unabsorbed one still exits 3', () => {
  const e = new DumpKilledError();
  assert.ok(e instanceof CliError);
  assert.equal(e.exitCode, 3, 'a caller with no wait budget keeps the old behaviour');
  assert.equal(isEnvError(e), true);
});

test('both transient reads share a base, so a poller absorbs them with one check', () => {
  assert.ok(new NoWindowError('x') instanceof TransientReadError);
  assert.ok(new DumpKilledError() instanceof TransientReadError);
});

test('a plain capture failure is NEITHER, so it still surfaces at once', () => {
  // The narrowness IS the feature, and it is the same polarity the no-window cases pin: a
  // missing adb or a wedged dumper must not be polled for two minutes.
  const e = new CliError('adb not found', 3);
  assert.equal(e instanceof TransientReadError, false);
  assert.equal(e instanceof DumpKilledError, false);
  assert.equal(e instanceof NoWindowError, false);
});

test('the two transient reads stay distinguishable from EACH OTHER', () => {
  // Load-bearing: only the killed dump refuses to answer "absent" at the end of a window,
  // because a null root is the device answering and a kill is no answer at all.
  assert.equal(new NoWindowError('x') instanceof DumpKilledError, false);
  assert.equal(new DumpKilledError() instanceof NoWindowError, false);
});

test('DumpKilledError names memory pressure, not just "capture failed"', () => {
  // "Killed" vs "the device is gone" want opposite responses from whoever reads the report.
  assert.match(new DumpKilledError().message, /killed/i);
  assert.match(new DumpKilledError().message, /memory/i);
});

test('the device evidence rides along when there is any, and is not faked when there is none', () => {
  // MEASURED (#137): in the `adb shell '<cmd>'` form BOTH streams come back empty and only the
  // exit status says 137 — so an empty detail must not produce a dangling "()".
  assert.equal(dumpKilledMessage(''), DUMP_KILLED_MESSAGE);
  assert.match(dumpKilledMessage('Killed'), /\(Killed\)$/);
});
