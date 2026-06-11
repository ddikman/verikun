import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, flagStr, flagBool, flagNum, Flags } from './args';
import { CliError } from './errors';
import { runText } from './exec';
import { getDriver, AdbDriver, SimctlDriver } from './drivers';
import { Driver, DeviceInfo, Element, Platform, Point } from './types';
import { parseSelector, matchElements, resolveOne, Selector, MatchTier, MatchResult } from './ui/selector';
import { formatCompact, formatTree, formatInline, toJsonShape } from './ui/format';
import { out, err, json, defaultScreenshotPath } from './output';
import { Recorder, isRecordable } from './run';
import { downscalePng } from './image';

const VERSION = '0.3.0';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Ctx {
  driver: Driver;
  platform: Platform;
  device?: string;
  positionals: string[];
  flags: Flags;
  /** Present when the command is being recorded into a test run. */
  record?: Recorder;
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

export function parsePoint(s: string): Point {
  const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(s.trim());
  if (!m) throw new CliError(`Expected coordinates as x,y but got '${s}'`, 2);
  return { x: +m[1], y: +m[2] };
}

/** A short note appended to action output when the selector matched non-exactly. */
export function healNote(tier: MatchTier | null): string {
  return tier && tier !== 'exact' ? ` (healed: ${tier} match)` : '';
}

// --- Auto-wait on selector lookups -----------------------------------------
// A selector-resolving command does not fail the instant a lookup misses: it
// re-captures the hierarchy and retries until the (lenient) match succeeds or a
// wait window elapses (default 5s). A straightforward flow can then skip explicit
// `wait` calls — fewer round-trips, fewer tokens — while `--no-wait` / `--wait 0`
// restores fail-fast. Ambiguity (a present-but-plural match) is never waited on:
// the elements are already there, so it surfaces at once.

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 300;

/** Parse a duration: a bare number is milliseconds (CLI convention), or `5s` / `800ms`. */
export function parseDuration(raw: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s)?$/.exec(raw.trim());
  if (!m) throw new CliError(`--${flag} must be a duration like 5000, 5s, or 800ms; got '${raw}'`, 2);
  const n = Number(m[1]);
  return Math.max(0, Math.round(m[2] === 's' ? n * 1000 : n));
}

/** Wait window (ms) for selector lookups: `--no-wait`/`--wait 0` → 0; else `--wait <dur>`, else 5s. */
export function waitWindowMs(flags: Flags): number {
  if (flagBool(flags, 'no-wait')) return 0;
  const v = flags['wait'];
  if (v === undefined || v === true) return DEFAULT_WAIT_MS; // absent, or bare `--wait` → default
  return parseDuration(String(v), 'wait');
}

/** A short note appended to a confirmation when the action had to wait for its target. */
export function waitNote(ms: number): string {
  return ms >= 100 ? ` (waited ${(ms / 1000).toFixed(1)}s)` : '';
}

/** Poll interval (ms) for auto-wait, capped so a sleep never overshoots the deadline. */
function pollStep(flags: Flags, deadline: number): number {
  const interval = flagNum(flags, 'interval') ?? DEFAULT_POLL_MS;
  return Math.min(interval, Math.max(0, deadline - Date.now()));
}

/**
 * matchElements with auto-wait: re-capture + re-match until at least one element
 * matches or the window elapses. Returns the final result either way (empty on miss).
 */
async function matchWaiting(ctx: Ctx, sel: Selector, opts: { all?: boolean } = {}): Promise<MatchResult> {
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  for (;;) {
    const res = matchElements(ctx.driver.getElements(opts), sel);
    if (res.matches.length > 0 || Date.now() >= deadline) return res;
    await sleep(pollStep(ctx.flags, deadline));
  }
}

/**
 * resolveOne with auto-wait: poll until exactly one element resolves. A hit (1) or
 * an ambiguous (>1) match returns/throws at once via resolveOne — only an empty
 * result is retried. On a final miss, throws not-found (exit 1), noting the wait.
 */
