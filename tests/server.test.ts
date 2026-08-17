// Policy tests for `vk server`'s device-control gate. buildServer has no device
// dependency once `lifecycle` and `makeDriver` are injected, so the whole matrix —
// which is where a regression would actually be dangerous — runs without a device.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildServer, parseDeviceControl, ServerConfig, ServerLifecycle } from '../src/server';
import { setOutputQuiet } from '../src/output';
import type { DeviceOpResponse, DeviceListResponse, HealthResponse } from '../src/rpc';
import { CliError } from '../src/errors';
import { makeDriver } from './helpers';

const KEY = 'test-key';

/** Records what the server asked of the lifecycle layer, and what it was told back. */
function fakeLifecycle(over: Partial<ServerLifecycle> = {}) {
  const calls: Array<{ op: string; target: string; wipe?: boolean }> = [];
  const lc: ServerLifecycle = {
    async start(_p, target, opts) {
      calls.push({ op: 'start', target, wipe: opts.wipe });
      return { serial: 'emulator-5554', started: true };
    },
    async restart(_p, target, opts) {
      calls.push({ op: 'restart', target, wipe: opts.wipe });
      return { serial: 'emulator-5556' }; // deliberately a DIFFERENT port
    },
    async stop(_p, target, opts) {
      calls.push({ op: 'stop', target, wipe: opts.wipe });
    },
    list: () => [
      { serial: 'emulator-5554', state: 'device', platform: 'android', kind: 'emulator', name: 'Pixel_6' },
      { serial: '', state: 'shutdown', platform: 'android', kind: 'emulator', name: 'Secret_AVD' },
    ],
    ...over,
  };
  return { lc, calls };
}

let server: Server;
let base: string;
const madeDrivers: string[] = [];

/** Boot a server on an ephemeral port for one test and point `base` at it. */
async function start(config: Partial<ServerConfig> = {}): Promise<void> {
  if (server) server.close();
  madeDrivers.length = 0;
  server = buildServer({
    platform: 'android',
    driver: makeDriver(),
    serial: 'emulator-5554',
    authKey: KEY,
    allowInstall: false,
    makeDriver: (_p, device) => {
      madeDrivers.push(device);
      return makeDriver({ resolvedSerial: () => device });
    },
    ...config,
  });
  // listen() is async: address() stays null until 'listening' fires.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      'x-verikun-run': init.token ?? 'run-A',
      ...(init.headers as Record<string, string>),
    },
  });

before(() => setOutputQuiet(true)); // the server logs every request via err()
after(() => server?.close()); // without this, `node --test` hangs on the open handle

// --- parseDeviceControl -----------------------------------------------------

test('parseDeviceControl: absent = disabled; bare = enabled with no named targets', () => {
  assert.equal(parseDeviceControl({}), undefined);
  assert.equal(parseDeviceControl({ 'allow-device-control': false }), undefined);
  assert.deepEqual(parseDeviceControl({ 'allow-device-control': true }), { allowedTargets: [] });
});

test('parseDeviceControl: =names parses the allowlist (flagBool would have said false)', () => {
  assert.deepEqual(parseDeviceControl({ 'allow-device-control': 'Pixel_6, iPhone 17 ' }), {
    allowedTargets: ['Pixel_6', 'iPhone 17'],
  });
});

test('parseDeviceControl: an empty list is a usage error, not a silent bare flag', () => {
  assert.throws(
    () => parseDeviceControl({ 'allow-device-control': ' , ' }),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});

// --- health -----------------------------------------------------------------

test('health: device control is off by default and advertised as such', async () => {
  await start();
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.deviceControlEnabled, false);
  assert.equal(h.deviceNamingEnabled, false);
  assert.equal(h.deviceState, 'ready');
  assert.equal(h.serial, 'emulator-5554');
});

test('health: a device-less server reports serial null and deviceState none', async () => {
  await start({ serial: null, deviceControl: { allowedTargets: [] } });
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.serial, null);
  assert.equal(h.deviceState, 'none');
  assert.equal(h.deviceControlEnabled, true);
  assert.equal(h.deviceNamingEnabled, false);
});

test('health: an allowlist turns on deviceNamingEnabled', async () => {
  await start({ deviceControl: { allowedTargets: ['Pixel_6'] } });
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.deviceNamingEnabled, true);
});

// --- the gate ---------------------------------------------------------------

test('devices: 403 when the operator did not opt in', async () => {
  await start();
  for (const p of ['/v1/devices/start', '/v1/devices/restart', '/v1/devices/stop']) {
    const res = await call(p, { method: 'POST', body: '{}' });
    assert.equal(res.status, 403, p);
  }
  assert.equal((await call('/v1/devices')).status, 403);
});

