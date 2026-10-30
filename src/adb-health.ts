/**
 * Is the HOST's adb server healthy, or has it rotted?
 *
 * A long-lived adb server leaks IOKit Mach ports and never recovers. Measured on macOS
 * 2026-09-12: a 9-day-old server logging EXC_GUARD `GUARD_TYPE_MACH_PORT` / `INVALID_NAME`
 * at 2/sec — 27,983 in 7h, every one of them from the adb pid — having burned 92 minutes
 * of CPU on the error loop. `adb kill-server && adb start-server` took it to zero and every
 * device came back in ~5s.
 *
 * A host transport failure affects every device behind adb. The server supervises
 * correlated losses together and recycles under a host lock, excluding foreign claims.
 *
 * THE RATE IS A LEAKED-HANDLE COUNTER, which is what makes this measurable rather than
 * guessed. adb scans USB at ~1Hz and each STALE device handle throws one violation per
 * pass, so the per-minute count reads directly as "how many handles adb has leaked". It
 * stepped 59 -> 118/min at the exact second a device re-enumerated, and never came back
 * down. A healthy server sits at exactly 0.
 *
 * EVIDENCE, NEVER AGE, is the trigger — see `adbServerRotting`. Age alone would restart a
 * perfectly good server, which for a default-on behaviour is a new way to fail; the whole
 * point of a measured signal is that a healthy host is never disturbed.
 *
 * macOS-only, and that is honest rather than lazy: EXC_GUARD and Mach ports do not exist on
 * Linux, and the rot has not been measured there. Everywhere else this reports `undefined`
 * and every caller degrades to doing nothing — never to a blind restart.
 */

import { statSync } from 'node:fs';
import { platform } from 'node:os';
import { basename } from 'node:path';
import type { ToolProbe } from './types';
import { runText } from './exec';

/** The window we count violations over. Long enough that a ~1Hz loop is unmissable, short
 *  enough that `log show` stays ~1s (measured: 1.2s for 2m). */
export const VIOLATION_WINDOW_MS = 2 * 60 * 1000;

/**
 * `log`'s own absolute path, not a bare `log`. Belt-and-braces against a shadowing shell
 * function (the author hit exactly that while investigating: `log` was a zsh function and
 * every query failed with "too many arguments"). We spawn without a shell so this cannot
 * bite us today, but the absolute path costs nothing and documents the hazard.
 */
const LOG_BIN = '/usr/bin/log';

/**
 * Match the kernel's report of adb's guard violations, and NOTHING else.
 *
 * All three clauses are load-bearing. Without `process == "kernel"` this matches unrelated
 * processes; without the `[adb:` clause it matches any process's guard violations, and a
 * host with an unrelated misbehaving binary would be told its adb had rotted. The line the
 * kernel actually emits:
 *
 *   ERROR: [adb:96399] EXC_GUARD AST: type=0x1 flavor=0x200 target=0x24d7 ...
 */
const VIOLATION_PREDICATE =
  'process == "kernel" AND eventMessage CONTAINS "EXC_GUARD" AND eventMessage CONTAINS "[adb:"';

export interface AdbServerHealth {
  /** The running adb server's pid, if one could be found. */
  pid?: number;
  /** How long it has been up. Reported for context; deliberately NOT the trigger. */
  ageMs?: number;
  /** Guard violations in `windowMs`. `undefined` = not measurable on this host. */
  violations?: number;
  windowMs?: number;
}

/**
 * `ps -o etime=` elapsed time -> ms. Formats, narrowest first: `MM:SS`, `HH:MM:SS`,
 * `DD-HH:MM:SS`. Returns undefined rather than throwing on anything unrecognised — this
 * feeds an advisory, and a parse failure must degrade to silence, never to a wrong number.
 */
export function parseEtime(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const [days, clock] = s.includes('-') ? s.split('-', 2) : ['0', s];
  const parts = clock.split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  // Test the DIGITS, not Number(): `Number('')` is 0, not NaN, so a leading '-' ("-5:00")
  // would otherwise parse as a happy five minutes instead of being rejected.
  const fields = [days, ...parts];
  if (!fields.every((f) => /^\d+$/.test(f))) return undefined;
  const nums = fields.map((f) => Number(f));
  const [d, ...rest] = nums;
  const [h, m, sec] = rest.length === 3 ? rest : [0, ...rest];
  return ((d * 24 + h) * 60 * 60 + m * 60 + sec) * 1000;
}

