/**
 * `vk doctor --restart-adb`: restart a LEAKING host adb server — but only while nothing else
 * is using it.
 *
 * `vk server` already recycles a rotted adb server while its own pool is idle (adb-health.ts,
 * server.ts). A developer host driven by agents straight from the CLI had nothing: doctor printed
 * `adb kill-server`, the skill told the agent to hand that to the user, and the leak ran on for
 * days (issue #161). This is the step the skill now tells an agent to take itself when doctor
 * reports the leak, so it has to be safe to run unattended:
 *
 * - EVIDENCE, NEVER AGE — same rule as the server, and the evidence is THIS server's: a healthy
 *   or unmeasurable server is left alone.
 * - NOTHING ELSE ON ADB — `kill-server` cuts every connection the server holds. No other verikun
 *   job may hold an Android device (claims), and no other process may hold a connection to the
 *   server (Android Studio, scrcpy, `adb logcat`, a tool behind `adb reverse` — none of which
 *   leave a claim). Anything that cannot be seen counts as in use. Asked before the host lock,
 *   which it shares with `vk server`, and again while holding it.
 * - IT COMES BACK AS IT WAS — the same binary (`adb server-status`), the same USB backend, `-a`
 *   if it listened beyond loopback; `adb connect` devices are redialled and forward/reverse rules
 *   re-applied, because a restart drops all of them and nothing else would put them back.
 * - DEVICES ARE WAITED FOR — every device that was attached or offline, then reported.
 *
 * Not carried over: the rest of the old server's environment (`ADB_VENDOR_KEYS`, …). The new
 * server inherits the asker's, so an agent running inside a sandbox starts a sandboxed server —
 * the device wait is what surfaces that, as devices that do not come back.
 *
 * `VERIKUN_NO_ADB_RECYCLE` stops this too: it is the host operator's one switch for "verikun
 * never restarts adb here".
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AdbPeer,
  AdbServerHealth,
  adbServerConnections,
  adbServerPid,
  adbServerStatus,
  adbServerRotting,
  recycleAdbServer,
  serverViolations,
} from './adb-health';
import { ClaimOpts, DeviceClaim, claimsEnabled, describeHolder } from './device/claims';
import { adbTransport, parseAdbDevices } from './drivers/adb';
import { runText } from './exec';
import { RecycleResult, adbClaimBlockers, recycleHostAdb } from './server-host';
import type { DeviceInfo } from './types';
import { sleep } from './wait';

/** How long to wait for the devices that were attached to reappear. Measured: ~5s for USB
 *  phones and running emulators; the rest is headroom for a slow hub. */
const DEVICE_RETURN_MS = 20_000;
const POLL_MS = 500;

/** How long after the restart to judge it. MEASURED: violations that a restart cannot clear are
 *  back ~1s after a fresh start and then come every second, so 5s holds several. */
const SETTLE_MS = 5000;

/** A forward (`adb forward <local> <remote>`) or reverse (`adb reverse <remote> <local>`) rule,
 *  as the arguments that re-apply it on `serial`. */
export interface AdbRule {
  kind: 'forward' | 'reverse';
  serial: string;
  args: [string, string];
}

