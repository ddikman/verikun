// Policy tests for `vk server`'s device-control gate. buildServer has no device
// dependency once `lifecycle` and `makeDriver` are injected, so the whole matrix —
// which is where a regression would actually be dangerous — runs without a device.

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { request, ClientRequest, Server } from 'node:http';
import { buildServer, parseDeviceControl, parseFailover, ServerConfig } from '../src/server';
import type { ServerLifecycle } from '../src/server-lifecycle';
import { parseDevicePool } from '../src/device/pool';
import type { DeviceHandle, DevicePool } from '../src/server-pool';
import { executeForServer } from '../src/cli';
import { describeError } from '../src/rpc';
import { setOutputQuiet } from '../src/output';
import type {
  DeviceOpResponse, DeviceListResponse, ExecResponse, HealthResponse, InstallResponse, LogsResponse, RpcErrorBody,
} from '../src/rpc';
import { readClaim } from '../src/device/claims';
import type { DeviceInfo, Driver } from '../src/types';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceGoneError, CliError, NoWindowError } from '../src/errors';
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

/** Bring a fake device back from the dead, so a test can assert the reconciler re-adopts it.
 *  The real thing needs no such hook: `adopt` probes the actual phone, which either answers
 *  again or does not. Set by `fakePool`. */
let probeDevice: (serial: string) => boolean = () => true;
let reviveDevice: (serial: string) => void = () => undefined;
/** Throwaway $HOME for the host-global claim store — failover claims for real. */
const claimHome = mkdtempSync(join(tmpdir(), 'vk-server-claims-'));

/**
 * An in-memory stand-in for the worker pool.
 *
 * Each device delegates to a `makeDriver(fakes[serial])`, so a test gives a device a
 * distinguishable answer exactly as it did through the old `makeDriver` seam — and
 * `madeDrivers` still records every serial the pool brought up, which is what the
 * rebind and failover assertions read.
 */
function fakePool(
  serials: string[],
  fakes: Record<string, Partial<Driver>>,
  /** Lets a test hold an install open and assert what other clients can do meanwhile. */
  onInstall?: (serial: string, path: string) => Promise<void>,
  /** Serial whose worker dies on first use. */
  dies?: string,
): DevicePool {
  const live = new Map<string, DeviceHandle>();
  /** Serials whose worker has died: like WorkerHandle's `dead` latch, EVERY later call
   *  on that handle rejects, including the probe failover uses to confirm the death. */
  const deceased = new Set<string>();
  const revived = new Set<string>();
  reviveDevice = (serial: string) => { deceased.delete(serial); revived.add(serial); };
  probeDevice = (serial: string) => {
    if (deceased.has(serial)) return false;
    if (revived.has(serial)) return true;
    try { fakes[serial]?.preflight?.(); return true; } catch { return false; }
  };
  let lossListener: ((serial: string, why: string) => void) | undefined;
  const handleFor = (serial: string): DeviceHandle => {
    const driver = makeDriver({ resolvedSerial: () => serial, ...(fakes[serial] ?? {}) });
    return {
      serial,
      // The real thing, minus the thread: `executeForServer` is exactly what a worker
      // runs, so every command path — selector resolution, the errors failover
      // classifies — behaves here as it does in production.
      exec: async (req) => {
        if (dies === serial) {
          // Exactly what WorkerHandle.die does: leave the pool first, reject second. The
          // ordering is the whole point — a guard that tests pool membership in the catch
          // would already see this device gone.
          deceased.add(serial);
          live.delete(serial);
          // …and, exactly as `WorkerDevicePool.forget` does, tell the server so it can
          // hand back the claim and the companion. Synchronously, before the rejection.
          lossListener?.(serial, 'worker exited with code 1');
          throw new CliError(`device ${serial} is no longer available (worker exited with code 1)`, 3);
        }
        const r = await executeForServer(req.command, req.positionals, req.flags, driver, 'android');
        // Mirror the worker boundary: structured clone downgrades every Buffer to a
        // plain Uint8Array, and `Uint8Array.toString('base64')` silently ignores its
        // argument. A fake that hands back real Buffers hides that entirely.
        const cloned: Record<string, Buffer> = {};
        for (const [rel, b] of Object.entries(r.artifacts ?? {})) {
          cloned[rel] = new Uint8Array(b) as unknown as Buffer;
        }
        return {
          code: r.code,
          ...(r.error ? { error: describeError(r.error) } : {}),
          ...(r.step ? { step: r.step } : {}),
          ...(Object.keys(cloned).length ? { artifacts: cloned } : {}),
          ...(r.logStart ? { logStart: r.logStart } : {}),
        };
      },
      elements: async () => driver.getElements(),
      logs: async (opts) => driver.getLogs(opts),
      install: async (path) => {
        if (onInstall) return onInstall(serial, path);
        driver.install(path);
      },
      reads: async () => driver.hierarchySource?.() ?? null,
      preflight: async () => {
        if (deceased.has(serial)) {
          throw new CliError(`device ${serial} is no longer available (worker exited with code 1)`, 3);
        }
        if (!revived.has(serial)) driver.preflight();
      },
      dispose: async () => undefined,
    };
  };
  for (const s of serials) live.set(s, handleFor(s));
  return {
    serials: () => [...live.keys()],
    get: (serial) => live.get(serial),
    async adopt(serial) {
      if (live.has(serial)) return true;
      madeDrivers.push(serial);
      try {
        // Mirror WorkerHandle.start: the device is probed and only THEN inserted. That
        // ordering is what opens the concurrency window a real pool has — insert-first
        // would close it here and hide the very race this fake exists to expose.
        const handle = handleFor(serial);
        await handle.preflight(); // a real worker refuses to start on a bad probe
        // Starting a worker really does take a while — a thread plus an adb round trip.
        // The delay is what makes the concurrency window deterministic here instead of
        // depending on how many microtasks two requests happen to be apart.
        await new Promise((r) => setTimeout(r, 20));
        live.set(serial, handle);
        return true;
      } catch {
        live.delete(serial);
        return false;
      }
    },
    retire(serial) {
      live.delete(serial); // synchronous, exactly as WorkerDevicePool.retire
    },
    onLoss(cb) {
      lossListener = cb;
    },
    async rebind(serial) {
      if (serial === null) {
        live.clear();
        return;
      }
      madeDrivers.push(serial);
      // SWAP OR NOTHING, mirroring WorkerDevicePool.rebind: the replacement must be
      // serving before the outgoing handles go, and a probe that throws must leave the
      // pool as it was. A fake that cleared first and could never fail asserted nothing
      // about the ordering the real one calls load-bearing.
      const handle = handleFor(serial);
      await handle.preflight();
      live.clear();
      live.set(serial, handle);
    },
    async disposeAll() {
      live.clear();
    },
  };
}

