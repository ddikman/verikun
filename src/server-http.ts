// The HTTP plumbing every `vk server` handler shares: an error that knows its status and
// the client-side exit code, capped body reads, JSON replies, and the two wire encodings
// (flags → FlagSpec[], artifacts → base64). Transport only — every piece of policy (auth,
// the grammar gate, leases, failover) stays in server.ts.

import { IncomingMessage, ServerResponse } from 'node:http';
import type { FlagSpec } from './agent/ir';
import type { DeviceChange } from './rpc';

/** An error that already knows its HTTP status + the client-side exit code. */
export class HttpError extends Error {
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
export const firstLine = (m: string): string => m.split('\n')[0].trim();

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
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
export function flagsToSpecs(flags: unknown): FlagSpec[] {
  if (flags === undefined || flags === null) return [];
  if (typeof flags !== 'object' || Array.isArray(flags)) throw new HttpError(400, 'flags must be an object');
  return Object.entries(flags as Record<string, unknown>).map(([name, value]) => {
    if (typeof value === 'string') return { name, value };
    if (typeof value === 'number' || typeof value === 'boolean') return { name, value: String(value) };
    throw new HttpError(400, `flag '${name}' must be a string`);
  });
}

export function encodeArtifacts(artifacts: Record<string, Buffer>): Record<string, string> {
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
