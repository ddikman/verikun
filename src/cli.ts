import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, flagStr, flagBool, flagNum, Flags } from './args';
import { CliError } from './errors';
import { runText } from './exec';
import { getDriver, AdbDriver, SimctlDriver } from './drivers';
import { Driver, DeviceInfo, Element, Platform, Point } from './types';
import { parseSelector, matchElements, resolveOne, Selector, MatchTier } from './ui/selector';
import { formatCompact, formatTree, formatInline, toJsonShape } from './ui/format';
import { out, err, json, defaultScreenshotPath } from './output';

const VERSION = '0.1.0';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Ctx {
  driver: Driver;
  platform: Platform;
  device?: string;
  positionals: string[];
  flags: Flags;
}

function platformFromFlags(flags: Flags): Platform {
  if (flagBool(flags, 'ios')) return 'ios';
  if (flagBool(flags, 'android')) return 'android';
  const p = flagStr(flags, 'platform');
  if (p === 'ios' || p === 'android') return p;
  if (p) throw new CliError(`Unknown platform '${p}' (use android|ios)`, 2);
  return 'android';
}

function deviceFromFlags(flags: Flags, platform: Platform): string | undefined {
  return (
    flagStr(flags, 'device') ||
    process.env.VERIKUN_DEVICE ||
    (platform === 'android' ? process.env.ANDROID_SERIAL : undefined) ||
    undefined
  );
}

function buildSelector(raw: string | undefined, flags: Flags): Selector {
  if (!raw) {
    throw new CliError('Missing selector. e.g. `@login_button`, `text:Login`, `desc:Submit`.', 2);
  }
  return parseSelector(raw, { contains: flagBool(flags, 'contains'), index: flagNum(flags, 'index') });
}

function parsePoint(s: string): Point {
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(s.trim());
  if (!m) throw new CliError(`Expected coordinates as x,y but got '${s}'`, 2);
  return { x: +m[1], y: +m[2] };
}

