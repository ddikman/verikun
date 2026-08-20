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
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
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
import { assertActionable, chooseTarget, lifecycleFor, restartTarget } from './drivers/lifecycle';
import { err, setOutputQuiet } from './output';
import { DeviceInfo, HierarchySource, Platform } from './types';
import { DeviceHandle, DevicePool, WorkerDevicePool } from './server-pool';
import { FlagSpec, InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import {
  rebuildError, DeviceChange, DeviceListResponse, DeviceOpRequest, DeviceOpResponse,
  ExecRequest, ExecResponse, HealthResponse, InstallResponse, LeaseResponse, LogsRequest,
  LogsResponse, RpcErrorBody,
} from './rpc';
import { platformFromFlags, deviceFromFlags } from './cli';
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
const PROBE_RETRY_MS = 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  /** Called whenever /v1/devices/* changes the binding, so the owner can track which
   *  device is live — shutdown must release the companion on the CURRENT device, not
   *  whichever one happened to be bound at startup. */
  onRebind?: (serial: string | null) => void;
  // --- seams (tests) ---
  lifecycle?: ServerLifecycle;
  /** Points the host-global claim store somewhere throwaway. Undefined in production,
   *  where the store is $HOME-relative — without this a unit test asserting the failover
   *  claim hand-off would write into the developer's real `~/.verikun/devices`. */
  claimOpts?: ClaimOpts;
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
  for (const [rel, buf] of Object.entries(artifacts)) out[rel] = buf.toString('base64');
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
  const soleSerial = (): string | null => (pool.serials().length === 1 ? pool.serials()[0] : null);

  // Rebuild the worker rather than invalidating a cache: both drivers cache a pinned
  // serial without probing, so an AVD that returns on a different port would leave a
  // permanently dead instance. Always rebind to the CONCRETE serial the lifecycle layer
  // returned — never undefined, which would auto-resolve and could silently latch onto a
  // different attached device.
  const rebind = async (serial: string | null): Promise<void> => {
    await pool.rebind(serial);
    leases.clear(); // whatever they were holding no longer exists
    config.onRebind?.(serial);
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

  const quarantineDevice = (serial: string | null, reason: string): void => {
    if (!serial || quarantine.has(serial)) return;
    quarantine.set(serial, { reason, at: Date.now() });
    err(`[server] failover: ${serial} quarantined (${reason})`);
  };

  /** For /v1/health and the exhaustion message. */
  const quarantineList = (): Array<{ serial: string; reason: string }> =>
    [...quarantine.entries()].map(([serial, q]) => ({ serial, reason: q.reason }));

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
  let failoverGate: Promise<unknown> = Promise.resolve();
  const serializeFailover = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = failoverGate.then(fn, fn);
    failoverGate = next.catch(() => undefined);
    return next;
  };

  const pickFailoverDevice = (failed: string): Promise<string | null> =>
    serializeFailover(() => pickFailoverDeviceLocked(failed));

  const pickFailoverDeviceLocked = async (failed: string): Promise<string | null> => {
    const policy = config.failover;
    if (!policy) return null;
    // Another failover may have already dealt with this device while we queued.
    if (!pool.get(failed)) return null;
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
      if (pool.serials().length <= 1) {
        err(`[server] failover: nothing healthier to move to — staying on ${failed}`);
        return null;
      }
      await pool.replace(failed, null);
      err(`[server] failover: nothing healthier to move to — ${failed} left the pool (${pool.serials().length} device(s) remain)`);
      releaseCompanionOn(failed);
      if (claimsEnabled(claimEnv)) releaseClaim(failed, { ...claimOpts, mineOnly: true });
      config.onRebind?.(soleSerial());
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
      const arrived = await pool.replace(failed, c.serial);
      if (!arrived) {
        // The worker refused to come up, which means its preflight failed — the same
        // verdict a standalone probe would have reached, reported by the thread that ran it.
        if (claimsEnabled(claimEnv)) releaseClaim(c.serial, { ...claimOpts, mineOnly: true });
        quarantineDevice(c.serial, 'probe failed (the device would not start serving)');
        continue;
      }
      err(`[server] failover: ${c.serial} probe ok — moving`);
      // The LEASE FOLLOWS THE MOVE. A holder that lost its device must land on the
      // replacement the server just chose and reported, not on some third free device
      // its next request happens to draw — and it must not lose its place in the queue
      // either, since a move is not a reason to hand the floor to a racing job. The step
      // that failed is still never replayed: it keeps this device's error, and the
      // client re-points its run context on `deviceChanged`, which seals the old run and
      // opens a fresh one so no report ever spans two devices.
      for (const lease of leases.values()) {
        if (lease.serial === failed) lease.serial = arrived;
      }
      // Hand back the old device's ONE UiAutomation connection, or it stays held for
      // up to 15 minutes with nothing on the host able to explain why. Never throws.
      releaseCompanionOn(failed);
      if (claimsEnabled(claimEnv)) releaseClaim(failed, { ...claimOpts, mineOnly: true });
      config.onRebind?.(soleSerial());
      return arrived;
    }
    return shrink();
  };

  /** Why no move happened, in a form worth putting in front of an operator. */
  const exhaustedNote = (): string => {
    const rows = quarantineList().map((q) => `  ${q.serial}  ${q.reason}`);
    return (
      `\n[failover] no working device remains${rows.length ? `; ruled out:\n${rows.join('\n')}` : ''}` +
      '\n[failover] clear one with `vk devices restart <name> --server <url>`, or fix it and restart the server'
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
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(PROBE_RETRY_MS);
      try {
        await handle.preflight();
        return undefined;
      } catch (e) {
        last = firstLine((e as Error).message);
      }
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
    const verdict = classifyFailure(e);
    let reason = verdict.reason;
    if (!verdict.move) {
      // Only an unrecognised exit 3 earns a probe; `transient` and `toolchain` set
      // probe:false precisely so a mid-launch gap or a missing adb cannot become a move.
      if (!verdict.probe) return undefined;
      const dead = await deviceIsDead(handle);
      if (!dead) return undefined; // a blip — the test rerun is the right answer, not a new device
      reason = dead;
      noteVerdict({ ...verdict, move: true }, e, what);
    }
    const from = handle.serial;
    err(`[server] ${what}: FAILED on ${from} — ${reason}`);
    quarantineDevice(from, reason);
    // pickFailoverDevice has already said which of the two no-move outcomes happened —
    // the device was shed, or it was the last one and stayed. A second line here would
    // contradict one of them.
    const to = await pickFailoverDevice(from);
    if (!to) return undefined;
    return { from, to, reason, retried: false };
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

  const leases = new Map<string, { serial: string; lastSeenMs: number }>();

  /** Drop leases nobody has touched lately, and any whose device has left the pool.
   *  The second half is how failover reaches a lease: a quarantined device's holder is
   *  released here, so its NEXT request takes a healthy one. */
  function reapLeases(now: number): void {
    const live = new Set(pool.serials());
    for (const [token, lease] of leases) {
      if (!live.has(lease.serial)) {
        leases.delete(token);
      } else if (now - lease.lastSeenMs >= LOCK_IDLE_MS) {
        err(`[server] lease: idle run ${token.slice(0, 8)}… released ${lease.serial}`);
        leases.delete(token);
      }
    }
  }

  /** This token's device, taking a free one when it has none. Null = pool exhausted. */
  function leaseFor(token: string): string | null {
    const now = Date.now();
    reapLeases(now);
    const mine = leases.get(token);
    if (mine) {
      mine.lastSeenMs = now; // the heartbeat that keeps a long step from losing its device
      return mine.serial;
    }
    const taken = new Set([...leases.values()].map((l) => l.serial));
    const free = pool.serials().find((s) => !taken.has(s));
    if (!free) return null;
    leases.set(token, { serial: free, lastSeenMs: now });
    err(`[server] lease: ${free} → run ${token.slice(0, 8)}…`);
    return free;
  }

  function busyError(): HttpError {
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
    if (!serial) throw busyError();
    const handle = pool.get(serial);
    if (!handle) throw new HttpError(503, `device ${serial} is no longer attached`, 3);
    return handle;
  }

  /** Whether anyone ELSE is mid-run. Guards the two whole-server operations — install
   *  (which writes a binary to every device) and device control (which power-cycles
   *  one) — so neither can happen under a running suite. */
  function othersActive(token: string): boolean {
    reapLeases(Date.now());
    return [...leases.entries()].some(([t]) => t !== token);
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
    const { code, error, step, artifacts, logStart } = await handle.exec({
      command: node.command,
      positionals: node.positionals,
      flags: leafToFlags(node),
    });
    err(`[server] ${handle.serial} exec ${node.command} ${node.positionals.join(' ')} → exit ${code} (${Date.now() - t0}ms)`);
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
    // The BOUND driver, never config.driver: after a rebind (device control, or a
    // failover) the startup driver is pinned to a serial that may be gone, and logs
    // are evidence about the run that just failed — serving another device's is a lie.
    // The LEASED device, not a driver captured at startup: reading logs off a device the
    // caller never drove would attribute one phone's output to another's report.
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
    for (let hop = 0; ; hop++) {
      const handle = pool.get(from);
      if (!handle) throw firstError ?? new HttpError(503, `device ${from} is no longer attached`, 3);
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
        quarantineDevice(from, verdict.reason);
        const to = await pickFailoverDevice(from);
        if (!to) {
          const original = firstError instanceof Error ? firstError.message : String(firstError);
          throw new HttpError(500, `${original}${exhaustedNote()}`, 3, change);
        }
        change = { from, to, reason: verdict.reason, retried: true };
        moves++;
        from = to;
        err(`[server] install: retrying on ${to}…`);
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
      if (failed.length) {
        // One artifact, many devices: if it failed everywhere the file is the suspect, so
        // surface the FIRST device's error unchanged rather than a summary that buries it.
        if (failed.length === targets.length) throw failed[0].error;
        throw new HttpError(
          500,
          `install failed on ${failed.map((f) => `${f.serial} (${firstLine((f.error as Error).message)})`).join('; ')}`,
          3,
        );
      }
      const moved = outcomes.filter((o) => o.change);
      for (const m of moved) err(`[server] install: ${m.serial} → ${m.change!.to} (${m.moves} move(s))`);
      err(`[server] install: done on ${pool.serials().join(', ')}`);
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
      try {
        unlinkSync(tmpPath);
      } catch {
        /* upload may have failed before the file existed */
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
   */
  function requireSingleDevice(op: string): void {
    const n = pool.serials().length;
    if (n > 1) {
      throw new HttpError(
        403,
        `this server pools ${n} devices, so '${op}' has no single device to act on. ` +
          'Run one server per device if you need remote device control.',
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
    for (const key of [result.serial, target]) if (key) quarantine.delete(key);

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
      const released = leases.delete(token);
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
      if (othersActive(token)) throw busyError();
      return handleDeviceOp(op, policy, req, res);
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
        config.deviceControl
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
      const reads = await safeReads(handle);
      const body: LeaseResponse = {
        platform: config.platform,
        serial: handle.serial,
        ...(reads ? { reads } : {}),
      };
      sendJson(res, 200, body);
      return;
    }
    if (req.method === 'POST' && path === '/v1/exec') return handleExec(leasedHandle(token), req, res);
    if (req.method === 'POST' && path === '/v1/elements') return handleElements(leasedHandle(token), req, res);
    if (req.method === 'POST' && path === '/v1/logs') return handleLogs(leasedHandle(token), req, res);
    if (req.method === 'POST' && path === '/v1/install') {
      if (!config.allowInstall) {
        throw new HttpError(403, 'install is disabled on this server (start it with --allow-install)', 3);
      }
      // Installing writes a binary to EVERY device, so it cannot happen under someone
      // else's run — otherwise a suite's later lanes would silently swap builds mid-run.
      if (othersActive(token)) throw busyError();
      // …and the installer KEEPS a lease afterwards, so a racing job cannot take a device
      // in the gap between `vk install` and the suite that follows it. The client's own
      // `close()` hands it back, which is what lets install-then-suite chain in one job.
      leaseFor(token);
      return handleInstall(req, res);
    }
    throw new HttpError(404, `unknown endpoint ${req.method} ${path}`);
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    handle(req, res)
      .catch((e) => {
        const mapped =
          e instanceof HttpError
            ? e
            : e instanceof CliError
              ? new HttpError(e.exitCode === 2 ? 400 : 500, e.message, e.exitCode)
              : new HttpError(500, (e as Error).message || 'internal error', 3);
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
        err(`[server] ${req.method} ${(req.url ?? '').split('?')[0]} → ${res.statusCode} (${Date.now() - started}ms)`);
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
  const names = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    const names = String(raw)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
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

/** What `--devices` asked for. Pure — exported for unit tests. */
export interface DevicePoolSpec {
  /** Every usable device of the platform, rather than a named list. */
  all: boolean;
  /** The named serials, when `all` is false. */
  serials: string[];
  /** Platform pinned by the `all-android` / `all-ios` spelling. */
  platform?: Platform;
}

/**
 * Parse `--devices all | all-android | all-ios | <serial>,<serial>`.
 *
 * `all-android` / `all-ios` both SELECT and pin the platform, so the intent is one
 * self-documenting flag rather than `--android --devices all` read as a pair — and,
 * more usefully, so a bare `--devices all` on a Mac with both emulators and simulators
 * attached cannot silently resolve to whichever platform happened to be the default.
 */
export function parseDevicePool(flags: Flags): DevicePoolSpec | undefined {
  const raw = flags['devices'];
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) throw new CliError("--devices needs a value: 'all', 'all-android', 'all-ios', or a comma-separated list of serials.", 2);
  const entries = [...new Set(String(raw).split(',').map((e) => e.trim()).filter(Boolean))];
  if (!entries.length) {
    throw new CliError("--devices needs a value: 'all', 'all-android', 'all-ios', or a comma-separated list of serials.", 2);
  }
  const alls = entries.filter((e) => /^all(-android|-ios)?$/i.test(e));
  if (alls.length && entries.length > 1) {
    throw new CliError(`--devices '${alls[0]}' selects every device, so it cannot be combined with named serials.`, 2);
  }
  if (alls.length) {
    const suffix = /^all(?:-(android|ios))?$/i.exec(alls[0])![1];
    return { all: true, serials: [], ...(suffix ? { platform: suffix.toLowerCase() as Platform } : {}) };
  }
  return { all: false, serials: entries };
}

/** Was a platform named on the command line, as opposed to defaulted? */
function platformWasNamed(flags: Flags): boolean {
  return flagBool(flags, 'ios') || flagBool(flags, 'android') || !!flagStr(flags, 'platform');
}

/**
 * Which serials this server will pool.
 *
 * `all` takes only devices in a usable state — the same predicate `vk devices` applies —
 * so an offline or unauthorized phone never becomes advertised capacity. A NAMED serial
 * that is not attached is fatal rather than skipped: the operator asked for a specific
 * device, and silently serving fewer than requested is how a suite quietly loses a lane.
 */
function poolSerials(platform: Platform, spec: DevicePoolSpec): string[] {
  const attached = getDriver(platform, undefined).listDevices();
  const usable = attached.filter((d) => d.state === 'device').map((d) => d.serial);
  if (spec.all) {
    if (!usable.length) throw new CliError(`--devices: no usable ${platform} device is attached.`, 3);
    return usable;
  }
  const missing = spec.serials.filter((x) => !usable.includes(x));
  if (missing.length) {
    throw new CliError(
      `--devices: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not attached. ` +
        `Usable ${platform} devices: ${usable.length ? usable.join(', ') : '(none)'}`,
      3,
    );
  }
  return spec.serials;
}

export async function cmdServer(positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 0) {
    throw new CliError(`server: unexpected argument '${positionals[0]}'. Usage: verikun server [--bind addr] [--port n] [--auth-key k] [--devices all|a,b] [--allow-install] [--allow-device-control[=names]] [--allow-failover[=serials]|--no-failover] [--allow-unsafe-anonymous]`, 2);
  }
  const poolSpec = parseDevicePool(flags);
  if (poolSpec?.platform && platformWasNamed(flags) && platformFromFlags(flags) !== poolSpec.platform) {
    throw new CliError(
      `--devices all-${poolSpec.platform} contradicts the platform flag (${platformFromFlags(flags)}). Pass one or the other.`,
      2,
    );
  }
  const platform = poolSpec?.platform ?? platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);
  if (poolSpec && flagStr(flags, 'device')) {
    throw new CliError('--devices and --device are alternatives: pass a pool or a single device, not both.', 2);
  }
  const bind = flagStr(flags, 'bind') || '127.0.0.1';
  const port = flagNum(flags, 'port') ?? DEFAULT_PORT;
  const allowInstall = flagBool(flags, 'allow-install');
  const deviceControl = parseDeviceControl(flags);
  // `device` is --device || VERIKUN_DEVICE || ANDROID_SERIAL: an env pin is still a pin.
  const failover = parseFailover(flags, { pinned: device !== undefined });
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
  // Order matters: resolve the SERIAL first, because `preflight()` also throws exit 3
  // for a broken toolchain (probeFailure → envError) and that is NOT deferrable — no
  // client can install idb for us. Only "no device" earns the device-less path; once a
  // device does resolve, preflight runs and its failure is fatal as before.
  //
  // The server owns its device for as long as it listens, so its pid is exact liveness
  // evidence — set before resolving, since that is where the claim is taken.
  setProcessScoped(true);
  let serials: string[] = [];
  try {
    if (poolSpec) {
      serials = poolSerials(platform, poolSpec);
    } else {
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
  // Each device gets a worker thread, and a worker only reports ready once preflight()
  // says its toolchain can actually drive it — so the pool never advertises capacity it
  // cannot serve. One device that will not come up costs its own lane, not the server.
  const pool = await WorkerDevicePool.start(platform, serials);
  if (serials.length && !pool.serials().length && !deviceControl) {
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

  // Track the LIVE devices: a client may boot or swap one after startup, and shutdown
  // has to release the companion on whatever is bound then.
  let live: string[] = pool.serials();
  const server = buildServer({
    platform, pool, authKey, allowInstall, deviceControl, failover: failover.policy,
    onRebind: (s) => { live = s === null ? [] : [s]; },
  });

  return new Promise<number>((resolve, reject) => {
    server.on('error', (e) => reject(new CliError(`server: could not listen on ${bind}:${port} (${(e as Error).message})`, 3)));
    server.listen(port, bind, async () => {
      err(`[server] verikun ${VERSION} listening on http://${bind}:${port}`);
      err(`[server] devices: ${platform} · ${live.length ? live.join(', ') : '(none bound)'}`);
      if (live.length > 1) {
        err(`[server] pooled: ${live.length} devices, one run token leases one device — a parallel`);
        err('[server]         `vk suite --server <url>` sizes itself from this automatically.');
      }
      // Say the read path out loud. It is the difference between a suite that takes 8s and
      // one that takes 43s, and it used to be invisible from both ends (issue #77).
      for (const serial of live) {
        const reads = await safeReads(pool.get(serial));
        if (reads) err(`[server] reads: ${serial} → ${reads.path} (${reads.detail})`);
      }
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
      for (const serial of live) releaseCompanionOn(serial);
      void pool.disposeAll();
      server.close();
      resolve(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
