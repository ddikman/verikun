// Policy tests for `vk server`'s device-control gate. buildServer has no device
// dependency once `lifecycle` and `makeDriver` are injected, so the whole matrix —
// which is where a regression would actually be dangerous — runs without a device.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildServer, parseDeviceControl, parseFailover, ServerConfig, ServerLifecycle } from '../src/server';
import { setOutputQuiet } from '../src/output';
import type {
  DeviceOpResponse, DeviceListResponse, ExecResponse, HealthResponse, InstallResponse, LogsResponse, RpcErrorBody,
} from '../src/rpc';
import { readClaim } from '../src/device/claims';
import type { DeviceInfo, Driver } from '../src/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
/** Throwaway $HOME for the host-global claim store — failover claims for real. */
const claimHome = mkdtempSync(join(tmpdir(), 'vk-server-claims-'));

/** Boot a server on an ephemeral port for one test and point `base` at it. */
async function start(
  config: Partial<ServerConfig> = {},
  /** Per-serial Driver overrides for drivers the rebind seam builds. Lets a test give
   *  each device a distinguishable answer and assert WHICH one a handler read. */
  fakes: Record<string, Partial<Driver>> = {},
): Promise<void> {
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
      return makeDriver({ resolvedSerial: () => device, ...(fakes[device] ?? {}) });
    },
    claimOpts: { home: claimHome },
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

// Claims are host-global and $HOME-relative, and `executeForServer` heartbeats one on
// every /v1/exec — so leave them OFF process-wide here, or these tests would write into
// the developer's real ~/.verikun/devices. The one test that DOES exercise the failover
// claim hand-off re-enables them via claimOpts.env, pointed at a throwaway store.
const savedNoClaim = process.env.VERIKUN_NO_CLAIM;
before(() => {
  setOutputQuiet(true); // the server logs every request via err()
  process.env.VERIKUN_NO_CLAIM = '1';
});
after(() => {
  server?.close(); // without this, `node --test` hangs on the open handle
  if (savedNoClaim === undefined) delete process.env.VERIKUN_NO_CLAIM;
  else process.env.VERIKUN_NO_CLAIM = savedNoClaim;
  rmSync(claimHome, { recursive: true, force: true });
});

/** POST a build to /v1/install. The bytes are irrelevant — no test parses them. */
const install = (token = 'run-A') =>
  call('/v1/install', { method: 'POST', body: 'APKBYTES', token, headers: { 'x-verikun-ext': 'apk' } });

/** A driver whose install always fails the way adb would. */
const installFails = (adbOutput: string): Partial<Driver> => ({
  install: () => {
    throw new CliError(`Failed to install '/tmp/verikun-server/x.apk': ${adbOutput}`, 3);
  },
});

const attached = (...serials: string[]): DeviceInfo[] =>
  serials.map((serial) => ({ serial, state: 'device', platform: 'android' as const, kind: 'emulator' as const }));

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

// --- parseFailover ----------------------------------------------------------
//
// The polarity here is the opposite of parseDeviceControl's and that is the D2 decision:
// a server that auto-selected its device may auto-select again; one a human pinned may not.

test('parseFailover: absent and unpinned is ENABLED — the auto-selecting server may re-select', () => {
  const d = parseFailover({}, { env: {} });
  assert.deepEqual(d.policy, { allowedTargets: [] });
  assert.match(d.why, /ENABLED/);
});

test('parseFailover: a --device pin turns it off — the operator named the device', () => {
  const d = parseFailover({}, { pinned: true, env: {} });
  assert.equal(d.policy, undefined);
  assert.match(d.why, /--device pins/);
});

test('parseFailover: --allow-failover overrides a pin, and says where it may go', () => {
  assert.deepEqual(parseFailover({ 'allow-failover': true }, { pinned: true, env: {} }).policy, { allowedTargets: [] });
  const bounded = parseFailover({ 'allow-failover': 'emulator-5556, 032AY1UNR2 ' }, { pinned: true, env: {} });
  assert.deepEqual(bounded.policy, { allowedTargets: ['emulator-5556', '032AY1UNR2'] });
  assert.match(bounded.why, /may move to: emulator-5556, 032AY1UNR2/);
});

