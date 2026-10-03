import { recycleHostAdb, hostAdbRotting } from './server-host';
import { DeviceTable } from './server-devices';
import { LeaseTable } from './server-leases';
import { spawnCollect } from './exec';
import { listDevicesAsync } from './server-lifecycle';
// `vk server` — expose THIS machine's connected device to remote verikun clients
// (`vk ai/suite/install --server <url>`) over HTTP+JSON, Node's built-in http only.
//
// Security model (the server is the trust boundary, not the transport):
//  - Mandatory bearer auth: a key is REQUIRED unless --allow-unsafe-anonymous is
//    passed explicitly (for networks that are themselves the boundary, e.g. a
//    private tailnet). If none is configured, one is generated and printed loudly.
//    Comparison is crypto.timingSafeEqual over fixed-width sha256 digests.
//  - /v1/exec accepts ONLY verikun's validated action grammar: every request runs
//    through the SAME validateNode gate that guards `vk ai` model repairs, so only
//    KNOWN_COMMANDS action verbs execute — never `ui`/`log`, never a shell. Flags on
//    an /v1/exec request can NEVER repoint the device: it always runs against the
//    currently-bound driver. Archive-time log capture uses the dedicated /v1/logs
//    endpoint instead.
//  - /v1/install is a privileged management verb: auth PLUS --allow-install, body
//    streamed to a server-generated temp path (the client supplies only an
//    allowlisted extension — never a path), optional sha256 verification.
//  - /v1/devices/* is the other privileged verb: auth PLUS --allow-device-control,
//    and it is the ONLY thing that can change which device the server is bound to.
//    Two tiers: a bare flag permits restart/stop of the server's OWN device (a client
//    names nothing); `--allow-device-control=<names>` additionally permits starting a
//    target from that operator-declared allowlist. Naming is never open-ended — an
//    allowlist is the boundary, because enumerating the host's AVDs is autocomplete,
//    not authorization. Enabling this also lets an authenticated client ERASE the
//    device (`wipe`), which is the honest cost of the flag.
//  - Binds 127.0.0.1 unless --bind opts into exposure. One run-token holds the
//    held lease at a time. Socket close or heartbeat silence releases ownership.
//
// cli.ts reaches this module via a DYNAMIC import (no static cli↔server cycle, and
// node:http stays off the default CLI load path); this module imports cli.ts's
// executeForServer statically — a one-way runtime edge.

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Flags, flagStr, flagBool, flagNum } from './args';
import { RunEvictedError, DeviceGoneError, NoWindowError, isDeviceLoss, CliError } from './errors';
import { INSTALL_DEVICE_TIMEOUT_MS } from './install-timeouts';
import { getDriver } from './drivers';
import { releaseCompanionOnAsync } from './companion/manager';
import { ClaimOpts, touchClaim, claimDevice, claimsEnabled, releaseClaim, setProcessScoped, summarize } from './device/claims';
import { isUsableState, csvList, poolSerials, resolvePoolPlatform, type DevicePoolSpec } from './device/pool';
import { err, setErrSink, setOutputQuiet } from './output';
import { HttpError, encodeArtifacts, firstLine, flagsToSpecs, readBody, sendJson } from './server-http';
import { LifecycleOpts, ServerLifecycle, realLifecycle } from './server-lifecycle';
import { LOG_OFF, openServerLog, resolveLogPath, type ServerLog } from './server-log';
import { DeviceInfo, HierarchySource, Platform } from './types';
import { DeviceHandle, DevicePool, WorkerDevicePool } from './server-pool';
import type { WorkerExecResult } from './server-worker';
import { InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import {
  describeError, rebuildError, DeviceListResponse, DeviceOpRequest, DeviceOpResponse,
  ExecRequest, ExecResponse, HealthResponse, InstallResponse, LeaseResponse, LogsRequest,
  LogsResponse, RpcErrorBody,
} from './rpc';
import { platformFromFlags, deviceFromFlags } from './cli';
import { adbRecycleEnabled } from './adb-health';
import { sleep } from './wait';
import { VERSION } from './version';

/**
 * A driver's read path, or null when the backend has no opinion (iOS reads through idb, one
 * way only) or the probe failed.
 *
 * Best-effort on purpose. It is reported on `/v1/health`, which is also how a client checks
 * the server is reachable at all — a companion probe must never be the reason that answer
 * cannot be given.
 */
async function safeReads(handle: DeviceHandle | undefined): Promise<HierarchySource | null> {
  if (!handle) return null;
  try {
    return await handle.reads();
  } catch {
    return null;
  }
}

const DEFAULT_PORT = 8391;
const EXEC_BODY_CAP = 1024 * 1024; // 1 MB of JSON is far beyond any leaf command
const INSTALL_BODY_CAP = 512 * 1024 * 1024; // 512 MB app build
const HTTP_KEEP_ALIVE_MS = 5 * 60 * 1000;
// How often to ask whether the host's adb server has rotted. Generous on purpose: the
// check shells out to `log show` (~1s) and the condition it looks for accumulates over
// DAYS, so a tight interval would buy nothing and spend host time on every idle server.
const ADB_RECYCLE_CHECK_MS = 10 * 60 * 1000;
// Deliberately below the client's 5-minute ceiling, so a slow boot is reported by the
// side that knows WHY ("did not finish booting within 240s") rather than as a generic
// client-side abort.
const SERVER_BOOT_TIMEOUT_MS = 4 * 60 * 1000;

/** What `--allow-device-control[=names]` grants. */
export interface DeviceControlPolicy {
  /** Targets a client may name. EMPTY = restart/stop the bound device only; a request
   *  carrying `target` is rejected 400. Set by `--allow-device-control=<a,b>`. */
  allowedTargets: string[];
}

/**
 * Where this server may move when the bound device fails.
 *
 * Unlike device control, failover is ON BY DEFAULT — and that is not a new liberty. A
 * server started WITHOUT `--device` already auto-selected a free device via
 * `selectAndClaim` (drivers/adb.ts), so moving to another free, healthy, unclaimed one
 * is that same decision made again. A server started WITH `--device` had its binding
 * chosen by a human, and a pin means what it says.
 */
export interface FailoverPolicy {
  /** Serials/names it may move TO. EMPTY = any attached, running, unclaimed device
   *  (the default). Set by `--allow-failover=<a,b>`. */
  allowedTargets: string[];
}

export interface ServerConfig {
  // --- startup policy: never written after buildServer ---
  platform: Platform;
  now?: () => number;
  probe?: (serial: string) => Promise<boolean>;
  probeGraceMs?: number;
  deadlineFloorMs?: number;
  holdIdleMs?: number;
  /** undefined = --allow-unsafe-anonymous (auth disabled deliberately). */
  authKey?: string;
  allowInstall: boolean;
  /** undefined = device control disabled (403 on /v1/devices/*). */
  deviceControl?: DeviceControlPolicy;
  /** undefined = this server stays on its device whatever happens (pinned, or opted out). */
  failover?: FailoverPolicy;
  // --- the devices ---
  /** What this server serves. EMPTY = started with no device (only reachable with
   *  deviceControl). Injected as a seam so the whole policy matrix — leases, failover,
   *  device control — is testable with neither a device nor a forked process. */
  pool: DevicePool;
  /**
   * What `--devices` asked for, so the reconciler knows what "missing" means.
   *
   * Undefined means the initial singleton binding is the wanted set. Device control
   * rewrites it; health and readmission apply at every capacity.
   */
  poolSpec?: DevicePoolSpec;
  // --- seams (tests) ---
  lifecycle?: ServerLifecycle;
  /** How often to look for devices that should be serving and are not. 0 disables the
   *  sweep entirely, which is what the unit suite uses when it is asserting something else. */
  reconcileMs?: number;
  /** Points the host-global claim store somewhere throwaway. Undefined in production,
   *  where the store is $HOME-relative — without this a unit test asserting the failover
   *  claim hand-off would write into the developer's real `~/.verikun/devices`. */
  claimOpts?: ClaimOpts;
  /** Per-device install deadline. A short value keeps the hang path unit-testable; the
   *  production default is INSTALL_DEVICE_TIMEOUT_MS. */
  installAttemptMs?: number;
  installGraceMs?: number;
}

export function buildServer(config: ServerConfig): Server {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const lifecycle = config.lifecycle ?? realLifecycle;
  const pool = config.pool;
  const claimOpts = config.claimOpts ?? {};
  const claimEnv = claimOpts.env ?? process.env;
  const now = config.now ?? Date.now;
  const watch = !process.env.VERIKUN_NO_DEVICE_WATCH;
  if (!watch) err('[server] VERIKUN_NO_DEVICE_WATCH is set — device supervision disabled');
  let closed = false;
  let wanted = config.poolSpec ?? { all: false, serials: pool.serials() };
  const table = new DeviceTable(now, (serial, why) => evictHoldersOf(serial, why), m => err(`[server] device: ${m}`), serial => pool.retire(serial));
  const leaseTable = new LeaseTable(() => table.ready().filter(s => pool.get(s) !== undefined && !restoring.has(s) && (!lastInstall || table.get(s)?.installedSha === lastInstall.sha)), now,
    m => err(`[server] lease: ${m}`), token => { void restoreOriginals(token); });
  const { leases, evicted, inFlight } = leaseTable;
  for (const serial of pool.serials()) table.transition(serial, 'ready', 'executor ready');
  const restoring = new Set<string>();
  const heldTokens = new Set<string>();
  const endHolds = new Map<string, () => void>();
  const restoreTasks = new Map<string, Promise<void>>();
  const pendingOriginals = new Map<string, Record<string, string>>();
  let lastInstall: { path: string; ext: string; sha: string } | null = null;
  const retainedPaths = new Set<string>();
  const installingPaths = new Map<string, number>();
  const pruneRetainedInstalls = (): void => {
    for (const path of retainedPaths) {
      if (path === lastInstall?.path || installingPaths.has(path)) continue;
      try { unlinkSync(path); } catch {}
      retainedPaths.delete(path);
    }
  };
  const installArtifact = async (handle: DeviceHandle, path: string): Promise<void> => {
    installingPaths.set(path, (installingPaths.get(path) ?? 0) + 1);
    try { await handle.install(path); }
    finally {
      const remaining = installingPaths.get(path)! - 1;
      if (remaining) installingPaths.set(path, remaining);
      else installingPaths.delete(path);
      pruneRetainedInstalls();
    }
  };
  const joining = new Set<string>();
  const checking = new Map<string, Promise<void>>();
  const draining = new Set<string>();
  const lastLoss = (): string | undefined => {
    const r = table.all().filter(d => d.state === 'down').sort((a, b) => b.since - a.since)[0];
    return r ? `${r.serial} (${r.reason})` : undefined;
  };
  let cachedDevices: DeviceInfo[] = [];
  let kind: 'virtual' | 'physical' | undefined = config.platform === 'android' && pool.serials().some(s => s.startsWith('emulator-')) ? 'virtual' : undefined;
  const isVirtual = (d: DeviceInfo): boolean => d.kind === 'emulator' || d.kind === 'simulator';
  const soleSerial = (): string | null => {
    const all = wanted.all ? table.all().map(r => r.serial) : wanted.serials;
    return all.length === 1 ? all[0] : null;
  };
  const quarantineList = () => table.quarantined();
  const degradedList = () => table.degraded();
  const restoreDevice = (serial: string): void => { table.report(serial); };
  const restoreOriginals = (token: string): Promise<void> => {
    const lease = leases.get(token);
    const originals = leaseTable.originals.get(token);
    if (!lease || !originals || !Object.keys(originals).length) return Promise.resolve();
    leaseTable.originals.delete(token);
    const serial = lease.serial;
    const pending = pendingOriginals.get(serial) ?? {};
    for (const [k, v] of Object.entries(originals)) if (!(k in pending)) pending[k] = v;
    pendingOriginals.set(serial, pending);
    return restoreSerial(serial);
  };
  const restoreSerial = (serial: string): Promise<void> => {
    const running = restoreTasks.get(serial); if (running) return running;
    const originals = pendingOriginals.get(serial); const h = pool.get(serial);
    if (!originals || !h) return Promise.resolve();
    restoring.add(serial);
    const task = (async () => {
      for (const [key, value] of Object.entries(originals)) {
        try {
          const result = await h.exec({ command: 'device', positionals: ['set', `${key}=${value}`], flags: {} });
          if (result.code === 0) delete originals[key];
        } catch { /* next admission retries while the device remains unavailable */ }
      }
      if (!Object.keys(originals).length) pendingOriginals.delete(serial);
    })().finally(() => { restoring.delete(serial); restoreTasks.delete(serial); leaseTable.changed(); });
    restoreTasks.set(serial, task); return task;
  };
  const evictHoldersOf = (serial: string, why: string): void => {
    for (const [token, lease] of leases) if (lease.serial === serial) { void restoreOriginals(token); leaseTable.evict(token, why); endHolds.get(token)?.(); }
  };
  const evict = (token: string, why: string): void => { void restoreOriginals(token); leaseTable.evict(token, why); endHolds.get(token)?.(); };
  const reapLeases = (): void => {
    for (const [token, lease] of leases) {
      if (!pool.get(lease.serial) && table.get(lease.serial)?.state !== 'joining')
        evict(token, `${lease.serial} is no longer in the pool`);
    }
  };
  const othersActive = (token: string): boolean => { reapLeases(); return leaseTable.othersActive(token); };
  const busyError = (token?: string): HttpError => {
    const lost = token ? evicted.get(token) : undefined;
    if (lost) return new HttpError(409, `this run lost its device${lost.serial ? ` (${lost.serial})` : ''}: ${lost.why} — start a fresh run; this one cannot continue on another device`, 3, 'RunEvictedError');
    const n = table.ready().length;
    return new HttpError(409, n > 1 ? `all ${n} devices are leased by other active runs — retry when one finishes` : 'device is locked by another active run — retry when it finishes');
  };
  const leasedHandle = (token: string): DeviceHandle => {
    const serial = leases.get(token)?.serial;
    if (!serial) {
      if (evicted.has(token)) throw busyError(token);
      throw new HttpError(428, 'device execution requires a streaming held lease', 3);
    }
    if (draining.has(serial) || restoring.has(serial) || !table.ready().includes(serial))
      throw new HttpError(409, `device ${serial} is checking or draining a previous call`, 3);
    const handle = pool.get(serial); if (!handle) throw new HttpError(503, `device ${serial} is no longer attached`, 3);
    return handle;
  };
  const holdingLease = <T>(token: string, fn: () => Promise<T>): Promise<T> => leaseTable.hold(token, async () => {
    const serial = leases.get(token)?.serial;
    try { return await fn(); }
    finally { if (serial && !leases.has(token)) await restoreSerial(serial); }
  });
  const rememberOriginals = (token: string, serial: string, originals?: Record<string, string>): void => {
    if (!originals) return;
    const target = leases.has(token) ? leaseTable.originals : pendingOriginals;
    const key = leases.has(token) ? token : serial;
    const saved = target.get(key) ?? {};
    for (const [k, v] of Object.entries(originals)) if (!(k in saved)) saved[k] = v;
    target.set(key, saved);
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (!config.authKey) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    return !!m && timingSafeEqual(sha(m[1]), sha(config.authKey));
  };

  // A worker can remain blocked in spawnSync after retirement. Only its exit releases
  // the host claim; the pool refuses a second executor for that serial until then.
  pool.onLoss(async (serial, why) => {
    table.transition(serial, 'down', why);
    await releaseCompanionOnAsync(serial);
    if (claimsEnabled(claimEnv)) releaseClaim(serial, { ...claimOpts, mineOnly: true });
  });

  const probe = async (serial: string): Promise<boolean> => {
    if (config.probe) return config.probe(serial);
    const handle = pool.get(serial);
    if (config.lifecycle && handle) {
      try { await handle.preflight(); return true; } catch { return false; }
    }
    const r = await spawnCollect(config.platform === 'android' ? (process.env.ADB || 'adb') : (process.env.IDB || 'idb'),
      config.platform === 'android' ? ['-s', serial, 'shell', 'echo', 'ok'] : ['describe', '--udid', serial],
      { timeout: 5000, stdoutTailBytes: 4096 });
    return r.code === 0 && (config.platform !== 'android' || r.stdout.trim() === 'ok');
  };
  const bootIdentity = async (serial: string): Promise<string | null> => {
    if (config.lifecycle) return 'fake-boot';
    if (config.platform !== 'android') {
      const sims = await spawnCollect(process.env.XCRUN || 'xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 5000 });
      if (sims.code !== 0) throw new CliError('cannot verify iOS boot readiness', 3);
      const data = JSON.parse(sims.stdout) as { devices?: Record<string, Array<{udid: string; state: string}>> };
      const sim = Object.values(data.devices ?? {}).flat().find(d => d.udid === serial);
      if (sim) {
        const ready = await spawnCollect(process.env.XCRUN || 'xcrun', ['simctl', 'bootstatus', serial, '-b'], { timeout: 5000 });
        if (sim.state !== 'Booted' || ready.code !== 0) throw new CliError('simulator has not completed boot', 3);
      }
      return null;
    }
    const r = await spawnCollect(process.env.ADB || 'adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5000 });
    if (r.code !== 0 || r.stdout.trim() !== '1') return null;
    const b = await spawnCollect(process.env.ADB || 'adb', ['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id'], { timeout: 5000 });
    return b.code === 0 ? b.stdout.trim() || null : null;
  };
  const check = (serial: string, why: string, strike = false): Promise<void> => {
    const existing = checking.get(serial); if (existing) return existing;
    const work = (async () => {
      const until = now() + (config.probeGraceMs ?? 8000);
      do {
        if (closed) return;
        if (await probe(serial)) {
          if (!draining.has(serial)) {
            try { await pool.get(serial)?.recover?.(); } catch { break; }
          }
          if (strike) {
            const h = pool.get(serial);
            try { await h?.exec({ command: 'home', positionals: [], flags: {} }); await h?.elements(); }
            catch (e) { if (!(e instanceof NoWindowError)) break; }
          }
          await restoreSerial(serial);
          if (pendingOriginals.has(serial)) break;
          if (!draining.has(serial) && pool.get(serial)) table.transition(serial, 'ready', 'liveness confirmed');
          leaseTable.changed(); return;
        }
        if (now() >= until) break;
        await sleep(Math.min(1000, Math.max(0, until - now())));
      } while (now() < until);
      if (closed) return;
      table.transition(serial, 'down', why);
      pool.retire(serial);
      leaseTable.changed();
    })().finally(() => checking.delete(serial));
    checking.set(serial, work); return work;
  };
  const transportLosses = new Map<string, number>();
  let hostUntil = 0;
  const reportFailure = async (e: unknown, what: string, handle: DeviceHandle): Promise<void> => {
    const serial = handle.serial;
    err(`[server] ${what}: FAILED on ${serial} — ${(e as Error).message}`);
    if (!watch) return;
    if (e instanceof DeviceGoneError) {
      transportLosses.set(serial, now());
      for (const [s, t] of transportLosses) if (now() - t > 10_000) transportLosses.delete(s);
      if (table.all().length >= 2) await sleep(250);
      if (transportLosses.size >= 2 && transportLosses.size >= table.all().length / 2) {
        if (hostUntil <= now()) hostUntil = now() + 15_000;
        for (const r of table.all()) if (r.state === 'ready' || r.state === 'leased') table.transition(r.serial, 'joining', 'host transport event');
      }
    }
    if (hostUntil > now()) {
      table.transition(serial, 'joining', 'host transport event');
      await sleep(Math.max(0, hostUntil - now()));
      if (await probe(serial)) { table.transition(serial, 'ready', 'host transport recovered'); return; }
      table.transition(serial, 'checking', (e as Error).message, { evict: true });
      await check(serial, (e as Error).message); return;
    }
    const verdict = table.report(serial, e);
    if (verdict === 'check') void check(serial, (e as Error).message, !isDeviceLoss(e)).catch(error => err(`[server] checking ${serial}: ${(error as Error).message}`));
    return;
  };
  const boundedCall = async <T>(handle: DeviceHandle, req: IncomingMessage, fn: () => Promise<T>): Promise<T> => {
    const raw = Number(req.headers['x-verikun-deadline-ms']);
    const ms = Math.max(config.deadlineFloorMs ?? 60_000, Number.isFinite(raw) && raw > 0 ? raw : 600_000);
    let timer: NodeJS.Timeout | undefined;
    const call = fn();
    try {
      return await Promise.race([call, new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          draining.add(handle.serial);
          table.transition(handle.serial, 'checking', 'step exceeded its deadline');
          void check(handle.serial, 'step exceeded its deadline');
          reject(new CliError('step exceeded its deadline', 3));
        }, ms);
        timer.unref();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      void call.then(() => {}, () => {}).finally(() => {
        if (!draining.delete(handle.serial)) return;
        if (pool.get(handle.serial) && table.get(handle.serial)?.state === 'checking') {
          void check(handle.serial, 'deadline call drained');
        }
      });
    }
  };
  const packageIdentity = async (serial: string): Promise<string | undefined> => {
    if (config.platform !== 'android' || config.lifecycle) return;
    const r = await spawnCollect(process.env.ADB || 'adb', ['-s', serial, 'shell', 'dumpsys', 'package'], { timeout: 5000 });
    if (r.code !== 0) return;
    // Snapshot all package versions/update times: hand-installing any build invalidates
    // the shortcut without requiring aapt or trusting an APK filename as its package ID.
    const fields = r.stdout.split('\n').filter(line => /Package \[|versionCode=|lastUpdateTime=/.test(line)).map(line => line.trim());
    return fields.some(line => line.includes('lastUpdateTime=')) ? createHash('sha256').update(fields.join('\n')).digest('hex') : undefined;
  };
  const admit = async (serial: string, allowExclusive = false): Promise<boolean> => {
    if (joining.has(serial) || closed || (!allowExclusive && leaseTable.exclusive !== null)) return false;
    const held = claimsEnabled(claimEnv) ? summarize(serial, claimOpts) : undefined;
    if (held && !held.mine) return false;
    joining.add(serial);
    const previous = table.get(serial);
    table.transition(serial, 'joining', 'admission');
    try {
      if (!(await probe(serial))) throw new CliError('device failed admission echo', 3);
      const bootId = await bootIdentity(serial);
      if (config.platform === 'android' && !bootId) throw new CliError('device has not completed boot', 3);
      if (claimsEnabled(claimEnv) && !claimDevice(serial, config.platform, claimOpts).ok) throw new CliError('device held by another job', 3);
      if (!(await pool.adopt(serial))) throw new CliError('previous executor has not exited or admission failed', 3);
      await restoreSerial(serial);
      if (pendingOriginals.has(serial)) throw new CliError('device overrides could not be restored', 3);
      const build = lastInstall;
      let identity = build ? await packageIdentity(serial) : undefined;
      if (build && !(config.platform === 'android' && previous?.installedSha === build.sha && previous?.bootId === bootId && identity && identity === previous?.packageIdentity)) {
        const h = pool.get(serial)!;
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([installArtifact(h, build.path), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CliError('catch-up install exceeded its deadline', 3)), config.installAttemptMs ?? INSTALL_DEVICE_TIMEOUT_MS); timer.unref();
        })]); } finally { if (timer) clearTimeout(timer); }
      }
      if (closed) { pool.retire(serial); return false; }
      while (!allowExclusive && leaseTable.exclusive !== null && !closed) await sleep(50);
      if (build) identity = await packageIdentity(serial);
      if (build !== lastInstall) throw new CliError('build changed during admission', 3);
      table.transition(serial, 'ready', 'admission complete', { ...(build ? { installedSha: build.sha } : {}), ...(bootId ? { bootId } : {}), ...(identity ? { packageIdentity: identity } : {}) });
      leaseTable.changed(true); return true;
    } catch (e) {
      table.transition(serial, 'down', (e as Error).message, { installFailure: /install/i.test((e as Error).message) });
      pool.retire(serial); return false;
    } finally { joining.delete(serial); }
  };
  const rebind = async (serial: string | null): Promise<void> => {
    for (const s of pool.serials()) { evictHoldersOf(s, 'the device was restarted'); table.transition(s, 'down', 'device control'); }
    wanted = { all: false, serials: serial ? [serial] : [] };
    await pool.rebind(serial);
    for (const r of table.all()) if (r.serial !== serial) table.remove(r.serial);
    if (serial) {
      table.transition(serial, 'joining', 'device control admission');
      if (!(await admit(serial, true))) throw new CliError(`device ${serial} could not complete admission`, 3);
    }
    leaseTable.changed();
  };
  const enumerate = async (): Promise<DeviceInfo[]> => config.lifecycle
    ? lifecycle.list(config.platform) : listDevicesAsync(config.platform);
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking || closed) return;
    ticking = true;
    try {
      cachedDevices = await enumerate();
      if (wanted.all && kind === undefined) {
        const initial = cachedDevices.filter(d => pool.serials().includes(d.serial));
        kind = initial.some(isVirtual) ? 'virtual' : 'physical';
      }
      const targets = wanted.all ? cachedDevices.filter(d => isUsableState(d.state) && (kind === 'virtual' ? isVirtual(d) : !isVirtual(d))).map(d => d.serial) : wanted.serials;
      await Promise.all(targets.map(async serial => {
        const r = table.get(serial);
        if (!r || (r.state === 'down' && now() >= r.nextTryAt) ||
          (r.state === 'joining' && r.reason === 'build changed after install')) { await admit(serial); return; }
        if (r.state === 'joining' && r.reason === 'host transport event' && hostUntil <= now()) {
          if (await probe(serial)) table.transition(serial, 'ready', 'host transport recovered');
          else { table.transition(serial, 'checking', 'host transport did not recover'); await check(serial, 'host transport did not recover'); }
          return;
        }
        if (claimsEnabled(claimEnv)) touchClaim(serial, config.platform, claimOpts);
        if (watch && (r.state === 'ready' || r.state === 'leased') && now() - r.lastEchoAt >= 15_000) {
          if (table.echo(serial, await probe(serial)) === 'check') await check(serial, 'two missed liveness echoes');
        }
      }));
      if (!wanted.all && wanted.serials.length <= 1 && !table.ready().length && config.failover && !config.poolSpec) {
        const spares = cachedDevices.filter(d => isUsableState(d.state) && !wanted.serials.includes(d.serial) &&
          (!config.failover!.allowedTargets.length || config.failover!.allowedTargets.includes(d.serial) || config.failover!.allowedTargets.includes(d.name ?? '')));
        for (const spare of spares) if (await admit(spare.serial)) {
          wanted = { all: false, serials: [spare.serial] }; break;
        }
      }
      leaseTable.changed();
    } finally { ticking = false; }
  };
  const reconcileMs = config.reconcileMs ?? 5000;
  const reconcileTimer = reconcileMs > 0 ? setInterval(() => { void tick().catch(e => err(`[server] watch: ${(e as Error).message}`)); }, reconcileMs) : undefined;
  reconcileTimer?.unref();
  let recycling = false;
  const recycleTimer = adbRecycleEnabled(config.platform) && !config.lifecycle ? setInterval(() => {
    if (recycling || closed || inFlight.size || leaseTable.exclusive !== null) return;
    recycling = true;
    void (async () => {
      if (!(await hostAdbRotting())) return;
      await recycleHostAdb(claimOpts, () => leaseTable.drainAndHold('(adb-host)', async () => {
        const members = table.all().filter(r => r.state === 'ready' || r.state === 'leased');
        for (const r of members) table.transition(r.serial, 'joining', 'host transport event');
        const adb = process.env.ADB || 'adb';
        await spawnCollect(adb, ['kill-server'], { timeout: 20_000 });
        const r = await spawnCollect(adb, ['start-server'], { timeout: 30_000 });
        if (hostUntil <= now()) hostUntil = now() + 15_000;
        for (const member of members) {
          if (await probe(member.serial)) table.transition(member.serial, 'ready', 'host transport recovered');
        }
        return r.code === 0;
      }));
    })().catch(e => err(`[server] adb recycle: ${(e as Error).message}`)).finally(() => { recycling = false; });
  }, ADB_RECYCLE_CHECK_MS) : undefined;
  recycleTimer?.unref();
  const dropRetainedInstall = (): void => { lastInstall = null; pruneRetainedInstalls(); };

  async function handleExec(handle: DeviceHandle, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const body = await readBody(req, EXEC_BODY_CAP);
    let parsed: ExecRequest;
    try {
      parsed = JSON.parse(body.toString('utf8')) as ExecRequest;
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
    // The exact gate that guards model repairs: only KNOWN_COMMANDS action verbs
    // pass — a client cannot run `ui`, `log`, or anything outside the grammar.
    let node;
    try {
      node = validateNode(
        { type: 'command', command: parsed?.command, positionals: parsed?.positionals, flags: flagsToSpecs(parsed?.flags) },
        'rpc',
      );
    } catch (e) {
      if (e instanceof InvalidPlanError) throw new HttpError(400, `rejected: ${e.message}`);
      throw e;
    }
    if (node.type !== 'command') throw new HttpError(400, 'rejected: not a command leaf');

    const t0 = Date.now();
    // Off to this device's forked process: the call underneath is a blocking spawnSync,
    // and running it here would stall every other device's requests.
    //
    // Both thrown failures and exit-3 outcomes feed the same health authority.
    let outcome: WorkerExecResult;
    try {
      outcome = await boundedCall(handle, req, () => handle.exec({
        command: node.command,
        positionals: node.positionals,
        flags: leafToFlags(node),
        sampleDeviceTime: parsed.record !== false && !leases.get(token)?.logSampled,
      }).then(result => {
        rememberOriginals(token, handle.serial, result.originals);
        return result;
      }));
    } catch (e) {
      await reportFailure(e, 'exec', handle);
      throw evicted.has(token) && !isDeviceLoss(e) ? new RunEvictedError((e as Error).message) : e;
    }
    const { code, error, step, artifacts, logStart } = outcome;
    if (logStart && parsed.record !== false && leases.has(token)) leases.get(token)!.logSampled = true;
    err(`[server] ${handle.serial} exec ${node.command} ${node.positionals.join(' ')} → exit ${code} (${Date.now() - t0}ms)`);
    // Anything but an ENVIRONMENT failure proves the device drove the step: exit 1 is a
    // failed assertion and exit 2 a usage error, both of which are verdicts about the APP
    // — the same polarity the classifier itself applies (exit 1 → `app`, exit 2 → `usage`,
    // neither ever moves). Only exit 3 leaves the device still suspect.
    if (code !== 3) restoreDevice(handle.serial);
    // The step keeps its own verdict whatever we decide here: the error below is the one
    // THIS device produced, never a replay's. Only the pool membership moves.
    if (code !== 0 && error) await reportFailure(rebuildError(error), 'exec', handle);
    const verdict = error && evicted.has(token) && !isDeviceLoss(rebuildError(error))
      ? describeError(new RunEvictedError(error.message)) : error;
    const payload: ExecResponse = {
      code,
      ...(verdict ? { error: verdict } : {}),
      ...(step ? { step } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts: encodeArtifacts(artifacts) } : {}),
      ...(logStart ? { logStart } : {}),
    };
    sendJson(res, 200, payload);
  }

  async function handleElements(handle: DeviceHandle, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    await readBody(req, EXEC_BODY_CAP); // drain (the body is unused; keeps keep-alive sane)
    try {
      const elements = await boundedCall(handle, req, () => handle.elements()); // CliError(3) on dump failure → 500 below
      // A hierarchy dump is the single most demanding thing this server asks of a device,
      // so one that succeeds is strong evidence the device is well again.
      restoreDevice(handle.serial);
      sendJson(res, 200, { elements });
    } catch (e) {
      await reportFailure(e, 'read', handle);
      throw evicted.has(token) && !isDeviceLoss(e) ? new RunEvictedError((e as Error).message) : e;
    }
  }

  async function handleLogs(handle: DeviceHandle, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, EXEC_BODY_CAP);
    let parsed: LogsRequest = {};
    if (body.length) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as LogsRequest;
      } catch {
        throw new HttpError(400, 'invalid JSON body');
      }
    }
    // Mirror the driver's --since charset gate so a remote caller cannot inject
    // into the device shell via a crafted marker (see AdbDriver.getLogs).
    if (parsed.since !== undefined && parsed.since !== null) {
      if (typeof parsed.since !== 'string' || !/^[0-9 :.\-]+$/.test(parsed.since)) {
        throw new HttpError(400, `invalid since: only a logcat timestamp (digits, space, '-', ':', '.') is allowed`);
      }
    }
    const lines =
      parsed.lines === undefined || parsed.lines === null
        ? undefined
        : typeof parsed.lines === 'number' && Number.isFinite(parsed.lines) && parsed.lines > 0
          ? Math.floor(parsed.lines)
          : undefined;
    const appId =
      parsed.appId === undefined || parsed.appId === null
        ? undefined
        : typeof parsed.appId === 'string' && /^[A-Za-z0-9_.-]+$/.test(parsed.appId)
          ? parsed.appId
          : (() => {
              throw new HttpError(400, `invalid appId '${String(parsed.appId)}'`);
            })();
    // The LEASED device, never one captured at startup: logs are evidence about the run
    // that just failed, and serving another device's is a lie.
    const logs = await boundedCall(handle, req, () => handle.logs({
      ...(lines !== undefined ? { lines } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(appId ? { appId } : {}),
      ...(parsed.scopedOnly ? { scopedOnly: true } : {}),
    }));
    const payload: LogsResponse = { logs };
    sendJson(res, 200, payload);
  }

  async function handleInstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ext = String(req.headers['x-verikun-ext'] ?? '').toLowerCase();
    if (ext !== 'apk' && ext !== 'ipa') {
      throw new HttpError(400, `x-verikun-ext must be 'apk' or 'ipa' (got '${ext || '(missing)'}')`);
    }
    // The temp path is server-generated — the client never supplies a path, so
    // there is no traversal surface. Streamed (backpressured), never buffered.
    const dir = join(tmpdir(), 'verikun-server');
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `${randomUUID()}.${ext}`);
    const hasher = createHash('sha256');
    let size = 0;
    let retained = false;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > INSTALL_BODY_CAP) {
          cb(new HttpError(413, `install body exceeds ${INSTALL_BODY_CAP} bytes`));
          return;
        }
        hasher.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmpPath));
      const digest = hasher.digest('hex');
      const expected = String(req.headers['x-verikun-sha256'] ?? '').toLowerCase();
      if (expected && expected !== digest) {
        throw new HttpError(400, `sha256 mismatch: upload arrived corrupted (got ${digest.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`);
      }
      const targets = table.ready().filter(s => pool.get(s));
      if (!targets.length) throw new HttpError(503, 'no device is left to install onto', 3);
      const outcomes = new Map<string, { ok: boolean; reason?: string; timedOut?: boolean }>();
      let firstSuccess: (() => void) | undefined;
      const success = new Promise<void>(resolve => { firstSuccess = resolve; });
      const tasks = targets.map(async serial => {
        table.transition(serial, 'installing', 'install requested');
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([installArtifact(pool.get(serial)!, tmpPath), new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              outcomes.set(serial, { ok: false, reason: 'install exceeded its per-device deadline', timedOut: true });
              reject(new CliError('install exceeded its per-device deadline', 3));
            }, config.installAttemptMs ?? INSTALL_DEVICE_TIMEOUT_MS); timer.unref();
          })]);
          if (timer) { clearTimeout(timer); timer = undefined; }
          const bootId = await bootIdentity(serial);
          outcomes.set(serial, { ok: true });
          const identity = await packageIdentity(serial);
          table.transition(serial, 'installing', 'build installed', { installedSha: digest, ...(bootId ? { bootId } : {}), ...(identity ? { packageIdentity: identity } : {}) });
          firstSuccess?.();
        } catch (e) {
          outcomes.set(serial, { ...outcomes.get(serial), ok: false, reason: (e as Error).message });
          // An all-device artifact rejection preserves the previous build. Decide
          // that rollback before retiring otherwise healthy executors.
          if (outcomes.get(serial)?.timedOut || retained)
            table.transition(serial, 'down', (e as Error).message, { installFailure: true });
        } finally { if (timer) clearTimeout(timer); }
      });
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(tasks), success.then(() => new Promise<void>(resolve => {
        graceTimer = setTimeout(resolve, config.installGraceMs ?? 60_000); graceTimer.unref();
      }))]);
      if (graceTimer) clearTimeout(graceTimer);
      const devices = targets.filter(s => outcomes.get(s)?.ok);
      if (!devices.length) {
        // A non-timeout all-device failure can describe the artifact itself; keep the
        // previous build and readmit devices against it. A timeout never clears health.
        for (const serial of targets) if (!outcomes.get(serial)?.timedOut && pool.get(serial))
          table.transition(serial, 'ready', 'previous build retained');
        throw new HttpError(500, outcomes.values().next().value?.reason ?? 'install failed on every device', 3);
      }
      retained = true; retainedPaths.add(tmpPath);
      lastInstall = { path: tmpPath, ext, sha: digest };
      pruneRetainedInstalls();
      for (const serial of devices) table.transition(serial, 'ready', 'current build installed', { installedSha: digest });
      for (const r of table.all()) if ((r.state === 'ready' || r.state === 'leased') && r.installedSha !== digest)
        table.transition(r.serial, 'joining', 'build changed after install');
      for (const serial of targets) if (outcomes.has(serial) && !outcomes.get(serial)?.ok)
        table.transition(serial, 'down', outcomes.get(serial)!.reason!, { installFailure: true });
      const skipped = table.all().filter(r => !devices.includes(r.serial)).map(r => ({ serial:r.serial, reason:outcomes.get(r.serial)?.reason ?? r.reason }));
      for (const serial of targets.filter(s => !outcomes.has(s))) {
        table.transition(serial, 'draining', 'install still draining');
        void tasks[targets.indexOf(serial)].then(() => {
          if (closed) return;
          if (outcomes.get(serial)?.ok && lastInstall?.sha === digest) {
            table.transition(serial, 'ready', 'straggler installed current build', { installedSha: digest });
            leaseTable.changed();
          } else if (outcomes.get(serial)?.ok) {
            table.transition(serial, 'joining', 'build changed after install');
          }
        });
      }
      leaseTable.changed();
      const payload: InstallResponse = { ok: true, bytes: size, sha256: digest, devices, ...(skipped.length ? { skipped } : {}) };
      sendJson(res, 200, payload);
    } finally {
      // A timed-out executor may still be reading its upload. Keep that file until
      // the real install settles, even when no device accepted the build.
      if (!retained) {
        retainedPaths.add(tmpPath);
        pruneRetainedInstalls();
      }
    }
  }

  /**
   * Device-control MUTATIONS are a single-device concept.
   *
   * The protocol names no device, so on a pool "restart the device" has no answer — and
   * guessing (the caller's lease? the first serial?) would let one job power-cycle a
   * phone another job is mid-test on. Refusing plainly beats a rule nobody can predict.
   * The GET listing stays available, because reading what is attached is safe.
   *
   */
  function requireSingleDevice(op: string): void {
    const n = wanted.all ? table.all().length : wanted.serials.length;
    if (n > 1) {
      throw new HttpError(
        403,
        `this server pools ${n} devices, so '${op}' has no single device to act on. ` +
          'Run one server per device if you need remote device control — ',
        3,
      );
    }
  }

  /** 403 unless the operator opted in, mirroring /v1/install's gate. */
  function requireDeviceControl(): DeviceControlPolicy {
    if (!config.deviceControl) {
      throw new HttpError(403, 'device control is disabled on this server (start it with --allow-device-control)', 3);
    }
    return config.deviceControl;
  }

  async function handleDeviceOp(
    op: 'start' | 'restart' | 'stop',
    policy: DeviceControlPolicy,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req, EXEC_BODY_CAP);
    let parsed: DeviceOpRequest = {};
    if (raw.length) {
      try {
        parsed = JSON.parse(raw.toString('utf8')) as DeviceOpRequest;
      } catch {
        throw new HttpError(400, 'invalid JSON body');
      }
    }

    // Naming REPOINTS the server's device — the one thing /v1/exec can never do — so
    // it is permitted only against the operator-declared allowlist. The rejection
    // deliberately does not reveal whether the name exists on this host.
    let target = parsed.target;
    if (target !== undefined) {
      if (typeof target !== 'string' || !target.trim()) throw new HttpError(400, 'target must be a non-empty string');
      if (policy.allowedTargets.length === 0) {
        throw new HttpError(
          400,
          'this server does not accept a named target — it was started with a bare --allow-device-control ' +
            '(restart/stop of its own device only). Restart it with --allow-device-control=<names> to permit named starts.',
        );
      }
      if (!policy.allowedTargets.includes(target)) {
        throw new HttpError(400, "target is not permitted by this server's --allow-device-control allowlist");
      }
    } else {
      // No name given: act on what this server is for — its bound device, else the
      // operator's declared default.
      target = soleSerial() ?? policy.allowedTargets[0];
    }
    // `stop` acts on the binding, so answer its own precondition before the
    // start/restart "what would I even boot?" one, or a stop against a device-less
    // server reports a confusing "no default startable target".
    if (op === 'stop' && soleSerial() === null) {
      throw new HttpError(409, 'no device is bound — nothing to stop', 3);
    }
    if (!target) {
      throw new HttpError(
        400,
        'no device is bound and this server has no default startable target — restart it with --allow-device-control=<avd-or-simulator-name>',
      );
    }

    // Never defaulted on: `wipe` erases the device, so it must be explicitly true.
    const wipe = parsed.wipe === true;
    if (wipe && op === 'stop') {
      throw new HttpError(400, 'wipe is not valid with stop; use restart with wipe to wipe and reboot');
    }
    const opts: LifecycleOpts = {
      timeoutMs: SERVER_BOOT_TIMEOUT_MS,
      wipe,
      onProgress: (m) => err(`[server] device: ${m}`),
    };
    const t0 = Date.now();
    let result: DeviceOpResponse;

    if (op === 'stop') {
      await lifecycle.stop(config.platform, target, opts);
      await rebind(null);
      result = { ok: true, platform: config.platform, serial: null, changed: true, durationMs: Date.now() - t0 };
    } else if (op === 'restart') {
      if (wipe) err('[server] device: WIPE requested — the device\'s data will be erased');
      const { serial } = await lifecycle.restart(config.platform, target, opts);
      await rebind(serial);
      result = { ok: true, platform: config.platform, serial, changed: true, durationMs: Date.now() - t0 };
    } else {
      if (wipe) err('[server] device: WIPE requested — the device\'s data will be erased');
      const { serial, started } = await lifecycle.start(config.platform, target, opts);
      if (started || serial !== soleSerial() || !table.ready().includes(serial)) await rebind(serial);
      result = { ok: true, platform: config.platform, serial, changed: started, durationMs: Date.now() - t0 };
    }

    // A power cycle IS the fix for a quarantined device, and performing one is the
    // assertion that it worked. Clear by both keys: a client names an AVD, the
    // lifecycle layer answers with a serial.
    for (const key of [result.serial, target]) {
      if (!key) continue;
      if (table.get(key) && pool.get(key)) table.transition(key, 'ready', 'device control completed');
    }

    err(`[server] device ${op} → ${result.serial ?? '(none)'} (${result.durationMs}ms, changed=${result.changed})`);
    sendJson(res, 200, result);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && path === '/v1/health') {
      // Unauthenticated preflight — but if the caller DID send a key, verify it, so
      // a client with a wrong key fails fast at ping instead of at its first step.
      if (config.authKey && req.headers.authorization && !authorized(req)) {
        throw new HttpError(401, 'invalid auth key');
      }
      const serials = table.ready().filter(s => pool.get(s) && !restoring.has(s) && (!lastInstall || table.get(s)?.installedSha === lastInstall.sha));
      // `reads` is a single-device answer, and on a pool the useful one is per-lease —
      // /v1/lease carries it there, so the client logs the read path of the device it
      // actually got rather than an arbitrary member's.
      const reads = serials.length === 1 ? await safeReads(pool.get(serials[0])) : null;
      const quarantined = quarantineList();
      const degradedNow = degradedList();
      const health: HealthResponse = {
        ok: true,
        version: VERSION,
        platform: config.platform,
        // Kept as the SERIAL for a single-device server, so every existing client is
        // untouched; a pool reports null here and speaks through capacity/devices.
        serial: serials.length === 1 ? serials[0] : null,
        capacity: serials.length,
        devices: serials,
        deviceHealth: 1,
        leaseHold: 1,
        deviceStates: table.all().map(({serial, state, reason, since}) => ({serial, state, reason, since})),
        ...(lastInstall ? { installedSha: lastInstall.sha } : {}),
        installEnabled: config.allowInstall,
        ...(reads ? { reads } : {}),
        deviceControlEnabled: config.deviceControl !== undefined,
        deviceNamingEnabled: (config.deviceControl?.allowedTargets.length ?? 0) > 0,
        failoverEnabled: config.failover !== undefined,
        ...(quarantined.length ? { quarantined } : {}),
        // Serving but suspect — distinct from `quarantined`, which is not serving at all.
        // A client sizing its lanes from `capacity` still gets every device; this says
        // which of them the server would rather not have handed out.
        ...(degradedNow.length ? { degraded: degradedNow } : {}),
        // Derived from the pool right here, so the two can never drift apart.
        deviceState: serials.length ? 'ready' : 'none',
      };
      sendJson(res, 200, health);
      return;
    }

    if (!authorized(req)) throw new HttpError(401, 'missing or invalid auth key');
    const token = String(req.headers['x-verikun-run'] ?? '(anonymous)');
    reapLeases();
    const served = new Set(table.ready().filter(s => pool.get(s) && !restoring.has(s) && (!lastInstall || table.get(s)?.installedSha === lastInstall.sha)));

    if (req.method === 'POST' && path === '/v1/release') {
      // A finished client frees its lease so the NEXT run proceeds immediately instead
      // of waiting for heartbeat expiry. Only the holder can release.
      await readBody(req, EXEC_BODY_CAP); // drain
      await restoreOriginals(token);
      const mine = leases.get(token);
      const released = mine !== undefined;
      leaseTable.release(token);
      if (mine && !inFlight.has(token) && table.get(mine.serial)?.state === 'leased') table.transition(mine.serial, 'ready', 'lease released');
      leaseTable.changed();
      sendJson(res, 200, { ok: true, released });
      return;
    }
    // Device control. Every MUTATION is refused while ANOTHER run is live: power-cycling
    // a phone someone else is mid-test on is sabotage. The recovery case still works,
    // because the holder passes its own run token.
    if (req.method === 'POST' && (path === '/v1/devices/start' || path === '/v1/devices/restart' || path === '/v1/devices/stop')) {
      const policy = requireDeviceControl();
      const op = path.slice('/v1/devices/'.length) as 'start' | 'restart' | 'stop';
      requireSingleDevice(op);
      if (othersActive(token)) throw busyError(token);
      // HOLD it for the duration, not merely check at the door. A restart takes minutes,
      // and the old lock was held across the whole operation; a bare check leaves the
      // device leasable the moment it is made, so a racing run gets handed a phone that
      // is mid power-cycle and then has its worker terminated under it by `rebind`.
      return leaseTable.drainAndHold(token, async () => {
        await handleDeviceOp(op, policy, req, res);
      });
    }
    if (req.method === 'GET' && path === '/v1/devices') {
      // Neither locked nor serialized: a diagnostic must stay answerable DURING
      // someone else's run, and it queries host tooling, not the device. Still gated,
      // because enumerating every AVD on the host exposes the operator's other devices.
      const policy = requireDeviceControl();
      const seen = await enumerate().catch(() => cachedDevices);
      // Who is driving what, so a client can see "is it free" before committing to a run
      // rather than discovering it as a 409 mid-suite. Read-only, exactly like the local
      // listing — asking must never take a claim.
      if (claimsEnabled(claimEnv)) {
        for (const d of seen) {
          const claim = summarize(d.serial, claimOpts);
          if (claim) d.claim = claim;
        }
      }
      // `note` is the existing optional-caveat column formatDeviceTable already renders,
      // so `vk devices --server` shows this with no wire change.
      for (const d of seen) {
        const q = table.get(d.serial)?.state === 'down' ? table.get(d.serial) : undefined;
        if (q) d.note = `quarantined: ${q.reason}`;
      }
      const body: DeviceListResponse = {
        devices: policy.allowedTargets.length
          ? seen.filter((d) => served.has(d.serial) || policy.allowedTargets.includes(d.name ?? ''))
          : seen.filter((d) => served.has(d.serial)),
        startable: policy.allowedTargets,
        bound: soleSerial(),
      };
      sendJson(res, 200, body);
      return;
    }

    if (req.method === 'POST' && path === '/v1/lease') {
      if (req.headers['x-verikun-hold'] !== '1') throw new HttpError(426, 'streaming held leases are required; upgrade the client', 3);
      if (evicted.has(token)) throw busyError(token);
      if (heldTokens.has(token)) throw busyError(token);
      heldTokens.add(token);
      let gone = false;
      let timer: NodeJS.Timeout | undefined;
      let lastByte = now();
      const finish = (): void => {
        if (gone) return; gone = true;
        heldTokens.delete(token); endHolds.delete(token);
        if (timer) clearInterval(timer);
        leaseTable.cancelWait(token);
        const mine = leases.get(token);
        void restoreOriginals(token).finally(() => {
          leaseTable.release(token, leases.has(token) || evicted.has(token));
          if (mine && !inFlight.has(token) && table.get(mine.serial)?.state === 'leased') table.transition(mine.serial, 'ready', 'lease hold ended');
          leaseTable.changed();
          res.end();
        });
      };
      endHolds.set(token, finish);
      req.on('data', (chunk: Buffer) => {
        if (chunk.length > 1024 || !/^\.+$/.test(chunk.toString())) { finish(); req.destroy(); return; }
        lastByte = now();
      });
      req.on('end', finish); req.on('aborted', finish); res.on('close', finish);
      const requestedWait = Number(req.headers['x-verikun-wait-ms']);
      const waitMs = Number.isFinite(requestedWait) && requestedWait >= 0 ? requestedWait : 600_000;
      const avoid = typeof req.headers['x-verikun-avoid'] === 'string' ? req.headers['x-verikun-avoid'] : undefined;
      const serial = await leaseTable.wait(token, waitMs, avoid);
      if (gone) return;
      if (!serial) throw new HttpError(503, 'no device became available within the lease wait window', 3);
      table.transition(serial, 'leased', 'held lease');
      timer = setInterval(() => { if (now() - lastByte >= (config.holdIdleMs ?? 30_000)) finish(); }, Math.min(1000, config.holdIdleMs ?? 1000));
      timer.unref();
      const reads = await safeReads(pool.get(serial));
      const body: LeaseResponse = { platform: config.platform, serial, ...(reads ? { reads } : {}), ...(lastInstall ? { installedSha: lastInstall.sha } : {}) };
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify(body) + '\n');
      return;
    }

    if (leaseTable.exclusive !== null && leaseTable.exclusive !== token && ['/v1/lease', '/v1/exec', '/v1/elements', '/v1/install'].includes(path)) throw busyError(token);

    // A run that was EVICTED is told so first, however empty the pool has since become: it
    // lost its phone part-way, which is not the same as a new run finding none, and a
    // parallel suite re-runs only the former as a fresh run (#147). Shedding a pool's last
    // device is exactly when both are true at once.
    if (served.size === 0 && evicted.has(token) && (path === '/v1/exec' || path === '/v1/elements' || path === '/v1/logs' || path === '/v1/lease')) {
      throw busyError(token);
    }
    // A deviceless server must not silently fail every command. In-memory check, so
    // the normal path is untouched. NOTE this fires only when the server NEVER
    // resolved a device — one that DIED mid-run still has a non-null binding and keeps
    // today's behaviour (the exec returns exit 3 in its body).
    if (
      served.size === 0 &&
      (path === '/v1/exec' || path === '/v1/elements' || path === '/v1/logs' || path === '/v1/install' || path === '/v1/lease')
    ) {
      throw new HttpError(
        503,
        // Name the device we LOST, when we lost one. An empty pool that started full is
        // not "no device attached" — it is a phone that stopped serving for a reason the
        // operator needs, and answering with the generic sentence replaces that reason
        // with a message that names nothing.
        lastLoss()
          ? `this verikun server has no device left to serve — last loss: ${lastLoss()}`
          : config.deviceControl
            ? 'no device is attached to this verikun server — run `vk devices start --server <url>` to boot one'
            : 'no device is attached to this verikun server',
        3,
      );
    }

    const onLeasedDevice = async (fn: (h: DeviceHandle) => Promise<void>): Promise<void> => {
      const mine = leases.get(token);
      if (mine && table.get(mine.serial)?.state === 'checking' && !draining.has(mine.serial))
        await checking.get(mine.serial);
      const h = leasedHandle(token);
      return holdingLease(token, () => fn(h));
    };
    if (req.method === 'POST' && path === '/v1/exec') return onLeasedDevice((h) => handleExec(h, req, res, token));
    if (req.method === 'POST' && path === '/v1/elements') return onLeasedDevice((h) => handleElements(h, req, res, token));
    if (req.method === 'POST' && path === '/v1/logs') return onLeasedDevice((h) => handleLogs(h, req, res));
    if (req.method === 'POST' && path === '/v1/install') {
      if (!config.allowInstall) {
        throw new HttpError(403, 'install is disabled on this server (start it with --allow-install)', 3);
      }
      // Installing writes a binary to EVERY device, so it cannot happen under someone
      // else's run — otherwise a suite's later lanes would silently swap builds mid-run.
      if (othersActive(token)) throw busyError();
      // Nor may a run START during it, which a single lease cannot prevent on a pool:
      // hold the whole server for the duration. The installer also keeps an ordinary
      // lease afterwards, so a racing job cannot take a device in the gap between
      // `vk install` and the suite that follows it — the client's own `close()` hands
      // that back, which is what lets install-then-suite chain in one job.
      return leaseTable.drainAndHold(token, async () => {
        // Held open like any other device request. Without it the installer's own lease
        // ages out during a multi-minute upload+install, and the moment `leaseTable.exclusive` is
        // cleared the next `reapLeases` hands its device to a racing job — losing exactly
        // the install-then-suite continuity the lease above exists to provide.
        return await holdingLease(token, () => handleInstall(req, res));
      });
    }
    throw new HttpError(404, `unknown endpoint ${req.method} ${path}`);
  }

  /**
   * Which run, and on which device — the two facts that turn a wall of request lines into
   * something you can follow.
   *
   * Without them a parallel suite's log is N lanes interleaved with no way to tell which
   * 409 belonged to which, or which device a failing step ran on. The token is truncated to
   * 8 characters, matching the lease lines so the two can be grepped together.
   */
  const requestTag = (req: IncomingMessage): string => {
    const raw = req.headers['x-verikun-run'];
    if (typeof raw !== 'string' || !raw) return '';
    const serial = leases.get(raw)?.serial;
    return ` run=${raw.slice(0, 8)}${serial ? ` dev=${serial}` : ''}`;
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    // Captured BEFORE the handler runs: a request that loses its lease (an eviction, a
    // failover shed) would otherwise log no device at all — which is exactly the request
    // whose device you most want named.
    const tag = requestTag(req);
    let failure = '';
    handle(req, res)
      .catch((e) => {
        const mapped =
          e instanceof HttpError
            ? e
            : e instanceof CliError
              ? new HttpError(e.exitCode === 2 ? 400 : 500, e.message, e.exitCode)
              : new HttpError(500, (e as Error).message || 'internal error', 3);
        // The reason, kept for the log line below. Every error body used to be sent to the
        // CLIENT and never written down, so a server-side log recorded a bare `→ 409` with
        // nothing saying what the client was told — the single biggest gap when reading
        // back why a suite degraded.
        failure = ` — ${firstLine(mapped.message)}`;
        if (!res.headersSent) {
          // The class comes from the ORIGINAL throw, never from `mapped`: the HttpError
          // mapping above keeps only message + exit code, which is precisely how a
          // NoWindowError used to reach the client as an anonymous CliError (issue #80). An
          // HttpError raised by the server itself (auth, validation, a lock) has no wrapped
          // class and simply omits the field, which older clients already tolerate.
          const errorKind = e instanceof HttpError ? e.errorKind : describeError(e as Error).kind;
          const body: RpcErrorBody = {
            error: mapped.message,
            exitCode: mapped.exitCode,
            ...(errorKind ? { errorKind } : {}),
          };
          sendJson(res, mapped.status, body);
        } else {
          res.destroy();
        }
      })
      .finally(() => {
        err(
          `[server] ${req.method} ${(req.url ?? '').split('?')[0]}${tag} → ${res.statusCode} ` +
            `(${Date.now() - started}ms)${failure}`,
        );
      });
  });
  // A 512 MB upload over a slow link can legitimately exceed Node's 5-minute
  // default request window.
  server.requestTimeout = 30 * 60 * 1000;
  // Connection persistence is independent of held-lease lifetime.
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_MS;
  // …and bound how many of those long-lived sockets may exist. `/v1/health` is
  // unauthenticated and meant to be polled, so a 60x longer idle window with no cap turns
  // a monitoring loop or a port scan into file-descriptor pressure — which surfaces as
  // unrelated DEVICE errors, since the forked processes spawn adb/idb and need descriptors
  // of their own. Far above any real client count; this is a backstop.
  server.maxConnections = 256;
  // Tie the sweep timer and the retained build to the server's own lifetime, so a test that
  // builds a server and drops it leaves neither behind, and Ctrl-C is clean in production.
  const stopWatch = (): void => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    closed = true;
    if (recycleTimer) clearInterval(recycleTimer);
    leaseTable.dispose();
  };
  server.on('verikun:shutdown', stopWatch);
  server.on('close', () => { stopWatch(); dropRetainedInstall(); });

  return server;
}

