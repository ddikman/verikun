import { spawnCollect } from './exec';
import { claimDevice, claimsEnabled, releaseClaim } from './device/claims';
// Per-device process ownership, correlated IPC replies and serialized calls.
// Health and lease policy live in the parent server. Claims and companion cleanup
// remain owned until actual executor exit, preventing overlapping successors.

import { fork, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { DeviceGoneError, DeviceUnresponsiveError, CliError } from './errors';
import { serialQueue } from './wait';
import { err } from './output';
import { rebuildError, ErrorDescriptor, ExecRequest } from './rpc';
import type { Element, HierarchySource, Platform } from './types';
import type { LogFetchOpts } from './run';
import type { WorkerCall, WorkerExecResult, WorkerReply, WorkerRequest } from './server-worker';

/** Kill the detached executor and every device-tool child in its process group. */
function killWorkerGroup(worker: ChildProcess): void {
  if (!worker.pid) return;
  try { process.kill(process.platform === 'win32' ? worker.pid : -worker.pid, 'SIGKILL'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') err(`[server] cannot kill worker ${worker.pid}: ${(e as Error).message}`); }
}

/** One device, as the request handlers see it. */
export interface DeviceHandle {
  readonly serial: string;
  exec(req: ExecRequest): Promise<WorkerExecResult>;
  elements(): Promise<Element[]>;
  logs(opts: LogFetchOpts): Promise<string>;
  install(path: string): Promise<void>;
  /** Cached read path, seeded at startup and piggybacked on exec replies. */
  reads(): Promise<HierarchySource | null>;
  /** Probe outside the executor, so a blocked device call cannot hide failed liveness. */
  preflight(): Promise<void>;
  /** Confirm recovery on the executor itself, clearing any driver breaker. */
  recover?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DevicePool {
  /** Serials currently serving. A device whose worker died is no longer listed. */
  serials(): string[];
  get(serial: string): DeviceHandle | undefined;
  /**
   * Bring a device INTO the pool, resolving false when its worker will not start.
   *
   * The server admits it after confirming liveness and installing its current build.
   * Retirement removes advertisement immediately; actual exit releases resources.
   */
  adopt(serial: string): Promise<boolean>;
  /**
   * Drop a device from the pool. SYNCHRONOUS on purpose: the caller pairs it with its own
   * lease bookkeeping, and both must land without an `await` between them. Disposal of the
   * worker runs in the background — nothing is waiting on a dead device's teardown.
   */
  retire(serial: string): void;
  /** Point a SINGLE-device pool at another serial (`/v1/devices/*`), or at nothing. */
  rebind(serial: string | null): Promise<void>;
  /**
   * Release the companion and claim after actual worker exit, including retirement
   * and failed startup. At most one listener; cleanup finishes before readoption.
   */
  onLoss(cb: (serial: string, why: string) => void | Promise<void>): void;
  disposeAll(): Promise<void>;
}

/** Executor seams used to exercise a genuinely blocked process without waiting 30 minutes. */
export interface WorkerPoolOptions { workerFile?: string; callTimeoutMs?: number }

/** How long to wait for a worker to report that its device is drivable. Generous: the
 *  probe shells out to adb/idb, which on a cold box is not instant. */
const WORKER_READY_TIMEOUT_MS = 60_000;

/** Last-resort executor bound; ordinary request deadlines are server policy. */
const WORKER_CALL_TIMEOUT_MS = 30 * 60_000;

/**
 * One device's worker process, with replies correlated by id and commands serialized.
 *
 * The serialization is per DEVICE, which is the whole point of the pool: a phone can
 * serve one interaction at a time, but two phones need not wait for each other. (The
 * global promise chain this replaces made the second phone wait for the first.)
 */
class WorkerHandle implements DeviceHandle {
  private seq = 0;
  private platform: Platform = 'android';
  /** Last known read path, piggybacked on successful exec replies. */
  private cachedReads: HierarchySource | null = null;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private dead: Error | null = null;

  private constructor(
    readonly serial: string,
    private readonly worker: ChildProcess,
    ready: HierarchySource | null,
    /** Told when this device dies unprompted, so the pool can stop advertising it. */
    private readonly onDeath?: (serial: string, why: string) => void,
    private readonly onExit?: (serial: string, why: string) => void,
    private readonly callTimeoutMs = WORKER_CALL_TIMEOUT_MS,
  ) {
    this.cachedReads = ready;
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
      const first = this.dead === null;
      this.dead ??= new DeviceGoneError(`device ${serial} is no longer available (${why})`);
      for (const [, slot] of this.pending) slot.reject(this.dead);
      this.pending.clear();
      // `DevicePool.serials()` promises that a device whose worker died is no longer
      // listed. Without this the handle stays in the map: health keeps advertising the
      // capacity, leases keep being handed the serial, and every request on it rejects
      // instantly — a slot poisoned for the process lifetime with nothing explaining it.
      if (first) this.onDeath?.(serial, why);
    };
    worker.on('error', (e) => die(e.message));
    worker.on('close', (code, signal) => {
      killWorkerGroup(worker);
      die(`worker exited (${signal ?? code})`);
      this.onExit?.(serial, `worker exited (${signal ?? code})`);
    });
  }

  /**
   * Start a worker and wait until it says its device is genuinely drivable.
   *
   * Readiness means DRIVABLE, not merely resolved — the worker runs `preflight()` before
   * answering — because a pool that advertises a device it cannot drive would hand a lane
   * a device that 500s on every step.
   */
  static start(
    platform: Platform,
    serial: string,
    onDeath?: (serial: string, why: string) => void,
    onExit?: (serial: string, why: string) => void,
    options: WorkerPoolOptions = {},
  ): Promise<WorkerHandle> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const worker = fork(options.workerFile ?? join(__dirname, 'server-worker.js'), [platform, serial], {
        detached: true, serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, VERIKUN_NO_CLAIM: '1' },
      });
      worker.stderr?.on('data', chunk => err(chunk.toString().trimEnd()));
      let settled = false;
      const timer = setTimeout(() => {
        // Through `settle`, like every other exit: leaving `settled` false lets a late
        // `ready` build a full handle around an already-terminated worker, which the pool
        // would then admit as a device whose every request rejects.
        settle(() => {
          killWorkerGroup(worker);
          reject(new CliError(`device ${serial} did not become ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`, 3));
        });
      }, WORKER_READY_TIMEOUT_MS);
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      worker.once('message', (msg: WorkerReply) => {
        if (msg.kind === 'ready') settle(() => {
          ready = true;
          resolve(Object.assign(new WorkerHandle(serial, worker, msg.reads ?? null, onDeath, onExit, options.callTimeoutMs), { platform }));
        });
        else if (msg.kind === 'failed') {
          settle(() => {
            killWorkerGroup(worker);
            reject(rebuildError(msg.error as ErrorDescriptor));
          });
        }
      });
      worker.on('error', (e) => settle(() => { killWorkerGroup(worker); reject(new CliError(`device ${serial}: ${e.message}`, 3)); }));
      worker.on('close', (code) => {
        if (!ready) { killWorkerGroup(worker); onExit?.(serial, `startup worker exited with code ${code}`); }
        settle(() => reject(new CliError(`device ${serial}: worker exited with code ${code}`, 3)));
      });
    });
  }

  /** Chain onto THIS device's queue, never onto a shared one. */
  private readonly queue = serialQueue();
  private send<T>(req: WorkerCall): Promise<T> {
    return this.queue(() => this.dispatch<T>(req));
  }

  private dispatch<T>(req: WorkerCall): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.dead ??= new DeviceUnresponsiveError(`device ${this.serial} stopped responding (no reply to '${req.kind}')`);
        for (const slot of this.pending.values()) slot.reject(this.dead);
        this.pending.clear();
        this.onDeath?.(this.serial, this.dead.message);
        killWorkerGroup(this.worker);
      }, this.callTimeoutMs);
      // A pending call must not by itself keep the process alive at shutdown.
      timer.unref?.();
      const settle = <A>(fn: (a: A) => void) => (a: A): void => {
        clearTimeout(timer);
        fn(a);
      };
      this.pending.set(id, { resolve: settle(resolve) as (v: unknown) => void, reject: settle(reject) });
      this.worker.send({ ...req, id } as WorkerRequest, error => {
        if (!error) return;
        this.pending.get(id)?.reject(new DeviceGoneError(`device ${this.serial}: ${error.message}`));
        this.pending.delete(id);
      });
    });
  }

  async exec(req: ExecRequest): Promise<WorkerExecResult> {
    const r = await this.send<WorkerExecResult>({ kind: 'exec', ...req });
    if (r.reads) this.cachedReads = r.reads;
    // Normalize IPC binary views at the boundary. A plain `Uint8Array`'s `toString`
    // IGNORES its encoding argument — so `.toString('base64')` downstream yields
    // "137,80,78,71,…" and every screenshot and piece of failure evidence archives as an
    // unopenable file, with a 200 and no error anywhere. TypeScript cannot see it: the
    // declared type is still Buffer. Restore it at the boundary that broke it.
    if (r.artifacts) {
      for (const [rel, bytes] of Object.entries(r.artifacts)) {
        // A view over the received memory without another copy. Failure evidence stays
        // full-resolution (run.ts) — megabytes per failed step, per device.
        const u8 = bytes as unknown as Uint8Array;
        r.artifacts[rel] = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
      }
    }
    return r;
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
  /** Seeded at startup and piggybacked on exec replies; health never queues device work. */
  async reads(): Promise<HierarchySource | null> { return this.cachedReads; }
  async recover(): Promise<void> { await this.send({ kind: 'recover' }); }
  async preflight(): Promise<void> {
    const args = this.platform === 'android'
      ? ['-s', this.serial, 'shell', 'echo', 'ok'] : ['describe', '--udid', this.serial];
    const r = await spawnCollect(this.platform === 'android' ? (process.env.ADB || 'adb') : (process.env.IDB || 'idb'), args, { timeout: 5000 });
    if (r.code !== 0 || (this.platform === 'android' && r.stdout.trim() !== 'ok'))
      throw new DeviceUnresponsiveError(`device ${this.serial} failed its liveness probe: ${r.stderr.trim()}`);
  }
  async dispose(): Promise<void> {
    this.dead ??= new CliError(`device ${this.serial} is shutting down`, 3);
    if (this.worker.exitCode !== null || this.worker.signalCode !== null) return;
    await new Promise<void>(resolve => { this.worker.once('close', () => resolve()); killWorkerGroup(this.worker); });
  }
}

