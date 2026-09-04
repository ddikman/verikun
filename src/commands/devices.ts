// `vk devices`: list what is attached (and, with --all, what is startable), and render it
// as an aligned table. This is the one place a concrete Driver is constructed outside
// getDriver() — listing needs both backends at once.

import { Flags, flagBool } from '../args';
import { claimsEnabled, summarize } from '../device/claims';
import { AdbDriver, IdbDriver } from '../drivers';
import { avdNameOf, listAvds } from '../drivers/adb';
import { err, json, out } from '../output';
import type { DeviceInfo } from '../types';

export function cmdDevices(flags: Flags): number {
  const all = flagBool(flags, 'all');
  const allDevices: DeviceInfo[] = [];
  try {
    const android = new AdbDriver().listDevices();
    // Name each running emulator by its AVD, so the listing shows the token you'd
    // pass to `vk devices stop|restart`. Best-effort: the console may not answer.
    for (const d of android) {
      if (d.kind === 'emulator') d.name = avdNameOf(d.serial) || undefined;
    }
    allDevices.push(...android);
    if (all) {
      // Startable-but-not-running AVDs have no adb address yet — they are addressed
      // by name, so `serial` stays empty rather than being invented.
      const running = new Set(android.map((d) => (d.name ?? '').toLowerCase()).filter(Boolean));
      for (const name of listAvds()) {
        if (running.has(name.toLowerCase())) continue;
        allDevices.push({ serial: '', state: 'shutdown', platform: 'android', kind: 'emulator', name });
      }
    }
  } catch (e) {
    // adb not on PATH is the common (expected) case, but surface anything else so a real
    // adb listing failure isn't hidden behind a silently-empty device list.
    err(`devices: adb backend unavailable (${(e as Error).message})`);
  }
  try {
    // By default only booted simulators (a shutdown one isn't drivable); physical
    // devices always show (they carry a note). --all lists everything startable.
    const ios = new IdbDriver().listDevices();
    allDevices.push(...(all ? ios : ios.filter((d) => d.state === 'booted' || d.note)));
  } catch (e) {
    err(`devices: iOS backend unavailable (${(e as Error).message})`);
  }

  // Who is driving what. Read-only: listing the pool must never claim a device, which is
  // what makes `vk devices` (and `vk doctor`) safe to run while surveying a busy host.
  if (claimsEnabled()) {
    for (const d of allDevices) {
      const claim = summarize(d.serial);
      if (claim) d.claim = claim;
    }
  }

  if (flagBool(flags, 'json')) {
    json(allDevices);
    return 0;
  }
  if (!allDevices.length) {
    err(all ? 'No devices or startable AVDs/simulators found.' : 'No devices found.');
    return 0;
  }
  for (const line of formatDeviceTable(allDevices)) out(line);
  return 0;
}

/**
 * Render the device list as an aligned, headed table (header line first, then one
 * line per device). Optional columns (KIND/NAME/MODEL/PRODUCT/NOTE) are dropped when no
 * device populates them; every shown cell is padded to its column width so columns line up
 * regardless of which cells are empty — the previous `.filter(Boolean).join('\t')`
 * dropped empty cells, sliding later cells into earlier tab stops. Exported for unit
 * testing.
 */
export function formatDeviceTable(devices: DeviceInfo[]): string[] {
  const columns: Array<{ header: string; get: (d: DeviceInfo) => string; optional?: boolean }> = [
    { header: 'PLATFORM', get: (d) => d.platform },
    { header: 'KIND', get: (d) => d.kind ?? '', optional: true },
    { header: 'SERIAL', get: (d) => d.serial },
    { header: 'STATE', get: (d) => d.state },
    { header: 'NAME', get: (d) => d.name ?? '', optional: true },
    { header: 'MODEL', get: (d) => d.model ?? '', optional: true },
    { header: 'PRODUCT', get: (d) => d.product ?? '', optional: true },
    // Optional like the rest, which is load-bearing twice over: nothing changes for a
    // single-user host where no device is ever claimed, and `VERIKUN_NO_CLAIM=1` renders
    // exactly the table it always did.
    { header: 'USED BY', get: (d) => d.claim?.by ?? '', optional: true },
    { header: 'NOTE', get: (d) => d.note ?? '', optional: true },
  ];
  // Drop optional columns that no device populates (e.g. NOTE for an Android-only list).
  const shown = columns.filter((c) => !c.optional || devices.some((d) => c.get(d) !== ''));
  const rows = [shown.map((c) => c.header), ...devices.map((d) => shown.map((c) => c.get(d)))];
  const widths = shown.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  // Pad every cell except the last shown column (no trailing whitespace); join with 2 spaces.
  return rows.map((r) =>
    r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd(),
  );
}
