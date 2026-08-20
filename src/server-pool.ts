// The `vk server` device pool: N devices, one worker thread each, addressed by serial.
//
// This module owns MECHANISM only — spawning a worker per device, correlating replies,
// and keeping one command at a time per device. Who may use which device (leases, the
// run token, idle takeover) is POLICY and lives in server.ts, next to auth and the
// command grammar.
//
// `DevicePool` is a seam in the same spirit as ServerLifecycle / makeDriver: the unit
// suite injects an in-memory pool and never starts a thread, while production always
// takes the worker path — including a single-device server, so there is one code path
// rather than two that can drift.

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { CliError } from './errors';
import { err } from './output';
import { rebuildError, ErrorDescriptor, ExecRequest } from './rpc';
import type { Element, HierarchySource, Platform } from './types';
import type { LogFetchOpts } from './run';
import type { WorkerCall, WorkerExecResult, WorkerReply, WorkerRequest } from './server-worker';

/** One device, as the request handlers see it. */
export interface DeviceHandle {
  readonly serial: string;
  exec(req: ExecRequest): Promise<WorkerExecResult>;
  elements(): Promise<Element[]>;
  logs(opts: LogFetchOpts): Promise<string>;
  install(path: string): Promise<void>;
  reads(): Promise<HierarchySource | null>;
  /** Re-probe this device, throwing when it cannot be driven. What failover asks before
   *  quarantining a device on an unrecognised error. */
  preflight(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DevicePool {
  /** Serials currently serving. A device whose worker died is no longer listed. */
  serials(): string[];
  get(serial: string): DeviceHandle | undefined;
  /**
   * Swap ONE device out and, when `next` is given, a replacement in — how failover acts
   * on a pool. Retiring `failed` alone (`next: null`) is the honest degrade when nothing
   * healthier remains: the pool shrinks rather than keeps handing out a broken device.
   *
   * Resolves to the serial actually serving, or null when the replacement would not
   * start — in which case the pool has still shed the failed device.
   */
  replace(failed: string, next: string | null): Promise<string | null>;
  /** Point a SINGLE-device pool at another serial (`/v1/devices/*`), or at nothing. */
  rebind(serial: string | null): Promise<void>;
  disposeAll(): Promise<void>;
}

/** How long to wait for a worker to report that its device is drivable. Generous: the
 *  probe shells out to adb/idb, which on a cold box is not instant. */
const WORKER_READY_TIMEOUT_MS = 60_000;

/**
 * One device's worker thread, with replies correlated by id and commands serialized.
 *
 * The serialization is per DEVICE, which is the whole point of the pool: a phone can
 * serve one interaction at a time, but two phones need not wait for each other. (The
 * global promise chain this replaces made the second phone wait for the first.)
 */
class WorkerHandle implements DeviceHandle {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private dead: Error | null = null;

  private constructor(
    readonly serial: string,
    private readonly worker: Worker,
  ) {
    worker.on('message', (msg: WorkerReply) => {
      if (msg.kind !== 'reply') return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.ok) slot.resolve(msg.value);
      else slot.reject(rebuildError(msg.error));
    });
    // A worker that dies takes its device with it. Fail everything in flight rather
    // than leaving a caller hanging on a reply that can never arrive.
    const die = (why: string): void => {
      this.dead ??= new CliError(`device ${serial} is no longer available (${why})`, 3);
      for (const [, slot] of this.pending) slot.reject(this.dead);
      this.pending.clear();
    };
    worker.on('error', (e) => die(e.message));
    worker.on('exit', (code) => die(`worker exited with code ${code}`));
  }

  /**
   * Start a worker and wait until it says its device is genuinely drivable.
   *
   * Readiness means DRIVABLE, not merely resolved — the worker runs `preflight()` before
   * answering — because a pool that advertises a device it cannot drive would hand a lane
   * a device that 500s on every step.
   */
  static start(platform: Platform, serial: string): Promise<WorkerHandle> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'server-worker.js'), {
        workerData: { platform, serial },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new CliError(`device ${serial} did not become ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`, 3));
      }, WORKER_READY_TIMEOUT_MS);
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      worker.once('message', (msg: WorkerReply) => {
        if (msg.kind === 'ready') settle(() => resolve(new WorkerHandle(serial, worker)));
        else if (msg.kind === 'failed') {
          settle(() => {
            void worker.terminate();
            reject(rebuildError(msg.error as ErrorDescriptor));
          });
        }
      });
      worker.on('error', (e) => settle(() => reject(new CliError(`device ${serial}: ${e.message}`, 3))));
      worker.on('exit', (code) => settle(() => reject(new CliError(`device ${serial}: worker exited with code ${code}`, 3))));
    });
  }

  private send<T>(req: WorkerCall): Promise<T> {
    // Chain onto this device's queue, never onto a shared one.
    const next = this.queue.then(
      () => this.dispatch<T>(req),
      () => this.dispatch<T>(req),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private dispatch<T>(req: WorkerCall): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  exec(req: ExecRequest): Promise<WorkerExecResult> {
    return this.send<WorkerExecResult>({ kind: 'exec', ...req });
  }
  elements(): Promise<Element[]> {
    return this.send<Element[]>({ kind: 'elements' });
  }
  logs(opts: LogFetchOpts): Promise<string> {
    return this.send<string>({ kind: 'logs', opts });
  }
  async install(path: string): Promise<void> {
    await this.send<null>({ kind: 'install', path });
  }
  reads(): Promise<HierarchySource | null> {
    // Deliberately NOT queued: this reads the companion's cached verdict rather than the
    // device, and `/v1/health` must stay answerable while a step is in flight.
    return this.dispatch<HierarchySource | null>({ kind: 'reads' });
  }
  async preflight(): Promise<void> {
    // Also unqueued: the whole point is to ask a device that may be WEDGED behind the
    // very command we are trying to classify. Queueing the probe behind it would deadlock
    // until that command's own timeout, which is the opposite of failing over quickly.
    await this.dispatch<null>({ kind: 'preflight' });
  }
  async dispose(): Promise<void> {
    this.dead ??= new CliError(`device ${this.serial} is shutting down`, 3);
    await this.worker.terminate();
  }
}

/** The production pool: one worker thread per device. */
export class WorkerDevicePool implements DevicePool {
  private constructor(
    private readonly platform: Platform,
    private readonly handles: Map<string, DeviceHandle>,
  ) {}

  /**
   * Start a worker for every serial. A device that will not come up is REPORTED AND
   * DROPPED rather than fatal: with three phones on a shelf, one bad USB cable should
   * cost you a third of the throughput, not the whole server. The caller decides what an
   * empty pool means (cmdServer refuses unless device control can fix it).
   */
  static async start(platform: Platform, serials: string[]): Promise<WorkerDevicePool> {
    const handles = new Map<string, DeviceHandle>();
    const started = await Promise.all(
      serials.map(async (serial) => {
        try {
          return await WorkerHandle.start(platform, serial);
        } catch (e) {
          err(`[server] device ${serial} is NOT joining the pool: ${(e as Error).message}`);
          return null;
        }
      }),
    );
    for (const h of started) if (h) handles.set(h.serial, h);
    return new WorkerDevicePool(platform, handles);
  }

  serials(): string[] {
    return [...this.handles.keys()];
  }

  get(serial: string): DeviceHandle | undefined {
    return this.handles.get(serial);
  }

  /**
   * Retire `failed` and, when one is offered, bring `next` in to take its place.
   *
   * Order is load-bearing and mirrors the single-device failover it generalises: START
   * THE REPLACEMENT FIRST, then drop the failed device. A worker only reports ready after
   * its own `preflight()` passes, so a replacement that cannot be driven never enters the
   * pool — and the pool never dips below its remaining healthy devices while we find out.
   *
   * Dropping is unconditional. A device that just failed must not keep being handed to
   * runs even when nothing healthier exists; a pool of two that becomes a pool of one is
   * a smaller pool, whereas a pool of two where one is broken is a coin flip per lease.
   */
  async replace(failed: string, next: string | null): Promise<string | null> {
    let arrived: string | null = null;
    if (next) {
      try {
        this.handles.set(next, await WorkerHandle.start(this.platform, next));
        arrived = next;
      } catch (e) {
        err(`[server] pool: ${next} could not take over (${(e as Error).message})`);
      }
    }
    const gone = this.handles.get(failed);
    this.handles.delete(failed);
    await gone?.dispose().catch(() => undefined);
    return arrived;
  }

  /**
   * Swap a single-device pool onto another serial. Rebuilds the worker rather than
   * mutating one, for the same reason server.ts rebuilt the driver: both drivers cache a
   * pinned serial without probing, so an AVD that returns on a different port would leave
   * a permanently dead instance behind.
   */
  async rebind(serial: string | null): Promise<void> {
    await this.disposeAll();
    if (serial === null) return;
    const handle = await WorkerHandle.start(this.platform, serial);
    this.handles.set(serial, handle);
  }

  async disposeAll(): Promise<void> {
    const live = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(live.map((h) => h.dispose().catch(() => undefined)));
  }
}
