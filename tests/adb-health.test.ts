import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  VIOLATION_WINDOW_MS,
  adbHealthProbe,
  adbRecycleEnabled,
  adbServerPeers,
  adbServerRotting,
  countViolations,
  describeRot,
  adbServerPort,
  leakNote,
  listensBeyondLoopback,
  parseEtime,
  parseLsofSockets,
  parseServerStatus,
  trustedAdbBinary,
} from '../src/adb-health';

// A verbatim line from a rotted server (macOS 26, adb 37.0.1), trimmed only in length.
const REAL_LINE =
  '2026-09-12 16:18:38.347 E  kernel[0:2373f9a] ERROR: [adb:96399] EXC_GUARD AST: type=0x1 flavor=0x200 target=0x2d33';
// `log show --style compact` ALWAYS emits this first. Counting it is the bug this guards.
const HEADER = 'Timestamp               Ty Process[PID:TID]';

test('parseEtime: the three `ps -o etime=` shapes', () => {
  assert.equal(parseEtime('45:03'), (45 * 60 + 3) * 1000);
  assert.equal(parseEtime('09:45:03'), ((9 * 60 + 45) * 60 + 3) * 1000);
  assert.equal(parseEtime('09-08:33:29'), (((9 * 24 + 8) * 60 + 33) * 60 + 29) * 1000);
});

