// The remote execution backend: `vk ai/suite/install --server <url>` run their
// device work through a `vk server` sitting next to the device, over HTTP+JSON
// (Node's global fetch — no SDK, zero runtime deps). One validated leaf command =
// ONE round-trip: the server keeps the whole auto-wait/dump loop on its side.
//
// The step detail each exec produces (selector, tier, resolved element, failure
// evidence) comes back in the response and is handed to `onStep`, which splices it
// into the CALLER's local run — so a remote run archives a report identical to a
// local one. Recording stays a caller concern: this module never touches ./.verikun.

import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { CliError } from '../errors';
import { err } from '../output';
import type { Element } from '../types';
import type { RunStep } from '../run';
import {
  ExecBackend,
  ExecRequest,
  ExecResponse,
  ElementsResponse,
  DeviceChange,
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
  /**
   * The server moved itself onto a different device. Mirrors `onStep`: the transport
   * reports, the caller decides what it means (a log line, and re-pointing the run
   * context so later spliced steps are attributed to the device that ran them).
   *
   * Fires from THREE places, because a move is reported on success bodies AND on error
   * bodies — `/v1/elements` and an install that exhausted the pool both fail, and the
   * client still needs to know the ground shifted.
   */
  onDeviceChange?: (change: DeviceChange) => void;
  /** Devices a pooled server could not install this build onto, and which therefore left
   *  its pool. Same shape of side-channel as `onDeviceChange`: the caller keeps the list,
   *  because `Driver.install` returns void and this is remote-only by nature. */
  onInstallSkipped?: (skipped: InstallSkip[]) => void;
}

/**
 * The ceiling NONE of the per-call timeouts below can exceed, whatever they say.
 *
 * Node's global `fetch` is undici, whose `headersTimeout` and `bodyTimeout` both default to
 * 300s, and there is no dependency-free way to raise them: a `dispatcher` needs `undici`
 * itself, which is bundled but not importable. The `AbortController` below is therefore a
 * FLOOR on how long a call may take, never a ceiling — `EXEC_TIMEOUT_MS` says 600s and gets
 * 300s.
 *
 * MEASURED on Node v20.20.2 against a server that held its headers for 310s: the fetch
 * rejected at 301s with `TypeError: fetch failed`, cause `HeadersTimeoutError`, code
 * `UND_ERR_HEADERS_TIMEOUT`. The bare `fetch failed` is the whole problem — `describeStatus`
 * never sees it, the suite reads the resulting exit 3 as the DEVICE being unreachable, and a
 * healthy phone gets retired for a client-side clock. Named in `request` below so it says so.
 */
const FETCH_HEADERS_CEILING_MS = 300_000;