/**
 * Count real events in `log show --style compact` output.
 *
 * It ALWAYS prints a `Timestamp Ty Process[PID:TID]` header, so a naive line count reports
 * 1 on a perfectly healthy host — which would make every caller cry rot forever. Counting
 * only lines that name adb is both the fix and a second guard on the predicate.
 *
 * With `pid`, only THAT server's lines count. The window outlives a restart by two minutes, and
 * the predecessor's violations would otherwise read the fresh server as leaking — evidence about
 * a process that no longer exists, which `vk doctor --restart-adb` would act on.
 */
export function countViolations(stdout: string, pid?: number): number {
  const mark = pid === undefined ? '[adb:' : `[adb:${pid}]`;
  return stdout.split('\n').filter((l) => l.includes(mark)).length;
}

/**
 * Has this adb server rotted? Evidence only.
 *
 * A healthy server produces EXACTLY zero over the window (measured repeatedly on a freshly
 * restarted one), and a rotted one produces 60-120 per minute — there is no middle ground
 * to tune a threshold against, so any nonzero count is the signal. `undefined` violations
 * (not macOS, or the query failed) is NEVER rot: we do not restart on a hunch.
 */
export function adbServerRotting(health: AdbServerHealth): boolean {
  return (health.violations ?? 0) > 0;
}

/** `~60 kernel guard violations/min, up 152h` — the evidence, in the units a reader compares. */
function rotFigures(health: AdbServerHealth): string {
  const perMin = Math.round((health.violations! / (health.windowMs ?? VIOLATION_WINDOW_MS)) * 60_000);
  const age = health.ageMs !== undefined ? `, up ${Math.floor(health.ageMs / 3_600_000)}h` : '';
  return `~${perMin} kernel guard violations/min${age}`;
}

/** One line a human can act on, or undefined when there is nothing worth saying. */
export function describeRot(health: AdbServerHealth): string | undefined {
  if (!adbServerRotting(health)) return undefined;
  return `adb server is leaking USB handles (${rotFigures(health)}) — devices will drop`;
}

/**
 * The line a device-drop failure gains on a leaking host, or undefined.
 *
 * A phone that left adb mid-flow reads as a broken phone or a broken test, and the reader goes
 * looking at both. When the host's adb server is leaking, it is the likelier cause, and the
 * remedy is the guarded restart — never a bare `kill-server`, which would cut off every other
 * job on the host.
 */
export function leakNote(health: AdbServerHealth): string | undefined {
  if (!adbServerRotting(health)) return undefined;
  return (
    `likely cause: this host's adb server is leaking USB handles (${rotFigures(health)}), which drops devices — ` +
    '`vk doctor --restart-adb` restarts it once nothing else is using adb'
  );
}

/**
 * Is the idle adb-server recycle active? ONE definition, because two callers ask — the
 * server's timer and its startup banner — and a banner that disagrees with the behaviour is
 * worse than no banner at all.
 *
 * Android only: `adb` is the only transport that rots this way, so an iOS server never pays
 * for the check. On by default (`vk server` is built to sit on a CI host for days, which is
 * the condition that rots it); `VERIKUN_NO_ADB_RECYCLE=1` restores the previous behaviour
 * exactly, for the rare host running other adb work alongside the server.
 */
export function adbRecycleEnabled(platform: string): boolean {
  return platform === 'android' && !process.env.VERIKUN_NO_ADB_RECYCLE;
}