/** The production pool: one worker process per device. */
export class WorkerDevicePool implements DevicePool {
  private readonly handles = new Map<string, DeviceHandle>();
  private readonly busy = new Set<string>();
  private readonly exitTasks = new Map<string, Promise<void>>();
  private readonly exitComplete = new Map<string, Promise<void>>();
  private readonly exitResolve = new Map<string, () => void>();
  private lossListener?: (serial: string, why: string) => void | Promise<void>;

  private constructor(private readonly platform: Platform, private readonly options: WorkerPoolOptions = {}) {}

  /** An arrow property, not a method: it is handed to every worker as a callback. */
  private readonly forget = (serial: string, why: string): void => {
    if (!this.handles.delete(serial)) return;
    err(`[server] pool: ${serial} left the pool — ${why}`);
    // Resource release belongs to the actual exit callback.
  };

  private readonly exited = (serial: string, why: string): void => {
    const cleanup = Promise.resolve().then(() => this.lossListener?.(serial, why)).catch(e => {
      err(`[server] cleanup ${serial}: ${(e as Error).message}`);
    }).finally(() => {
      if (!this.lossListener && claimsEnabled()) releaseClaim(serial, { mineOnly: true });
      this.busy.delete(serial);
      this.exitTasks.delete(serial);
      this.exitResolve.get(serial)?.();
      this.exitResolve.delete(serial);
      this.exitComplete.delete(serial);
    });
    this.exitTasks.set(serial, cleanup);
  };