/** Everything the restart touches on the host, injectable so the decisions are unit-testable. */
export interface AdbRestartOps {
  /** False under `VERIKUN_NO_ADB_RECYCLE`. */
  enabled: boolean;
  /** Whether the leak is measurable here at all — only for saying why it was not measured. */
  macos: boolean;
  /** Measured once by the caller, which prints it too. */
  health: AdbServerHealth;
  /** `adb devices -l`; undefined when the listing itself failed. */
  devices(): DeviceInfo[] | undefined;
  /** Live verikun jobs on Android that a restart would cut off; undefined when claims are off,
   *  so they cannot be seen. */
  claimBlockers(): DeviceClaim[] | undefined;
  /** Other processes connected to the adb server; undefined when that cannot be seen. */
  peers(devicePorts: number[]): AdbPeer[] | undefined;
  /** Run `fn` under the host-wide restart lock unless `blocked()` — asked before taking the lock
   *  and again while holding it (see recycleHostAdb). */
  exclusive(blocked: () => boolean, fn: () => Promise<boolean>): Promise<RecycleResult>;
  /** The forward and reverse rules on these devices, to re-apply after the restart, and what
   *  could not be listed — whose rules a restart then loses unseen, so they are reported. */
  rules(devices: DeviceInfo[]): { rules: AdbRule[]; unread: string[] };
  /** Which binary the restart will use instead of the server's own, and why — or undefined. */
  substitute(): string | undefined;
  /** An earlier restart that produced the RUNNING server and did not clear the violations. */
  futile(): { at: string } | undefined;
  /** The new server and the violations it has thrown so far; undefined when not measurable. */
  settled(): Promise<{ pid: number; violations: number } | undefined>;
  /** Record whether the restart that produced `pid` cleared the violations. */
  remember(verdict: { pid: number; cleared: boolean }): void;
  /** kill-server, then start-server as the old one was started. */
  restart(): boolean;
  /** `adb connect <serial>`, best effort. */
  connect(serial: string): void;
  /** Re-apply one rule; false if it would not take (its port was taken meanwhile, …). */
  restore(rule: AdbRule): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type AdbRestartOutcome =
  | { kind: 'disabled' | 'healthy' | 'busy' | 'unwritable' | 'failed' }
  | { kind: 'futile'; at: string }
  | { kind: 'unmeasurable'; why: 'not-macos' | 'no-server' | 'log' }
  | { kind: 'unverifiable'; why: 'claims' | 'connections' | 'devices' }
  | { kind: 'in-use'; claims: DeviceClaim[]; peers: AdbPeer[] }
  | {
      kind: 'restarted';
      back: string[];
      missing: string[];
      ms: number;
      rules: { restored: number; lost: AdbRule[]; unread: string[] };
      substituted?: string;
      /** Did the new server come up clean? Absent when that could not be measured. */
      cleared?: boolean;
    };

/**
 * The adb ports of the attached devices that live on THIS host: an emulator answers adb on its
 * console port + 1 (`emulator-5554` → 5555), a loopback TCP device on its own port. The server's
 * link to them is a device, not a user, so these ports never count as somebody using adb.
 */
export function devicePorts(devices: DeviceInfo[]): number[] {
  const ports: number[] = [];
  for (const { serial } of devices) {
    const emulator = /^emulator-(\d+)$/.exec(serial);
    const loopback = /^(?:localhost|127\.[\d.]+|\[::1\]):(\d+)$/.exec(serial);
    if (emulator) ports.push(Number(emulator[1]) + 1);
    else if (loopback) ports.push(Number(loopback[1]));
  }
  return ports;
}

/** Lines of a `--list` reply that can be rules — not blank, not adb's own `* daemon …` chatter. */
const ruleLines = (stdout: string): string[][] =>
  stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('*')).map((l) => l.split(/\s+/));

/** `adb forward --list`: `<serial> <local> <remote>` per line. */
export function parseForwardList(stdout: string): AdbRule[] {
  return ruleLines(stdout).flatMap(([serial, local, remote]): AdbRule[] =>
    serial && local && remote ? [{ kind: 'forward', serial, args: [local, remote] }] : [],
  );
}

/** `adb -s <serial> reverse --list`: `<device-side transport> <remote> <local>` per line. The
 *  first column names the transport as the DEVICE sees it (`host-15`, `UsbFfs`), not a serial. */
export function parseReverseList(serial: string, stdout: string): AdbRule[] {
  return ruleLines(stdout).flatMap(([, remote, local]): AdbRule[] =>
    remote && local ? [{ kind: 'reverse', serial, args: [remote, local] }] : [],
  );
}

/** A device the old server reached through `adb connect host:port` — the one kind adb does not
 *  bring back by itself. mDNS-discovered wireless devices reconnect on their own. */
const isDialled = (serial: string): boolean => adbTransport(serial) === 'tcp' && /:\d+$/.test(serial);

