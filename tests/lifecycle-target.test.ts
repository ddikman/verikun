import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  chooseTarget,
  assertActionable,
  isRunning,
  targetLabel,
  LifecycleTarget,
} from '../src/drivers/lifecycle';
import { CliError } from '../src/errors';

const target = (over: Partial<LifecycleTarget> = {}): LifecycleTarget => ({
  platform: 'android',
  kind: 'emulator',
  serial: 'emulator-5554',
  name: 'Pixel_6_API_34',
  state: 'device',
  ...over,
});

/** The real ambiguity from this machine: one name, two runtimes, two UDIDs. */
const IPHONE_264 = target({
  platform: 'ios', kind: 'simulator', serial: '92478A24-35FA-4459-AA25-4ABAEE8A0B86',
  name: 'iPhone 17 Pro', state: 'shutdown', runtime: 'iOS-26-4',
});
const IPHONE_265 = target({
  platform: 'ios', kind: 'simulator', serial: '865617C9-9A9A-4968-B5D6-B65BE6B9143E',
  name: 'iPhone 17 Pro', state: 'shutdown', runtime: 'iOS-26-5',
});

const isCli = (code: number, re?: RegExp) => (e: unknown) =>
  e instanceof CliError && e.exitCode === code && (!re || re.test(e.message));

// --- isRunning / targetLabel ------------------------------------------------

test('isRunning: both platforms spell "usable" differently', () => {
  assert.equal(isRunning(target({ state: 'device' })), true);
  assert.equal(isRunning(target({ state: 'booted' })), true);
  assert.equal(isRunning(target({ state: 'shutdown' })), false);
  assert.equal(isRunning(target({ state: 'offline' })), false);
  assert.equal(isRunning(target({ state: 'unauthorized' })), false);
});

test('targetLabel: prefers the human name, falls back to the serial', () => {
  assert.equal(targetLabel(target()), 'Pixel_6_API_34');
  assert.equal(targetLabel(target({ name: '', serial: '1a2b3c' })), '1a2b3c');
});

// --- chooseTarget -----------------------------------------------------------

test('chooseTarget: an exact serial/UDID match wins over a name match', () => {
  const decoy = target({ name: 'emulator-5554', serial: 'emulator-9999', state: 'shutdown' });
  const got = chooseTarget([decoy, target()], 'emulator-5554', { prefer: 'running' });
  assert.equal(got.serial, 'emulator-5554');
});

test('chooseTarget: matching is case-insensitive and trims the input', () => {
  assert.equal(chooseTarget([target()], '  pixel_6_api_34  ', { prefer: 'running' }).serial, 'emulator-5554');
  assert.equal(chooseTarget([IPHONE_264], 'iphone 17 pro', { prefer: 'startable' }).runtime, 'iOS-26-4');
  assert.equal(
    chooseTarget([IPHONE_264], '92478a24-35fa-4459-aa25-4abaee8a0b86', { prefer: 'startable' }).runtime,
    'iOS-26-4',
  );
});

test('chooseTarget: no match is exit 1 and points at `vk devices --all`', () => {
  assert.throws(
    () => chooseTarget([target()], 'Nexus_5X', { prefer: 'startable' }),
    isCli(1, /No device or AVD named 'Nexus_5X'[\s\S]*vk devices --all/),
  );
});

test('chooseTarget: a partial name suggests, but never resolves', () => {
  assert.throws(
    () => chooseTarget([IPHONE_264, IPHONE_265], 'iPhone', { prefer: 'startable' }),
    isCli(1, /Did you mean: iPhone 17 Pro\?/),
  );
});

test('chooseTarget: two same-named simulators are exit 2 naming both runtimes and UDIDs', () => {
  assert.throws(
    () => chooseTarget([IPHONE_264, IPHONE_265], 'iPhone 17 Pro', { prefer: 'startable' }),
    (e: unknown) => {
      if (!isCli(2)(e)) return false;
      const m = (e as CliError).message;
      return (
        /matches 2 devices/.test(m) &&
        m.includes('iOS-26-4') && m.includes('iOS-26-5') &&
        m.includes('92478A24-35FA-4459-AA25-4ABAEE8A0B86') &&
        m.includes('865617C9-9A9A-4968-B5D6-B65BE6B9143E')
      );
    },
  );
});

test("chooseTarget: prefer 'startable' picks the shutdown one when the other is booted", () => {
  const booted = { ...IPHONE_264, state: 'booted' };
  const got = chooseTarget([booted, IPHONE_265], 'iPhone 17 Pro', { prefer: 'startable' });
  assert.equal(got.serial, IPHONE_265.serial);
});

test("chooseTarget: prefer 'running' picks the booted one when the other is shutdown", () => {
  const booted = { ...IPHONE_264, state: 'booted' };
  const got = chooseTarget([booted, IPHONE_265], 'iPhone 17 Pro', { prefer: 'running' });
  assert.equal(got.serial, IPHONE_264.serial);
});

test('chooseTarget: both in the SAME state stays ambiguous — narrowing never guesses', () => {
  const bothBooted = [{ ...IPHONE_264, state: 'booted' }, { ...IPHONE_265, state: 'booted' }];
  assert.throws(() => chooseTarget(bothBooted, 'iPhone 17 Pro', { prefer: 'running' }), isCli(2));
  assert.throws(() => chooseTarget(bothBooted, 'iPhone 17 Pro', { prefer: 'startable' }), isCli(2));
});

test('chooseTarget: an empty target list is a miss, not a crash', () => {
  assert.throws(() => chooseTarget([], 'Pixel_6_API_34', { prefer: 'startable' }), isCli(1));
});

// --- assertActionable (the --wipe guardrails) -------------------------------

test('assertActionable: physical devices are never power-cycled', () => {
  const phone = target({ kind: 'physical', name: '', serial: 'R5CT10ABCDE' });
  for (const verb of ['start', 'stop', 'restart'] as const) {
    assert.throws(() => assertActionable(phone, verb), isCli(2, /physical device/));
  }
});

test('assertActionable: emulators and simulators pass without --wipe', () => {
  assertActionable(target(), 'start');
  assertActionable(target(), 'stop');
  assertActionable(target({ state: 'shutdown' }), 'restart');
  assertActionable(IPHONE_264, 'start');
});

test('assertActionable: --wipe is rejected on stop', () => {
  assert.throws(
    () => assertActionable(target(), 'stop', { wipe: true }),
    isCli(2, /--wipe is not valid with `vk devices stop`/),
  );
});

test('assertActionable: `start --wipe` against a RUNNING target points at restart', () => {
  assert.throws(
    () => assertActionable(target({ state: 'device' }), 'start', { wipe: true }),
    isCli(2, /already running; use `vk devices restart Pixel_6_API_34 --wipe`/),
  );
  assert.throws(
    () => assertActionable({ ...IPHONE_264, state: 'booted' }, 'start', { wipe: true }),
    isCli(2, /already running/),
  );
});

test('assertActionable: `start --wipe` against a SHUTDOWN target is allowed', () => {
  assertActionable(target({ state: 'shutdown' }), 'start', { wipe: true });
  assertActionable(IPHONE_264, 'start', { wipe: true });
});

test('assertActionable: `restart --wipe` is allowed in either state', () => {
  assertActionable(target({ state: 'device' }), 'restart', { wipe: true });
  assertActionable(target({ state: 'shutdown' }), 'restart', { wipe: true });
});
