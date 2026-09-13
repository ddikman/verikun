/**
 * Is the HOST's adb server healthy, or has it rotted?
 *
 * A long-lived adb server leaks IOKit Mach ports and never recovers. Measured on macOS
 * 2026-09-12: a 9-day-old server logging EXC_GUARD `GUARD_TYPE_MACH_PORT` / `INVALID_NAME`
 * at 2/sec — 27,983 in 7h, every one of them from the adb pid — having burned 92 minutes
 * of CPU on the error loop. `adb kill-server && adb start-server` took it to zero and every
 * device came back in ~5s.
 *
 * WHY VERIKUN CARES, rather than leaving this to the operator: adb rot DEFEATS DEVICE
 * FAILOVER. `device/failover.ts` moves the server off a device that fails, but every
 * candidate sits behind the same host adb — so when the transport is what broke, failover
 * walks the pool retiring healthy phones for a host-side fault. That is the same polarity
 * error `ARTIFACT_RULES` exists to prevent on the install path: enumerate the thing you can
 * actually attribute, and never blame the open-ended side.
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

import { platform } from 'node:os';
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
 */
export function countViolations(stdout: string): number {
  return stdout.split('\n').filter((l) => l.includes('[adb:')).length;
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

/** One line a human can act on, or undefined when there is nothing worth saying. */
export function describeRot(health: AdbServerHealth): string | undefined {
  if (!adbServerRotting(health)) return undefined;
  const perMin = Math.round((health.violations! / (health.windowMs ?? VIOLATION_WINDOW_MS)) * 60_000);
  const age = health.ageMs !== undefined ? `, up ${Math.floor(health.ageMs / 3_600_000)}h` : '';
  return `adb server is leaking USB handles (~${perMin} kernel guard violations/min${age}) — devices will drop`;
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
  return platform === 'android' && process.env.VERIKUN_NO_ADB_RECYCLE !== '1';
}

/** The running adb server's pid. Undefined when there is none, or when `pgrep` is absent. */
function adbServerPid(): number | undefined {
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

/**
 * Survey the host's adb server. Never throws: every probe is wrapped, and an unavailable
 * signal comes back `undefined` so callers do nothing rather than something wrong.
 */
export function adbServerHealth(windowMs = VIOLATION_WINDOW_MS): AdbServerHealth {
  const pid = adbServerPid();
  const health: AdbServerHealth = { pid, ageMs: pid ? processAgeMs(pid) : undefined };
  if (platform() !== 'darwin' || !pid) return health;
  try {
    const secs = Math.max(1, Math.round(windowMs / 1000));
    const r = runText(LOG_BIN, ['show', '--last', `${secs}s`, '--style', 'compact', '--predicate', VIOLATION_PREDICATE], {
      timeout: 20000,
    });
    if (r.code !== 0) return health;
    return { ...health, violations: countViolations(r.stdout), windowMs };
  } catch {
    return health; // log(1) missing, sandboxed, or slow — no opinion, not a failure
  }
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
    hint: 'restart it: `adb kill-server && adb start-server` (safe; devices reconnect in a few seconds)',
  };
}

/**
 * Restart the host's adb server. Returns whether it came back.
 *
 * HOST-GLOBAL and therefore never called speculatively — `kill-server` drops every
 * transport on the machine, including devices this process does not own. Callers must have
 * evidence (`adbServerRotting`) and, on the server, an idle pool.
 */
export function recycleAdbServer(adb: string): boolean {
  try {
    runText(adb, ['kill-server'], { timeout: 20000 });
    const r = runText(adb, ['start-server'], { timeout: 30000 });
    return r.code === 0;
  } catch {
    return false; // never a new way to fail: the caller logs and carries on
  }
}
