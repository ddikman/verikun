// The `vk server` device pool: N devices, one worker thread each, addressed by serial.
//
// This module owns MECHANISM only — spawning a worker per device, correlating replies,
// and keeping one command at a time per device. Who may use which device (leases, the
// run token, idle takeover) is POLICY and lives in server.ts, next to auth and the
// command grammar.
//
// `DevicePool` is a seam in the same spirit as `ServerLifecycle`: the unit suite injects
// an in-memory pool and never starts a thread, while production always takes the worker
// path — including a single-device server, so there is one code path rather than two that
// can drift. A fake standing in here must mirror the WORKER's semantics, not the
// convenient ones: notably that structured clone hands a `Buffer` back as a plain
// `Uint8Array`, and that `adopt` probes before it inserts.

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { CliError } from './errors';
import { serialQueue } from './wait';
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
  /** The device's read path. Cached; `{fresh: true}` waits for a live measurement — see
   *  `WorkerHandle.reads`. */
  reads(opts?: { fresh?: boolean }): Promise<HierarchySource | null>;
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
   * Bring a device INTO the pool, resolving false when its worker will not start.
   *
   * Paired with `retire` rather than offered as one `replace(failed, next)` call, because
   * the caller has to do something BETWEEN the two — re-point the leases held on the
   * outgoing device — and it must do it while that device is still listed. A combined
   * call would delete the device first and hand back control at an `await`, letting a
   * racing `leaseFor` reap the holder's lease before it could be remapped, which loses
   * exactly the affinity the lease exists to provide.
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
   * Register what to do when a device leaves WITHOUT being retired — its worker died.
   *
   * The pool cannot clean up after it: a claim file and a companion connection are both
   * things it knows nothing about, and both are held on the HOST until something hands
   * them back. Failover tidies up after a device it SHED, but a death can happen with
   * failover off entirely, or on the last device (where shedding is deliberately refused),
   * so the pool has to say so out loud. At most one listener.
   */
  onLoss(cb: (serial: string, why: string) => void): void;
  disposeAll(): Promise<void>;
}

/** How long to wait for a worker to report that its device is drivable. Generous: the
 *  probe shells out to adb/idb, which on a cold box is not instant. */
const WORKER_READY_TIMEOUT_MS = 60_000;

/** How stale the cached read path may get before a background refresh is worth its cost.
 *  A companion that stands down mid-suite is what this field exists to expose (issue #77),
 *  and half a minute is far inside that. */
const READS_TTL_MS = 30_000;

/**
 * One device's worker thread, with replies correlated by id and commands serialized.
 *
 * The serialization is per DEVICE, which is the whole point of the pool: a phone can
 * serve one interaction at a time, but two phones need not wait for each other. (The
 * global promise chain this replaces made the second phone wait for the first.)
 */
class WorkerHandle implements DeviceHandle {
  private seq = 0;
  /** Last known read path, refreshed in the background. See `reads()`. */
  private cachedReads: HierarchySource | null = null;
  private readsAt = Date.now(); // seeded by the ready handshake
  private refreshingReads = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private dead: Error | null = null;