/** Harness-only knobs, translated into a pool before buildServer sees the config. */
type StartOpts = Partial<Omit<ServerConfig, 'pool'>> & {
  /** null = a server that came up with no device. */
  serial?: string | null;
  /** Behaviour for the STARTING device — the old `driver:` key, unchanged at call sites. */
  driver?: Partial<Driver>;
  /** More than one device: a pool. */
  serials?: string[];
  /** Hold every install open until the returned promise settles. */
  onInstall?: (serial: string, path: string) => Promise<void>;
  /** This device's worker DIES on its first exec — removed from the pool synchronously
   *  (as `onDeath` does) and only then rejecting, which is the production ordering. */
  dies?: string;
};

const DEFAULT_SERIAL = 'emulator-5554';

/** Boot a server on an ephemeral port for one test and point `base` at it. */
async function start(
  opts: StartOpts = {},
  /** Per-serial Driver overrides for devices the pool brings up later. Lets a test give
   *  each device a distinguishable answer and assert WHICH one a handler read. */
  fakes: Record<string, Partial<Driver>> = {},
): Promise<void> {
  for (const hold of holds.values()) hold.req.destroy();
  holds.clear();
  if (server) server.close();
  madeDrivers.length = 0;
  const { serial, driver, serials, onInstall, dies, ...config } = opts;
  const starting = serials ?? (serial === null ? [] : [serial ?? DEFAULT_SERIAL]);
  server = buildServer({
    platform: 'android',
    lifecycle: fakeLifecycle().lc,
    probeGraceMs: 0,
    installAttemptMs: 500,
    probe: async serial => probeDevice(serial),
    now: () => config.reconcileMs && config.reconcileMs > 0 ? Date.now() * 1000 : Date.now(),
    authKey: KEY,
    allowInstall: false,
    claimOpts: { home: claimHome },
    pool: fakePool(starting, { ...(driver ? { [starting[0] ?? DEFAULT_SERIAL]: driver } : {}), ...fakes }, onInstall, dies),
    ...config,
  });
  // listen() is async: address() stays null until 'listening' fires.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(probe: () => Promise<boolean>, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const capacity = async (): Promise<number> => ((await (await call('/v1/health')).json()) as HealthResponse).capacity ?? 0;

const holds = new Map<string, { req: ClientRequest; body: unknown; url: string }>();
const holding = (token: string, headers: Record<string,string>): Promise<Response> => {
  if ([...holds.values()].some(h=>h.url!==base)) { for(const h of holds.values()) h.req.destroy(); holds.clear(); }
  const existing = holds.get(token);
  if (existing) return Promise.resolve(new Response(JSON.stringify(existing.body),{status:200}));
  return new Promise((resolve,reject) => {
    const req = request(`${base}/v1/lease`, {method:'POST',headers:{...headers,'x-verikun-run':token,'x-verikun-hold':'1','x-verikun-wait-ms':'0'}}, res => {
      let body='';res.setEncoding('utf8');
      res.on('data', chunk => {
        body+=chunk;
        if(res.statusCode===200 && body.includes('\n') && !holds.has(token)) {
          const parsed=JSON.parse(body.split('\n')[0]); holds.set(token,{req,body:parsed,url:base});
          resolve(new Response(JSON.stringify(parsed),{status:200}));
        }
      });
      res.on('end',()=>{ req.destroy(); if(holds.get(token)?.req===req) holds.delete(token); if(res.statusCode!==200) {resolve(new Response(body,{status:res.statusCode}));} });
      res.on('error',()=>{if(holds.get(token)?.req===req)holds.delete(token);});
    });
    req.on('error',reject);req.flushHeaders();req.write('.');
  });
};
const call = async (path: string, init: RequestInit & { token?: string } = {}): Promise<Response> => {
  if ([...holds.values()].some(h=>h.url!==base)) {for(const h of holds.values()) h.req.destroy();holds.clear();}
  const token=init.token??'run-A';
  const headers={authorization:`Bearer ${KEY}`,'x-verikun-run':token,...init.headers as Record<string,string>};
  if (path==='/v1/lease') return holding(token,headers);
  if (['/v1/exec','/v1/elements','/v1/logs'].includes(path) && !holds.has(token)) await holding(token,headers);
  const res=await fetch(`${base}${path}`,{...init,headers});
  if(path==='/v1/release') { holds.get(token)?.req.destroy();holds.delete(token); }
  return res;
};

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
  for (const hold of holds.values()) hold.req.destroy();
  holds.clear();
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
  assert.equal(((await (await call('/v1/health')).json()) as HealthResponse).quarantined, undefined, 'an artifact rejected everywhere does not convict a device');

  // fakeLifecycle.restart answers 'emulator-5556'; restart the QUARANTINED one by name.
  await call('/v1/devices/restart', { method: 'POST', body: JSON.stringify({ target: 'emulator-5554' }) });
  const h = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(h.quarantined, undefined, 'a power cycle is the fix, and doing one asserts it worked');
});

