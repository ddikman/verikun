import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { waitWindowMs, parseDuration } from '../commands/auto-wait';
import { deviceWaitMs } from '../suite';
// The remote execution backend: `vk ai/suite/install --server <url>` run their
// device work through a `vk server` sitting next to the device, over HTTP+JSON
// (Node's native HTTP clients — no SDK, zero runtime deps). One validated leaf command =
// ONE round-trip: the server keeps the whole auto-wait/dump loop on its side.
//
// The step detail each exec produces (selector, tier, resolved element, failure
// evidence) comes back in the response and is handed to `onStep`, which splices it
// into the CALLER's local run — so a remote run archives a report identical to a
// local one. Recording stays a caller concern: this module never touches ./.verikun.

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname } from 'node:path';
import { ServerUnreachableError, CliError, NoFreeDeviceError, RunEvictedError } from '../errors';
import { REMOTE_INSTALL_TIMEOUT_MS } from '../install-timeouts';
import { err } from '../output';
import type { Element } from '../types';
import type { RunStep } from '../run';
import {
  ExecBackend,
  ExecRequest,
  ExecResponse,
  ElementsResponse,
  DeviceListResponse,
  DeviceOpRequest,
  DeviceOpResponse,
  HealthResponse,
  InstallResponse,
  InstallSkip,
  LeaseResponse,
  LogsResponse,
  RpcErrorBody,
  rebuildError,
} from '../rpc';

export interface RemoteOpts {
  /** Server base URL, e.g. http://127.0.0.1:8391 (a trailing '/' is tolerated). */
  url: string;
  authKey?: string;
  /** Receives each exec'd step + its artifact buffers for splicing into the local run.
   *  `logStart` is the server's device-clock marker (optional on older servers). */
  onStep?: (step: RunStep, artifacts: Record<string, Buffer>, logStart?: string) => void;
  /** Devices a pooled server could not install this build onto, and which therefore left
   *  its pool. The caller keeps the list,
   *  because `Driver.install` returns void and this is remote-only by nature. */
  onInstallSkipped?: (skipped: InstallSkip[]) => void;
}

// Caller-owned ceilings, enforced by node:http for uploads and responses alike.
const HEALTH_TIMEOUT_MS = 10_000;
const ELEMENTS_TIMEOUT_MS = 150_000;
const DEVICE_LIST_TIMEOUT_MS = 150_000;
const DEVICE_START_TIMEOUT_MS = 6 * 60_000;
const DEVICE_STOP_TIMEOUT_MS = 150_000;

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * A dependency-free request path whose caller-owned timeout covers BOTH upload and response.
 *
 * Global fetch cannot wait past undici's fixed 300s header/body ceilings. An install may
 * legitimately need 15 minutes, so it uses Node's native protocol clients instead of claiming
 * a budget the transport cannot honor. Buffering the response preserves the Response boundary
 * used below; install responses are small JSON descriptors, never artifacts.
 */
function requestWithNodeHttp(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: Buffer | string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const endpoint = new URL(url);
  const send = endpoint.protocol === 'http:' ? httpRequest : endpoint.protocol === 'https:' ? httpsRequest : null;
  if (!send) return Promise.reject(new Error(`unsupported server protocol '${endpoint.protocol}'`));
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const requestHeaders = {
    ...headers,
    ...(payload ? { 'content-length': String(payload.byteLength) } : {}),
  };

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const req = send(endpoint, { method, headers: requestHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('error', (e) => finish(() => reject(e)));
      res.on('aborted', () => finish(() => reject(new Error('the server aborted its response'))));
      res.on('end', () => {
        const status = res.statusCode ?? 500;
        finish(() => resolve(new Response(Buffer.concat(chunks), { status })));
      });
    });
    req.on('error', (e) => finish(() => reject(e)));
    timer = setTimeout(() => {
      const timeout = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      req.destroy(timeout);
    }, timeoutMs);
    timer.unref?.();
    req.end(payload);
  });
}

