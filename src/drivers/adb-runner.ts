import { DeviceGoneError, DeviceUnresponsiveError } from '../errors';
import { runText, runBinary, sleepSync, TextResult } from '../exec';

let recoveryDeadline = Infinity;
/** Polling owns its window; transport recovery must not extend it. */
export function withAdbRecoveryDeadline<T>(deadline: number, fn: () => T): T {
  const previous = recoveryDeadline;
  recoveryDeadline = Math.min(previous, deadline);
  try { return fn(); } finally { recoveryDeadline = previous; }
}

/** Transport evidence only; authorization and boot readiness are operator errors. */
export function adbTransportLoss(r: { code: number; stderr: string }): boolean {
  return r.code !== 0 && /device (?:'[^']*' )?not found|no devices\/emulators found|device offline|error: closed|protocol fault|failed to get feature set|transport (?:error|is closing)/i.test(r.stderr) &&
    !/unauthorized|still authorizing|is not ready \(/i.test(r.stderr);
}

export interface AdbRunnerDeps {
  text: typeof runText;
  binary: typeof runBinary;
  now: () => number;
  sleep: (ms: number) => void;
}

/** One device runner, shared with its companion. A successful real round trip clears the breaker. */
export class AdbRunner {
  private broken = false;
  constructor(private readonly bin: string, private readonly serial: string,
    private readonly deps: AdbRunnerDeps = { text: runText, binary: runBinary, now: Date.now, sleep: sleepSync }) {}

  private echo(): boolean {
    try {
      const r = this.deps.text(this.bin, ['-s', this.serial, 'shell', 'echo', 'ok'], { timeout: 5000 });
      if (r.code === 0 && r.stdout.trim() === 'ok') { this.broken = false; return true; }
    } catch { /* the echo is the confirmation, never another suspicion */ }
    return false;
  }

  private call<T extends { code: number; stderr: string; stdout: string | Buffer }>(
    args: string[], invoke: () => T, bestEffort: boolean,
  ): T {
    if (this.broken) throw new DeviceUnresponsiveError(`device ${this.serial} is not responding (breaker open)`);
    const execute = (): T => {
      try { return invoke(); } catch (e) {
        if (!bestEffort && (e as NodeJS.ErrnoException).code === 'ETIMEDOUT' && !this.echo()) {
          this.broken = true;
          throw new DeviceUnresponsiveError(`device ${this.serial} did not answer a 5s shell echo after a timeout: ${(e as Error).message}`);
        }
        throw e;
      }
    };
    let r = execute();
    if (!adbTransportLoss(r)) return r;
    // Reads are idempotent; input is safe only with transport evidence and no device output.
    const safe = args[0] === 'exec-out' || args[0] === 'get-state' ||
      (args[0] === 'shell' && (/^(?:getprop|dumpsys|cat|date|wm|echo)$/.test(args[1] ?? '') || r.stdout.length === 0));
    if (safe && !bestEffort) {
      const until = Math.min(this.deps.now() + 10_000, recoveryDeadline);
      while (this.deps.now() < until) {
        let ready = false;
        try {
          const state = this.deps.text(this.bin, ['-s', this.serial, 'get-state'], { timeout: Math.min(1000, until - this.deps.now()) });
          ready = state.code === 0 && state.stdout.trim() === 'device';
        } catch { /* bounded transport recovery */ }
        if (ready) {
          r = execute();
          if (!adbTransportLoss(r)) return r;
          break;
        }
        this.deps.sleep(Math.min(500, Math.max(0, until - this.deps.now())));
      }
    }
    throw new DeviceGoneError(`device ${this.serial} transport lost: ${r.stderr.trim()}`);
  }

  text(args: string[], opts: { timeout?: number; bestEffort?: boolean } = {}): TextResult {
    return this.call(args, () => this.deps.text(this.bin, ['-s', this.serial, ...args], opts), !!opts.bestEffort);
  }
  binary(args: string[], opts: { timeout?: number } = {}): ReturnType<typeof runBinary> {
    return this.call(args, () => this.deps.binary(this.bin, ['-s', this.serial, ...args], opts), false);
  }
  probe(): boolean { return this.echo(); }
}
