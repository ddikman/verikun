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
//    device lock at a time (409 otherwise; an idle lock is taken over so a crashed
//    caller can't wedge the box). Device endpoints are serialized via a mutex.
//
// cli.ts reaches this module via a DYNAMIC import (no static cli↔server cycle, and
// node:http stays off the default CLI load path); this module imports cli.ts's
// executeForServer statically — a one-way runtime edge.

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Flags, flagStr, flagBool, flagNum } from './args';
import { CliError } from './errors';
import { getDriver } from './drivers';
import { releaseCompanionOn } from './companion/manager';
import { ClaimOpts, claimDevice, claimsEnabled, releaseClaim, setProcessScoped, summarize } from './device/claims';
import { classifyFailure, classifyInstallFailure, failoverCandidates, FailoverVerdict } from './device/failover';
import { csvList, poolSerials, resolvePoolPlatform, type DevicePoolSpec } from './device/pool';
import { assertActionable, chooseTarget, lifecycleFor, restartTarget } from './drivers/lifecycle';
import { err, setErrSink, setOutputQuiet } from './output';
import { LOG_OFF, openServerLog, resolveLogPath, type ServerLog } from './server-log';
import { DeviceInfo, HierarchySource, Platform } from './types';
import { DeviceHandle, DevicePool, WorkerDevicePool } from './server-pool';
import type { WorkerExecResult } from './server-worker';
import { FlagSpec, InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import {
  rebuildError, DeviceChange, DeviceListResponse, DeviceOpRequest, DeviceOpResponse,
  ExecRequest, ExecResponse, HealthResponse, InstallResponse, LeaseResponse, LogsRequest,
  LogsResponse, RpcErrorBody,
} from './rpc';
import { platformFromFlags, deviceFromFlags } from './cli';
import { serialQueue, sleep } from './wait';
import { VERSION } from './version';

/**
 * A driver's read path, or null when the backend has no opinion (iOS reads through idb, one
 * way only) or the probe failed.
 *
 * Best-effort on purpose. It is reported on `/v1/health`, which is also how a client checks
 * the server is reachable at all — a companion probe must never be the reason that answer
 * cannot be given.
 */
async function safeReads(handle: DeviceHandle | undefined, opts: { fresh?: boolean } = {}): Promise<HierarchySource | null> {
  if (!handle) return null;
  try {
    return await handle.reads(opts);
  } catch {
    return null;
  }
}


const DEFAULT_PORT = 8391;
const EXEC_BODY_CAP = 1024 * 1024; // 1 MB of JSON is far beyond any leaf command
const INSTALL_BODY_CAP = 512 * 1024 * 1024; // 512 MB app build
// A silent run-token older than this may be taken over by a new one — long enough
// to survive a client-side compile/repair pause, short enough that a crashed
// caller doesn't wedge the device.
const LOCK_IDLE_MS = 5 * 60 * 1000;
// How many times ONE request may move device. 2 moves = 3 devices tried, which sits
// comfortably inside the client's 15-minute install ceiling at ~1 minute an install,
// while a farm of ten wedged emulators cannot burn ten installs inside one request.
const MAX_FAILOVER_HOPS = 2;
// Gap between the two probes that separate a momentary blip from a dead device. Mirrors
// suite.ts's stillBroken, and for the same reason: a flaky dump also surfaces as exit 3,
// so acting on one probe would rotate the pool on ordinary flake.
/**
 * How often the server looks for devices that should be serving and are not.
 *
 * A minute is chosen against the two costs it sits between: a sweep enumerates the host and
 * may start a worker thread, so it is not free, and a device that comes back is not needed
 * within seconds — a suite lane that lost its device has already failed and moved on. Named
 * here rather than inlined because it and WORKER_CALL_TIMEOUT_MS are the two numbers most
 * likely to want tuning against a real fleet.
 */
const RECONCILE_INTERVAL_MS = 60_000;

const PROBE_RETRY_MS = 1000;
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

/** The lifecycle operations the server needs, injected so buildServer is testable
 *  without a device (mirrors SuiteDeps / EngineDeps). */
export interface ServerLifecycle {
  start(platform: Platform, target: string, opts: LifecycleOpts): Promise<{ serial: string; started: boolean }>;
  restart(platform: Platform, target: string, opts: LifecycleOpts): Promise<{ serial: string }>;
  stop(platform: Platform, target: string, opts: LifecycleOpts): Promise<void>;
  list(platform: Platform): DeviceInfo[];
}

export interface LifecycleOpts {
  timeoutMs: number;
  wipe?: boolean;
  onProgress?: (message: string) => void;
}

export interface ServerConfig {
  // --- startup policy: never written after buildServer ---
  platform: Platform;
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
   *  device control — is testable with neither a device nor a worker thread. */
  pool: DevicePool;
  /**
   * What `--devices` asked for, so the reconciler knows what "missing" means.
   *
   * Undefined on a SINGLE-device server, which deliberately does not reconcile: its binding
   * is owned by `/v1/devices/*` and by failover's rebind, and a sweep re-adopting underneath
   * either would be fighting them. The ratchet this repairs is a pool-only problem.
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
  /** How long a lease may go untouched before another run may take its device. Defaults
   *  to LOCK_IDLE_MS; a test sets it small, because the property that matters — a run
   *  coming back from a long client-side pause keeps ITS OWN phone — is otherwise five
   *  minutes away and would go unpinned. */
  idleMs?: number;
}

/** An error that already knows its HTTP status + the client-side exit code. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly exitCode: number = status === 400 || status === 404 || status === 413 ? 2 : 3,
    /** Set when this request moved the server's device before failing — the client
     *  needs to know the ground shifted even though the answer is an error. */
    readonly deviceChanged?: DeviceChange,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Errors here are multi-line (detail + hint); logs and reasons want the headline. */
const firstLine = (m: string): string => m.split('\n')[0].trim();

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new HttpError(413, `request body exceeds ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Wire flags → FlagSpec[] for validateNode. Primitives are coerced to strings
 *  (a boolean flag travels as "true"); anything structured is rejected. */
function flagsToSpecs(flags: unknown): FlagSpec[] {
  if (flags === undefined || flags === null) return [];
  if (typeof flags !== 'object' || Array.isArray(flags)) throw new HttpError(400, 'flags must be an object');
  return Object.entries(flags as Record<string, unknown>).map(([name, value]) => {
    if (typeof value === 'string') return { name, value };
    if (typeof value === 'number' || typeof value === 'boolean') return { name, value: String(value) };
    throw new HttpError(400, `flag '${name}' must be a string`);
  });
}

function encodeArtifacts(artifacts: Record<string, Buffer>): Record<string, string> {
  const out: Record<string, string> = {};
  // `Buffer.from` before `toString`, ALWAYS. These bytes crossed a worker boundary, and
  // structured clone downgrades a Buffer to a plain Uint8Array whose `toString` ignores
  // its encoding argument — so a direct `.toString('base64')` yields "137,80,78,71,…",
  // ships with a 200, and archives an unopenable screenshot. TypeScript cannot catch it:
  // the declared type is still Buffer.
  for (const [rel, buf] of Object.entries(artifacts)) {
    // `isBuffer` rather than an unconditional `Buffer.from`: these are megabyte-scale
    // full-resolution failure screenshots and the pool has already normalised them.
    out[rel] = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array)).toString('base64');
  }
  return out;
}

/** The production lifecycle, over drivers/lifecycle.ts. Every path re-resolves the
 *  target against the LIVE device list rather than trusting the current binding —
 *  both drivers accept a pinned `--device` without probing, so "bound" never implies
 *  "alive". `started: false` is therefore the lifecycle layer's verdict, not a
 *  serial comparison the server makes. */
const realLifecycle: ServerLifecycle = {
  async start(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'startable' });
    assertActionable(chosen, 'start', { wipe: opts.wipe });
    const r = await lc.boot(chosen, { timeoutMs: opts.timeoutMs, wait: true, wipe: !!opts.wipe, onProgress: opts.onProgress });
    if (!r.serial) throw new CliError(`'${target}' started but reported no serial`, 3);
    return { serial: r.serial, started: r.started };
  },
  async restart(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'running' });
    assertActionable(chosen, 'restart', { wipe: opts.wipe });
    const r = await restartTarget(lc, chosen, { timeoutMs: opts.timeoutMs, wait: true, wipe: !!opts.wipe, onProgress: opts.onProgress });
    if (!r.serial) throw new CliError(`'${target}' restarted but reported no serial`, 3);
    return { serial: r.serial };
  },
  async stop(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'running' });
    assertActionable(chosen, 'stop');
    await lc.shutdown(chosen, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress });
  },
  list(platform) {
    return lifecycleFor(platform)
      .targets()
      .map((t) => ({
        serial: t.serial,
        state: t.state,
        platform: t.platform,
        kind: t.kind,
        name: t.name || undefined,
        product: t.runtime,
      }));
  },
};

export function buildServer(config: ServerConfig): Server {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const lifecycle = config.lifecycle ?? realLifecycle;
  const pool = config.pool;
  const claimOpts = config.claimOpts ?? {};
  const claimEnv = claimOpts.env ?? process.env;

  /** The serial, when this server has exactly one device. Device control and the
   *  backwards-compatible `health.serial` are both single-device concepts. */
  const soleSerial = (): string | null => {
    const all = pool.serials();
    return all.length === 1 ? all[0] : null;
  };

  // Rebuild the worker rather than invalidating a cache: both drivers cache a pinned
  // serial without probing, so an AVD that returns on a different port would leave a
  // permanently dead instance. Always rebind to the CONCRETE serial the lifecycle layer
  // returned — never undefined, which would auto-resolve and could silently latch onto a
  // different attached device.
  const rebind = async (serial: string | null): Promise<void> => {
    const outgoing = pool.serials();
    await pool.rebind(serial);
    // EVICT the holders, never merely drop their leases. A power cycle wipes the app, so
    // a run that resumed on the rebound device would execute step 12 on a phone that never
    // ran steps 1–11 — silently, since nothing here can send a `deviceChanged`, and its
    // report would name one device for a run that spanned two.
    for (const gone of outgoing) evictHoldersOf(gone, 'the server rebound to another device');
    if (serial !== null) evictHoldersOf(serial, 'the device was restarted'); // a same-serial restart wiped it too
    leases.clear(); // belt and braces: whatever anyone held no longer exists
    err(`[server] device: ${config.platform} · ${serial ?? '(none)'}`);
  };

  // --- failover ---------------------------------------------------------------
  //
  // Devices this server has ruled out, and why. In-memory, PROCESS-LIFETIME, no TTL: a
  // TTL would silently re-try a device that ran out of disk ten minutes ago and burn
  // another full install on it, on a schedule nobody can see — precisely the minutes
  // this feature exists to save. A power cycle is the fix, so a successful
  // /v1/devices/{start,restart,stop} is what clears an entry (see handleDeviceOp).
  const quarantine = new Map<string, { reason: string; at: number }>();

  /** The most recent device this server stopped serving, and why — so an empty pool can
   *  answer with the reason it emptied instead of the generic "no device attached". */
  let lostDevice: string | null = null;

  /**
   * A worker died, so its device left the pool on its own.
   *
   * Everything here is cleanup the POOL cannot do and failover does not always reach: a
   * death can happen with `--no-failover`, or on the last device, where shedding is
   * deliberately refused — and in both of those the claim file and the device's single
   * UiAutomation connection would stay held for the server's whole process lifetime with
   * nothing on the host able to explain why.
   *
   * Deliberately NOT the lease. Evicting here would run synchronously inside the worker's
   * own death, before `considerFailover` has entered `moving`, and would undo the very
   * protection that lets a holder follow a move. Leases are settled by `reapLeases` (no
   * replacement) or the remap (a replacement) — never here.
   */
  pool.onLoss((serial, why) => {
    lostDevice = `${serial} (${why})`;
    releaseCompanionOn(serial);
    if (claimsEnabled(claimEnv)) releaseClaim(serial, { ...claimOpts, mineOnly: true });
  });

  /**
   * Where a COMPLETED failover already sent each casualty, so a second failure queued
   * behind it returns the same answer instead of burning another spare on the same
   * device. Distinct from `quarantine`, which is set before the attempt rather than
   * after it.
   *
   * Only a successful move is recorded. An attempt that found nothing — every spare
   * busy, the enumeration failing — deliberately leaves no mark, so the NEXT failure
   * re-evaluates against a host that may since have freed a device. Recording the attempt
   * instead would pin the server to a broken phone for its whole process lifetime the
   * first time a spare happened to be held by another job.
   */
  const failedOver = new Map<string, string>();

  /**
   * Devices with a failover decision in flight, whose holders keep their lease throughout.
   *
   * See `considerFailover` for why: a dead worker leaves the pool seconds before its
   * failure is classified, and a lease reaped in that gap can never follow the move.
   */
  const moving = new Map<string, number>();
  const beginMove = (serial: string): void => void moving.set(serial, (moving.get(serial) ?? 0) + 1);
  const endMove = (serial: string): void => {
    // A COUNT, not a flag: two requests can fail on ONE device at once (an exec and an
    // elements read, say) and both enter `considerFailover`. With a Set the first to
    // finish would clear the guard while the second was still inside `deviceIsDead`,
    // re-opening the eviction window this exists to close.
    const n = (moving.get(serial) ?? 1) - 1;
    if (n > 0) moving.set(serial, n);
    else moving.delete(serial);
  };

  const quarantineDevice = (serial: string | null, reason: string): void => {
    if (!serial || quarantine.has(serial)) return;
    quarantine.set(serial, { reason, at: Date.now() });
    err(`[server] failover: ${serial} quarantined (${reason})`);
  };

  /** For /v1/health and the exhaustion message. */
  const quarantineList = (): Array<{ serial: string; reason: string }> =>
    [...quarantine.entries()].map(([serial, q]) => ({ serial, reason: q.reason }));

  /**
   * Pool MEMBERS that recently failed. Still served, but dealt last.
   *
   * The distinction from `quarantine` is which question each answers. Quarantine says
   * "never move ONTO this device"; degradation says "this device is still ours and still
   * serving, but prefer any other". They are disjoint by construction — `shrink` clears the
   * quarantine entry when it decides to keep serving a device — so `/v1/health` never
   * reports one device in both lists, and `exhaustedNote` keeps naming only devices that
   * genuinely are not serving.
   *
   * This exists because removal used to be the only available verdict, and removal is
   * permanent: on a pool where every attached device is already a member, `failoverCandidates`
   * excludes them all, so EVERY failover verdict fell through to a shed. Two verdicts took a
   * three-device pool to one, and nothing could ever bring the other two back.
   */
  const degraded = new Map<string, { reason: string; at: number }>();

  /**
   * When each serial was last handed to a run — the round-robin clock.
   *
   * Kept beside the pool rather than on the lease, because a lease is deleted the moment it
   * is released and the ordering has to survive that: without it, "least recently dealt"
   * would reset every time a lane finished and first-fit would creep back in.
   */
  const dealtAtMs = new Map<string, number>();

  const degradeDevice = (serial: string, reason: string): void => {
    // The FIRST reason is kept: it is the one that explains why the device stopped being
    // trusted, and a later, vaguer failure would only bury it.
    if (degraded.has(serial)) return;
    degraded.set(serial, { reason, at: Date.now() });
    err(`[server] pool: ${serial} degraded — ${reason} (dealt last until it works again)`);
  };

  /**
   * This device just did real work, so it is not suspect any more.
   *
   * Recovery is proven by TRAFFIC, never by a clock. That is the same objection the
   * quarantine comment above raises against a TTL — a timer re-tries a broken device on a
   * schedule nobody can see — answered without one: the evidence is a command that was
   * going to run anyway, and nothing extra is spent to collect it.
   */
  const restoreDevice = (serial: string): void => {
    if (!degraded.delete(serial)) return;
    err(`[server] pool: ${serial} recovered — back in the healthy rotation`);
  };

  const degradedList = (): Array<{ serial: string; reason: string }> =>
    [...degraded.entries()].map(([serial, d]) => ({ serial, reason: d.reason }));

  /**
   * Failover runs ONE AT A TIME, process-wide.
   *
   * The claim store cannot provide this: `claimDevice` returns ok for a claim this
   * process already holds (`isMine`, by design), so two devices failing at once would
   * BOTH pass the claim check on the same spare, both start a worker for it, and end up
   * with two run tokens on one phone — the exact collision the pool exists to prevent.
   * Concurrency here is real: `/v1/exec` on two leases, and the per-device install
   * failovers that `Promise.all` fans out.
   *
   * Serializing is cheap because failover is the exceptional path, and it is also what
   * makes the second caller CORRECT rather than merely safe: by the time it runs, its
   * `pool.serials()` read already includes the spare the first one took, so it excludes
   * that device and looks for another (or shrinks).
   */
  const serializeFailover = serialQueue();

  // --- reconciliation -----------------------------------------------------------------
  //
  // The pool used to be a RATCHET: `adopt` ran at boot and, otherwise, only onto a device
  // that was not already a member. Nothing ever brought a device back, so every departure —
  // a worker crash, an unplugged cable, an emulator restarted out of band — was permanent
  // for the server's whole life, and capacity only ever fell.
  //
  // The sweep is the answer, and it is deliberately the same shape as `--devices` itself:
  // ask what SHOULD be serving, compare with what is, and start the difference. That is why
  // it needs no bespoke retry counter hung off worker death — a device that died is simply a
  // device that should be serving and is not, indistinguishable from one that was never
  // there, which is exactly the property that makes it cover cases a death-handler cannot.

  /**
   * How long a device that failed to rejoin waits before the next attempt, and the ceiling
   * on that wait.
   *
   * Backoff, not a flat interval, because "retry the ruled-out device on a timer" is the one
   * thing the quarantine comment above rightly refuses: a device that ran out of disk ten
   * minutes ago still has, and re-adopting it every minute would re-burn a full install on a
   * schedule nobody asked for. Doubling makes a genuinely broken device cost almost nothing
   * while a transiently absent one is back within a minute — and every attempt is logged, so
   * the schedule is one everybody can see.
   */
  const REJOIN_BACKOFF_MAX_MS = 30 * 60_000;

  /** How often the sweep runs, and therefore the base of the backoff: the first retry is
   *  simply the next sweep, and each failure doubles from there. One knob, so the cadence
   *  cannot drift away from the retry schedule it is supposed to pace. */
  const reconcileMs = config.reconcileMs ?? RECONCILE_INTERVAL_MS;

  /** Per serial: when it may next be tried, and how many times it has refused. */
  const rejoin = new Map<string, { nextAtMs: number; failures: number }>();

  /**
   * The last artifact successfully installed, kept so a device that rejoins can be brought
   * up to the build its siblings are running.
   *
   * Without this the sweep would introduce the exact failure `handleInstall` fans out to
   * avoid: a device serving a stale build while the lanes dealt onto it report green. One
   * file, replaced by each install and removed at shutdown.
   */
  let lastInstall: { path: string; ext: string } | null = null;

  /** Move a just-installed artifact into the single retained slot, replacing any previous. */
  const retainInstall = (from: string, ext: string): void => {
    const to = join(tmpdir(), 'verikun-server', `last-install.${ext}`);
    try {
      renameSync(from, to);
      // Only after the rename succeeds: pointing at a path that does not exist would make
      // every later rejoin fail on a missing file rather than simply not installing.
      lastInstall = { path: to, ext };
    } catch {
      /* keeping the build is best-effort; a rejoining device just stays on its own */
    }
  };

  /** Drop the retained build. Wired to the server's own close, so a long-lived host does not
   *  accumulate one APK per server it has ever run. */
  const dropRetainedInstall = (): void => {
    if (!lastInstall) return;
    try {
      unlinkSync(lastInstall.path);
    } catch {
      /* already gone */
    }
    lastInstall = null;
  };

  /**
   * Devices that should be serving, per what `--devices` asked for.
   *
   * `all` re-enumerates, so a device attached after startup legitimately joins; an explicit
   * list never grows beyond the serials the operator named. Returns null when the question
   * cannot be answered right now — nothing attached is a normal transient state for a sweep,
   * not the fatal startup error it is for `cmdServer`.
   */
  const wantedSerials = (): string[] | null => {
    const spec = config.poolSpec;
    if (!spec) return null;
    if (!spec.all) return spec.serials;
    try {
      return poolSerials(config.platform, spec, { quiet: true });
    } catch {
      return null;
    }
  };

  /**
   * Bring back one device, build and all. Returns whether it is now serving.
   *
   * Ordering matches `pickFailoverDeviceLocked`: claim, then probe, then commit. Starting the
   * worker IS the probe — it only reports ready once its own `preflight()` passed, on the
   * thread that will go on to use the device — so a phone that is still broken simply fails
   * to come back and says so.
   */
  const rejoinDevice = async (serial: string): Promise<boolean> => {
    if (claimsEnabled(claimEnv) && !claimDevice(serial, config.platform, claimOpts).ok) {
      return false; // held by another job on this host: busy is not broken, and not ours to take
    }
    if (!(await pool.adopt(serial))) {
      if (claimsEnabled(claimEnv)) releaseClaim(serial, { ...claimOpts, mineOnly: true });
      return false;
    }
    // Match the build its siblings are running, or this device is the one lane that silently
    // tests the previous APK — wrong-but-green, which is the failure mode `handleInstall`
    // fans out across every device to prevent in the first place.
    if (lastInstall) {
      try {
        const handle = pool.get(serial);
        if (handle) await handle.install(lastInstall.path);
        err(`[server] reconcile: ${serial} brought up to the current build`);
      } catch (e) {
        err(`[server] reconcile: ${serial} rejoined but could NOT take the current build — ${firstLine((e as Error).message)}`);
        // Serving the wrong build is worse than not serving: back out rather than deal it.
        pool.retire(serial);
        if (claimsEnabled(claimEnv)) releaseClaim(serial, { ...claimOpts, mineOnly: true });
        return false;
      }
    }
    // It came up and it is current, so whatever ruled it out no longer holds. Cleared on
    // EVIDENCE — a worker that started and a build that installed — never on a clock.
    quarantine.delete(serial);
    degraded.delete(serial);
    failedOver.delete(serial);
    return true;
  };

  const reconcileOnce = async (): Promise<void> => {
    const wanted = wantedSerials();
    if (!wanted) return;
    // An install (or a device-control op) is rewriting every device: a member joining now
    // would miss it. `lastInstall` is only set once that request has finished.
    if (exclusive !== null) return;
    const serving = new Set(pool.serials());
    const missing = wanted.filter((x) => !serving.has(x));
    if (!missing.length) return;
    const now = Date.now();
    for (const serial of missing) {
      const state = rejoin.get(serial);
      if (state && now < state.nextAtMs) continue;
      const attempt = (state?.failures ?? 0) + 1;
      err(`[server] reconcile: ${serial} should be serving and is not — attempt ${attempt}`);
      const ok = await serializeFailover(() => rejoinDevice(serial));
      if (ok) {
        rejoin.delete(serial);
      } else {
        const wait = Math.min(reconcileMs * 2 ** (attempt - 1), REJOIN_BACKOFF_MAX_MS);
        rejoin.set(serial, { nextAtMs: Date.now() + wait, failures: attempt });
        err(`[server] reconcile: ${serial} did not rejoin — next attempt in ${Math.round(wait / 1000)}s`);
      }
    }
  };

  let reconciling = false;
  const reconcileTimer =
    reconcileMs > 0 && config.poolSpec
      ? setInterval(() => {
          // A sweep can take a minute of its own (a worker start is allowed 60s), so a
          // second tick must not stack on top of the first.
          if (reconciling) return;
          reconciling = true;
          void reconcileOnce()
            .catch((e) => err(`[server] reconcile: sweep failed — ${firstLine((e as Error).message)}`))
            .finally(() => {
              reconciling = false;
            });
        }, reconcileMs)
      : null;
  // The first timer this server has ever had, so this is the first thing that could hold the
  // process open after Ctrl-C. It must not.
  reconcileTimer?.unref?.();

  const pickFailoverDevice = (failed: string, reason: string): Promise<string | null> =>
    serializeFailover(() => pickFailoverDeviceLocked(failed, reason));

  /**
   * Bring in a healthy replacement for `failed`. Returns the serial moved to, or null
   * when none remains (which is not an error here — the caller reports the ORIGINAL
   * failure).
   *
   * The walk order is load-bearing: claim-new -> probe -> commit -> release-old.
   * Releasing the old claim first would leave this server serving a device it no longer
   * holds, and another job on the host would take it mid-request.
   *
   * The probe is not a separate step here as it is on a single-device server: a worker
   * only reports ready once its OWN `preflight()` has passed, so starting the worker IS
   * the probe, run on the thread that will go on to use it.
   */

  const pickFailoverDeviceLocked = async (failed: string, reason: string): Promise<string | null> => {
    const policy = config.failover;
    if (!policy) return null;
    // Idempotency, on a marker of its OWN. Not pool membership — a worker that dies
    // unprompted leaves the pool synchronously via `onDeath`, long before its in-flight
    // rejection surfaces here, so that test would refuse to move in precisely the case
    // failover exists for. And not the quarantine either: `considerFailover` quarantines
    // BEFORE it asks, so that test would refuse every first attempt.
    const already = failedOver.get(failed);
    if (already !== undefined) return already;
    // lifecycle.list is the SAME source /v1/devices answers from, so what a client can
    // see and where the server will actually go cannot drift. A pool member's own driver
    // is not: it may be pointed at a corpse.
    /**
     * Nothing healthier exists. Shed the failed device — continuing to hand it out is
     * what makes a pool a coin flip per lease — but ONLY while another remains.
     *
     * The LAST device stays, deliberately. A server that shed it would answer every
     * later request `503 no device attached`, replacing the device's own error (full
     * disk, no space, whatever it actually was) with a message that names nothing. A
     * caller stuck on one broken device is better served by the truth about it.
     */
    const shrink = async (): Promise<null> => {
      // A device whose worker DIED is already out of the pool, so there is nothing left to
      // shed — but its holder still has to be evicted and its claim and companion handed
      // back, and the "last device stays" guard below must not skip that. Asking whether
      // it is still a member is what separates the two cases.
      const serving = pool.serials().includes(failed);
      if (serving) {
        // DEMOTE, never shed. The device keeps its worker, its claim and its place in the
        // pool; it is simply dealt last until it does some work (see `degradeDevice`).
        //
        // This replaces "nothing healthier to move to — X left the pool". That rule read
        // correctly on a SINGLE-device server, where it never actually fired (the last
        // device always stayed), and catastrophically on a pool, where it fired on every
        // verdict — because a pool's own members are excluded from its candidate list, so
        // "no candidate" is the normal case rather than the exceptional one. The argument
        // for shedding was that continuing to hand out a broken device makes a pool a coin
        // flip per lease; that is answered by ORDERING (a degraded device is chosen only
        // when nothing else is free), which costs no capacity. And it is the same judgement
        // the last-device branch already made out loud: a caller stuck on one broken device
        // is better served by the truth about it than by a server that quietly halved.
        //
        // The holder keeps its lease too: its device did not go anywhere, so there is no
        // `deviceChanged` to send and nothing for the run to seal. The step that failed
        // still fails, with this device's own error, exactly as before.
        quarantine.delete(failed);
        degradeDevice(failed, reason);
        return null;
      }
      // NOT serving — its worker already died, so the device left on its own and there is
      // nothing to demote. The holder is EVICTED, not migrated: without a replacement there
      // is no `deviceChanged` to send, so the client never learns to seal its run — and
      // merely dropping the lease would let its next request silently draw some other device
      // and continue a flow whose earlier steps ran elsewhere. A run that straddles two
      // phones and reports one is the false green this whole design refuses.
      evictHoldersOf(failed, `${failed} left the pool and nothing healthy replaced it`);
      err(`[server] failover: nothing healthier to replace ${failed} with (${pool.serials().length} device(s) remain)`);
      lostDevice = `${failed} (${reason})`;
      releaseCompanionOn(failed);
      if (claimsEnabled(claimEnv)) releaseClaim(failed, { ...claimOpts, mineOnly: true });
      return null;
    };

    let seen: DeviceInfo[] = [];
    try {
      seen = lifecycle.list(config.platform);
    } catch (e) {
      err(`[server] failover: cannot enumerate devices (${firstLine((e as Error).message)})`);
      return shrink();
    }
    const candidates = failoverCandidates(seen, {
      // Everything ALREADY IN THE POOL is excluded, not merely the failed device: on a
      // pool, moving onto a device another lease is mid-step on would be the collision
      // this whole feature exists to prevent.
      exclude: [...pool.serials(), ...quarantine.keys()],
      allow: policy.allowedTargets,
    });
    if (!candidates.length) return shrink();
    err(`[server] failover: ${candidates.length} candidate(s) — ${candidates.map((d) => d.serial).join(', ')}`);

    for (const c of candidates) {
      // Claim BEFORE probing: deciding "this one is free" and then taking it is the
      // read-then-write race device/claims.ts exists to prevent.
      if (claimsEnabled(claimEnv) && !claimDevice(c.serial, config.platform, claimOpts).ok) {
        err(`[server] failover: ${c.serial} is held by another job — skipping`);
        continue;
      }
      const adopted = await pool.adopt(c.serial);
      if (!adopted) {
        // `failed` is deliberately untouched — nothing is retired until a replacement is
        // genuinely serving — so the next candidate, or the shed above, still owns
        // releasing its companion and claim.
        // The worker refused to come up, which means its preflight failed — the same
        // verdict a standalone probe would have reached, reported by the thread that ran it.
        if (claimsEnabled(claimEnv)) releaseClaim(c.serial, { ...claimOpts, mineOnly: true });
        quarantineDevice(c.serial, 'probe failed (the device would not start serving)');
        continue;
      }
      err(`[server] failover: ${c.serial} probe ok — moving`);
      // ---- NO `await` FROM HERE TO `pool.retire` ----------------------------------
      // The LEASE FOLLOWS THE MOVE. A holder that lost its device must land on the
      // replacement the server just chose and reported, not on some third free device
      // its next request happens to draw — and it must not lose its place in the queue
      // either, since a move is not a reason to hand the floor to a racing job.
      //
      // Remapping BEFORE the device leaves the pool is what makes that airtight rather
      // than merely likely: while `failed` is still listed, `reapLeases` has no reason to
      // touch the holder, and once it is gone every lease already points elsewhere. An
      // `await` in between would hand the event loop to a racing `/v1/lease`, which would
      // reap the holder and hand this very spare to somebody else.
      //
      // The step that failed is still never replayed: it keeps this device's error, and
      // the client re-points its run context on `deviceChanged`, which seals the old run
      // and opens a fresh one so no report ever spans two devices.
      for (const lease of leases.values()) {
        if (lease.serial === failed) lease.serial = c.serial;
      }
      pool.retire(failed);
      failedOver.set(failed, c.serial);
      // ---- end of the critical region ---------------------------------------------
      // Hand back the old device's ONE UiAutomation connection, or it stays held for
      // up to 15 minutes with nothing on the host able to explain why. Never throws.
      releaseCompanionOn(failed);
      if (claimsEnabled(claimEnv)) releaseClaim(failed, { ...claimOpts, mineOnly: true });
      return c.serial;
    }
    return shrink();
  };

  /** Why no move happened, in a form worth putting in front of an operator. */
  const exhaustedNote = (): string => {
    const rows = quarantineList().map((q) => `  ${q.serial}  ${q.reason}`);
    return (
      `\n[failover] no working device remains${rows.length ? `; ruled out:\n${rows.join('\n')}` : ''}` +
      // Never prescribe `vk devices restart` alone: it exits 2 on a PHYSICAL device
      // ("verikun does not power-cycle physical devices"), which used to leave the one
      // device class that cannot be power-cycled with no route back but a server restart.
      // Reattaching is now a real remedy, because the sweep re-adopts what reappears.
      '\n[failover] reattach or fix a device and the pool re-adopts it within a minute; ' +
        'an emulator can also be power-cycled with `vk devices restart <name> --server <url>`'
    );
  };

  /** Announce an unrecognised move, so real-world strings reach a CI log and can be
   *  promoted into device/failover.ts's tables deliberately rather than guessed at. */
  const noteVerdict = (v: FailoverVerdict, e: unknown, what: string): void => {
    if (v.unclassified && v.move) {
      err(`[server] failover: unclassified ${what} failure, treating as device-attributable — ${firstLine((e as Error).message)}`);
    }
  };

  /**
   * Is this device actually gone? Two probes a second apart, because that gap is the only
   * thing separating a USB re-enumeration or a mid-`launch --clear` gap from a dead box —
   * and quarantining a healthy device is the expensive mistake here. Returns the reason
   * when dead, undefined when it was a blip.
   */
  const deviceIsDead = async (handle: DeviceHandle): Promise<string | undefined> => {
    let last = '';
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(PROBE_RETRY_MS);
      try {
        await handle.preflight();
        return undefined;
      } catch (e) {
        lastError = e;
        last = firstLine((e as Error).message);
      }
    }
    // The PROBE has failure modes of its own, and they are not all about this device.
    // `preflight()` checks the toolchain before it checks the phone (`probeAdb` shells out
    // to `adb version` on every call, uncached), so an adb server restart, a socket
    // exhaustion under several emulators, or a `kill-server` from another job fails BOTH
    // probes a second apart and convicted a perfectly healthy device.
    //
    // That is the exact upgrade `FailoverVerdict.probe` exists to prevent — "NEVER set on
    // transient or toolchain … with adb missing every probe fails" — and the guard was
    // being applied only to the ORIGINAL error, never to the probe's own. Classifying the
    // probe failure closes it: a host-level problem is not evidence against a device.
    const verdict = classifyFailure(lastError);
    if (verdict.kind === 'toolchain' || verdict.kind === 'transient') {
      err(`[server] probe on ${handle.serial}: ${verdict.reason} (${verdict.kind}) — a host problem, not this device`);
      return undefined;
    }
    return last || 'the device stopped answering';
  };

  /**
   * A non-install operation failed. Move off the device if it is genuinely at fault —
   * but NEVER replay the operation there.
   *
   * That restraint is the whole point. A `vk ai` step twelve deep presupposes the eleven
   * before it ran on THIS device; another device's app is at whatever an earlier run left
   * behind. Replaying would either find something matching and go green (a false green
   * that ships a regression) or wake the repair model against the wrong screen. So the
   * failing operation still fails, honestly, with the ORIGINAL device's error — and it is
   * the NEXT request that benefits from the move.
   *
   * The LEASE, unlike the step, does follow the move: the holder is re-pointed onto the
   * replacement in `pickFailoverDevice`, so its next request lands on the device this
   * response named rather than on some third one it happens to draw — and it keeps its
   * place in the queue, because a move is not a reason to hand the floor to a racing job.
   * `reapLeases` only drops a lease when its device left with NO replacement (the shrink
   * case). Every other lease is untouched throughout.
   *
   * Returns the change to report, or undefined when we stayed put.
   */
  const considerFailover = async (e: unknown, what: string, handle: DeviceHandle): Promise<DeviceChange | undefined> => {
    if (!config.failover) return undefined;
    const from = handle.serial;
    // Hold the holder's lease across the whole decision. A worker that dies unprompted
    // leaves the pool SYNCHRONOUSLY (`onDeath` → `forget`), and `deviceIsDead` then
    // spends two probes a second apart deciding what happened — seconds in which any
    // racing request's `reapLeases` would see this serial missing, evict the holder, and
    // leave the remap below with nothing to move. The run would be told
    // `deviceChanged: {to: spare}` and then 409'd forever while that spare sat idle.
    // Entering `moving` before the first `await` is what makes it airtight: the rejection
    // that brought us here resolves in the same microtask drain as the death, so no HTTP
    // request can be dispatched in between.
    beginMove(from);
    try {
      const verdict = classifyFailure(e);
      let reason = verdict.reason;
      if (!verdict.move) {
        // Only an unrecognised exit 3 earns a probe; `transient` and `toolchain` set
        // probe:false precisely so a mid-launch gap or a missing adb cannot become a move.
        //
        // Both of these arms used to return in COMPLETE SILENCE, which made a flapping
        // device invisible: a phone failing every other step while passing every probe
        // produced a failing suite and a server log with nothing in it at all.
        if (!verdict.probe) {
          err(`[server] ${what}: staying on ${from} — ${verdict.reason} (${verdict.kind})`);
          return undefined;
        }
        const dead = await deviceIsDead(handle);
        if (!dead) {
          err(`[server] ${what}: ${from} failed but probes healthy — staying (${verdict.reason})`);
          return undefined; // a blip — the test rerun is the right answer, not a new device
        }
        reason = dead;
        noteVerdict({ ...verdict, move: true }, e, what);
      }
      err(`[server] ${what}: FAILED on ${from} — ${reason}`);
      quarantineDevice(from, reason);
      // pickFailoverDevice has already said which of the two no-move outcomes happened —
      // the device was shed, or it was the last one and stayed. A second line here would
      // contradict one of them.
      const to = await pickFailoverDevice(from, reason);
      if (!to) return undefined;
      return { from, to, reason, retried: false };
    } finally {
      endMove(from);
    }
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!config.authKey) return true; // --allow-unsafe-anonymous
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return false;
    // Fixed-width digests make the comparison length-safe as well as timing-safe.
    return timingSafeEqual(sha(m[1]), sha(config.authKey));
  };

  // --- leases ---------------------------------------------------------------
  //
  // One run token holds one device for the whole run. With a single device this is
  // exactly the old lock (second token → 409, idle takeover after LOCK_IDLE_MS); with a
  // pool it is what gives a parallel suite N devices behind one URL while keeping every
  // call of a given run — including its repairs — on the phone that run started on.

  const leases = new Map<string, { serial: string; lastSeenMs: number; releasing?: boolean }>();
  const idleMs = config.idleMs ?? LOCK_IDLE_MS;

  /**
   * Run tokens whose device left the pool with NOTHING to move them to.
   *
   * They are refused a fresh device rather than quietly handed one: their flow ran on a
   * phone that is now gone, so continuing it elsewhere would produce a run whose steps
   * came from two devices while the report named one. A new run token (a rerun) is served
   * normally — this only closes the door on the run that was interrupted.
   */
  const evicted = new Set<string>();

  /**
   * Bounded, because on a long-lived CI server every interrupted run leaves an entry and
   * only its own `/v1/release` ever removes one. A Set iterates in insertion order, so
   * the front is the stalest — a client that died long ago and will never ask again.
   */
  const EVICTED_CAP = 512;

  /**
   * Refuse this run a device from here on. The ONE place that happens, so the rule —
   * a run whose device left is never silently re-homed — cannot be half-applied.
   */
  function evict(token: string, why: string): void {
    const had = leases.get(token);
    leases.delete(token);
    evicted.add(token);
    // Every eviction is announced. This is the direct cause of the 409 a client then reads
    // as an environment failure — and of the lane a suite retires over it — and it used to
    // be the one lease transition that happened in complete silence, so a degrading run
    // showed a burst of unexplained 409s with nothing anywhere connecting them to the
    // device that left.
    if (had) err(`[server] lease: run ${token.slice(0, 8)}… evicted from ${had.serial} — ${why}`);
    // `if`, not `while`: this adds exactly one entry, so at most one can be over.
    if (evicted.size > EVICTED_CAP) evicted.delete(evicted.values().next().value as string);
  }

  function evictHoldersOf(serial: string, why: string): void {
    for (const [token, lease] of leases) if (lease.serial === serial) evict(token, why);
  }

  /** Has this lease gone quiet long enough that another run may take its device? */
  function isIdle(token: string, lease: { lastSeenMs: number }, now: number): boolean {
    return now - lease.lastSeenMs >= idleMs && !inFlight.has(token);
  }

  /** Evict every lease whose device has left the pool. */
  function reapLeases(): void {
    const live = new Set(pool.serials());
    for (const [token, lease] of leases) {
      // A failover is mid-decision on this device: its holder keeps the lease so the
      // remap can follow the move. See `considerFailover`.
      if (moving.has(lease.serial)) continue;
      // Its device vanished — a worker that died, or a shed that beat us here. Same
      // verdict as an explicit shed: EVICT, never silently re-home. Handing this run
      // another phone would continue a flow whose earlier steps ran somewhere else,
      // and the report would name only the first.
      if (!live.has(lease.serial)) evict(token, `${lease.serial} is no longer in the pool`);
    }
  }

  /** This token's device, taking a free one when it has none. Null = pool exhausted. */
  function leaseFor(token: string): string | null {
    // A whole-server operation is in flight: every device is about to change underneath.
    if (exclusive !== null && exclusive !== token) return null;
    if (evicted.has(token)) return null;
    const now = Date.now();
    reapLeases();
    if (evicted.has(token)) return null; // our device left the pool while we were away
    const mine = leases.get(token);
    if (mine) {
      // A token asking for its own device gets THAT device, however long it was away.
      // Idleness is not a reason to re-deal: a lane pausing to compile a test or to wait
      // out a model repair does client-side work with nothing in flight, and re-dealing
      // there would swap two paused runs' phones with no `deviceChanged` and no error —
      // both still reporting the serial they leased while every later step came from
      // somewhere else. The single-device `acquireLock` this replaced could not do that;
      // for the same token it was a pure refresh, and a pool must not be a downgrade.
      mine.lastSeenMs = now;
      return mine.serial;
    }
    // `moving` is excluded as firmly as a leased device: handing out a phone whose
    // failover is still being decided would either give this run the casualty or race the
    // remap for the replacement.
    const taken = new Set([...leases.values()].map((l) => l.serial));
    // HEALTH first, then least-recently-dealt. The old `find` took the first free serial in
    // pool order, which quietly gave a BROKEN device more traffic than a healthy one: a
    // device that fails fast returns to the free set fastest, so first-fit handed it
    // straight back out while the healthy devices were still busy doing real work. Ordering
    // by health is also what makes demotion (see `degradeDevice`) a complete answer to
    // shedding — a suspect device is reached only when nothing else is free, which costs no
    // capacity and cannot starve a pool the way removal did.
    const free = pool
      .serials()
      .filter((s) => !taken.has(s) && !moving.has(s))
      .sort((a, b) => {
        const health = Number(degraded.has(a)) - Number(degraded.has(b));
        if (health !== 0) return health;
        return (dealtAtMs.get(a) ?? 0) - (dealtAtMs.get(b) ?? 0);
      })[0];
    if (free) {
      leases.set(token, { serial: free, lastSeenMs: now });
      dealtAtMs.set(free, now);
      err(`[server] lease: ${free} → run ${token.slice(0, 8)}…${degraded.has(free) ? ' (degraded — nothing healthy was free)' : ''}`);
      return free;
    }
    // Nothing free. THIS is where an idle lease is broken — on demand, by a run that
    // actually needs a device, rather than on a timer. A crashed client still cannot
    // hold a phone forever (the reason the idle window exists at all), and a merely slow
    // one keeps its device for as long as nobody else wants it. The stalest goes first.
    const stale = [...leases.entries()]
      .filter(([t, l]) => isIdle(t, l, now) && !moving.has(l.serial))
      .sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)[0];
    if (!stale) return null;
    const [victim, lease] = stale;
    err(`[server] lease: idle run ${victim.slice(0, 8)}… lost ${lease.serial} to run ${token.slice(0, 8)}…`);
    // EVICTED, not merely dropped: somebody else is about to drive that phone, so the
    // victim's flow cannot continue anywhere — and being told so beats being handed a
    // different device and reporting one run that ran on two.
    evict(victim, `idle — ${lease.serial} went to run ${token.slice(0, 8)}…`);
    leases.set(token, { serial: lease.serial, lastSeenMs: now });
    return lease.serial;
  }

  /**
   * The token holding the WHOLE server, for an operation that touches every device.
   *
   * `othersActive` only answers the question one way round — "may I start, given who is
   * already running?" — and `leaseFor` taking a single serial cannot answer the other.
   * On a pool that leaves the install window wide open: the installer holds one device
   * while writing a binary to all of them, so another token leases devices 2..N and runs
   * steps straight through the swap. Silent, and green: the run's early steps ran on the
   * old build and its later ones on the new.
   *
   * Bounded by the request that set it — every exit from handleInstall clears it in a
   * `finally`, and `server.requestTimeout` is the backstop if a client vanishes mid-upload.
   */
  let exclusive: string | null = null;

  function busyError(token?: string): HttpError {
    if (token !== undefined && evicted.has(token)) {
      // Named plainly, because "device is busy" would send the operator looking for a
      // racing job that does not exist.
      return new HttpError(
        409,
        'the device this run was using left the pool and nothing healthy replaced it — ' +
          'start a fresh run; this one cannot continue on another device',
        3,
      );
    }
    const n = pool.serials().length;
    return new HttpError(
      409,
      n > 1
        ? `all ${n} devices are leased by other active runs — retry when one finishes`
        : 'device is locked by another active run — retry when it finishes',
    );
  }

  /** The device this request runs against. Commands are serialized per device by the
   *  handle itself, so two leases proceed independently. */
  function leasedHandle(token: string): DeviceHandle {
    const serial = leaseFor(token);
    if (!serial) throw busyError(token);
    const handle = pool.get(serial);
    if (!handle) throw new HttpError(503, `device ${serial} is no longer attached`, 3);
    return handle;
  }

  /**
   * Hold a lease open for the length of one request.
   *
   * The heartbeat is stamped when a request ARRIVES, but a single request can legitimately
   * outlast LOCK_IDLE_MS — a `wait --timeout 600000`, a large install, a model repair
   * round-trip. Without this an idle-takeover fires mid-step and a sibling is handed the
   * very device this run is driving; the old design could not do that because every
   * device endpoint went through one global queue. Counting in-flight requests per token
   * lets `reapLeases` leave a busy lease alone without extending the idle window itself.
   */
  const inFlight = new Map<string, number>();
  async function holdingLease<T>(token: string, fn: () => Promise<T>): Promise<T> {
    inFlight.set(token, (inFlight.get(token) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (inFlight.get(token) ?? 1) - 1;
      if (n > 0) inFlight.set(token, n);
      else inFlight.delete(token);
      // A release that arrived mid-command lands here, once the device is genuinely free.
      // The flag lives ON the lease rather than in a token-keyed set beside it, so it
      // cannot outlive the lease it describes: a token that released and then leased again
      // gets a fresh record, and this finally can no longer delete the NEW one.
      // (No `return` in a finally — it would swallow `fn`'s result.)
      const lease = leases.get(token);
      if (lease?.releasing && !inFlight.has(token)) leases.delete(token);
      else if (lease) lease.lastSeenMs = Date.now();
    }
  }

  /** Whether anyone ELSE is mid-run. Guards the two whole-server operations — install
   *  (which writes a binary to every device) and device control (which power-cycles
   *  one) — so neither can happen under a running suite. */
  function othersActive(token: string): boolean {
    // The latch counts: a device-control op or an install held by someone else owns every
    // device, and it may hold no ordinary lease at the moment we ask.
    if (exclusive !== null && exclusive !== token) return true;
    reapLeases();
    // An IDLE lease does not count as active — otherwise a client that crashed without
    // releasing would block every install and every power-cycle for the rest of the
    // server's life, which is the state the idle window exists to escape. It keeps its
    // device until somebody asks for one, but it is no longer "mid-run".
    const now = Date.now();
    return [...leases.entries()].some(([t, l]) => t !== token && !isIdle(t, l, now));
  }

  /**
   * Clear the way for a whole-server operation, evicting whoever is merely idle.
   *
   * `othersActive` deliberately steps over an idle lease so a crashed client cannot wedge
   * the server — but an install rewrites the app on every device and a power cycle wipes
   * it, so an idle holder that later resumed would run step 12 against a build or a state
   * its first eleven steps never saw. Silent and green, which is what the whole lease
   * design refuses. Being told "start a fresh run" is the honest answer.
   */
  function evictIdleHolders(token: string, why: string): void {
    const now = Date.now();
    for (const [t, l] of [...leases.entries()]) {
      if (t === token || !isIdle(t, l, now)) continue;
      // `evict` announces it — this used to log here because it was the only eviction
      // path that said anything at all.
      evict(t, why);
    }
  }

  async function handleExec(handle: DeviceHandle, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    // Off to this device's worker thread: the call underneath is a blocking spawnSync,
    // and running it here would stall every other device's requests.
    //
    // The REJECTION path matters as much as the outcome: a worker that died mid-step
    // rejects here rather than returning a non-zero code, and letting that escape would
    // skip failover entirely — so an unreachable device would be failed over when READ
    // (handleElements catches) but never when DRIVEN, and the pool would keep handing
    // that serial to the next lease.
    let outcome: WorkerExecResult;
    try {
      outcome = await handle.exec({
        command: node.command,
        positionals: node.positionals,
        flags: leafToFlags(node),
      });
    } catch (e) {
      const changed = await considerFailover(e, 'exec', handle);
      throw changed ? new HttpError(500, (e as Error).message, e instanceof CliError ? e.exitCode : 3, changed) : e;
    }
    const { code, error, step, artifacts, logStart } = outcome;
    err(`[server] ${handle.serial} exec ${node.command} ${node.positionals.join(' ')} → exit ${code} (${Date.now() - t0}ms)`);
    // Anything but an ENVIRONMENT failure proves the device drove the step: exit 1 is a
    // failed assertion and exit 2 a usage error, both of which are verdicts about the APP
    // — the same polarity the classifier itself applies (exit 1 → `app`, exit 2 → `usage`,
    // neither ever moves). Only exit 3 leaves the device still suspect.
    if (code !== 3) restoreDevice(handle.serial);
    // The step keeps its own verdict whatever we decide here: the error below is the one
    // THIS device produced, never a replay's. Only the pool membership moves.
    const deviceChanged =
      code !== 0 && error ? await considerFailover(rebuildError(error), 'exec', handle) : undefined;
    const payload: ExecResponse = {
      code,
      ...(error ? { error } : {}),
      ...(deviceChanged ? { deviceChanged } : {}),
      ...(step ? { step } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts: encodeArtifacts(artifacts) } : {}),
      ...(logStart ? { logStart } : {}),
    };
    sendJson(res, 200, payload);
  }

  async function handleElements(handle: DeviceHandle, req: IncomingMessage, res: ServerResponse): Promise<void> {
    await readBody(req, EXEC_BODY_CAP); // drain (the body is unused; keeps keep-alive sane)
    try {
      const elements = await handle.elements(); // CliError(3) on dump failure → 500 below
      // A hierarchy dump is the single most demanding thing this server asks of a device,
      // so one that succeeds is strong evidence the device is well again.
      restoreDevice(handle.serial);
      sendJson(res, 200, { elements });
    } catch (e) {
      // Move if the device is at fault, but NEVER answer with the new device's screen:
      // this is the engine's `if-present` guard input and its repair context, and a
      // hierarchy from somewhere else is worse than an error. The client's connect probe
      // re-asks after a reported move — see remote.ts's preflight.
      const deviceChanged = await considerFailover(e, 'read', handle);
      if (!deviceChanged) throw e;
      throw new HttpError(500, (e as Error).message, e instanceof CliError ? e.exitCode : 3, deviceChanged);
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
    const logs = await handle.logs({
      ...(lines !== undefined ? { lines } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(appId ? { appId } : {}),
      ...(parsed.scopedOnly ? { scopedOnly: true } : {}),
    });
    const payload: LogsResponse = { logs };
    sendJson(res, 200, payload);
  }

  /**
   * Install, moving to another device when THIS one is at fault.
   *
   * Install is the one operation safe to REPLAY elsewhere: it is idempotent, carries no
   * app session, and the uploaded bytes are still on the server's disk, so a retry costs
   * one more `adb install` and no re-upload. Every other endpoint rebinds without
   * replaying — see handleExec.
   *
   * On exhaustion it throws the FIRST device's error, never the last. That inversion is
   * what makes move-by-default safe: a wrong move costs time, not the diagnosis.
   */
  async function installWithFailover(serial: string, tmpPath: string): Promise<{ change?: DeviceChange; moves: number }> {
    let change: DeviceChange | undefined;
    let moves = 0;
    let firstError: unknown;
    let from = serial;
    /**
     * Hop to a healthy device, or throw the failure the caller should see.
     *
     * ONE helper for both reasons an install stops using a device — it failed, or it left
     * the pool — because the difference between them is a message, and writing the hop
     * twice is how the exhaustion arm lost `change`. `HttpError.deviceChanged` is the only
     * way a move that DID happen survives a failed install (`handleInstall`'s per-device
     * wrapper keeps no result on a throw), so dropping it leaves the operator holding a
     * serial the server has already left.
     */
    const hopOrThrow = async (why: string, giveUp: unknown): Promise<string> => {
      quarantineDevice(from, why);
      const to = await pickFailoverDevice(from, why);
      if (to === null) {
        // A pool that emptied with nothing having moved keeps its own 503 — a more
        // accurate status than a wrapped 500.
        if (giveUp instanceof HttpError && change === undefined) throw giveUp;
        const original = giveUp instanceof Error ? giveUp.message : String(giveUp);
        throw new HttpError(500, `${original}${exhaustedNote()}`, 3, change);
      }
      change = { from, to, reason: why, retried: true };
      moves++;
      err(`[server] install: retrying on ${to}…`);
      return to;
    };
    for (let hop = 0; ; hop++) {
      const handle = pool.get(from);
      if (!handle) {
        // The device left the pool mid-install — its worker died, or an earlier failover
        // retired it. That is as device-attributable as a failure gets, and install is the
        // ONE operation safe to replay elsewhere (idempotent, no app session, the bytes
        // are still on our disk), so it hops rather than throwing a bare 503 that never
        // reaches the failover machinery at all.
        const gone = firstError ?? new HttpError(503, `device ${from} is no longer attached`, 3);
        if (!config.failover || hop >= MAX_FAILOVER_HOPS) throw gone;
        from = await hopOrThrow('the device left the pool mid-install', gone);
        continue;
      }
      try {
        await handle.install(tmpPath);
        return { change, moves };
      } catch (e) {
        if (firstError === undefined) firstError = e;
        const verdict = classifyInstallFailure(e);
        err(`[server] install: FAILED on ${from} — ${verdict.reason}`);
        noteVerdict(verdict, e, 'install');
        // The artifact is broken / the caller is wrong / failover is off / we are out of
        // hops: report the first failure unchanged, exactly as before this feature.
        if (!verdict.move || !config.failover || hop >= MAX_FAILOVER_HOPS) throw firstError;
        from = await hopOrThrow(verdict.reason, firstError);
      }
    }
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
      // EVERY device in the pool, concurrently. A parallel suite deals its tests across
      // all of them, so installing on one would leave the other lanes running the
      // previous build — a wrong-but-green result, which is the worst kind. Each device
      // carries its own failover budget, so one full disk costs that device, not the build.
      const targets = pool.serials();
      // Re-read AFTER the upload, so an empty pool is caught here rather than at the
      // door. A device whose worker died mid-transfer would otherwise leave `outcomes`
      // empty, `failed.length` zero, and this handler answering `200 {ok:true,
      // devices:[]}` — an install that installed nowhere, reported as a success, with the
      // suite that follows running the previous build.
      if (!targets.length) {
        throw new HttpError(503, `no device is left to install onto${lostDevice ? ` — last loss: ${lostDevice}` : ''}`, 3);
      }
      err(`[server] install: received ${size} bytes (.${ext}), installing on ${targets.join(', ')}…`);
      const outcomes = await Promise.all(
        targets.map(async (serial) => {
          try {
            return { serial, ...(await installWithFailover(serial, tmpPath)), error: null as unknown };
          } catch (e) {
            return { serial, change: undefined, moves: 0, error: e };
          }
        }),
      );
      const failed = outcomes.filter((o) => o.error);
      const moved = outcomes.filter((o) => o.change);
      if (failed.length) {
        // One artifact, many devices: if it failed everywhere the file is the suspect, so
        // surface the FIRST device's error unchanged rather than a summary that buries it.
        if (failed.length === targets.length) {
          // …and if the FILE is the suspect, none of the devices were. Each per-device
          // failover quarantined its own device on the way here, because the install
          // classifier moves by default on any wording it has not seen — a deliberate
          // polarity, since the device side is open-ended and OEM-specific. That is right
          // for ONE device failing; applied to every device at once it condemns the whole
          // pool for what this very branch has just concluded is a bad build. Undo them.
          const condemned = targets.filter((t) => quarantine.delete(t));
          if (condemned.length) {
            err(`[server] install: failed on every device, so the build is the suspect — un-quarantining ${condemned.join(', ')}`);
          }
          throw failed[0].error;
        }
        // Carry a move that DID happen even though the overall install failed: the
        // client re-points its run context on `deviceChanged`, and dropping it here
        // would leave the operator holding a serial the server has already left.
        throw new HttpError(
          500,
          `install failed on ${failed.map((f) => `${f.serial} (${firstLine((f.error as Error).message)})`).join('; ')}`,
          3,
          moved[0]?.change,
        );
      }
      for (const m of moved) err(`[server] install: ${m.serial} → ${m.change!.to} (${m.moves} move(s))`);
      err(`[server] install: done on ${pool.serials().join(', ')}`);
      // Retain the artifact so a device that rejoins later can be brought up to this build
      // (see `rejoinDevice`). Renamed out of the per-request temp name into one stable slot,
      // so at most one build is ever held and each install replaces the last.
      retainInstall(tmpPath, ext);
      retained = true;
      const body: InstallResponse = {
        ok: true,
        bytes: size,
        sha256: digest,
        devices: pool.serials(),
        // The wire field is singular; a pool that moved more than one device logs the rest.
        ...(moved.length ? { deviceChanged: moved[0].change } : {}),
      };
      sendJson(res, 200, body);
    } finally {
      // A retained artifact has been renamed away; unlinking here would delete the build the
      // reconciler needs.
      if (!retained) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* upload may have failed before the file existed */
        }
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
   * KNOWN COST, stated in the refusal so nobody has to discover it: this is also the only
   * thing that clears a quarantine, so on a pool a device ruled out by failover stays out
   * until the server is restarted. That is the price of refusing rather than guessing;
   * lifting it would mean letting a NAMED, allowlisted target act on one pool member.
   */
  function requireSingleDevice(op: string): void {
    const n = pool.serials().length;
    if (n > 1) {
      throw new HttpError(
        403,
        `this server pools ${n} devices, so '${op}' has no single device to act on. ` +
          'Run one server per device if you need remote device control — ' +
            'on a pool, a quarantined device is readmitted only by restarting the server.',
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
      if (started || serial !== soleSerial()) await rebind(serial);
      result = { ok: true, platform: config.platform, serial, changed: started, durationMs: Date.now() - t0 };
    }

    // A power cycle IS the fix for a quarantined device, and performing one is the
    // assertion that it worked. Clear by both keys: a client names an AVD, the
    // lifecycle layer answers with a serial.
    for (const key of [result.serial, target]) {
      if (!key) continue;
      quarantine.delete(key);
      failedOver.delete(key); // a readmitted device gets a clean slate, not a stale verdict
    }
    // A device is serving again, so the last loss no longer explains anything.
    if (pool.serials().length) lostDevice = null;

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
      const serials = pool.serials();
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
    const served = new Set(pool.serials());

    if (req.method === 'POST' && path === '/v1/release') {
      // A finished client frees its lease so the NEXT run proceeds immediately instead
      // of waiting out the idle takeover. Only the holder can release.
      await readBody(req, EXEC_BODY_CAP); // drain
      const mine = leases.get(token);
      const released = mine !== undefined;
      if (mine && inFlight.has(token)) {
        // The client is done but the DEVICE is not: an aborted fetch (a dump that
        // outran ELEMENTS_TIMEOUT_MS, say) leaves its worker still executing. Handing
        // the phone to a sibling now would start its run under an abandoned command
        // from a dead one. Defer instead — `holdingLease`'s finally does the delete
        // once the last request lands, and the idle window is the backstop.
        mine.releasing = true;
      } else {
        leases.delete(token);
      }
      evicted.delete(token);
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
      exclusive = token;
      evictIdleHolders(token, `the device was ${op === 'stop' ? 'stopped' : 'power-cycled'}`);
      try {
        return await handleDeviceOp(op, policy, req, res);
      } finally {
        exclusive = null;
      }
    }
    if (req.method === 'GET' && path === '/v1/devices') {
      // Neither locked nor serialized: a diagnostic must stay answerable DURING
      // someone else's run, and it queries host tooling, not the device. Still gated,
      // because enumerating every AVD on the host exposes the operator's other devices.
      const policy = requireDeviceControl();
      const seen = (() => {
        try {
          return lifecycle.list(config.platform);
        } catch {
          return [];
        }
      })();
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
        const q = quarantine.get(d.serial);
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
        lostDevice
          ? `this verikun server has no device left to serve — last loss: ${lostDevice}`
          : config.deviceControl
            ? 'no device is attached to this verikun server — run `vk devices start --server <url>` to boot one'
            : 'no device is attached to this verikun server',
        3,
      );
    }

    if (req.method === 'POST' && path === '/v1/lease') {
      // Take (or confirm) this run's device UP FRONT, so the caller knows which phone it
      // got before its first step — a step attributed to the wrong device is worse than
      // one attributed to none. Idempotent: re-leasing returns the same device.
      await readBody(req, EXEC_BODY_CAP); // drain
      const handle = leasedHandle(token);
      const reads = await safeReads(handle, { fresh: true });
      const body: LeaseResponse = {
        platform: config.platform,
        serial: handle.serial,
        ...(reads ? { reads } : {}),
      };
      sendJson(res, 200, body);
      return;
    }
    // Taking the lease and holding it open are ONE step, deliberately expressed as one
    // helper. A route that resolved a handle and forgot the hold would compile, pass, and
    // silently lose its device to the idle takeover on any step longer than LOCK_IDLE_MS.
    const onLeasedDevice = (fn: (h: DeviceHandle) => Promise<void>): Promise<void> => {
      const h = leasedHandle(token);
      return holdingLease(token, () => fn(h));
    };
    if (req.method === 'POST' && path === '/v1/exec') return onLeasedDevice((h) => handleExec(h, req, res));
    if (req.method === 'POST' && path === '/v1/elements') return onLeasedDevice((h) => handleElements(h, req, res));
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
      exclusive = token;
      evictIdleHolders(token, 'the app was reinstalled on every device');
      leaseFor(token);
      try {
        // Held open like any other device request. Without it the installer's own lease
        // ages out during a multi-minute upload+install, and the moment `exclusive` is
        // cleared the next `reapLeases` hands its device to a racing job — losing exactly
        // the install-then-suite continuity the lease above exists to provide.
        return await holdingLease(token, () => handleInstall(req, res));
      } finally {
        exclusive = null;
      }
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
          const body: RpcErrorBody = {
            error: mapped.message,
            exitCode: mapped.exitCode,
            ...(mapped.deviceChanged ? { deviceChanged: mapped.deviceChanged } : {}),
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
  // Node hangs up an idle keep-alive connection after FIVE SECONDS by default, and
  // advertises that in its `Keep-Alive` header — which the client's fetch pool honours.
  // A verikun client routinely pauses far longer than that between requests: compiling a
  // test with the model takes tens of seconds, during which the client is one blocking
  // `spawnSync` and cannot even notice the socket close. The next request then writes to a
  // dead socket and surfaces as `fetch failed`, which the suite reads as the DEVICE being
  // unreachable — a lane retired for a healthy server. Outliving the lease's own idle
  // window is the honest number: a connection should survive exactly as long as the run
  // holding it is still considered alive.
  server.keepAliveTimeout = LOCK_IDLE_MS;
  // …and bound how many of those long-lived sockets may exist. `/v1/health` is
  // unauthenticated and meant to be polled, so a 60x longer idle window with no cap turns
  // a monitoring loop or a port scan into file-descriptor pressure — which surfaces as
  // unrelated DEVICE errors, since the worker threads spawn adb/idb and need descriptors
  // of their own. Far above any real client count; this is a backstop.
  server.maxConnections = 256;
  // Tie the sweep timer and the retained build to the server's own lifetime, so a test that
  // builds a server and drops it leaves neither behind, and Ctrl-C is clean in production.
  server.on('close', () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    dropRetainedInstall();
  });

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
  if (raw === undefined || raw === false) return undefined;
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
  const asked = raw !== undefined && raw !== false;
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
  // each device's own worker thread — also fails for a broken toolchain, and that is NOT
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
  // Each device gets a worker thread, and a worker only reports ready once preflight()
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
    // Only a POOL reconciles: a single-device server's binding belongs to /v1/devices/*
    // and to failover's rebind, and a sweep would fight both.
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
    const close = () => {
      err('[server] shutting down');
      // Hand the device's ONE UiAutomation connection back. The companion outlives the
      // process that started it and would otherwise keep the connection for up to its full
      // 15-minute idle window, blocking Appium, Layout Inspector and TalkBack on this host —
      // with no obvious cause, and no way to stop it from a `--server` client.
      for (const serial of live()) releaseCompanionOn(serial);
      void pool.disposeAll();
      server.close();
      // Last, and in this order: the sink is detached BEFORE the descriptor closes, or a
      // stray `err()` from the teardown above races a closed fd. Dropping the tee first
      // means those lines still reach stderr, which is where a Ctrl-C is being read anyway.
      setErrSink(null);
      serverLog?.close();
      resolve(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