/**
 * Turn a non-2xx into the error the caller sees.
 *
 * The 401/409/503 arms come FIRST and never rebuild a driver error: those describe the
 * TRANSPORT (wrong key, device leased, nothing attached), not something a driver threw, so
 * there is no device-error identity to restore and their wording is what a user acts on.
 * Two of them do carry a class of their own, because a parallel suite has to act on the
 * difference (#147) — both still exit 3:
 *
 *  - on the LEASE route (`opts.lease`), 409 and 503 are `NoFreeDeviceError`: the run never
 *    started. The route decides, not the body — every run mints a fresh token, so a lease can
 *    be refused but never evicted.
 *  - elsewhere, a 409 the server tagged `RunEvictedError` is one: the run lost its device
 *    part-way. That is the ONLY kind a 409 honours. Anything else a body carries is ignored,
 *    and an untagged 409 (an older server) stays the plain error it always was.
 *
 * Everything else prefers the server's `errorKind`. That field is what stops a `--server` run
 * reading a mid-launch `NoWindowError` as a fatal environment error: the class survives the
 * worker→main hop server-side, and this is where it used to be replaced by an anonymous
 * `CliError` (issue #80). No field — an older server, or a failure with no class worth
 * naming — falls through to exactly the previous behaviour.
 */
export function describeStatus(status: number, body: RpcErrorBody | null, url: string, opts: { lease?: boolean } = {}): Error {
  const detail = body?.error ? `: ${body.error}` : '';
  if (status === 401) {
    return new CliError(`verikun server rejected the auth key (401)${detail}. Check --auth-key / VERIKUN_SERVER_AUTH_KEY.`, 3);
  }
  if (status === 409) {
    const busy = `verikun server device is busy (409)${detail || ' — another run holds the device; retry when it finishes'}.`;
    if (body?.errorKind === 'RunEvictedError') return new RunEvictedError(`verikun server ended this run (409)${detail}.`);
    if (opts.lease) return new NoFreeDeviceError(busy);
    return new CliError(busy, 3);
  }
  if (status === 503) {
    const none = `verikun server has no device attached (503)${detail}.`;
    return opts.lease ? new NoFreeDeviceError(none) : new CliError(none, 3);
  }
  // The server sends the intended exit code (usage 2 / env 3) in the body; fall
  // back on the HTTP class when it didn't.
  const exitCode = body?.exitCode ?? (status === 400 || status === 404 || status === 413 ? 2 : 3);
  if (body?.errorKind) {
    // The server's own message, NOT the `verikun server error 500 at <url>` wrapper: this is
    // a device error that happens to have travelled, and it reads (and matches) the same as
    // the local one. The same shape /v1/exec's 200-with-descriptor path already produces.
    return rebuildError({ kind: body.errorKind, name: body.errorKind, message: body.error, exitCode });
  }
  return new CliError(`verikun server error ${status} at ${url}${detail}`, exitCode);
}

/**
 * Why the transport failed, in words an operator can act on. PURE — exported for the tests.
 *
 * The undici arm is the one that earns its keep. `fetch` reports its own header/body
 * timeouts as a bare `TypeError: fetch failed` with the real cause one level down, and that
 * string is indistinguishable from a server that is genuinely unreachable — which is how a
 * five-minute install came to look like a dead phone, and how a lane came to be retired for
 * it. Say which clock ran out, and say whose it was.
 */
export function transportReason(e: unknown, timeoutMs: number): string {
  const ex = e as { name?: string; message?: string; cause?: { code?: string } };
  if (ex?.name === 'AbortError') return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  return ex?.message ?? String(e);
}

async function readBody<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

class RemoteTransport {
  private readonly base: string;
  /** One token per backend = one logical run holding the server's device lock. */
  readonly runToken = randomUUID();
  private holdWorker?: Worker;

