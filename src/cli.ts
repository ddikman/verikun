import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, sep, join } from 'node:path';
import { parseArgs, flagStr, flagBool, flagNum, Flags } from './args';
import { CliError, NoWindowError, SelectorNotFoundError, isEnvError } from './errors';
import { runText, commandExists } from './exec';
import { getDriver, AdbDriver, IdbDriver, probeAdb, probeXcrun, probeIdb, probeIdbCompanion } from './drivers';
import { adbTransport, severanceRisk, avdNameOf, listAvds } from './drivers/adb';
import {
  allLifecycles, assertActionable, chooseTarget, isRunning, lifecycleFor, restartTarget, targetLabel,
  LifecycleTarget, LifecycleVerb,
} from './drivers/lifecycle';
import { Bounds, Driver, DeviceInfo, Element, HierarchySource, Platform, Point, ToolProbe } from './types';
import {
  SETTINGS,
  SETTING_KEYS,
  SettingKey,
  Support,
  checkSupport,
  isSettingKey,
  parseDeviceAssignments,
} from './device/settings';
import {
  claimsEnabled,
  describeClaim,
  releaseClaim,
  releaseOwnClaims,
  setProcessScoped,
  summarize,
  touchClaim,
} from './device/claims';
import {
  parseSelector,
  matchElements,
  resolveOne,
  Selector,
  MatchTier,
  MatchResult,
  StateFilter,
  STATE_ATTRS,
} from './ui/selector';
import { assertStateSupported } from './ui/state-support';
import { formatCompact, formatTree, formatInline, toJsonShape } from './ui/format';
import {
  Direction,
  DEFAULT_SWIPE_FRACTION,
  clipRegion,
  isFullyVisible,
  isOccluded,
  isOffscreen,
  screenRect,
  reachablePoint,
  scrollPlan,
  scrollSurface,
  swipeDurationMs,
  swipeVector,
  tapPoint,
  visibleFraction,
} from './ui/viewport';
import { out, err, json, defaultScreenshotPath, setOutputQuiet } from './output';
import { Recorder, isRecordable, RunStep, archiveLogWindow, wantsArchiveLogs, inferRunAppId } from './run';
import { capturePng } from './capture';
import { Companion, companionEnabled } from './companion/manager';
import { runPlan, DEFAULT_RUN_TIMEOUT_MS, DEFAULT_GUARD_SETTLE_MS } from './agent/engine';
import { lintPlan } from './agent/lint';
import { ClaudeProvider } from './agent/claude';
import { OpenAiProvider } from './agent/openai';
import { CliProvider, CliAgentSpec, CODEX_SPEC, CURSOR_SPEC } from './agent/cli-provider';
import { AgentProvider } from './agent/provider';
import { readPlan, writePlan, findSeed, CacheKeyInput } from './agent/cache';
import { resolveModel, parseCostOverride, priceFor, providerFor, CostTracker, DEFAULT_MAX_COST_USD, Price, ProviderId } from './agent/cost';
import { Plan } from './agent/ir';
import { ExecBackend, HealthResponse } from './rpc';
import { createRemoteBackend, pingServer, remoteDeviceList, remoteDeviceOp, RemoteOpts } from './agent/remote';
import { cmdSuite, AiRunResult } from './suite';
import { sleep, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS } from './wait';
import { VERSION } from './version';
import { updateProbes } from './update-check';

interface Ctx {
  driver: Driver;
  platform: Platform;
  device?: string;
  positionals: string[];
  flags: Flags;
  /** Present when the command is being recorded into a test run. */
  record?: Recorder;
}

// Exported for src/server.ts (which resolves its own platform/device at startup).
export function platformFromFlags(flags: Flags): Platform {
  if (flagBool(flags, 'ios')) return 'ios';
  if (flagBool(flags, 'android')) return 'android';
  const p = flagStr(flags, 'platform');
  if (p === 'ios' || p === 'android') return p;
  if (p) throw new CliError(`Unknown platform '${p}' (use android|ios)`, 2);
  return 'android';
}

export function deviceFromFlags(flags: Flags, platform: Platform): string | undefined {
  return (
    flagStr(flags, 'device') ||
    process.env.VERIKUN_DEVICE ||
    (platform === 'android' ? process.env.ANDROID_SERIAL : undefined) ||
    undefined
  );
}

/**
 * Read the `--enabled` / `--not-enabled` / `--selected` / … pairs off the flags.
 *
 * An ABSENT flag must stay `undefined`, never `false`: these modifiers are tri-state
 * ("must be" / "must not be" / "don't care"), so passing `flagBool()` straight through —
 * which is what this replaced — would quietly turn every selector on every command into
 * "must be disabled, unselected, unchecked and unfocused".
 */
export function stateFromFlags(flags: Flags): StateFilter {
  const state: StateFilter = {};
  for (const attr of STATE_ATTRS) {
    const yes = flagBool(flags, attr);
    const no = flagBool(flags, `not-${attr}`);
    if (yes && no) throw new CliError(`Cannot combine --${attr} with --not-${attr}.`, 2);
    if (yes) state[attr] = true;
    else if (no) state[attr] = false;
  }
  return state;
}