/** The running adb server's pid. Undefined when there is none, or when `pgrep` is absent. */
export function adbServerPid(): number | undefined {
  try {
    // `adb -L tcp:5037 fork-server server` is the canonical argv; match loosely so a
    // non-default port or an ADB_SERVER_SOCKET still resolves.
    const r = runText('pgrep', ['-f', 'adb.*fork-server'], { timeout: 5000 });
    const pid = Number(r.stdout.split('\n')[0]?.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** How long pid has been running, via `ps -o etime=`. */
function processAgeMs(pid: number): number | undefined {
  try {
    const r = runText('ps', ['-p', String(pid), '-o', 'etime='], { timeout: 5000 });
    return parseEtime(r.stdout);
  } catch {
    return undefined;
  }
}

/** Guard violations `pid` threw in the last `windowMs`; undefined where that cannot be measured
 *  (not macOS, or the query failed) — no opinion, not a failure. */
export function serverViolations(pid: number, windowMs: number): number | undefined {
  if (platform() !== 'darwin') return undefined;
  try {
    const secs = Math.max(1, Math.round(windowMs / 1000));
    const r = runText(LOG_BIN, ['show', '--last', `${secs}s`, '--style', 'compact', '--predicate', VIOLATION_PREDICATE], {
      timeout: 20000,
    });
    return r.code === 0 ? countViolations(r.stdout, pid) : undefined;
  } catch {
    return undefined; // log(1) missing, sandboxed, or slow
  }
}

/**
 * Survey the host's adb server. Never throws: every probe is wrapped, and an unavailable
 * signal comes back `undefined` so callers do nothing rather than something wrong.
 */
export function adbServerHealth(windowMs = VIOLATION_WINDOW_MS): AdbServerHealth {
  const pid = adbServerPid();
  const health: AdbServerHealth = { pid, ageMs: pid ? processAgeMs(pid) : undefined };
  if (!pid) return health;
  const violations = serverViolations(pid, windowMs);
  return violations === undefined ? health : { ...health, violations, windowMs };
}

/**
 * The `vk doctor` line. ADVISORY, always: a rotted adb server is a thing to fix, not a
 * machine that cannot drive a device, and exit 3 is reserved for the latter. Returns null
 * when there is nothing to say, so doctor stays quiet on a healthy host.
 */
export function adbHealthProbe(health = adbServerHealth()): ToolProbe | null {
  const detail = describeRot(health);
  if (!detail) return null;
  return {
    name: 'adb server',
    ok: true,
    advisory: true,
    detail,
    hint: 'restart it: `vk doctor --restart-adb` (only while nothing else is using adb; devices reconnect in a few seconds)',
  };
}

/**
 * Restart the host's adb server. Returns whether it came back.
 *
 * HOST-GLOBAL and therefore never called speculatively — `kill-server` drops every
 * transport on the machine, including devices this process does not own. Callers must have
 * evidence (`adbServerRotting`) and nothing else using adb (`adbServerPeers` + the claims).
 */
export function recycleAdbServer(adb: string, like: { allInterfaces?: boolean; usbBackend?: string } = {}): boolean {
  try {
    runText(adb, ['kill-server'], { timeout: 20000 });
    // Started as the old one was: `-a` keeps remote clients able to reach it, and the backend is
    // carried explicitly so the asker's environment cannot swap it.
    const backend = like.usbBackend === 'LIBUSB' ? '1' : like.usbBackend === 'NATIVE' ? '0' : undefined;
    const r = runText(adb, [...(like.allInterfaces ? ['-a'] : []), 'start-server'], {
      timeout: 30000,
      ...(backend ? { env: { ...process.env, ADB_LIBUSB: backend } } : {}),
    });
    return r.code === 0;
  } catch {
    return false; // never a new way to fail: the caller logs and carries on
  }
}

// --- who else is using adb? -------------------------------------------------
//
// A restart cuts every connection the server holds, and claims only cover verikun's own jobs.
// Android Studio, scrcpy, an `adb logcat` in a terminal, a tool tunnelled through `adb reverse`
// — each holds a TCP connection to (or from) the adb server for as long as it is working, so
// the server's own socket table is the one list that names all of them.

/** One TCP socket as `lsof -F pcnT` lists it. `remote` is absent on a listener. */
export interface TcpSocket {
  pid: number;
  command: string;
  local: string;
  remote?: string;
  state?: string;
}

/** Something other than a device holding a live connection to the adb server. No `pid` means
 *  a local process lsof could not see into (another user's) — still somebody, so it counts. */
export interface AdbPeer {
  pid?: number;
  command?: string;
  /** The far end of the server's socket — what to look for if the pid is unknown. */
  endpoint: string;
}

/**
 * Parse `lsof -nP -iTCP -F pcnT`. Field output is one field per line, keyed by its first letter:
 * `p` opens a process, `c` names it, `f` opens one of its files, `n` is that file's address
 * (`local->remote`, or just `local` for a listener) and `T` carries TCP detail, of which only
 * `ST=` (the state) matters here.
 */
export function parseLsofSockets(stdout: string): TcpSocket[] {
  const sockets: TcpSocket[] = [];
  let pid = 0;
  let command = '';
  let current: TcpSocket | undefined;
  for (const line of stdout.split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        pid = Number(value);
        command = '';
        current = undefined;
        break;
      case 'c':
        command = value;
        break;
      case 'f':
        current = undefined;
        break;
      case 'n': {
        if (!(pid > 0)) break;
        const [local, remote] = value.split('->');
        current = { pid, command, local, ...(remote ? { remote } : {}) };
        sockets.push(current);
        break;
      }
      case 'T':
        if (current && value.startsWith('ST=')) current.state = value.slice(3);
        break;
    }
  }
  return sockets;
}

function splitEndpoint(endpoint: string): { host: string; port: number } {
  const i = endpoint.lastIndexOf(':');
  return { host: endpoint.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(endpoint.slice(i + 1)) };
}

const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.');

/**
 * The local TCP port of the adb server this environment talks to — or undefined when that server
 * is not a local TCP one: a unix socket (`ADB_SERVER_SOCKET=localfilesystem:…`), whose clients
 * lsof cannot see, or ANOTHER host (`ADB_SERVER_SOCKET=tcp:box:5037`, `ANDROID_ADB_SERVER_ADDRESS`).
 * The evidence and the connection check read this host, while `kill-server` follows the
 * environment, so a remote server would be judged by one machine and killed on another.
 */
export function adbServerPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const local = (host: string | undefined): boolean => !host || isLoopback(host.replace(/^\[|\]$/g, ''));
  if (env.ADB_SERVER_SOCKET) {
    const m = /^tcp:(?:(.*):)?(\d+)$/.exec(env.ADB_SERVER_SOCKET);
    return m && local(m[1]) ? Number(m[2]) : undefined;
  }
  if (!local(env.ANDROID_ADB_SERVER_ADDRESS)) return undefined;
  const port = Number(env.ANDROID_ADB_SERVER_PORT || 5037);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Every process with a live connection to the adb server except this one and the devices.
 *
 * A socket is classified by the SERVER's side of it, never by process name:
 *
 * - ACCEPTED on one of the server's own listeners (the adb port, or a forward) — a client, from
 *   whatever address: an `adb -a` server takes clients from other hosts, and a dual-stack
 *   client can arrive IPv4-mapped.
 * - DIALLED by the server — a device, unless it is a local process: a non-loopback far end is a
 *   wireless device, and a loopback one on `devicePorts` is an emulator's adb port
 *   (`emulator-5554` answers on 5555). Anything else local is a tool behind `adb reverse`.
 *
 * The far end's owner is found by its mirrored address pair. One we cannot attribute still
 * counts while the connection is ESTABLISHED (an unseen user is still a user), but not in
 * teardown, where an unowned end means the client is already gone. The server dialling ITSELF
 * happens only through `adb reverse tcp:<adb port> …` — something on the phone is using the
 * host's adb — so it counts too, once, on its accepted side.
 *
 * Returns undefined unless `serverPid` is the process listening on `adbPort`: with none (a unix
 * socket, another user's server) "nothing listed" would read as "nobody connected", and with two
 * servers the gate would inspect one process while `kill-server` hits the other.
 */
export function adbServerPeers(
  sockets: TcpSocket[],
  serverPid: number,
  opts: { selfPid: number; devicePorts: number[]; adbPort: number | undefined },
): AdbPeer[] | undefined {
  const server = sockets.filter((s) => s.pid === serverPid);
  const listening = new Set(server.filter((s) => !s.remote).map((s) => splitEndpoint(s.local).port));
  if (opts.adbPort === undefined || !listening.has(opts.adbPort)) return undefined;
  const peers: AdbPeer[] = [];
  const seen = new Set<number>();
  for (const s of server) {
    if (!s.remote) continue;
    const owner = sockets.find((o) => o.local === s.remote && o.remote === s.local);
    const far = splitEndpoint(s.remote);
    const accepted = listening.has(splitEndpoint(s.local).port);
    if (owner?.pid === serverPid) {
      if (accepted) peers.push({ command: 'a device-side client through adb reverse', endpoint: s.remote });
      continue;
    }
    if (owner?.pid === opts.selfPid) continue;
    if (!accepted && (!isLoopback(far.host) || opts.devicePorts.includes(far.port))) continue;
    if (!owner) {
      if (!s.state || s.state === 'ESTABLISHED') peers.push({ endpoint: s.remote });
      continue;
    }
    if (seen.has(owner.pid)) continue;
    seen.add(owner.pid);
    peers.push({ pid: owner.pid, command: owner.command, endpoint: s.remote });
  }
  return peers;
}

/** Whether the server listens beyond loopback — it was started with `adb -a`, and a restart
 *  must keep that or every remote client loses it. */
export function listensBeyondLoopback(sockets: TcpSocket[], serverPid: number, adbPort: number): boolean {
  return sockets.some((s) => {
    if (s.pid !== serverPid || s.remote) return false;
    const { host, port } = splitEndpoint(s.local);
    return port === adbPort && !isLoopback(host);
  });
}

/** What `adb server-status` (adb 36+) says the running server was started as. Both fields are
 *  absent on an older adb, which has no such command. */
export function parseServerStatus(stdout: string): { executable?: string; usbBackend?: string } {
  const executable = /^executable_absolute_path:\s*"([^"]+)"/m.exec(stdout)?.[1];
  const usbBackend = /^usb_backend:\s*(\S+)/m.exec(stdout)?.[1];
  return { ...(executable ? { executable } : {}), ...(usbBackend ? { usbBackend } : {}) };
}

/**
 * Is `path` an adb this user may run on the running server's say-so?
 *
 * The path comes from whatever answers on the adb port, so it is checked before it is executed:
 * an `adb` that exists, is executable, belongs to this user or root and nobody else can rewrite.
 * It also fails safe on the common case — `brew upgrade` deletes the Caskroom directory a
 * days-old server was started from, and running a missing path would fail the restart after
 * the old server was already asked to quit.
 */
export function trustedAdbBinary(
  path: string,
  stat: (p: string) => { isFile: boolean; mode: number; uid: number } | undefined,
  uid: number,
): boolean {
  if (basename(path) !== 'adb') return false;
  const st = stat(path);
  return !!st && st.isFile && (st.mode & 0o111) !== 0 && (st.mode & 0o022) === 0 && (st.uid === uid || st.uid === 0);
}

/**
 * Who else is connected to the adb server right now, via `lsof` (~50ms). Undefined when that
 * cannot be seen — lsof missing, or the server's sockets invisible to this user — which a caller
 * must treat as "maybe somebody", never as "nobody".
 */
export function adbServerConnections(
  serverPid: number,
  devicePorts: number[],
): { peers: AdbPeer[]; allInterfaces: boolean } | undefined {
  const adbPort = adbServerPort();
  let stdout: string;
  try {
    // `+c 0` gives full process names rather than 9 characters, and process NAMES only: a
    // refusal is read into agent transcripts, and other processes' argv can carry tokens.
    // Exit 1 means "nothing matched" as well as "failed", so the parsed sockets decide.
    stdout = runText('lsof', ['+c', '0', '-nP', '-iTCP', '-F', 'pcnT'], { timeout: 10_000 }).stdout;
  } catch {
    return undefined;
  }
  const sockets = parseLsofSockets(stdout);
  const peers = adbServerPeers(sockets, serverPid, { selfPid: process.pid, devicePorts, adbPort });
  return peers && { peers, allInterfaces: listensBeyondLoopback(sockets, serverPid, adbPort!) };
}

/**
 * The binary and USB backend the running adb server was started with, so a restart brings back
 * the same adb rather than whichever one is first on PATH. A host can carry two — an SDK one and
 * a Homebrew one — and they differ in version and in default USB backend (platform-tools 37.0.1
 * moved macOS back to the native one). Falls back to `adb`, backend unknown, when the server
 * cannot say (adb older than 36 has no `server-status`) or names a binary it may not run.
 */
export function adbServerStatus(adb: string): { executable: string; usbBackend?: string; refused?: string } {
  let status: { executable?: string; usbBackend?: string } = {};
  try {
    const r = runText(adb, ['server-status'], { timeout: 10_000 });
    if (r.code === 0) status = parseServerStatus(r.stdout);
  } catch {
    /* no opinion: the fallbacks below */
  }
  const uid = process.getuid?.() ?? -1;
  const stat = (p: string) => {
    try {
      const st = statSync(p);
      return { isFile: st.isFile(), mode: st.mode, uid: st.uid };
    } catch {
      return undefined;
    }
  };
  const trusted = !!status.executable && trustedAdbBinary(status.executable, stat, uid);
  return {
    executable: trusted ? status.executable! : adb,
    ...(status.usbBackend ? { usbBackend: status.usbBackend } : {}),
    // Said, not swallowed: the restart is then NOT of the binary the server ran from.
    ...(status.executable && !trusted ? { refused: status.executable } : {}),
  };
}