test('parseFailover: --allow-failover=<names> parses where flagBool would have said false', () => {
  // The exact trap parseDeviceControl documents: flagBool('allow-failover') is FALSE for
  // `--allow-failover=emulator-5556`, which would disable the feature for the one
  // spelling that bounds it.
  assert.notEqual(parseFailover({ 'allow-failover': 'emulator-5556' }, { env: {} }).policy, undefined);
});

test('parseFailover: an explicit off wins, from either channel', () => {
  assert.equal(parseFailover({ 'no-failover': true }, { env: {} }).policy, undefined);
  const byEnv = parseFailover({}, { env: { VERIKUN_NO_FAILOVER: '1' } });
  assert.equal(byEnv.policy, undefined);
  // Announced, so a host-level kill switch can never silently explain a server that
  // "won't fail over".
  assert.match(byEnv.why, /VERIKUN_NO_FAILOVER/);
});

test('parseFailover: contradictory flags are a usage error, not a silent winner', () => {
  assert.throws(
    () => parseFailover({ 'allow-failover': true, 'no-failover': true }, { env: {} }),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});

test('parseFailover: an empty list is a usage error, not a silent bare flag', () => {
  assert.throws(
    () => parseFailover({ 'allow-failover': ' , ' }, { env: {} }),
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

test('health: failoverEnabled reflects the policy, so a client can feature-detect', async () => {
  await start();
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).failoverEnabled, false);
  await start({ failover: { allowedTargets: [] } });
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).failoverEnabled, true);
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

// A rebind moves the DEVICE, so every handler must read through `bound.driver`. Both
// of these read `config.driver` before the fix — the startup one, pinned to a serial
// that may be gone. Failover would make that a routine lie rather than a rare one.

test('logs: served from the BOUND device, not the one the server started with', async () => {
  const { lc } = fakeLifecycle();
  await start(
    {
      deviceControl: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver({ getLogs: () => 'STARTUP-DEVICE' }),
    },
    { 'emulator-5556': { getLogs: () => 'REBOUND-DEVICE' } },
  );
  await call('/v1/devices/restart', { method: 'POST', body: '{}' });
  const r = (await (await call('/v1/logs', { method: 'POST', body: '{}' })).json()) as LogsResponse;
  assert.equal(r.logs, 'REBOUND-DEVICE', 'logs are evidence about the bound device, never another');
});

test('health: the read path follows a rebind, and is absent once nothing is bound', async () => {
  const { lc } = fakeLifecycle();
  await start(
    {
      deviceControl: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver({ hierarchySource: () => ({ path: 'stock', detail: 'startup device' }) }),
    },
    { 'emulator-5556': { hierarchySource: () => ({ path: 'companion', detail: 'rebound device' }) } },
  );
  await call('/v1/devices/restart', { method: 'POST', body: '{}' });
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.reads?.detail, 'rebound device');

  await call('/v1/devices/stop', { method: 'POST', body: '{}' });
  const gone = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(gone.reads, undefined, 'no device bound = no read path to report');
});

// --- install failover -------------------------------------------------------
//
// The reported bug (#99) and the polarity that fixes it. `install` is the ONE operation
// safe to replay elsewhere: idempotent, no app session, bytes already on server disk.

test('install: a device that cannot take the build hands off to one that can', async () => {
  const installed: string[] = [];
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': { install: (p: string) => void installed.push(p) } },
  );

  const r = await install();
  assert.equal(r.status, 200);
  const body = (await r.json()) as InstallResponse;
  assert.deepEqual(
    { from: body.deviceChanged?.from, to: body.deviceChanged?.to, retried: body.deviceChanged?.retried },
    { from: 'emulator-5554', to: 'emulator-5556', retried: true },
  );
  assert.match(body.deviceChanged!.reason, /out of space/);
  assert.equal(installed.length, 1, 'the build must actually reach the second device');
  assert.match(installed[0], /\.apk$/, 'and via the same server-side temp path — never re-uploaded');

  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.serial, 'emulator-5556', 'the binding moved, so the NEXT request lands healthy');
  assert.deepEqual(h.quarantined, [{ serial: 'emulator-5554', reason: h.quarantined![0].reason }]);
  assert.match(h.quarantined![0].reason, /INSTALL_FAILED_INSUFFICIENT_STORAGE/);
});

