// One device executor in a detached child process. Blocking device tools cannot stall
// HTTP or another device; the parent can kill this entire process group on retirement.
// Authentication, validation, leases and health remain in the parent server.

import { getDriver } from './drivers';
import { executeForServer } from './cli';
import { setOutputQuiet } from './output';
import { setProcessScoped } from './device/claims';
import { describeError, ErrorDescriptor } from './rpc';
import { DeviceUnresponsiveError } from './errors';
import type { Driver, Element, HierarchySource, Platform } from './types';
import type { RunStep } from './run';
import type { LogFetchOpts } from './run';

export type WorkerCall =
  | { kind: 'exec'; sampleDeviceTime?: boolean; command: string; positionals: string[]; flags: Record<string, string> }
  | { kind: 'elements' }
  | { kind: 'logs'; opts: LogFetchOpts }
  | { kind: 'install'; path: string }
  /** Confirm liveness and clear the driver's circuit breaker after a successful probe. */
  | { kind: 'recover' };

export type WorkerRequest = WorkerCall & { id: number };

/** What an `exec` produces — `ExecResponse` minus the base64 encoding, which the main
 *  process applies (advanced IPC serialization preserves binary artifacts). */
export interface WorkerExecResult {
  code: number;
  error?: ErrorDescriptor;
  step?: RunStep;
  artifacts?: Record<string, Buffer>;
  logStart?: string;
  originals?: Record<string, string>;
  reads?: HierarchySource;
}

export type WorkerReply =
  /** Sent once at startup: the device resolved AND its toolchain can drive it. */
  | { kind: 'ready'; serial: string; reads?: HierarchySource }
  | { kind: 'failed'; error: ErrorDescriptor }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: ErrorDescriptor };

/**
 * Tag this worker's diagnostics with its device.
 *
 * A worker's stderr is forwarded to the parent's automatically, so without this the log
 * of a three-device server is three interleaved streams with no way to tell which phone
 * is talking — precisely the question you open the log to answer.
 */
function prefixStderr(tag: string): () => void {
  const write = process.stderr.write.bind(process.stderr);
  let pending = '';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    // Honour the documented `write(chunk, cb)` / `write(chunk, encoding, cb)` overloads:
    // a swallowed callback leaves anything awaiting a drain ack waiting forever, and a
    // dropped encoding silently re-reads the bytes as utf8.
    const cb = typeof rest[rest.length - 1] === 'function' ? (rest[rest.length - 1] as () => void) : undefined;
    const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : 'utf8';
    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    let ok = true;
    for (const line of lines) ok = write(`[${tag}] ${line}\n`);
    cb?.();
    return ok;
  }) as typeof process.stderr.write;
  // A partial line is BUFFERED until the next write or this flush. A process killed by
  // SIGKILL runs no code at all — not even an 'exit' handler — so that path cannot
  // be flushed and this is not claimed to cover it; the caller flushes on an uncaught
  // throw, which is the one ending a worker gets to observe.
  return () => {
    if (!pending) return;
    const last = pending;
    pending = '';
    write(`[${tag}] ${last}\n`);
  };
}

function main(): void {
  if (!process.send) throw new Error('server-worker must be forked with an IPC channel');
  const platform = process.argv[2] as Platform;
  const serial = process.argv[3];
  if (!['android', 'ios'].includes(platform) || !serial) throw new Error('invalid device executor arguments');
  const send = (reply: WorkerReply): void => { if (process.connected) process.send!(reply); };
  process.on('disconnect', () => process.exit(0));
  const flushStderr = prefixStderr(serial);
  // The ONLY teardown a worker can flush on. SIGKILL — how every normal path ends a
  // worker (dispose/retire/rebind/ready-timeout) — runs no handler at all, so a
  // `beforeExit` listener would be dead code claiming otherwise.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`uncaught: ${(e as Error).stack ?? (e as Error).message}\n`);
    flushStderr();
    process.exit(1);
  });
  // Handlers print "tapped …" confirmations via out(); a server's stdout is not a data
  // channel. Mirrors what cmdServer does for the single-device case.
  setOutputQuiet(true);
  // The server owns this device for as long as it listens, so its pid is exact liveness
  // evidence for the claim store (claims.ts's isLive).
  setProcessScoped(true);

  let driver: Driver;
  try {
    driver = getDriver(platform, serial);
    driver.resolvedSerial();
    // A device that resolved must actually be drivable, or the pool would advertise
    // capacity it cannot serve and every request to this device would 500.
    driver.preflight();
  } catch (e) {
    send({ kind: 'failed', error: describeError(e as Error) } satisfies WorkerReply);
    return;
  }

  let reads: HierarchySource | undefined;
  try {
    reads = driver.hierarchySource?.() ?? undefined;
  } catch {
    /* best-effort: a read-path probe must never be why a device is unusable */
  }
  send({ kind: 'ready', serial, ...(reads ? { reads } : {}) } satisfies WorkerReply);

  process.on('message', (req: WorkerRequest) => {
    void (async () => {
      try {
        send({ kind: 'reply', id: req.id, ok: true, value: await handle(driver, platform, req) } satisfies WorkerReply);
      } catch (e) {
        send({ kind: 'reply', id: req.id, ok: false, error: describeError(e as Error) } satisfies WorkerReply);
      }
    })();
  });
}

async function handle(driver: Driver, platform: Platform, req: WorkerRequest): Promise<unknown> {
  switch (req.kind) {
    case 'exec': {
      const { code, error, step, artifacts, logStart, originals } = await executeForServer(
        req.command,
        req.positionals,
        req.flags,
        driver,
        platform,
        req.sampleDeviceTime,
      );
      const result: WorkerExecResult = {
        code,
        ...(originals ? { originals } : {}),
        ...(error ? { error: describeError(error) } : {}),
        ...(step ? { step } : {}),
        ...(artifacts && Object.keys(artifacts).length ? { artifacts } : {}),
        ...(logStart ? { logStart } : {}),
      };
      try { result.reads = driver.hierarchySource?.() ?? undefined; } catch { /* cached path is advisory */ }
      return result;
    }
    case 'recover':
      if (driver.probeLiveness && !driver.probeLiveness()) throw new DeviceUnresponsiveError('device failed its recovery echo');
      return null;
    case 'elements':
      return driver.getElements() satisfies Element[];
    case 'logs':
      return driver.getLogs(req.opts);
    case 'install':
      driver.install(req.path);
      return null;
  }
}

main();