/** Restart the host's adb server if it is leaking and nothing else is using it. */
export async function restartLeakingAdb(ops: AdbRestartOps, waitMs = DEVICE_RETURN_MS): Promise<AdbRestartOutcome> {
  if (!ops.enabled) return { kind: 'disabled' };
  if (ops.health.violations === undefined) {
    return { kind: 'unmeasurable', why: !ops.macos ? 'not-macos' : ops.health.pid ? 'log' : 'no-server' };
  }
  if (!adbServerRotting(ops.health)) return { kind: 'healthy' };
  // MEASURED: some violations are no leak at all — a Samsung SM-A415F on adb's native USB
  // backend makes even a fresh server throw ~1/s. One restart of a server is enough to learn
  // that, and repeating it would cut every device at every agent session for nothing.
  const prior = ops.futile();
  if (prior) return { kind: 'futile', at: prior.at };

  const before = ops.devices();
  // Without the list, an emulator's own link to adb cannot be told from a user's.
  if (!before) return { kind: 'unverifiable', why: 'devices' };
  const ports = devicePorts(before);
  // Whatever the LAST look found: the gate is asked here, then again under the lock, so a
  // blocker that arrived in between is the one reported.
  let refusal: AdbRestartOutcome | undefined;
  const inUse = (): boolean => {
    const claims = ops.claimBlockers();
    const peers = ops.peers(ports);
    refusal = claims?.length
      ? { kind: 'in-use', claims, peers: peers ?? [] }
      : !claims
        ? { kind: 'unverifiable', why: 'claims' }
        : !peers
          ? { kind: 'unverifiable', why: 'connections' }
          : peers.length
            ? { kind: 'in-use', claims, peers }
            : undefined;
    return refusal !== undefined;
  };
  // Asked directly first, so a known user is never cut off on the strength of how exclusive()
  // happens to be wired.
  if (inUse()) return refusal!;

  const { rules, unread } = ops.rules(before);
  const substituted = ops.substitute();
  let outcome: AdbRestartOutcome | undefined;
  const result = await ops.exclusive(inUse, async () => {
    const started = ops.now();
    if (!ops.restart()) return false;
    const { back, missing, ms } = await awaitDevices(before, ops, started, waitMs);
    const lost: AdbRule[] = [];
    let restored = 0;
    for (const rule of rules) {
      if (back.includes(rule.serial) && ops.restore(rule)) restored++;
      else lost.push(rule);
    }
    // Did it help? A leak's violations start only after a device drops; ones back within
    // seconds of a fresh start are a device the backend mishandles, which no restart clears.
    await ops.sleep(Math.max(0, SETTLE_MS - (ops.now() - started)));
    const after = await ops.settled();
    if (after) ops.remember({ pid: after.pid, cleared: after.violations === 0 });
    outcome = {
      kind: 'restarted',
      back,
      missing,
      ms,
      rules: { restored, lost, unread },
      ...(substituted ? { substituted } : {}),
      ...(after ? { cleared: after.violations === 0 } : {}),
    };
    return true;
  });
  if (result === 'blocked') return refusal ?? { kind: 'busy' };
  if (result === 'busy' || result === 'unwritable') return { kind: result };
  return result === 'restarted' && outcome ? outcome : { kind: 'failed' };
}

/** A device in either state may be the one adb dropped; on a leaking host `offline` is the usual
 *  state of exactly the device the restart is for. Anything else (unauthorized, …) is a human's. */
const recoverable = (d: DeviceInfo): boolean => d.state === 'device' || d.state === 'offline';

async function awaitDevices(
  before: DeviceInfo[],
  ops: AdbRestartOps,
  started: number,
  waitMs: number,
): Promise<{ back: string[]; missing: string[]; ms: number }> {
  for (const d of before) if (isDialled(d.serial)) ops.connect(d.serial);
  const want = before.filter(recoverable).map((d) => d.serial);
  for (;;) {
    const usable = new Set((ops.devices() ?? []).filter((d) => d.state === 'device').map((d) => d.serial));
    const back = want.filter((s) => usable.has(s));
    const elapsed = ops.now() - started;
    if (back.length === want.length || elapsed >= waitMs) {
      return { back, missing: want.filter((s) => !usable.has(s)), ms: elapsed };
    }
    await ops.sleep(POLL_MS);
  }
}