/**
 * Parse the tri-state `--allow-device-control[=a,b]`. PURE — exported for unit tests.
 * `flagBool` is deliberately NOT used: it returns FALSE for
 * `--allow-device-control=Pixel_6` (args.ts only accepts `true`/'true'), which would
 * silently disable the feature for the exact spelling that enables naming.
 */
export function parseDeviceControl(flags: Flags): DeviceControlPolicy | undefined {
  const raw = flags['allow-device-control'];
  if (raw === undefined || raw === false || raw === 'false') return;
  if (raw === true || raw === 'true') return { allowedTargets: [] }; // bare: restart/stop only
  const names = csvList(raw);
  if (!names.length) {
    throw new CliError(
      '--allow-device-control=<names> needs a comma-separated list of AVD/simulator names ' +
        '(or pass a bare --allow-device-control for restart/stop of the bound device only).',
      2,
    );
  }
  return { allowedTargets: names };
}

/** What `parseFailover` decided, and the one line the startup log prints about it.
 *  The reason travels WITH the decision so the two can never disagree. */
export interface FailoverDecision {
  /** undefined = failover is off. */
  policy?: FailoverPolicy;
  /** Startup-log text: what is on, and why. */
  why: string;
}

/**
 * Decide whether this server may move off a device that fails. PURE — exported for unit
 * tests, and it takes `pinned`/`env` explicitly rather than reading `process.env` so the
 * whole truth table is assertable.
 *
 * Precedence, and each step earns its place:
 *  1. An explicit OFF wins over everything — a kill switch you can override is not one.
 *     `VERIKUN_NO_FAILOVER` mirrors `VERIKUN_NO_CLAIM`: host-level policy for an operator
 *     who cannot change every command line. It is announced at startup, so it can never
 *     silently explain a server that "won't fail over".
 *  2. `--allow-failover[=names]` turns it on, and OVERRIDES a `--device` pin — two flags
 *     that appear to disagree are resolved by the later, more specific one, loudly.
 *  3. A `--device` pin turns it off. The operator named the device; honour that.
 *  4. Otherwise ON, unbounded. See FailoverPolicy for why that is the honest default.
 *
 * `flagBool` is deliberately NOT used for `allow-failover`, for the same reason as
 * `parseDeviceControl`: it returns FALSE for `--allow-failover=emulator-5556`, silently
 * disabling the feature for the exact spelling that bounds it.
 */
