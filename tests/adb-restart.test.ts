import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdbRestartOps,
  AdbRule,
  describeAdbRestart,
  devicePorts,
  hostRestartOps,
  parseForwardList,
  parseReverseList,
  restartLeakingAdb,
} from '../src/adb-restart';
import type { AdbPeer } from '../src/adb-health';
import type { DeviceClaim } from '../src/device/claims';
import type { DeviceInfo } from '../src/types';

const LEAKING = { pid: 15109, violations: 120, windowMs: 120_000, ageMs: 152 * 3_600_000 };
const usb: DeviceInfo = { serial: 'R58R42SGVNR', state: 'device', platform: 'android', kind: 'physical' };
const emu: DeviceInfo = { serial: 'emulator-5554', state: 'device', platform: 'android', kind: 'emulator' };
const wifi: DeviceInfo = { serial: '192.168.1.20:5555', state: 'device', platform: 'android', kind: 'physical' };
const rdb: AdbPeer = { pid: 43804, command: 'rdb', endpoint: '127.0.0.1:38665' };
const claim: DeviceClaim = {
  serial: 'emulator-5556', platform: 'android', cwd: '/w/curitiba-v1', pid: 98107, host: 'mac',
  processScoped: false, since: '2026-10-21T11:05:18.941Z', heartbeat: '2026-10-21T11:24:12.343Z', version: '0.33.0',
};

/**
 * A host whose `adb devices` answers come from `lists` (the first before the restart, the rest
 * after it; the last one repeats). `exclusive` mirrors recycleHostAdb's contract: the gate is
 * asked before the lock and again while holding it.
 */
function host(over: Partial<AdbRestartOps> & { lists?: DeviceInfo[][] } = {}) {
  const { lists = [[usb, emu]], ...rest } = over;
  const seen = { restarts: 0, connects: [] as string[], peerPorts: [] as number[][], remembered: [] as { pid: number; cleared: boolean }[] };
  let clock = 0;
  const ops: AdbRestartOps = {
    enabled: true,
    macos: true,
    health: LEAKING,
    devices: () => (lists.length > 1 ? lists.shift()! : lists[0]),
    claimBlockers: () => [],
    peers: (ports) => {
      seen.peerPorts.push(ports);
      return [];
    },
    exclusive: async (blocked, fn) => (blocked() || blocked() ? 'blocked' : (await fn()) ? 'restarted' : 'failed'),
    rules: () => ({ rules: [], unread: [] }),
    substitute: () => undefined,
    futile: () => undefined,
    settled: async () => ({ pid: 20928, violations: 0 }),
    remember: (verdict) => void seen.remembered.push(verdict),
    restore: () => true,
    restart: () => {
      seen.restarts++;
      return true;
    },
    connect: (serial) => void seen.connects.push(serial),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...rest,
  };
  return { ops, seen };
}

test('restartLeakingAdb: a healthy server is left alone', async () => {
  const { ops, seen } = host({ health: { pid: 15109, violations: 0, windowMs: 120_000 } });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'healthy' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: no evidence is never a reason — an unmeasurable host is not restarted', async () => {
  const { ops, seen } = host({ health: { pid: 15109 } });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'unmeasurable', why: 'log' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: an unmeasurable host says why — no server, or not macOS', async () => {
  assert.deepEqual(await restartLeakingAdb(host({ health: {} }).ops), { kind: 'unmeasurable', why: 'no-server' });
  assert.deepEqual(await restartLeakingAdb(host({ macos: false, health: { pid: 15109 } }).ops), {
    kind: 'unmeasurable',
    why: 'not-macos',
  });
});

test('restartLeakingAdb: VERIKUN_NO_ADB_RECYCLE wins even over a measured leak', async () => {
  const { ops, seen } = host({ enabled: false });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'disabled' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: another process on adb blocks the restart, and is named', async () => {
  const { ops, seen } = host({ peers: () => [rdb] });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'in-use', claims: [], peers: [rdb] });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: another vk job on a device blocks the restart, and is named', async () => {
  const { ops, seen } = host({ claimBlockers: () => [claim] });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'in-use', claims: [claim], peers: [] });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: when it cannot see who is connected, it does not restart', async () => {
  const { ops, seen } = host({ peers: () => undefined });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'unverifiable', why: 'connections' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: with claims switched off, verikun jobs cannot be seen, so it does not restart', async () => {
  // A `vk ai` waiting on a model repair holds no adb socket; only its claim says it is mid-flow.
  const { ops, seen } = host({ claimBlockers: () => undefined });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'unverifiable', why: 'claims' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: a known verikun blocker is named even when connections cannot be seen', async () => {
  const { ops } = host({ claimBlockers: () => [claim], peers: () => undefined });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'in-use', claims: [claim], peers: [] });
});

