// Device LIFECYCLE — starting and stopping a device, as opposed to driving one.
//
// This is a SECOND seam beside `Driver`, deliberately not part of it. A `Driver` is
// bound to a resolved device: every method funnels through `resolvedSerial()`, which
// throws when no device is attached — precisely the state in which you want to boot
// one. (`Driver.stop(appId)` also already exists, so a `Driver.stop(deviceName)`
// sibling would be a permanent reader trap.) So lifecycle operations are addressed
// by NAME, not by a bound driver, and live here.
//
// Platform specifics stay in adb.ts / ios.ts, as CLAUDE.md requires; this module is
// the dispatcher plus the pure target-resolution rules that cli.ts and server.ts share.

import { isUsableState } from '../device/failover';
import { DeviceKind, Platform, StartOpts, StartResult, StopOpts, StopResult } from '../types';
import { CliError } from '../errors';
import { DEFAULT_STOP_TIMEOUT_MS } from '../wait';
import { listAdbDevices, listAvds, avdNameOf, bootAvd, killEmulator } from './adb';
import { listSimulators, listPhysicalDevices, bootSimulator, shutdownSimulator } from './ios';

export type LifecycleVerb = 'start' | 'stop' | 'restart';

/** Something start/stop can address: a running device OR a startable AVD/simulator. */
export interface LifecycleTarget {
  platform: Platform;
  kind: DeviceKind;
  /** adb serial / simulator UDID. '' for an AVD that has not booted yet — Android
   *  assigns `emulator-<console-port>` at boot, so there is no address until then. */
  serial: string;
  /** AVD name / simulator name — the token a human passes. */
  name: string;
  /** DeviceInfo vocabulary: 'device' | 'booted' | 'shutdown' | 'offline' | … */
  state: string;
  /** iOS runtime; shown when disambiguating same-named simulators. */
  runtime?: string;
}

export interface DeviceLifecycle {
  readonly platform: Platform;
  /** Running devices + startable AVDs/simulators. Returns [] when tooling is missing —
   *  listing degrades, only acting on a device fails loudly. */
  targets(): LifecycleTarget[];
  boot(target: LifecycleTarget, opts: StartOpts): Promise<StartResult>;
  shutdown(target: LifecycleTarget, opts: StopOpts): Promise<StopResult>;
}

/** Is this target usable right now? The two platforms spell it differently. */
export function isRunning(t: LifecycleTarget): boolean {
  // The SAME predicate the pool and failover ask. It was a local copy of
  // `state === 'device' || 'booted'` and drifted the moment that one learned devicectl's
  // `connected`: `chooseTarget`'s `prefer: 'running'` then read a connected iPhone as
  // not-running and resolved ambiguity the wrong way against a device the pool enlists.
  return isUsableState(t.state);
}

/** How a target is displayed and re-addressed: prefer the human name. */
export function targetLabel(t: LifecycleTarget): string {
  return t.name || t.serial;
}

// --- Android ---------------------------------------------------------------

const androidLifecycle: DeviceLifecycle = {
  platform: 'android',

  targets(): LifecycleTarget[] {
    let attached: LifecycleTarget[] = [];
    try {
      attached = listAdbDevices().map((d) => ({
        platform: 'android' as const,
        kind: d.kind ?? 'physical',
        serial: d.serial,
        // Only an emulator has an AVD name; ask its console (cheap, best-effort).
        name: d.kind === 'emulator' ? avdNameOf(d.serial) : '',
        state: d.state,
      }));
    } catch {
      /* adb missing → nothing attached to report */
    }
    const running = new Set(attached.map((t) => t.name.toLowerCase()).filter(Boolean));
    const idle: LifecycleTarget[] = listAvds()
      .filter((name) => !running.has(name.toLowerCase()))
      .map((name) => ({ platform: 'android', kind: 'emulator', serial: '', name, state: 'shutdown' }));
    return [...attached, ...idle];
  },

  boot(target, opts) {
    return bootAvd(target.name, opts);
  },

  shutdown(target, opts) {
    if (!target.serial) return Promise.resolve({ serial: '', stopped: false });
    return killEmulator(target.serial, opts);
  },
};

// --- iOS -------------------------------------------------------------------

const iosLifecycle: DeviceLifecycle = {
  platform: 'ios',

  targets(): LifecycleTarget[] {
    const out: LifecycleTarget[] = [];
    try {
      for (const d of listSimulators()) {
        out.push({
          platform: 'ios',
          kind: 'simulator',
          serial: d.serial,
          name: d.name ?? d.model ?? '',
          state: d.state,
          runtime: d.product,
        });
      }
    } catch {
      /* simctl missing */
    }
    try {
      for (const d of listPhysicalDevices()) {
        out.push({ platform: 'ios', kind: 'physical', serial: d.serial, name: '', state: d.state });
      }
    } catch {
      /* devicectl missing */
    }
    return out;
  },

  boot(target, opts) {
    return bootSimulator(target.serial, opts);
  },

  shutdown(target, opts) {
    return shutdownSimulator(target.serial, opts);
  },
};