function buildSelector(ctx: Ctx, raw: string | undefined): Selector {
  if (!raw) {
    throw new CliError('Missing selector. e.g. `@login_button`, `text:Login`, `desc:Submit`.', 2);
  }
  const sel = parseSelector(raw, {
    contains: flagBool(ctx.flags, 'contains'),
    index: flagNum(ctx.flags, 'index'),
    ...stateFromFlags(ctx.flags),
  });
  // Every command's selector — and so every `vk ai` leaf, which reaches these handlers
  // through executeOutcome — funnels through here, which is why the platform check lives
  // at this seam rather than in the (platform-free) selector layer.
  assertStateSupported(sel, ctx.platform);
  return sel;
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
 * Read the hierarchy for a caller that is polling, treating "no window yet" as "nothing on
 * screen yet" rather than a fatal environment error.
 *
 * A `NoWindowError` means the device genuinely had nothing to show — `launch --clear` and
 * `launch` both leave a gap where the app has been stopped and has not drawn. That clears in
 * a second or two, so a caller that has a wait budget should keep polling; escalating to
 * exit 3 throws away the budget it was explicitly given. MEASURED: a `wait --timeout 120000`
 * used to abort at ~20s with 100 seconds unspent.
 *
 * Every OTHER capture failure still propagates untouched — a missing adb, an unauthorised
 * device or a wedged dumper is a machine to fix, and polling it for two minutes helps nobody.
 */
function readForPoll(ctx: Ctx, opts: { all?: boolean } = {}): Element[] {
  try {
    return ctx.driver.getElements(opts);
  } catch (e) {
    if (e instanceof NoWindowError) return [];
    throw e;
  }
}

/**
 * matchElements with auto-wait: re-capture + re-match until at least one element
 * matches or the window elapses. Returns the final result either way (empty on miss).
 */
async function matchWaiting(ctx: Ctx, sel: Selector, opts: { all?: boolean } = {}): Promise<MatchResult> {
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  for (;;) {
    const res = matchElements(readForPoll(ctx, opts), sel);
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
): Promise<{ element: Element; tier: MatchTier; waitedMs: number; elements: Element[] }> {
  const windowMs = waitWindowMs(ctx.flags);
  const start = Date.now();
  const deadline = start + windowMs;
  for (;;) {
    const els = readForPoll(ctx, opts);
    if (matchElements(els, sel).matches.length >= 1) {
      const { element, tier } = resolveOne(els, sel); // 1 → resolved; >1 → throws ambiguity
      // The snapshot rides along: scroll-into-view needs the scrollable containers
      // from the SAME dump the element came from, and re-capturing to find them
      // would both cost a round-trip and risk describing a screen that moved on.
      return { element, tier, waitedMs: Date.now() - start, elements: els };
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

// --- Auto scroll-into-view --------------------------------------------------
// An element's centre is not always a point that reaches it, and a tap on the
// wrong point still reported success — so the run carried on from the wrong place
// and failed several steps later on an unrelated symptom (issue #42). Actions
// therefore bring their target into the clear first, the same contract as
// Playwright's scrollIntoViewIfNeeded.
//
// MEASURED, and it is not only the obvious case: Android's dumper already drops
// nodes it considers invisible and clips the rest to the display, so the usual
// shape is an element that IS on screen — a row cut off by its list, or one with a
// sticky bar drawn across its middle. Both are handled by asking the question
// against `clipRegion()` (screen ∩ scroll container) and `isOccluded()` (what is
// painted after it), not against the screen alone.
//
// Load-bearing split, mirroring auto-wait: ACTIONS scroll, INSPECTION does not.
// `ui`/`find`/`assert` report an element exactly as it is (tagged `offscreen` when
// it has no pixel on screen) — hiding it would turn a wrong tap into a mysterious
// miss — while `tap`/`text` refuse to press a point that would hit something else.
//
// Scrolling only ever happens when the alternative is a wrong tap, so a target
// already in the clear costs nothing: no extra dump, no swipe.

const SCROLL_INTO_VIEW_MAX = 10;
/** Let the scroll settle before re-dumping — a mid-fling hierarchy reads as a stall. */
const SCROLL_SETTLE_MS = 500;
/** Movement below this is measurement noise, not progress. */
const NO_PROGRESS_PX = 8;
/** Consecutive non-moving swipes before we accept the list will not go further. */
const NO_PROGRESS_STRIKES = 2;

/** A short note appended to action output when the target had to be scrolled to. */
export function scrollNote(swipes: number): string {
  return swipes > 0 ? ` (scrolled into view: ${swipes} swipe${swipes === 1 ? '' : 's'})` : '';
}

/** Swipe until `target` sits fully inside its clip region, or we run out of room. */
async function scrollIntoView(
  ctx: Ctx,
  sel: Selector,
  target: Element,
  elements: Element[],
  screen: Bounds,
  opts: { all?: boolean } = {},
): Promise<{ element: Element; swipes: number; elements: Element[] }> {
  let current = target;
  let snapshot = elements;
  let swipes = 0;
  let stalled = 0;

  while (swipes < SCROLL_INTO_VIEW_MAX && stalled < NO_PROGRESS_STRIKES) {
    // Re-derived every iteration: scrolling can change which container holds the
    // element, and a stale clip would aim the next swipe at the wrong box.
    const clip = clipRegion(snapshot, current, screen);
    const axis =
      Math.abs(current.center.y - (clip.y1 + clip.y2) / 2) >= Math.abs(current.center.x - (clip.x1 + clip.x2) / 2)
        ? 'y'
        : 'x';
    // A covered element is scrolled to the MIDDLE of its container even though it is
    // technically in view: a sticky bar overlaps the edges of a list, and moving the
    // target away from them is the one reliable way to get a touch through to it.
    const centre = isOccluded(snapshot, current, tapPoint(current, screen));
    const plan = scrollPlan(current.bounds, scrollSurface(snapshot, current, screen, axis), clip, { centre });
    if (!plan) break; // in view, or no swipe big enough to be worth making

    ctx.driver.swipe(plan.from.x, plan.from.y, plan.to.x, plan.to.y, swipeDurationMs(plan.distance));
    swipes++;
    await sleep(SCROLL_SETTLE_MS);

    const before = current.bounds;
    snapshot = ctx.driver.getElements(opts);
    // An empty tree is a bad read, not a screen (the device returns partial dumps
    // mid-transition) — retry rather than conclude the element is gone.
    if (snapshot.length === 0) continue;
    if (matchElements(snapshot, sel).matches.length === 0) {
      // Android drops a node that scrolls out of view, so overshooting LOSES the
      // target rather than leaving it visibly off-position. Give the last swipe back
      // (half of it, to land between the two) and look once more before giving up.
      const mid = { x: Math.round((plan.from.x + plan.to.x) / 2), y: Math.round((plan.from.y + plan.to.y) / 2) };
      ctx.driver.swipe(plan.to.x, plan.to.y, mid.x, mid.y, swipeDurationMs(plan.distance / 2));
      await sleep(SCROLL_SETTLE_MS);
      snapshot = ctx.driver.getElements(opts);
      if (matchElements(snapshot, sel).matches.length === 0) {
        throw new SelectorNotFoundError(
          `'${sel.raw}' left the hierarchy while being scrolled into view (after ${swipes} swipe(s)) — ` +
            'a lazy list may have recycled it. Run `verikun ui` to inspect the current screen.',
        );
      }
    }
    current = resolveOne(snapshot, sel).element; // >1 → ambiguity, exit 2, as everywhere else
    const moved = Math.abs(
      plan.axis === 'y' ? current.bounds.y1 - before.y1 : current.bounds.x1 - before.x1,
    );
    stalled = moved < NO_PROGRESS_PX ? stalled + 1 : 0;
  }
  return { element: current, swipes, elements: snapshot };
}

interface ActionTarget {
  element: Element;
  tier: MatchTier | null;
  waitedMs: number;
  swipes: number;
  /** Where to press: inside the element's visible part, and clear of anything drawn
   *  over it where we can find such a point. */
  point: Point;
}

/** The screen as a rectangle, or null on a device whose size could not be read. */
function screenOf(ctx: Ctx): Bounds | null {
  const vp = ctx.driver.viewport();
  return vp ? screenRect(vp) : null;
}

/** The point to press for `el`, preferring one nothing else is drawn over. Falls back
 *  to the visible centre — an ordering-based guess must never block a real tap. */
function pressPoint(els: Element[], el: Element, screen: Bounds | null): Point {
  if (!screen) return el.center;
  return reachablePoint(els, el, screen) ?? tapPoint(el, screen);
}

/** Say so when the element we are about to press is only partly on screen, or is
 *  covered by something drawn over it — both mean the touch may not reach it. */
function reachWarning(els: Element[], el: Element, screen: Bounds | null): void {
  if (!screen) return;
  if (!isFullyVisible(el.bounds, screen)) {
    err(`(only ${Math.round(visibleFraction(el.bounds, screen) * 100)}% of ${formatInline(el)} is on screen)`);
  }
  if (!reachablePoint(els, el, screen)) {
    err(`(${formatInline(el)} is covered by another element — the tap may land on whatever is on top)`);
  }
}

/**
 * Resolve a selector to something that can actually be pressed: wait for it, scroll it
 * into view when it is not fully inside its scroll container, and fail loudly rather
 * than tap blind.
 *
 * When the screen size is unknown this is exactly the old behaviour — resolve and
 * press the element's centre.
 */
async function resolveTappable(ctx: Ctx, sel: Selector, opts: { all?: boolean } = {}): Promise<ActionTarget> {
  const { element, tier, waitedMs, elements } = await resolveOneWaiting(ctx, sel, opts);
  const screen = screenOf(ctx);
  const clip = screen ? clipRegion(elements, element, screen) : null;
  // Scroll when the element is cut off by its container, and also when something is
  // drawn over the point we would press — but only if it HAS a container to scroll
  // (clip !== screen). Swiping the whole screen at a covered toolbar button would be
  // a random gesture, and the point-picking fallback below handles that case.
  const covered =
    !!screen && !!clip && clip !== screen && isOccluded(elements, element, tapPoint(element, screen));
  if (!screen || !clip || (isFullyVisible(element.bounds, clip) && !covered)) {
    reachWarning(elements, element, screen);
    return { element, tier, waitedMs, swipes: 0, point: pressPoint(elements, element, screen) };
  }

  const scrolled = flagBool(ctx.flags, 'no-scroll')
    ? { element, swipes: 0, elements }
    : await scrollIntoView(ctx, sel, element, elements, screen, opts);

  if (isOffscreen(scrolled.element.bounds, screen)) {
    const why = flagBool(ctx.flags, 'no-scroll')
      ? '--no-scroll is set'
      : scrolled.swipes === 0
        ? 'no scrollable container could move it'
        : `${scrolled.swipes} swipe(s) did not bring it into view`;
    throw new SelectorNotFoundError(
      `'${sel.raw}' is in the screen's element tree but scrolled out of view (${why}), so tapping it ` +
        'would press whatever is at those coordinates instead. Run `verikun ui` to inspect the current screen.',
    );
  }
  reachWarning(scrolled.elements, scrolled.element, screen);
  return { ...scrolled, tier, waitedMs, point: pressPoint(scrolled.elements, scrolled.element, screen) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdDevices(flags: Flags): number {
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

/** Aliases for the lifecycle verbs, mirroring the top-level command aliases. */
const DEVICE_VERBS: Record<string, LifecycleVerb> = {
  start: 'start',
  boot: 'start',
  stop: 'stop',
  shutdown: 'stop',
  kill: 'stop',
  restart: 'restart',
  reboot: 'restart',
};

/**
 * `vk devices [list|start|stop|restart]`. Dispatched as a META-command (before the
 * recording machinery) whenever a subcommand is present: lifecycle needs no local
 * driver — it is what you run when there ISN'T one — and a `--server` invocation
 * must not build one either. Bare `vk devices` keeps the ordinary path.
 */
async function cmdDevicesEntry(positionals: string[], flags: Flags): Promise<number> {
  const sub = String(positionals[0] ?? 'list').toLowerCase();
  const server = serverFromFlags(flags);
  if (sub === 'list') return server ? cmdDevicesRemoteList(server, flags) : cmdDevices(flags);
  const verb = DEVICE_VERBS[sub];
  if (!verb) {
    throw new CliError(`Unknown 'devices' subcommand '${sub}'. Use: list | start | stop | restart.`, 2);
  }
  return server
    ? cmdDevicesRemote(verb, positionals[1], server, flags)
    : cmdDeviceLifecycle(verb, positionals[1], flags);
}

/**
 * Refuse to power-cycle a device another job is actively driving.
 *
 * The local counterpart of the server's `409`: you may restart YOUR OWN device, never
 * someone else's. Without this, device claims and device lifecycle would each work and
 * together be a hole — one job could reboot the phone another job is mid-suite on,
 * which is precisely the collision claims exist to prevent.
 *
 * `start` is exempt: it only ever brings up something that is not running, so there is
 * nothing to pull out from under anyone.
 */
function assertNotClaimedByOthers(target: LifecycleTarget, verb: LifecycleVerb): void {
  if (verb === 'start' || !target.serial || !claimsEnabled()) return;
  const claim = summarize(target.serial);
  if (!claim || claim.mine) return;
  throw new CliError(
    `${targetLabel(target)} (${target.serial}) is in use by ${claim.by} — ` +
      `${verb} would pull the device out from under it.\n` +
      `If that job is gone, hand the device back first: vk device release ${target.serial}`,
    2,
  );
}

async function cmdDeviceLifecycle(
  verb: LifecycleVerb,
  rawTarget: string | undefined,
  flags: Flags,
): Promise<number> {
  const wipe = flagBool(flags, 'wipe');
  const wait = !flagBool(flags, 'no-wait');
  const timeoutFlag = flagStr(flags, 'timeout');
  const timeoutMs = timeoutFlag
    ? parseDuration(timeoutFlag, 'timeout')
    : verb === 'stop'
      ? DEFAULT_STOP_TIMEOUT_MS
      : DEFAULT_BOOT_TIMEOUT_MS;

  // An explicit --ios/--android/--platform narrows the search; otherwise probe both
  // backends, exactly as bare `vk devices` does, so `devices start Pixel_6_API_34`
  // works without also naming the platform. A name that hits BOTH is still exit 2.
  const explicitPlatform =
    flagBool(flags, 'ios') || flagBool(flags, 'android') || flagStr(flags, 'platform') !== undefined;
  const lifecycles = explicitPlatform ? [lifecycleFor(platformFromFlags(flags))] : allLifecycles();
  const targets = lifecycles.flatMap((l) => l.targets());

  if (!rawTarget) {
    const startable = targets.filter((t) => t.kind !== 'physical').map(targetLabel).filter(Boolean);
    const hint = startable.length
      ? `\nStartable: ${[...new Set(startable)].join(', ')}`
      : '\nRun `vk devices --all` to list startable devices.';
    throw new CliError(`Usage: verikun devices ${verb} <name|serial> [--timeout <dur>]${hint}`, 2);
  }

  // `start` wants the one that ISN'T up; `stop`/`restart` want the live one.
  const chosen = chooseTarget(targets, rawTarget, { prefer: verb === 'start' ? 'startable' : 'running' });
  assertActionable(chosen, verb, { wipe });
  assertNotClaimedByOthers(chosen, verb);
  const lc = lifecycleFor(chosen.platform);
  const onProgress = (m: string) => err(`[verikun] ${m}`);
  const asJson = flagBool(flags, 'json');

  if (verb === 'stop') {
    const r = await lc.shutdown(chosen, { timeoutMs, onProgress });
    if (asJson) {
      json({ action: 'stop', requested: rawTarget, platform: chosen.platform, kind: chosen.kind, serial: r.serial, name: chosen.name, stopped: r.stopped });
    } else {
      err(r.stopped ? `stopped ${targetLabel(chosen)}` : `${targetLabel(chosen)} was not running`);
      out(r.serial);
    }
    return 0;
  }

  const opts = { timeoutMs, wait, wipe, onProgress };
  const r =
    verb === 'restart'
      ? await restartTarget(lc, chosen, opts)
      : { ...(await lc.boot(chosen, opts)), stopped: false };

  if (asJson) {
    json({
      action: verb,
      requested: rawTarget,
      platform: chosen.platform,
      kind: chosen.kind,
      serial: r.serial,
      name: chosen.name,
      started: r.started,
      ready: r.ready,
      waitedMs: r.waitedMs,
      ...(r.logPath ? { logPath: r.logPath } : {}),
    });
  } else {
    if (verb === 'start' && !r.started) err(`${targetLabel(chosen)} is already running`);
    // stdout is the one machine-usable datum: the serial, so
    // `vk -d "$(vk devices start X)" ui` composes. Under --no-wait on Android there
    // is genuinely no serial yet, so print nothing rather than invent one.
    out(r.serial ?? '');
  }
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

/** Render one shared ToolProbe the way doctor always has: present -> stdout, failure +
 *  hint -> stderr. Unlike `Driver.preflight()` (which throws on the first failure),
 *  doctor reports every probe so one run lists everything that needs fixing.
 *
 *  An `advisory` probe (see ToolProbe) renders like a failure — stderr, with its hint,
 *  because the hint is the useful part — but returns true, so it is visible without
 *  claiming the setup is broken. Returns whether this counts as OK for doctor's verdict. */
function reportProbe(p: ToolProbe): boolean {
  if (p.advisory) {
    err(`${p.name}: ${p.detail}`);
    if (p.hint) err(`  ${p.hint}`);
    return true;
  }
  if (p.ok) {
    // A multi-line detail (simctl's booted-device listing) reads as its own block
    // rather than smashed onto the `name:` line.
    if (p.detail.includes('\n')) {
      out(`${p.name}: present`);
      out(p.detail);
    } else {
      out(`${p.name}: ${p.detail}`);
    }
  } else {
    err(`${p.name}: ${p.detail}`);
    if (p.hint) err(`  ${p.hint}`);
  }
  return p.ok;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  // First, and platform-independent: a skewed plugin makes an agent emit commands this CLI
  // does not have, which is worth knowing before any device diagnosis. Every version probe
  // is advisory, though — being out of date is not a broken machine, and exit 3 is reserved
  // for one. So these render (with their remediation hints) without touching the verdict.
  for (const probe of await updateProbes()) reportProbe(probe);

  if (ctx.platform === 'ios') {
    // xcrun is the floor: without it there is no device list to reason about.
    if (!reportProbe(probeXcrun())) return 3;
    // idb (+ its companion) powers everything interactive: ui/tap/text/swipe/key/logs.
    const idbOk = [probeIdb(), probeIdbCompanion()].map(reportProbe).every(Boolean);
    out('note: simulator screenshots + launch/stop work via simctl; ui/tap/text/swipe/key/logs use idb.');
    return idbOk ? 0 : 3;
  }

  const adb = process.env.ADB || 'adb';
  if (!reportProbe(probeAdb())) return 3;

  const devices = ctx.driver.listDevices();
  const usable = devices.filter((d) => d.state === 'device');
  const claims = claimsEnabled();
  // Read-only, like `vk devices`: doctor surveys the host, it never takes a device.
  const heldByOther = (serial: string) => {
    const c = claims ? summarize(serial) : undefined;
    return c && !c.mine ? c : undefined;
  };
  out(`devices: ${devices.length} attached, ${usable.length} usable`);
  for (const d of devices) {
    const claim = claims ? summarize(d.serial) : undefined;
    out(`  ${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}${claim ? `  [${claim.by}]` : ''}`);
  }

  let ok = true;
  const free = usable.filter((d) => !heldByOther(d.serial));
  if (!usable.length) {
    err('  -> no usable device');
    ok = false;
  } else if (!ctx.device && !free.length) {
    // Every device is busy. Advisory-shaped but genuinely blocking, so it still fails:
    // an interaction command run right now would exit 2, and doctor exists to say so first.
    err('  -> every attached device is claimed by another job — `verikun devices` shows who');
    ok = false;
  } else if (!ctx.device && !claims && usable.length > 1) {
    err('  -> multiple devices: pass --device for interaction commands');
    ok = false;
  }

  // Check the device an interaction command would actually land on: the one named, else
  // the first FREE one (which is what auto-selection picks), not merely the first attached.
  const target = ctx.device || free[0]?.serial;
  if (target) {
    try {
      const serial = target;
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
  const sel = buildSelector(ctx, ctx.positionals[0]);
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
  let swipes = 0;
  let point: Point;
  if (isBareIndex) {
    const els = ctx.driver.getElements({ all: flagBool(ctx.flags, 'all') });
    const idx = Number(raw);
    const found = els.find((e) => e.index === idx);
    if (!found) throw new CliError(`No element with index [${idx}] on the current screen. Run \`verikun ui\`.`, 1);
    // An index names a row of one specific dump, and scrolling renumbers every row —
    // so this path cannot scroll. Refuse instead of pressing coordinates off-screen.
    if (found.offscreen) {
      throw new CliError(
        `Element [${idx}] ${formatInline(found)} is scrolled out of view. Tap it by selector ` +
          `(e.g. \`verikun tap @${found.idShort || 'id'}\`) so verikun can scroll it into view first.`,
        1,
      );
    }
    target = found;
    reachWarning(els, target, screenOf(ctx));
    point = pressPoint(els, target, screenOf(ctx));
    ctx.record?.note({ element: target, message: `tapped by index [${idx}]` });
  } else {
    const sel = buildSelector(ctx, raw);
    ({ element: target, tier, waitedMs, swipes, point } = await resolveTappable(ctx, sel, {
      all: flagBool(ctx.flags, 'all'),
    }));
    ctx.record?.note({
      selector: sel,
      tier,
      element: target,
      message: swipes > 0 ? `scrolled into view (${swipes} swipe(s)) and tapped` : undefined,
    });
  }

  ctx.driver.tap(point.x, point.y);
  out(`tapped ${formatInline(target)}${healNote(tier)}${waitNote(waitedMs)}${scrollNote(swipes)}`);
  return 0;
}

async function cmdText(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length < 2) {
    throw new CliError('Usage: verikun text <selector> <text...>  (use -- before text starting with "-")', 2);
  }
  const sel = buildSelector(ctx, ctx.positionals[0]);
  const value = ctx.positionals.slice(1).join(' ');
  const { element: target, tier, waitedMs, swipes, point } = await resolveTappable(ctx, sel);
  ctx.record?.note({
    selector: sel,
    tier,
    element: target,
    message: target.password ? 'typed «redacted»' : `typed ${JSON.stringify(value)}`,
  });

  ctx.driver.tap(point.x, point.y);
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
  out(
    `typed ${JSON.stringify(value)} into ${formatInline(target)}${healNote(tier)}${waitNote(waitedMs)}${scrollNote(swipes)}`,
  );
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
    // Through buildSelector, not parseSelector: --on used to see only --contains, so
    // `swipe --on X --enabled` silently ignored the modifier it was given.
    const onSel = buildSelector(ctx, on);
    const { element, waitedMs: w } = await resolveOneWaiting(ctx, onSel);
    waitedMs = w;
    ctx.record?.note({ selector: onSel, element });
    region = element.bounds;
  } else {
    const { width, height } = ctx.driver.screenSize();
    region = { x1: 0, y1: 0, x2: width, y2: height };
  }

  if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
    throw new CliError(`Unknown direction '${dir}' (use up|down|left|right)`, 2);
  }
  const frac = Math.min(Math.max(flagNum(ctx.flags, 'distance') ?? DEFAULT_SWIPE_FRACTION, 0.1), 0.95);
  const { from: a, to: b } = swipeVector(region, dir as Direction, frac);
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

/** How long a `vk ai` `if-present` guard waits for its selector before deciding the
 *  optional UI is absent. `VERIKUN_GUARD_SETTLE_MS` overrides the engine default so the
 *  window can be tuned against a real app without a rebuild (0 restores the old
 *  single-shot probe). Exported for unit tests. */
export function guardSettleMs(): number {
  const env = process.env.VERIKUN_GUARD_SETTLE_MS;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_GUARD_SETTLE_MS;
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
  // Precedence: --full (original) > --max <px> (explicit) > --more (preset) > default.
  const maxEdge = flagNum(ctx.flags, 'max') ?? (flagBool(ctx.flags, 'more') ? MORE_SHOT_MAX_EDGE : shotMaxEdge());
  const res = capturePng(ctx.driver, flagBool(ctx.flags, 'full') ? null : maxEdge);
  const buf = res.buf;

  const outFlag = flagStr(ctx.flags, 'out');
  const path = outFlag ? confineToCwd(outFlag) : defaultScreenshotPath();
  writeFileSync(path, buf);
  ctx.record?.attachImage(buf);
  ctx.record?.note({ message: res.scaled ? `${path} (${res.width}×${res.height})` : path });

  // Surface the one case worth knowing about: we wanted to shrink but couldn't.
  if (!res.scaled && res.reason?.startsWith('unsupported')) {
    err(`screenshot not downscaled: ${res.reason}`);
  }

  if (flagBool(ctx.flags, 'json')) {
    json({
      path,
      bytes: buf.length,
      ...(res.scaled
        ? { width: res.width, height: res.height, scaledFrom: { width: res.origWidth, height: res.origHeight } }
        : {}),
    });
  } else {
    out(path);
    if (res.scaled) err(`scaled ${res.origWidth}×${res.origHeight} -> ${res.width}×${res.height} (max edge ${maxEdge}px; --more for detail, --full for original)`);
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
  const sel = buildSelector(ctx, ctx.positionals[0]);
  const gone = flagBool(ctx.flags, 'gone');
  const timeout = flagNum(ctx.flags, 'timeout') ?? 10000;
  const interval = flagNum(ctx.flags, 'interval') ?? 400;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { matches, tier } = matchElements(readForPoll(ctx), sel);
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
    // Compare against text OR content-desc, mirroring what the selector layer already
    // does (a `text:` selector falls back to desc when nothing matches on text). Without
    // the fallback this could never pass on a Flutter app, which maps Semantics(label:)
    // to contentDescription and leaves `text` empty on every node — while `text:Foo` as a
    // SELECTOR resolved fine, so the contradiction was silent and read as a real failure.
    // Strictly widening: it only turns false negatives into passes.
    const content = (m: Element): string[] => [m.text, m.desc].filter((v) => v !== '');
    const hit = (v: string): boolean =>
      contains
        ? v.toLowerCase().includes(wantText.toLowerCase())
        : v.trim().toLowerCase() === wantText.trim().toLowerCase();
    pass = matches.some((m) => content(m).some(hit));
    reason = pass
      ? 'text matched'
      : `found, but text != ${JSON.stringify(wantText)} (got ${JSON.stringify(matches.flatMap(content))})`;
  } else {
    pass = true;
    reason = `found ${matches.length}`;
  }
  return { pass, reason, matches };
}

async function cmdAssert(ctx: Ctx): Promise<number> {
  const sel = buildSelector(ctx, ctx.positionals[0]);
  // Auto-wait subsumes the common "wait then assert": poll until the assertion
  // passes or the window elapses. `--gone` therefore waits for disappearance.
  const deadline = Date.now() + waitWindowMs(ctx.flags);
  let result = evalAssert(readForPoll(ctx), sel, ctx.flags);
  while (!result.pass && Date.now() < deadline) {
    await sleep(pollStep(ctx.flags, deadline));
    result = evalAssert(readForPoll(ctx), sel, ctx.flags);
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

// ---------------------------------------------------------------------------
// device — control the device the app runs on (see device/settings.ts)
// ---------------------------------------------------------------------------
//
// The capability table is the single source of truth: it validates values, decides
// what each platform supports, and prints itself via `device caps`. Two properties
// are load-bearing:
//
//  - FAIL EARLY. Every assignment is parsed and capability-checked before ANY device
//    I/O, so `device set dark=on rotation=landscape` on iOS refuses up front instead
//    of applying dark mode and then dying — a half-applied device is worse than none.
//  - SNAPSHOT FIRST. The pre-change value is persisted before the change is made, so
//    `device reset` can undo it even from a later process.

const DEVICE_USAGE =
  'Usage: verikun device set <key>=<value> [<key>=<value> ...] | device get [key] | device reset [key ...] | device caps | device release [serial]\n' +
  `Keys: ${SETTING_KEYS.join(', ')}`;

function cmdDevice(ctx: Ctx): number {
  const sub = (ctx.positionals[0] ?? '').toLowerCase();
  const rest = ctx.positionals.slice(1);
  switch (sub) {
    case 'set':
      return deviceSet(ctx, rest);
    case 'get':
    case 'status':
      return deviceGet(ctx, rest);
    case 'reset':
      return deviceReset(ctx, rest);
    case 'caps':
      return deviceCaps(ctx);
    case 'release':
      return deviceRelease(ctx, rest);
    default:
      throw new CliError(
        (sub ? `Unknown 'device' subcommand '${sub}'.\n` : '') + DEVICE_USAGE,
        2,
      );
  }
}

/**
 * Hand a device back to the pool. The break-glass named in every "in use by" refusal:
 * a crashed job's claim expires on its own, but waiting out the TTL is the one thing an
 * operator should never be forced to do just to get on with their run.
 *
 * Deliberately releases someone ELSE's claim too, naming them — you had to type the
 * serial, and refusing here would leave no way to recover a stuck device at all. Resolves
 * the device WITHOUT going through the driver, so it works even when the claim being
 * cleared is the very thing that would refuse the resolve.
 */
function deviceRelease(ctx: Ctx, args: string[]): number {
  const serial = args[0] || ctx.device;
  if (!serial) {
    throw new CliError('Usage: verikun device release <serial>  (or pass --device / set VERIKUN_DEVICE)', 2);
  }
  if (!claimsEnabled()) {
    err('device claims are disabled (VERIKUN_NO_CLAIM) — nothing to release');
    return 0;
  }
  const released = releaseClaim(serial);
  if (flagBool(ctx.flags, 'json')) {
    json({ serial, released: !!released, ...(released ? { was: released } : {}) });
  } else if (released) {
    out(`released ${serial} (was held by ${describeClaim(released)})`);
  } else {
    out(`${serial} was not claimed`);
  }
  return 0;
}

/** Render a setting value for humans/JSON; a platform that cannot answer says so. */
const showValue = (v: string | null): string => v ?? 'n/a';

function deviceSet(ctx: Ctx, args: string[]): number {
  const assignments = parseDeviceAssignments(args);

  // Gate 1: capability, for EVERY key, before touching the device.
  const support = new Map<SettingKey, Support>();
  for (const { key } of assignments) support.set(key, checkSupport(key, ctx.platform));

  // Gate 2: would this cut the wire we are talking over? Only wireless adb is at
  // risk, and only from the radios. A stderr warning would be useless here — the
  // command that reads it is the one that just lost its transport — so refuse, and
  // require an explicit opt-in to accept losing the link.
  if (ctx.platform === 'android') {
    const transport = adbTransport(ctx.driver.resolvedSerial());
    for (const { key, value } of assignments) {
      if (severanceRisk(transport, key, value) && !flagBool(ctx.flags, 'allow-wireless')) {
        throw new CliError(
          `Refusing to set ${key}=${value} over a wireless adb connection (${ctx.driver.resolvedSerial()}): ` +
            'it would cut the link carrying this session, and nothing could turn it back on remotely.\n' +
            'Connect over USB, or pass --allow-wireless to accept losing the connection.',
          2,
        );
      }
    }
  }

  const applied: Record<string, string> = {};
  for (const { key, value } of assignments) {
    // A no-op key has nothing to put back, so it is never snapshotted.
    if (support.get(key) !== 'noop') snapshotSetting(ctx, key);
    ctx.driver.setDeviceSetting(key, value);
    applied[key] = value;
  }

  const summary = assignments.map((a) => `${a.key}=${a.value}`).join(' ');
  ctx.record?.note({ message: `device set ${summary}` });
  if (flagBool(ctx.flags, 'json')) json({ set: applied });
  else out(`device set ${summary}`);
  return 0;
}

/** Persist what a setting held before we change it. Warns rather than fails when the
 *  value can't be captured — the change still happens, it just can't be auto-undone. */
function snapshotSetting(ctx: Ctx, key: SettingKey): void {
  if (!ctx.record) {
    // Recording disabled (VERIKUN_NO_RUN=1): there is nowhere to persist the original,
    // so this change is one-way. Say so rather than implying reset will handle it.
    err(`warning: run recording is off, so '${key}' was not snapshotted — \`device reset\` cannot restore it`);
    return;
  }
  const original = ctx.driver.getDeviceSetting(key);
  if (original === null) {
    err(`warning: could not read the current '${key}' — \`device reset\` will not restore it`);
    return;
  }
  ctx.record.rememberDeviceOverride(key, original);
}

function deviceGet(ctx: Ctx, args: string[]): number {
  const keys = args.length ? args.map(requireSettingKey) : SETTING_KEYS;
  const values: Record<string, string> = {};
  for (const key of keys) {
    values[key] = SETTINGS[key].support[ctx.platform] === 'unsupported'
      ? 'n/a'
      : showValue(ctx.driver.getDeviceSetting(key));
  }
  if (flagBool(ctx.flags, 'json')) json(values);
  else for (const key of keys) out(`${key.padEnd(12)} ${values[key]}`);
  return 0;
}

function deviceReset(ctx: Ctx, args: string[]): number {
  // Read from the recorder's in-flight state, not from disk: this step's own commit()
  // will write that state back, so a disk-level delete here would be undone.
  const overrides = ctx.record?.deviceOverrides() ?? {};
  const wanted = args.length ? args.map(requireSettingKey) : (Object.keys(overrides) as SettingKey[]);
  const restored: Record<string, string> = {};
  const failed: string[] = [];

  for (const key of wanted) {
    const original = overrides[key];
    if (original === undefined) continue; // never changed by this run — leave it alone
    try {
      ctx.driver.setDeviceSetting(key, original);
      restored[key] = original;
    } catch (e) {
      // Best-effort by design: reset is usually reached while cleaning up after a
      // failure, and one stubborn setting must not stop the rest being put back.
      failed.push(`${key} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
  }
  ctx.record?.forgetDeviceOverrides(Object.keys(restored));

  const summary = Object.entries(restored).map(([k, v]) => `${k}=${v}`).join(' ');
  ctx.record?.note({ message: summary ? `device reset ${summary}` : 'device reset (nothing to restore)' });
  if (failed.length) err(`warning: could not restore ${failed.join(', ')}`);
  if (flagBool(ctx.flags, 'json')) json({ restored, ...(failed.length ? { failed } : {}) });
  else out(summary ? `device reset ${summary}` : 'device reset: nothing to restore');
  return 0;
}

function deviceCaps(ctx: Ctx): number {
  const rows = SETTING_KEYS.map((key) => {
    const spec = SETTINGS[key];
    const support = spec.support[ctx.platform];
    return {
      key,
      values: spec.values,
      support,
      describe: spec.describe,
      ...(support === 'unsupported' && spec.manual[ctx.platform] ? { manual: spec.manual[ctx.platform] } : {}),
      ...(spec.note[ctx.platform] ? { note: spec.note[ctx.platform] } : {}),
    };
  });
  if (flagBool(ctx.flags, 'json')) {
    json({ platform: ctx.platform, settings: rows });
    return 0;
  }
  out(`device settings on ${ctx.platform}:`);
  for (const r of rows) {
    out(`  ${r.key.padEnd(12)} ${r.support.padEnd(12)} ${r.values}`);
    out(`  ${' '.repeat(12)} ${r.describe}`);
    if (r.manual) out(`  ${' '.repeat(12)} unsupported: ${r.manual.replace(/\n/g, ' ')}`);
    if (r.note) out(`  ${' '.repeat(12)} note: ${r.note}`);
  }
  return 0;
}

function requireSettingKey(v: string): SettingKey {
  const k = v.trim().toLowerCase();
  if (!isSettingKey(k)) {
    throw new CliError(`Unknown device setting '${v}'. Known: ${SETTING_KEYS.join(', ')}.`, 2);
  }
  return k;
}

/**
 * Put back every device setting this run changed. Best-effort and silent about
 * "nothing to do", because it runs from a `finally` — the flow may well be unwinding
 * from the very failure that left the device in a modified state.
 *
 * Runs through the backend rather than a Driver so the local and remote paths are the
 * same code. (Remote is a known gap: the overrides live in the *server's* run file, so
 * a locally-empty snapshot means this correctly skips — see the issue's Out of scope.)
 */
async function restoreDeviceOverrides(backend: ExecBackend): Promise<void> {
  if (!Recorder.hasDeviceOverrides()) return;
  try {
    err('[verikun] restoring device settings changed by this run…');
    await backend.exec('device', ['reset'], {});
  } catch {
    /* the device may be exactly why we are unwinding — never mask the real error */
  }
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
      // The run is over, so the device goes back to the pool now rather than in TTL
      // minutes. `mineOnly` because a run can only ever hand back its own device.
      if (cleared?.device) releaseClaim(cleared.device, { mineOnly: true });
      if (asJson) json({ cleared: cleared?.id ?? null });
      else out(cleared ? `discarded test run '${cleared.name}' (${cleared.steps.length} step(s))` : 'no active test run');
      return 0;
    }
    case 'archive':
    case 'finish':
    case 'save': {
      const noLogs = flagBool(flags, 'no-logs');
      // Best-effort: archive-time log capture needs a device. Prefer the run's
      // bound serial/platform so a multi-device host hits the right one. A
      // missing/broken toolchain must not prevent sealing the report.
      let fetchLogs: ((opts: { since?: string; lines?: number; appId?: string; scopedOnly?: boolean }) => string) | undefined;
      const active = Recorder.status();
      const hasFailures = !!active?.steps.some((s) => s.status !== 'passed');
      if (wantsArchiveLogs(hasFailures, noLogs)) {
        try {
          const plat =
            active?.platform === 'ios' || active?.platform === 'android'
              ? (active.platform as Platform)
              : platform;
          const driver = getDriver(plat, active?.device || device);
          fetchLogs = (opts) => driver.getLogs(opts);
        } catch (e) {
          err(`[verikun] archive log capture unavailable (${(e as Error).message})`);
        }
      }
      const { dir, xmlPath, htmlPath, state } = Recorder.archive(positionals[1], { noLogs, fetchLogs });
      // Archived means finished: release after log capture, which still needs the device.
      if (state.device) releaseClaim(state.device, { mineOnly: true });
      const { passed, failed } = tally(state.steps);
      if (asJson) {
        json({
          archived: dir,
          report: htmlPath,
          junit: xmlPath,
          steps: state.steps.length,
          passed,
          failed,
          ...(state.logFile ? { logFile: state.logFile } : {}),
        });
      } else {
        out(dir); // primary result: the archived run directory
        err(`archived '${state.name}': ${state.steps.length} step(s), ${passed} passed, ${failed} failed/error`);
        err(`  JUnit: ${xmlPath}`);
        err(`  HTML:  ${htmlPath}`);
        if (state.logFile) err(`  Logs:  ${join(dir, state.logFile)}`);
        if (state.appLogFile) err(`  App:   ${join(dir, state.appLogFile)}`);
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

  // One process drives the whole batch, so its pid is exact evidence that the device is
  // still in use — a `kill -9` hands it straight back instead of parking it for the TTL.
  setProcessScoped(true);

  // The finally is what makes `device set` safe to use in a batch: a line that fails
  // (or a ^C) still puts the device back, instead of leaving it offline or rotated.
  try {
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
  } finally {
    if (Recorder.hasDeviceOverrides()) {
      err('[verikun] restoring device settings changed by this batch…');
      try {
        await executeParsed('device', ['reset'], withBatchGlobals({}, batchFlags));
      } catch {
        /* the device may be exactly why we are unwinding — never mask the real error */
      }
    }
    releaseOwnClaims();
  }
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

/** The parsed `vk ai` knobs, shared verbatim by every test in a `vk suite` run. */
interface AiOptions {
  model: string;
  price: Price;
  maxCostUsd: number;
  timeoutMs: number;
  effort?: string;
  pkg?: string;
  build?: string;
  recompile: boolean;
}

function parseAiOptions(flags: Flags): AiOptions {
  const model = resolveModel(flagStr(flags, 'model'));
  const overrideRaw = flagStr(flags, 'cost-override');
  const override = overrideRaw ? parseCostOverride(overrideRaw) : undefined;
  const maxCostUsd = flagNum(flags, 'max-cost-usd') ?? DEFAULT_MAX_COST_USD;
  if (maxCostUsd <= 0) throw new CliError(`--max-cost-usd must be greater than 0 (got ${maxCostUsd}).`, 2);
  // Whole-run wall-clock ceiling (default 15m) so a runaway loop/repair can't hang the run.
  const timeoutFlag = flagStr(flags, 'timeout');
  const timeoutMs = timeoutFlag ? parseDuration(timeoutFlag, 'timeout') : DEFAULT_RUN_TIMEOUT_MS;
  return {
    model,
    price: priceFor(model, override),
    maxCostUsd,
    timeoutMs,
    effort: flagStr(flags, 'effort'),
    pkg: flagStr(flags, 'package'),
    build: flagStr(flags, 'app-build'),
    recompile: flagBool(flags, 'recompile') || flagBool(flags, 'no-cache'),
  };
}

function readAiTest(file: string): string {
  let nl: string;
  try {
    nl = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch (e) {
    throw new CliError(`ai: cannot read '${file}' (${(e as Error).message})`, 2);
  }
  if (!nl.trim()) throw new CliError(`ai: '${file}' is empty`, 2);
  return nl;
}

/** The CLI-agent backends, by ProviderId. Adding a CLI provider is one entry here rather than a
 *  new arm in each of the three functions below — they all ask the same question of it. */
const CLI_SPECS: Partial<Record<ProviderId, CliAgentSpec>> = { codex: CODEX_SPEC, cursor: CURSOR_SPEC };

/** Is the backend for `model` usable right now? HTTP providers need their API key in env;
 *  a CLI provider needs its binary on PATH (auth lives in the CLI's own login, not an env key). */
function providerAvailable(model: string): boolean {
  const id = providerFor(model);
  const spec = CLI_SPECS[id];
  if (spec) return commandExists(spec.bin);
  return id === 'openai' ? !!process.env.OPENAI_API_KEY : !!process.env.ANTHROPIC_API_KEY;
}

/** What's missing when a provider is unavailable — the tail of the preflight error message. */
function providerRequirement(model: string): string {
  const id = providerFor(model);
  const spec = CLI_SPECS[id];
  // Reuse the spec's own loginHint rather than restating it, so the two can't drift apart.
  if (spec) return `the \`${spec.bin}\` CLI was not found on PATH — install it and ${spec.loginHint}`;
  return id === 'openai' ? 'OPENAI_API_KEY is not set' : 'ANTHROPIC_API_KEY is not set';
}

/** Route the model to its backend. HTTP providers read their own key; a CLI provider shells
 *  out to its logged-in binary. Unavailable → null (compile/repair off). That is NOT a free
 *  replay path: runAiTest turns a null provider into exit 3 even at a 100% cache hit, because
 *  it must be able to repair a drifted step at runtime — only --show-plan degrades gracefully.
 *  CLI providers get no `model`, so the CLI picks its own default — the "I just have a
 *  subscription" path; --effort is likewise inapplicable to them. */
function makeProvider(opts: AiOptions): AgentProvider | null {
  const id = providerFor(opts.model);
  const spec = CLI_SPECS[id];
  if (spec) return commandExists(spec.bin) ? new CliProvider({ spec }) : null;
  if (id === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    return apiKey ? new OpenAiProvider({ model: opts.model, apiKey, effort: opts.effort }) : null;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? new ClaudeProvider({ model: opts.model, apiKey, effort: opts.effort }) : null;
}

/** Obtain the plan: a cache hit (free) or a compile (pays tokens; may seed from a
 *  prior build's plan to avoid a full recompile). The fresh compile is cached right
 *  away, so an unchanged test is never recompiled — even via --show-plan or after a
 *  failed run. A green run later re-persists the healed plan (never a half-healed one). */
async function obtainPlan(
  key: CacheKeyInput,
  file: string,
  opts: AiOptions,
  cost: CostTracker,
  provider: AgentProvider | null,
): Promise<{ plan: Plan; cached: boolean }> {
  const cached = opts.recompile ? null : readPlan(key);
  if (cached) {
    err(`[ai] plan cache hit — ${opts.model} not called to compile`);
    return { plan: cached.plan, cached: true };
  }
  if (!provider) {
    throw new CliError(`${providerRequirement(opts.model)} — needed to compile the test (model ${opts.model}).`, 3);
  }
  const seed = findSeed(key);
  if (seed) err(`[ai] no exact cache; seeding from a prior plan (build ${seed.build ?? 'unknown'})`);
  err(`[ai] compiling '${file}' with ${opts.model} (effort ${opts.effort ?? 'default'})…`);

  let compiled = await provider.compile({ nl: key.nl, pkg: key.pkg, platform: key.platform, seed: seed?.plan });
  cost.add(compiled.usage, 'compile');

  // Compilation is nondeterministic: the same prose has produced `launch --clear` on one
  // run and plain `launch` on the next, silently dropping something the test stated. One
  // guided retry is much cheaper than discovering it as a device-run failure several steps
  // later. Budget is re-checked HERE because the first attempt has already been billed.
  const findings = lintPlan(key.nl, compiled.plan);
  if (findings.length > 0) {
    const feedback = findings.map((f) => `- ${f.message}`).join('\n');
    err(`[ai] compiled plan does not match the test — recompiling once:\n${feedback}`);
    if (cost.exceeded()) {
      err('[ai] cost ceiling reached — keeping the first plan rather than paying for a retry');
    } else {
      const retry = await provider.compile({
        nl: key.nl,
        pkg: key.pkg,
        platform: key.platform,
        seed: seed?.plan,
        retryFeedback: feedback,
      });
      cost.add(retry.usage, 'compile');
      const still = lintPlan(key.nl, retry.plan);
      // Keep the retry either way: it was compiled with strictly more information. If it
      // still trips the lint, say so rather than pretending the plan is clean.
      if (still.length > 0) err(`[ai] the retry still does not match the test — running it anyway:\n${still.map((f) => `- ${f.message}`).join('\n')}`);
      else err('[ai] recompile matches the test');
      compiled = retry;
    }
  }

  err(`[ai] compiled ${compiled.plan.steps.length} top-level step(s) · ${cost.summaryLine()}`);
  try {
    writePlan(key, compiled.plan);
  } catch (e) {
    err(`[ai] could not cache compiled plan: ${(e as Error).message}`);
  }
  return { plan: compiled.plan, cached: false };
}

// --- execution backend (local driver vs remote `vk server`) -----------------
//
// `vk ai`, `vk suite`, and `vk install` run their device work through an
// ExecBackend. Local wraps one shared Driver; remote speaks HTTP to a `vk server`
// beside the device (--server / VERIKUN_SERVER), where each validated leaf is ONE
// round-trip (the auto-wait loop stays server-side). In remote mode the server
// owns the device: its /v1/health platform+serial supersede the client's
// --platform/--device, and no local driver is ever built.

interface ResolvedBackend {
  backend: ExecBackend;
  platform: Platform;
  device?: string;
  /** Set when the backend is a remote `vk server`. `reads` is absent against a pre-0.21.1
   *  server, which did not report its hierarchy read path. */
  remote?: { url: string; version: string; reads?: HierarchySource };
}

/** The `--server` URL, or VERIKUN_SERVER. Exported-shape helper so `resolveBackend`
 *  and `vk devices --server` can never disagree about what "remote" means. */
export function serverFromFlags(flags: Flags): string | undefined {
  return flagStr(flags, 'server') || process.env.VERIKUN_SERVER || undefined;
}

function remoteOptsFrom(url: string, flags: Flags): RemoteOpts {
  return { url, authKey: flagStr(flags, 'auth-key') || process.env.VERIKUN_SERVER_AUTH_KEY || undefined };
}

/**
 * `--ensure-device[=<target>]` — the requested target, or `undefined` for the bare
 * form, or `null` when the flag is absent. Exported for unit tests.
 */
export function ensureDeviceTarget(flags: Flags): string | undefined | null {
  const raw = flags['ensure-device'];
  if (raw === undefined || raw === false) return null;
  if (raw === true || raw === 'true') return undefined;
  return String(raw);
}

/** The one target that is startable without guessing, else exit 2 with the options. */
function soleStartable(targets: LifecycleTarget[]): LifecycleTarget {
  const startable = targets.filter((t) => t.kind !== 'physical' && !isRunning(t));
  if (startable.length === 1) return startable[0];
  const names = [...new Set(startable.map(targetLabel).filter(Boolean))];
  throw new CliError(
    startable.length === 0
      ? '--ensure-device: no startable device found. Run `vk devices --all` to check the toolchain.'
      : `--ensure-device: ${startable.length} devices could be started — name one, ` +
        `e.g. --ensure-device="${names[0]}"\n  ${names.join('\n  ')}`,
    2,
  );
}

/**
 * Boot a device before the first step, when `--ensure-device` asks for it. Runs here
 * — inside resolveBackend, before runCtx is fixed — rather than inside `vk suite`,
 * so the booted serial is the one every recorded step is attributed to. It is
 * structurally unable to turn a red test green: it happens before any step executes,
 * never between tests and never mid-run.
 */
async function ensureLocalDevice(platform: Platform, device: string | undefined, flags: Flags): Promise<void> {
  const want = ensureDeviceTarget(flags);
  if (want === null) return;
  try {
    const serial = getDriver(platform, device).resolvedSerial();
    // `--ensure-device=X` means "boot X if nothing is usable", not "make X the
    // device" — so say so plainly when a different device is already serving,
    // rather than reporting a serial the caller didn't ask for.
    err(`[verikun] --ensure-device: ${serial} is already available${want ? ` — not booting '${want}'` : ''}`);
    return;
  } catch (e) {
    // Ambiguity (exit 2) is an operator error — booting another device makes it worse.
    if (!(e instanceof CliError) || e.exitCode !== 3) throw e;
  }
  const lc = lifecycleFor(platform);
  const targets = lc.targets();
  const chosen = want ? chooseTarget(targets, want, { prefer: 'startable' }) : soleStartable(targets);
  assertActionable(chosen, 'start');
  err(`[verikun] --ensure-device: booting ${targetLabel(chosen)}…`);
  await lc.boot(chosen, {
    timeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
    wait: true,
    wipe: false,
    onProgress: (m) => err(`[verikun] ${m}`),
  });
}

/** The remote half of `--ensure-device`: ask the server to boot, then re-ping so the
 *  run context carries the serial the device actually came up as. */
async function ensureRemoteDevice(
  health: HealthResponse,
  opts: RemoteOpts,
  url: string,
  flags: Flags,
): Promise<HealthResponse> {
  const want = ensureDeviceTarget(flags);
  if (want === null) return health;
  if (health.serial) {
    err(`[verikun] --ensure-device: ${health.serial} is already bound on ${url}${want ? ` — not booting '${want}'` : ''}`);
    return health;
  }
  assertDeviceControl(health, url, want);
  err(`[verikun] --ensure-device: asking ${url} to boot a device…`);
  await remoteDeviceOp(opts, 'start', want ? { target: want } : {});
  return pingServer(opts);
}

/** Feature-detect device control from /v1/health. Never compare versions: a client
 *  cannot tell "old server" from "new server, flag off", and both need this answer. */
function assertDeviceControl(health: HealthResponse, url: string, target?: string): void {
  if (!health.deviceControlEnabled) {
    throw new CliError(
      `device control is not available on the verikun server at ${url} (verikun ${health.version}). ` +
        'Restart it with --allow-device-control.',
      3,
    );
  }
  if (target && !health.deviceNamingEnabled) {
    throw new CliError(
      `the server at ${url} was started with a bare --allow-device-control — it can only act on its own ` +
        `device, not '${target}'. Restart it with --allow-device-control=<names>.`,
      2,
    );
  }
}

async function cmdDevicesRemote(
  verb: LifecycleVerb,
  target: string | undefined,
  url: string,
  flags: Flags,
): Promise<number> {
  const opts = remoteOptsFrom(url, flags);
  const health = await pingServer(opts); // fails fast (exit 3) on a bad URL or key
  assertDeviceControl(health, url, target);
  const wipe = flagBool(flags, 'wipe');
  err(`[verikun] ${verb} device on ${url}${target ? ` (${target})` : ''}${wipe ? ' with WIPE' : ''}…`);
  const r = await remoteDeviceOp(opts, verb, { ...(target ? { target } : {}), ...(wipe ? { wipe } : {}) });
  err(
    `[verikun] ${r.changed ? `${verb} ok` : 'already running'} · ${r.serial ?? '(none)'} · ` +
      `${(r.durationMs / 1000).toFixed(1)}s`,
  );
  if (flagBool(flags, 'json')) json({ action: verb, server: url, ...r });
  else out(r.serial ?? '');
  return 0;
}

async function cmdDevicesRemoteList(url: string, flags: Flags): Promise<number> {
  const opts = remoteOptsFrom(url, flags);
  const health = await pingServer(opts);
  assertDeviceControl(health, url);
  const r = await remoteDeviceList(opts);
  if (flagBool(flags, 'json')) {
    json({ server: url, ...r });
    return 0;
  }
  if (r.devices.length) for (const line of formatDeviceTable(r.devices)) out(line);
  else err('No devices visible on the server.');
  err(`[verikun] bound: ${r.bound ?? '(none)'}${r.startable.length ? ` · startable: ${r.startable.join(', ')}` : ''}`);
  return 0;
}

async function resolveBackend(platform: Platform, device: string | undefined, flags: Flags): Promise<ResolvedBackend> {
  const server = serverFromFlags(flags);
  if (!server) {
    await ensureLocalDevice(platform, device, flags);
    const driver = getDriver(platform, device);
    // Fail fast on a broken toolchain BEFORE any model spend — the mirror of the
    // remote branch's pingServer below. Without this, a missing `idb` isn't noticed
    // until the first step that reads the hierarchy (launch/screenshot go through
    // simctl on a simulator), by which point every test in a suite has been compiled.
    driver.preflight();
    return {
      backend: {
        exec: (command, positionals, f) => executeOutcome(command, positionals, f, driver),
        getElements: () => driver.getElements(),
        getLogs: (opts) => driver.getLogs(opts),
        install: (appPath) => driver.install(appPath),
        reset: (appId) => {
          assertSafeAppId(appId);
          // iOS has no per-app data reset — degrade honestly to a force-stop.
          if (platform === 'ios') driver.stop(appId);
          else driver.clearApp(appId);
        },
        preflight: () => driver.preflight(),
        captureFailure: async () => {
          // Two independent tries: a screencap can succeed where a dump doesn't (and
          // vice versa), and neither is allowed to derail recording the failure.
          const out: { png?: Buffer; hierarchy?: Element[] } = {};
          try {
            out.png = capturePng(driver, null).buf;
          } catch {
            /* device may be gone — that may be why we failed */
          }
          try {
            out.hierarchy = driver.getElements({ all: false });
          } catch {
            /* ditto */
          }
          return out;
        },
      },
      platform,
      device,
    };
  }

  let runCtx: { platform: string; device?: string } = { platform, device };
  const opts: RemoteOpts = {
    url: server,
    authKey: flagStr(flags, 'auth-key') || process.env.VERIKUN_SERVER_AUTH_KEY || undefined,
    // Each remote step is spliced into the local active run so the archived report
    // is identical to a local run's. logStart travels from the server's device clock
    // so archive-time / vk log scoping works without a local driver.
    onStep: (step, artifacts, logStart) =>
      Recorder.appendForeignStep(step, artifacts, { ...runCtx, logStart }),
  };
  let health = await pingServer(opts); // fails fast (exit 3) on a bad URL or key
  // `--ensure-device` boots BEFORE runCtx is fixed: resolveBackend bakes the serial
  // into the run context and the returned device, so booting afterwards would
  // attribute every spliced step to a device that didn't exist yet.
  health = await ensureRemoteDevice(health, opts, server, flags);
  runCtx = { platform: health.platform, device: health.serial ?? undefined };
  err(`[verikun] server ${server}: ${health.platform} · device ${health.serial ?? '(none)'} · verikun ${health.version}`);
  // Say the read path once, here. Reads execute server-side, so this is the only end of the
  // connection that knows it — and without it a companion that had silently stood down was
  // indistinguishable from one that never engaged, for a whole suite (issue #77). An older
  // server omits the field; saying nothing is better than guessing.
  if (health.reads) err(`[verikun] server reads: ${health.reads.path} (${health.reads.detail})`);
  const remote = createRemoteBackend(opts, health);
  return {
    backend: {
      ...remote,
      // Ping first (URL, key, version), then fetch the hierarchy once. The ping alone
      // is NOT enough as a health probe: /v1/health answers from config captured at
      // server startup and never touches the device, so it cannot see a phone that was
      // unplugged next to the server — the suite's mid-run re-probe would call it
      // healthy and keep grinding. One dump is the cheap call that actually proves it.
      preflight: async () => {
        await pingServer(opts);
        await remote.getElements();
      },
      // Hierarchy only: the server exposes no screenshot route, so a remote run's
      // engine failure archives without a picture. Honest degrade over a protocol
      // change here — tracked in #48.
      captureFailure: async () => {
        try {
          return { hierarchy: await remote.getElements() };
        } catch {
          return {};
        }
      },
    },
    platform: health.platform,
    device: health.serial ?? undefined,
    remote: { url: server, version: health.version, reads: health.reads },
  };
}

export interface TerminalFailure {
  where: string;
  reason: string;
  kind: 'fail' | 'env' | 'budget' | 'timeout';
}

/**
 * The one terminal-failure record for a non-ok engine result — `null` when the run
 * passed. Exported for the unit suite.
 *
 * Budget and timeout aborts come back from the engine as a bare flag with NO `failure`
 * object, so their reason is composed here; `where` is `run` because the abort is not
 * attributable to one node. Both the recorded failure and the `[ai] …` status line are
 * built from this, so the archive and the console cannot disagree about why a run died.
 */
export function terminalFailure(
  r: {
    ok: boolean;
    failure?: { where: string; reason: string };
    abortedForBudget?: boolean;
    abortedForTimeout?: boolean;
    abortedForEnv?: boolean;
  },
  opts: { maxCostUsd: number; timeoutMs: number },
): TerminalFailure | null {
  if (r.ok) return null;
  if (r.abortedForEnv) {
    return { where: r.failure?.where ?? 'run', reason: r.failure?.reason ?? 'device unavailable', kind: 'env' };
  }
  if (r.abortedForBudget) {
    return { where: r.failure?.where ?? 'run', reason: `cost ceiling $${opts.maxCostUsd} reached`, kind: 'budget' };
  }
  if (r.abortedForTimeout) {
    return { where: 'run', reason: `run timeout (${Math.round(opts.timeoutMs / 1000)}s) reached`, kind: 'timeout' };
  }
  return { where: r.failure?.where ?? 'run', reason: r.failure?.reason ?? 'failed', kind: 'fail' };
}

/** The `[ai] …` console verdict for a terminal failure, phrased as it always was. */
function terminalStatusLine(t: TerminalFailure): string {
  if (t.kind === 'fail') return `FAIL at ${t.where}: ${t.reason}`;
  return `ABORTED — ${t.kind === 'env' ? `environment: ${t.reason}` : t.reason}`;
}

/**
 * Best-effort archive-time device-log capture via an ExecBackend (local driver or
 * remote `/v1/logs`). Writes `artifacts/logcat.txt` onto the active run so a later
 * `Recorder.archive()` finds `logFile` already set. Never throws — a gone device
 * must not prevent sealing the report.
 */
async function prefetchArchiveLogs(backend: ExecBackend, noLogs = false): Promise<void> {
  const state = Recorder.status();
  if (!state) return;
  const hasFailures = state.steps.some((s) => s.status !== 'passed');
  if (!wantsArchiveLogs(hasFailures, noLogs)) return;
  if (!backend.getLogs) return;
  // Skip only when both artifacts are already attached (e.g. a prior prefetch).
  if (state.logFile && state.appLogFile) return;
  const window = archiveLogWindow(state);
  try {
    const full = state.logFile ? undefined : await backend.getLogs(window);
    const appId = inferRunAppId(state);
    let app: string | undefined;
    if (appId && !state.appLogFile) {
      try {
        app = await backend.getLogs({ ...window, appId, scopedOnly: true });
      } catch (e) {
        err(`[verikun] could not capture archive app logs (${(e as Error).message})`);
      }
    }
    if (full !== undefined || (app !== undefined && app !== '')) {
      Recorder.attachArchiveLogs(full, app);
    }
  } catch (e) {
    err(`[verikun] could not capture archive device logs (${(e as Error).message})`);
  }
}

/**
 * Run one natural-language test through a backend and return DATA — no stdout
 * writes (stdout stays the caller's one result; progress streams to stderr).
 * `vk ai` wraps it with its --json/report output; `vk suite` calls it per test.
 */
async function runAiTest(
  file: string,
  opts: AiOptions,
  backend: ExecBackend,
  platform: Platform,
  device: string | undefined,
): Promise<AiRunResult> {
  const nl = readAiTest(file);
  const key: CacheKeyInput = { nl, pkg: opts.pkg, build: opts.build, platform };
  const cost = new CostTracker(opts.price, opts.maxCostUsd);
  const deadline = Date.now() + opts.timeoutMs;
  const provider = makeProvider(opts);

  const { plan, cached } = await obtainPlan(key, file, opts, cost, provider);

  // Running needs the provider for repair-on-failure; a cache hit with no key can't repair.
  if (!provider) {
    throw new CliError(`${providerRequirement(opts.model)} — needed to repair a failing step at runtime (model ${opts.model}).`, 3);
  }

  // The budget is a TOTAL-run ceiling: if the compile alone already crossed it, abort
  // before running. A cache hit spends nothing, so a free replay is still allowed.
  if (!cached && cost.exceeded()) {
    err(`[ai] cost ceiling $${opts.maxCostUsd} reached during compile (${cost.summaryLine()}) — not running`);
    return {
      ok: false,
      cached,
      costUsd: Number(cost.usd().toFixed(4)),
      costLine: cost.summaryLine(),
      modelRepairs: 0,
      improvements: [],
      runDir: '',
      reportHtml: '',
      junitXml: '',
      state: null,
      abortedForBudget: true,
      failure: { where: 'compile', reason: `cost ceiling $${opts.maxCostUsd} reached during compile` },
    };
  }

  // One explicit run for the whole flow (so rollover can't split the test).
  const existing = Recorder.status();
  if (existing && existing.steps.length > 0) {
    // Seal the pre-existing run into the archive instead of letting start(force=true)
    // discard it — a manual in-progress run should never be silently lost.
    await prefetchArchiveLogs(backend);
    const sealed = Recorder.archive();
    err(`[ai] archived the active run ('${existing.name}', ${existing.steps.length} step(s)) → ${sealed.dir}`);
  }
  const started = Recorder.start(`ai: ${basename(file)}`, platform, device, true);
  // Prefer --package when the prose never launches by id (rare but possible).
  if (opts.pkg) Recorder.annotateRun({ appId: opts.pkg });

  // Suppress per-step `out()` so stdout stays the one final result; progress -> stderr.
  const prevQuiet = setOutputQuiet(true);
  let result: Awaited<ReturnType<typeof runPlan>>;
  try {
    result = await runPlan(plan, {
      exec: (command, pos, f) => backend.exec(command, pos, f),
      getElements: () => backend.getElements(),
      provider,
      cost,
      log: (m) => err(m),
      markHealed: (m) => Recorder.markLastStepHealed(m),
      maxRepairs: 3,
      guardSettleMs: guardSettleMs(),
      runId: started.id,
      deadline,
      // The RESOLVED platform — for --server that is the server's, which supersedes
      // the client's --platform (leaves are gated server-side; guards run here).
      platform,
    });
  } catch (e) {
    // An unexpected throw mid-run (e.g. an unrecoverable device error) must still
    // seal the run so it is not left dangling in .verikun/run/ for the next command
    // to roll over. Then let the error map to an exit code as usual.
    Recorder.annotateRun({ ai: { ok: false, cost: cost.summaryLine(), modelRepairs: 0, improvements: [] } });
    // No evidence capture here: a throw at this level usually IS the device dying, so
    // the capture would fail the same way and only add noise to the error path.
    Recorder.recordTerminalFailure({
      where: 'run',
      reason: (e as Error).message,
      kind: isEnvError(e as Error) ? 'env' : 'fail',
    });
    try {
      await prefetchArchiveLogs(backend);
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

  // Persist the (possibly repaired) plan only on a fully-green run; attach the
  // cost + improvements summary to the run; archive into the report.
  const costLine = cost.summaryLine();
  if (result.ok) {
    try {
      writePlan(key, result.plan);
      err('[ai] cached the green plan for next run');
    } catch (e) {
      err(`[ai] could not cache plan: ${(e as Error).message}`);
    }
  }
  // A failure the engine produced (a control node giving up, a budget/timeout abort)
  // never ran through a command, so nothing recorded it — without this the archive
  // declares the failed test green. Must come BEFORE the archive that renders it.
  const terminal = terminalFailure(result, opts);
  if (terminal) Recorder.recordTerminalFailure(terminal, await backend.captureFailure?.());

  Recorder.annotateRun({
    ai: { ok: result.ok, cost: costLine, modelRepairs: result.modelRepairs, improvements: result.improvements },
  });
  await prefetchArchiveLogs(backend);
  const { dir, xmlPath, htmlPath, state } = Recorder.archive();

  err(`[ai] ${terminal ? terminalStatusLine(terminal) : 'PASS'} · ${costLine}`);
  err(`[ai] report: ${htmlPath}`);
  if (result.improvements.length) {
    err(`[ai] ${result.improvements.length} suggested improvement(s) (also in the report):`);
    for (const imp of result.improvements) err('  - ' + imp);
  }
  err(`[ai] estimated total cost: $${cost.usd().toFixed(4)}`);

  return {
    ok: result.ok,
    cached,
    costUsd: Number(cost.usd().toFixed(4)),
    costLine,
    modelRepairs: result.modelRepairs,
    improvements: result.improvements,
    runDir: dir,
    reportHtml: htmlPath,
    junitXml: xmlPath,
    state,
    ...(result.failure ? { failure: result.failure } : {}),
    ...(result.abortedForBudget ? { abortedForBudget: true } : {}),
    ...(result.abortedForTimeout ? { abortedForTimeout: true } : {}),
    ...(result.abortedForEnv ? { abortedForEnv: true } : {}),
  };
}

async function cmdAi(positionals: string[], flags: Flags): Promise<number> {
  const file = positionals[0];
  if (!file) {
    throw new CliError('Usage: verikun ai <file> [--model m] [--max-cost-usd n] [--timeout dur] [--server url] [--show-plan] [--recompile]', 2);
  }
  const opts = parseAiOptions(flags);
  setProcessScoped(true); // one process for the whole run — see claims.ts's isLive

  // --show-plan: compile (or cache-hit) and print the IR — no device, no backend.
  if (flagBool(flags, 'show-plan')) {
    const nl = readAiTest(file);
    const key: CacheKeyInput = { nl, pkg: opts.pkg, build: opts.build, platform: platformFromFlags(flags) };
    const cost = new CostTracker(opts.price, opts.maxCostUsd);
    const { plan } = await obtainPlan(key, file, opts, cost, makeProvider(opts));
    json(plan);
    return 0;
  }

  const reqPlatform = platformFromFlags(flags);
  const { backend, platform, device } = await resolveBackend(reqPlatform, deviceFromFlags(flags, reqPlatform), flags);
  let result: AiRunResult;
  try {
    result = await runAiTest(file, opts, backend, platform, device);
  } finally {
    // Undo any device setting the test changed, INCLUDING when it failed part-way —
    // otherwise an unattended run leaves the phone offline or in dark mode.
    await restoreDeviceOverrides(backend);
    await backend.close?.(); // frees a remote server's device lock for the next command
    releaseOwnClaims(); // and the host-level claim, so the next job can have the device
  }

  if (flagBool(flags, 'json')) {
    json({
      ok: result.ok,
      cached: result.cached,
      model: opts.model,
      cost: result.costLine,
      costUsd: result.costUsd,
      modelRepairs: result.modelRepairs,
      improvements: result.improvements,
      report: result.reportHtml,
      junit: result.junitXml,
      runDir: result.runDir,
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.abortedForBudget ? { abortedForBudget: true } : {}),
      ...(result.abortedForTimeout ? { abortedForTimeout: true } : {}),
      ...(result.abortedForEnv ? { abortedForEnv: true } : {}),
    });
  } else if (result.reportHtml) {
    out(result.reportHtml); // primary machine result: the report path
  }
  // An environment failure is exit 3, not 1: the box is broken, not the app. Exit 1
  // here would be indistinguishable from a real regression and page the wrong person.
  return result.abortedForEnv ? 3 : result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// install — put an app build on the device (local driver or remote vk server)
// ---------------------------------------------------------------------------

async function cmdInstall(positionals: string[], flags: Flags): Promise<number> {
  const appPath = positionals[0];
  if (!appPath) throw new CliError('Usage: verikun install <app.apk|app.ipa> [--server url]', 2);
  const path = resolve(process.cwd(), appPath);
  if (!existsSync(path)) throw new CliError(`install: '${appPath}' does not exist`, 2);
  const platform = platformFromFlags(flags);
  const { backend, remote } = await resolveBackend(platform, deviceFromFlags(flags, platform), flags);
  err(`[verikun] installing ${appPath}${remote ? ` via ${remote.url}` : ''}…`);
  try {
    await backend.install(path);
  } finally {
    await backend.close?.();
  }
  if (flagBool(flags, 'json')) json({ installed: appPath, ...(remote ? { server: remote.url } : {}) });
  else out(`installed ${appPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// suite — run a directory of natural-language tests as one gated suite
// ---------------------------------------------------------------------------

async function cmdSuiteEntry(positionals: string[], flags: Flags): Promise<number> {
  const dirArg = positionals[0];
  if (!dirArg) throw new CliError('Usage: verikun suite <dir> [--app <id>] [--server url] [--name n] [--retries n] [--json]', 2);
  const opts = parseAiOptions(flags);
  setProcessScoped(true); // one process for the whole suite — see claims.ts's isLive
  // Pre-flight the provider BEFORE touching any device/server: every test needs it
  // to compile (on a cache miss) or to repair at runtime.
  if (!providerAvailable(opts.model)) {
    throw new CliError(`${providerRequirement(opts.model)} — needed to compile/repair tests (model ${opts.model}).`, 3);
  }
  const reqPlatform = platformFromFlags(flags);
  const { backend, platform, device, remote } = await resolveBackend(reqPlatform, deviceFromFlags(flags, reqPlatform), flags);
  const app = flagStr(flags, 'app');
  if (app) assertSafeAppId(app);
  try {
    return await cmdSuite(dirArg, flags, {
      platform,
      device,
      ...(remote
        ? { server: { url: remote.url, verikun: remote.version, reads: remote.reads?.path } }
        : {}),
      runTest: (file) => runAiTest(file, opts, backend, platform, device),
      // Reset app state between tests only when the app id is known; without --app,
      // each test is responsible for its own isolation (e.g. `launch --clear`).
      reset: app ? () => backend.reset(app) : undefined,
      preflight: () => backend.preflight?.(),
    });
  } finally {
    await restoreDeviceOverrides(backend);
    await backend.close?.();
    releaseOwnClaims();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
/**
 * Inspect or stop the on-device companion (`tools/verikun-companion`).
 *
 * `stop` exists because the companion holds the device's ONE UiAutomation connection for as
 * long as it runs, which locks out Appium, Layout Inspector and a second verikun. Without a
 * way to hand that back, the only recourse would be `adb shell pkill`.
 */
function cmdCompanion(ctx: Ctx): number {
  const action = ctx.positionals[0] ?? 'status';
  if (action !== 'status' && action !== 'stop') {
    throw new CliError(`Usage: verikun companion <status|stop>`, 2);
  }
  if (ctx.platform !== 'android') {
    throw new CliError('The companion is Android-only; iOS reads the hierarchy through idb, which is already fast.', 3);
  }
  const companion = new Companion({
    adb: process.env.ADB || 'adb',
    serial: ctx.driver.resolvedSerial(),
    // `status`/`stop` never calibrate, so this is unreachable — but a throwing stub is
    // honest about that, where a silent no-op would hide a future miswiring.
    stockDump: () => {
      throw new CliError('the companion command never calibrates', 3);
    },
  });
  if (action === 'stop') {
    companion.stop();
    if (flagBool(ctx.flags, 'json')) json({ companion: 'stopped' });
    else out('companion stopped');
    return 0;
  }
  const state = companion.describe();
  if (flagBool(ctx.flags, 'json')) json({ companion: state, enabled: companionEnabled() });
  else {
    out(state);
    if (!companionEnabled()) err('note: disabled by VERIKUN_COMPANION — hierarchy reads use the slower stock dump');
  }
  return 0;
}

// ---------------------------------------------------------------------------

async function executeCommand(command: string, ctx: Ctx): Promise<number> {
  switch (command) {
    case 'doctor':
      return cmdDoctor(ctx);
    case 'companion':
      return cmdCompanion(ctx);
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
    case 'device':
      return cmdDevice(ctx);
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
  const recordable = isRecordable(command, positionals);
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
      // Keep this job's device claim alive. Deliberately NOT gated on the recorder:
      // `Recorder.beginStep` returns null under VERIKUN_NO_RUN=1 (which the e2e suite
      // sets), and hanging the heartbeat off it would silently stop claims from being
      // refreshed for exactly the runs that exercise them.
      if (serial) touchClaim(serial, platform);
      recorder = Recorder.beginStep(command, positionals, flags, platform, device, serial, driver);
    }
  } catch (e) {
    return { code: e instanceof CliError ? e.exitCode : 3, error: e as Error };
  }
  const d = driver!; // assigned in the try above, or we already returned
  const ctx: Ctx = { driver: d, platform, device, positionals, flags, record: recorder ?? undefined };
  return runRecorded(command, ctx, recorder, d);
}

/** The shared middle of executeOutcome / executeForServer: run the handler, close
 *  the step (with failure evidence) whether it returned or threw, map to a raw
 *  outcome (the error NOT printed — callers decide). */
async function runRecorded(
  command: string,
  ctx: Ctx,
  recorder: Recorder | null,
  driver: Driver,
): Promise<{ code: number; error?: Error }> {
  try {
    const code = await executeCommand(command, ctx);
    recorder?.finish(code, driver);
    return { code };
  } catch (e) {
    recorder?.finishError(e as Error, driver);
    return { code: e instanceof CliError ? e.exitCode : 3, error: e as Error };
  }
}

/**
 * `vk server`'s per-request executor: run one already-validated leaf against the
 * server's fixed driver/platform (a client can never repoint the device via flags),
 * recording into an EPHEMERAL single-step recorder instead of the local run store.
 * Returns the raw outcome plus the finished step + artifact buffers, which travel
 * back over the wire and are spliced into the CALLER's run — so `resolved`/`tier`/
 * failure evidence survive remoting with zero handler changes.
 */
export async function executeForServer(
  command: string,
  positionals: string[],
  flags: Flags,
  driver: Driver,
  platform: Platform,
): Promise<{ code: number; error?: Error; step?: RunStep; artifacts?: Record<string, Buffer>; logStart?: string }> {
  let serial: string | undefined;
  try {
    serial = driver.resolvedSerial();
  } catch {
    /* surfaced by the command handler below */
  }
  // A server holds one device for its whole life, but its claim still has to look alive
  // to everyone else on the host — refresh it per request, the same as a local step.
  if (serial) touchClaim(serial, platform);
  // Sample the device clock up front so the caller's run can set logStart (the
  // ephemeral recorder never persists RunState). Best-effort — empty/unavailable
  // just means archive / vk log fall back to last-N.
  let logStart: string | undefined;
  try {
    const t = driver.deviceTime();
    if (t) logStart = t;
  } catch {
    /* device clock unavailable */
  }
  const recorder = Recorder.beginEphemeralStep(command, positionals, flags, platform, serial);
  const ctx: Ctx = { driver, platform, device: serial, positionals, flags, record: recorder };
  const outcome = await runRecorded(command, ctx, recorder, driver);
  const { step, artifacts } = recorder.takeEphemeral();
  return { ...outcome, step, artifacts, ...(logStart ? { logStart } : {}) };
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
  // `devices` is wholly a meta-command: it must not build a local driver. Lifecycle is
  // what you run when there ISN'T one, a `--server` call needs no local device at all,
  // and even the bare listing probes both backends itself rather than using ctx.driver.
  // Dispatched in exactly one place on purpose — a command split across the switch AND
  // this chain reads as two commands to anything parsing the dispatch (tests/docs-coverage).
  if (command === 'devices') {
    try {
      return await cmdDevicesEntry(positionals, flags);
    } catch (e) {
      return mapError(e, flags);
    }
  }
  // `ai`/`suite`/`install`/`server` orchestrate their own steps; map their thrown
  // CliErrors to exit codes here (usage 2 / env 3 / …) so they honor the exit-code
  // contract instead of escaping to the top-level "Fatal" handler (exit 3).
  if (command === 'ai') {
    try {
      return await cmdAi(positionals, flags);
    } catch (e) {
      return mapError(e, flags);
    }
  }
  if (command === 'suite') {
    try {
      return await cmdSuiteEntry(positionals, flags);
    } catch (e) {
      return mapError(e, flags);
    }
  }
  if (command === 'install') {
    try {
      return await cmdInstall(positionals, flags);
    } catch (e) {
      return mapError(e, flags);
    }
  }
  if (command === 'server') {
    // Dynamic import: keeps node:http off the default load path and avoids a
    // static cli↔server cycle (server.ts imports executeForServer from here).
    try {
      const { cmdServer } = await import('./server');
      return await cmdServer(positionals, flags);
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
  install <app.apk|.ipa> [--server url]   Install a build on the device (adb install -r /
                                      idb install). With --server, uploads the file to a
                                      remote vk server (which must run --allow-install)

DEVICE STATE (change the device the app runs on, then put it back)
  device set <key>=<value> ...        Apply settings, snapshotting each original first.
                                      Keys: ${SETTING_KEYS.join(', ')}
                                      e.g. \`device set airplane=on\` to test offline handling,
                                      \`device set dark=on font-scale=1.3 rotation=landscape\`.
                                      Each change is verified by reading it back — the
                                      underlying device commands silently no-op on some skins.
  device get [key] [--json]           Show current values ('n/a' where unsupported)
  device reset [key ...]              Restore what this run changed. batch/ai/suite also
                                      do this automatically when the flow ends OR fails,
                                      so a dead test can't leave the phone offline.
  device caps [--json]                What this platform supports, and the manual
                                      equivalent where it doesn't
                                      Refuses \`airplane=on\` over wireless adb (it would cut
                                      this very connection); --allow-wireless overrides.
  device release [serial] [--json]    Hand a claimed device back to the pool. Claims
                                      expire on their own; this is for when you don't
                                      want to wait. See \`devices\` for who holds what.

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
                                      ANTHROPIC_API_KEY (Claude), OPENAI_API_KEY (gpt-*),
                                      or a logged-in agent CLI — no API key: --model
                                      codex-cli uses your 'codex login' ChatGPT
                                      subscription, cursor-cli your 'cursor-agent login'
                                      Cursor one (cost is $0 for both, so
                                      --max-cost-usd/--cost-override are no-ops).
                                      Progress -> stderr; the report path ->
                                      stdout. --show-plan prints the compiled IR without
                                      running; --recompile ignores the cache.
                                      Models: claude-haiku-4-5 | claude-sonnet-4-6
                                      (default) | claude-opus-4-8 | claude-fable-5 |
                                      gpt-5.4-mini | gpt-5.4 | gpt-5.5 | gpt-4.1 |
                                      codex-cli | cursor-cli.

SUITE (run a directory of natural-language tests as one gated suite)
  suite <dir> [--app <id>] [--name n] [--retries n] [--json]
                                      (+ all \`ai\` flags, incl. --server)
                                      Run every *.md in <dir> (lexicographic order —
                                      prefix 01-, 02- to sequence; README.md skipped)
                                      through \`vk ai\`. With --app, app data is reset
                                      between tests (iOS: force-stop). --retries N
                                      re-runs a failed test up to N times; a later
                                      pass recovers the suite (exit 0) and surfaces a
                                      warning, keeping failed-attempt evidence in the
                                      report. Writes a suite overview to
                                      ./.verikun/suites/<id>/{index.json, index.html}
                                      linking each test's report. Exits 1 if any test
                                      failed — the CI gate.

SERVER (expose a locally-connected device to remote verikun clients)
  server [--bind addr] [--port n] [--auth-key k] [--allow-install]
         [--allow-device-control[=names]]
         [--allow-unsafe-anonymous]  Serve THIS machine's device over HTTP+JSON for
                                      \`vk ai/suite/install --server <url>\`. Only
                                      verikun's validated action grammar is runnable
                                      (never a shell); auth is required (a key is
                                      generated if none given; --allow-unsafe-anonymous
                                      opts out for trusted networks e.g. Tailscale);
                                      binds 127.0.0.1 by default (--bind to expose);
                                      one run at a time holds the device lock.
                                      Env: VERIKUN_SERVER_AUTH_KEY (keeps it off argv).
  Clients: pass --server <url> (or VERIKUN_SERVER) + --auth-key (or
  VERIKUN_SERVER_AUTH_KEY) to ai/suite/install. The server's device+platform apply.
  --allow-device-control lets a client restart/stop the server's OWN device (for a
  device gone flaky mid-suite); --allow-device-control=<avd,sim> additionally lets it
  START one of those named targets — and, with it, ERASE the device (--wipe). With
  the flag the server also starts even when no device is attached, so a client can
  boot one: \`vk devices start|stop|restart [name] --server <url>\`, or add
  --ensure-device[=name] to ai/suite/install to boot once before the first step.

ENVIRONMENT
  devices [--all] [--json]            List attached devices/simulators, and which job is
                                      already driving each (USED BY); --all also lists
                                      startable (not-yet-booted) AVDs/simulators
  devices start <name> [--wipe]       Boot an AVD/simulator; prints its serial. Already
        [--timeout dur] [--no-wait]   running = a no-op. --wipe erases its data first
  devices stop <name|serial>          Shut a running emulator/simulator down
  devices restart <name> [--wipe]     Stop then boot (use for a wedged/flaky device)
  doctor [--fix]                      Diagnose adb/device, and warn if this CLI or the
                                      Claude Code plugin is out of date (a warning only —
                                      it never changes the exit code). --fix disables
                                      animations. VERIKUN_NO_UPDATE_CHECK skips the check
  companion <status|stop> [--json]    On-device hierarchy reader (Android, on by default;
                                      VERIKUN_COMPANION=0 opts out)
  Note: \`devices stop\` powers a DEVICE off; \`stop <appId>\` force-stops an APP, and
  \`device set\` (singular) changes settings on the device you are driving.
  Physical devices are never power-cycled. Env: VERIKUN_EMULATOR (path to the SDK's
  \`emulator\` binary, if it isn't on PATH or under \$ANDROID_HOME).

TEST RUNS (actions are recorded; a run auto-starts on first action)
  run start [name] [--force]          Begin a named run (else one starts implicitly)
  run status                          Show the active run, its device/session, and steps
  run archive [name] [--no-logs]      Write JUnit + HTML report, move to ./.verikun/runs/<id>/
                                      Captures artifacts/logcat.txt by default (session-scoped);
                                      --no-logs / VERIKUN_NO_LOGS skips on green runs (failures
                                      still capture). Capture is best-effort and never blocks archive.
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
  State:     --enabled / --selected / --checked / --focused, each with a --not-
             form (--not-selected). Unset = don't care. Use the negative to guard
             a toggle: tapping a picker whose options share a handler FLIPS it, so
             an unconditional tap lands on the wrong mode and still exits 0.
             May be written as a flag or appended to the selector string
             ("@mode_video --not-selected") — the latter is how a \`vk ai\`
             if-present/when/repeat guard carries one.
             --selected and --focused are Android-only (idb reports neither);
             on iOS they exit 3 rather than matching nothing.

AUTO-WAIT (selector lookups retry until they resolve)
  Selector commands (tap, text, find, assert, swipe --on) re-poll the screen for
  up to 5s when a lookup misses, so a settling UI needs no explicit \`wait\`.
  --wait <dur>   override the window: 8s, 800ms, or bare ms (3000); 0 disables
  --no-wait      fail fast on the first miss (same as --wait 0)
  A \`vk ai\` plan's if-present guard has its own smaller settle window (>=2 looks at
  the screen); VERIKUN_GUARD_SETTLE_MS tunes it, 0 = old single-shot probe.
  Ambiguity is never waited on (the elements are already there). The \`wait\`
  command stays for explicit polling, including --gone, with --timeout/--interval.

AUTO-SCROLL (actions bring their target into view)
  \`tap\` / \`text\` first scroll their target into the clear — inside its scroll
  container, and out from under anything drawn over it (a sticky bar) — then act,
  so "scroll down then tap X" is just \`tap X\`. \`ui\` / \`find\` / \`assert\` never
  scroll and hide nothing: an element with no pixel on screen is listed as usual,
  marked \`offscreen\`. One that cannot be reached fails with exit 1 rather than
  being tapped at coordinates that would hit something else.
  --no-scroll    act where the element is; do not scroll to it

GLOBAL FLAGS
  -d, --device <serial>   target a specific device (or VERIKUN_DEVICE / ANDROID_SERIAL)
  -p, --platform <android|ios>   (default: android;  --ios / --android shortcuts)
  -j, --json              machine-readable output
      --                  end flag parsing (so text/args may start with '-')

EXIT CODES
  0 success · 1 not found / assertion failed / timeout · 2 usage or ambiguous selector · 3 environment error

iOS (--ios): full parity via idb — ui/tap/text/swipe/key + screenshot/launch/stop.
  Needs idb (\`brew install idb-companion\` + \`pip install fb-idb\`); see \`vk doctor --ios\`.
  Caveats: no \`clear\` (no per-app reset), \`current\` is (unknown), device logs are simulator-only.
  \`device set\`: dark + font-scale work on a SIMULATOR (font-scale maps to the nearest
  Dynamic Type category); airplane and rotation are unsupported — run \`vk device caps --ios\`.`;
}