test('restartLeakingAdb: the first look never depends on the lock wiring', async () => {
  // Even an exclusive() that forgot to consult the gate must not restart past a known user.
  const { ops, seen } = host({ peers: () => [rdb], exclusive: async (_blocked, fn) => ((await fn()) ? 'restarted' : 'failed') });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'in-use', claims: [], peers: [rdb] });
  assert.equal(seen.restarts, 0);
});

test("restartLeakingAdb: an attached emulator's own link to adb is not counted as a user", async () => {
  // emulator-5554 is reached on its adb port, 5555; without it every host running an emulator
  // would refuse every restart.
  const { ops, seen } = host();
  await restartLeakingAdb(ops);
  assert.deepEqual(seen.peerPorts[0], [5555]);
});

test('restartLeakingAdb: restarts, redials wireless devices, and waits for every device to return', async () => {
  const { ops, seen } = host({ lists: [[usb, emu, wifi], [], [emu], [usb, emu, wifi]] });
  const r = await restartLeakingAdb(ops);
  assert.equal(seen.restarts, 1);
  // adb forgets an `adb connect` on restart, so a wireless device must be dialled again.
  assert.deepEqual(seen.connects, ['192.168.1.20:5555']);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.deepEqual(r.back, ['R58R42SGVNR', 'emulator-5554', '192.168.1.20:5555']);
  assert.deepEqual(r.missing, []);
});

test('restartLeakingAdb: an offline device is waited for too — on a leaking host that is the usual state', async () => {
  const offline: DeviceInfo = { ...usb, state: 'offline' };
  const unauthorized: DeviceInfo = { ...emu, serial: 'emulator-5556', state: 'unauthorized' }; // a human's job, not adb's
  const { ops } = host({ lists: [[offline, unauthorized], [usb, unauthorized]] });
  const r = await restartLeakingAdb(ops);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.deepEqual(r.back, ['R58R42SGVNR']);
  assert.deepEqual(r.missing, []);
});

test('restartLeakingAdb: forward and reverse rules come back with their device, or are named', async () => {
  // A restart drops every rule. Silently, that is a Metro reverse or a debugger forward that
  // stops working minutes later for no visible reason.
  const metro: AdbRule = { kind: 'reverse', serial: 'R58R42SGVNR', args: ['tcp:8081', 'tcp:8081'] };
  const companion: AdbRule = { kind: 'forward', serial: 'emulator-5554', args: ['tcp:8486', 'localabstract:verikun-companion'] };
  const busyPort: AdbRule = { kind: 'forward', serial: 'emulator-5554', args: ['tcp:9000', 'tcp:9000'] };
  const stranded: AdbRule = { kind: 'forward', serial: 'emulator-5556', args: ['tcp:9100', 'tcp:9100'] };
  const restored: AdbRule[] = [];
  const { ops } = host({
    lists: [[usb, emu, { ...emu, serial: 'emulator-5556' }], [usb, emu]],
    rules: () => ({ rules: [metro, companion, busyPort, stranded], unread: [] }),
    restore: (rule) => {
      restored.push(rule);
      return rule !== busyPort;
    },
  });
  const r = await restartLeakingAdb(ops, 2000);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.deepEqual(restored, [metro, companion, busyPort], 'nothing is re-applied to a device that did not return');
  assert.deepEqual(r.rules, { restored: 2, lost: [busyPort, stranded], unread: [] });
});

test('restartLeakingAdb: rules it could not even read are reported, not silently dropped', async () => {
  const { ops } = host({ rules: () => ({ rules: [], unread: ['R58R42SGVNR'] }) });
  const r = await restartLeakingAdb(ops);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.deepEqual(r.rules.unread, ['R58R42SGVNR']);
  assert.match(describeAdbRestart(r).join('\n'), /could not read .*R58R42SGVNR/);
});

