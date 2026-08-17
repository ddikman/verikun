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
import { claimsEnabled, setProcessScoped, summarize } from './device/claims';
import { assertActionable, chooseTarget, lifecycleFor, restartTarget } from './drivers/lifecycle';
import { err, setOutputQuiet } from './output';
import { DeviceInfo, Driver, HierarchySource, Platform } from './types';
import { FlagSpec, InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import {
  describeError, DeviceListResponse, DeviceOpRequest, DeviceOpResponse,
  ExecRequest, ExecResponse, HealthResponse, LogsRequest, LogsResponse, RpcErrorBody,
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
}

/** An error that already knows its HTTP status + the client-side exit code. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly exitCode: number = status === 400 || status === 404 || status === 413 ? 2 : 3,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

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

  // The ONE piece of server state a request can change, and only via /v1/devices/*.
  // Everything in `config` is startup policy and is never written. Grep `bound =`
  // to find every rebind.
  let bound: { driver: Driver; serial: string | null } = { driver: config.driver, serial: config.serial };

  // Rebuild the driver rather than invalidating a cache: AdbDriver caches BOTH its
  // resolved serial and a pinned `requested` without probing, so an AVD that returns
  // on a different port would leave a permanently dead instance. Always rebind to the
  // CONCRETE serial the lifecycle layer returned — never undefined, which would
  // auto-resolve and could silently latch onto a different attached device.
  const rebind = (serial: string | null): void => {
    bound = serial === null ? { driver: bound.driver, serial: null } : { driver: makeDriver(config.platform, serial), serial };
    config.onRebind?.(serial);
    err(`[server] device: ${config.platform} · ${serial ?? '(none)'}`);
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
    const payload: ExecResponse = {
      code,
      ...(error ? { error: describeError(error) } : {}),
      ...(step ? { step } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts: encodeArtifacts(artifacts) } : {}),
      ...(logStart ? { logStart } : {}),
    };
    sendJson(res, 200, payload);
  }

  async function handleElements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await readBody(req, EXEC_BODY_CAP); // drain (the body is unused; keeps keep-alive sane)
    const elements = bound.driver.getElements(); // CliError(3) on dump failure → 500 below
    sendJson(res, 200, { elements });
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
    const logs = config.driver.getLogs({
      ...(lines !== undefined ? { lines } : {}),
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(appId ? { appId } : {}),
      ...(parsed.scopedOnly ? { scopedOnly: true } : {}),
    });
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
      bound.driver.install(tmpPath);
      err('[server] install: done');
      sendJson(res, 200, { ok: true, bytes: size, sha256: digest });
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
      const reads = safeHierarchySource(config.driver);
      const health: HealthResponse = {
        ok: true,
        version: VERSION,
        platform: config.platform,
        serial: bound.serial,
        installEnabled: config.allowInstall,
        ...(reads ? { reads } : {}),
        deviceControlEnabled: config.deviceControl !== undefined,
        deviceNamingEnabled: (config.deviceControl?.allowedTargets.length ?? 0) > 0,
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
      if (claimsEnabled()) {
        for (const d of seen) {
          const claim = summarize(d.serial);
          if (claim) d.claim = claim;
        }
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
          const body: RpcErrorBody = { error: mapped.message, exitCode: mapped.exitCode };
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

export async function cmdServer(positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 0) {
    throw new CliError(`server: unexpected argument '${positionals[0]}'. Usage: verikun server [--bind addr] [--port n] [--auth-key k] [--allow-install] [--allow-device-control[=names]] [--allow-unsafe-anonymous]`, 2);
  }
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);
  const bind = flagStr(flags, 'bind') || '127.0.0.1';
  const port = flagNum(flags, 'port') ?? DEFAULT_PORT;
  const allowInstall = flagBool(flags, 'allow-install');
  const deviceControl = parseDeviceControl(flags);
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
    driver, platform, serial, authKey, allowInstall, deviceControl,
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