test('parseEtime: anything unrecognised is undefined, never a wrong number', () => {
  // This feeds an advisory, so a parse failure must degrade to silence.
  for (const bad of ['', '   ', 'nope', '1:2:3:4', '-5:00', 'x-01:02:03']) {
    assert.equal(parseEtime(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
  }
});

test('countViolations: the compact-output header is NOT a violation', () => {
  // A naive line count reports 1 on a healthy host, which would cry rot forever.
  assert.equal(countViolations(HEADER), 0);
  assert.equal(countViolations(`${HEADER}\n`), 0);
  assert.equal(countViolations(''), 0);
});

test('countViolations: counts only lines naming adb', () => {
  const other = '2026-09-12 16:18:38.347 E  kernel[0:1] ERROR: [Spotify:123] EXC_GUARD AST: type=0x1';
  assert.equal(countViolations([HEADER, REAL_LINE, REAL_LINE, other].join('\n')), 2);
});

test('countViolations: pinned to one server, a fresh one is not blamed for its predecessor', () => {
  // The window outlives a restart by two minutes. Counting every adb pid would read the new
  // server as leaking — and the skill acts on that by restarting a healthy server.
  const fresh = REAL_LINE.replace('[adb:96399]', '[adb:15109]');
  assert.equal(countViolations([HEADER, REAL_LINE, REAL_LINE, fresh].join('\n'), 15109), 1);
  assert.equal(countViolations([HEADER, REAL_LINE].join('\n'), 15109), 0);
  // A pid that is a prefix of another must not match it.
  assert.equal(countViolations(REAL_LINE, 963), 0);
});

test('adbServerRotting: any nonzero count is rot; a healthy server is exactly zero', () => {
  // Measured: healthy sits at 0 over the window, rotted at 60-120/min. No middle ground,
  // so there is no threshold to tune — which is why this is `> 0` and not a constant.
  assert.equal(adbServerRotting({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), false);
  assert.equal(adbServerRotting({ violations: 1, windowMs: VIOLATION_WINDOW_MS }), true);
  assert.equal(adbServerRotting({ violations: 239, windowMs: VIOLATION_WINDOW_MS }), true);
});

test('adbServerRotting: an unmeasurable host is never rot', () => {
  // Not macOS, or the query failed. We must not restart a host transport on a hunch.
  assert.equal(adbServerRotting({}), false);
  assert.equal(adbServerRotting({ pid: 497, ageMs: 9 * 864e5 }), false);
});

test('describeRot: reports a per-minute rate, not the raw window count', () => {
  // 239 over 2 minutes is the measured rotted rate; the operator needs /min to compare.
  const d = describeRot({ violations: 239, windowMs: VIOLATION_WINDOW_MS, ageMs: 9 * 864e5 });
  assert.ok(d && d.includes('~120'), `expected ~120/min, got: ${d}`);
  assert.ok(d.includes('216h'), `expected the age, got: ${d}`);
});

test('describeRot: silent on a healthy server', () => {
  assert.equal(describeRot({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), undefined);
  assert.equal(describeRot({}), undefined);
});

test('adbHealthProbe: null when healthy, so doctor stays quiet', () => {
  assert.equal(adbHealthProbe({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), null);
  assert.equal(adbHealthProbe({}), null);
});

test('adbHealthProbe: ADVISORY — it must never change doctor exit code', () => {
  // Exit 3 means "a machine that cannot drive a device". A rotted adb server is a thing to
  // fix, not that. Same rule the version check holds.
  const p = adbHealthProbe({ violations: 239, windowMs: VIOLATION_WINDOW_MS, ageMs: 9 * 864e5 });
  assert.ok(p);
  assert.equal(p.ok, true);
  assert.equal(p.advisory, true);
});

test('adbHealthProbe: the remedy is the guarded restart, not a bare kill-server', () => {
  // The skill tells an agent to act on this hint. A bare `adb kill-server` would cut off
  // every other job on the host; `--restart-adb` checks for them first.
  const p = adbHealthProbe({ violations: 239, windowMs: VIOLATION_WINDOW_MS, ageMs: 9 * 864e5 });
  assert.ok(p?.hint?.includes('vk doctor --restart-adb'), `hint: ${p?.hint}`);
  assert.ok(!p?.hint?.includes('kill-server'), `hint: ${p?.hint}`);
});

// `lsof -nP -iTCP -F pcnT`, shaped like the real thing on macOS 26 — the adb server (15109)
// with its listener, an emulator link, a reverse link out to a local tool, three clients and a
// wireless device. Only the field letters the parser reads are kept.
const LSOF = [
  'p15109', 'cadb',
  'f13', 'n127.0.0.1:5037', 'TST=LISTEN', 'TQR=0', 'TQS=0',
  'f25', 'n127.0.0.1:64013->127.0.0.1:5555', 'TST=ESTABLISHED', 'TQR=0', 'TQS=0',
  'f17', 'n127.0.0.1:54875->127.0.0.1:38665', 'TST=ESTABLISHED',
  'f30', 'n127.0.0.1:5037->127.0.0.1:60001', 'TST=ESTABLISHED',
  'f31', 'n127.0.0.1:5037->127.0.0.1:60002', 'TST=ESTABLISHED',
  'f32', 'n127.0.0.1:5037->127.0.0.1:60003', 'TST=ESTABLISHED',
  'f33', 'n192.168.1.10:62000->192.168.1.20:5555', 'TST=ESTABLISHED',
  'f34', 'n127.0.0.1:5037->127.0.0.1:60004', 'TST=ESTABLISHED',
  'p58374', 'cqemu-system-aarch64',
  'f37', 'n127.0.0.1:5555', 'TST=LISTEN',
  'f281', 'n127.0.0.1:5555->127.0.0.1:64013', 'TST=ESTABLISHED',
  'p43804', 'crdb',
  'f18', 'n*:38665', 'TST=LISTEN',
  'f21', 'n127.0.0.1:38665->127.0.0.1:54875', 'TST=ESTABLISHED',
  'p777', 'cadb',
  'f3', 'n127.0.0.1:60001->127.0.0.1:5037', 'TST=ESTABLISHED',
  'f4', 'n127.0.0.1:60004->127.0.0.1:5037', 'TST=ESTABLISHED',
  'p900', 'cnode',
  'f20', 'n127.0.0.1:60002->127.0.0.1:5037', 'TST=ESTABLISHED',
  'p52266', 'cFigma',
  'f75', 'n127.0.0.1:50000->127.0.0.1:8888', 'TST=ESTABLISHED',
].join('\n');

test('parseLsofSockets: each socket keeps the process it was listed under', () => {
  const sockets = parseLsofSockets(LSOF);
  assert.deepEqual(sockets.find((s) => s.local === '127.0.0.1:38665' && s.remote), {
    pid: 43804, command: 'rdb', local: '127.0.0.1:38665', remote: '127.0.0.1:54875', state: 'ESTABLISHED',
  });
  assert.deepEqual(sockets.find((s) => s.pid === 15109 && s.state === 'LISTEN'), {
    pid: 15109, command: 'adb', local: '127.0.0.1:5037', state: 'LISTEN',
  });
  assert.equal(sockets.length, 16);
});

test('adbServerPeers: names every other process with a live connection to the adb server', () => {
  const peers = adbServerPeers(parseLsofSockets(LSOF), 15109, { selfPid: 900, devicePorts: [5555], adbPort: 5037 });
  assert.deepEqual(peers, [
    { pid: 43804, command: 'rdb', endpoint: '127.0.0.1:38665' }, // the server dialled out to it
    { pid: 777, command: 'adb', endpoint: '127.0.0.1:60001' }, // a client, counted once for two links
    { endpoint: '127.0.0.1:60003' }, // a local peer we cannot see into still counts
  ]);
});

test('adbServerPeers: devices are not users — emulator and wireless links never block', () => {
  const lone = [
    'p15109', 'cadb',
    'f13', 'n127.0.0.1:5037', 'TST=LISTEN',
    'f25', 'n127.0.0.1:64013->127.0.0.1:5555', 'TST=ESTABLISHED',
    'f33', 'n192.168.1.10:62000->192.168.1.20:5555', 'TST=ESTABLISHED',
    'p58374', 'cqemu-system-aarch64',
    'f281', 'n127.0.0.1:5555->127.0.0.1:64013', 'TST=ESTABLISHED',
  ].join('\n');
  assert.deepEqual(adbServerPeers(parseLsofSockets(lone), 15109, { selfPid: 900, devicePorts: [5555], adbPort: 5037 }), []);
});

test('adbServerPeers: undefined when the server itself is not visible — no proof, no restart', () => {
  // A server owned by another user (or on a unix socket) shows no sockets at all. Reading
  // that as "nobody is connected" would restart adb under a stranger.
  assert.equal(adbServerPeers(parseLsofSockets(LSOF), 4242, { selfPid: 900, devicePorts: [], adbPort: 5037 }), undefined);
});

/** Lines for one more process in an lsof fixture. */
const proc = (pid: number, command: string, ...files: string[][]): string[] => [`p${pid}`, `c${command}`, ...files.flat()];
const sock = (fd: number, name: string, state?: string): string[] => [`f${fd}`, `n${name}`, ...(state ? [`TST=${state}`] : [])];

test('adbServerPeers: undefined when the measured pid is not the server on the adb port', () => {
  // Two servers, or a recycled pid: the gate would inspect one process and `kill-server` hit another.
  const other = proc(15109, 'adb', sock(13, '127.0.0.1:5038', 'LISTEN')).join('\n');
  assert.equal(adbServerPeers(parseLsofSockets(other), 15109, { selfPid: 900, devicePorts: [], adbPort: 5037 }), undefined);
});

test('adbServerPeers: a client in teardown counts only while a process still holds its end', () => {
  const lines = [
    ...proc(15109, 'adb',
      sock(13, '127.0.0.1:5037', 'LISTEN'),
      sock(30, '127.0.0.1:5037->127.0.0.1:60010', 'CLOSE_WAIT'), // the client is gone
      sock(31, '127.0.0.1:5037->127.0.0.1:60011', 'CLOSE_WAIT')), // half-closed, still running
    ...proc(778, 'adb', sock(3, '127.0.0.1:60011->127.0.0.1:5037', 'FIN_WAIT_2')),
  ].join('\n');
  assert.deepEqual(adbServerPeers(parseLsofSockets(lines), 15109, { selfPid: 900, devicePorts: [], adbPort: 5037 }), [
    { pid: 778, command: 'adb', endpoint: '127.0.0.1:60011' },
  ]);
});

test('adbServerPeers: a client counts whatever address it connects from', () => {
  // An `adb -a` server takes clients from other hosts, and a dual-stack client can arrive
  // IPv4-mapped. Whoever reached the server's own listener is a client, not a device.
  const lines = [
    ...proc(15109, 'adb',
      sock(13, '*:5037', 'LISTEN'),
      sock(30, '192.168.1.10:5037->192.168.1.30:51000', 'ESTABLISHED'),
      sock(31, '[::ffff:127.0.0.1]:5037->[::ffff:127.0.0.1]:52000', 'ESTABLISHED')),
    ...proc(779, 'studio', sock(9, '[::ffff:127.0.0.1]:52000->[::ffff:127.0.0.1]:5037', 'ESTABLISHED')),
  ].join('\n');
  assert.deepEqual(adbServerPeers(parseLsofSockets(lines), 15109, { selfPid: 900, devicePorts: [], adbPort: 5037 }), [
    { endpoint: '192.168.1.30:51000' },
    { pid: 779, command: 'studio', endpoint: '[::ffff:127.0.0.1]:52000' },
  ]);
});

test('adbServerPeers: the server dialling itself is a device-side client, counted once', () => {
  // Only `adb reverse tcp:5037 …` produces it: something on the phone is using the host's adb.
  const lines = proc(15109, 'adb',
    sock(13, '127.0.0.1:5037', 'LISTEN'),
    sock(40, '127.0.0.1:53000->127.0.0.1:5037', 'ESTABLISHED'),
    sock(41, '127.0.0.1:5037->127.0.0.1:53000', 'ESTABLISHED')).join('\n');
  assert.deepEqual(adbServerPeers(parseLsofSockets(lines), 15109, { selfPid: 900, devicePorts: [], adbPort: 5037 }), [
    { command: 'a device-side client through adb reverse', endpoint: '127.0.0.1:53000' },
  ]);
});

test('listensBeyondLoopback: whether the server was started with -a', () => {
  const all = proc(15109, 'adb', sock(13, '*:5037', 'LISTEN')).join('\n');
  const local = proc(15109, 'adb', sock(13, '127.0.0.1:5037', 'LISTEN')).join('\n');
  assert.equal(listensBeyondLoopback(parseLsofSockets(all), 15109, 5037), true);
  assert.equal(listensBeyondLoopback(parseLsofSockets(local), 15109, 5037), false);
});

test('adbServerPort: where the server listens, or undefined when it is not a TCP port', () => {
  assert.equal(adbServerPort({}), 5037);
  assert.equal(adbServerPort({ ANDROID_ADB_SERVER_PORT: '5038' }), 5038);
  assert.equal(adbServerPort({ ADB_SERVER_SOCKET: 'tcp:localhost:6000' }), 6000);
  assert.equal(adbServerPort({ ADB_SERVER_SOCKET: 'tcp:6001' }), 6001);
  assert.equal(adbServerPort({ ADB_SERVER_SOCKET: 'localfilesystem:/tmp/adb.sock' }), undefined);
  assert.equal(adbServerPort({ ANDROID_ADB_SERVER_ADDRESS: 'localhost' }), 5037);
});

test('adbServerPort: a server on another host is not this one — undefined, so nothing restarts', () => {
  // The evidence and the connection check read THIS host; `kill-server` would follow the
  // environment to the other one, and `start-server` cannot bring a remote server back.
  assert.equal(adbServerPort({ ADB_SERVER_SOCKET: 'tcp:build-box.lan:5037' }), undefined);
  assert.equal(adbServerPort({ ANDROID_ADB_SERVER_ADDRESS: 'build-box.lan' }), undefined);
});

test('parseServerStatus: the binary and USB backend the running server was started with', () => {
  const status = [
    'usb_backend: NATIVE',
    'mdns_backend: LIBADBMDNS',
    'version: "37.0.1"',
    'build: "15733141"',
    'executable_absolute_path: "/Users/someone/Library/Android/sdk/platform-tools/adb"',
    'log_absolute_path: "/var/folders/fm/T//adb.501.log"',
  ].join('\n');
  assert.deepEqual(parseServerStatus(status), {
    executable: '/Users/someone/Library/Android/sdk/platform-tools/adb',
    usbBackend: 'NATIVE',
  });
  // adb older than 36 has no server-status: no opinion, so the caller falls back to `ADB`.
  assert.deepEqual(parseServerStatus('adb: unknown command server-status'), {});
});

test('trustedAdbBinary: only an adb this user controls is executed on the server\'s word', () => {
  // Whatever answers on the adb port names this path, and a `brew upgrade` deletes the old one.
  const me = 501;
  const file = (over: Partial<{ isFile: boolean; mode: number; uid: number }> = {}) => () => ({ isFile: true, mode: 0o755, uid: me, ...over });
  const path = '/opt/homebrew/Caskroom/android-platform-tools/37.0.0/platform-tools/adb';
  assert.equal(trustedAdbBinary(path, file(), me), true);
  assert.equal(trustedAdbBinary(path, file({ uid: 0 }), me), true, 'root-owned is fine');
  assert.equal(trustedAdbBinary(path, () => undefined, me), false, 'gone after an upgrade');
  assert.equal(trustedAdbBinary('/tmp/evil', file(), me), false, 'not an adb');
  assert.equal(trustedAdbBinary(path, file({ uid: 502 }), me), false, 'another user\'s binary');
  assert.equal(trustedAdbBinary(path, file({ mode: 0o777 }), me), false, 'writable by anyone');
  assert.equal(trustedAdbBinary(path, file({ mode: 0o644 }), me), false, 'not executable');
});

test('leakNote: names the leak and the guarded restart when a device dropped on a leaking host', () => {
  const note = leakNote({ violations: 120, windowMs: VIOLATION_WINDOW_MS, ageMs: 152 * 3_600_000 });
  assert.ok(note?.includes('~60'), `note: ${note}`);
  assert.ok(note?.includes('152h'), `note: ${note}`);
  assert.ok(note?.includes('vk doctor --restart-adb'), `note: ${note}`);
});

test('leakNote: silent on a healthy or unmeasurable host', () => {
  assert.equal(leakNote({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), undefined);
  assert.equal(leakNote({}), undefined);
});

test('adbRecycleEnabled: on by default for Android, never for iOS', () => {
  const prev = process.env.VERIKUN_NO_ADB_RECYCLE;
  delete process.env.VERIKUN_NO_ADB_RECYCLE;
  try {
    // `vk server` sits on a CI host for days, which is what rots adb — so default-on.
    assert.equal(adbRecycleEnabled('android'), true);
    // iOS has no adb to recycle; it must never pay for the check.
    assert.equal(adbRecycleEnabled('ios'), false);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_ADB_RECYCLE;
    else process.env.VERIKUN_NO_ADB_RECYCLE = prev;
  }
});

test('adbRecycleEnabled: the kill switch restores the previous behaviour exactly', () => {
  const prev = process.env.VERIKUN_NO_ADB_RECYCLE;
  process.env.VERIKUN_NO_ADB_RECYCLE = '1';
  try {
    assert.equal(adbRecycleEnabled('android'), false);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_ADB_RECYCLE;
    else process.env.VERIKUN_NO_ADB_RECYCLE = prev;
  }
});