async function resolveOneWaiting(
  ctx: Ctx,
  sel: Selector,
  opts: { all?: boolean } = {},
): Promise<{ element: Element; tier: MatchTier; waitedMs: number }> {
  const windowMs = waitWindowMs(ctx.flags);
  const start = Date.now();
  const deadline = start + windowMs;
  for (;;) {
    const els = ctx.driver.getElements(opts);
    if (matchElements(els, sel).matches.length >= 1) {
      const { element, tier } = resolveOne(els, sel); // 1 → resolved; >1 → throws ambiguity
      return { element, tier, waitedMs: Date.now() - start };
    }
    if (Date.now() >= deadline) {
      const waited = windowMs > 0 ? ` after ${(windowMs / 1000).toFixed(1)}s` : '';
      throw new CliError(
        `No element matched selector '${sel.raw}'${waited}. Run \`verikun ui\` to inspect the current screen.`,
        1,
      );
    }
    await sleep(pollStep(ctx.flags, deadline));
  }
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

async function cmdFind(ctx: Ctx): Promise<number> {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const { matches, tier } = await matchWaiting(ctx, sel, { all: flagBool(ctx.flags, 'all') });
  if (flagBool(ctx.flags, 'json')) json(matches.map(toJsonShape));
  else if (!matches.length) err(`no match for '${sel.raw}'`);
  else {
    out(formatCompact(matches));
    if (tier && tier !== 'exact') err(`(healed: matched via ${tier}, not exact)`);
  }
  return matches.length ? 0 : 1;
}

async function cmdTap(ctx: Ctx): Promise<number> {
  const at = flagStr(ctx.flags, 'at');
  if (at) {
    const p = parsePoint(at);
    ctx.driver.tap(p.x, p.y);
    ctx.record?.note({ message: `tapped coordinates (${p.x},${p.y})` });
    out(`tapped (${p.x},${p.y})`);
    return 0;
  }

  const raw = ctx.positionals[0];

  // Bare integer == tap the element with that index from the latest `ui` snapshot.
  // An index points at a specific prior dump, so it is single-shot (never waited on).
  const isBareIndex =
    raw !== undefined &&
    /^\d+$/.test(raw) &&
    ctx.flags['index'] === undefined &&
    !raw.startsWith('@') &&
    !/^(id|text|desc|class):/.test(raw);

  let target: Element;
  let tier: MatchTier | null = null;
  let waitedMs = 0;
  if (isBareIndex) {
    const els = ctx.driver.getElements({ all: flagBool(ctx.flags, 'all') });
    const idx = Number(raw);
    const found = els.find((e) => e.index === idx);
    if (!found) throw new CliError(`No element with index [${idx}] on the current screen. Run \`verikun ui\`.`, 1);
    target = found;
    ctx.record?.note({ element: target, message: `tapped by index [${idx}]` });
  } else {
    const sel = buildSelector(raw, ctx.flags);
    ({ element: target, tier, waitedMs } = await resolveOneWaiting(ctx, sel, { all: flagBool(ctx.flags, 'all') }));
    ctx.record?.note({ selector: sel, tier, element: target });
  }

  ctx.driver.tap(target.center.x, target.center.y);
  out(`tapped ${formatInline(target)}${healNote(tier)}${waitNote(waitedMs)}`);
  return 0;
}

async function cmdText(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length < 2) {
    throw new CliError('Usage: verikun text <selector> <text...>  (use -- before text starting with "-")', 2);
  }
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const value = ctx.positionals.slice(1).join(' ');
  const { element: target, tier, waitedMs } = await resolveOneWaiting(ctx, sel);
  ctx.record?.note({
    selector: sel,
    tier,
    element: target,
    message: target.password ? 'typed «redacted»' : `typed ${JSON.stringify(value)}`,
  });

  ctx.driver.tap(target.center.x, target.center.y);
  // Wait for field to be focused after tap
  await sleep(100);
  if (flagBool(ctx.flags, 'clear') && target.text) {
    ctx.driver.pressKey('move_end');
    for (let i = 0; i < target.text.length + 2; i++) ctx.driver.pressKey('del');
    // Wait for field to settle after clearing before typing
    await sleep(200);
  }
  // Prime the input method with a space, then delete it, to avoid losing first character
  // (workaround for adb input text behavior where first char is sometimes lost)
  ctx.driver.inputText(' ');
  ctx.driver.pressKey('backspace');
  ctx.driver.inputText(value);
  if (flagBool(ctx.flags, 'enter')) ctx.driver.pressKey('enter');
  out(`typed ${JSON.stringify(value)} into ${formatInline(target)}${healNote(tier)}${waitNote(waitedMs)}`);
  return 0;
}

