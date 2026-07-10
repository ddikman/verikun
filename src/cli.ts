import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, sep } from 'node:path';
import { parseArgs, flagStr, flagBool, flagNum, Flags } from './args';
import { CliError, SelectorNotFoundError } from './errors';
import { runText } from './exec';
import { getDriver, AdbDriver, IdbDriver } from './drivers';
import { Driver, DeviceInfo, Element, Platform, Point } from './types';
import { parseSelector, matchElements, resolveOne, Selector, MatchTier, MatchResult } from './ui/selector';
import { formatCompact, formatTree, formatInline, toJsonShape } from './ui/format';
import { out, err, json, defaultScreenshotPath, setOutputQuiet } from './output';
import { Recorder, isRecordable } from './run';
import { downscalePng } from './image';
import { runPlan, DEFAULT_RUN_TIMEOUT_MS } from './agent/engine';
import { ClaudeProvider } from './agent/claude';
import { OpenAiProvider } from './agent/openai';
import { readPlan, writePlan, findSeed, CacheKeyInput } from './agent/cache';
import { resolveModel, parseCostOverride, priceFor, providerFor, CostTracker, DEFAULT_MAX_COST_USD } from './agent/cost';
import { Plan } from './agent/ir';
import { VERSION } from './version';

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
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(raw.trim());
  if (!m) throw new CliError(`--${flag} must be a duration like 5000, 5s, 800ms, or 15m; got '${raw}'`, 2);
  const n = Number(m[1]);
  const scale = m[2] === 's' ? 1000 : m[2] === 'm' ? 60000 : 1;
  return Math.max(0, Math.round(n * scale));
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
      throw new SelectorNotFoundError(
        `No element matched selector '${sel.raw}'${waited}. Run \`verikun ui\` to inspect the current screen.`,
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
  try {
    allDevices.push(...new AdbDriver().listDevices());
  } catch (e) {
    // adb not on PATH is the common (expected) case, but surface anything else so a real
    // adb listing failure isn't hidden behind a silently-empty device list.
    err(`devices: adb backend unavailable (${(e as Error).message})`);
  }
  try {
    // Only include booted simulators; always include physical devices (they carry a note)
    allDevices.push(...new IdbDriver().listDevices().filter((d) => d.state === 'booted' || d.note));
  } catch (e) {
    err(`devices: iOS backend unavailable (${(e as Error).message})`);
  }

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
    try {
      const r = runText('xcrun', ['simctl', 'list', 'devices', 'booted']);
      out('xcrun: present');
      out(r.stdout.trim() || '(no booted simulators)');
    } catch (e) {
      // Not necessarily missing: runText also throws on a spawn timeout or other exec
      // failure, so surface the real reason rather than always claiming "NOT FOUND".
      err(`xcrun: ${(e as Error).message}`);
      err('  (if the Xcode command-line tools are not installed: `xcode-select --install`)');
      return 3;
    }

    // idb (+ its companion) powers everything interactive: ui/tap/text/swipe/key/logs.
    const idb = process.env.IDB || 'idb';
    let idbOk = true;
    try {
      runText(idb, ['--help']); // idb has no --version; --help confirms the binary runs
      out('idb: present');
    } catch (e) {
      err(`idb: ${(e as Error).message}`);
      err('  needed for ui/tap/text/swipe/key/logs — install: `brew install idb-companion` then `pip install fb-idb`');
      idbOk = false;
    }
    try {
      runText('idb_companion', ['--help']);
      out('idb_companion: present');
    } catch (e) {
      err(`idb_companion: ${(e as Error).message}`);
      err('  install: `brew install idb-companion`');
      idbOk = false;
    }
    out('note: simulator screenshots + launch/stop work via simctl; ui/tap/text/swipe/key/logs use idb.');
    return idbOk ? 0 : 3;
  }

  const adb = process.env.ADB || 'adb';
  try {
    out('adb: ' + runText(adb, ['version']).stdout.split('\n')[0]);
  } catch (e) {
    // Not necessarily missing: runText also throws on a spawn timeout or other exec
    // failure — surface the real reason rather than always claiming "NOT FOUND".
    err(`adb: ${(e as Error).message}`);
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

/** Resolve an `--out` path and confine it to the working directory. A host-side write
 *  (a screenshot PNG, captured device logs) must never land outside cwd via a `..`
 *  traversal or an absolute path — including when driven by `vk ai` model output, whose
 *  leaf flags `validateNode` does not constrain. Exported for unit tests. */
export function confineToCwd(outFlag: string): string {
  const cwd = resolve(process.cwd());
  const path = resolve(cwd, outFlag);
  if (path !== cwd && !path.startsWith(cwd + sep)) {
    throw new CliError(`--out must stay within the current directory; '${outFlag}' resolves outside it.`, 2);
  }
  return path;
}

/** A package / bundle id is handed to `adb shell`, which re-concatenates its args into
 *  one device-side command line — so a value with shell metacharacters would inject into
 *  the device shell. Valid Android package / iOS bundle ids are only `[A-Za-z0-9._-]`;
 *  reject anything else. This is the trust gate for `launch` / `stop` / `clear`, all
 *  reachable from `vk ai` model output. Exported for unit tests. */
export function assertSafeAppId(appId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(appId)) {
    throw new CliError(`Invalid app id '${appId}': only letters, digits, '.', '_' and '-' are allowed.`, 2);
  }
  return appId;
}