/** The real host: lsof for connections, the claim store, the server's own adb binary. */
export function hostRestartOps(health: AdbServerHealth, opts: ClaimOpts = {}): AdbRestartOps {
  const onPath = process.env.ADB || 'adb';
  // Asked lazily, while the old server is still up to say how it was started.
  let status: ReturnType<typeof adbServerStatus> | undefined;
  const server = () => (status ??= adbServerStatus(onPath));
  const adb = (args: string[]) => runText(server().executable, args, { timeout: 10_000 });
  // Seen by the connection check, needed by the restart: whether to start it with `-a`.
  let allInterfaces = false;
  const record = join(opts.home ?? homedir(), '.verikun', 'adb-restart.json');
  return {
    enabled: !process.env.VERIKUN_NO_ADB_RECYCLE,
    macos: platform() === 'darwin',
    health,
    devices: () => {
      try {
        const r = adb(['devices', '-l']);
        return r.code === 0 ? parseAdbDevices(r.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    claimBlockers: () => (claimsEnabled(opts.env) ? adbClaimBlockers(opts) : undefined),
    peers: (ports) => {
      const seen = health.pid ? adbServerConnections(health.pid, ports) : undefined;
      allInterfaces = seen?.allInterfaces ?? false;
      return seen?.peers;
    },
    exclusive: (blocked, fn) => recycleHostAdb(opts, fn, blocked),
    rules: (devices) => {
      const rules: AdbRule[] = [];
      const unread: string[] = [];
      // One listing at a time, so a device that will not answer costs only its own rules.
      const read = (what: string, args: string[], parse: (stdout: string) => AdbRule[]): void => {
        try {
          const r = adb(args);
          if (r.code === 0) rules.push(...parse(r.stdout));
          else unread.push(what);
        } catch {
          unread.push(what);
        }
      };
      read('the forward list', ['forward', '--list'], parseForwardList);
      for (const d of devices) {
        if (d.state === 'device') read(d.serial, ['-s', d.serial, 'reverse', '--list'], (out) => parseReverseList(d.serial, out));
      }
      return { rules, unread };
    },
    substitute: () => {
      const { executable, refused } = server();
      return refused ? `${executable} — the server's own ${refused} is gone or not trusted` : undefined;
    },
    restart: () => recycleAdbServer(server().executable, { allInterfaces, usbBackend: server().usbBackend }),
    connect: (serial) => {
      try {
        adb(['connect', serial]);
      } catch {
        /* best effort: a device that stays gone is reported as missing */
      }
    },
    restore: (rule) => {
      try {
        return adb(['-s', rule.serial, rule.kind, ...rule.args]).code === 0;
      } catch {
        return false;
      }
    },
    sleep,
    now: () => Date.now(),
    futile: () => {
      try {
        const last = JSON.parse(readFileSync(record, 'utf8')) as { pid?: number; cleared?: boolean; at?: string };
        return last.pid === health.pid && last.cleared === false ? { at: String(last.at) } : undefined;
      } catch {
        return undefined; // no record, or an unreadable one: no opinion
      }
    },
    settled: async () => {
      const pid = adbServerPid();
      const violations = pid ? serverViolations(pid, 10_000) : undefined;
      return pid && violations !== undefined ? { pid, violations } : undefined;
    },
    remember: ({ pid, cleared }) => {
      try {
        mkdirSync(dirname(record), { recursive: true });
        writeFileSync(record, JSON.stringify({ pid, cleared, at: new Date().toISOString() }));
      } catch {
        /* best effort: without the record the next run restarts once more, then knows */
      }
    },
  };
}

const peerLabel = (p: AdbPeer): string =>
  p.pid
    ? `${p.command || 'a process'} (pid ${p.pid})`
    : p.command
      ? `${p.command} (${p.endpoint})`
      : `an unidentified process on ${p.endpoint}`;

const UNMEASURABLE = {
  'not-macos': 'the leak is only measurable on macOS',
  'no-server': 'no adb server is running',
  log: 'the kernel log could not be read',
};

/** What `--restart-adb` did, as the lines doctor prints under its adb server line. */
export function describeAdbRestart(o: AdbRestartOutcome, opts: ClaimOpts = {}): string[] {
  switch (o.kind) {
    case 'disabled':
      return ['not restarting — VERIKUN_NO_ADB_RECYCLE is set'];
    case 'unmeasurable':
      return [`not restarting — ${UNMEASURABLE[o.why]}`];
    case 'healthy':
      return ['no leak measured — nothing to restart'];
    case 'futile':
      return [
        `not restarting — the restart at ${new Date(o.at).toTimeString().slice(0, 5)} did not clear it (the violations came straight back)`,
        '  a device on adb\'s native USB backend causes them, not a leak: start adb with ADB_LIBUSB=1 (see troubleshooting)',
      ];
    case 'unverifiable':
      return [
        o.why === 'claims'
          ? 'not restarting — VERIKUN_NO_CLAIM hides which verikun jobs are using adb'
          : o.why === 'devices'
            ? 'not restarting — `adb devices` failed, so devices cannot be told from other users'
            : 'not restarting — could not see what else is connected to adb',
      ];
    case 'unwritable':
      return ['not restarting — cannot write its lock under ~/.verikun/devices'];
    case 'busy':
      return [
        'not restarting — another verikun job is restarting it right now',
        '  (if none is, its lock is stale: ~/.verikun/devices/adb-recycle.lock)',
      ];
    case 'failed':
      return ['restart failed — adb did not come back up (the next adb command starts it again)'];
    case 'in-use':
      return [
        'not restarting — still in use by:',
        ...o.claims.map((c) => `  ${c.serial} — ${describeHolder(c, opts)}`),
        ...o.peers.map((p) => `  ${peerLabel(p)}`),
        'run `vk doctor --restart-adb` again once they are done',
      ];
    case 'restarted': {
      const total = o.back.length + o.missing.length;
      const secs = (o.ms / 1000).toFixed(1);
      const lines = [
        total ? `restarted — ${o.back.length}/${total} devices back in ${secs}s` : `restarted in ${secs}s — no devices were attached`,
      ];
      if (o.substituted) lines.push(`  restarted with ${o.substituted}`);
      if (o.cleared === false) {
        lines.push('  the violations came straight back on the new server — a restart does not fix these (try ADB_LIBUSB=1)');
      }
      if (o.missing.length) lines.push(`  not back: ${o.missing.join(', ')}`);
      if (o.rules.restored) lines.push(`  ${o.rules.restored} forward/reverse rule(s) restored`);
      for (const r of o.rules.lost) lines.push(`  not restored: ${r.kind} ${r.args.join(' ')} on ${r.serial}`);
      if (o.rules.unread.length) {
        lines.push(`  could not read forward/reverse rules on ${o.rules.unread.join(', ')} — any it had are gone`);
      }
      return lines;
    }
  }
}