export function parseFailover(
  flags: Flags,
  opts: { pinned?: boolean; env?: Record<string, string | undefined> } = {},
): FailoverDecision {
  const raw = flags['allow-failover'];
  const asked = raw !== undefined && raw !== false && raw !== 'false';
  const refused = flagBool(flags, 'no-failover');
  if (asked && refused) {
    throw new CliError('--allow-failover and --no-failover contradict each other — pass one.', 2);
  }
  if (refused) return { why: 'disabled (--no-failover)' };
  if ((opts.env ?? process.env).VERIKUN_NO_FAILOVER) {
    return { why: 'disabled (VERIKUN_NO_FAILOVER)' };
  }

  if (asked) {
    if (raw === true || raw === 'true') {
      return { policy: { allowedTargets: [] }, why: 'ENABLED · any attached device on this host (--allow-failover)' };
    }
    const names = csvList(raw);
    if (!names.length) {
      throw new CliError(
        '--allow-failover=<serials> needs a comma-separated list of device serials or AVD/simulator names ' +
          '(or pass a bare --allow-failover to permit any attached device).',
        2,
      );
    }
    return { policy: { allowedTargets: names }, why: `ENABLED · may move to: ${names.join(', ')}` };
  }

  if (opts.pinned) {
    return { why: 'disabled (--device pins the binding; pass --allow-failover to permit moving)' };
  }
  return { policy: { allowedTargets: [] }, why: 'ENABLED · any attached device on this host' };
}