test('install: a failure nobody has ever seen still hands off', async () => {
  // End-to-end proof of the inversion: the server does not need to recognise a failure
  // to route around it. Without this, the feature only ever works for failures we have
  // already met — which is the opposite of what #99 asks for.
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('widget frobnicator exploded (code 71)')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  assert.equal((await install()).status, 200);
});

test('install: a broken build never burns the pool', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  const r = await install();
  assert.equal(r.status, 500);
  const body = (await r.json()) as RpcErrorBody;
  assert.equal(body.exitCode, 3);
  assert.match(body.error, /INSTALL_PARSE_FAILED_NO_CERTIFICATES/);
  assert.deepEqual(madeDrivers, [], 'a parse failure is identical on every device — do not try another');
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.quarantined, undefined, 'and blame no device for it');
});

test('install: with failover off, a full device still fails and nothing rebinds', async () => {
  // The D2 pin guard: `--device X` means what it says.
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start({
    allowInstall: true,
    lifecycle: lc,
    driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
  });
  assert.equal((await install()).status, 500);
  assert.deepEqual(madeDrivers, []);
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).serial, 'emulator-5554');
});

test('install: on exhaustion the client sees the FIRST failure, not the last', async () => {
  // This is what makes move-by-default safe. Reporting the last device's error would
  // hide the real cause behind whatever the final candidate happened to say — the exact
  // failure mode #99 names.
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': installFails('Failure [INSTALL_FAILED_SOMETHING_ELSE_ENTIRELY]') },
  );
  const body = (await (await install()).json()) as RpcErrorBody;
  assert.match(body.error, /INSTALL_FAILED_INSUFFICIENT_STORAGE/, 'the first device is the headline');
  assert.doesNotMatch(body.error, /SOMETHING_ELSE_ENTIRELY/);
  assert.match(body.error, /no working device remains/);
  assert.match(body.error, /vk devices restart/, 'and say what would clear it');
  assert.equal(body.deviceChanged?.to, 'emulator-5556', 'the binding still moved — say so');
});

test('install: a candidate that fails its probe is quarantined and skipped', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556', 'emulator-5558') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    {
      'emulator-5556': {
        preflight: () => {
          throw new CliError('device emulator-5556 is not ready (offline)', 3);
        },
      },
      'emulator-5558': { install: () => undefined },
    },
  );
  assert.equal((await install()).status, 200);
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.serial, 'emulator-5558');
  assert.deepEqual(h.quarantined?.map((q) => q.serial), ['emulator-5554', 'emulator-5556']);
  assert.match(h.quarantined![1].reason, /probe failed/);
});

test('install: the hop cap stops one request grinding through a whole broken pool', async () => {
  const tried: string[] = ['emulator-5554'];
  const { lc } = fakeLifecycle({
    list: () => attached('emulator-5554', 'e-2', 'e-3', 'e-4', 'e-5'),
  });
  const broken = (serial: string): Partial<Driver> => ({
    install: () => {
      tried.push(serial);
      throw new CliError(`Failed to install '/tmp/x.apk': Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]`, 3);
    },
  });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'e-2': broken('e-2'), 'e-3': broken('e-3'), 'e-4': broken('e-4'), 'e-5': broken('e-5') },
  );
  assert.equal((await install()).status, 500);
  assert.deepEqual(tried, ['emulator-5554', 'e-2', 'e-3'], '2 moves = 3 devices, then stop');
});

test('install: failover never moves outside the allowlist', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: ['emulator-9999'] }, // not attached
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  assert.equal((await install()).status, 500);
  assert.deepEqual(madeDrivers, [], 'an attached device outside the operator set is not a candidate');
});

test('install: a move never drops the device lock', async () => {
  // Power-cycling or repointing MY device is mine to do; another run must still be
  // held off. If the move released the lock, a racing job could take the device the
  // instant we moved onto it.
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      deviceControl: { allowedTargets: [] },
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  assert.equal((await install()).status, 200);
  assert.equal((await install('run-B')).status, 409, 'run-A still owns the device it moved to');
});

test('devices: a power cycle clears that device\'s quarantine', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      // Naming a target needs the allowlist form; a bare flag only acts on the bound device.
      deviceControl: { allowedTargets: ['emulator-5554'] },
      lifecycle: lc,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  await install();
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).quarantined?.length, 1);

  // fakeLifecycle.restart answers 'emulator-5556'; restart the QUARANTINED one by name.
  await call('/v1/devices/restart', { method: 'POST', body: JSON.stringify({ target: 'emulator-5554' }) });
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.quarantined, undefined, 'a power cycle is the fix, and doing one asserts it worked');
});