  constructor(private readonly opts: RemoteOpts) {
    this.base = trimUrl(opts.url);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'x-verikun-run': this.runToken, ...(process.env.VERIKUN_AVOID_DEVICE ? { 'x-verikun-avoid': process.env.VERIKUN_AVOID_DEVICE } : {}), ...extra };
    if (this.opts.authKey) h.authorization = `Bearer ${this.opts.authKey}`;
    return h;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: Buffer | string | undefined, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<T> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      const idempotent = method === 'GET' || ['/v1/elements', '/v1/logs', '/v1/release'].includes(path);
      const headers = this.headers({ ...extraHeaders, 'x-verikun-deadline-ms': String(Math.max(60_000, timeoutMs - 5000)) });
      try { res = await requestWithNodeHttp(url, method, headers, body, timeoutMs); }
      catch (e) {
        if (!idempotent || !/ECONNRESET|socket hang up/.test((e as Error).message + (e as NodeJS.ErrnoException).code)) throw e;
        res = await requestWithNodeHttp(url, method, headers, body, timeoutMs);
      }
    } catch (e) {
      throw new ServerUnreachableError(`cannot reach verikun server at ${url} (${transportReason(e, timeoutMs)})`);
    }
    if (!res.ok) {
      const body = await readBody<RpcErrorBody>(res);
      const error = describeStatus(res.status, body, url, { lease: path === '/v1/lease' });
      throw error;
    }
    const parsed = await readBody<T>(res);
    if (parsed === null) throw new CliError(`verikun server at ${url} returned a non-JSON response`, 3);
    return parsed;
  }

  hold(waitMs: number): Promise<LeaseResponse> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'lease-heartbeat.js'), { workerData: {
        url: `${this.base}/v1/lease`, timeoutMs: waitMs + 120_000,
        headers: this.headers({ 'x-verikun-hold': '1', 'x-verikun-wait-ms': String(waitMs) }),
      } });
      this.holdWorker = worker;
      let acquired = false;
      worker.on('message', m => {
        if (m.kind === 'leased') { acquired = true; worker.unref(); resolve(m.body as LeaseResponse); }
        else if (m.kind === 'status') reject(describeStatus(m.status, m.body, this.base, { lease: true }));
        else if (m.kind === 'error') {
          if (!acquired) reject(new ServerUnreachableError(`cannot hold verikun server lease: ${m.message}`));
        }
      });
      worker.on('error', e => { if (!acquired) reject(new ServerUnreachableError(e.message)); });
      worker.on('exit', code => { if (!acquired) reject(new ServerUnreachableError(`lease worker exited (${code})`)); });
    });
  }
  closeHold(): void { this.holdWorker?.postMessage('close'); this.holdWorker = undefined; }

  postJson<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
    return this.request<T>('POST', path, JSON.stringify(payload), timeoutMs, { 'content-type': 'application/json' });
  }

  /** Best-effort: give the device lock back. Closing the held stream releases ownership independently. */
  async release(): Promise<void> {
    this.closeHold();
    try {
      await this.postJson<{ ok: boolean }>('/v1/release', {}, HEALTH_TIMEOUT_MS);
    } catch {
      /* the hold closes independently of this best-effort request */
    }
  }
}

/** GET /v1/health — the `--server` preflight. Reachability, the server's platform +
 *  serial (which become the run's context), and — when a key is supplied — an auth
 *  check, so a bad key fails fast here instead of at the first step. */
export async function pingServer(opts: RemoteOpts): Promise<HealthResponse> {
  const t = new RemoteTransport(opts);
  const health = await t.request<HealthResponse>('GET', '/v1/health', undefined, HEALTH_TIMEOUT_MS);
  if (!health.ok || !health.platform) {
    throw new CliError(`'${trimUrl(opts.url)}' does not look like a verikun server (unexpected /v1/health payload).`, 3);
  }
  requireServerProtocol(health);
  return health;
}

export function requireServerProtocol(health: HealthResponse): void {
  if (health.leaseHold !== 1 || health.deviceHealth !== 1 || !Array.isArray(health.deviceStates))
    throw new CliError('this client requires a server with held leases and device supervision; upgrade the server to verikun 1.0 or later', 3);
}

