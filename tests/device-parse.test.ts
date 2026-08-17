import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAdbDevices } from '../src/drivers/adb';
import { parseSimulatorList } from '../src/drivers/ios';

// --- parseAdbDevices (`adb devices -l`) ------------------------------------

test('parseAdbDevices: skips the header and reads model/product key-values', () => {
  const out = [
    'List of devices attached',
    'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
    '1a2b3c4d               device product:raven model:Pixel_6_Pro device:raven transport_id:2',
    '',
  ].join('\n');
  const devices = parseAdbDevices(out);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].serial, 'emulator-5554');
  assert.equal(devices[0].state, 'device');
  assert.equal(devices[0].model, 'sdk_gphone64_arm64');
  assert.equal(devices[0].product, 'sdk_gphone64_arm64');
  assert.equal(devices[0].platform, 'android');
  assert.equal(devices[1].serial, '1a2b3c4d');
  assert.equal(devices[1].model, 'Pixel_6_Pro');
});

test('parseAdbDevices: emulator-* is kind emulator, everything else physical', () => {
  const devices = parseAdbDevices(
    'List of devices attached\nemulator-5556  device\nR5CT10ABCDE  device\n',
  );
  assert.equal(devices[0].kind, 'emulator');
  assert.equal(devices[1].kind, 'physical');
});

test('parseAdbDevices: carries offline/unauthorized states through verbatim', () => {
  const devices = parseAdbDevices(
    'List of devices attached\nemulator-5554  offline\n1a2b3c4d  unauthorized\n',
  );
  assert.deepEqual(devices.map((d) => d.state), ['offline', 'unauthorized']);
});

test('parseAdbDevices: ignores daemon chatter and blank lines', () => {
  const out = [
    'List of devices attached',
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    '',
    'emulator-5554  device',
    '',
  ].join('\n');
  const devices = parseAdbDevices(out);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, 'emulator-5554');
});

test('parseAdbDevices: empty / header-only output yields no devices', () => {
  assert.deepEqual(parseAdbDevices(''), []);
  assert.deepEqual(parseAdbDevices('List of devices attached\n\n'), []);
});

// --- parseSimulatorList (`simctl list devices available --json`) -----------

// Trimmed from real output on this machine: note "iPhone 17 Pro" appears under
// BOTH runtimes with different UDIDs — the ambiguity chooseTarget must not resolve.
const SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
      { udid: '92478A24-35FA-4459-AA25-4ABAEE8A0B86', name: 'iPhone 17 Pro', state: 'Shutdown' },
      { udid: 'FF9FF790-9A04-4C7A-8ED7-569A38C7E433', name: 'iPhone 17', state: 'Booted' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: '865617C9-9A9A-4968-B5D6-B65BE6B9143E', name: 'iPhone 17 Pro', state: 'Shutdown' },
    ],
  },
});

test('parseSimulatorList: flattens runtimes, lowercases state, runtime becomes product', () => {
  const sims = parseSimulatorList(SIMCTL_JSON);
  assert.equal(sims.length, 3);
  const booted = sims.find((d) => d.serial === 'FF9FF790-9A04-4C7A-8ED7-569A38C7E433');
  assert.ok(booted);
  assert.equal(booted.state, 'booted', 'state is lowercased to match the DeviceInfo vocabulary');
  assert.equal(booted.model, 'iPhone 17');
  assert.equal(booted.name, 'iPhone 17');
  assert.equal(booted.product, 'iOS-26-4');
  assert.equal(booted.kind, 'simulator');
  assert.equal(booted.platform, 'ios');
});

test('parseSimulatorList: the same name under two runtimes stays two distinct entries', () => {
  const pros = parseSimulatorList(SIMCTL_JSON).filter((d) => d.name === 'iPhone 17 Pro');
  assert.equal(pros.length, 2);
  assert.notEqual(pros[0].serial, pros[1].serial);
  assert.deepEqual(pros.map((d) => d.product).sort(), ['iOS-26-4', 'iOS-26-5']);
});

test('parseSimulatorList: malformed or empty output degrades to [] instead of throwing', () => {
  assert.deepEqual(parseSimulatorList(''), []);
  assert.deepEqual(parseSimulatorList('xcrun: error: unable to find utility'), []);
  assert.deepEqual(parseSimulatorList('{"devices":null}'), []);
  assert.deepEqual(parseSimulatorList('{"devices":{}}'), []);
});