test('elements: a failed read names the error CLASS on the wire, not just its text', async () => {
  // Issue #80. `/v1/exec` has carried an ErrorDescriptor on its 200s from the start; every
  // other route answered with a status code and a message, so the client rebuilt a bare
  // CliError. The `vk ai` guard decides "the app is still drawing" vs "the box is broken" on
  // this class alone, so without the field every --server run read a mid-launch gap as fatal.
  await start({ driver: makeDriver({ getElements: () => { throw new NoWindowError(); } }) });
  const r = await call('/v1/elements', { method: 'POST', body: '{}' });
  assert.equal(r.status, 500);
  const body = (await r.json()) as RpcErrorBody;
  assert.equal(body.errorKind, 'NoWindowError', 'the subclass, not the CliError it extends');
  assert.equal(body.exitCode, 3, 'unchanged — a caller with no budget still exits 3');
  assert.equal((body as unknown as Record<string,unknown>).deviceChanged, undefined, 'no failover here: this is the plain throw arm');
});

test('elements: a server-raised failure omits errorKind rather than inventing one', async () => {
  // The 503 gate is the server\'s own verdict, with no wrapped driver error behind it. An
  // absent field is what an older server sends too, so both read the same to a client.
  await start({ serial: null });
  const r = await call('/v1/elements', { method: 'POST', body: '{}' });
  assert.equal(r.status, 503);
  const body = (await r.json()) as RpcErrorBody;
  assert.equal(body.errorKind, undefined);
  assert.equal(body.exitCode, 3);
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
  assert.equal((body as unknown as Record<string,unknown>).deviceChanged, undefined);
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

// --- the device pool: capacity, leases, and how failover reaches one ---------

test('parseDevicePool: all / all-android / all-ios and explicit serial lists', () => {
  assert.equal(parseDevicePool({}), undefined);
  assert.deepEqual(parseDevicePool({ devices: 'all' }), { all: true, serials: [] });
  assert.deepEqual(parseDevicePool({ devices: 'all-ios' }), { all: true, serials: [], platform: 'ios' });
  assert.deepEqual(parseDevicePool({ devices: 'ALL-Android' }), { all: true, serials: [], platform: 'android' });
  assert.deepEqual(parseDevicePool({ devices: 'a, b ,a' }), { all: false, serials: ['a', 'b'] });
});

test('parseDevicePool: "all" plus named serials is a usage error, not a silent winner', () => {
  for (const bad of ['all,emulator-5554', 'all-ios,udid-1']) {
    assert.throws(
      () => parseDevicePool({ devices: bad }),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  }
});

test('parseDevicePool: a valueless or empty --devices is a usage error', () => {
  for (const bad of [true, '', ' , ']) {
    assert.throws(
      () => parseDevicePool({ devices: bad as string | true }),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  }
});

test('health: one device still reports its serial; a pool reports capacity and members', async () => {
  await start();
  const one = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(one.serial, 'emulator-5554', 'existing clients read this field');
  assert.equal(one.capacity, 1);

  await start({ serials: ['a', 'b', 'c'] });
  const many = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(many.capacity, 3);
  assert.deepEqual(many.devices, ['a', 'b', 'c']);
  assert.equal(many.serial, null, 'a pool has no single answer');
  assert.equal(many.deviceState, 'ready');
});

test('lease: a run token gets one device, and the SAME one on every later call', async () => {
  await start({ serials: ['a', 'b'] });
  const first = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-A' })).json()) as { serial: string };
  const again = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-A' })).json()) as { serial: string };
  assert.equal(again.serial, first.serial, 'affinity: a repair must land on the device the run started on');
});

test('lease: a second run token gets a DIFFERENT device from the pool', async () => {
  await start({ serials: ['a', 'b'] });
  const a = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-A' })).json()) as { serial: string };
  const b = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-B' })).json()) as { serial: string };
  assert.notEqual(a.serial, b.serial);
});

test('lease: an exhausted FIFO wait is 503, and releasing frees the device immediately', async () => {
  await start({ serials: ['a', 'b'] });
  for (const token of ['run-A', 'run-B']) {
    assert.equal((await call('/v1/lease', { method: 'POST', body: '{}', token })).status, 200);
  }
  const busy = await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-C' });
  assert.equal(busy.status, 503);
  assert.match(((await busy.json()) as { error: string }).error, /lease wait window/);
  await call('/v1/release', { method: 'POST', body: '{}', token: 'run-A' });
  assert.equal((await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-C' })).status, 200);
});

test('logs: served from the LEASED device, not one captured at startup', async () => {
  await start({ serials: ['a', 'b'] }, { a: { getLogs: () => 'FROM-A' }, b: { getLogs: () => 'FROM-B' } });
  const leased = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-A' })).json()) as { serial: string };
  const r = (await (await call('/v1/logs', { method: 'POST', body: '{}', token: 'run-A' })).json()) as LogsResponse;
  assert.equal(r.logs, leased.serial === 'a' ? 'FROM-A' : 'FROM-B');
});

test('device control: a pooled server refuses mutations rather than guessing a device', async () => {
  const { lc } = fakeLifecycle();
  await start({ serials: ['a', 'b'], deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const res = await call('/v1/devices/restart', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /pools 2 devices/);
  assert.equal((await call('/v1/devices')).status, 200, 'the read-only listing stays available');
});

test('install: reaches EVERY device, or the later lanes would run the previous build', async () => {
  const installed: string[] = [];
  const seen = (serial: string) => ({ install: () => void installed.push(serial) });
  await start(
    { serials: ['a', 'b', 'c'], allowInstall: true },
    { a: seen('a'), b: seen('b'), c: seen('c') },
  );
  const res = await install();
  assert.equal(res.status, 200);
  assert.deepEqual(installed.sort(), ['a', 'b', 'c']);
  assert.deepEqual(((await res.json()) as { devices: string[] }).devices.sort(), ['a', 'b', 'c']);
});

test('install: a hanging device hits its own deadline and leaves while healthy installs finish', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('hung', 'healthy') });
  await start({
    serials: ['hung', 'healthy'],
    poolSpec: { all: false, serials: ['hung', 'healthy'] },
    reconcileMs: 0,
    allowInstall: true,
    failover: { allowedTargets: [] },
    lifecycle: lc,
    installAttemptMs: 20,
    onInstall: (serial) => serial === 'hung' ? new Promise<void>(() => undefined) : Promise.resolve(),
  });

  const res = await install();
  assert.equal(res.status, 200, 'one wedged device does not hold the fan-out open');
  const body = (await res.json()) as InstallResponse;
  assert.deepEqual(body.devices, ['healthy']);
  assert.deepEqual(body.skipped?.map((s) => s.serial), ['hung']);
  assert.match(body.skipped![0].reason, /per-device deadline/);

  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.deepEqual(health.devices, ['healthy']);
  assert.equal(health.quarantined?.some((q) => q.serial === 'hung'), true);
});

test('install: all-device timeouts keep their quarantines instead of blaming the build', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('hung-a', 'hung-b') });
  await start({
    serials: ['hung-a', 'hung-b'],
    poolSpec: { all: false, serials: ['hung-a', 'hung-b'] },
    reconcileMs: 0,
    allowInstall: true,
    failover: { allowedTargets: [] },
    lifecycle: lc,
    installAttemptMs: 20,
    onInstall: () => new Promise<void>(() => undefined),
  });

  assert.equal((await install()).status, 500);
  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(health.capacity, 0);
  assert.deepEqual(health.quarantined?.map((q) => q.serial).sort(), ['hung-a', 'hung-b']);
});

test('install: a timeout with failover disabled still releases the dead lane', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('hung') });
  await start({
    serials: ['hung'],
    poolSpec: { all: false, serials: ['hung'] },
    reconcileMs: 0,
    allowInstall: true,
    lifecycle: lc,
    installAttemptMs: 20,
    onInstall: () => new Promise<void>(() => undefined),
  });

  assert.equal((await install()).status, 500);
  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(health.capacity, 0);
  assert.equal(health.quarantined?.some((q) => q.serial === 'hung'), true);
});

