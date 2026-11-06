import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { executeForServer } from '../src/cli';
import { UnsupportedOnPlatformError } from '../src/errors';
import { setOutputQuiet } from '../src/output';
import type { SettingKey } from '../src/device/settings';
import { makeDriver } from './helpers';

// `vk device set` with a key newer than the attached Android (download-limit needs 13 / API 33)
// must refuse BEFORE any write — the same fail-early rule as a platform-unsupported key, because
// a half-applied device is worse than none. Driven through `executeForServer`, the real handler
// path minus the device.

// `executeForServer` heartbeats a host-global claim; keep these tests out of ~/.verikun/devices.
const savedNoClaim = process.env.VERIKUN_NO_CLAIM;
before(() => {
  setOutputQuiet(true);
  process.env.VERIKUN_NO_CLAIM = '1';
});
after(() => {
  setOutputQuiet(false);
  if (savedNoClaim === undefined) delete process.env.VERIKUN_NO_CLAIM;
  else process.env.VERIKUN_NO_CLAIM = savedNoClaim;
});

function deviceAt(apiLevel: (() => number | null) | undefined) {
  const writes: Array<[SettingKey, string]> = [];
  const driver = makeDriver({
    ...(apiLevel ? { apiLevel } : {}),
    getDeviceSetting: (key) => (key === 'download-limit' ? 'off' : 'off'),
    setDeviceSetting: (key, value) => void writes.push([key, value]),
  });
  return { driver, writes };
}

test('device set: download-limit on Android 12 exits 3 before touching ANY key', async () => {
  const { driver, writes } = deviceAt(() => 31);
  const r = await executeForServer('device', ['set', 'dark=on', 'download-limit=1mbps'], {}, driver, 'android', false);
  assert.equal(r.code, 3);
  assert.ok(r.error instanceof UnsupportedOnPlatformError, `expected UnsupportedOnPlatformError, got ${r.error}`);
  assert.match(r.error!.message, /needs Android 13 \(API 33\).*API 31/);
  assert.deepEqual(writes, [], 'dark=on was applied before the refusal — the gate ran too late');
});

test('device set: download-limit on Android 13 is written in bytes per second', async () => {
  const { driver, writes } = deviceAt(() => 33);
  const r = await executeForServer('device', ['set', 'download-limit=1mbps'], {}, driver, 'android', false);
  assert.equal(r.code, 0, String(r.error));
  assert.deepEqual(writes, [['download-limit', '125000']]);
});

test('device set: an API level the device would not give does not refuse', async () => {
  // Null passes; a driver without the probe at all (an older RPC peer) passes too.
  for (const apiLevel of [() => null, undefined]) {
    const { driver, writes } = deviceAt(apiLevel);
    const r = await executeForServer('device', ['set', 'download-limit=256kbps'], {}, driver, 'android', false);
    assert.equal(r.code, 0, String(r.error));
    assert.deepEqual(writes, [['download-limit', '32000']]);
  }
});

test('device set: keys without a floor never ask the device for its API level', async () => {
  const { driver, writes } = deviceAt(() => {
    throw new Error('apiLevel() asked for a key that declares no floor');
  });
  const r = await executeForServer('device', ['set', 'dark=on'], {}, driver, 'android', false);
  assert.equal(r.code, 0, String(r.error));
  assert.deepEqual(writes, [['dark', 'on']]);
});