test('restartLeakingAdb: a restart that could not use the server\'s own binary says which it used', async () => {
  const { ops } = host({ substitute: () => '/opt/homebrew/bin/adb (the server\'s own adb is gone)' });
  const r = await restartLeakingAdb(ops);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.match(describeAdbRestart(r).join('\n'), /\/opt\/homebrew\/bin\/adb/);
});

test('restartLeakingAdb: a device that never comes back is reported after the wait, not waited on forever', async () => {
  const { ops } = host({ lists: [[usb, emu], [emu]] });
  const r = await restartLeakingAdb(ops, 20_000);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.deepEqual(r.back, ['emulator-5554']);
  assert.deepEqual(r.missing, ['R58R42SGVNR']);
  assert.ok(r.ms >= 20_000 && r.ms < 21_000, `waited ${r.ms}ms`);
});

test('restartLeakingAdb: someone connecting while the lock was taken stops the restart', async () => {
  const answers: AdbPeer[][] = [[], [rdb]];
  const { ops, seen } = host({ peers: () => answers.shift() ?? [rdb] });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'in-use', claims: [], peers: [rdb] });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: another job already restarting adb is reported as such', async () => {
  // The lock is held elsewhere: recycleHostAdb returns without running the restart.
  const { ops, seen } = host({ exclusive: async () => 'busy' });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'busy' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: a store it cannot write is said as such, not as "busy"', async () => {
  const { ops, seen } = host({ exclusive: async () => 'unwritable' });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'unwritable' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: no device list means emulators cannot be told from users — no restart', async () => {
  // With no list, an emulator's own link would be named as a user ("qemu-system-aarch64").
  const { ops, seen } = host({ devices: () => undefined });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'unverifiable', why: 'devices' });
  assert.equal(seen.restarts, 0);
});

test('restartLeakingAdb: a server that does not come back is a failure', async () => {
  const { ops } = host({ restart: () => false });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'failed' });
});