export async function cmdServer(positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 0) {
    throw new CliError(`server: unexpected argument '${positionals[0]}'. Usage: verikun server [--bind addr] [--port n] [--auth-key k] [--devices all|a,b] [--allow-install] [--allow-device-control[=names]] [--allow-failover[=serials]|--no-failover] [--allow-unsafe-anonymous] [--log-file path|off]`, 2);
  }
  const { spec: poolSpec, platform } = resolvePoolPlatform(flags, platformFromFlags(flags));
  const device = deviceFromFlags(flags, platform);
  if (poolSpec && flagStr(flags, 'device')) {
    throw new CliError('--devices and --device are alternatives: pass a pool or a single device, not both.', 2);
  }
  const bind = flagStr(flags, 'bind') || '127.0.0.1';
  const port = flagNum(flags, 'port') ?? DEFAULT_PORT;
  // Opened as soon as the port is known — which is as early as the path CAN be resolved —
  // so that everything downstream is captured: a `--devices` enumeration warning, a device
  // that would not resolve, a worker that refused to start. Those are startup failures an
  // operator reads about after the fact, and they were the first lines to be lost.
  const logPath = resolveLogPath({ flags, port });
  const serverLog: ServerLog | null = logPath ? openServerLog(logPath) : null;
  if (logPath && !serverLog) {
    err(`[server] WARNING: cannot write the log at ${logPath} — continuing with stderr only.`);
  }
  if (serverLog) setErrSink((line) => serverLog.write(line));
  const allowInstall = flagBool(flags, 'allow-install');
  const deviceControl = parseDeviceControl(flags);
  // `device` is --device || VERIKUN_DEVICE || ANDROID_SERIAL: an env pin is still a pin.
  // A pool is never "pinned". `deviceFromFlags` also reads ANDROID_SERIAL / VERIKUN_DEVICE,
  // and on a `--devices` server that value selects nothing — so without this an env var
  // routinely exported on a CI box silently disabled failover for the whole pool, and the
  // banner blamed a `--device` nobody passed.
  const failover = parseFailover(flags, { pinned: !poolSpec && device !== undefined });
  const anonymous = flagBool(flags, 'allow-unsafe-anonymous');

  // The env var is the documented channel for the key (keeps it out of argv/ps).
  let authKey = flagStr(flags, 'auth-key') || process.env.VERIKUN_SERVER_AUTH_KEY || undefined;
  if (anonymous && authKey) {
    throw new CliError('--allow-unsafe-anonymous cannot be combined with an auth key (--auth-key / VERIKUN_SERVER_AUTH_KEY) — pick one.', 2);
  }
  let generated = false;
  if (!anonymous && !authKey) {
    authKey = randomBytes(32).toString('base64url');
    generated = true;
  }

  // Build the driver the server starts bound to, and fail fast (exit 2/3) before
  // binding a port. WITH device control we may instead listen device-less, since a
  // client can then do something about it; without it, a server nobody can fix is
  // just a server that 500s forever.
  //
  // Order matters: resolve the SERIAL first, because `preflight()` — which now runs on
  // each device's own forked process — also fails for a broken toolchain, and that is NOT
  // deferrable: no client can install idb for us. Only "no device" earns the device-less
  // path; once a device does resolve, a preflight failure is fatal (see below).
  //
  // The server owns its device for as long as it listens, so its pid is exact liveness
  // evidence — set before resolving, since that is where the claim is taken.
  setProcessScoped(true);
  let serials: string[] = [];
  // An EXPLICIT --devices list is never deferrable: the deviceless path below exists for
  // "nothing is attached, a client can boot one", not for "the operator named devices and
  // one of them is missing". Swallowing it would drop the healthy members too and listen
  // with an empty pool, which is worse than the error.
  if (poolSpec) {
    serials = poolSerials(platform, poolSpec);
  } else {
    try {
      const driver = getDriver(platform, device);
      const serial = driver.resolvedSerial();
      // Both drivers TRUST a pinned --device without probing (adb.ts / ios.ts), so
      // `vk server --device X` already starts "bound" to a device that may not exist.
      // Verify it here, or the device-less path is never entered and every request
      // fails with nothing a client could do about it.
      if (deviceControl && device && !driver.listDevices().some((d) => d.serial === serial)) {
        err(`[server] --device ${serial} is not attached — starting with NO device bound`);
      } else {
        serials = [serial];
      }
    } catch (e) {
      // Ambiguity (exit 2) is an OPERATOR error — booting another device makes it
      // worse. Only "no device" (exit 3) is deferrable.
      const code = e instanceof CliError ? e.exitCode : 3;
      if (!deviceControl || code !== 3) throw e;
      err(`[server] no device resolved (${(e as Error).message})`);
      err('[server] listening anyway — device control is enabled. Boot one with:');
      err('[server]     vk devices start --server <url>');
    }
  }
  // Each device gets a forked process, and a worker only reports ready once preflight()
  // says its toolchain can actually drive it — so the pool never advertises capacity it
  // cannot serve. One device that will not come up costs its own lane, not the server.
  const pool = await WorkerDevicePool.start(platform, serials);
  // A device RESOLVED and still could not be driven, so the toolchain is broken — and no
  // client can install idb for us. Fatal regardless of device control, exactly as the
  // unconditional startup `preflight()` this replaced was: listening anyway would answer
  // `503 no device attached` forever, naming the wrong problem and prescribing a fix
  // (boot one) that cannot work while the tooling is missing.
  if (serials.length && !pool.serials().length) {
    throw new CliError('server: no device could be driven — see the errors above.', 3);
  }
  if (deviceControl?.allowedTargets.length) {
    // Typo detection only — non-fatal, since the tooling may be missing entirely.
    const known = new Set(realLifecycle.list(platform).map((d) => d.name).filter(Boolean));
    const unknown = deviceControl.allowedTargets.filter((t) => !known.has(t));
    if (unknown.length) err(`[server] WARNING: --allow-device-control names no such device: ${unknown.join(', ')}`);
  }

  // Handlers print "tapped …" confirmations via out(); a server's stdout is not a
  // data channel, so silence them — request logging goes to stderr instead.
  setOutputQuiet(true);

  // Which devices are live is ASKED, never tracked. A mirrored copy has to be updated
  // from `onRebind`, whose signature is `serial | null` — a single-device shape that
  // simply cannot describe a pool: after a failover on two devices it would report null
  // and the mirror would go empty while both phones were still being driven, so shutdown
  // would release neither companion and both would hold their UiAutomation connection for
  // the full 15-minute idle window. The pool is the only thing that knows, so ask it.
  const live = (): string[] => pool.serials();
  const server = buildServer({
    platform, pool, authKey, allowInstall, deviceControl, failover: failover.policy,
    // All servers readmit; an explicit pool preserves its operator-declared wanted set.
    ...(poolSpec ? { poolSpec } : {}),
  });

  // Say the read path out loud. It is the difference between a suite that takes 8s and
  // one that takes 43s, and it used to be invisible from both ends (issue #77). Asked
  // BEFORE the socket opens, so the whole banner — including a generated auth key — is
  // printed before the first request can be accepted, and so the `listen` callback stays
  // synchronous: an `async` listener turns a throwing `err()` (EPIPE on a closed stderr)
  // into an unhandled rejection the `reject` below could never see.
  const readsBanner: string[] = [];
  for (const serial of live()) {
    const reads = await safeReads(pool.get(serial));
    if (reads) readsBanner.push(`[server] reads: ${serial} → ${reads.path} (${reads.detail})`);
  }

  return new Promise<number>((resolve, reject) => {
    server.on('error', (e) => reject(new CliError(`server: could not listen on ${bind}:${port} (${(e as Error).message})`, 3)));
    server.listen(port, bind, () => {
      err(`[server] verikun ${VERSION} listening on http://${bind}:${port}`);
      const serving = live();
      err(`[server] devices: ${platform} · ${serving.length ? serving.join(', ') : '(none bound)'}`);
      if (serving.length > 1) {
        err(`[server] pooled: ${serving.length} devices, one run token leases one device — a parallel`);
        err('[server]         `vk suite --server <url>` sizes itself from this automatically.');
      }
      for (const line of readsBanner) err(line);
      err(`[server] install endpoint: ${allowInstall ? 'ENABLED (--allow-install)' : 'disabled (pass --allow-install to accept builds)'}`);
      err(
        `[server] device control: ${
          !deviceControl
            ? 'disabled (pass --allow-device-control to let clients start/restart the device)'
            : deviceControl.allowedTargets.length
              ? `ENABLED · start/restart/stop · startable: ${deviceControl.allowedTargets.join(', ')}`
              : 'ENABLED · restart/stop THIS device only (no named targets)'
        }`,
      );
      if (deviceControl) {
        err('[server] NOTE: an authenticated client can now power-cycle AND erase this device.');
      }
      err(`[server] failover: ${failover.why}`);
      // Announced in both states, like the failover kill switch. ON is worth saying because
      // `adb kill-server` is host-global and an operator should not meet it as a surprise;
      // OFF is worth saying because a rotted adb server is otherwise a baffling flake.
      if (platform === 'android') {
        err(
          `[server] adb recycle: ${
            adbRecycleEnabled(platform)
              ? 'on — a rotted adb server is restarted while idle (VERIKUN_NO_ADB_RECYCLE=1 to disable)'
              : 'disabled (VERIKUN_NO_ADB_RECYCLE)'
          }`,
        );
      }
      err(
        serverLog
          ? `[server] log: ${serverLog.path} (--log-file ${LOG_OFF} to disable)`
          : `[server] log: stderr only (--log-file ${LOG_OFF})`,
      );
      // Two flags that appear to disagree. Permitted rather than refused — `--device X`
      // alongside the other --allow-* flags is straight out of the docs, so refusing
      // would break the commonest shape — but never silently: a bare --allow-failover
      // means the pin governs only the INITIAL binding.
      if (device && failover.policy && failover.policy.allowedTargets.length === 0) {
        err(`[server] WARNING: --device ${device} pins only the INITIAL binding — a bare --allow-failover`);
        err('[server]          permits moving to any other attached device on this host. Pass');
        err('[server]          --allow-failover=<serials> to bound where it may go.');
      }
      if (generated) {
        err('[server] auth key generated for this session — clients pass it via VERIKUN_SERVER_AUTH_KEY or --auth-key:');
        err(`[server]     ${authKey}`);
      } else if (anonymous) {
        err('[server] WARNING: --allow-unsafe-anonymous — NO AUTHENTICATION. Anyone who can reach this');
        err('[server]          address fully controls the connected device. Only use when the network');
        err('[server]          itself is the boundary (e.g. a private tailnet), never on a shared LAN.');
      } else {
        err('[server] auth: key configured');
      }
      err('[server] stop with Ctrl-C');
    });
    let shuttingDown = false;
    const close = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      err('[server] shutting down');
      server.emit('verikun:shutdown');
      server.close();
      server.closeIdleConnections();
      // Actual exit owns companion release, then claim release. A blocked worker
      // must not hand its resources to another executor while spawnSync is alive.
      void pool.disposeAll().finally(() => {
        server.closeAllConnections();
        setErrSink(null);
        serverLog?.close();
        resolve(0);
      });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