  /**
   * Start a worker for every serial. A device that will not come up is REPORTED AND
   * DROPPED rather than fatal: with three phones on a shelf, one bad USB cable should
   * cost you a third of the throughput, not the whole server. The caller decides what an
   * empty pool means (cmdServer refuses when nothing at all could be driven).
   *
   * Joining goes through `adopt`, the same call failover uses, so a pool behaves the same
   * way whether a device arrived at boot or replaced a casualty an hour later.
   */
  static async start(platform: Platform, serials: string[], options: WorkerPoolOptions = {}): Promise<WorkerDevicePool> {
    const pool = new WorkerDevicePool(platform, options);
    await Promise.all(serials.map((serial) => pool.adopt(serial)));
    return pool;
  }

  onLoss(cb: (serial: string, why: string) => void | Promise<void>): void {
    this.lossListener = cb;
  }

  serials(): string[] {
    return [...this.handles.keys()];
  }

  get(serial: string): DeviceHandle | undefined {
    return this.handles.get(serial);
  }

  /** Start a worker for `serial` and add it, reporting whether it came up. */
  async adopt(serial: string): Promise<boolean> {
    if (this.handles.has(serial)) {
      // Already serving. Never start a SECOND worker for one serial: the map would keep
      // only the newer handle and the older process would run on unreferenced, holding
      // that device's single UiAutomation connection with nothing able to release it.
      // server.ts serializes failover so this should be unreachable; it is here because
      // the failure it prevents is silent.
      return true;
    }
    if (this.busy.has(serial)) return false;
    this.busy.add(serial);
    if (claimsEnabled() && !claimDevice(serial, this.platform).ok) { this.busy.delete(serial); return false; }
    this.exitComplete.set(serial, new Promise(resolve => this.exitResolve.set(serial, resolve)));
    try {
      // Inserted HERE, inside the await, not by a caller after a `Promise.all`: a worker
      // that dies while a slower device is still starting would otherwise fire `forget`
      // against a map it is not in yet (a silent no-op) and then be inserted DEAD — a
      // poisoned slot that health advertises and every lease is handed.
      this.handles.set(serial, await WorkerHandle.start(this.platform, serial, this.forget, this.exited, this.options));
      // Announced, like the departure in `forget`. Capacity has to be legible in BOTH
      // directions or a log shows a pool that only ever shrinks: at boot this confirms each
      // device came up individually rather than as one aggregate banner line, and later it
      // is how a reconciler's re-adoption is distinguished from a device that never left.
      err(`[server] pool: ${serial} joined the pool (${this.handles.size} device(s) serving)`);
      return true;
    } catch (e) {
      err(`[server] pool: ${serial} is NOT serving (${(e as Error).message})`);
      return false;
    }
  }

  retire(serial: string): void {
    const gone = this.handles.get(serial);
    this.handles.delete(serial);
    // Fire and forget: awaiting here would reopen the very window `retire` is synchronous
    // to close, and a device we have already stopped serving has nobody waiting on it.
    void gone?.dispose().catch(() => undefined);
  }

  /**
   * Swap a single-device pool onto another serial. Rebuilds the worker rather than
   * mutating one, for the same reason server.ts rebuilt the driver: both drivers cache a
   * pinned serial without probing, so an AVD that returns on a different port would leave
   * a permanently dead instance behind.
   *
   * Await old worker exit and cleanup before adopting, even when the serial is unchanged.
   * Failed adoption remains eligible for the server's normal readmission loop.
   */
  async rebind(serial: string | null): Promise<void> {
    if (serial === null) {
      await this.disposeAll();
      return;
    }
    await this.disposeAll();
    if (!(await this.adopt(serial))) throw new CliError(`device ${serial} could not be readmitted`, 3);
  }

  async disposeAll(): Promise<void> {
    const live = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(live.map((h) => h.dispose().catch(() => undefined)));
    await Promise.all([...this.exitComplete.values()]);
  }
}