/** A short note appended to action output when the selector matched non-exactly. */
function healNote(tier: MatchTier | null): string {
  return tier && tier !== 'exact' ? ` (healed: ${tier} match)` : '';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdDevices(ctx: Ctx): number {
  const allDevices: DeviceInfo[] = [];
  try { allDevices.push(...new AdbDriver().listDevices()); } catch { /* adb unavailable */ }
  try {
    // Only include booted simulators; always include physical devices (they carry a note)
    allDevices.push(...new SimctlDriver().listDevices().filter((d) => d.state === 'booted' || d.note));
  } catch { /* simctl unavailable */ }

  if (flagBool(ctx.flags, 'json')) {
    json(allDevices);
    return 0;
  }
  if (!allDevices.length) {
    err('No devices found.');
    return 0;
  }
  for (const d of allDevices) {
    out(
      [d.platform, d.serial, d.state, d.model ?? '', d.product ? `(${d.product})` : '', d.note ? `[${d.note}]` : '']
        .filter(Boolean)
        .join('\t'),
    );
  }
  return 0;
}

function cmdDoctor(ctx: Ctx): number {
  if (ctx.platform === 'ios') {
    const r = runText('xcrun', ['simctl', 'list', 'devices', 'booted']);
    out('xcrun: present');
    out(r.stdout.trim() || '(no booted simulators)');
    out('note: iOS screenshots + launch/stop work via simctl; tap/text/swipe/hierarchy need idb.');
    return 0;
  }

  const adb = process.env.ADB || 'adb';
  try {
    out('adb: ' + runText(adb, ['version']).stdout.split('\n')[0]);
  } catch {
    err('adb: NOT FOUND on PATH');
    return 3;
  }

  const devices = ctx.driver.listDevices();
  const usable = devices.filter((d) => d.state === 'device');
  out(`devices: ${devices.length} attached, ${usable.length} usable`);
  for (const d of devices) out(`  ${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}`);

  let ok = true;
  if (usable.length !== 1 && !ctx.device) {
    err(usable.length ? '  -> multiple devices: pass --device for interaction commands' : '  -> no usable device');
    ok = false;
  }

  if (usable.length === 1 || ctx.device) {
    try {
      const serial = ctx.device || usable[0].serial;
      const keys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];
      const get = (k: string) => runText(adb, ['-s', serial, 'shell', 'settings', 'get', 'global', k]).stdout.trim();
      const vals = keys.map(get);
      const off = vals.every((v) => v === '0' || v === '0.0');
      out(`animations: ${vals.join('/')} ${off ? '(off, good)' : '(ON — flaky dumps; run `verikun doctor --fix`)'}`);
      if (flagBool(ctx.flags, 'fix') && !off) {
        for (const k of keys) runText(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', k, '0']);
        out('animations: disabled (good)');
      }
    } catch {
      err('animations: could not read device settings');
    }
  }
  return ok ? 0 : 3;
}

function cmdUi(ctx: Ctx): number {
  const els = ctx.driver.getElements({ all: flagBool(ctx.flags, 'all') });
  if (flagBool(ctx.flags, 'json')) {
    json(els.map(toJsonShape));
    return 0;
  }
  out(flagBool(ctx.flags, 'tree') ? formatTree(els) : formatCompact(els));
  return 0;
}

function cmdFind(ctx: Ctx): number {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const els = ctx.driver.getElements({ all: flagBool(ctx.flags, 'all') });
  const { matches, tier } = matchElements(els, sel);
  if (flagBool(ctx.flags, 'json')) json(matches.map(toJsonShape));
  else if (!matches.length) err(`no match for '${sel.raw}'`);
  else {
    out(formatCompact(matches));
    if (tier && tier !== 'exact') err(`(healed: matched via ${tier}, not exact)`);
  }
  return matches.length ? 0 : 1;
}

function cmdTap(ctx: Ctx): number {
  const at = flagStr(ctx.flags, 'at');
  if (at) {
    const p = parsePoint(at);
    ctx.driver.tap(p.x, p.y);
    out(`tapped (${p.x},${p.y})`);
    return 0;
  }

  const raw = ctx.positionals[0];
  const els = ctx.driver.getElements({ all: flagBool(ctx.flags, 'all') });

  // Bare integer == tap the element with that index from the latest `ui` snapshot.
  const isBareIndex =
    raw !== undefined &&
    /^\d+$/.test(raw) &&
    ctx.flags['index'] === undefined &&
    !raw.startsWith('@') &&
    !/^(id|text|desc|class):/.test(raw);

  let target: Element;
  let tier: MatchTier | null = null;
  if (isBareIndex) {
    const idx = Number(raw);
    const found = els.find((e) => e.index === idx);
    if (!found) throw new CliError(`No element with index [${idx}] on the current screen. Run \`verikun ui\`.`, 1);
    target = found;
  } else {
    ({ element: target, tier } = resolveOne(els, buildSelector(raw, ctx.flags)));
  }

  ctx.driver.tap(target.center.x, target.center.y);
  out(`tapped ${formatInline(target)}${healNote(tier)}`);
  return 0;
}

function cmdText(ctx: Ctx): number {
  if (ctx.positionals.length < 2) {
    throw new CliError('Usage: verikun text <selector> <text...>  (use -- before text starting with "-")', 2);
  }
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const value = ctx.positionals.slice(1).join(' ');
  const { element: target, tier } = resolveOne(ctx.driver.getElements(), sel);

  ctx.driver.tap(target.center.x, target.center.y);
  if (flagBool(ctx.flags, 'clear') && target.text) {
    ctx.driver.pressKey('move_end');
    for (let i = 0; i < target.text.length + 2; i++) ctx.driver.pressKey('del');
  }
  ctx.driver.inputText(value);
  if (flagBool(ctx.flags, 'enter')) ctx.driver.pressKey('enter');
  out(`typed ${JSON.stringify(value)} into ${formatInline(target)}${healNote(tier)}`);
  return 0;
}

function cmdType(ctx: Ctx): number {
  const value = ctx.positionals.join(' ');
  if (!value) throw new CliError('Usage: verikun type <text...>  (types into the focused field)', 2);
  ctx.driver.inputText(value);
  if (flagBool(ctx.flags, 'enter')) ctx.driver.pressKey('enter');
  out(`typed ${JSON.stringify(value)}`);
  return 0;
}

function cmdKey(ctx: Ctx): number {
  const name = ctx.positionals[0];
  if (!name) throw new CliError('Usage: verikun key <name|code>', 2);
  ctx.driver.pressKey(name);
  out(`key ${name}`);
  return 0;
}

function quickKey(ctx: Ctx, name: string): number {
  ctx.driver.pressKey(name);
  out(name);
  return 0;
}

function cmdSwipe(ctx: Ctx): number {
  const duration = flagNum(ctx.flags, 'duration') ?? 300;
  const from = flagStr(ctx.flags, 'from');
  const to = flagStr(ctx.flags, 'to');
  if (from && to) {
    const a = parsePoint(from);
    const b = parsePoint(to);
    ctx.driver.swipe(a.x, a.y, b.x, b.y, duration);
    out(`swiped (${a.x},${a.y})->(${b.x},${b.y})`);
    return 0;
  }

  const dir = ctx.positionals[0];
  if (!dir) {
    throw new CliError('Usage: verikun swipe <up|down|left|right> [--on <selector>] | --from x,y --to x,y', 2);
  }

  // Region the swipe happens within: the whole screen, or one element via --on.
  let region;
  const on = flagStr(ctx.flags, 'on');
  if (on) {
    const { element } = resolveOne(ctx.driver.getElements(), parseSelector(on, { contains: flagBool(ctx.flags, 'contains') }));
    region = element.bounds;
  } else {
    const { width, height } = ctx.driver.screenSize();
    region = { x1: 0, y1: 0, x2: width, y2: height };
  }

  const cx = Math.floor((region.x1 + region.x2) / 2);
  const cy = Math.floor((region.y1 + region.y2) / 2);
  const frac = Math.min(Math.max(flagNum(ctx.flags, 'distance') ?? 0.6, 0.1), 0.95);
  const dx = Math.floor(((region.x2 - region.x1) * frac) / 2);
  const dy = Math.floor(((region.y2 - region.y1) * frac) / 2);

  let a: Point;
  let b: Point;
  switch (dir) {
    case 'up':
      a = { x: cx, y: cy + dy };
      b = { x: cx, y: cy - dy };
      break;
    case 'down':
      a = { x: cx, y: cy - dy };
      b = { x: cx, y: cy + dy };
      break;
    case 'left':
      a = { x: cx + dx, y: cy };
      b = { x: cx - dx, y: cy };
      break;
    case 'right':
      a = { x: cx - dx, y: cy };
      b = { x: cx + dx, y: cy };
      break;
    default:
      throw new CliError(`Unknown direction '${dir}' (use up|down|left|right)`, 2);
  }
  ctx.driver.swipe(a.x, a.y, b.x, b.y, duration);
  out(`swiped ${dir}`);
  return 0;
}

function cmdScreenshot(ctx: Ctx): number {
  const buf = ctx.driver.screenshot();
  const outFlag = flagStr(ctx.flags, 'out');
  const path = outFlag ? resolve(process.cwd(), outFlag) : defaultScreenshotPath();
  writeFileSync(path, buf);
  if (flagBool(ctx.flags, 'json')) json({ path, bytes: buf.length });
  else out(path);
  return 0;
}

async function cmdWait(ctx: Ctx): Promise<number> {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const gone = flagBool(ctx.flags, 'gone');
  const timeout = flagNum(ctx.flags, 'timeout') ?? 10000;
  const interval = flagNum(ctx.flags, 'interval') ?? 400;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { matches } = matchElements(ctx.driver.getElements(), sel);
    if (gone ? matches.length === 0 : matches.length > 0) {
      if (gone) out(`gone: '${sel.raw}'`);
      else out(formatCompact(matches));
      return 0;
    }
    await sleep(interval);
  }
  err(`timeout after ${timeout}ms waiting for '${sel.raw}'${gone ? ' to disappear' : ''}`);
  return 1;
}