/**
 * What a `vk server` is serving, and what it has ruled out, in one line from one
 * `/v1/health`. Carried on every "no free device" so the reader learns WHICH phone left and
 * the server's own reason, not the lane slot (`host:port#1`) that happened to notice (#147).
 * A device the server shed keeps its quarantine, which is what makes it nameable here.
 */
export function poolNote(health: HealthResponse): string {
  const serving = health.devices ?? (health.serial ? [health.serial] : []);
  const count = health.capacity ?? serving.length;
  const out = serving.length ? ` (${serving.join(', ')})` : '';
  const ruledOut = health.quarantined?.length
    ? `; ruled out: ${health.quarantined.map((q) => `${q.serial} (${q.reason})`).join(', ')}`
    : '';
  return `pool: ${count} serving${out}${ruledOut}`;
}

/**
 * POST /v1/devices/{start,restart,stop}. Standalone beside pingServer rather than on
 * the ExecBackend seam: that seam is the engine's DEVICE WORK (exec/getElements/
 * install/reset), and adding administration to it would oblige the local backend to
 * implement a verb nothing in the engine ever calls.
 */
export async function remoteDeviceOp(
  opts: RemoteOpts,
  op: 'start' | 'restart' | 'stop',
  body: DeviceOpRequest = {},
): Promise<DeviceOpResponse> {
  const t = new RemoteTransport(opts);
  const timeout = op === 'stop' ? DEVICE_STOP_TIMEOUT_MS : DEVICE_START_TIMEOUT_MS;
  try {
    return await t.postJson<DeviceOpResponse>(`/v1/devices/${op}`, body, timeout);
  } finally {
    // Administrative calls hold no execution lease; release is idempotent.
    await t.release();
  }
}

/** GET /v1/devices — what the server can see and what it will boot on request. */
export async function remoteDeviceList(opts: RemoteOpts): Promise<DeviceListResponse> {
  const t = new RemoteTransport(opts);
  return t.request<DeviceListResponse>('GET', '/v1/devices', undefined, DEVICE_LIST_TIMEOUT_MS);
}

function decodeArtifacts(encoded: Record<string, string> | undefined): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [rel, b64] of Object.entries(encoded ?? {})) out[rel] = Buffer.from(b64, 'base64');
  return out;
}

/** An ExecBackend that also knows which device the server gave this run. */
export interface RemoteBackend extends ExecBackend {
  /**
   * Claim (or re-confirm) this run's device.
   *
   * The transport's run token IS the lease key, so this needs no argument and is
   * idempotent — and, crucially, it must be called on the BACKEND's transport rather
   * than a fresh one: `pingServer` mints its own token, so a lease taken there would
   * belong to nobody. The server must support streaming held leases.
   */
  lease(): Promise<LeaseResponse | null>;
}

