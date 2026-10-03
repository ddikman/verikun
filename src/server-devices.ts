import { DumpKilledError, NoWindowError, UnsupportedOnPlatformError, isDeviceLoss } from './errors';
export type DeviceState = 'joining' | 'ready' | 'leased' | 'draining' | 'checking' | 'down' | 'installing';
export interface DeviceRecord {
  serial: string; state: DeviceState; reason: string; since: number; failures: number;
  strikes: number; nextTryAt: number; installedSha?: string; bootId?: string; packageIdentity?: string; missedEchoes: number; lastEchoAt: number;
  attemptStartedAt?: number;
}
export interface TransitionDetails { installedSha?: string; bootId?: string; packageIdentity?: string; evict?: boolean; installFailure?: boolean }

/** One authority for device health; executor teardown releases resources only after exit. */
export class DeviceTable {
  private readonly records = new Map<string, DeviceRecord>();
  constructor(private readonly now: () => number = Date.now,
    private readonly evict: (serial: string, reason: string) => void = () => {},
    private readonly log: (message: string) => void = () => {},
    private readonly onDown: (serial: string) => void = () => {}) {}
  get(serial: string): Readonly<DeviceRecord> | undefined { return this.records.get(serial); }
  remove(serial: string): void { this.records.delete(serial); }
  all(): Readonly<DeviceRecord>[] { return [...this.records.values()]; }
  ready(): string[] { return this.all().filter(r => r.state === 'ready' || r.state === 'leased').map(r => r.serial); }
  transition(serial: string, state: DeviceState, reason: string, details: TransitionDetails = {}): void {
    let record = this.records.get(serial);
    if (!record) {
      record = { serial, state: 'down', reason: '', since: this.now(), failures: 0, strikes: 0, nextTryAt: 0, missedEchoes: 0, lastEchoAt: this.now() };
      this.records.set(serial, record);
    }
    const previous = record.state;
    if (previous !== state && ['joining', 'checking', 'installing'].includes(state)) record.attemptStartedAt = this.now();
    const changed = previous !== state || record.reason !== reason;
    record.state = state; record.reason = reason;
    if (changed) { record.since = this.now(); this.log(`${serial}: ${previous} → ${state} (${reason})`); }
    if (details.installedSha !== undefined) record.installedSha = details.installedSha;
    if (details.bootId !== undefined) record.bootId = details.bootId;
    if (details.packageIdentity !== undefined) record.packageIdentity = details.packageIdentity;
    if (state === 'ready') { record.strikes = 0; record.failures = 0; record.nextTryAt = 0; record.missedEchoes = 0; record.lastEchoAt = this.now(); delete record.attemptStartedAt; }
    if (state === 'down' && previous !== 'down') {
      record.failures++;
      const base = details.installFailure ? 60_000 : 5000;
      const cap = details.installFailure ? 30 * 60_000 : 5 * 60_000;
      const startedAt = record.attemptStartedAt ?? this.now();
      record.nextTryAt = startedAt + Math.min(base * 2 ** (record.failures - 1), cap);
      delete record.attemptStartedAt;
    }
    if ((state === 'down' && previous !== 'down') || details.evict) this.evict(serial, reason);
    if (state === 'down' && previous !== 'down') this.onDown(serial);
  }
  report(serial: string, error?: unknown): 'check' | 'stay' {
    const r = this.records.get(serial);
    if (!r) return 'stay';
    if (!error) { r.strikes = 0; return 'stay'; }
    if (isDeviceLoss(error)) { this.transition(serial, 'checking', (error as Error).message, { evict: true }); return 'check'; }
    if (error instanceof NoWindowError || error instanceof UnsupportedOnPlatformError) return 'stay';
    if (error instanceof DumpKilledError || (error as { exitCode?: number }).exitCode === 3) {
      if (++r.strikes >= 3) { this.transition(serial, 'checking', 'three failed read windows'); return 'check'; }
    }
    return 'stay';
  }
  echo(serial: string, ok: boolean): 'check' | 'stay' {
    const r = this.records.get(serial);
    if (!r) return 'stay';
    r.lastEchoAt = this.now(); r.missedEchoes = ok ? 0 : r.missedEchoes + 1;
    if (r.missedEchoes < 2) return 'stay';
    this.transition(serial, 'checking', 'two missed liveness echoes'); return 'check';
  }
  quarantined(): Array<{ serial: string; reason: string }> {
    return this.all().filter(r => r.state === 'down').map(({serial, reason}) => ({serial, reason}));
  }
  degraded(): Array<{ serial: string; reason: string }> {
    return this.all().filter(r => r.state === 'checking').map(({serial, reason}) => ({serial, reason}));
  }
}