function cmdAssert(ctx: Ctx): number {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const { matches } = matchElements(ctx.driver.getElements(), sel);
  const gone = flagBool(ctx.flags, 'gone');
  const wantText = flagStr(ctx.flags, 'text');

  let pass: boolean;
  let reason: string;
  if (gone) {
    pass = matches.length === 0;
    reason = pass ? 'absent' : `still present (${matches.length})`;
  } else if (matches.length === 0) {
    pass = false;
    reason = 'not found';
  } else if (wantText !== undefined) {
    const contains = flagBool(ctx.flags, 'contains');
    pass = matches.some((m) =>
      contains
        ? m.text.toLowerCase().includes(wantText.toLowerCase())
        : m.text.trim().toLowerCase() === wantText.trim().toLowerCase(),
    );
    reason = pass ? 'text matched' : `found, but text != ${JSON.stringify(wantText)} (got ${JSON.stringify(matches.map((m) => m.text))})`;
  } else {
    pass = true;
    reason = `found ${matches.length}`;
  }

  if (flagBool(ctx.flags, 'json')) json({ pass, selector: sel.raw, reason, matches: matches.map(toJsonShape) });
  else out(`${pass ? 'PASS' : 'FAIL'} ${sel.raw} — ${reason}`);
  return pass ? 0 : 1;
}

function cmdLaunch(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun launch <package|bundleId>', 2);
  ctx.driver.launch(appId);
  out(`launched ${appId}`);
  return 0;
}