export function lifecycleFor(platform: Platform): DeviceLifecycle {
  return platform === 'ios' ? iosLifecycle : androidLifecycle;
}

export function allLifecycles(): DeviceLifecycle[] {
  return [androidLifecycle, iosLifecycle];
}

// --- target resolution (pure) ----------------------------------------------

function describe(t: LifecycleTarget): string {
  return ['  ' + (t.serial || '(not running)'), t.name, t.runtime ?? '', t.state]
    .filter(Boolean)
    .join('  ');
}

/**
 * Resolve a user-supplied token to exactly one target. PURE — exported for unit tests.
 *
 * Matching is EXACT (case-insensitive) only: no selector-style healing tiers. Screen
 * text is unstable across builds, which is what `ui/selector.ts` heals for; device
 * names are stable, the candidate set is tiny and fully printed on failure, and
 * booting the wrong device costs minutes.
 *
 * The one narrowing step — by running-vs-not — is the SAME rule
 * `IdbDriver.resolvedSerial()` already applies (prefer booted; only error if several
 * are booted). Anything still plural is exit 2 with the candidates listed: ambiguity
 * is never auto-resolved.
 *
 * @throws CliError(1) when nothing matches, CliError(2) when the match is ambiguous.
 */
export function chooseTarget(
  targets: LifecycleTarget[],
  raw: string,
  opts: { prefer: 'startable' | 'running' },
): LifecycleTarget {
  const needle = raw.trim().toLowerCase();
  const bySerial = targets.filter((t) => t.serial.toLowerCase() === needle);
  // A serial/UDID is unique by construction, so it short-circuits the name pass.
  const matches = bySerial.length ? bySerial : targets.filter((t) => t.name.trim().toLowerCase() === needle);

  if (matches.length === 0) {
    const near = targets
      .filter((t) => t.name && t.name.toLowerCase().includes(needle))
      .map((t) => t.name);
    const hint = near.length
      ? `\nDid you mean: ${[...new Set(near)].join(', ')}?`
      : '\nRun `vk devices --all` to list startable devices.';
    throw new CliError(`No device or AVD named '${raw}'.${hint}`, 1);
  }
  if (matches.length === 1) return matches[0];

  const wanted = opts.prefer === 'running' ? matches.filter(isRunning) : matches.filter((t) => !isRunning(t));
  if (wanted.length === 1) return wanted[0];

  const candidates = (wanted.length ? wanted : matches).map(describe).join('\n');
  throw new CliError(
    `'${raw}' matches ${matches.length} devices; pass the serial/UDID instead:\n${candidates}`,
    2,
  );
}

/**
 * Reject a lifecycle action that must not run against this target. PURE — exported
 * for unit tests. `--wipe` is the only irreversible operation in verikun, so its
 * guardrails live in one place rather than being re-derived per call site.
 */
export function assertActionable(
  target: LifecycleTarget,
  verb: LifecycleVerb,
  opts: { wipe?: boolean } = {},
): void {
  if (target.kind === 'physical') {
    throw new CliError(
      `'${targetLabel(target)}' is a physical device — verikun does not power-cycle physical devices.`,
      2,
    );
  }
  if (!opts.wipe) return;
  if (verb === 'stop') {
    throw new CliError('--wipe is not valid with `vk devices stop`; use `vk devices restart <target> --wipe`.', 2);
  }
  if (verb === 'start' && isRunning(target)) {
    // `start` stays the safe, idempotent "ensure it's up" verb — erasing a live
    // device is only reachable through a verb whose name says it tears it down.
    // (It also matches the platform constraint: `simctl erase` needs a shutdown device.)
    const label = targetLabel(target);
    throw new CliError(
      `'${label}' is already running; use \`vk devices restart ${label} --wipe\` to wipe and reboot it.`,
      2,
    );
  }
}

/**
 * Stop (if running) then boot. A PRIMITIVE, not stop-then-start composed by a caller:
 * adb must see the old serial disappear — and the AVD's lock files must be released —
 * before the new instance is trustworthy, and over HTTP a composed version would drop
 * the server's device lock in the gap.
 */
export async function restartTarget(
  lc: DeviceLifecycle,
  target: LifecycleTarget,
  opts: StartOpts,
): Promise<StartResult & { stopped: boolean }> {
  let stopped = false;
  if (isRunning(target)) {
    const r = await lc.shutdown(target, { timeoutMs: DEFAULT_STOP_TIMEOUT_MS, onProgress: opts.onProgress });
    stopped = r.stopped;
  }
  const started = await lc.boot({ ...target, state: 'shutdown' }, opts);
  return { ...started, stopped };
}
