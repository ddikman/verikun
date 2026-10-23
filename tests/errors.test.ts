import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CliError, usageError, envError, isEnvError, SelectorNotFoundError, AmbiguousSelectorError, DeviceGoneError,
  DeviceUnresponsiveError, DumpKilledError, NoFreeDeviceError, NoUsableDeviceError, NoWindowError, RunEvictedError, isDeviceDrop,
} from '../src/errors';
import { describeError } from '../src/rpc';

test('CliError: carries the exit code and is a real Error', () => {
  const e = new CliError('boom', 2);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CliError');
  assert.equal(e.message, 'boom');
  assert.equal(e.exitCode, 2);
});

test('error helpers map to the documented exit codes', () => {
  assert.equal(usageError('x').exitCode, 2);
  assert.equal(envError('x').exitCode, 3);
});

test('isEnvError: true only for exit 3 — "the box is broken", not "the app is"', () => {
  assert.equal(isEnvError(envError('idb not on PATH')), true);
  assert.equal(isEnvError(new CliError('boom', 3)), true);
});

test('isEnvError: false for every other failure shape', () => {
  // Exit 1/2 are the app's problem (assertion, selector) — never an env abort.
  assert.equal(isEnvError(new CliError('x', 1)), false);
  assert.equal(isEnvError(usageError('x')), false);
  // The selector heal-trigger subclasses must not be swept up: healing them is the
  // whole point, and classifying them as env would abort the run instead.
  assert.equal(isEnvError(new SelectorNotFoundError('miss')), false);
  assert.equal(isEnvError(new AmbiguousSelectorError('ambiguous', [])), false);
  // Non-CliError inputs (catch bindings are `unknown`) must not throw.
  assert.equal(isEnvError(new Error('plain')), false);
  assert.equal(isEnvError(undefined), false);
  assert.equal(isEnvError(null), false);
  assert.equal(isEnvError('idb not found'), false);
});

test('isDeviceDrop: a phone that left adb — lost mid-flow, or nowhere to be found', () => {
  // These are the failures a leaking host adb server produces, so these alone earn the note
  // that names it (cli.ts's mapError and `vk ai`'s verdict).
  assert.equal(isDeviceDrop(new DeviceGoneError("device R58 transport lost: error: device 'R58' not found")), true);
  assert.equal(isDeviceDrop(new DeviceUnresponsiveError('device R58 did not answer a 5s shell echo')), true);
  assert.equal(isDeviceDrop(new NoUsableDeviceError('No Android devices/emulators connected.')), true);
});

test('isDeviceDrop: everything else stays unattributed', () => {
  // A screen the device ANSWERED about, an app-level miss, a busy server: none of these is a
  // phone leaving the host, and blaming adb for them would send the reader the wrong way.
  for (const e of [
    new NoWindowError(),
    new DumpKilledError(),
    new SelectorNotFoundError('miss'),
    new CliError('settings put did not stick', 3),
    new NoFreeDeviceError('verikun server device is busy (409)'),
    new RunEvictedError('evicted'),
    new Error('plain'),
    undefined,
  ]) {
    assert.equal(isDeviceDrop(e), false, String(e));
  }
});

test('NoUsableDeviceError: still exit 3, and still a plain CliError on the wire', () => {
  // A lane child reports its failure as `errorKind`; the parallel suite schedules on it. This
  // class exists for attribution only, so it must not become a new kind there.
  const e = new NoUsableDeviceError('No Android devices/emulators connected.');
  assert.equal(e.exitCode, 3);
  assert.equal(isEnvError(e), true);
  assert.equal(describeError(e).kind, 'CliError');
});
