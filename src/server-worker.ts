// One `vk server` device, driven on its own thread.
//
// WHY A THREAD. Every device call bottoms out in `spawnSync` (exec.ts), which blocks the
// thread it runs on. A single-threaded server therefore serves one device at a time no
// matter how many are attached — so a pooled server that kept everything on the main
// thread would buy exactly nothing, which is the same trap `Promise.all` over tests falls
// into on the client. A worker per device is the smallest thing that makes the blocking
// call block only its own device. It also gives each device its own copy of the module
// globals that are per-job by nature (`quiet` in output.ts, `processScoped` and the
// acquired-claims set in device/claims.ts).
//
// WHAT STAYS ON THE MAIN THREAD. Everything that is policy: bearer auth, the validateNode
// grammar gate, body caps, the logs charset gate, install streaming. This module is only
// the device call at the end of that pipeline — so the server's trust boundary does not
// move and does not get re-implemented per device.
//
// Errors cross the boundary through rpc.ts's existing pure codec, so a SelectorNotFound /
// AmbiguousSelector keeps its class identity all the way to the `vk ai` engine that has
// to tell a heal trigger from a terminal failure.

import { parentPort, workerData } from 'node:worker_threads';
import { getDriver } from './drivers';
import { executeForServer } from './cli';
import { setOutputQuiet } from './output';
import { setProcessScoped } from './device/claims';
import { describeError, ErrorDescriptor } from './rpc';
import type { Driver, Element, HierarchySource, Platform } from './types';
import type { RunStep } from './run';
import type { LogFetchOpts } from './run';

export interface DeviceWorkerData {
  platform: Platform;
  serial: string;
}

export type WorkerCall =
  | { kind: 'exec'; command: string; positionals: string[]; flags: Record<string, string> }
  | { kind: 'elements' }
  | { kind: 'logs'; opts: LogFetchOpts }
  | { kind: 'install'; path: string }
  /** Re-probe this device's toolchain. The failover classifier deliberately leaves the
   *  timing-dependent question ("is it actually dead, or was that a blip?") to the caller,
   *  and this is how the caller asks — on the device's OWN thread, so a probe of one
   *  device cannot stall another's in-flight step. */
  | { kind: 'preflight' }
  /** Which read path this device's NEXT hierarchy read would take. Answered without
   *  touching the device (it reads the companion's cached verdict), which is why the
   *  pool may dispatch it outside the per-device queue — `/v1/health` has to stay
   *  answerable while a step is in flight, and a companion that silently stood down
   *  mid-suite is exactly what this field exists to expose (issue #77). */
  | { kind: 'reads' };

export type WorkerRequest = WorkerCall & { id: number };

/** What an `exec` produces — `ExecResponse` minus the base64 encoding, which the main
 *  thread applies (Buffers survive structured clone, so the wire encoding stays there). */
export interface WorkerExecResult {
  code: number;
  error?: ErrorDescriptor;
  step?: RunStep;
  artifacts?: Record<string, Buffer>;
  logStart?: string;
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
function prefixStderr(tag: string): void {
  const write = process.stderr.write.bind(process.stderr);
  let pending = '';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) write(`[${tag}] ${line}\n`);
    // Report success regardless: a swallowed partial line is buffered, not lost, and a
    // logging path must never be able to fail a device command.
    void rest;
    return true;
  }) as typeof process.stderr.write;
}

function main(): void {
  const port = parentPort;
  if (!port) throw new Error('server-worker must be started as a worker thread');
  const { platform, serial } = workerData as DeviceWorkerData;
  prefixStderr(serial);
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
    port.postMessage({ kind: 'failed', error: describeError(e as Error) } satisfies WorkerReply);
    return;
  }

  let reads: HierarchySource | undefined;
  try {
    reads = driver.hierarchySource?.() ?? undefined;
  } catch {
    /* best-effort: a read-path probe must never be why a device is unusable */
  }
  port.postMessage({ kind: 'ready', serial, ...(reads ? { reads } : {}) } satisfies WorkerReply);

  port.on('message', (req: WorkerRequest) => {
    void (async () => {
      try {
        port.postMessage({ kind: 'reply', id: req.id, ok: true, value: await handle(driver, platform, req) } satisfies WorkerReply);
      } catch (e) {
        port.postMessage({ kind: 'reply', id: req.id, ok: false, error: describeError(e as Error) } satisfies WorkerReply);
      }
    })();
  });
}

async function handle(driver: Driver, platform: Platform, req: WorkerRequest): Promise<unknown> {
  switch (req.kind) {
    case 'exec': {
      const { code, error, step, artifacts, logStart } = await executeForServer(
        req.command,
        req.positionals,
        req.flags,
        driver,
        platform,
      );
      const result: WorkerExecResult = {
        code,
        ...(error ? { error: describeError(error) } : {}),
        ...(step ? { step } : {}),
        ...(artifacts && Object.keys(artifacts).length ? { artifacts } : {}),
        ...(logStart ? { logStart } : {}),
      };
      return result;
    }
    case 'preflight':
      driver.preflight(); // throws CliError(3), which crosses back through the codec
      return null;
    case 'elements':
      return driver.getElements() satisfies Element[];
    case 'logs':
      return driver.getLogs(req.opts);
    case 'install':
      driver.install(req.path);
      return null;
    case 'reads':
      try {
        return driver.hierarchySource?.() ?? null;
      } catch {
        return null;
      }
  }
}

main();