test('install: refused while another run holds a device', async () => {
  await start({ serials: ['a', 'b'], allowInstall: true });
  await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-A' });
  assert.equal((await install('run-B')).status, 409);
});

test('install: holds the WHOLE pool, so no run can start on a device mid-swap', async () => {
  // A single lease cannot express this: the installer would hold one device while writing
  // a binary to all of them, and another token would happily take devices 2..N and run
  // steps straight through the build change — green, and wrong.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await start({ serials: ['a', 'b', 'c'], allowInstall: true, onInstall: () => held });

  const installing = install('run-A');
  await new Promise((r) => setTimeout(r, 20)); // let the install reach the devices

  for (const path of ['/v1/lease', '/v1/exec']) {
    const res = await call(path, { method: 'POST', body: '{}', token: 'run-B' });
    assert.equal(res.status, path === '/v1/lease' ? 503 : 409, `${path} must not start a run mid-install`);
  }

  release();
  assert.equal((await installing).status, 200);
  // …and the moment it finishes, the other devices are available again.
  assert.equal((await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-B' })).status, 200);
});

test('install: a failure still hands the pool back', async () => {
  let reject!: (e: Error) => void;
  const held = new Promise<void>((_r, rj) => { reject = rj; });
  await start({ serials: ['a', 'b'], allowInstall: true, onInstall: () => held });
  const installing = install('run-A');
  await new Promise((r) => setTimeout(r, 20));
  reject(new CliError('adb: device offline', 3));
  assert.notEqual((await installing).status, 200);
  assert.equal(
    (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-B' })).status,
    200,
    'a crashed install must not wedge the server',
  );
});

test('health: the read path comes from the worker handshake, not a live device call', () => {
  // The non-blocking property this pins the VALUE half of — that health answers from a
  // cached read path rather than asking a device — cannot be asserted through this seam:
  // the blocking lives in WorkerHandle, below the injected pool, where the worker thread
  // sits in a spawnSync for the whole of an exec. That half is verified on hardware by
  // timing /v1/health against a device mid-step.
  return start({ driver: { hierarchySource: () => ({ path: 'companion', detail: 'ready app held' }) } }).then(
    async () => {
      const h = (await (await call('/v1/health')).json()) as HealthResponse;
      assert.equal(h.reads?.path, 'companion');
      assert.equal(h.reads?.detail, 'ready app held');
    },
  );
});

// --- the worker boundary ----------------------------------------------------

test('exec: artifacts survive the worker boundary as real base64', async () => {
  // Structured clone turns Buffer into Uint8Array, whose toString IGNORES its encoding
  // argument — so an unguarded encode ships "137,80,78,71,…" with a 200 and no error, and
  // every remote screenshot archives as a file nothing can open.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await start({ driver: { screenshot: () => png } });
  const r = await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'screenshot', positionals: [], flags: {} }),
  });
  const body = (await r.json()) as ExecResponse;
  const encoded = Object.values(body.artifacts ?? {})[0];
  assert.ok(encoded, 'the screenshot step should attach an artifact');
  assert.ok(!encoded.includes(','), `expected base64, got ${encoded.slice(0, 40)}`);
  assert.deepEqual(Buffer.from(encoded, 'base64'), png, 'the bytes must round-trip exactly');
});