test('devices: 401 without the auth key', async () => {
  await start({ deviceControl: { allowedTargets: [] } });
  const res = await fetch(`${base}/v1/devices/start`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});

test('devices: a bare flag refuses a named target', async () => {
  const { lc, calls } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const res = await call('/v1/devices/start', { method: 'POST', body: JSON.stringify({ target: 'Pixel_6' }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /bare --allow-device-control/);
  assert.equal(calls.length, 0, 'the lifecycle layer must not be reached');
});

test('devices: a non-allowlisted target is refused WITHOUT revealing whether it exists', async () => {
  const { lc, calls } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: ['Pixel_6'] }, lifecycle: lc });
  const res = await call('/v1/devices/start', { method: 'POST', body: JSON.stringify({ target: 'Secret_AVD' }) });
  assert.equal(res.status, 400);
  const { error } = (await res.json()) as { error: string };
  assert.match(error, /not permitted by this server's --allow-device-control allowlist/);
  // No enumeration oracle: the message must be identical for a real and a fake name.
  assert.doesNotMatch(error, /Secret_AVD|does not exist|unknown/i);
  assert.equal(calls.length, 0);
});

test('devices: an allowlisted target reaches the lifecycle layer', async () => {
  const { lc, calls } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: ['Pixel_6'] }, lifecycle: lc });
  const res = await call('/v1/devices/start', { method: 'POST', body: JSON.stringify({ target: 'Pixel_6' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ op: 'start', target: 'Pixel_6', wipe: false }]);
});

test('devices: with no target, the bound device is what gets acted on', async () => {
  const { lc, calls } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  await call('/v1/devices/restart', { method: 'POST', body: '{}' });
  assert.deepEqual(calls, [{ op: 'restart', target: 'emulator-5554', wipe: false }]);
});

test('devices: wipe is never defaulted on, and is refused on stop', async () => {
  const { lc, calls } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  await call('/v1/devices/restart', { method: 'POST', body: JSON.stringify({ wipe: true }) });
  assert.equal(calls[0].wipe, true);

  const res = await call('/v1/devices/stop', { method: 'POST', body: JSON.stringify({ wipe: true }) });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 1, 'stop+wipe must not reach the lifecycle layer');
});

// --- the lock (the sabotage guard) ------------------------------------------

test('devices: another run cannot restart the device out from under the holder', async () => {
  const { lc } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });

  // run-A takes the lock via an ordinary device endpoint.
  assert.equal((await call('/v1/elements', { method: 'POST', body: '{}', token: 'run-A' })).status, 200);

  const hostile = await call('/v1/devices/restart', { method: 'POST', body: '{}', token: 'run-B' });
  assert.equal(hostile.status, 409, 'run-B must not power-cycle run-A\'s device');

  const own = await call('/v1/devices/restart', { method: 'POST', body: '{}', token: 'run-A' });
  assert.equal(own.status, 200, 'the holder may recover its own device');
});

// --- rebinding --------------------------------------------------------------

test('devices: a restart onto a NEW serial rebinds the driver and health follows', async () => {
  const { lc } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });

  const r = (await (await call('/v1/devices/restart', { method: 'POST', body: '{}' })).json()) as DeviceOpResponse;
  assert.equal(r.serial, 'emulator-5556');
  assert.equal(r.changed, true);

  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.serial, 'emulator-5556', 'health must report the device we are now bound to');
  // Never rebind with undefined: that would auto-resolve and could latch onto a
  // different attached device.
  assert.deepEqual(madeDrivers, ['emulator-5556']);
});

test('devices: an idempotent start (started=false) leaves the binding alone', async () => {
  const { lc } = fakeLifecycle({
    async start() {
      return { serial: 'emulator-5554', started: false };
    },
  });
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const r = (await (await call('/v1/devices/start', { method: 'POST', body: '{}' })).json()) as DeviceOpResponse;
  assert.equal(r.changed, false);
  assert.deepEqual(madeDrivers, [], 'no rebuild when nothing changed');
});

test('devices: stop unbinds, and a second stop is a 409 rather than a crash', async () => {
  const { lc } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const r = (await (await call('/v1/devices/stop', { method: 'POST', body: '{}' })).json()) as DeviceOpResponse;
  assert.equal(r.serial, null);
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).deviceState, 'none');
  assert.equal((await call('/v1/devices/stop', { method: 'POST', body: '{}' })).status, 409);
});

// --- the 503 gate -----------------------------------------------------------

test('device-less: exec/elements/install answer 503 with exit code 3, not a silent failure', async () => {
  await start({ serial: null, deviceControl: { allowedTargets: ['Pixel_6'] } });
  for (const p of ['/v1/exec', '/v1/elements', '/v1/logs', '/v1/install']) {
    const res = await call(p, { method: 'POST', body: '{}' });
    assert.equal(res.status, 503, p);
    const body = (await res.json()) as { error: string; exitCode: number };
    assert.equal(body.exitCode, 3);
    assert.match(body.error, /vk devices start --server/);
  }
});

test('device-less: /v1/health still answers, so a client can see what to do', async () => {
  await start({ serial: null, deviceControl: { allowedTargets: ['Pixel_6'] } });
  assert.equal((await call('/v1/health')).status, 200);
});

// --- listing ----------------------------------------------------------------

test('devices list: without an allowlist, only the bound device is disclosed', async () => {
  const { lc } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const r = (await (await call('/v1/devices')).json()) as DeviceListResponse;
  assert.deepEqual(r.devices.map((d) => d.serial), ['emulator-5554']);
  assert.deepEqual(r.startable, []);
  assert.equal(r.bound, 'emulator-5554');
});

test('devices list: an allowlist discloses those names, never the whole host', async () => {
  const { lc } = fakeLifecycle();
  await start({ deviceControl: { allowedTargets: ['Pixel_6'] }, lifecycle: lc });
  const r = (await (await call('/v1/devices')).json()) as DeviceListResponse;
  assert.deepEqual(r.devices.map((d) => d.name), ['Pixel_6']);
  assert.ok(!r.devices.some((d) => d.name === 'Secret_AVD'), 'other AVDs on the host stay private');
});