// Per-call ceilings. exec is generous: a single leaf may legitimately block for its
// whole auto-wait window or an explicit `wait --timeout`, plus device time. Anything here
// above FETCH_HEADERS_CEILING_MS is aspirational — see that constant.
const HEALTH_TIMEOUT_MS = 10_000;
const ELEMENTS_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const DEVICE_LIST_TIMEOUT_MS = 30_000;
// Meant to sit above the server's own 4-minute boot ceiling, so the SERVER reports why a
// boot timed out rather than the client aborting first. It is exactly AT
// FETCH_HEADERS_CEILING_MS, so a boot that runs the full four minutes and then some is a
// photo finish — which is survivable only because `transportReason` now names the loser.
const DEVICE_START_TIMEOUT_MS = 5 * 60_000;
const DEVICE_STOP_TIMEOUT_MS = 60_000;

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * Turn a non-2xx into the error the caller sees.
 *
 * The 401/409/503 arms come FIRST and stay class-free on purpose: those describe the
 * TRANSPORT (wrong key, device leased, nothing attached), not something a driver threw, so
 * there is no device-error identity to restore and their wording is what a user acts on.
 *
 * Everything else prefers the server's `errorKind`. That field is what stops a `--server` run
 * reading a mid-launch `NoWindowError` as a fatal environment error: the class survives the
 * worker→main hop server-side, and this is where it used to be replaced by an anonymous
 * `CliError` (issue #80). No field — an older server, or a failure with no class worth
 * naming — falls through to exactly the previous behaviour.
 */
export function describeStatus(status: number, body: RpcErrorBody | null, url: string): Error {
  const detail = body?.error ? `: ${body.error}` : '';
  if (status === 401) {
    return new CliError(`verikun server rejected the auth key (401)${detail}. Check --auth-key / VERIKUN_SERVER_AUTH_KEY.`, 3);
  }
  if (status === 409) {
    return new CliError(`verikun server device is busy (409)${detail || ' — another run holds the device; retry when it finishes'}.`, 3);
  }
  if (status === 503) {
    return new CliError(`verikun server has no device attached (503)${detail}.`, 3);
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
  const code = ex?.cause?.code;
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    const what = code === 'UND_ERR_HEADERS_TIMEOUT' ? 'send a response' : 'finish its response';
    return (
      `the server did not ${what} within ${Math.round(FETCH_HEADERS_CEILING_MS / 1000)}s — ` +
      "this is Node's own fetch ceiling on the CLIENT, not the device. " +
      'The server may still be working; check its log before blaming the device'
    );
  }
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

  constructor(private readonly opts: RemoteOpts) {
    this.base = trimUrl(opts.url);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'x-verikun-run': this.runToken, ...extra };
    if (this.opts.authKey) h.authorization = `Bearer ${this.opts.authKey}`;
    return h;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: Buffer | string | undefined, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<T> {
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(extraHeaders),
        body,
        signal: controller.signal,
      });
    } catch (e) {
      throw new CliError(`cannot reach verikun server at ${url} (${transportReason(e, timeoutMs)})`, 3);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await readBody<RpcErrorBody>(res);
      // Before throwing: a failing request may still have moved the device, and that is
      // exactly the case a caller must not miss (an exhausted install, a dead-device read).
      if (body?.deviceChanged) this.opts.onDeviceChange?.(body.deviceChanged);
      throw describeStatus(res.status, body, url);
    }
    const parsed = await readBody<T>(res);
    if (parsed === null) throw new CliError(`verikun server at ${url} returned a non-JSON response`, 3);
    return parsed;
  }

  postJson<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
    return this.request<T>('POST', path, JSON.stringify(payload), timeoutMs, { 'content-type': 'application/json' });
  }

  /** Best-effort: give the device lock back. A lock we fail to release ages out. */
  async release(): Promise<void> {
    try {
      await this.postJson<{ ok: boolean }>('/v1/release', {}, HEALTH_TIMEOUT_MS);
    } catch {
      /* the idle takeover covers it */
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
  return health;
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
    // This is a one-shot administrative call under its own run token, not a run —
    // so hand the device lock straight back. Without this, `vk devices start
    // --server` (and the --ensure-device preflight, which uses its own token) would
    // 409 the very run it just booted the device for, until the 5-minute idle takeover.
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
   * belong to nobody. Returns null against a server that predates pooling.
   */
  lease(): Promise<LeaseResponse | null>;
}

export function createRemoteBackend(opts: RemoteOpts, health: HealthResponse): RemoteBackend {
  const t = new RemoteTransport(opts);

  const execRaw = async (req: ExecRequest, record: boolean): Promise<{ code: number; error?: Error }> => {
    const res = await t.postJson<ExecResponse>('/v1/exec', req, EXEC_TIMEOUT_MS);
    if (record && res.step) opts.onStep?.(res.step, decodeArtifacts(res.artifacts), res.logStart);
    // A failing step is a 200, so this is the ordinary path for a mid-run device death.
    if (res.deviceChanged) opts.onDeviceChange?.(res.deviceChanged);
    return { code: res.code, error: res.error ? rebuildError(res.error) : undefined };
  };

  return {
    exec: (command, positionals, flags) => execRaw({ command, positionals, flags }, true),

    async lease(): Promise<LeaseResponse | null> {
      // Feature-detect on a FIELD, never on the version: `capacity` and /v1/lease landed
      // together, and a client cannot otherwise tell "old server" from "new server".
      if (health.capacity === undefined) return null;
      return t.postJson<LeaseResponse>('/v1/lease', {}, HEALTH_TIMEOUT_MS);
    },

    async getElements(): Promise<Element[]> {
      const res = await t.postJson<ElementsResponse>('/v1/elements', {}, ELEMENTS_TIMEOUT_MS);
      return res.elements;
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
      const res = await t.request<InstallResponse>('POST', '/v1/install', buf, INSTALL_TIMEOUT_MS, {
        'content-type': 'application/octet-stream',
        'x-verikun-ext': ext,
        'x-verikun-sha256': sha256,
      });
      // Install is the one operation the server replays elsewhere, so a move here means
      // the build DID land — on a different device than the one we started with.
      if (res.deviceChanged) opts.onDeviceChange?.(res.deviceChanged);
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

    async close(): Promise<void> {
      // Free the server's device lock so the next command (a fresh run token, e.g.
      // `vk install` then `vk suite` in one CI job) isn't 409'd until the idle
      // takeover. Best-effort: a dead server just means the lock ages out.
      try {
        await t.postJson<{ ok: boolean }>('/v1/release', {}, HEALTH_TIMEOUT_MS);
      } catch {
        /* the idle takeover covers a lock we failed to release */
      }
    },
  };
}