function cmdType(ctx: Ctx): number {
  const value = ctx.positionals.join(' ');
  if (!value) throw new CliError('Usage: verikun type <text...>  (types into the focused field)', 2);
  ctx.driver.inputText(value);
  if (flagBool(ctx.flags, 'enter')) ctx.driver.pressKey('enter');
  ctx.record?.note({ message: `typed ${value.length} char(s) into focused field` });
  out(`typed ${JSON.stringify(value)}`);
  return 0;
}

function cmdKey(ctx: Ctx): number {
  const name = ctx.positionals[0];
  if (!name) throw new CliError('Usage: verikun key <name|code>', 2);
  ctx.driver.pressKey(name);
  ctx.record?.note({ message: `key ${name}` });
  out(`key ${name}`);
  return 0;
}

function quickKey(ctx: Ctx, name: string): number {
  ctx.driver.pressKey(name);
  ctx.record?.note({ message: `key ${name}` });
  out(name);
  return 0;
}

async function cmdSwipe(ctx: Ctx): Promise<number> {
  const duration = flagNum(ctx.flags, 'duration') ?? 300;
  const from = flagStr(ctx.flags, 'from');
  const to = flagStr(ctx.flags, 'to');
  if (from && to) {
    const a = parsePoint(from);
    const b = parsePoint(to);
    ctx.driver.swipe(a.x, a.y, b.x, b.y, duration);
    ctx.record?.note({ message: `swiped (${a.x},${a.y})->(${b.x},${b.y})` });
    out(`swiped (${a.x},${a.y})->(${b.x},${b.y})`);
    return 0;
  }

  const dir = ctx.positionals[0];
  if (!dir) {
    throw new CliError('Usage: verikun swipe <up|down|left|right> [--on <selector>] | --from x,y --to x,y', 2);
  }

  // Region the swipe happens within: the whole screen, or one element via --on.
  let region;
  let waitedMs = 0;
  const on = flagStr(ctx.flags, 'on');
  if (on) {
    const onSel = parseSelector(on, { contains: flagBool(ctx.flags, 'contains') });
    const { element, waitedMs: w } = await resolveOneWaiting(ctx, onSel);
    waitedMs = w;
    ctx.record?.note({ selector: onSel, element });
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
  ctx.record?.note({ message: `swiped ${dir}${on ? ` on ${on}` : ''}` });
  out(`swiped ${dir}${waitNote(waitedMs)}`);
  return 0;
}

// Screenshots are downscaled by default so an agent reading them spends fewer
// tokens (image cost scales with pixel area) — we rarely need much detail to tell
// what's on screen, and text stays legible at a small size. The cap is the
// longest edge in px: the default is deliberately small; --more bumps it up,
// --max <px> sets an exact cap, VERIKUN_SHOT_MAX_EDGE changes the default, and
// --full writes the original.
const DEFAULT_SHOT_MAX_EDGE = 700;
const MORE_SHOT_MAX_EDGE = 1400;

function shotMaxEdge(): number {
  const env = process.env.VERIKUN_SHOT_MAX_EDGE;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_SHOT_MAX_EDGE;
}

function cmdScreenshot(ctx: Ctx): number {
  const raw = ctx.driver.screenshot();
  // Precedence: --full (original) > --max <px> (explicit) > --more (preset) > default.
  const maxEdge = flagNum(ctx.flags, 'max') ?? (flagBool(ctx.flags, 'more') ? MORE_SHOT_MAX_EDGE : shotMaxEdge());
  const res = flagBool(ctx.flags, 'full') ? null : downscalePng(raw, maxEdge);
  const buf = res?.scaled ? res.buf : raw;

  const outFlag = flagStr(ctx.flags, 'out');
  const path = outFlag ? resolve(process.cwd(), outFlag) : defaultScreenshotPath();
  writeFileSync(path, buf);
  ctx.record?.attachImage(buf);
  ctx.record?.note({ message: res?.scaled ? `${path} (${res.width}×${res.height})` : path });

  // Surface the one case worth knowing about: we wanted to shrink but couldn't.
  if (res && !res.scaled && res.reason?.startsWith('unsupported')) {
    err(`screenshot not downscaled: ${res.reason}`);
  }

  if (flagBool(ctx.flags, 'json')) {
    json({
      path,
      bytes: buf.length,
      ...(res?.scaled
        ? { width: res.width, height: res.height, scaledFrom: { width: res.origWidth, height: res.origHeight } }
        : {}),
    });
  } else {
    out(path);
    if (res?.scaled) err(`scaled ${res.origWidth}×${res.origHeight} -> ${res.width}×${res.height} (max edge ${maxEdge}px; --more for detail, --full for original)`);
  }
  return 0;
}

async function cmdWait(ctx: Ctx): Promise<number> {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  const gone = flagBool(ctx.flags, 'gone');
  const timeout = flagNum(ctx.flags, 'timeout') ?? 10000;
  const interval = flagNum(ctx.flags, 'interval') ?? 400;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { matches, tier } = matchElements(ctx.driver.getElements(), sel);
    if (gone ? matches.length === 0 : matches.length > 0) {
      ctx.record?.note({ selector: sel, tier, element: matches[0], message: gone ? 'gone' : `${matches.length} match(es)` });
      if (gone) out(`gone: '${sel.raw}'`);
      else out(formatCompact(matches));
      return 0;
    }
    await sleep(interval);
  }
  ctx.record?.note({ selector: sel, message: `timeout after ${timeout}ms${gone ? ' (still present)' : ' (never appeared)'}` });
  err(`timeout after ${timeout}ms waiting for '${sel.raw}'${gone ? ' to disappear' : ''}`);
  return 1;
}

