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
import type { Element } from '../types';
import type { RunStep } from '../run';
import {
  ExecBackend,
  ExecRequest,
  ExecResponse,
  ElementsResponse,
  HealthResponse,
  RpcErrorBody,
  rebuildError,
} from '../rpc';

export interface RemoteOpts {
  /** Server base URL, e.g. http://127.0.0.1:8391 (a trailing '/' is tolerated). */
  url: string;
  authKey?: string;
  /** Receives each exec'd step + its artifact buffers for splicing into the local run. */
  onStep?: (step: RunStep, artifacts: Record<string, Buffer>) => void;
}

// Per-call ceilings. exec is generous: a single leaf may legitimately block for its
// whole auto-wait window or an explicit `wait --timeout`, plus device time.
const HEALTH_TIMEOUT_MS = 10_000;
const ELEMENTS_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

function describeStatus(status: number, body: RpcErrorBody | null, url: string): CliError {
  const detail = body?.error ? `: ${body.error}` : '';
  if (status === 401) {
    return new CliError(`verikun server rejected the auth key (401)${detail}. Check --auth-key / VERIKUN_SERVER_AUTH_KEY.`, 3);
  }
  if (status === 409) {
    return new CliError(`verikun server device is busy (409)${detail || ' — another run holds the device; retry when it finishes'}.`, 3);
  }
  // The server sends the intended exit code (usage 2 / env 3) in the body; fall
  // back on the HTTP class when it didn't.
  const exitCode = body?.exitCode ?? (status === 400 || status === 404 || status === 413 ? 2 : 3);
  return new CliError(`verikun server error ${status} at ${url}${detail}`, exitCode);
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
      const reason = (e as Error).name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e as Error).message;
      throw new CliError(`cannot reach verikun server at ${url} (${reason})`, 3);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw describeStatus(res.status, await readBody<RpcErrorBody>(res), url);
    const parsed = await readBody<T>(res);
    if (parsed === null) throw new CliError(`verikun server at ${url} returned a non-JSON response`, 3);
    return parsed;
  }

  postJson<T>(path: string, payload: unknown, timeoutMs: number): Promise<T> {
    return this.request<T>('POST', path, JSON.stringify(payload), timeoutMs, { 'content-type': 'application/json' });
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

function decodeArtifacts(encoded: Record<string, string> | undefined): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [rel, b64] of Object.entries(encoded ?? {})) out[rel] = Buffer.from(b64, 'base64');
  return out;
}

export function createRemoteBackend(opts: RemoteOpts, health: HealthResponse): ExecBackend {
  const t = new RemoteTransport(opts);

  const execRaw = async (req: ExecRequest, record: boolean): Promise<{ code: number; error?: Error }> => {
    const res = await t.postJson<ExecResponse>('/v1/exec', req, EXEC_TIMEOUT_MS);
    if (record && res.step) opts.onStep?.(res.step, decodeArtifacts(res.artifacts));
    return { code: res.code, error: res.error ? rebuildError(res.error) : undefined };
  };

  return {
    exec: (command, positionals, flags) => execRaw({ command, positionals, flags }, true),

    async getElements(): Promise<Element[]> {
      const res = await t.postJson<ElementsResponse>('/v1/elements', {}, ELEMENTS_TIMEOUT_MS);
      return res.elements;
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
      await t.request<{ ok: boolean }>('POST', '/v1/install', buf, INSTALL_TIMEOUT_MS, {
        'content-type': 'application/octet-stream',
        'x-verikun-ext': ext,
        'x-verikun-sha256': sha256,
      });
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