function cmdScreenshot(ctx: Ctx): number {
  const raw = ctx.driver.screenshot();
  // Precedence: --full (original) > --max <px> (explicit) > --more (preset) > default.
  const maxEdge = flagNum(ctx.flags, 'max') ?? (flagBool(ctx.flags, 'more') ? MORE_SHOT_MAX_EDGE : shotMaxEdge());
  const res = flagBool(ctx.flags, 'full') ? null : downscalePng(raw, maxEdge);
  const buf = res?.scaled ? res.buf : raw;

  const outFlag = flagStr(ctx.flags, 'out');
  const path = outFlag ? confineToCwd(outFlag) : defaultScreenshotPath();
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

// --full asks for everything; cap it large-but-finite so output stays under the
// exec MAX_BUFFER (the driver still does a single bounded dump, never a stream).
const FULL_LOG_LINES = 100000;

/**
 * Pick the logcat window for `vk log`. Precedence:
 *   --since <marker>  >  -n/--lines <count>  >  --full  >  session window  >  last DEFAULT_LOG_LINES
 * The session window (the run's device-clock start, when recording past the first
 * step) is the default, so logs from before the run started are excluded.
 * Exported for unit tests.
 */
export function chooseLogOpts(
  flags: Flags,
  ctx: { appId?: string; sessionSince?: string },
): { lines?: number; appId?: string; since?: string } {
  const appId = ctx.appId;
  const sinceFlag = flagStr(flags, 'since');
  if (sinceFlag) return { since: sinceFlag, appId };
  const explicitLines = flagNum(flags, 'lines');
  if (explicitLines !== undefined) return { lines: explicitLines, appId };
  if (flagBool(flags, 'full')) return { lines: FULL_LOG_LINES, appId };
  if (ctx.sessionSince) return { since: ctx.sessionSince, appId };
  return { appId };
}

function cmdLog(ctx: Ctx): number {
  const opts = chooseLogOpts(ctx.flags, {
    appId: ctx.positionals[0], // optional package; omitted = system-wide
    sessionSince: ctx.record?.logWindowStart(),
  });
  const logs = ctx.driver.getLogs(opts);
  // Recorded so the on-demand capture lands in the archived report (when a run is active).
  ctx.record?.attachLog(logs);

  const lineCount = logs === '' ? 0 : logs.replace(/\n+$/, '').split('\n').length;
  const outFlag = flagStr(ctx.flags, 'out');
  if (outFlag) {
    // Keep --out inside the working directory (device logs can contain secrets).
    const path = confineToCwd(outFlag);
    writeFileSync(path, logs);
    if (flagBool(ctx.flags, 'json')) json({ path, bytes: Buffer.byteLength(logs), lines: lineCount });
    else out(path);
    return 0;
  }
  if (flagBool(ctx.flags, 'json')) {
    json({ logs, lines: lineCount, ...(opts.appId ? { app: opts.appId } : {}), ...(opts.since ? { since: opts.since } : {}) });
    return 0;
  }
  out(logs);
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
  if (!appId) throw new CliError('Usage: verikun launch <package|bundleId> [--clear] [--no-restart]', 2);
  assertSafeAppId(appId);
  // launch RESTARTS by default: if the app is already running/foregrounded, re-issuing
  // the launch intent just delivers it to the live (possibly mid-flow, stale) instance
  // instead of giving a fresh start — which makes reruns flaky. So we force-stop first.
  // force-stop is a no-op when the app isn't running, so no "is it running?" probe is
  // needed (and none would be portable — the iOS backend has no foreground query).
  //   --clear     wipes data first via `pm clear` (which already force-stops) → fresh install
  //   --no-restart opt out of the force-stop (just bring the existing instance forward)
  const cleared = flagBool(ctx.flags, 'clear');
  const noRestart = flagBool(ctx.flags, 'no-restart');
  if (cleared && noRestart) {
    throw new CliError('Cannot combine --clear with --no-restart: --clear wipes data and force-stops (a restart).', 2);
  }
  if (cleared) ctx.driver.clearApp(appId);
  else if (!noRestart) ctx.driver.stop(appId);
  ctx.driver.launch(appId);
  const how = cleared ? 'cleared data + launched' : noRestart ? 'launched' : 'restarted';
  ctx.record?.note({ message: `${how} ${appId}` });
  if (flagBool(ctx.flags, 'json')) json({ launched: appId, cleared, restarted: !cleared && !noRestart });
  else out(`${how} ${appId}`);
  return 0;
}

function cmdStop(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun stop <package|bundleId>', 2);
  assertSafeAppId(appId);
  ctx.driver.stop(appId);
  ctx.record?.note({ message: `stopped ${appId}` });
  out(`stopped ${appId}`);
  return 0;
}

function cmdClear(ctx: Ctx): number {
  const appId = ctx.positionals[0];
  if (!appId) throw new CliError('Usage: verikun clear <package|bundleId>', 2);
  assertSafeAppId(appId);
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
// ai — compile a natural-language test to a plan IR, then run it (self-healing)
// ---------------------------------------------------------------------------
//
// `vk ai <file>` reads a plain-English test, compiles it ONCE into a deterministic
// plan IR via the model (cached by NL + app build), then replays it with NO model
// calls on the happy path. The model is woken only to repair a step that fails to
// resolve its selector; a green run persists the (possibly repaired) plan so the
// next run is free again. Cost is bounded by --max-cost-usd. Progress streams to
// stderr (CI liveness — it never goes quiet); stdout carries the final result.

async function cmdAi(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0];
  if (!file) {
    throw new CliError('Usage: verikun ai <file> [--model m] [--max-cost-usd n] [--timeout dur] [--show-plan] [--recompile]', 2);
  }
  let nl: string;
  try {
    nl = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch (e) {
    throw new CliError(`ai: cannot read '${file}' (${(e as Error).message})`, 2);
  }
  if (!nl.trim()) throw new CliError(`ai: '${file}' is empty`, 2);

  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);

  const model = resolveModel(flagStr(flags, 'model'));
  const overrideRaw = flagStr(flags, 'cost-override');
  const override = overrideRaw ? parseCostOverride(overrideRaw) : undefined;
  const maxCostUsd = flagNum(flags, 'max-cost-usd') ?? DEFAULT_MAX_COST_USD;
  if (maxCostUsd <= 0) throw new CliError(`--max-cost-usd must be greater than 0 (got ${maxCostUsd}).`, 2);
  const cost = new CostTracker(priceFor(model, override), maxCostUsd);
  // Whole-run wall-clock ceiling (default 15m) so a runaway loop/repair can't hang the run.
  const timeoutFlag = flagStr(flags, 'timeout');
  const timeoutMs = timeoutFlag ? parseDuration(timeoutFlag, 'timeout') : DEFAULT_RUN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const effort = flagStr(flags, 'effort');

  const pkg = flagStr(flags, 'package');
  const build = flagStr(flags, 'app-build');
  const key: CacheKeyInput = { nl, pkg, build, platform };

  const recompile = flagBool(flags, 'recompile') || flagBool(flags, 'no-cache');
  const showPlan = flagBool(flags, 'show-plan');
  // Route the model to its backend; each provider reads its own key. A missing key means
  // no provider (compile/repair unavailable) — the same graceful degradation as before.
  const providerId = providerFor(model);
  const keyEnv = providerId === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = process.env[keyEnv];
  const provider = !apiKey
    ? null
    : providerId === 'openai'
      ? new OpenAiProvider({ model, apiKey, effort })
      : new ClaudeProvider({ model, apiKey, effort });

  // 1. Obtain the plan: a cache hit (free) or a compile (pays tokens; may seed from
  //    a prior build's plan to avoid a full recompile).
  const cached = recompile ? null : readPlan(key);
  let plan: Plan;
  if (cached) {
    plan = cached.plan;
    err(`[ai] plan cache hit — ${model} not called to compile`);
  } else {
    if (!provider) {
      throw new CliError(`${keyEnv} is not set — \`vk ai\` needs it to compile the test (model ${model}). Set it and retry.`, 3);
    }
    const seed = findSeed(key);
    if (seed) err(`[ai] no exact cache; seeding from a prior plan (build ${seed.build ?? 'unknown'})`);
    err(`[ai] compiling '${file}' with ${model} (effort ${effort ?? 'default'})…`);
    const compiled = await provider.compile({ nl, pkg, platform, seed: seed?.plan });
    cost.add(compiled.usage, 'compile');
    plan = compiled.plan;
    err(`[ai] compiled ${plan.steps.length} top-level step(s) · ${cost.summaryLine()}`);
    // Cache the freshly-compiled plan right away, keyed by the test-text hash, so an
    // unchanged test is never recompiled — even via --show-plan or after a failed run.
    // A green run below re-persists the healed plan; a failed run leaves this clean
    // compile cached (never a half-healed one).
    try {
      writePlan(key, plan);
    } catch (e) {
      err(`[ai] could not cache compiled plan: ${(e as Error).message}`);
    }
  }

  // 2. --show-plan: print the compiled IR and stop (no device run).
  if (showPlan) {
    json(plan);
    return 0;
  }

  // Running needs the provider for repair-on-failure; a cache hit with no key can't repair.
  if (!provider) {
    throw new CliError(`${keyEnv} is not set — \`vk ai\` needs it to repair a failing step at runtime (model ${model}).`, 3);
  }

  // The budget is a TOTAL-run ceiling: if the compile alone already crossed it, abort
  // before running. A cache hit spends nothing, so a free replay is still allowed.
  if (!cached && cost.exceeded()) {
    err(`[ai] cost ceiling $${maxCostUsd} reached during compile (${cost.summaryLine()}) — not running`);
    return 1;
  }

  // 3. One explicit run + one shared driver for the whole flow (so rollover can't
  //    split the test, and we don't rebuild a driver per step).
  const existing = Recorder.status();
  if (existing && existing.steps.length > 0) {
    // Seal the pre-existing run into the archive instead of letting start(force=true)
    // discard it — a manual in-progress run should never be silently lost.
    const sealed = Recorder.archive();
    err(`[ai] archived the active run ('${existing.name}', ${existing.steps.length} step(s)) → ${sealed.dir}`);
  }
  Recorder.start(`ai: ${basename(file)}`, platform, device, true);
  const driver = getDriver(platform, device);

  // Suppress per-step `out()` so stdout stays the one final result; progress -> stderr.
  const prevQuiet = setOutputQuiet(true);
  let result: Awaited<ReturnType<typeof runPlan>>;
  try {
    result = await runPlan(plan, {
      exec: (command, pos, f) => executeOutcome(command, pos, f, driver),
      getElements: () => driver.getElements(),
      provider,
      cost,
      log: (m) => err(m),
      markHealed: (m) => Recorder.markLastStepHealed(m),
      maxRepairs: 3,
      deadline,
    });
  } catch (e) {
    // An unexpected throw mid-run (e.g. an unrecoverable device error) must still
    // seal the run so it is not left dangling in .verikun/run/ for the next command
    // to roll over. Then let the error map to an exit code as usual.
    Recorder.annotateRun({ ai: { ok: false, cost: cost.summaryLine(), modelRepairs: 0, improvements: [] } });
    try {
      Recorder.archive();
    } catch (sealErr) {
      // Best-effort seal in an error path; surface a failure (the run state may itself be
      // unreadable) but still throw the ORIGINAL error below.
      err(`[ai] could not archive the run after a mid-run error (${(sealErr as Error).message})`);
    }
    throw e;
  } finally {
    setOutputQuiet(prevQuiet);
  }

  // 4. Persist the (possibly repaired) plan only on a fully-green run; attach the
  //    cost + improvements summary to the run; archive into the report.
  const costLine = cost.summaryLine();
  if (result.ok) {
    try {
      writePlan(key, result.plan);
      err('[ai] cached the green plan for next run');
    } catch (e) {
      err(`[ai] could not cache plan: ${(e as Error).message}`);
    }
  }
  Recorder.annotateRun({
    ai: { ok: result.ok, cost: costLine, modelRepairs: result.modelRepairs, improvements: result.improvements },
  });
  const { dir, xmlPath, htmlPath } = Recorder.archive();

  const status = result.ok
    ? 'PASS'
    : result.abortedForBudget
      ? `ABORTED — cost ceiling $${maxCostUsd} reached`
      : result.abortedForTimeout
        ? `ABORTED — run timeout (${Math.round(timeoutMs / 1000)}s) reached`
        : `FAIL at ${result.failure?.where}: ${result.failure?.reason}`;
  err(`[ai] ${status} · ${costLine}`);
  err(`[ai] report: ${htmlPath}`);
  if (result.improvements.length) {
    err(`[ai] ${result.improvements.length} suggested improvement(s) (also in the report):`);
    for (const imp of result.improvements) err('  - ' + imp);
  }
  err(`[ai] estimated total cost: $${cost.usd().toFixed(4)}`);

  if (flagBool(flags, 'json')) {
    json({
      ok: result.ok,
      model,
      cost: costLine,
      costUsd: Number(cost.usd().toFixed(4)),
      modelRepairs: result.modelRepairs,
      improvements: result.improvements,
      report: htmlPath,
      junit: xmlPath,
      runDir: dir,
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.abortedForBudget ? { abortedForBudget: true } : {}),
      ...(result.abortedForTimeout ? { abortedForTimeout: true } : {}),
    });
  } else {
    out(htmlPath); // primary machine result: the report path
  }
  return result.ok ? 0 : 1;
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
    case 'log':
    case 'logs':
      return cmdLog(ctx);
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
 * Execute one (non-meta) command and return its RAW outcome — the exit code, and
 * the thrown error if any, WITHOUT mapping it to a printed exit. The agent engine
 * (`vk ai`) uses this to tell a selector miss / ambiguity (a heal trigger: the error
 * is a SelectorNotFoundError / AmbiguousSelectorError) apart from an assertion
 * failure (`assert` *returns* exit 1, never throws — so it must never be healed, or
 * a real regression would be masked). `executeParsed` wraps it to restore the
 * print-and-exit behavior the CLI and `batch` rely on.
 *
 * An optional `sharedDriver` lets the engine reuse one device handle across many
 * commands (and its control-flow guards) instead of building a driver per call.
 */
async function executeOutcome(
  command: string,
  positionals: string[],
  flags: Flags,
  sharedDriver?: Driver,
): Promise<{ code: number; error?: Error }> {
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);

  // Recordable commands open a step (auto-starting an implicit run if needed);
  // the step is finalized with the outcome — and, on failure, screenshot + UI
  // hierarchy of the page are captured — whether the command returns or throws.
  const recordable = isRecordable(command);
  let driver: Driver | undefined = sharedDriver;
  let recorder: Recorder | null = null;
  try {
    if (!driver) driver = getDriver(platform, device);
    if (recordable) {
      // Resolve the serial up front (cheap; the driver caches it) so the run can
      // detect a device change. Tolerate failure — the handler raises the real error.
      let serial: string | undefined;
      try {
        serial = driver.resolvedSerial();
      } catch {
        /* surfaced by the command handler below */
      }
      recorder = Recorder.beginStep(command, positionals, flags, platform, device, serial, driver);
    }
    const ctx: Ctx = { driver, platform, device, positionals, flags, record: recorder ?? undefined };
    const code = await executeCommand(command, ctx);
    recorder?.finish(code, driver);
    return { code };
  } catch (e) {
    recorder?.finishError(e as Error, driver);
    return { code: e instanceof CliError ? e.exitCode : 3, error: e as Error };
  }
}

