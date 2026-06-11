import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import { Driver, DeviceInfo, Element, Platform } from '../types';
import { CliError } from '../errors';
import { runText } from '../exec';

const XCRUN = 'xcrun';

function listPhysicalDevices(): DeviceInfo[] {
  const r = runText(XCRUN, ['devicectl', 'list', 'devices']);
  if (r.code !== 0) return [];
  const lines = r.stdout.split('\n');
  const headerIdx = lines.findIndex((l) => l.includes('Identifier'));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  const nameCol = header.indexOf('Name');
  const hostCol = header.indexOf('Hostname');
  const idCol = header.indexOf('Identifier');
  const stateCol = header.indexOf('State');
  const modelCol = header.indexOf('Model');
  const devices: DeviceInfo[] = [];
  for (const line of lines.slice(headerIdx + 2)) {
    if (!line.trim() || line.startsWith('-')) continue;
    const identifier = line.slice(idCol, stateCol).trim();
    const state = line.slice(stateCol, modelCol).trim();
    const name = line.slice(nameCol, hostCol).trim();
    const model = line.slice(modelCol).trim();
    if (!identifier) continue;
    const productMatch = model.match(/\(([^)]+)\)$/);
    devices.push({
      serial: identifier,
      state,
      model: name,
      product: productMatch?.[1],
      platform: 'ios',
      note: 'physical — screenshot only, tap/ui not supported',
    });
  }
  return devices;
}

// iOS support is intentionally partial. `simctl` covers screenshots, launch,
// and stop. Full interaction (tap, swipe, type) and the accessibility hierarchy
// require WebDriverAgent (https://github.com/appium/WebDriverAgent) — the
// planned next step. WDA is an open-source XCTest HTTP server: build it once
// in Xcode, sign it with your Apple developer certificate, and run it on the
// target device or simulator. No Python required; works on both simulators and
// physical devices. The Driver seam is already in place so the command layer
// won't change when WDA support is added.
function notSupported(feature: string): never {
  throw new CliError(
    `iOS ${feature} is not supported yet.\n` +
      'Screenshots, launch, and stop work today via xcrun simctl.\n' +
      'Full interaction (tap / swipe / type) and UI hierarchy inspection are planned\n' +
      'via WebDriverAgent — build it once in Xcode and vk will drive it over HTTP.\n' +
      'See: https://github.com/appium/WebDriverAgent',
    3,
  );
}

export class SimctlDriver implements Driver {
  readonly platform: Platform = 'ios';
  private readonly udid: string;

  constructor(device?: string) {
    this.udid = device || 'booted';
  }

  listDevices(): DeviceInfo[] {
    const devices: DeviceInfo[] = [];

    // Simulators via simctl
    const { stdout } = runText(XCRUN, ['simctl', 'list', 'devices', 'available', '--json']);
    try {
      const data = JSON.parse(stdout) as {
        devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
      };
      for (const [runtime, list] of Object.entries(data.devices)) {
        for (const d of list) {
          devices.push({
            serial: d.udid,
            state: d.state.toLowerCase(),
            model: d.name,
            product: runtime.split('.').pop(),
            platform: 'ios',
          });
        }
      }
    } catch {
      /* tolerate unexpected simctl output */
    }

    // Physical devices via devicectl (Xcode 15+)
    devices.push(...listPhysicalDevices());

    return devices;
  }

  resolvedSerial(): string {
    return this.udid;
  }

  screenshot(): Buffer {
    const tmp = join(tmpdir(), `verikun-ios-${process.pid}.png`);
    const r = runText(XCRUN, ['simctl', 'io', this.udid, 'screenshot', tmp]);
    if (r.code !== 0) throw new CliError(`simctl screenshot failed: ${r.stderr.trim()}`, 3);
    const buf = readFileSync(tmp);
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return buf;
  }

  launch(appId: string): void {
    const r = runText(XCRUN, ['simctl', 'launch', this.udid, appId]);
    if (r.code !== 0) throw new CliError(`simctl launch failed: ${r.stderr.trim()}`, 3);
  }

  stop(appId: string): void {
    const r = runText(XCRUN, ['simctl', 'terminate', this.udid, appId]);
    if (r.code !== 0) throw new CliError(`simctl terminate failed: ${r.stderr.trim()}`, 3);
  }

  clearApp(appId: string): void {
    // simctl has no per-app data reset. The manual equivalent is to uninstall and
    // reinstall, which also removes the app itself — so we don't do it implicitly.
    throw new CliError(
      `iOS app-data clearing is not supported yet (requested for '${appId}').\n` +
        'simctl has no per-app data reset; uninstall + reinstall ' +
        '(`xcrun simctl uninstall <udid> <bundleId>`) is the manual equivalent, but it removes the app too.',
      3,
    );
  }

  getElements(): Element[] {
    return notSupported('hierarchy inspection');
  }
  screenSize(): { width: number; height: number } {
    return notSupported('screen size');
  }
  tap(): void {
    notSupported('tap');
  }
  swipe(): void {
    notSupported('swipe');
  }
  inputText(): void {
    notSupported('text input');
  }
  pressKey(): void {
    notSupported('key events');
  }
  currentApp(): string {
    return notSupported('current app');
  }
}
