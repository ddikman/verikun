import { RunEvictedError } from './errors';

export interface Lease { serial: string; logSampled?: boolean }
export interface Tombstone { serial?: string; why: string }
interface Waiter { token: string; avoid?: string; resolve: (serial: string | null) => void; timer: NodeJS.Timeout }

/** Affinity, tombstones and FIFO admission. No device I/O belongs here. */
export class LeaseTable {
  readonly leases = new Map<string, Lease>();
  readonly evicted = new Map<string, Tombstone>();
  readonly originals = new Map<string, Record<string, string>>();
  readonly inFlight = new Map<string, number>();
  private readonly executing = new Map<string, number>();
  readonly dealtAtMs = new Map<string, number>();
  exclusive: string | null = null;
  private readonly waiters: Waiter[] = [];
  private progressAt: number;
  constructor(private readonly ready: () => string[], private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = () => {},
    private readonly beforeEvict: (token: string) => void = () => {}) {
    this.progressAt = now();
  }
  evict(token: string, why: string): void {
    const had = this.leases.get(token);
    if (had) this.beforeEvict(token);
    this.leases.delete(token);
    this.evicted.set(token, { serial: had?.serial, why });
    if (this.evicted.size > 512) this.evicted.delete(this.evicted.keys().next().value!);
    if (had) this.log(`run ${token.slice(0, 8)} evicted from ${had.serial} — ${why}`);
    this.changed(true);
  }
  evictDevice(serial: string, why: string): void {
    for (const [token, lease] of this.leases) if (lease.serial === serial) this.evict(token, why);
  }
  acquire(token: string, avoid?: string, queued = false): string | null {
    if ((this.exclusive !== null && this.exclusive !== token) || this.evicted.has(token)) return null;
    const mine = this.leases.get(token);
    if (mine) return mine.serial;
    if (!queued && this.waiters.length) return null;
    const taken = new Set([...this.leases.values()].map(l => l.serial).concat([...this.executing.keys()]));
    const ready = this.ready();
    // Wait for a healthy sibling even when it is currently leased. A recovered
    // casualty is a fallback only when it is the sole ready member.
    const eligible = ready.filter(s => s !== avoid || !ready.some(other => other !== avoid));
    const free = eligible.filter(s => !taken.has(s)).sort((a, b) =>
      Number(a === avoid) - Number(b === avoid) || (this.dealtAtMs.get(a) ?? 0) - (this.dealtAtMs.get(b) ?? 0));
    const serial = free[0];
    if (!serial) return null;
    this.leases.set(token, { serial });
    this.dealtAtMs.set(serial, this.now());
    this.progressAt = this.now();
    this.log(`${serial} → run ${token.slice(0, 8)}`);
    return serial;
  }
  wait(token: string, waitMs: number, avoid?: string): Promise<string | null> {
    const serial = this.acquire(token, avoid);
    if (serial) return Promise.resolve(serial);
    if (this.evicted.has(token)) return Promise.reject(new RunEvictedError(this.evicted.get(token)!.why));
    return new Promise(resolve => {
      const timer = setInterval(() => {
        this.flush();
        if (this.now() - this.progressAt < waitMs) return;
        const index = this.waiters.findIndex(w => w.token === token);
        if (index >= 0) this.waiters.splice(index, 1);
        clearInterval(timer); resolve(null);
      }, Math.min(1000, Math.max(1, waitMs)));
      timer.unref();
      if (!this.waiters.length) this.progressAt = this.now();
      this.waiters.push({ token, avoid, resolve, timer });
    });
  }
  cancelWait(token: string): void {
    const i = this.waiters.findIndex(w => w.token === token);
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1); clearInterval(w.timer); w.resolve(null);
  }
  release(token: string, tombstone = false): void {
    const lease = this.leases.get(token);
    this.leases.delete(token);
    if (tombstone && !this.evicted.has(token)) {
      this.evicted.set(token, { serial: lease?.serial, why: 'the lease hold ended' });
      if (this.evicted.size > 512) this.evicted.delete(this.evicted.keys().next().value!);
    }
    this.cancelWait(token);
    this.changed(true);
  }
  async hold<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const serial = this.leases.get(token)?.serial;
    if (serial) this.executing.set(serial, (this.executing.get(serial) ?? 0) + 1);
    this.inFlight.set(token, (this.inFlight.get(token) ?? 0) + 1);
    try { return await fn(); } finally {
      const n = (this.inFlight.get(token) ?? 1) - 1;
      if (n) this.inFlight.set(token, n); else this.inFlight.delete(token);
      if (serial) {
        const running = this.executing.get(serial)! - 1;
        if (running) this.executing.set(serial, running); else this.executing.delete(serial);
      }
      this.changed();
    }
  }
  othersActive(token: string): boolean {
    return this.exclusive !== null || [...this.leases.keys(), ...this.inFlight.keys()].some(t => t !== token);
  }
  async drainAndHold<T>(token: string, fn: () => Promise<T>): Promise<T> {
    if (this.exclusive !== null) throw new Error('server already has an exclusive operation');
    this.exclusive = token;
    try { return await fn(); } finally { this.exclusive = null; this.changed(); }
  }
  changed(progress = false): void { if (progress) this.progressAt = this.now(); this.flush(); }
  private flush(): void {
    while (this.waiters.length && this.exclusive === null) {
      const w = this.waiters[0];
      const serial = this.acquire(w.token, w.avoid, true);
      if (!serial) break;
      this.waiters.shift(); clearInterval(w.timer); w.resolve(serial);
    }
  }
  dispose(): void {
    for (const w of this.waiters.splice(0)) { clearInterval(w.timer); w.resolve(null); }
  }
}