test('device control: the device is HELD for the whole operation, not just checked', async () => {
  let finish!: () => void;
  const restarting = new Promise<void>((r) => { finish = r; });
  const { lc } = fakeLifecycle({
    async restart() { await restarting; return { serial: 'emulator-5554' }; },
  });
  await start({ deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const op = call('/v1/devices/restart', { method: 'POST', body: '{}', token: 'run-A' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-B' })).status,
    503,
    'a racing run must not be handed a device mid power-cycle',
  );
  finish();
  assert.equal((await op).status, 200);
  assert.equal((await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-B' })).status, 200);
});

test('exec: a step whose worker DIED marks the eviction on the error body too', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start({
    serials: ['a', 'b'], poolSpec: { all: false, serials: ['a', 'b'] }, reconcileMs: 0,
    failover: { allowedTargets: [] }, lifecycle: lc, dies: 'a',
  });
  const leased = (await (await call('/v1/lease', { method: 'POST', body: '{}', token: 'run-1' })).json()) as { serial: string };
  assert.equal(leased.serial, 'a');
  const res = await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
    token: 'run-1',
  });
  assert.equal(res.status, 500, "the step keeps the dead worker's own error");
  const body = (await res.json()) as RpcErrorBody;
  assert.equal((body as unknown as Record<string,unknown>).evicted,undefined,'the compatibility field is removed');
  assert.match(body.error, /no longer available/);
});

test('install: refused while a device-control op holds the server', async () => {
  // `othersActive` must respect the exclusive latch: a control op holds every device but
  // need hold no ordinary lease, so a check that only reads `leases` would let an install
  // land on a phone mid power-cycle.
  let finish!: () => void;
  const restarting = new Promise<void>((r) => { finish = r; });
  const { lc } = fakeLifecycle({
    async restart() { await restarting; return { serial: 'emulator-5554' }; },
  });
  await start({ allowInstall: true, deviceControl: { allowedTargets: [] }, lifecycle: lc });
  const op = call('/v1/devices/restart', { method: 'POST', body: '{}', token: 'run-A' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await install('run-B')).status, 409, 'no install during a power-cycle');
  finish();
  assert.equal((await op).status, 200);
});

// --- leases: a run never silently changes phones ----------------------------


test('install: an empty pool is a 503, never a green install that installed nowhere', async () => {
  await start({ serials: [], allowInstall: true });
  const res = await install();
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /no device/i);
});




test('reconcile: a device whose worker died is re-adopted once it answers again', async () => {
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start({
    serials: ['a', 'b'],
    poolSpec: { all: false, serials: ['a', 'b'] },
    reconcileMs: 10,
    failover: { allowedTargets: [] },
    lifecycle: lc,
    dies: 'a',
  });
  await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
    token: 'run-A',
  });
  await until(async () => (await capacity()) === 1, 'the dead device to leave the pool');

  // While it is still dead the sweep keeps failing — and must not wedge or crash the server.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await capacity(), 1, 'a device that is still broken does not come back');

  reviveDevice('a');
  await until(async () => (await capacity()) === 2, 'the recovered device to rejoin');
});