function cmdStop(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun stop <package|bundleId>', 2);
  ctx.driver.stop(appId);
  out(`stopped ${appId}`);
  return 0;
}

function cmdCurrent(ctx: Ctx): number {
  out(ctx.driver.currentApp());
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function run(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  if (flagBool(flags, 'version') || command === 'version') {
    out(VERSION);
    return 0;
  }
  if (!command || command === 'help' || flagBool(flags, 'help')) {
    out(usageText());
    return command && command !== 'help' && !flagBool(flags, 'help') ? 2 : 0;
  }

  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);

  try {
    const ctx: Ctx = { driver: getDriver(platform, device), platform, device, positionals, flags };
    switch (command) {
      case 'devices':
        return cmdDevices(ctx);
      case 'doctor':
        return cmdDoctor(ctx);
      case 'ui':
      case 'dump':
        return cmdUi(ctx);
      case 'find':
        return cmdFind(ctx);
      case 'tap':
      case 'click':
        return cmdTap(ctx);
      case 'text':
        return cmdText(ctx);
      case 'type':
        return cmdType(ctx);
      case 'key':
        return cmdKey(ctx);
      case 'back':
        return quickKey(ctx, 'back');
      case 'home':
        return quickKey(ctx, 'home');
      case 'enter':
        return quickKey(ctx, 'enter');
      case 'swipe':
      case 'scroll':
        return cmdSwipe(ctx);
      case 'screenshot':
      case 'shot':
        return cmdScreenshot(ctx);
      case 'wait':
        return await cmdWait(ctx);
      case 'assert':
        return cmdAssert(ctx);
      case 'launch':
      case 'open':
        return cmdLaunch(ctx);
      case 'stop':
        return cmdStop(ctx);
      case 'current':
        return cmdCurrent(ctx);
      default:
        err(`Unknown command '${command}'. Run \`verikun help\`.`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (flagBool(flags, 'json')) json({ error: e.message, exitCode: e.exitCode });
      else err(e.message);
      return e.exitCode;
    }
    err('Unexpected error: ' + (e as Error).message);
    if (process.env.VERIKUN_DEBUG) err((e as Error).stack ?? '');
    return 3;
  }
}

function usageText(): string {
  return `verikun ${VERSION} — drive simulators/devices for AI agents (Puppeteer-style).

USAGE
  verikun <command> [args] [flags]

INSPECT (semantic hierarchy — the core feature)
  ui [--all] [--tree] [--json]        Compact list of interactive/labeled elements
  find <selector> [--json]            Print elements matching a selector (exit 1 if none)
  assert <selector> [--text S] [--gone]   Assertion for tests (exit 0 pass / 1 fail)
  wait <selector> [--timeout ms] [--interval ms] [--gone]   Poll until match/absent
  current                             Foreground app/activity

ACT
  tap <selector|index> | --at x,y     Tap an element (or raw coordinates)
  text <selector> <text...> [--clear] [--enter]   Focus a field and type
  type <text...> [--enter]            Type into the currently focused field
  key <name|code> | back | home | enter            Send a key event
  swipe <up|down|left|right> [--on <selector>] [--distance f] [--duration ms]
  swipe --from x,y --to x,y [--duration ms]
  screenshot [--out path] [--json]    Save a PNG (default: ./.verikun/screen.png)
  launch <app>   stop <app>           App lifecycle (package id / bundle id)

ENVIRONMENT
  devices [--json]                    List attached devices/simulators
  doctor [--fix]                      Diagnose adb/device; --fix disables animations

SELECTORS
  @login          shorthand for id:login
  id:login        resource-id (full, suffix, or short name)
  text:Sign in    visible text (exact, case-insensitive)   [+ --contains for substring]
  desc:Submit     content-desc / accessibility label
  class:Button    type or full class name
  "Sign in"       bare string == text:"Sign in"
  Modifiers: --contains (substring), --index N (pick Nth match)

GLOBAL FLAGS
  -d, --device <serial>   target a specific device (or VERIKUN_DEVICE / ANDROID_SERIAL)
  -p, --platform <android|ios>   (default: android;  --ios / --android shortcuts)
  -j, --json              machine-readable output
      --                  end flag parsing (so text/args may start with '-')

EXIT CODES
  0 success · 1 not found / assertion failed / timeout · 2 usage or ambiguous selector · 3 environment error

iOS: screenshots + launch/stop work today via simctl; tap/text/swipe/hierarchy need idb (planned).`;
}
