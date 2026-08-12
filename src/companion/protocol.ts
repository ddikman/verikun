// Wire protocol for the on-device companion (tools/verikun-companion).
//
// One request per connection: write a command line, read until EOF. Kept separate from
// the lifecycle manager so the framing rules — which are where the sharp edges are —
// can be unit-tested without a device.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Bumped in lockstep with PROTOCOL_VERSION in CompanionApp.java. A companion left running
 *  by an older verikun answers `ping` with a different number and is restarted rather than
 *  talked to, so a changed dump format can never be replayed by a stale process. */
export const COMPANION_PROTOCOL = '1';

/** How the companion decides which display size to clip node bounds to. Calibrated per
 *  device against a real `uiautomator dump` — never assumed. See calibrate(). */
export type DimensionSource = 'app' | 'real';

export class CompanionUnavailableError extends Error {}

/**
 * Is this reply from a live companion, or from nothing at all?
 *
 * Load-bearing: `adb forward` keeps the host port open whether or not anything is
 * listening on the device end, so a companion that died answers with a successful
 * connection and ZERO bytes rather than ECONNREFUSED. A client that only handles connect
 * errors reads that as a valid empty hierarchy — which is exactly the "absent" lie that
 * silently skips a guard. Treat an empty reply as unavailable, always.
 */
export function isLiveReply(reply: Buffer): boolean {
  return reply.length > 0;
}

/** Does this `ping` reply come from a companion we can speak to? */
export function pingMatches(reply: Buffer): boolean {
  if (!isLiveReply(reply)) return false;
  const [name, version] = reply.toString('utf8').trim().split(/\s+/);
  return name === 'verikun-companion' && version === COMPANION_PROTOCOL;
}

/** A dump reply is only usable if it is actually a hierarchy — the companion reports its
 *  own failures as plain text (`ERROR …`, `released — call acquire first`), and those must
 *  never reach the XML parser as if they were a screen. */
export function isHierarchy(reply: Buffer): boolean {
  return isLiveReply(reply) && reply.toString('utf8', 0, 512).includes('<hierarchy');
}

/** The command line for a dump, given the idle window and the calibrated dimension source. */
export function dumpCommand(idleMs: number, dims: DimensionSource): string {
  return `dump ${Math.max(0, Math.round(idleMs))} ${dims}`;
}

/**
 * Local port for a device's companion. One companion per device (only one UiAutomation may
 * be connected at a time), so ports are derived from the serial rather than allocated — two
 * verikun processes driving the SAME device must land on the same forward, and two driving
 * DIFFERENT devices must not collide.
 */
export function portForSerial(serial: string, base = 8299, span = 200): number {
  let hash = 0;
  for (let i = 0; i < serial.length; i++) hash = (hash * 31 + serial.charCodeAt(i)) >>> 0;
  return base + (hash % span);
}

/**
 * Send one command and read the whole reply, synchronously.
 *
 * Synchronous because `Driver` is: every device call in verikun is a `spawnSync`, and
 * making the hierarchy read async would ripple through cli.ts, run.ts and the engine for
 * no behavioural gain. Node has no sync socket, so the socket work happens in a child
 * process (`sock-client.js`) and we read its stdout — the same shape as shelling to `adb`.
 * Measured cost of that indirection: 39ms per round trip, against 2400ms for the stock
 * dump it replaces.
 *
 * Throws CompanionUnavailableError for every failure mode, so callers have exactly one
 * thing to catch before handing the connection back and using the stock path.
 */
export function requestSync(port: number, command: string, timeoutMs = 10000): Buffer {
  const client = join(__dirname, 'sock-client.js');
  const r = spawnSync(process.execPath, [client, String(port), ...command.split(' ')], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new CompanionUnavailableError((r.error as Error).message);
  if (r.status !== 0) throw new CompanionUnavailableError(`companion unreachable on port ${port}`);
  const out = (r.stdout as Buffer) ?? Buffer.alloc(0);
  // `adb forward` keeps the host port open whether or not anything is listening on the
  // device end, so a dead companion connects fine and returns nothing. See isLiveReply.
  if (!isLiveReply(out)) throw new CompanionUnavailableError('companion is not running');
  return out;
}