test('reconcile: an explicit --devices list never grows beyond the serials named', async () => {
  // `all` re-enumerates and may legitimately pick up a device attached after startup; a
  // named list is a promise about which phones this server touches.
  //
  // Failover is OFF here so the sweep is the only thing that can change the pool. Failover
  // moving onto an unnamed spare is a separate, deliberate liberty (`--allow-failover` with
  // no targets means any attached device) and would otherwise mask what this pins.
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b', 'c') });
  await start({
    serials: ['a', 'b'],
    poolSpec: { all: false, serials: ['a', 'b'] },
    reconcileMs: 10,
    lifecycle: lc,
    dies: 'a',
  });
  await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
    token: 'run-A',
  });
  await until(async () => (await capacity()) === 1, 'the dead device to leave');
  reviveDevice('a');
  await until(async () => (await capacity()) === 2, 'the named device to rejoin');
  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.deepEqual(health.devices?.slice().sort(), ['a', 'b'], "'c' was never asked for");
});

test('reconcile: rejoining clears the quarantine that ruled the device out', async () => {
  // Adoption IS the probe — a worker only reports ready once its own preflight passed — so
  // a device that comes back has produced better evidence than any TTL could.
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start(
    {
      serials: ['a', 'b'],
      poolSpec: { all: false, serials: ['a', 'b'] },
      reconcileMs: 10,
      failover: { allowedTargets: [] },
      lifecycle: lc,
      dies: 'a',
    },
    { a: deadDevice() },
  );
  await call('/v1/exec', {
    method: 'POST',
    body: JSON.stringify({ command: 'tap', positionals: ['text:Login'], flags: {} }),
    token: 'run-A',
  });
  await until(async () => (await capacity()) === 1, 'the dead device to leave');
  reviveDevice('a');
  await until(async () => (await capacity()) === 2, 'the device to rejoin');
  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(health.quarantined?.some((q) => q.serial === 'a') ?? false, false, 'no longer ruled out');
});

test('install: a build that fails on EVERY device condemns the build, not the pool', async () => {
  // Each per-device failover quarantines its own device on the way out, because the install
  // classifier moves by default on wordings it has never seen. Right for one device; applied
  // to all of them at once it condemns the whole pool for what is plainly a bad artifact.
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start(
    { serials: ['a', 'b'], allowInstall: true, failover: { allowedTargets: [] }, lifecycle: lc },
    { a: installFails('surprising new adb wording'), b: installFails('surprising new adb wording') },
  );
  assert.equal((await install()).status, 500);
  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.equal(health.quarantined, undefined, 'no device was ruled out for a bad build');
  assert.equal(health.capacity, 2, 'and the pool kept its capacity');
});