/** Evaluate an assertion against a single captured snapshot. */
export function evalAssert(
  els: Element[],
  sel: Selector,
  flags: Flags,
): { pass: boolean; reason: string; matches: Element[] } {
  const { matches } = matchElements(els, sel);
  const gone = flagBool(flags, 'gone');
  const wantText = flagStr(flags, 'text');

  let pass: boolean;
  let reason: string;
  if (gone) {
    pass = matches.length === 0;
    reason = pass ? 'absent' : `still present (${matches.length})`;
  } else if (matches.length === 0) {
    pass = false;
    reason = 'not found';
  } else if (wantText !== undefined) {
    const contains = flagBool(flags, 'contains');
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
  return { pass, reason, matches };
}

async function cmdAssert(ctx: Ctx): Promise<number> {
  const sel = buildSelector(ctx.positionals[0], ctx.flags);
  // Auto-wait subsumes the common "wait then assert": poll until the assertion
  // passes or the window elapses. `--gone` therefore waits for disappearance.
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  let result = evalAssert(ctx.driver.getElements(), sel, ctx.flags);
  while (!result.pass && Date.now() < deadline) {
    await sleep(pollStep(ctx.flags, deadline));
    result = evalAssert(ctx.driver.getElements(), sel, ctx.flags);
  }
  const { pass, reason, matches } = result;

  ctx.record?.note({ selector: sel, element: matches[0], message: `${pass ? 'PASS' : 'FAIL'} — ${reason}` });
  if (flagBool(ctx.flags, 'json')) json({ pass, selector: sel.raw, reason, matches: matches.map(toJsonShape) });
  else out(`${pass ? 'PASS' : 'FAIL'} ${sel.raw} — ${reason}`);
  return pass ? 0 : 1;
}

function cmdLaunch(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun launch <package|bundleId> [--clear]', 2);
  // --clear wipes locally stored data (login/session, prefs, cache) first, so the
  // app starts in a fresh-install state. (pm clear also force-stops it before launch.)
  const cleared = flagBool(ctx.flags, 'clear');
  if (cleared) ctx.driver.clearApp(appId);
  ctx.driver.launch(appId);
  ctx.record?.note({ message: cleared ? `cleared data + launched ${appId}` : `launched ${appId}` });
  if (flagBool(ctx.flags, 'json')) json({ launched: appId, cleared });
  else out(cleared ? `cleared + launched ${appId}` : `launched ${appId}`);
  return 0;
}

function cmdStop(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun stop <package|bundleId>', 2);
  ctx.driver.stop(appId);
  ctx.record?.note({ message: `stopped ${appId}` });
  out(`stopped ${appId}`);
  return 0;
}

function cmdClear(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun clear <package|bundleId>', 2);
  ctx.driver.clearApp(appId);
  ctx.record?.note({ message: `cleared app data for ${appId}` });
  if (flagBool(ctx.flags, 'json')) json({ cleared: appId });
  else out(`cleared ${appId}`);
  return 0;
}

function cmdCurrent(ctx: Ctx): number {
  out(ctx.driver.currentApp());
  return 0;
}

// Manage the active test run. Needs no device, so it is dispatched before the
// driver is built and is itself never recorded as a step.
function cmdRun(positionals: string[], flags: Flags, platform: Platform, device?: string): number {
  const sub = (positionals[0] ?? 'status').toLowerCase();
  const asJson = flagBool(flags, 'json');
  const tally = (steps: { status: string }[]) => ({
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status !== 'passed').length,
  });

  switch (sub) {
    case 'start': {
      const state = Recorder.start(positionals[1], platform, device, flagBool(flags, 'force'));
      if (asJson) json({ started: state.id, name: state.name });
      else err(`started test run '${state.name}' (${state.id})`);
      return 0;
    }
    case 'status': {
      const state = Recorder.status();
      if (asJson) {
        json(state ?? { active: false });
        return 0;
      }
      if (!state) {
        out('no active test run');
        return 0;
      }
      const { passed, failed } = tally(state.steps);
      out(`run '${state.name}' (${state.id})${state.implicit ? ' [implicit]' : ''}: ${state.steps.length} step(s), ${passed} passed, ${failed} failed/error`);
      out(`  ${Recorder.contextLine(state)}`);
      for (const s of state.steps) out(`  #${s.index} ${s.status.toUpperCase()} ${s.name} (${s.durationMs}ms)`);
      return 0;
    }
    case 'clear':
    case 'stop':
    case 'discard': {
      const cleared = Recorder.clear();
      if (asJson) json({ cleared: cleared?.id ?? null });
      else out(cleared ? `discarded test run '${cleared.name}' (${cleared.steps.length} step(s))` : 'no active test run');
      return 0;
    }
    case 'archive':
    case 'finish':
    case 'save': {
      const { dir, xmlPath, htmlPath, state } = Recorder.archive(positionals[1]);
      const { passed, failed } = tally(state.steps);
      if (asJson) {
        json({ archived: dir, report: htmlPath, junit: xmlPath, steps: state.steps.length, passed, failed });
      } else {
        out(dir); // primary result: the archived run directory
        err(`archived '${state.name}': ${state.steps.length} step(s), ${passed} passed, ${failed} failed/error`);
        err(`  JUnit: ${xmlPath}`);
        err(`  HTML:  ${htmlPath}`);
      }
      // Exit non-zero when the run contained failures, so CI can gate on it.
      return failed > 0 ? 1 : 0;
    }
    default:
      throw new CliError(`Unknown 'run' subcommand '${sub}'. Use: start | status | archive | clear.`, 2);
  }
}