/**
 * Run one already-parsed command for the CLI / `batch`: dispatch meta-commands,
 * else execute it and map any failure to a printed exit code. This is the shared
 * per-command entry both a top-level `run()` and each `batch` line go through, so a
 * batched command behaves identically to a standalone invocation.
 */
async function executeParsed(command: string, positionals: string[], flags: Flags): Promise<number> {
  const platform = platformFromFlags(flags);
  const device = deviceFromFlags(flags, platform);

  // Meta-commands manage local state / orchestrate other commands. They build no
  // driver of their own and are dispatched before the recording machinery.
  if (command === 'run') return cmdRun(positionals, flags, platform, device);
  if (command === 'batch') return cmdBatch(positionals, flags);
  // `ai` orchestrates its own steps; map its thrown CliErrors to exit codes here
  // (usage 2 / env 3 / …) so they honor the exit-code contract instead of escaping
  // to the top-level "Fatal" handler (which would force exit 3).
  if (command === 'ai') {
    try {
      return await cmdAi(positionals, flags);
    } catch (e) {
      return mapError(e, flags);
    }
  }

  const { code, error } = await executeOutcome(command, positionals, flags);
  return error ? mapError(error, flags) : code;
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
  log [package] [-n lines] [--since t] [--out path] [--full] [--json]   Device logs (logcat snapshot)
                                      In a run, defaults to logs since the run started; -n caps lines,
                                      --since <MM-DD HH:MM:SS.mmm> overrides, --full dumps everything.
                                      Scopes to a package's process (system-wide if it has crashed);
                                      recorded into the run so it lands in the report

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
  launch <app> [--clear] [--no-restart]   stop <app>   App lifecycle (launch restarts by
                                        default — force-stops first; --clear also wipes app data)
  clear <app>                         Wipe app data — login/session, caches (fresh-install state)

BATCH (script many commands in one process)
  batch [--file path] [--quiet]       Run newline-separated commands — from --file,
                                      else piped stdin — each exactly as its own
                                      command. Streams each result to stdout; stops
                                      and propagates the exit code on the first
                                      failure. Blank lines and # comments are skipped.

AI (run a natural-language test — compile once, replay model-free, self-heal)
  ai <file> [--model m] [--max-cost-usd n] [--cost-override in/out] [--effort e]
            [--package pkg] [--app-build id] [--show-plan] [--recompile] [--json]
                                      Compile a plain-English test (<file>) into a
                                      deterministic plan, cached by NL + app build,
                                      then replay it with NO model calls on the happy
                                      path. The model is woken only to repair a step
                                      that fails to resolve; a green run persists the
                                      (repaired) plan so the next run is free. Needs
                                      ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY
                                      (gpt-5.x). Progress -> stderr; the report path ->
                                      stdout. --show-plan prints the compiled IR without
                                      running; --recompile ignores the cache.
                                      Models: claude-haiku-4-5 | claude-sonnet-4-6
                                      (default) | claude-opus-4-8 | claude-fable-5 |
                                      gpt-5.4-mini | gpt-5.4 | gpt-5.5.

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

iOS (--ios): full parity via idb — ui/tap/text/swipe/key + screenshot/launch/stop.
  Needs idb (\`brew install idb-companion\` + \`pip install fb-idb\`); see \`vk doctor --ios\`.
  Caveats: no \`clear\` (no per-app reset), \`current\` is (unknown), device logs are simulator-only.`;
}
