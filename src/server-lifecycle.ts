import { spawnCollect } from './exec';
import { parseAdbDevices } from './drivers/adb';
import { parseSimulatorList, parsePhysicalDevices } from './drivers/ios';
// The device-lifecycle seam `buildServer` is injected with — start / restart / stop / list
// by name — and its production implementation over drivers/lifecycle.ts. Kept apart from
// the server so the interface the unit suite fakes and the real one live side by side.

import { assertActionable, chooseTarget, lifecycleFor, restartTarget } from './drivers/lifecycle';
import { CliError } from './errors';
import type { DeviceInfo, Platform } from './types';

/** The lifecycle operations the server needs, injected so buildServer is testable
 *  without a device (mirrors SuiteDeps / EngineDeps). */
export interface ServerLifecycle {
  start(platform: Platform, target: string, opts: LifecycleOpts): Promise<{ serial: string; started: boolean }>;
  restart(platform: Platform, target: string, opts: LifecycleOpts): Promise<{ serial: string }>;
  stop(platform: Platform, target: string, opts: LifecycleOpts): Promise<void>;
  list(platform: Platform): DeviceInfo[];
}

export interface LifecycleOpts {
  timeoutMs: number;
  wipe?: boolean;
  onProgress?: (message: string) => void;
}

/** The production lifecycle, over drivers/lifecycle.ts. Every path re-resolves the
 *  target against the LIVE device list rather than trusting the current binding —
 *  both drivers accept a pinned `--device` without probing, so "bound" never implies
 *  "alive". `started: false` is therefore the lifecycle layer's verdict, not a
 *  serial comparison the server makes. */
export const realLifecycle: ServerLifecycle = {
  async start(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'startable' });
    assertActionable(chosen, 'start', { wipe: opts.wipe });
    const r = await lc.boot(chosen, { timeoutMs: opts.timeoutMs, wait: true, wipe: !!opts.wipe, onProgress: opts.onProgress });
    if (!r.serial) throw new CliError(`'${target}' started but reported no serial`, 3);
    return { serial: r.serial, started: r.started };
  },
  async restart(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'running' });
    assertActionable(chosen, 'restart', { wipe: opts.wipe });
    const r = await restartTarget(lc, chosen, { timeoutMs: opts.timeoutMs, wait: true, wipe: !!opts.wipe, onProgress: opts.onProgress });
    if (!r.serial) throw new CliError(`'${target}' restarted but reported no serial`, 3);
    return { serial: r.serial };
  },
  async stop(platform, target, opts) {
    const lc = lifecycleFor(platform);
    const chosen = chooseTarget(lc.targets(), target, { prefer: 'running' });
    assertActionable(chosen, 'stop');
    await lc.shutdown(chosen, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress });
  },
  list(platform) {
    return lifecycleFor(platform)
      .targets()
      .map((t) => ({
        serial: t.serial,
        state: t.state,
        platform: t.platform,
        kind: t.kind,
        name: t.name || undefined,
        product: t.runtime,
      }));
  },
};

/** Host enumeration must not block HTTP while a device or adb is wedged. */
export async function listDevicesAsync(platform: Platform): Promise<DeviceInfo[]> {
  if (platform === 'android') {
    const r = await spawnCollect(process.env.ADB || 'adb', ['devices', '-l'], { timeout: 5000 });
    if (r.code !== 0) throw new CliError(r.stderr || 'adb enumeration failed', 3);
    return parseAdbDevices(r.stdout);
  }
  const [sim, phone] = await Promise.all([
    spawnCollect(process.env.XCRUN || 'xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { timeout: 5000 }),
    spawnCollect(process.env.XCRUN || 'xcrun', ['devicectl', 'list', 'devices'], { timeout: 5000 }),
  ]);
  return [...(sim.code === 0 ? parseSimulatorList(sim.stdout) : []), ...(phone.code === 0 ? parsePhysicalDevices(phone.stdout) : [])];
}