// ---------------------------------------------------------------------------
// batch — run many commands from stdin or a --file, one per line
// ---------------------------------------------------------------------------
//
// Each non-blank, non-`#` line is parsed and executed exactly as if it had been
// its own `vk` invocation: same driver resolution, same auto-wait, same recording
// into the active test run, same stdout/stderr/exit semantics. Lines run in order
// and the batch STOPS at the first command that exits non-zero, propagating that
// code — a failed step means the flow's assumptions no longer hold, so continuing
// would be meaningless ("break on an irrecoverable error"). Device/output globals
// on the `batch` call are inherited by every line unless the line sets its own.

const BATCH_GLOBALS = ['device', 'platform', 'ios', 'android', 'json'] as const;

/** Read the batch source text: --file if given, else stdin (which must be piped). */
function readBatchSource(flags: Flags): string {
  const file = flagStr(flags, 'file');
  if (file) {
    const path = resolve(process.cwd(), file);
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      throw new CliError(`batch: cannot read --file '${file}' (${(e as Error).message})`, 2);
    }
  }
  // No --file: read newline-separated commands piped on stdin. A TTY means nothing
  // was piped, so guide the caller instead of blocking forever on input.
  if (process.stdin.isTTY) {
    throw new CliError(
      'batch: no commands. Pipe them on stdin, or pass --file <path>.\n' +
        "  printf 'tap @login\\nassert text:Home\\n' | vk batch\n" +
        '  vk batch --file flow.txt',
      2,
    );
  }
  try {
    return readFileSync(0, 'utf8'); // fd 0 == stdin
  } catch (e) {
    throw new CliError(`batch: could not read stdin (${(e as Error).message})`, 2);
  }
}