test('install: the claim moves with the binding, so no job is left holding a corpse', async () => {
  // claimOpts.env re-enables claims (the file disables them process-wide) against a
  // throwaway store. The ORDER is what matters: claim-new -> probe -> commit ->
  // release-old. Releasing first would leave this server bound to a device it no longer
  // holds, and a racing job would take it mid-request.
  const claims = { home: claimHome, env: {} as NodeJS.ProcessEnv };
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    {
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      claimOpts: claims,
      driver: makeDriver(installFails('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')),
    },
    { 'emulator-5556': { install: () => undefined } },
  );
  assert.equal((await install()).status, 200);
  assert.ok(readClaim('emulator-5556', claims), 'the device we moved to must be claimed');
  assert.equal(readClaim('emulator-5554', claims), null, 'and the one we left must be handed back');
});

// --- exec / elements: rebind, NEVER replay ----------------------------------
//
// The false-green guard. A step twelve deep presupposes the eleven before it ran on THIS
// device; device B's app is wherever an earlier run left it. Replaying would either find
// something matching and go green, or wake the repair model against the wrong screen.

const deadDevice = (): Partial<Driver> => ({
  getElements: () => {
    throw new CliError("Failed to capture UI hierarchy: adb: device 'emulator-5554' not found", 3);
  },
});

test('exec: a dead device rebinds, but the step still fails with ITS OWN error', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    { failover: { allowedTargets: [] }, lifecycle: lc, driver: makeDriver(deadDevice()) },
    { 'emulator-5556': {} },
  );
  const r = await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
  });
  assert.equal(r.status, 200, 'a command failure is a 200 carrying its exit code');
  const body = (await r.json()) as ExecResponse;
  assert.equal(body.code, 3);
  assert.match(body.error!.message, /not found/, "the OLD device's error, never a replay's");
  assert.equal(body.deviceChanged?.to, 'emulator-5556');
  assert.equal(body.deviceChanged?.retried, false, 'a mid-flow step is never replayed');
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).serial, 'emulator-5556');
});

test('exec: the command is NEVER executed on the device we moved to', async () => {
  // The single most important assertion here. If this ever passes with a non-zero count,
  // `vk ai` can report green having run half a flow on one phone and half on another.
  let touchedB = 0;
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    { failover: { allowedTargets: [] }, lifecycle: lc, driver: makeDriver(deadDevice()) },
    {
      'emulator-5556': {
        getElements: () => {
          touchedB++;
          return [];
        },
        tap: () => void touchedB++,
      },
    },
  );
  await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
  });
  assert.equal(touchedB, 0, 'the new device must not be touched by the step that caused the move');
});

test('elements: rebinds, but never answers with the new device\'s screen', async () => {
  let readB = 0;
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start(
    { failover: { allowedTargets: [] }, lifecycle: lc, driver: makeDriver(deadDevice()) },
    {
      'emulator-5556': {
        getElements: () => {
          readB++;
          return [];
        },
      },
    },
  );
  const r = await call('/v1/elements', { method: 'POST', body: '{}' });
  assert.equal(r.status, 500, 'a hierarchy from somewhere else is worse than an error');
  const body = (await r.json()) as RpcErrorBody;
  assert.equal(body.exitCode, 3);
  assert.equal(body.deviceChanged?.to, 'emulator-5556', 'but say the ground moved, so the client can re-ask');
  assert.equal(readB, 0);
});

test('exec: an app failure never moves device, however healthy the alternatives', async () => {
  // exit 1 is the app's verdict. Rotating on it would turn every failing assertion into
  // a device change, and #99 is explicit that a flaky mid-run device is the test rerun's
  // problem, not failover's.
  const { lc } = fakeLifecycle({ list: () => attached('emulator-5554', 'emulator-5556') });
  await start({ failover: { allowedTargets: [] }, lifecycle: lc, driver: makeDriver({ getElements: () => [] }) });
  const r = await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Nope'], flags: { 'no-wait': 'true' } }),
  });
  const body = (await r.json()) as ExecResponse;
  assert.equal(body.code, 1, 'selector miss');
  assert.equal(body.deviceChanged, undefined);
  assert.deepEqual(madeDrivers, []);
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