export function createRemoteBackend(opts: RemoteOpts, health: HealthResponse): RemoteBackend {
  requireServerProtocol(health);
  const t = new RemoteTransport(opts);

  const execRaw = async (req: ExecRequest, record: boolean): Promise<{ code: number; error?: Error }> => {
    const res = await t.postJson<ExecResponse>('/v1/exec', { ...req, record }, leafTimeoutMs(req));
    if (record && res.step) opts.onStep?.(res.step, decodeArtifacts(res.artifacts), res.logStart);
    return { code: res.code, error: res.error ? rebuildError(res.error) : undefined };
  };

  return {
    exec: (command, positionals, flags) => execRaw({ command, positionals, flags }, true),

    async lease(): Promise<LeaseResponse | null> {
      try {
        return await t.hold(deviceWaitMs());
      } catch (e) {
        // Say what the pool looks like. `health` was read moments ago, on the way here, and
        // it is what names a phone that left — the refusal itself only counts devices.
        if (e instanceof NoFreeDeviceError) throw new NoFreeDeviceError(`${e.message} [${poolNote(health)}]`);
        throw e;
      }
    },

    async getElements(): Promise<Element[]> {
      const res = await t.postJson<ElementsResponse>('/v1/elements', {}, ELEMENTS_TIMEOUT_MS);
      return res.elements;
    },

    async captureFailure() {
      try {
        const res = await t.postJson<ElementsResponse>('/v1/elements', {}, 20_000);
        return { hierarchy: res.elements };
      } catch { return {}; }
    },

    async getLogs(logOpts = {}): Promise<string> {
      const res = await t.postJson<LogsResponse>('/v1/logs', logOpts, ELEMENTS_TIMEOUT_MS);
      return res.logs ?? '';
    },

    async install(appPath: string): Promise<void> {
      // v1 remote installs are single-file uploads; the extension is the only thing
      // the client tells the server about the artifact (never a path).
      const ext = extname(appPath).slice(1).toLowerCase();
      if (ext !== 'apk' && ext !== 'ipa') {
        throw new CliError(`install --server accepts a single .apk or .ipa file; got '${appPath}'. (.app directories are local-only.)`, 2);
      }
      let buf: Buffer;
      try {
        buf = readFileSync(appPath);
      } catch (e) {
        throw new CliError(`install: cannot read '${appPath}' (${(e as Error).message})`, 2);
      }
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const res = await installWhenFree(t, buf, REMOTE_INSTALL_TIMEOUT_MS, {
        'content-type': 'application/octet-stream',
        'x-verikun-ext': ext,
        'x-verikun-sha256': sha256,
      });
      // A PARTIAL install is a success, and it must not be a silent one: capacity just
      // dropped, and the operator's next question is which phone to go and look at.
      if (res.skipped?.length) {
        err(
          `[verikun] server installed on ${(res.devices ?? []).join(', ') || '(none)'}; ` +
            `${res.skipped.length} device(s) could not take this build and left the pool — ` +
            res.skipped.map((s) => `${s.serial} (${s.reason})`).join('; '),
        );
        opts.onInstallSkipped?.(res.skipped);
      }
    },

    async reset(appId: string): Promise<void> {
      // Between-test housekeeping (vk suite): the step is deliberately NOT spliced
      // into any run. iOS has no per-app data reset, so degrade to a force-stop —
      // the same honest degrade the local backend applies.
      const command = health.platform === 'ios' ? 'stop' : 'clear';
      const { code, error } = await execRaw({ command, positionals: [appId], flags: {} }, false);
      if (code !== 0) throw error ?? new CliError(`reset (${command} ${appId}) failed on the server (exit ${code})`, 3);
    },

    close: () => t.release(),
  };
}

/** The leaf's own wait budget plus evidence/restart margin, without undici's ceiling. */
export function leafTimeoutMs(req: ExecRequest): number {
  let budget = 30_000;
  if (req.command === 'wait') budget = parseDuration(req.flags.timeout ?? '10000', 'timeout');
  else if (['tap', 'text', 'assert', 'find', 'swipe'].includes(req.command)) budget += waitWindowMs(req.flags);
  else if (req.command === 'install') budget = 600_000;
  else if (req.command === 'launch') budget = 60_000;
  return Math.max(60_000, budget + 120_000);
}
async function installWhenFree(t: RemoteTransport, buf: Buffer, timeout: number, headers: Record<string, string>): Promise<InstallResponse> {
  const until = Date.now() + deviceWaitMs();
  let backoff = 500;
  for (;;) {
    try { return await t.request<InstallResponse>('POST', '/v1/install', buf, timeout, headers); }
    catch (e) {
      if (!(e instanceof CliError) || e instanceof RunEvictedError || !/\(409\)/.test(e.message) || Date.now() >= until) throw e;
      await new Promise(resolve => setTimeout(resolve, Math.min(backoff, Math.max(0, until - Date.now()))));
      backoff = Math.min(5000, backoff * 2);
    }
  }
}
