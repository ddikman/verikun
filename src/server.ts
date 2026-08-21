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
import { DeviceInfo, Driver, HierarchySource, Platform } from './types';
import { FlagSpec, InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import {
  describeError, DeviceChange, DeviceListResponse, DeviceOpRequest, DeviceOpResponse,
  ExecRequest, ExecResponse, HealthResponse, InstallResponse, LogsRequest, LogsResponse, RpcErrorBody,
} from './rpc';
import { executeForServer, platformFromFlags, deviceFromFlags } from './cli';
import { VERSION } from './version';

/**
 * A driver's read path, or null when the backend has no opinion (iOS reads through idb, one
 * way only) or the probe failed.
 *
 * Best-effort on purpose. It is reported on `/v1/health`, which is also how a client checks
 * the server is reachable at all — a companion probe must never be the reason that answer
 * cannot be given.
 */
function safeHierarchySource(driver: Driver): HierarchySource | null {
  try {
    return driver.hierarchySource?.() ?? null;
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
  // --- initial device binding ---
  driver: Driver;
  /** null = started with NO device bound (only reachable with deviceControl). */
  serial: string | null;
  /** Called whenever /v1/devices/* changes the binding, so the owner can track which
   *  device is live — shutdown must release the companion on the CURRENT device, not
   *  whichever one happened to be bound at startup. */
  onRebind?: (serial: string | null) => void;
  // --- seams (tests) ---
  lifecycle?: ServerLifecycle;
  makeDriver?: (platform: Platform, device: string) => Driver;
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
  const makeDriver = config.makeDriver ?? getDriver;
  const claimOpts = config.claimOpts ?? {};
  const claimEnv = claimOpts.env ?? process.env;

  // The ONE piece of server state a request can change, and only via /v1/devices/*.
  // Everything in `config` is startup policy and is never written. Grep `bound =`
  // to find every rebind.
  let bound: { driver: Driver; serial: string | null } = { driver: config.driver, serial: config.serial };

  // Rebuild the driver rather than invalidating a cache: AdbDriver caches BOTH its
  // resolved serial and a pinned `requested` without probing, so an AVD that returns
  // on a different port would leave a permanently dead instance. Always rebind to the
  // CONCRETE serial the lifecycle layer returned — never undefined, which would
  // auto-resolve and could silently latch onto a different attached device.
  //
  // `driver` is passed when the caller has ALREADY built and probed one (failover), so
  // the instance that answered the probe is the instance we go on to use.
  const rebind = (serial: string | null, driver?: Driver): void => {
    bound =
      serial === null
        ? { driver: bound.driver, serial: null }
        : { driver: driver ?? makeDriver(config.platform, serial), serial };
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
   * Move to another healthy device. Returns the serial moved to, or null when none
   * remains (which is not an error here — the caller reports the ORIGINAL failure).
   *
   * The walk order is load-bearing: claim-new -> probe -> commit -> release-old.
   * Releasing the old claim first would leave this server bound to a device it no longer
   * holds, and another job on the host would take it mid-request.
   */
  const pickFailoverDevice = (): string | null => {
    const policy = config.failover;
    if (!policy) return null;
    const from = bound.serial;
    // lifecycle.list is the SAME source /v1/devices answers from, so what a client can
    // see and where the server will actually go cannot drift. bound.driver is not: it
    // may be pointed at a corpse.
    let seen: DeviceInfo[] = [];
    try {
      seen = lifecycle.list(config.platform);
    } catch (e) {
      err(`[server] failover: cannot enumerate devices (${firstLine((e as Error).message)})`);
      return null;
    }
    const candidates = failoverCandidates(seen, {
      exclude: [...(from ? [from] : []), ...quarantine.keys()],
      allow: policy.allowedTargets,
    });
    if (!candidates.length) return null;
    err(`[server] failover: ${candidates.length} candidate(s) — ${candidates.map((d) => d.serial).join(', ')}`);

    for (const c of candidates) {
      // Claim BEFORE probing: deciding "this one is free" and then taking it is the
      // read-then-write race device/claims.ts exists to prevent.
      if (claimsEnabled(claimEnv) && !claimDevice(c.serial, config.platform, claimOpts).ok) {
        err(`[server] failover: ${c.serial} is held by another job — skipping`);
        continue;
      }
      const driver = makeDriver(config.platform, c.serial);
      try {
        // ONE probe per candidate, against TWO for the bound device on the unknown path.
        // Deliberate: a false negative here just moves to the next candidate, while a
        // false positive there quarantines a device that was fine.
        driver.preflight();
      } catch (e) {
        if (claimsEnabled(claimEnv)) releaseClaim(c.serial, { ...claimOpts, mineOnly: true });
        quarantineDevice(c.serial, `probe failed (${firstLine((e as Error).message)})`);
        continue;
      }
      err(`[server] failover: ${c.serial} probe ok — moving`);
      if (from) {
        // Hand back the old device's ONE UiAutomation connection, or it stays held for
        // up to 15 minutes with nothing on the host able to explain why. Never throws.
        releaseCompanionOn(from);
        if (claimsEnabled(claimEnv)) releaseClaim(from, { ...claimOpts, mineOnly: true });
      }
      rebind(c.serial, driver);
      return c.serial;
    }
    return null;
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
   * Is the bound device actually gone? Two probes a second apart, because that gap is the
   * only thing separating a USB re-enumeration or a mid-`launch --clear` gap from a dead
   * box — and quarantining a healthy device is the expensive mistake here. Returns the
   * reason when dead, undefined when it was a blip.
   */
  const boundDeviceIsDead = async (): Promise<string | undefined> => {
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(PROBE_RETRY_MS);
      try {
        bound.driver.preflight();
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
   * before it ran on THIS device; device B's app is at whatever an earlier run left
   * behind. Replaying would either find something matching and go green (a false green
   * that ships a regression) or wake the repair model against the wrong screen. So the
   * failing operation still fails, honestly, with the ORIGINAL device's error — and it is
   * the NEXT request that benefits from the move.
   *
   * Returns the change to report, or undefined when we stayed put.
   */
  const considerFailover = async (e: unknown, what: string): Promise<DeviceChange | undefined> => {
    if (!config.failover) return undefined;
    const verdict = classifyFailure(e);
    let reason = verdict.reason;
    if (!verdict.move) {
      // Only an unrecognised exit 3 earns a probe; `transient` and `toolchain` set
      // probe:false precisely so a mid-launch gap or a missing adb cannot become a move.
      if (!verdict.probe) return undefined;
      const dead = await boundDeviceIsDead();
      if (!dead) return undefined; // a blip — the test rerun is the right answer, not a new device
      reason = dead;
      noteVerdict({ ...verdict, move: true }, e, what);
    }
    err(`[server] ${what}: FAILED on ${bound.serial ?? '(none)'} — ${reason}`);
    const from = bound.serial ?? '(none)';
    quarantineDevice(bound.serial, reason);
    const to = pickFailoverDevice();
    if (!to) {
      err(`[server] failover: nothing healthier to move to — staying on ${from}`);
      return undefined;
    }
    return { from, to, reason, retried: false };
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!config.authKey) return true; // --allow-unsafe-anonymous
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return false;
    // Fixed-width digests make the comparison length-safe as well as timing-safe.
    return timingSafeEqual(sha(m[1]), sha(config.authKey));
  };

  // One active run-token owns the device; see LOCK_IDLE_MS for takeover.
  let lock: { token: string; lastSeenMs: number } | null = null;
  const acquireLock = (token: string): boolean => {
    const now = Date.now();
    if (lock && lock.token !== token) {
      if (now - lock.lastSeenMs < LOCK_IDLE_MS) return false;
      err(`[server] device lock: idle run ${lock.token.slice(0, 8)}… taken over by ${token.slice(0, 8)}…`);
    }
    lock = { token, lastSeenMs: now };
    return true;
  };

  // The device can serve one interaction at a time — serialize the device endpoints
  // through a promise chain (requests queue in arrival order).
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  async function handleExec(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const { code, error, step, artifacts, logStart } = await executeForServer(
      node.command,
      node.positionals,
      leafToFlags(node),
      bound.driver,
      config.platform,
    );
    err(`[server] exec ${node.command} ${node.positionals.join(' ')} → exit ${code} (${Date.now() - t0}ms)`);
    // The step keeps its own verdict whatever we decide here: the error below is the one
    // THIS device produced, never a replay's. Only the binding moves.
    const deviceChanged = code !== 0 && error ? await considerFailover(error, 'exec') : undefined;
    const payload: ExecResponse = {
      code,
      ...(error ? { error: describeError(error) } : {}),
      ...(deviceChanged ? { deviceChanged } : {}),
      ...(step ? { step } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts: encodeArtifacts(artifacts) } : {}),
      ...(logStart ? { logStart } : {}),
    };
    sendJson(res, 200, payload);
  }

  async function handleElements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await readBody(req, EXEC_BODY_CAP); // drain (the body is unused; keeps keep-alive sane)
    try {
      const elements = bound.driver.getElements(); // CliError(3) on dump failure → 500 below
      sendJson(res, 200, { elements });
    } catch (e) {
      // Move if the device is at fault, but NEVER answer with the new device's screen:
      // this is the engine's `if-present` guard input and its repair context, and a
      // hierarchy from somewhere else is worse than an error. The client's connect probe
      // re-asks after a reported move — see remote.ts's preflight.
      const deviceChanged = await considerFailover(e, 'read');
      if (!deviceChanged) throw e;
      throw new HttpError(500, (e as Error).message, e instanceof CliError ? e.exitCode : 3, deviceChanged);
    }
  }

  async function handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const logs = bound.driver.getLogs({
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
  function installWithFailover(tmpPath: string): { change?: DeviceChange; moves: number } {
    let change: DeviceChange | undefined;
    let moves = 0;
    let firstError: unknown;
    for (let hop = 0; ; hop++) {
      const from = bound.serial ?? '(none)';
      try {
        bound.driver.install(tmpPath);
        return { change, moves };
      } catch (e) {
        if (firstError === undefined) firstError = e;
        const verdict = classifyInstallFailure(e);
        err(`[server] install: FAILED on ${from} — ${verdict.reason}`);
        noteVerdict(verdict, e, 'install');
        // The artifact is broken / the caller is wrong / failover is off / we are out of
        // hops: report the first failure unchanged, exactly as before this feature.
        if (!verdict.move || !config.failover || hop >= MAX_FAILOVER_HOPS) throw firstError;
        quarantineDevice(bound.serial, verdict.reason);
        const to = pickFailoverDevice();
        if (!to) {
          const original = firstError instanceof Error ? firstError.message : String(firstError);
          throw new HttpError(500, `${original}${exhaustedNote()}`, 3, change);
        }
        change = { from, to, reason: verdict.reason, retried: true };
        moves++;
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
      err(`[server] install: received ${size} bytes (.${ext}), installing…`);
      const { change, moves } = installWithFailover(tmpPath);
      err(`[server] install: done${change ? ` on ${change.to} (after ${moves} move${moves === 1 ? '' : 's'})` : ''}`);
      const body: InstallResponse = { ok: true, bytes: size, sha256: digest, ...(change ? { deviceChanged: change } : {}) };
      sendJson(res, 200, body);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* upload may have failed before the file existed */
      }
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
      target = bound.serial ?? policy.allowedTargets[0];
    }
    // `stop` acts on the binding, so answer its own precondition before the
    // start/restart "what would I even boot?" one, or a stop against a device-less
    // server reports a confusing "no default startable target".
    if (op === 'stop' && bound.serial === null) {
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
      rebind(null);
      result = { ok: true, platform: config.platform, serial: null, changed: true, durationMs: Date.now() - t0 };
    } else if (op === 'restart') {
      if (wipe) err('[server] device: WIPE requested — the device\'s data will be erased');
      const { serial } = await lifecycle.restart(config.platform, target, opts);
      rebind(serial);
      result = { ok: true, platform: config.platform, serial, changed: true, durationMs: Date.now() - t0 };
    } else {
      if (wipe) err('[server] device: WIPE requested — the device\'s data will be erased');
      const { serial, started } = await lifecycle.start(config.platform, target, opts);
      if (started || serial !== bound.serial) rebind(serial);
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
      const reads = bound.serial === null ? null : safeHierarchySource(bound.driver);
      const health: HealthResponse = {
        ok: true,
        version: VERSION,
        platform: config.platform,
        serial: bound.serial,
        installEnabled: config.allowInstall,
        ...(reads ? { reads } : {}),
        deviceControlEnabled: config.deviceControl !== undefined,
        deviceNamingEnabled: (config.deviceControl?.allowedTargets.length ?? 0) > 0,
        failoverEnabled: config.failover !== undefined,
        // Omitted when empty, so a CI job can assert on its ABSENCE. Unauthenticated
        // like the rest of health, which is what makes "is the pool ok?" answerable
        // without holding a run token.
        ...(quarantine.size ? { quarantined: quarantineList() } : {}),
        // Derived from `serial` right here, so the two can never drift apart.
        deviceState: bound.serial === null ? 'none' : 'ready',
      };
      sendJson(res, 200, health);
      return;
    }

    if (!authorized(req)) throw new HttpError(401, 'missing or invalid auth key');
    const token = String(req.headers['x-verikun-run'] ?? '(anonymous)');
    const deviceEndpoint = (fn: () => Promise<void>): Promise<void> =>
      serialize(async () => {
        if (!acquireLock(token)) {
          throw new HttpError(409, 'device is locked by another active run — retry when it finishes');
        }
        await fn();
      });

    if (req.method === 'POST' && path === '/v1/release') {
      // A finished client frees its lock so the NEXT command (a fresh run token)
      // proceeds immediately instead of waiting out the idle takeover. Serialized
      // so it lands after any in-flight request; only the holder can release.
      return serialize(async () => {
        await readBody(req, EXEC_BODY_CAP); // drain
        const released = lock !== null && lock.token === token;
        if (released) lock = null;
        sendJson(res, 200, { ok: true, released });
      });
    }
    // Device control. Every MUTATION takes the full device lock: a restart while
    // another run holds the device is sabotage (→ 409), while the recovery case still
    // works because the HOLDER passes its own run token, which acquireLock accepts and
    // refreshes. You may power-cycle your own device; nobody else may.
    if (req.method === 'POST' && (path === '/v1/devices/start' || path === '/v1/devices/restart' || path === '/v1/devices/stop')) {
      const policy = requireDeviceControl();
      const op = path.slice('/v1/devices/'.length) as 'start' | 'restart' | 'stop';
      return deviceEndpoint(() => handleDeviceOp(op, policy, req, res));
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
          ? seen.filter((d) => d.serial === bound.serial || policy.allowedTargets.includes(d.name ?? ''))
          : seen.filter((d) => d.serial === bound.serial),
        startable: policy.allowedTargets,
        bound: bound.serial,
      };
      sendJson(res, 200, body);
      return;
    }

    // A deviceless server must not silently fail every command. In-memory check, so
    // the normal path is untouched. NOTE this fires only when the server NEVER
    // resolved a device — one that DIED mid-run still has a non-null binding and keeps
    // today's behaviour (the exec returns exit 3 in its body).
    if (
      bound.serial === null &&
      (path === '/v1/exec' || path === '/v1/elements' || path === '/v1/logs' || path === '/v1/install')
    ) {
      throw new HttpError(
        503,
        config.deviceControl
          ? 'no device is attached to this verikun server — run `vk devices start --server <url>` to boot one'
          : 'no device is attached to this verikun server',
        3,
      );
    }

    if (req.method === 'POST' && path === '/v1/exec') return deviceEndpoint(() => handleExec(req, res));
    if (req.method === 'POST' && path === '/v1/elements') return deviceEndpoint(() => handleElements(req, res));
    if (req.method === 'POST' && path === '/v1/logs') return deviceEndpoint(() => handleLogs(req, res));
    if (req.method === 'POST' && path === '/v1/install') {
      if (!config.allowInstall) {
        throw new HttpError(403, 'install is disabled on this server (start it with --allow-install)', 3);
      }
      return deviceEndpoint(() => handleInstall(req, res));
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

export async function cmdServer(positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 0) {
    throw new CliError(`server: unexpected argument '${positionals[0]}'. Usage: verikun server [--bind addr] [--port n] [--auth-key k] [--allow-install] [--allow-device-control[=names]] [--allow-failover[=serials]|--no-failover] [--allow-unsafe-anonymous]`, 2);
  }
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);
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
  const driver = getDriver(platform, device);
  let serial: string | null = null;
  try {
    serial = driver.resolvedSerial();
    // Both drivers TRUST a pinned --device without probing (adb.ts / ios.ts), so
    // `vk server --device X` already starts "bound" to a device that may not exist.
    // Verify it here, or the device-less path is never entered and every request
    // fails with nothing a client could do about it.
    if (deviceControl && device && !driver.listDevices().some((d) => d.serial === serial)) {
      err(`[server] --device ${serial} is not attached — starting with NO device bound`);
      serial = null;
    }
  } catch (e) {
    // Ambiguity (exit 2) is an OPERATOR error — booting another device makes it
    // worse. Only "no device" (exit 3) is deferrable.
    const code = e instanceof CliError ? e.exitCode : 3;
    if (!deviceControl || code !== 3) throw e;
    err(`[server] no device resolved (${(e as Error).message})`);
    err('[server] listening anyway — device control is enabled. Boot one with:');
    err('[server]     vk devices start --server <url>');
    serial = null;
  }
  // A device resolved, so the toolchain must be able to drive it — otherwise the
  // server listens on a box with no idb and 500s every /v1/exec.
  if (serial !== null) driver.preflight();
  if (deviceControl?.allowedTargets.length) {
    // Typo detection only — non-fatal, since the tooling may be missing entirely.
    const known = new Set(realLifecycle.list(platform).map((d) => d.name).filter(Boolean));
    const unknown = deviceControl.allowedTargets.filter((t) => !known.has(t));
    if (unknown.length) err(`[server] WARNING: --allow-device-control names no such device: ${unknown.join(', ')}`);
  }

  // Handlers print "tapped …" confirmations via out(); a server's stdout is not a
  // data channel, so silence them — request logging goes to stderr instead.
  setOutputQuiet(true);

  // Track the LIVE binding: a client may boot or swap the device after startup, and
  // shutdown has to release the companion on whatever is bound then.
  let boundSerial: string | null = serial;
  const server = buildServer({
    driver, platform, serial, authKey, allowInstall, deviceControl, failover: failover.policy,
    onRebind: (s) => { boundSerial = s; },
  });

  return new Promise<number>((resolve, reject) => {
    server.on('error', (e) => reject(new CliError(`server: could not listen on ${bind}:${port} (${(e as Error).message})`, 3)));
    server.listen(port, bind, () => {
      err(`[server] verikun ${VERSION} listening on http://${bind}:${port}`);
      err(`[server] device: ${platform} · ${serial ?? '(none bound)'}`);
      // Say the read path out loud. It is the difference between a suite that takes 8s and
      // one that takes 43s, and it used to be invisible from both ends (issue #77).
      const reads = serial === null ? null : safeHierarchySource(driver);
      if (reads) err(`[server] reads: ${reads.path} (${reads.detail})`);
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
      if (boundSerial) releaseCompanionOn(boundSerial);
      server.close();
      resolve(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
