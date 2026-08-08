// Spawn seam for the device end-to-end suite.
//
// This file lives in tests/e2e/ and has no `.test.` infix, so `node --test` never
// treats it as a test file — the same trick tests/helpers.ts uses.
//
// WHY THIS EXISTS AT ALL: `vk batch` stops at the first non-zero exit and
// propagates it, so it structurally cannot express "this SHOULD exit 2 (ambiguous
// selector)". And `vk ai` heals around exactly the failures worth observing.
// Asserting on `{code, stdout, stderr}` from the built binary is the only way to
// pin the machine contract — exit codes, heal notes, redaction — against a real
// device.
//
// ISOLATION: these tests are compiled by `npm test` (tsconfig.test.json includes
// tests/**/*.ts) but never RUN by it. The runner glob is `.test-build/tests/*.test.js`,
// a single star, which a shell does not expand across a directory boundary — so
// `.test-build/tests/e2e/*.test.js` is out of scope. That is load-bearing: it keeps
// device tests out of the device-free CI path while still type-checking them.
// If that glob ever becomes `**`, this suite lands in CI and CI goes red for
// everyone without a phone plugged in.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface VkResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The app under test — built from example/flutter-app. */
export const APP_ID = 'dev.verikun.testapp';

const BIN = resolve(process.cwd(), 'dist', 'bin', 'verikun.js');

export type Platform = 'android' | 'ios';

export const PLATFORM: Platform = process.env.VK_E2E_PLATFORM === 'ios' ? 'ios' : 'android';
const DEVICE = process.env.VK_E2E_DEVICE;

export const isAndroid = PLATFORM === 'android';

/**
 * Where a `Semantics(label:)` lands, per platform.
 *
 * Android maps it to contentDescription (vk's `desc`); iOS maps it to AXLabel,
 * which vk reads as `text`. Naming the asymmetry once here keeps it out of the
 * individual cases — everything else addresses elements by `@id`, which is the
 * one selector that means the same thing on both platforms.
 */
export function labelField(): 'desc' | 'text' {
  return PLATFORM === 'ios' ? 'text' : 'desc';
}

function platformArgs(): string[] {
  const args: string[] = [];
  if (PLATFORM === 'ios') args.push('--ios');
  // A device flag is not optional in practice: vk exits 3 when several devices
  // are attached and none is named.
  if (DEVICE) args.push('--device', DEVICE);
  return args;
}

/**
 * Run the BUILT cli and capture the outcome.
 *
 * Never throws on a non-zero exit — the exit code is the thing under test. Runs
 * `dist/bin/verikun.js` rather than the TypeScript so what is exercised is
 * exactly what a user runs.
 */
export function vk(args: string[], opts: { timeoutMs?: number; record?: boolean } = {}): VkResult {
  const env = { ...process.env };
  // Recording is its own case; by default keep the suite from filling
  // ./.verikun/run with hundreds of steps.
  if (opts.record) delete env.VERIKUN_NO_RUN;
  else env.VERIKUN_NO_RUN = '1';

  const r = spawnSync(process.execPath, [BIN, ...args, ...platformArgs()], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    env,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Parsed `vk ui --json`. NOTE: cmdUi prints a bare array, not {elements:[…]}. */
export interface UiElement {
  index: number;
  type: string;
  class: string;
  id?: string;
  text?: string;
  desc?: string;
  center: { x: number; y: number };
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable?: true;
  scrollable?: true;
  checkable?: true;
  checked?: boolean;
  focused?: true;
  password?: true;
  enabled: boolean;
  selected?: true;
  /** Absent unless the element has no pixel on screen — see toJsonShape. */
  offscreen?: true;
}

export function ui(): UiElement[] {
  const r = vk(['ui', '--json']);
  if (r.code !== 0) throw new Error(`vk ui failed (${r.code}): ${r.stderr}`);
  return JSON.parse(r.stdout) as UiElement[];
}

/**
 * Find a node by its `Semantics(identifier:)`.
 *
 * Android reports a bare id here (`vk_pass`), not the `pkg:id/name` form a native
 * app produces, so match on both shapes.
 */
export function byId(els: UiElement[], id: string): UiElement | undefined {
  return els.find((e) => e.id === id || e.id?.endsWith(`/${id}`));
}

/** Why the suite cannot run, or null when it can. Checked once per file. */
export function unavailable(): string | null {
  if (!existsSync(BIN)) return `not built — run \`npm run build\` (missing ${BIN})`;
  if (PLATFORM === 'android' && !DEVICE) {
    const devices = vk(['devices', '--json']);
    if (devices.code !== 0) return `no usable device: ${devices.stderr.trim()}`;
  }
  const launched = vk(['launch', APP_ID]);
  if (launched.code !== 0) {
    return (
      `the fixture app is not installed on the target.\n` +
      `  npm run flutter-app:${PLATFORM === 'ios' ? 'ios' : 'apk'}\n` +
      `  node dist/bin/verikun.js install <build output> ${PLATFORM === 'ios' ? '--ios' : '-d <serial>'}\n` +
      `  (vk launch said: ${launched.stderr.trim()})`
    );
  }
  return null;
}

/**
 * Put the app on a known screen.
 *
 * `vk launch` force-stops before launching, and the fixture holds no persistent
 * state, so this is a full reset on both platforms — no `pm clear` needed (which
 * is fortunate, since it throws on iOS).
 *
 * The generous first wait is deliberate: a debug Flutter build skips ~300 frames
 * on cold start, and a dump issued before first paint returns the PREVIOUS app's
 * hierarchy rather than an error. That cost an hour of confusion once already.
 */
export function openScreen(screen: 'login' | 'async' | 'scroll' | 'state' | 'device'): void {
  const launched = vk(['launch', APP_ID]);
  if (launched.code !== 0) throw new Error(`launch failed: ${launched.stderr}`);

  const home = vk(['assert', '@vk_home', '--wait', '20s']);
  if (home.code !== 0) throw new Error(`never reached home: ${home.stdout}${home.stderr}`);

  const nav = vk(['tap', `@vk_nav_${screen}`, '--wait', '10s']);
  if (nav.code !== 0) throw new Error(`could not open ${screen}: ${nav.stderr}`);

  const arrived = vk(['assert', `@vk_${screen}`, '--wait', '10s']);
  if (arrived.code !== 0) throw new Error(`${screen} did not render: ${arrived.stderr}`);
}