test('hostRestartOps: the real lock consults the gate it is given', async () => {
  // Dropping that argument would fall back to the server's claims-only gate and skip the
  // connection check entirely, with every other test still green.
  const home = mkdtempSync(join(tmpdir(), 'vk-restart-wiring-'));
  try {
    const ops = hostRestartOps(LEAKING, { home, env: {}, cwd: '/w/this-job' });
    let ran = 0;
    assert.equal(await ops.exclusive(() => true, async () => { ran++; return true; }), 'blocked');
    assert.equal(ran, 0);
    assert.equal(await ops.exclusive(() => false, async () => { ran++; return true; }), 'restarted');
    assert.equal(ran, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseForwardList / parseReverseList: what to re-apply after a restart', () => {
  assert.deepEqual(parseForwardList('emulator-5554 tcp:47997 tcp:47996\nR58R42SGVNR tcp:8486 localabstract:verikun-companion\n\n'), [
    { kind: 'forward', serial: 'emulator-5554', args: ['tcp:47997', 'tcp:47996'] },
    { kind: 'forward', serial: 'R58R42SGVNR', args: ['tcp:8486', 'localabstract:verikun-companion'] },
  ]);
  // The first column of `reverse --list` is the device-side transport name, not a serial.
  assert.deepEqual(parseReverseList('emulator-5554', 'host-15 tcp:47999 tcp:47998\n\n'), [
    { kind: 'reverse', serial: 'emulator-5554', args: ['tcp:47999', 'tcp:47998'] },
  ]);
  assert.deepEqual(parseReverseList('emulator-5554', ''), []);
  // adb's own chatter is not a rule.
  assert.deepEqual(parseForwardList('* daemon not running; starting now at tcp:5037\n* daemon started successfully\n'), []);
});

test('restartLeakingAdb: violations that come straight back on the new server are recorded as not cleared', async () => {
  // MEASURED: a Samsung SM-A415F on adb's native USB backend makes even a fresh server throw
  // ~1/s from its first second. A restart cannot fix that, and must not pretend it did.
  const { ops, seen } = host({ settled: async () => ({ pid: 20928, violations: 3 }) });
  const r = await restartLeakingAdb(ops);
  assert.equal(r.kind, 'restarted');
  if (r.kind !== 'restarted') return;
  assert.equal(r.cleared, false);
  assert.deepEqual(seen.remembered, [{ pid: 20928, cleared: false }]);
  assert.match(describeAdbRestart(r).join('\n'), /came straight back/);
});

test('restartLeakingAdb: a restart that already failed to clear this server is not repeated', async () => {
  // Otherwise the skill restarts adb at every agent session for nothing, cutting every device.
  const { ops, seen } = host({ futile: () => ({ at: '2026-10-23T23:55:52.000Z' }) });
  assert.deepEqual(await restartLeakingAdb(ops), { kind: 'futile', at: '2026-10-23T23:55:52.000Z' });
  assert.equal(seen.restarts, 0);
  assert.match(describeAdbRestart({ kind: 'futile', at: '2026-10-23T23:55:52.000Z' }).join('\n'), /ADB_LIBUSB=1/);
});

test('restartLeakingAdb: a restart that cleared it is recorded too; one that cannot be measured is not', async () => {
  const cleared = host();
  const r = await restartLeakingAdb(cleared.ops);
  assert.equal(r.kind === 'restarted' && r.cleared, true);
  assert.deepEqual(cleared.seen.remembered, [{ pid: 20928, cleared: true }]);
  const blind = host({ settled: async () => undefined });
  const b = await restartLeakingAdb(blind.ops);
  assert.equal(b.kind === 'restarted' && b.cleared, undefined);
  assert.deepEqual(blind.seen.remembered, []);
});

test('hostRestartOps: the not-cleared record holds for that server only', () => {
  const home = mkdtempSync(join(tmpdir(), 'vk-restart-record-'));
  try {
    hostRestartOps(LEAKING, { home }).remember({ pid: LEAKING.pid, cleared: false });
    assert.ok(hostRestartOps(LEAKING, { home }).futile(), 'the same server: refuse');
    assert.equal(hostRestartOps({ ...LEAKING, pid: 4242 }, { home }).futile(), undefined, 'a newer server: try again');
    hostRestartOps(LEAKING, { home }).remember({ pid: LEAKING.pid, cleared: true });
    assert.equal(hostRestartOps(LEAKING, { home }).futile(), undefined, 'cleared: nothing to refuse');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('devicePorts: emulators answer on console+1; loopback TCP devices on their own port', () => {
  const devices: DeviceInfo[] = [
    emu,
    { serial: '127.0.0.1:6520', state: 'device', platform: 'android', kind: 'physical' },
    usb,
    wifi, // not loopback: the peer check already skips any non-loopback far end
  ];
  assert.deepEqual(devicePorts(devices), [5555, 6520]);
});

test('describeAdbRestart: a blocker sharing only this session is labelled by its workspace', () => {
  // describeClaim says "this job" for a session match; every claim here is somebody else's.
  const lines = describeAdbRestart(
    { kind: 'in-use', claims: [{ ...claim, session: 'tmux-1' }], peers: [] },
    { now: Date.parse('2026-10-21T11:26:12.343Z'), cwd: '/w/this-job', env: { VERIKUN_SESSION: 'tmux-1' } },
  ).join('\n');
  assert.match(lines, /curitiba-v1/);
  assert.doesNotMatch(lines, /this job/);
});

test('describeAdbRestart: a refusal names every blocker so the user can act on it', () => {
  const lines = describeAdbRestart(
    { kind: 'in-use', claims: [claim], peers: [rdb, { endpoint: '127.0.0.1:60003' }] },
    { now: Date.parse('2026-10-21T11:26:12.343Z'), cwd: '/w/this-job', env: {} },
  ).join('\n');
  assert.match(lines, /emulator-5556.*curitiba-v1/);
  assert.match(lines, /rdb \(pid 43804\)/);
  assert.match(lines, /127\.0\.0\.1:60003/);
});

test('describeAdbRestart: a restart that lost a device or a rule says which', () => {
  const lost: AdbRule = { kind: 'reverse', serial: 'R58R42SGVNR', args: ['tcp:8081', 'tcp:8081'] };
  const lines = describeAdbRestart({
    kind: 'restarted',
    back: ['emulator-5554'],
    missing: ['R58R42SGVNR'],
    ms: 20_000,
    rules: { restored: 1, lost: [lost], unread: [] },
  }).join('\n');
  assert.match(lines, /1\/2/);
  assert.match(lines, /not back: R58R42SGVNR/);
  assert.match(lines, /reverse tcp:8081 tcp:8081.*R58R42SGVNR/);
});
