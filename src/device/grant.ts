// A run-scoped hold on ONE device: which serial am I on, who keeps it warm, and who
// hands it back. Claims (host), leases (server) and lanes (suite) are three different
// scopes; why claims and leases stay separate implementations, what a grant shares, and
// what deliberately is NOT here (idle takeover, eviction, affinity) is in CLAUDE.md,
// "Device claims and grants". Platform-agnostic, like claims.ts and settings.ts: no adb/xcrun.

import {
  ClaimOpts,
  assertClaimable,
  claimDevice,
  claimHeartbeatMs,
  claimsEnabled,
  releaseClaim,
  touchClaim,
  type ClaimCandidate,
} from './claims';
import { err } from '../output';
import type { Platform } from '../types';

/**
 * One run's hold on one device.
 *
 * `touch` and `release` are both IDEMPOTENT and never throw: a grant is bookkeeping, and
 * bookkeeping that can fail a run — or fail a teardown, which runs while something has
 * already gone wrong — is worse than no bookkeeping. That is the same posture claims.ts
 * takes for the store itself.
 */
export interface DeviceGrant {
  /**
   * The device this grant is on.
   *
   * `undefined` where the hold exists but the serial does not name it: a local run that
   * let verikun auto-select resolves its device lazily, deep inside
   * `Driver.resolvedSerial()`, long after the grant was made. The claim store still knows
   * exactly what was taken — which is why `release()` is what to trust here, not `serial`.
   */
  readonly serial?: string;
  /** Report that the holder is still working. */
  touch(): void;
  /** Hand the device back. Safe to call twice, and safe to call on a grant that holds
   *  nothing. */
  release(): Promise<void>;
}

/** A grant that holds nothing — the null object. */
function inert(serial?: string): DeviceGrant {
  return {
    ...(serial ? { serial } : {}),
    touch: () => {},
    release: async () => {},
  };
}

// --- claims ------------------------------------------------------------------

export interface ClaimGrantOpts extends ClaimOpts {
  /**
   * Heartbeat period, ms. Defaults to `claimHeartbeatMs()`; `0` starts no timer.
   *
   * A holder that already heartbeats by other means passes `0` — `executeOutcome` stamps
   * the claim on every recorded command, so an in-process run needs no timer at all. The
   * parallel suite parent is the case that does: every device call happens in a CHILD, so
   * the parent runs no commands of its own and its claims would keep their start-of-suite
   * timestamp for the whole run.
   */
  heartbeatMs?: number;
}

/**
 * Wrap a claim this process already owns, and keep it warm.
 *
 * The timer is `unref`'d, so it can never hold the process open, and `release()` clears
 * it — a grant that outlived its timer would keep re-publishing a claim nobody is using.
 */
function heldClaim(serial: string, platform: Platform, o: ClaimGrantOpts): DeviceGrant {
  const period = o.heartbeatMs ?? claimHeartbeatMs(o.env ?? process.env);
  let timer: NodeJS.Timeout | undefined;
  if (period > 0) {
    timer = setInterval(() => touchClaim(serial, platform, o), period);
    timer.unref();
  }
  let released = false;
  return {
    serial,
    touch: () => {
      if (!released) touchClaim(serial, platform, o);
    },
    release: async () => {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      releaseClaim(serial, { ...o, mineOnly: true });
    },
  };
}

/**
 * Take a device that may legitimately be somebody else's — the ELASTIC answer.
 *
 * `null` means "another live job holds it"; the caller drops it and carries on with the
 * rest. This is what `--devices all` wants: the operator asked for "every usable device",
 * and a phone a sibling job is driving is simply not one of them. Failing the whole run
 * because one of three phones is busy would leave the other two idle.
 */
export function claimGrant(serial: string, platform: Platform, o: ClaimGrantOpts = {}): DeviceGrant | null {
  // With claims off there is nothing to take and nothing to hand back, and the caller
  // must behave EXACTLY as it did before claims existed — including never skipping a
  // device for being busy, since nothing can tell it that any more.
  if (!claimsEnabled(o.env ?? process.env)) return inert(serial);
  if (!claimDevice(serial, platform, o).ok) return null;
  return heldClaim(serial, platform, o);
}

/**
 * Take a device the operator NAMED, or refuse — throws `CliError(…, 2)` listing who holds
 * it and what to do about it.
 *
 * The opposite polarity to `claimGrant`, and the difference is whose idea the serial was:
 * quietly skipping a device that was asked for by name would hand back less capacity than
 * was requested with nothing saying so. `poolSerials` applies the same polarity to a
 * serial that is not attached.
 */
export function requireClaimGrant(
  serial: string,
  platform: Platform,
  alternatives: () => ClaimCandidate[] = () => [],
  o: ClaimGrantOpts = {},
): DeviceGrant {
  if (!claimsEnabled(o.env ?? process.env)) return inert(serial);
  assertClaimable(serial, platform, alternatives, o);
  return heldClaim(serial, platform, o);
}

/**
 * The grant for a device this process claimed LAZILY — a local run that let
 * `Driver.resolvedSerial()` pick, or was pinned with `--device` and claimed inside the
 * driver. There is no handle to wrap, so the grant defers to the claim store's own record
 * of what this process took.
 *
 * `touch` is a no-op on purpose: `executeOutcome` already stamps the claim on every
 * recorded command (cli.ts), which is a truer heartbeat than a timer — it fires when work
 * actually happens.
 */
export function processClaimGrant(serial: string | undefined, handBack: () => void): DeviceGrant {
  let released = false;
  return {
    ...(serial ? { serial } : {}),
    touch: () => {},
    release: async () => {
      if (released) return;
      released = true;
      handBack();
    },
  };
}

// --- server leases -----------------------------------------------------------

/**
 * The half of the remote backend a grant needs. Structural rather than an import of
 * `RemoteBackend`, so `device/` never depends on `agent/` for one method.
 */
export interface LeaseSource {
  /** Free the server's device lock for the next run token. Absent on a backend with
   *  nothing to hand back, which is still a valid grant. */
  close?(): Promise<void> | void;
}

/**
 * Wrap a `vk server` lease this run already holds.
 *
 * `touch` is a no-op, and that is a property of the server rather than an omission: the
 * lease's `lastSeenMs` is stamped by every request the run makes, and `holdingLease`
 * keeps a lease off the idle list for the whole length of one call. A client-side
 * heartbeat would be a second, worse copy of a clock the server already keeps — and a
 * lease is only ever broken ON DEMAND (server.ts's `leaseFor`), so there is no timer to
 * beat.
 */
export function leaseGrant(source: LeaseSource, serial?: string): DeviceGrant {
  let released = false;
  return {
    ...(serial ? { serial } : {}),
    touch: () => {},
    release: async () => {
      if (released) return;
      released = true;
      try {
        await source.close?.();
      } catch {
        /* the server's idle takeover covers a lease we failed to release */
      }
    },
  };
}

// --- teardown ----------------------------------------------------------------

/**
 * Hand every grant back, best-effort.
 *
 * Never throws and never short-circuits: this runs from a `finally`, often while
 * something has already gone wrong, and one unreachable server must not strand the phones
 * held beside it.
 */
export async function releaseGrants(grants: readonly DeviceGrant[]): Promise<void> {
  for (const g of grants) {
    try {
      await g.release();
    } catch (e) {
      err(`[verikun] could not release ${g.serial ?? 'a device'} (${(e as Error).message})`);
    }
  }
}