test('install: a PARTIAL failure succeeds, and the device that missed the build leaves the pool', async () => {
  // A 500 for the whole pool is what turned one detached phone into a dead CI job (#139) —
  // two healthy devices had taken the build and the run died anyway, at the install step,
  // having already paid for an app build.
  //
  // The fan-out's own objection is the real one and it is answered, not softened: a lane
  // dealt a device that missed this build would run the PREVIOUS one and report green. So
  // that device is no longer leasable.
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start(
    {
      serials: ['a', 'b'],
      poolSpec: { all: false, serials: ['a', 'b'] },
      reconcileMs: 0,
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
    },
    { a: installFails('INSTALL_FAILED_INSUFFICIENT_STORAGE'), b: { install: () => undefined } },
  );
  const r = await install();
  assert.equal(r.status, 200, 'the devices that took the build are a success, not a failure');
  const body = (await r.json()) as InstallResponse;
  assert.deepEqual(body.devices, ['b'], 'named: what actually holds this build');
  assert.deepEqual(body.skipped?.map((x) => x.serial), ['a']);
  assert.match(body.skipped![0].reason, /INSUFFICIENT_STORAGE/, 'and why, so the operator knows which phone to go and look at');

  const health = (await (await call('/v1/health')).json()) as HealthResponse;
  assert.deepEqual(health.devices, ['b']);

  // The guard that makes the 200 honest: PROVABLY unleasable, not merely noted.
  for (const t of ['run-A', 'run-B', 'run-C']) {
    const lease = await call('/v1/lease', { method: 'POST', body: '{}', token: t });
    if (lease.ok) assert.equal(((await lease.json()) as { serial: string }).serial, 'b');
  }
});

