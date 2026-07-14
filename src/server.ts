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
//    KNOWN_COMMANDS action verbs execute — never `ui`/`log`, never a shell. The
//    server's driver is fixed at startup; client flags can never repoint the device.
//  - /v1/install is a privileged management verb: auth PLUS --allow-install, body
//    streamed to a server-generated temp path (the client supplies only an
//    allowlisted extension — never a path), optional sha256 verification.
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
import { err, setOutputQuiet } from './output';
import { Driver, Platform } from './types';
import { FlagSpec, InvalidPlanError, leafToFlags, validateNode } from './agent/ir';
import { describeError, ExecRequest, ExecResponse, HealthResponse, RpcErrorBody } from './rpc';
import { executeForServer, platformFromFlags, deviceFromFlags } from './cli';
import { VERSION } from './version';

const DEFAULT_PORT = 8391;
const EXEC_BODY_CAP = 1024 * 1024; // 1 MB of JSON is far beyond any leaf command
const INSTALL_BODY_CAP = 512 * 1024 * 1024; // 512 MB app build
// A silent run-token older than this may be taken over by a new one — long enough
// to survive a client-side compile/repair pause, short enough that a crashed
// caller doesn't wedge the device.
const LOCK_IDLE_MS = 5 * 60 * 1000;

interface ServerConfig {
  driver: Driver;
  platform: Platform;
  serial: string;
  /** undefined = --allow-unsafe-anonymous (auth disabled deliberately). */
  authKey?: string;
  allowInstall: boolean;
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

export function buildServer(config: ServerConfig): Server {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

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
    const { code, error, step, artifacts } = await executeForServer(
      node.command,
      node.positionals,
      leafToFlags(node),
      config.driver,
      config.platform,
    );
    err(`[server] exec ${node.command} ${node.positionals.join(' ')} → exit ${code} (${Date.now() - t0}ms)`);
    const payload: ExecResponse = {
      code,
      ...(error ? { error: describeError(error) } : {}),
      ...(step ? { step } : {}),
      ...(artifacts && Object.keys(artifacts).length ? { artifacts: encodeArtifacts(artifacts) } : {}),
    };
    sendJson(res, 200, payload);
  }

  async function handleElements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await readBody(req, EXEC_BODY_CAP); // drain (the body is unused; keeps keep-alive sane)
    const elements = config.driver.getElements(); // CliError(3) on dump failure → 500 below
    sendJson(res, 200, { elements });
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
      config.driver.install(tmpPath);
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && path === '/v1/health') {
      // Unauthenticated preflight — but if the caller DID send a key, verify it, so
      // a client with a wrong key fails fast at ping instead of at its first step.
      if (config.authKey && req.headers.authorization && !authorized(req)) {
        throw new HttpError(401, 'invalid auth key');
      }
      const health: HealthResponse = {
        ok: true,
        version: VERSION,
        platform: config.platform,
        serial: config.serial,
        installEnabled: config.allowInstall,
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
    if (req.method === 'POST' && path === '/v1/exec') return deviceEndpoint(() => handleExec(req, res));
    if (req.method === 'POST' && path === '/v1/elements') return deviceEndpoint(() => handleElements(req, res));
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

export async function cmdServer(positionals: string[], flags: Flags): Promise<number> {
  if (positionals.length > 0) {
    throw new CliError(`server: unexpected argument '${positionals[0]}'. Usage: verikun server [--bind addr] [--port n] [--auth-key k] [--allow-install] [--allow-unsafe-anonymous]`, 2);
  }
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);
  const bind = flagStr(flags, 'bind') || '127.0.0.1';
  const port = flagNum(flags, 'port') ?? DEFAULT_PORT;
  const allowInstall = flagBool(flags, 'allow-install');
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

  // Build the ONE driver the server will ever use, and fail fast (exit 2/3) if no
  // device resolves — before binding a port.
  const driver = getDriver(platform, device);
  const serial = driver.resolvedSerial();

  // Handlers print "tapped …" confirmations via out(); a server's stdout is not a
  // data channel, so silence them — request logging goes to stderr instead.
  setOutputQuiet(true);

  const server = buildServer({ driver, platform, serial, authKey, allowInstall });

  return new Promise<number>((resolve, reject) => {
    server.on('error', (e) => reject(new CliError(`server: could not listen on ${bind}:${port} (${(e as Error).message})`, 3)));
    server.listen(port, bind, () => {
      err(`[server] verikun ${VERSION} listening on http://${bind}:${port}`);
      err(`[server] device: ${platform} · ${serial}`);
      err(`[server] install endpoint: ${allowInstall ? 'ENABLED (--allow-install)' : 'disabled (pass --allow-install to accept builds)'}`);
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
      server.close();
      resolve(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