/**
 * Split a batch line into argv tokens with shell-like single/double quoting and
 * backslash escapes — but WITHOUT a shell: this is pure string scanning, so a line
 * can never spawn a host process or expand a variable (the same no-host-shell rule
 * the rest of the CLI follows). Throws on an unterminated quote.
 */
export function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false; // lets an empty "" / '' still produce a real empty token
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === '"' || c === "'") {
      started = true;
      i++;
      while (i < line.length && line[i] !== c) {
        if (c === '"' && line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
          cur += line[i + 1];
          i += 2;
        } else {
          cur += line[i++];
        }
      }
      if (i >= line.length) {
        throw new CliError(`batch: unterminated ${c === '"' ? 'double' : 'single'} quote in: ${line}`, 2);
      }
      i++; // consume the closing quote
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      started = true;
      i += 2;
    } else if (c === ' ' || c === '\t') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      i++;
    } else {
      cur += c;
      started = true;
      i++;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** Globals on the `batch` call become defaults for each line (the line may override). */
export function withBatchGlobals(lineFlags: Flags, batchFlags: Flags): Flags {
  const merged: Flags = { ...lineFlags };
  for (const k of BATCH_GLOBALS) {
    if (merged[k] === undefined && batchFlags[k] !== undefined) merged[k] = batchFlags[k];
  }
  return merged;
}

async function cmdBatch(positionals: string[], batchFlags: Flags): Promise<number> {
  let source: string;
  try {
    if (positionals.length > 0) {
      throw new CliError(
        `batch: unexpected argument '${positionals[0]}'. Pipe commands on stdin or pass --file <path>.`,
        2,
      );
    }
    source = readBatchSource(batchFlags);
  } catch (e) {
    return mapError(e, batchFlags);
  }

  // Number lines first (so messages point at the true source line), then drop
  // blank lines and `#` comments.
  const all = source.split(/\r?\n/).map((text, i) => ({ n: i + 1, text: text.trim() }));
  const commands = all.filter((l) => l.text.length > 0 && !l.text.startsWith('#'));
  const quiet = flagBool(batchFlags, 'quiet');

  if (commands.length === 0) {
    err('[verikun] batch: no commands to run');
    return 0;
  }

  for (const { n, text } of commands) {
    let code: number;
    try {
      const { command, positionals: pos, flags } = parseArgs(tokenizeLine(text));
      if (!command) continue; // tokens were all flags — nothing to run
      if (command === 'batch') {
        throw new CliError(`batch: a batch line may not itself be 'batch' (line ${n})`, 2);
      }
      if (!quiet) err(`[verikun] batch ${n}: ${text}`);
      code = await executeParsed(command, pos, withBatchGlobals(flags, batchFlags));
    } catch (e) {
      // A malformed line (bad quoting, nested batch) is itself an error to halt on.
      code = mapError(e, batchFlags);
    }
    if (code !== 0) {
      err(`[verikun] batch stopped at line ${n} (\`${text}\`) — exit ${code}`);
      return code;
    }
  }
  if (!quiet) err(`[verikun] batch: ${commands.length} command(s) ok`);
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function executeCommand(command: string, ctx: Ctx): Promise<number> {
  switch (command) {
    case 'devices':
      return cmdDevices(ctx);
    case 'doctor':
      return cmdDoctor(ctx);
    case 'ui':
    case 'dump':
      return cmdUi(ctx);
    case 'find':
      return await cmdFind(ctx);
    case 'tap':
    case 'click':
      return await cmdTap(ctx);
    case 'text':
      return await cmdText(ctx);
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
      return await cmdSwipe(ctx);
    case 'screenshot':
    case 'shot':
      return cmdScreenshot(ctx);
    case 'wait':
      return await cmdWait(ctx);
    case 'assert':
      return await cmdAssert(ctx);
    case 'launch':
    case 'open':
      return cmdLaunch(ctx);
    case 'stop':
      return cmdStop(ctx);
    case 'clear':
      return cmdClear(ctx);
    case 'current':
      return cmdCurrent(ctx);
    default:
      err(`Unknown command '${command}'. Run \`verikun help\`.`);
      return 2;
  }
}

/** Map a thrown error to an exit code, emitting it as text or JSON per --json. */
function mapError(e: unknown, flags: Flags): number {
  if (e instanceof CliError) {
    if (flagBool(flags, 'json')) json({ error: e.message, exitCode: e.exitCode });
    else err(e.message);
    return e.exitCode;
  }
  err('Unexpected error: ' + (e as Error).message);
  if (process.env.VERIKUN_DEBUG) err((e as Error).stack ?? '');
  return 3;
}

/**
 * Run one already-parsed command: resolve the driver, record it if recordable,
 * execute, and map any failure to an exit code. This is the per-command core that
 * both a top-level `run()` and each `batch` line go through, so a batched command
 * behaves identically to a standalone invocation.
 */
async function executeParsed(command: string, positionals: string[], flags: Flags): Promise<number> {
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);

  // Meta-commands manage local state / orchestrate other commands. They build no
  // driver of their own and are dispatched before the recording machinery.
  if (command === 'run') return cmdRun(positionals, flags, platform, device);
  if (command === 'batch') return cmdBatch(positionals, flags);

  // Recordable commands open a step (auto-starting an implicit run if needed);
  // the step is finalized with the outcome — and, on failure, screenshot + UI
  // hierarchy of the page are captured — whether the command returns or throws.
  const recordable = isRecordable(command);
  let driver: Driver | undefined;
  let recorder: Recorder | null = null;
  try {
    driver = getDriver(platform, device);
    if (recordable) {
      // Resolve the serial up front (cheap; the driver caches it) so the run can
      // detect a device change. Tolerate failure — the handler raises the real error.
      let serial: string | undefined;
      try {
        serial = driver.resolvedSerial();
      } catch {
        /* surfaced by the command handler below */
      }
      recorder = Recorder.beginStep(command, positionals, flags, platform, device, serial);
    }
    const ctx: Ctx = { driver, platform, device, positionals, flags, record: recorder ?? undefined };
    const code = await executeCommand(command, ctx);
    recorder?.finish(code, driver);
    return code;
  } catch (e) {
    recorder?.finishError(e as Error, driver);
    return mapError(e, flags);
  }
}

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

  return executeParsed(command, positionals, flags);
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
  screenshot [--out path] [--more] [--max px] [--full] [--json]   Save a PNG (default: ./.verikun/screen.png)
                                      Downscaled to <=700px longest edge for token-cheap, legible reads;
                                      --more bumps detail (1400px), --max px sets an exact cap
                                      (VERIKUN_SHOT_MAX_EDGE changes the default), --full keeps original
  launch <app> [--clear]   stop <app>   App lifecycle (launch --clear wipes app data first)
  clear <app>                         Wipe app data — login/session, caches (fresh-install state)

BATCH (script many commands in one process)
  batch [--file path] [--quiet]       Run newline-separated commands — from --file,
                                      else piped stdin — each exactly as its own
                                      command. Streams each result to stdout; stops
                                      and propagates the exit code on the first
                                      failure. Blank lines and # comments are skipped.

ENVIRONMENT
  devices [--json]                    List attached devices/simulators
  doctor [--fix]                      Diagnose adb/device; --fix disables animations

TEST RUNS (actions are recorded; a run auto-starts on first action)
  run start [name] [--force]          Begin a named run (else one starts implicitly)
  run status                          Show the active run, its device/session, and steps
  run archive [name]                  Write JUnit + HTML report, move to ./.verikun/runs/<id>/
  run clear                           Discard the active run with no report
  An implicit run auto-closes (archives) and rolls over on a device change, a
  VERIKUN_SESSION change, or VERIKUN_RUN_IDLE_MIN minutes idle (default 30; 0 off).
  VERIKUN_NO_RUN=1 disables recording entirely.

SELECTORS
  @login          shorthand for id:login
  id:login        resource-id (full, suffix, or short name)
  text:Sign in    visible text (exact, case-insensitive)   [+ --contains for substring]
  desc:Submit     content-desc / accessibility label
  class:Button    type or full class name
  "Sign in"       bare string == text:"Sign in"
  Modifiers: --contains (substring), --index N (pick Nth match)

AUTO-WAIT (selector lookups retry until they resolve)
  Selector commands (tap, text, find, assert, swipe --on) re-poll the screen for
  up to 5s when a lookup misses, so a settling UI needs no explicit \`wait\`.
  --wait <dur>   override the window: 8s, 800ms, or bare ms (3000); 0 disables
  --no-wait      fail fast on the first miss (same as --wait 0)
  Ambiguity is never waited on (the elements are already there). The \`wait\`
  command stays for explicit polling, including --gone, with --timeout/--interval.

GLOBAL FLAGS
  -d, --device <serial>   target a specific device (or VERIKUN_DEVICE / ANDROID_SERIAL)
  -p, --platform <android|ios>   (default: android;  --ios / --android shortcuts)
  -j, --json              machine-readable output
      --                  end flag parsing (so text/args may start with '-')

EXIT CODES
  0 success · 1 not found / assertion failed / timeout · 2 usage or ambiguous selector · 3 environment error

iOS: screenshots + launch/stop work today via simctl; tap/text/swipe/hierarchy need idb (planned).`;
}