test('install: a partial build is RETAINED, so a device that rejoins gets it and not the one before', async () => {
  // `retainInstall` used to run only on a clean sweep. With a partial install answering 200,
  // that would leave `lastInstall` holding the PREVIOUS build — and `rejoinDevice` installs
  // `lastInstall` before dealing any work, so every readmitted device would come back
  // running the build the fan-out exists to stop it running. `rejoinDevice`'s own check
  // cannot catch it: an install that succeeds is all it can see.
  const seen: Record<string, string[]> = { a: [], b: [] };
  const records = (serial: string): Partial<Driver> => ({
    install: (path: string) => void seen[serial].push(readFileSync(path, 'utf8')),
  });
  let failOnA = true;
  const { lc } = fakeLifecycle({ list: () => attached('a', 'b') });
  await start(
    {
      serials: ['a', 'b'],
      poolSpec: { all: false, serials: ['a', 'b'] },
      reconcileMs: 10,
      allowInstall: true,
      failover: { allowedTargets: [] },
      lifecycle: lc,
    },
    {
      a: {
        install: (path: string) => {
          if (failOnA) throw new CliError('Failed to install: INSTALL_FAILED_INSUFFICIENT_STORAGE', 3);
          seen.a.push(readFileSync(path, 'utf8'));
        },
      },
      b: records('b'),
    },
  );
  const r = await call('/v1/install', {
    method: 'POST',
    body: 'BUILD-2',
    token: 'run-A',
    headers: { 'x-verikun-ext': 'apk' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.b, ['BUILD-2']);
  await until(async () => (await capacity()) === 1, "'a' to leave without the build");

  // Now the disk is free and the sweep can have it back.
  failOnA = false;
  await until(async () => (await capacity()) === 2, "'a' to rejoin");
  assert.deepEqual(seen.a, ['BUILD-2'], 'brought up to the build its sibling is running');
});

const deadDevice = (): Partial<Driver> => ({
  getElements: () => { throw new DeviceGoneError("device 'emulator-5554' not found"); },
  preflight: () => { throw new DeviceGoneError("device 'emulator-5554' not found"); },
});

test('typed loss: the failed step is never replayed or remapped, even with a spare', async () => {
  let otherCalls = 0;
  const {lc} = fakeLifecycle({list: () => attached('a', 'b', 'spare')});
  await start({ serials: ['a', 'b'], lifecycle: lc, reconcileMs: 0, failover: {allowedTargets: []} }, {
    a: { tap: () => { throw new DeviceGoneError('error: closed'); }, preflight: () => { throw new DeviceGoneError('offline'); } },
    b: { tap: () => { otherCalls++; } },
  });
  const res = await call('/v1/exec', {method: 'POST', body: JSON.stringify({command: 'tap', positionals: [], flags: {at: '1,1'}})});
  const body = await res.json() as ExecResponse;
  assert.equal(body.code, 3); assert.equal(body.error?.kind, 'DeviceGoneError');
  assert.equal((body as unknown as Record<string,unknown>).evicted,undefined,'the compatibility field is removed'); assert.equal((body as unknown as Record<string,unknown>).deviceChanged, undefined);
  assert.equal(otherCalls, 0);
  assert.equal((await call('/v1/lease', {method: 'POST', body: '{}'})).status, 409);
  assert.equal((await call('/v1/lease', {method: 'POST', body: '{}', token: 'fresh'})).status, 200);
  assert.deepEqual((await (await call('/v1/health')).json() as HealthResponse).devices, ['b']);
});
test('typed loss: a responding phone stays, but its failed holder is tombstoned', async () => {
  await start({reconcileMs: 0}, { [DEFAULT_SERIAL]: {tap: () => {throw new DeviceGoneError('error: closed');}} });
  const body = await (await call('/v1/exec', {method:'POST', body: JSON.stringify({command:'tap',positionals:[],flags:{at:'1,1'}})})).json() as ExecResponse;
  assert.equal((body as unknown as Record<string,unknown>).evicted,undefined,'the compatibility field is removed');
  const health = await (await call('/v1/health')).json() as HealthResponse;
  assert.equal(health.capacity, 1); assert.equal(health.quarantined, undefined);
  const next = await call('/v1/exec', {method:'POST',body: JSON.stringify({command:'home',positionals:[],flags:{}})});
  assert.equal(next.status,409); assert.equal((await next.json() as RpcErrorBody).errorKind,'RunEvictedError');
});
test('lease avoids the previous serial when another phone is ready', async () => {
  await start({serials:['a','b'],reconcileMs:0});
  const body = await (await call('/v1/lease', {method:'POST',body:'{}',headers:{'x-verikun-avoid':'a'}})).json() as {serial:string};
  assert.equal(body.serial,'b');
});
test('deadline: the client is answered while the call drains, with no second lease', async () => {
  let complete!: () => void;
  const blocking = new Promise<void>(r => complete=r);
  // install has its own deadline; an asynchronous fake exec makes the soft step deadline observable.
  const pool = fakePool(['a'], {});
  const h = pool.get('a')!;
  h.exec = async () => { await blocking; return {code:0}; };
  server.close();
  server=buildServer({platform:'android',authKey:KEY,allowInstall:false,pool,lifecycle:fakeLifecycle().lc,
    deadlineFloorMs:15, probeGraceMs:0, probe:async()=>true,reconcileMs:0});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res=await call('/v1/exec',{method:'POST',headers:{'x-verikun-deadline-ms':'1'},body:JSON.stringify({command:'home',positionals:[],flags:{}})});
  assert.equal(res.status,500);assert.match((await res.json() as RpcErrorBody).error,/deadline/);
  assert.equal((await call('/v1/lease',{method:'POST',body:'{}',token:'other'})).status,503);
  complete();
  await until(async()=>await capacity()===1,'drained call to become ready');
});

test('a timed-out install keeps its artifact until the original executor settles', async () => {
  let complete!: () => void;
  const blocked = new Promise<void>(resolve => { complete = resolve; });
  let path = '';
  await start({ allowInstall:true, reconcileMs:0, installAttemptMs:15,
    onInstall:(_serial,artifact) => { path = artifact; return blocked; } });
  try {
    assert.equal((await install()).status,500);
    assert.equal(await capacity(),0);
    assert.equal(existsSync(path),true,'the timed-out executor still needs its upload');
    complete();
    await until(async()=>!existsSync(path),'unused failed upload to be discarded');
  } finally { complete(); }
});

test('an old install straggler catches up to a newer build before dealing',async()=>{
  let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r);let bInstalls=0;
  const paths: string[] = [];
  const {lc}=fakeLifecycle({list:()=>attached('a','b')});
  await start({serials:['a','b'],poolSpec:{all:false,serials:['a','b']},lifecycle:lc,
    reconcileMs:5,allowInstall:true,installGraceMs:5,installAttemptMs:500,
    onInstall:(serial,path)=>{ paths.push(path); return serial==='b'&&++bInstalls===1?blocked:Promise.resolve(); }});
  try{
    assert.equal((await install()).status,200);
    const newer=await call('/v1/install',{method:'POST',body:'NEWER-APK',token:'run-A',headers:{'x-verikun-ext':'apk'}});
    assert.equal(newer.status,200);const sha=((await newer.json()) as InstallResponse).sha256;
    assert.equal(existsSync(paths[0]),true,'keep the old artifact while its install is still draining');
    unblock();await until(async()=>await capacity()===2,'old straggler to catch up');
    assert.equal(existsSync(paths[0]),false,'discard superseded artifacts after their last install finishes');
    assert.equal(existsSync(paths[paths.length-1]),true,'retain the current artifact for readmission');
    assert.ok(bInstalls>=2,'the old straggler installs currentBuild before returning');
    assert.equal(((await(await call('/v1/lease',{method:'POST',body:'{}',token:'run-B'})).json()) as {installedSha?:string}).installedSha,sha);
  }finally{unblock();}
});