  private constructor(
    readonly serial: string,
    private readonly worker: Worker,
    ready: HierarchySource | null,
    /** Told when this device dies unprompted, so the pool can stop advertising it. */
    private readonly onDeath?: (serial: string, why: string) => void,
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
      this.dead ??= new CliError(`device ${serial} is no longer available (${why})`, 3);
      for (const [, slot] of this.pending) slot.reject(this.dead);
      this.pending.clear();
      // `DevicePool.serials()` promises that a device whose worker died is no longer
      // listed. Without this the handle stays in the map: health keeps advertising the
      // capacity, leases keep being handed the serial, and every request on it rejects
      // instantly — a slot poisoned for the process lifetime with nothing explaining it.
      if (first) this.onDeath?.(serial, why);
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
  static start(
    platform: Platform,
    serial: string,
    onDeath?: (serial: string, why: string) => void,
  ): Promise<WorkerHandle> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'server-worker.js'), {
        workerData: { platform, serial },
      });
      let settled = false;
      const timer = setTimeout(() => {
        // Through `settle`, like every other exit: leaving `settled` false lets a late
        // `ready` build a full handle around an already-terminated worker, which the pool
        // would then admit as a device whose every request rejects.
        settle(() => {
          void worker.terminate();
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
        if (msg.kind === 'ready') settle(() => resolve(new WorkerHandle(serial, worker, msg.reads ?? null, onDeath)));
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

  /** Chain onto THIS device's queue, never onto a shared one. */
  private readonly queue = serialQueue();
  private send<T>(req: WorkerCall): Promise<T> {
    return this.queue(() => this.dispatch<T>(req));
  }

  private dispatch<T>(req: WorkerCall): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  async exec(req: ExecRequest): Promise<WorkerExecResult> {
    const r = await this.send<WorkerExecResult>({ kind: 'exec', ...req });
    // Structured clone hands a `Buffer` back as a plain `Uint8Array`, whose `toString`
    // IGNORES its encoding argument — so `.toString('base64')` downstream yields
    // "137,80,78,71,…" and every screenshot and piece of failure evidence archives as an
    // unopenable file, with a 200 and no error anywhere. TypeScript cannot see it: the
    // declared type is still Buffer. Restore it at the boundary that broke it.
    if (r.artifacts) {
      for (const [rel, bytes] of Object.entries(r.artifacts)) {
        // A VIEW over the clone's memory, not a third copy of it: `postMessage` already
        // copied these bytes once, and a failure screenshot is deliberately kept
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
  /**
   * The read path, answered WITHOUT touching the worker.
   *
   * `/v1/health` must stay answerable mid-step, and skipping the parent's queue is not
   * enough to achieve that: the worker thread itself is blocked inside `spawnSync` for
   * the whole of an exec, so a `reads` message would simply sit unread until the step
   * finished. Health would then hang for as long as the device was busy — which on a
   * single-device server is exactly when someone is most likely to be asking.
   *
   * So the value is cached (seeded from the worker's ready handshake) and refreshed in
   * the background, landing whenever the worker next comes free. One step of staleness
   * costs nothing: this field exists so a companion that quietly stood down is visible
   * at all (issue #77), and it is answered from the previous step rather than never.
   */
  async reads(opts: { fresh?: boolean } = {}): Promise<HierarchySource | null> {
    // `fresh` is for the once-per-run caller (`/v1/lease`), which on a POOLED server is
    // the only chance to measure this at all — `/v1/health` deliberately skips reads
    // there, so without it a client is told the read path from its PREVIOUS lease and a
    // companion that stood down in between goes unreported for a whole run (issue #77).
    // `/v1/health` still takes the cached value: staying answerable mid-step is its job.
    const refresh = this.refreshReads();
    if (opts.fresh) await refresh;
    return this.cachedReads;
  }

  private async refreshReads(): Promise<void> {
    // Throttled, because the refresh is NOT free: on Android `hierarchySource()` asks the
    // companion for its state, which spawns a helper process on the device thread — the
    // one resource the pool exists to protect. `/v1/health` is unauthenticated and polled
    // by CI, so an unthrottled refresh would spend device time on every probe.
    if (Date.now() - this.readsAt < READS_TTL_MS) return;
    if (this.refreshingReads || this.dead) return;
    this.refreshingReads = true;
    try {
      // QUEUED, not dispatched: the worker handles each message as an independent async
      // task and an exec yields at every auto-wait `sleep`, so an unqueued probe really
      // does run *during* a step — spending device time the pool exists to serialize and
      // stalling that step's next poll behind a blocking companion query.
      this.cachedReads = await this.send<HierarchySource | null>({ kind: 'reads' });
    } catch {
      /* the device may be gone; the last known value is still the best answer we have */
    } finally {
      // Stamped whether it worked or not. Throttling on SUCCESS would defeat itself for
      // exactly the device whose read path is failing: every unauthenticated /v1/health
      // would enqueue another probe onto the one worker least able to spare it.
      this.readsAt = Date.now();
      this.refreshingReads = false;
    }
  }
  async preflight(): Promise<void> {
    // Unqueued, unlike `reads`: the probe asks about a device that
    // may be mid-command, and the parent's queue would hold it behind exactly the work it
    // is trying to classify. What it does NOT get is a guarantee of promptness — the
    // worker still handles messages one at a time and is unreachable while blocked inside
    // a `spawnSync` — so treat it as "ask as early as the device allows", never as a
    // liveness check that can outrun a wedged phone.
    await this.dispatch<null>({ kind: 'preflight' });
  }
  async dispose(): Promise<void> {
    this.dead ??= new CliError(`device ${this.serial} is shutting down`, 3);
    await this.worker.terminate();
  }
}

/** The production pool: one worker thread per device. */
export class WorkerDevicePool implements DevicePool {
  private readonly handles = new Map<string, DeviceHandle>();
  private lossListener?: (serial: string, why: string) => void;

  private constructor(private readonly platform: Platform) {}

  /** An arrow property, not a method: it is handed to every worker as a callback. */
  private readonly forget = (serial: string, why: string): void => {
    if (!this.handles.delete(serial)) return;
    err(`[server] pool: ${serial} left the pool — ${why}`);
    this.lossListener?.(serial, why);
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
  static async start(platform: Platform, serials: string[]): Promise<WorkerDevicePool> {
    const pool = new WorkerDevicePool(platform);
    await Promise.all(serials.map((serial) => pool.adopt(serial)));
    return pool;
  }

  onLoss(cb: (serial: string, why: string) => void): void {
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
      // only the newer handle and the older thread would run on unreferenced, holding
      // that device's single UiAutomation connection with nothing able to release it.
      // server.ts serializes failover so this should be unreachable; it is here because
      // the failure it prevents is silent.
      return true;
    }
    try {
      // Inserted HERE, inside the await, not by a caller after a `Promise.all`: a worker
      // that dies while a slower device is still starting would otherwise fire `forget`
      // against a map it is not in yet (a silent no-op) and then be inserted DEAD — a
      // poisoned slot that health advertises and every lease is handed.
      this.handles.set(serial, await WorkerHandle.start(this.platform, serial, this.forget));
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
   * SWAP OR NOTHING, exactly as `adopt`/`retire`: the new worker has to be serving before
   * the old ones go. A freshly power-cycled device commonly fails its first probe (adb
   * still reports `offline` for a few seconds), and disposing first would leave the pool
   * EMPTY on a throw — with the caller's lease bookkeeping skipped, `/v1/devices/*`
   * unable to name a target any more, and the server answering 503 until it is restarted.
   */
  async rebind(serial: string | null): Promise<void> {
    if (serial === null) {
      await this.disposeAll();
      return;
    }
    // Snapshot BEFORE inserting, and compare by identity rather than serial: an AVD that
    // comes back on the same port — and every iOS simulator, whose UDID never changes —
    // rebinds onto its own serial, and a serial-based filter would drop the OLD handle
    // from the map without disposing it, leaking a worker and its UiAutomation connection
    // on every restart.
    const outgoing = [...this.handles.values()];
    const handle = await WorkerHandle.start(this.platform, serial, this.forget);
    this.handles.clear();
    this.handles.set(serial, handle);
    const leaving = outgoing.filter((h) => h !== handle);
    // Announce the departure BEFORE disposing. `dispose()` pre-sets the handle's `dead`
    // latch, so the worker's own exit event takes the not-first path and `onDeath` never
    // fires — which means the loss listener (the only place a departing device's claim and
    // companion are handed back) would be skipped for every `/v1/devices/*` rebind, and a
    // restarted AVD returning on a new port would leave its old claim owned by this
    // still-live server pid forever. Only for serials we are NOT re-adopting: the new
    // worker has already claimed `serial`, and releasing it here would give it away.
    for (const h of leaving) if (h.serial !== serial) this.lossListener?.(h.serial, `replaced by ${serial}`);
    await Promise.all(leaving.map((h) => h.dispose().catch(() => undefined)));
  }

  async disposeAll(): Promise<void> {
    const live = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(live.map((h) => h.dispose().catch(() => undefined)));
  }
}
