import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, sep, join } from 'node:path';
import { parseArgs, flagStr, flagBool, flagNum, Flags } from './args';
import { CliError, SelectorNotFoundError, isEnvError } from './errors';
import { runText, commandExists, spawnCollect } from './exec';
import { getDriver, AdbDriver, IdbDriver, probeAdb, probeXcrun, probeIdb, probeIdbCompanion } from './drivers';
import { adbTransport, severanceRisk, avdNameOf, listAvds, lockKindOf } from './drivers/adb';
import {
  allLifecycles, assertActionable, chooseTarget, isRunning, lifecycleFor, restartTarget, targetLabel,
  LifecycleTarget, LifecycleVerb,
} from './drivers/lifecycle';
import { Bounds, Driver, DeviceInfo, Element, HierarchySource, LockKind, Platform, Point, ToolProbe } from './types';
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
  ClaimGrantOpts,
  DeviceGrant,
  claimGrant,
  leaseGrant,
  processClaimGrant,
  releaseGrants,
  requireClaimGrant,
} from './device/grant';
import {
  PREP_SCREEN_TIMEOUT,
  assertPreppable,
  clearPrep,
  isPrepared,
  mergeOriginals,
  newPrepRecord,
  prepKnobs,
  readPrep,
  writePrep,
} from './device/prep';
import {
  parseSelector,
  matchElements,
  resolveOne,
  Selector,
  MatchTier,
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
import { Recorder, isRecordable, loadRunState, RunStep, archiveLogWindow, wantsArchiveLogs, inferRunAppId } from './run';
import { capturePng } from './capture';
import { Companion, companionEnabled } from './companion/manager';
import { runPlan, DEFAULT_RUN_TIMEOUT_MS, DEFAULT_GUARD_SETTLE_MS } from './agent/engine';
import { lintPlan } from './agent/lint';
import { ClaudeProvider } from './agent/claude';
import { OpenAiProvider } from './agent/openai';
import { CliProvider, CliAgentSpec, CODEX_SPEC, CURSOR_SPEC } from './agent/cli-provider';
import { AgentProvider } from './agent/provider';
import { readPlan, writePlan, findSeed, CacheEntry, CacheKeyInput } from './agent/cache';
import { takePlanLock, planLockWaitMs } from './agent/plan-lock';
import { resolveModel, parseCostOverride, priceFor, providerFor, CostTracker, DEFAULT_MAX_COST_USD, Price, ProviderId } from './agent/cost';
import { InvalidPlanError, Plan } from './agent/ir';
import { ResolvedTest, Segment, resolveIncludes, segmentLabel } from './agent/include';
import { DeviceChange, ErrorDescriptor, ExecBackend, HealthResponse, describeError, rebuildError } from './rpc';
import { DevicePoolSpec, csvList, parseDevicePool, poolSerials, resolvePoolPlatform } from './device/pool';
import { createRemoteBackend, pingServer, remoteDeviceList, remoteDeviceOp, RemoteOpts } from './agent/remote';
import { cmdSuite, AiRunResult, Lane } from './suite';
import { classifyFailure } from './device/failover';
import { sleep, DEFAULT_BOOT_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS } from './wait';
import { VERSION } from './version';
import { updateProbes } from './update-check';
import type { Ctx } from './commands/context';
import {
  matchWaiting,
  parseDuration,
  pollStep,
  readForPoll,
  resolveOneWaiting,
  waitNote,
  waitWindowMs,
} from './commands/auto-wait';

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
function scrollNote(swipes: number): string {
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
  // Blank lines separate doctor's three blocks — toolchain, device inventory, target detail.
  // Without them the target's indented lines read as a continuation of the last device row.
  out('');
  out(`devices: ${devices.length} attached, ${usable.length} usable`);
  // Probe each device, not just the one an interaction command would land on: "is there a
  // screen lock" and "is this prepared" are facts about a PHONE, and a host driving three of
  // them cannot act on an answer that does not say which. The lock read is one `dumpsys` per
  // device and the prep read is a local file, which is affordable in an explicit setup check.
  const locks = new Map<string, LockKind>();
  const rows = devices.map((d) => {
    const facts: string[] = [];
    if (d.state === 'device') {
      facts.push(readPrep(d.serial) ? 'prepared' : 'not prepared');
      const lock = lockKindOf(d.serial);
      locks.set(d.serial, lock);
      if (lock !== 'none' && lock !== 'unknown') facts.push(`screen lock: ${lock}`);
    }
    const claim = claims ? summarize(d.serial) : undefined;
    return {
      serial: d.serial,
      what: `${d.state}${d.model ? ` (${d.model})` : ''}`,
      facts: facts.join(' · '),
      claim: claim ? `[${claim.by}]` : '',
    };
  });
  // Pad each column to its widest cell so the per-device facts line up and can be scanned
  // down; trimEnd so a device with no facts and no claim leaves no trailing whitespace.
  const w = (pick: (r: (typeof rows)[number]) => string) => Math.max(...rows.map((r) => pick(r).length), 0);
  const [wSerial, wWhat, wFacts] = [w((r) => r.serial), w((r) => r.what), w((r) => r.facts)];
  for (const r of rows) {
    out(`  ${r.serial.padEnd(wSerial)}  ${r.what.padEnd(wWhat)}  ${r.facts.padEnd(wFacts)}  ${r.claim}`.trimEnd());
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
    reportTargetStatus(target, adb, locks.get(target) ?? 'unknown');
    // `--fix` is now an alias for `device prep`, so it inherits prep's gate: on a physical
    // device it refuses unless the serial was named. That refusal is the point — the old
    // `--fix` wrote permanently to whichever phone happened to be unclaimed, with no undo.
    if (flagBool(ctx.flags, 'fix')) {
      const prepFlags: Flags = flagBool(ctx.flags, 'no-sleep-when-idle') ? { 'no-sleep-when-idle': true } : {};
      return devicePrep({ ...ctx, flags: prepFlags });
    }
  }
  return ok ? 0 : 3;
}

/**
 * The extra detail for the ONE device an interaction command would land on. Every line names
 * that serial, because the listing above may have shown several and an advisory you cannot
 * attribute to a phone is not actionable.
 *
 * Reads NOTHING through `ctx.driver`, deliberately — resolving a driver claims the device, and
 * doctor surveys the host without taking anything (see the note at the device listing above).
 * The prep record is a plain file read; the animation probe goes through `adb -s <serial>`
 * directly. `lock` is passed in rather than re-probed, so the listing's read is the only one.
 */
function reportTargetStatus(serial: string, adb: string, lock: LockKind): void {
  out('');
  out(`target: ${serial} — the device an interaction command would use`);

  const rec = readPrep(serial);
  const when = rec?.preparedAt ? ` (${rec.preparedAt.slice(0, 10)})` : '';
  out(
    rec
      ? `  prepared${when} — undo with \`verikun device prep --revert --device ${serial}\``
      : `  not prepared — run \`verikun device prep --device ${serial}\``,
  );

  // Animations are still called out by name rather than folded into "not prepared": they are
  // the single most common cause of a flaky dump, and a device can be prepped and then drift.
  try {
    const vals = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'].map(
      (k) => runText(adb, ['-s', serial, 'shell', 'settings', 'get', 'global', k]).stdout.trim(),
    );
    const off = vals.every((v) => Number(v) === 0);
    out(`  animations: ${vals.join('/')} ${off ? '(off, good)' : '(ON — flaky dumps; run `verikun device prep`)'}`);
  } catch {
    err(`  animations: could not read settings on ${serial}`);
  }

  // Advisory, never a failure: a screen lock is a property of someone's phone, not a broken
  // machine. It is worth saying because of what a slept device actually does — the read
  // SUCCEEDS and returns the keyguard, so selectors miss for a reason unrelated to the app.
  if (lock !== 'none' && lock !== 'unknown') {
    // Indented to sit with the target's other lines, but it still NAMES the serial: this goes
    // to stderr (it is a diagnostic, not data), so under `vk doctor > out.txt` it appears on
    // its own with no `target:` header above it to say which phone it means.
    err(
      `  screen lock on ${serial} (${lock}) — while it is up, a read returns the lock screen ` +
        'rather than the app.\n' +
        '    Remove it on a test device (Settings > Security). verikun never asks for a PIN.',
    );
  }
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
 *  single-shot probe). */
function guardSettleMs(): number {
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
  'Usage: verikun device set <key>=<value> [<key>=<value> ...] | device get [key] | device reset [key ...] | ' +
  'device prep [--revert] [--dry-run] | device caps | device release [serial]\n' +
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
    case 'prep':
      return devicePrep(ctx);
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

/**
 * `vk device prep` — establish the test-device knob set, stickily.
 *
 * The whole point is that this OUTLIVES the run, so unlike `deviceSet` the snapshot does not
 * go into the run file (which `ai`/`suite`/`batch` auto-restore from a `finally`) but into the
 * host-global prep store. See device/prep.ts for why the two stores exist.
 *
 * Unsupported and no-op knobs are SKIPPED with a note rather than failing the command, which
 * is the difference between prep and `device set`: `set` was told which key to change and must
 * refuse if it cannot, while prep means "establish what this platform can" — so on iOS, where
 * every knob is a noop or unsupported, it honestly reports doing nothing instead of erroring.
 */
function devicePrep(ctx: Ctx): number {
  const asJson = flagBool(ctx.flags, 'json');
  const dryRun = flagBool(ctx.flags, 'dry-run');
  const serial = ctx.driver.resolvedSerial();
  if (flagBool(ctx.flags, 'revert')) return devicePrepRevert(ctx, serial, dryRun, asJson);

  // Which display policy: sleeps by itself after PREP_SCREEN_TIMEOUT, or never turns off.
  const sleepWhenIdle = !flagBool(ctx.flags, 'no-sleep-when-idle');

  // Partition by what this platform can actually do, so the gate below counts real writes.
  const skipped: Array<{ key: SettingKey; reason: string }> = [];
  const applicable: Array<{ key: SettingKey; target: string; current: string | null; why: string }> = [];
  for (const knob of prepKnobs(sleepWhenIdle)) {
    const spec = SETTINGS[knob.key];
    const support = spec.support[ctx.platform];
    if (support === 'unsupported') {
      skipped.push({ key: knob.key, reason: spec.manual[ctx.platform] ?? `not supported on ${ctx.platform}` });
      continue;
    }
    if (support === 'noop') {
      skipped.push({ key: knob.key, reason: spec.note[ctx.platform] ?? 'already satisfied on this platform' });
      continue;
    }
    // parse() so the target compares equal to a readback (`max` -> the millisecond string).
    applicable.push({
      key: knob.key,
      target: spec.parse(knob.value),
      current: ctx.driver.getDeviceSetting(knob.key),
      why: knob.why,
    });
  }

  const changes = applicable.filter((k) => k.current !== k.target);
  // `--dry-run` is deliberately NOT gated: it writes nothing, and refusing it would mean you
  // could not find out what prep would do to a phone without first asserting it is a test one.
  if (dryRun) {
    if (asJson) {
      json({ serial, prepared: isPrepared(serial), dryRun: true, changes, skipped });
    } else {
      out(`device prep ${serial} (dry run — nothing written)`);
      for (const k of applicable) {
        const state = k.current === k.target ? 'already' : `${showValue(k.current)} -> ${k.target}`;
        out(`  ${k.key.padEnd(15)} ${state}`);
        if (k.current !== k.target) out(`  ${' '.repeat(15)} ${k.why}`);
      }
      for (const s of skipped) out(`  ${s.key.padEnd(15)} skipped: ${s.reason.replace(/\n/g, ' ')}`);
    }
    return 0;
  }

  // The gate, immediately before the first write. `!!ctx.device` is true for --device AND
  // VERIKUN_DEVICE: both are a deliberate act naming one phone, which is the property asked for.
  const kind = ctx.driver.listDevices().find((d) => d.serial === serial)?.kind ?? 'physical';
  assertPreppable(kind, serial, !!ctx.device, applicable.length);

  const original: Partial<Record<SettingKey, string>> = {};
  for (const k of applicable) {
    // Snapshot even a knob already at target: `--revert` has to put back what the device
    // held before prep, and "it was already off" is exactly as much a fact as a change.
    if (k.current !== null) original[k.key] = k.current;
    if (k.current !== k.target) ctx.driver.setDeviceSetting(k.key, k.target);
  }

  // Earliest wins across re-preps, or `--revert` would restore the device to prepped.
  const prior = readPrep(serial);
  writePrep(
    newPrepRecord(serial, ctx.platform, mergeOriginals(prior?.original ?? {}, original), sleepWhenIdle),
  );

  const applied = Object.fromEntries(applicable.map((k) => [k.key, k.target]));
  ctx.record?.note({ message: `device prep ${serial} (${changes.length} changed)` });
  if (asJson) {
    json({ serial, applied, changed: changes.map((c) => c.key), skipped, sleepWhenIdle });
  } else {
    out(`device prep ${serial}: ${changes.length ? changes.map((c) => `${c.key}=${c.target}`).join(' ') : 'already prepared'}`);
    for (const s of skipped) err(`note: ${s.key} skipped — ${s.reason.replace(/\n/g, ' ')}`);
    if (sleepWhenIdle) err(`note: the display sleeps by itself after ${PREP_SCREEN_TIMEOUT} idle, and is woken on the next read`);
    warnSecureLock(ctx.platform, serial, sleepWhenIdle);
    err(`undo with: verikun device prep --revert --device ${serial}`);
  }
  return 0;
}

/**
 * Say so, once, when a device that will now sleep is behind a SECURE lock.
 *
 * The wake on the read path can only clear a *swipe* keyguard; a PIN/pattern/password one makes
 * `getElements` exit 3 rather than hand back the lock screen. That is honest, but it is a
 * failure, and prep — an explicit setup command that already resolved the serial — is where you
 * want to hear about it, not twenty minutes into a suite. It only warns: refusing would make a
 * perfectly usable device un-preppable, and `--no-sleep-when-idle` is the way out.
 */
function warnSecureLock(platform: Platform, serial: string, sleepWhenIdle: boolean): void {
  if (!sleepWhenIdle || platform !== 'android') return;
  const lock = lockKindOf(serial);
  if (lock === 'none' || lock === 'unknown') return;
  err(
    `warning: this device has a screen lock (${lock}), so a read after the display sleeps can land ` +
      'on the keyguard (verikun can only clear a swipe lock, and never asks for a PIN).\n' +
      'Remove it in Settings > Security, or keep the display lit with `verikun device prep ' +
      `--no-sleep-when-idle --device ${serial}\`.`,
  );
}

/** Put a prepared device back the way it was found, and forget it. */
function devicePrepRevert(ctx: Ctx, serial: string, dryRun: boolean, asJson: boolean): number {
  const rec = readPrep(serial);
  if (!rec) {
    if (asJson) json({ serial, prepared: false, restored: {} });
    else out(`device prep --revert ${serial}: not prepared, nothing to restore`);
    return 0;
  }
  const entries = Object.entries(rec.original) as Array<[SettingKey, string]>;
  if (dryRun) {
    if (asJson) json({ serial, prepared: true, dryRun: true, wouldRestore: rec.original });
    else {
      out(`device prep --revert ${serial} (dry run — nothing written)`);
      for (const [key, value] of entries) out(`  ${key.padEnd(15)} ${showValue(ctx.driver.getDeviceSetting(key))} -> ${value}`);
    }
    return 0;
  }

  const restored: Record<string, string> = {};
  const failed: string[] = [];
  for (const [key, value] of entries) {
    try {
      ctx.driver.setDeviceSetting(key, value);
      restored[key] = value;
    } catch (e) {
      // Best-effort, like `device reset`: one stubborn knob must not strand the rest.
      failed.push(`${key} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
  }
  // Forget the device even if a knob refused. Keeping the record would leave `vk doctor`
  // reporting it as prepped forever, and the values that DID go back are already back.
  clearPrep(serial);

  ctx.record?.note({ message: `device prep --revert ${serial}` });
  if (failed.length) err(`warning: could not restore ${failed.join(', ')}`);
  if (asJson) json({ serial, restored, ...(failed.length ? { failed } : {}) });
  else out(`device prep --revert ${serial}: ${Object.entries(restored).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to restore'}`);
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
  /**
   * `--reset-app <id>`: clear (Android) / force-stop (iOS) this app through the run's
   * OWN backend before the first step.
   *
   * `vk suite` does its between-test reset itself, so this exists for the PARALLEL
   * suite, where it has to move inside the test. Against a pooled `vk server` the
   * device is leased per run token, so a reset issued from the parent would take its
   * own lease and could easily land on a different device than the test that follows —
   * resetting one phone and testing another. Doing it here means the reset and the run
   * are the same lease by construction.
   */
  resetApp?: string;
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
  const resetApp = flagStr(flags, 'reset-app');
  if (resetApp) assertSafeAppId(resetApp);
  return {
    model,
    price: priceFor(model, override),
    maxCostUsd,
    timeoutMs,
    effort: flagStr(flags, 'effort'),
    pkg: flagStr(flags, 'package'),
    build: flagStr(flags, 'app-build'),
    recompile: flagBool(flags, 'recompile') || flagBool(flags, 'no-cache'),
    ...(resetApp ? { resetApp } : {}),
  };
}

/** Read a test and inline every `@include` it names (see agent/include.ts). The returned
 *  `nl` is the RESOLVED text, so it is what gets hashed into the plan-cache key — editing
 *  a fragment invalidates every test that includes it. */
function readAiTest(file: string): ResolvedTest {
  const resolved = resolveIncludes(file);
  if (!resolved.nl.trim()) throw new CliError(`ai: '${file}' is empty`, 2);
  return resolved;
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

/**
 * Refuse a FURTHER model call once the ceiling is crossed.
 *
 * The budget is a total-run ceiling that everything else checks *after* the fact: a compile
 * happens, and `runAiTest` then declines to run. That works while a compile is one call. It
 * stops working the moment a test can cost several — segment compiles, then a whole-file
 * fallback on top of them — so each call after the first has to ask first, exactly as the
 * lint retry already does ("the first attempt has already been billed").
 *
 * Exported solely so the unit suite can reach it.
 */
export function assertBudgetForCompile(cost: CostTracker, maxCostUsd: number, what: string): void {
  if (!cost.exceeded()) return;
  throw new CliError(`ai: cost ceiling $${maxCostUsd} reached — not ${what} (${cost.summaryLine()}).`, 1);
}

function cachePlan(key: CacheKeyInput, plan: Plan): void {
  try {
    writePlan(key, plan);
  } catch (e) {
    err(`[ai] could not cache compiled plan: ${(e as Error).message}`);
  }
}

/**
 * When this process started. Derived from `process.uptime()`, which counts from process
 * start regardless of when this module was loaded or whether the system clock is stepped.
 */
const PROCESS_STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);

/**
 * The cached plan for a segment, honouring `--recompile`.
 *
 * `--recompile` means "do not trust what is on disk", and a leftover entry from a previous
 * run must still be ignored. But three lanes must not each pay for the same shared fragment
 * either, so an entry written AFTER this process started is accepted: it cannot be a
 * leftover, it was written by a process racing this one right now.
 *
 * Scope, honestly: in a PARALLEL suite that window is one lane child (so `--recompile` still
 * recompiles a fragment roughly once per test, never more often than today); in a SERIAL
 * `vk suite`, which runs every test in one process, it is the whole suite. Widening it to
 * once-per-suite under a pool would need the parent to stamp an epoch into `laneEnv` — a new
 * env var and a new concept, for a flag whose whole meaning is "do not trust the disk".
 *
 * An unparseable `savedAt` is NaN, so the comparison is false and it recompiles.
 *
 * Exported solely so the unit suite can reach it.
 */
export function cachedSegment(segKey: CacheKeyInput, opts: AiOptions): CacheEntry | null {
  const hit = readPlan(segKey);
  if (!hit || !opts.recompile) return hit;
  return Date.parse(hit.savedAt) >= PROCESS_STARTED_MS ? hit : null;
}

/**
 * Compile a test SEGMENT AT A TIME and concatenate the results — the whole point of
 * `@include` doing more than a textual paste.
 *
 * Each contiguous chunk of prose is compiled and cached under its OWN key, so a preamble
 * shared by nine tests is compiled once and the other eight get it free. That is what
 * makes editing a shared fragment cheap: only the fragment misses its key, while every
 * test's own prose is still cached, instead of nine full recompiles. Splicing at the plan
 * level is safe because the IR is a flat list of steps (see agent/ir.ts).
 *
 * Two segments are legitimately allowed to contribute nothing: a headings-only chunk
 * (never sent to the model at all) and a chunk of pure rationale the model compiles to
 * zero steps — `no-steps` is the one InvalidPlanError a caller may swallow.
 *
 * Returns null when the split cannot be trusted — an empty result, or a lint finding
 * against the assembled plan — and the caller falls back to compiling the whole test,
 * which is exactly the pre-include behaviour. Both that fallback and each segment after
 * the first go through `assertBudgetForCompile`, so a ceiling crossed part-way stops the
 * spend instead of adding a full compile on top of what is already billed.
 *
 * "Compiled once" only held for a SERIAL suite until 0.26.0-rc.5: a pooled suite is N child
 * processes sharing one ./.verikun, so on a cold cache every lane missed the same fragment
 * at the same instant and compiled its own (issue #117). Each miss now takes a per-key lock
 * (agent/plan-lock.ts) and re-reads the cache under it.
 *
 * Exported solely so the unit suite can reach it.
 */
export async function compileFromSegments(
  segments: Segment[],
  key: CacheKeyInput,
  opts: AiOptions,
  cost: CostTracker,
  provider: AgentProvider,
): Promise<Plan | null> {
  const steps: Plan['steps'] = [];
  // ONE LOCK AT A TIME, ALWAYS. Taking every segment's lock up front would look like an
  // optimisation (one round trip instead of S) and would DEADLOCK: two tests sharing two
  // fragments enumerate them in different orders, and each would sit holding the other's
  // next lock. A process that holds at most one lock cannot hold-and-wait, and that is the
  // entire deadlock argument for this loop.
  for (const seg of segments) {
    const where = segmentLabel(seg);
    // Accounted for out loud: a silently-dropped chunk would look like lost steps.
    if (!seg.compilable) {
      err(`[ai] ${where}: headings only — nothing to compile`);
      continue;
    }
    const segKey: CacheKeyInput = { ...key, nl: seg.text };
    const hit = cachedSegment(segKey, opts);
    if (hit) {
      err(`[ai] ${where}: cached (${hit.plan.steps.length} step(s))`);
      steps.push(...hit.plan.steps);
      continue;
    }
    // A MISS is where a suite piles up: N lanes are N child processes sharing one
    // ./.verikun, so on a cold cache all N reach this line for the SAME `@include`d fragment
    // at once and all N call the model (issue #117). Serialise on the key — the first
    // compiles, the rest wait and take its result. Taken ONLY on a miss, so a green suite
    // does no lock I/O at all.
    const lock = await takePlanLock(segKey, { ceilingMs: planLockWaitMs(opts.timeoutMs) });
    try {
      // Re-read INSIDE the lock. Whoever held it was compiling exactly this key and its
      // `writePlan` lands before its release, so this is the only point at which the answer
      // cannot change under us — the same shape as claims.ts re-reading inside its takeover
      // token. Done unconditionally rather than only when we waited: a holder can finish in
      // the gap between the read above and our exclusive create. Skipped entirely when the
      // lock is not held, so a disabled or degraded lock lands on exactly the old path.
      const shared = lock.held ? cachedSegment(segKey, opts) : null;
      if (shared) {
        err(`[ai] ${where}: compiled by a concurrent run${waitNote(lock.waitedMs)} — ${shared.plan.steps.length} step(s)`);
        steps.push(...shared.plan.steps);
        continue; // `continue` from inside a try runs the finally first — that releases the lock
      }
      // Asked BEFORE the call, not after it: crossing the ceiling on the LAST segment leaves a
      // complete plan, which `runAiTest` then declines to run with a proper budget verdict —
      // far better than throwing away a finished compile. Crossing it earlier means the rest of
      // the test would go uncompiled, and a partial plan must never be cached or run.
      //
      // Asked HERE and not before the lock, though: a plan another lane just handed us is
      // FREE, and refusing it over a ceiling we were never about to spend against would fail
      // a test for somebody else's tokens.
      assertBudgetForCompile(cost, opts.maxCostUsd, `compiling ${where} — the test is only partly compiled`);
      const seed = findSeed(segKey);
      err(`[ai] ${where}: compiling with ${opts.model}…${lock.degraded ? ` (${lock.degraded})` : ''}`);
      let compiled;
      try {
        compiled = await provider.compile({ nl: seg.text, pkg: key.pkg, platform: key.platform, seed: seed?.plan, section: true });
      } catch (e) {
        // Prose with no instruction in it (a paragraph explaining WHY the next step exists)
        // is not an error at segment granularity — it just adds no steps.
        if (e instanceof InvalidPlanError && e.code === 'no-steps') {
          err(`[ai] ${where}: no steps`);
          continue;
        }
        throw e;
      }
      cost.add(compiled.usage, 'compile');
      // INSIDE the lock and before the release: a waiter re-reads the cache the instant the
      // lock disappears, so releasing first would hand it a miss and buy the second compile
      // this whole mechanism exists to prevent.
      cachePlan(segKey, compiled.plan);
      err(`[ai] ${where}: ${compiled.plan.steps.length} step(s)`);
      steps.push(...compiled.plan.steps);
    } finally {
      // Also the throw path: a compile that fails must never leave a corpse for the next
      // lane to time out on.
      lock.release();
    }
  }
  if (steps.length === 0) return null;

  const plan: Plan = { version: 1, package: key.pkg, platform: key.platform, steps };
  // The lint asks whether the ASSEMBLED plan still says what the WHOLE test said, because
  // that is the question ("does anything launch with --clear?") — a segment cannot answer
  // it alone. A finding drops the split and lets the whole-file path compile and retry.
  const findings = lintPlan(key.nl, plan);
  if (findings.length > 0) {
    err(`[ai] the assembled plan does not match the test — compiling it as one instead:\n${findings.map((f) => `- ${f.message}`).join('\n')}`);
    return null;
  }
  return plan;
}

/** Obtain the plan: a cache hit (free) or a compile (pays tokens; may seed from a
 *  prior build's plan to avoid a full recompile). A test assembled from more than one
 *  file compiles segment-at-a-time first, so shared prose is paid for once across a
 *  suite. The fresh compile is cached right away, so an unchanged test is never
 *  recompiled — even via --show-plan or after a failed run. A green run later
 *  re-persists the healed plan (never a half-healed one).
 *
 *  Exported solely so the unit suite can reach it. */
export async function obtainPlan(
  key: CacheKeyInput,
  file: string,
  opts: AiOptions,
  cost: CostTracker,
  provider: AgentProvider | null,
  segments: Segment[] = [],
): Promise<{ plan: Plan; cached: boolean }> {
  const cached = opts.recompile ? null : readPlan(key);
  if (cached) {
    err(`[ai] plan cache hit — ${opts.model} not called to compile`);
    return { plan: cached.plan, cached: true };
  }
  if (!provider) {
    throw new CliError(`${providerRequirement(opts.model)} — needed to compile the test (model ${opts.model}).`, 3);
  }
  if (segments.length > 1) {
    err(`[ai] '${file}' is assembled from ${segments.length} chunk(s) across ${new Set(segments.map((x) => x.source)).size} file(s)`);
    const split = await compileFromSegments(segments, key, opts, cost, provider);
    if (split) {
      err(`[ai] compiled ${split.steps.length} top-level step(s) · ${cost.summaryLine()}`);
      cachePlan(key, split);
      return { plan: split, cached: false };
    }
    // The split was dropped — the assembled plan failed the lint, or nothing compiled to a
    // step. Falling back means a whole-file compile ON TOP of segment calls already billed,
    // which is the same double-spend the loop refuses; the segment plans stay cached, so a
    // rerun with a larger ceiling picks up where this left off.
    assertBudgetForCompile(cost, opts.maxCostUsd, `compiling '${file}' as one instead`);
  }

  // Unlocked, unlike the per-segment compiles above, because this key is uncontended by
  // construction: `vk suite`'s queue is one `shift()` per lane, so no test file is ever in
  // flight twice. The one exception is two files whose RESOLVED text is byte-identical (two
  // copies of a test, or two files each holding only `@include _preamble.md` — which yields
  // one segment, so the split path never runs). Out of scope on purpose: two identical tests
  // are already two identical rows in the report, and the cost is one duplicate compile.
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
  cachePlan(key, compiled.plan);
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

/**
 * Run a remote read; if it failed AND the server reported it moved device, ask once more.
 *
 * This is the ONE place a failed remote read is re-asked, and the narrowness is the point.
 * It is only ever wired to `preflight` — the connect probe at `vk ai`/`vk suite` startup and
 * the suite's between-tests health check — where nothing has run yet on either device. A
 * mid-flow read is never retried: the new device has none of the state the flow built up, so
 * its screen would answer a different question than the one being asked.
 *
 * Gating on the move (rather than retrying every failure) also keeps the connect probe's
 * fail-fast property: a device that is simply broken still fails on the first try.
 *
 * Exported solely so the unit suite can reach it.
 */
export async function retryAfterDeviceMove<T>(read: () => T | Promise<T>, moved: () => boolean): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!moved()) throw e;
    return read();
  }
}

interface ResolvedBackend {
  backend: ExecBackend;
  platform: Platform;
  device?: string;
  /**
   * This run's hold on the device, whichever kind it turned out to be — a host claim
   * locally, a server lease remotely. ONE teardown for both, so a caller's `finally` says
   * "hand the device back" rather than re-deriving which of the two mechanisms it is on.
   */
  grant: DeviceGrant;
  /** Set when the backend is a remote `vk server`. `reads` is absent against a pre-0.21.1
   *  server, which did not report its hierarchy read path. */
  remote?: { url: string; version: string; reads?: HierarchySource };
  /** Devices the SERVER moved itself onto during this command, oldest first. Live — the
   *  transport pushes as it goes — so a caller reads it AFTER the work, not before.
   *  Always empty for a local backend, which has one device by construction. */
  moves: DeviceChange[];
}

/** The `--server` URL, or VERIKUN_SERVER. One helper, so `resolveBackend` and
 *  `vk devices --server` can never disagree about what "remote" means. */
function serverFromFlags(flags: Flags): string | undefined {
  return flagStr(flags, 'server') || process.env.VERIKUN_SERVER || undefined;
}

function remoteOptsFrom(url: string, flags: Flags): RemoteOpts {
  return { url, authKey: flagStr(flags, 'auth-key') || process.env.VERIKUN_SERVER_AUTH_KEY || undefined };
}

/**
 * `--ensure-device[=<target>]` — the requested target, or `undefined` for the bare
 * form, or `null` when the flag is absent.
 */
function ensureDeviceTarget(flags: Flags): string | undefined | null {
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
  if ((health.capacity ?? 0) > 1) {
    // A pooled server has devices; it just has no single one to report as `serial`.
    // Booting here would 403 (device control is single-device by design), so say what
    // is actually true rather than failing on a technicality.
    err(`[verikun] --ensure-device: ${url} already pools ${health.capacity} devices — nothing to boot`);
    return health;
  }
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
      // The claim was taken lazily, inside `driver.preflight()` → `resolvedSerial()`, and
      // when no `--device` was passed only the store knows which phone it landed on — so
      // the grant defers to `releaseOwnClaims()` rather than naming a serial it may not
      // have. `touch` is a no-op because `executeOutcome` already stamps the claim on
      // every recorded command, which beats a timer: it fires when work happens.
      grant: processClaimGrant(device, releaseOwnClaims),
      moves: [],
    };
  }

  let runCtx: { platform: string; device?: string } = { platform, device };
  const moves: DeviceChange[] = [];
  /** Set by the last move; the preflight below reads it to decide whether re-asking is
   *  warranted, then clears it. */
  let movedDuringCall: DeviceChange | undefined;
  const opts: RemoteOpts = {
    url: server,
    authKey: flagStr(flags, 'auth-key') || process.env.VERIKUN_SERVER_AUTH_KEY || undefined,
    // Each remote step is spliced into the local active run so the archived report
    // is identical to a local run's. logStart travels from the server's device clock
    // so archive-time / vk log scoping works without a local driver.
    onStep: (step, artifacts, logStart) =>
      Recorder.appendForeignStep(step, artifacts, { ...runCtx, logStart }),
    onDeviceChange: (c) => {
      moves.push(c);
      movedDuringCall = c;
      // Re-point the run context, so steps after the move are attributed to the device
      // that actually ran them. This makes `rolloverReason` seal the device-A run and
      // open a fresh one for B — intended: since a step is never replayed, no single run
      // can contain steps from two devices, and a report that claimed otherwise would lie.
      runCtx = { ...runCtx, device: c.to };
      err(
        `[verikun] server moved device: ${c.from} → ${c.to} (${c.reason})` +
          (c.retried
            ? ' — retried there'
            : ' — this step failed on the old device; the next runs on the new one'),
      );
    },
  };
  let health = await pingServer(opts); // fails fast (exit 3) on a bad URL or key
  // `--ensure-device` boots BEFORE runCtx is fixed: resolveBackend bakes the serial
  // into the run context and the returned device, so booting afterwards would
  // attribute every spliced step to a device that didn't exist yet.
  health = await ensureRemoteDevice(health, opts, server, flags);
  const remote = createRemoteBackend(opts, health);
  // Take this run's device BEFORE runCtx is fixed. Against a pool the client asked for a
  // URL, so the lease is the ONLY thing that knows which phone it got — and a step
  // attributed to the wrong device is worse than one attributed to none. Idempotent, and
  // null against a server that predates pooling (health.serial is the answer there).
  const lease = await remote.lease();
  const serial = lease?.serial ?? health.serial ?? undefined;
  const reads = lease?.reads ?? health.reads;
  runCtx = { platform: health.platform, device: serial };
  err(
    `[verikun] server ${server}: ${health.platform} · device ${serial ?? '(none)'} · verikun ${health.version}` +
      ((health.capacity ?? 1) > 1 ? ` (leased from a pool of ${health.capacity})` : '') +
      (health.failoverEnabled ? ' · failover: on' : ''),
  );
  // Devices the server has already ruled out explain a lot of otherwise-baffling
  // behaviour ("why is it on THAT phone?"), so say it once, up front.
  if (health.quarantined?.length) {
    err(`[verikun] server has ruled out ${health.quarantined.length} device(s):`);
    for (const q of health.quarantined) err(`[verikun]   ${q.serial}  ${q.reason}`);
  }
  // Say the read path once, here. Reads execute server-side, so this is the only end of the
  // connection that knows it — and without it a companion that had silently stood down was
  // indistinguishable from one that never engaged, for a whole suite (issue #77). An older
  // server omits the field; saying nothing is better than guessing.
  if (reads) err(`[verikun] server reads: ${reads.path} (${reads.detail})`);
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
        movedDuringCall = undefined;
        await retryAfterDeviceMove(
          () => remote.getElements(),
          () => movedDuringCall !== undefined,
        );
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
    device: serial,
    // The lease IS this run's hold: the transport's run token is its key, so every later
    // call — leaf, repair, archive read — lands on the phone named above. Handing it back
    // is `close()`, which is why the grant delegates rather than posting its own release:
    // two teardowns for one lease is how one of them stops being called.
    grant: leaseGrant(remote, serial),
    remote: { url: server, version: health.version, reads },
    moves,
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
  const { nl, segments } = readAiTest(file);
  const key: CacheKeyInput = { nl, pkg: opts.pkg, build: opts.build, platform };
  const cost = new CostTracker(opts.price, opts.maxCostUsd);
  const deadline = Date.now() + opts.timeoutMs;
  const provider = makeProvider(opts);

  const { plan, cached } = await obtainPlan(key, file, opts, cost, provider, segments);

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

  // Re-isolate the app BEFORE the run, on the device this process already holds.
  // Deliberately after the compile: it costs no device time to wait, and a test that
  // aborts at compile should not have disturbed the phone. A failure here throws
  // (exit 3 for a broken device), which is what a caller reads as an environment
  // abort — the same verdict `vk suite`'s own reset failure produces.
  if (opts.resetApp) {
    await backend.reset(opts.resetApp);
    err(`[ai] app state reset (${opts.resetApp})`);
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
    const { nl, segments } = readAiTest(file);
    const key: CacheKeyInput = { nl, pkg: opts.pkg, build: opts.build, platform: platformFromFlags(flags) };
    const cost = new CostTracker(opts.price, opts.maxCostUsd);
    const { plan } = await obtainPlan(key, file, opts, cost, makeProvider(opts), segments);
    json(plan);
    return 0;
  }

  const reqPlatform = platformFromFlags(flags);
  const { backend, platform, device, grant, moves } = await resolveBackend(reqPlatform, deviceFromFlags(flags, reqPlatform), flags);
  let result: AiRunResult;
  try {
    result = await runAiTest(file, opts, backend, platform, device);
  } finally {
    // Undo any device setting the test changed, INCLUDING when it failed part-way —
    // otherwise an unattended run leaves the phone offline or in dark mode.
    await restoreDeviceOverrides(backend);
    // Hand the device back — the host claim locally, the server's lease remotely. One
    // call for both, so a teardown cannot get one half right and forget the other.
    await grant.release();
  }

  if (flagBool(flags, 'json')) {
    json({
      ok: result.ok,
      cached: result.cached,
      model: opts.model,
      // Which device actually ran this. Against a POOLED `vk server` the client asks
      // for a url, not a serial, and only the lease answers — so without this a
      // parallel suite could not attribute a row to the phone that produced it. Where it
      // ENDED, not where it started: after a mid-run failover the suite's Device column
      // would otherwise name the phone the test did NOT finish on — wrong in precisely
      // the case ("is the device bad, or the test?") the column exists to answer.
      platform,
      ...(moves.length ? { device: moves[moves.length - 1].to } : device ? { device } : {}),
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
  const { backend, remote, moves } = await resolveBackend(platform, deviceFromFlags(flags, platform), flags);
  err(`[verikun] installing ${appPath}${remote ? ` via ${remote.url}` : ''}…`);
  try {
    await backend.install(path);
  } finally {
    // `close()`, deliberately NOT `grant.release()`. Remotely they are the same call; the
    // difference is local, and it is wanted: `vk install && vk suite` in one CI job wants
    // the claim to BRIDGE the two commands, so a sibling job on the same host cannot take
    // the phone in between and leave the suite running against a build it never saw. The
    // claim ages out on its own (VERIKUN_CLAIM_TTL_MIN) if no command follows.
    await backend.close?.();
  }
  // Where it LANDED, not just that it landed: after a failover that is a different
  // device than the one the run started against, and a caller acting on the old serial
  // (`adb -s … shell am start`) would be driving a phone without the build.
  const moved = moves.length ? moves[moves.length - 1] : undefined;
  if (flagBool(flags, 'json')) {
    json({ installed: appPath, ...(remote ? { server: remote.url } : {}), ...(moved ? { deviceChanged: moved } : {}) });
  } else {
    out(`installed ${appPath}${moved ? ` on ${moved.to}` : ''}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// suite lanes — one child `vk ai` process per test, one lane per device
//
// A lane is "a device plus the argv that reaches it". The parallel scheduler in
// suite.ts owns WHEN a lane runs a file; everything below owns WHAT it runs.
//
// The unit of parallelism is a CHILD PROCESS, not a promise: exec.ts is spawnSync
// throughout and the whole Driver interface is synchronous on top of it, so tests
// awaited inside one process would still serialize on every adb/idb shell-out. A
// child also gets crash isolation, its own `quiet` latch (output.ts's module global,
// which nested save/restore around each test would corrupt), and its own device-
// override restore — three of this feature's hazards solved by construction.
// ---------------------------------------------------------------------------

/** Enough of a lane to build its argv. Structural, so this half never needs suite.ts. */
interface LaneTarget {
  id: string;
  device?: string;
  server?: string;
}

/**
 * Flags `vk suite` owns, which must never reach a lane's `vk ai` child.
 *
 * `device`/`server` are here because the LANE supplies them — forwarding the suite's
 * would point every lane at one device, which is the bug this feature exists to fix.
 * `ensure-device` is refused outright on a pool (see cmdSuiteParallel), so it never needs
 * forwarding — listing it here keeps a stray one from reaching a child.
 */
const SUITE_ONLY_FLAGS = new Set([
  'devices', 'servers', 'concurrency', 'retries', 'name', 'app', 'max-suite-cost-usd',
  'device', 'server', 'ensure-device', 'json',
  // `--show-plan` makes `vk ai` print the compiled IR and return 0 BEFORE it builds a
  // backend. Forwarded to a lane it would turn every test into an instant pass that
  // touched no device, and the suite would exit 0 — a green CI gate for a run that
  // executed nothing, which is the worst outcome this tool can produce.
  'show-plan',
]);

/**
 * The argv for one lane's `vk ai` child.
 *
 * Every string flag is re-emitted in the INLINE `--name=value` form on purpose: it
 * round-trips through args.ts regardless of what the value looks like, whereas the
 * separated form silently becomes a boolean when the value begins with `-`
 * (args.ts:105). Booleans re-emit bare, which parses back to `true` in every position.
 * Exported for the unit suite.
 */
export function laneArgv(
  file: string,
  lane: LaneTarget,
  flags: Flags,
  opts: { resetApp?: string; platform?: Platform } = {},
): string[] {
  const argv = ['ai', file, '--json'];
  // ALWAYS explicit, never inherited. `--devices all-ios` pins the platform with no
  // `--ios` on the command line, and `--devices` is suite-only — so a child left to
  // re-derive it falls through to `platformFromFlags`'s android default and builds an
  // AdbDriver for a simulator UDID. Every test then fails 'device not found' while
  // `lanePreflight`, which DOES pass the platform, keeps reporting the lane healthy.
  if (opts.platform) argv.push(`--platform=${opts.platform}`);
  if (lane.device) argv.push(`--device=${lane.device}`);
  if (lane.server) argv.push(`--server=${lane.server}`);
  if (opts.resetApp) argv.push(`--reset-app=${opts.resetApp}`);
  for (const [name, value] of Object.entries(flags)) {
    if (SUITE_ONLY_FLAGS.has(name)) continue;
    if (value === false) continue; // args.ts never emits this; belt and braces
    argv.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  return argv;
}

/**
 * Environment for a lane child.
 *
 * Two overrides carry real weight. `VERIKUN_LANE` moves the child's ACTIVE run to
 * `.verikun/run-<lane>/`, without which concurrent tests delete each other's in-flight
 * state (run.ts's header explains the mechanism). `VERIKUN_NO_CLAIM` disables claims in
 * the child because the PARENT holds them for the whole suite: `isMine` matches on
 * session OR cwd (claims.ts:211), so siblings would see each other's claims as their
 * own and coordinate nothing, while each child's exit would hand its device back
 * mid-suite. Clearing `VERIKUN_SERVER` matters for a LOCAL lane — inherited, it would
 * quietly send a run meant for an attached phone to a remote server instead.
 */
export function laneEnv(lane: LaneTarget, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, VERIKUN_LANE: lane.id, VERIKUN_NO_CLAIM: '1' };
  if (!lane.server) delete child.VERIKUN_SERVER;
  if (!lane.device) delete child.VERIKUN_DEVICE;
  return child;
}

/** A short, stable label for a server lane: the host:port, not the whole URL. */
function serverLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The device pool from `--devices` / `--servers`.
 *
 * Lane IDS are positional (`d1`, `d2`, …) rather than derived from the serial, because
 * the id becomes a directory name AND the suffix of every run id the lane mints — a
 * 40-character iOS UDID would make both unreadable. The LABEL carries the serial.
 * Exported for the unit suite.
 */
export function lanesFromFlags(flags: Flags, resolveAll: (spec: DevicePoolSpec) => string[]): Lane[] | undefined {
  // `--servers` with no value parses to boolean true (args.ts), and reading it with
  // flagStr would yield undefined — silently running the SERIAL suite while the operator
  // believes they asked for a pool. (`--devices` gets the same treatment, and a better
  // message, from `parseDevicePool`.)
  if (flags['servers'] === true) {
    throw new CliError('--servers needs a value, e.g. --servers=http://a:8391,http://b:8391', 2);
  }
  // The SAME parser `vk server --devices` uses, so `all` / `all-android` / `all-ios` mean
  // the same thing on both commands. They diverged once — the suite read the word `all`
  // as a literal serial, wrote a claim file for a device that does not exist, and then
  // failed every test against `adb -s all`.
  const spec = parseDevicePool(flags);
  // `resolveAll` is REQUIRED, not optional-with-a-throwing-default: `--devices all` has to
  // enumerate the host, which this pure parser must not do, and an optional parameter would
  // make the impossible state representable for the sake of a message nothing can print.
  const devices = spec ? (spec.all ? resolveAll(spec) : spec.serials) : [];
  if (devices.length && serverFromFlags(flags)) {
    // Refused, never silently resolved. `--devices` builds LOCAL lanes and `laneEnv`
    // deletes VERIKUN_SERVER from each child, so taking the devices and dropping the
    // server would run the whole suite against local adb using the farm's serials —
    // which, on the default AVD ports, very plausibly resolves to something and reports
    // GREEN for a build the farm never saw. `vk server` refuses the same shape at exit 2.
    throw new CliError(
      '--devices names LOCAL devices, so it cannot be combined with --server/VERIKUN_SERVER. ' +
        'Use --server alone (a pooled server sizes the suite itself), or --servers <url,url> for several hosts.',
      2,
    );
  }
  const servers = csvList(flags['servers']);
  if (!devices.length && !servers.length) return undefined;
  const lanes: Lane[] = [
    ...devices.map((device) => ({ device, label: device })),
    ...servers.map((server) => ({ server, label: serverLabel(server) })),
  ].map((l, i) => ({ ...l, id: `d${i + 1}` }));
  return lanes;
}

/**
 * Take the parent's hold on every LOCAL lane, and return the lanes it may actually run.
 *
 * A SERVER lane is passed through untouched: its device is held by the child that leases
 * it, under the child's own run token, and the parent has nothing to claim.
 *
 * `elastic` is the whole policy. `--devices all` asked for a SET, so a phone a sibling job
 * is driving is simply not in it — dropped with a note, exactly as `vk server --devices
 * all` drops a device whose worker will not start. A NAMED serial was asked for by name,
 * so it throws exit 2 instead: quietly running without it would hand back less capacity
 * than was requested with nothing saying so.
 *
 * `grants` is an OUT-parameter, appended to as each device is taken rather than returned
 * at the end: the named path throws part-way through, and the caller's `finally` still has
 * to hand back everything granted before the throw — which a return value would lose
 * precisely when it matters. Exported for the unit suite.
 */
export function grantLanes(
  lanes: Lane[],
  platform: Platform,
  elastic: boolean,
  grants: DeviceGrant[],
  o: ClaimGrantOpts = {},
): Lane[] {
  const kept: Lane[] = [];
  for (const lane of lanes) {
    if (!lane.device) {
      kept.push(lane);
      continue;
    }
    const grant = elastic
      ? claimGrant(lane.device, platform, o)
      : requireClaimGrant(lane.device, platform, () => [], o);
    if (!grant) {
      err(`[suite] ${lane.device} is held by another job — running without it`);
      continue;
    }
    grants.push(grant);
    kept.push(lane);
  }
  if (!kept.length) {
    throw new CliError('every device in the pool is held by another job — see `verikun devices`.', 2);
  }
  return kept;
}

/**
 * The last JSON object a child printed on stdout.
 *
 * `vk ai --json` writes exactly one document, and per-step `out()` is suppressed for
 * the duration of the run — but "last object wins" costs nothing and keeps one stray
 * line from turning a finished test into an unparseable one. Returns null when there
 * is nothing to parse, which the caller reports with the child's stderr attached
 * (the child's own diagnosis is far more useful than "bad JSON").
 */
export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  // One forward pass tracking brace depth, skipping over string literals so a `}` inside
  // a value cannot throw the count off. Every TOP-LEVEL balanced object is a candidate and
  // the last one that parses wins — which is what makes stray output on either side
  // harmless. (Anchoring on the final `}` in the stream did not: one line printed after
  // the document containing a brace put `end` past it, every candidate slice failed to
  // parse, and a test that PASSED came back as an unparseable child.)
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) found.push(stdout.slice(start, i + 1));
    }
  }
  for (let i = found.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(found[i]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* not a document — try the one before it */
    }
  }
  return null;
}

/** The most informative line a failed child left behind. */
function lastLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * Turn a finished `vk ai` child into the `AiRunResult` the suite consumes.
 *
 * THE EXIT CODE IS THE VERDICT, not the JSON: `ok` is `code === 0` and nothing else, so
 * a child that somehow printed a stale success document cannot report a pass. The JSON
 * only supplies detail. `state` is left null here and filled from `<runDir>/run.json` by
 * the caller — keeping this function pure enough to unit-test.
 *
 * Exit 3 is verikun's environment code, and 127 means the child never started at all,
 * which is the same class of problem; both mark the result environment-flavoured so the
 * suite probes the lane instead of blaming the app. Exported for the unit suite.
 */
export function laneResult(
  code: number,
  parsed: Record<string, unknown> | null,
  detail: string,
  lane: LaneTarget & { label?: string },
): AiRunResult {
  const str = (k: string): string | undefined => (typeof parsed?.[k] === 'string' ? (parsed[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof parsed?.[k] === 'number' ? (parsed[k] as number) : undefined);
  const yes = (k: string): boolean => parsed?.[k] === true;
  const raw = parsed?.failure;
  // A budget / timeout / environment abort comes back as a bare FLAG with no `failure`
  // object — the engine returns it that way, and `toSuiteResult` composes its own wording
  // ("aborted: cost ceiling reached"). Synthesizing a failure here from the child's last
  // stderr line would win that branch and label the row with an unrelated log line
  // (`[ai] estimated total cost: $0.51`), making all three wordings unreachable on a pool
  // while they stayed correct serially.
  const aborted = yes('abortedForBudget') || yes('abortedForTimeout') || yes('abortedForEnv');
  const failure =
    raw && typeof raw === 'object' && typeof (raw as { reason?: unknown }).reason === 'string'
      ? (raw as { where: string; reason: string })
      : str('error')
        ? { where: 'run', reason: str('error')! }
        : code !== 0 && !aborted
          ? { where: 'run', reason: detail || `the test process exited ${code}` }
          : undefined;
  return {
    ok: code === 0,
    cached: yes('cached'),
    costUsd: num('costUsd') ?? 0,
    costLine: str('cost') ?? '',
    modelRepairs: num('modelRepairs') ?? 0,
    improvements: Array.isArray(parsed?.improvements)
      ? (parsed.improvements as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    runDir: str('runDir') ?? '',
    reportHtml: str('report') ?? '',
    junitXml: str('junit') ?? '',
    state: null,
    // The child is the only one that can know this against a pooled server, where the
    // parent handed out a URL and the lease chose the phone.
    // `||`, not `??`: an empty-string device from the child must fall back to the lane's
    // own serial rather than blanking the column it was added to fill.
    ...(str('device') || lane.device ? { device: str('device') || lane.device } : {}),
    ...(failure ? { failure } : {}),
    ...(yes('abortedForBudget') ? { abortedForBudget: true } : {}),
    ...(yes('abortedForTimeout') ? { abortedForTimeout: true } : {}),
    // `errorKind: 'Error'` means the child threw something that was NOT a CliError — an
    // internal bug, not a broken box. `mapError` flattens those to exit 3, so without this
    // check a TypeError in a new code path reads as an environment failure: the suite
    // probes the lane, finds it healthy, retries, and two in a row retire a perfectly good
    // device via ENV_STREAK_LIMIT.
    ...((yes('abortedForEnv') || code === 3 || code === 127) && str('errorKind') !== 'Error'
      ? { abortedForEnv: true }
      : {}),
    // Exit 2 is verikun's USAGE code — a flag the child rejected, an unreadable test, a
    // payload the server refused. The serial path reaches this verdict from the thrown
    // CliError (`isRetryableThrow`); across a process boundary the throw is only an exit
    // code, so without this a pooled `--retries 3` spends three more devices re-running a
    // failure that provably cannot change.
    ...(code === 2 ? { usageError: true } : {}),
  };
}

/** This verikun's own entry script, so a lane child is the SAME build as its parent —
 *  derived from `__dirname` rather than argv[1], which depends on how we were invoked. */
function vkEntry(): string {
  const beside = join(__dirname, 'bin', 'verikun.js');
  return existsSync(beside) ? beside : process.argv[1];
}

/** Run one test on one lane, as a child process. */
async function runLaneTest(file: string, lane: Lane, flags: Flags, platform: Platform, resetApp?: string): Promise<AiRunResult> {
  const argv = laneArgv(file, lane, flags, { platform, ...(resetApp ? { resetApp } : {}) });
  const { code, stdout, stderr } = await spawnCollect(process.execPath, [vkEntry(), ...argv], {
    env: laneEnv(lane),
    // Prefix, or N tests' progress arrives interleaved and unattributable.
    onStderrLine: (line) => err(`[${lane.label}] ${line}`),
  });
  const result = laneResult(code, lastJsonObject(stdout), lastLine(stderr), lane);
  // The step tally lives in the archived run, not on the wire — reading it back keeps
  // the JSON contract small and `toSuiteResult` identical to the in-process path.
  // Through run.ts's own loader: it owns the run-file layout and the tolerant-read
  // posture, so the parallel suite cannot drift from what every other reader does.
  if (result.runDir) result.state = loadRunState(result.runDir);
  return result;
}

/** How long a lane probe may take before the device counts as not answering. Generous
 *  for a `uiautomator dump` on a cold phone, far short of a lane's own test. */
const PREFLIGHT_TIMEOUT_MS = 45_000;

/**
 * Is this lane's device still drivable?
 *
 * A local lane gets a real hierarchy read on that exact device — spawned, because a
 * `spawnSync` here would stall every other lane in the parent. A SERVER lane only gets
 * a ping: `/v1/elements` would take a lease, and with every lane already holding one
 * that returns 409 and would read as "broken" for a perfectly healthy pool. One dead
 * device behind a live server is covered instead by the suite's consecutive-failure
 * retirement (ENV_STREAK_LIMIT in suite.ts).
 */
async function lanePreflight(lane: Lane, flags: Flags, platform: Platform): Promise<void> {
  if (lane.server) {
    await pingServer(remoteOptsFrom(lane.server, flags));
    return;
  }
  // `--json`, because under it `mapError` writes the failure to STDOUT as a document
  // carrying `errorKind` — the error's CLASS. That is what the classifier below needs:
  // rebuilding a bare CliError out of a stderr line flattens `NoWindowError` into an
  // `unknown` verdict, and device/failover.ts's first rule is "identity first, never
  // message text" precisely because getting this one wrong retires a healthy phone.
  //
  // A short timeout, unlike a lane's test: this is a liveness probe, and a device wedged
  // badly enough not to answer one at all is the very thing it is asking about.
  const { code, stdout, stderr } = await spawnCollect(
    process.execPath,
    [vkEntry(), 'ui', '--json', `--device=${lane.device}`, `--platform=${platform}`],
    // Only the trailing error document is read, and `vk ui --json`'s SUCCESS output is a
    // whole hierarchy — tens of KB per probe, per lane, held for the child's lifetime.
    { env: { ...laneEnv(lane), VERIKUN_NO_RUN: '1' }, timeout: PREFLIGHT_TIMEOUT_MS, stdoutTailBytes: 64 * 1024 },
  );
  if (code === 0) return;
  const body = lastJsonObject(stdout);
  const message = (typeof body?.error === 'string' && body.error) || lastLine(stderr) || `vk ui exited ${code}`;
  const kind = typeof body?.errorKind === 'string' ? (body.errorKind as ErrorDescriptor['kind']) : 'CliError';
  // A hierarchy read is the cheapest DEVICE probe available from the CLI, but it asks a
  // slightly different question than "is this device alive": an app that has not drawn
  // yet answers with NoWindowError and exit 3, and retiring a lane for that would take a
  // healthy phone out of the pool for a state that clears in a second. So classify the
  // failure with the same pure table failover uses rather than trusting the exit code.
  const verdict = classifyFailure(rebuildError({ kind, name: kind, message, exitCode: code }));
  if (verdict.kind === 'transient' || verdict.kind === 'app') return;
  throw new CliError(`device ${lane.label} is not answering (${message})`, 3);
}

// ---------------------------------------------------------------------------
// suite — run a directory of natural-language tests as one gated suite
// ---------------------------------------------------------------------------

interface LanePool {
  lanes: Lane[];
  platform: Platform;
  /**
   * The pool was asked for as a SET ("every usable device"), not as a list of names.
   *
   * That is the difference between "skip the one another job is driving" and "fail,
   * because the operator named that phone" — the same polarity `poolSerials` applies to a
   * missing serial, and what `vk server --devices all` already does (a device whose worker
   * will not start is dropped, not fatal).
   */
  elastic: boolean;
  /** Only when the whole pool is ONE server, since the manifest field describes one. */
  server?: { url: string; verikun: string; reads?: string };
}

/**
 * Resolve the device pool, or `undefined` for today's serial suite.
 *
 * Every lane must share a platform. A pool is a set of INTERCHANGEABLE devices, so a
 * suite dealt half onto Android and half onto iOS would compile two plans per test,
 * double cold-cache spend, and report one `platform` for rows that ran on two. That is a
 * matrix, not a pool, and it is expressed by running the suite once per platform.
 */
async function buildLanePool(flags: Flags, platform: Platform): Promise<LanePool | undefined> {
  // `all-ios` / `all-android` pin the platform, exactly as they do for `vk server` — one
  // resolver, so the two commands cannot disagree about what the flag means.
  const { spec, platform: devicePlatform } = resolvePoolPlatform(flags, platform);
  const elastic = spec?.all === true;
  const lanes = lanesFromFlags(flags, (s) => poolSerials(devicePlatform, s));
  if (!lanes) {
    // A plain `--server` at a POOLED server sizes itself: one URL, one secret, one CI
    // line, and the fleet behind it is the operator's business. Capacity 1 (or an older
    // server, which omits the field) stays exactly today's serial suite.
    const url = serverFromFlags(flags);
    if (!url) return undefined;
    const health = await pingServer(remoteOptsFrom(url, flags));
    const capacity = health.capacity ?? 1;
    if (capacity <= 1) return undefined;
    err(`[verikun] server ${url} pools ${capacity} devices — running the suite across all of them`);
    return {
      lanes: Array.from({ length: capacity }, (_, i) => ({
        id: `d${i + 1}`,
        // The DEVICE is unknown until each lane leases one, so the lane is numbered and
        // every row records the serial the child came back with.
        label: `${serverLabel(url)}#${i + 1}`,
        server: url,
      })),
      platform: health.platform,
      elastic: false,
      server: { url, verikun: health.version, ...(health.reads?.path ? { reads: health.reads.path } : {}) },
    };
  }
  const urls = [...new Set(lanes.map((l) => l.server).filter((u): u is string => !!u))];
  if (!urls.length) return { lanes, platform: devicePlatform, elastic };

  // Ping each server once, up front: it fixes the platform, proves reachability before
  // any model spend, and is where a mixed-platform pool is refused.
  const health = await Promise.all(urls.map(async (url) => ({ url, health: await pingServer(remoteOptsFrom(url, flags)) })));
  const platforms = [...new Set(health.map((h) => h.health.platform))];
  if (platforms.length > 1) {
    throw new CliError(
      `--servers mixes platforms (${health.map((h) => `${serverLabel(h.url)}=${h.health.platform}`).join(', ')}). ` +
        'A pool must be interchangeable devices; run the suite once per platform instead.',
      2,
    );
  }
  if (lanes.some((l) => l.device) && platforms[0] !== platform) {
    throw new CliError(
      `--devices are ${platform} but --servers report ${platforms[0]}; a pool must be one platform.`,
      2,
    );
  }
  for (const { url, health: h } of health) {
    err(`[verikun] server ${url}: ${h.platform} · ${h.capacity ?? 1} device(s) · verikun ${h.version}`);
  }
  // A POOLED server contributes as many lanes as it has devices. Without this, naming a
  // second pooled host with `--servers a,b` gave 2 lanes across 6 phones — fewer than
  // `--server a` alone, which is the opposite of what adding a host should do.
  const expanded = lanes.flatMap((l) => {
    if (!l.server) return [l];
    const capacity = health.find((h) => h.url === l.server)?.health.capacity ?? 1;
    return Array.from({ length: Math.max(1, capacity) }, (_, i) => ({
      ...l,
      label: capacity > 1 ? `${l.label}#${i + 1}` : l.label,
    }));
  }).map((l, i) => ({ ...l, id: `d${i + 1}` }));
  const only = urls.length === 1 && lanes.every((l) => l.server === urls[0]) ? health[0] : undefined;
  return {
    lanes: expanded,
    platform: platforms[0],
    elastic,
    ...(only ? { server: { url: only.url, verikun: only.health.version, reads: only.health.reads?.path } } : {}),
  };
}

/**
 * The parallel suite: one child `vk ai` per test, spread across the pool.
 *
 * Builds NO local driver — every device touch happens in a child, which is the whole
 * point (see the lane header above). What the parent still owns is the device CLAIMS:
 * `isMine` matches on session or cwd (claims.ts:211), so children would see each other's
 * claims as their own and coordinate nothing, and each child's exit would hand its
 * device back mid-suite. Holding them here for the suite's lifetime is both correct and
 * simpler, and is why the children run with VERIKUN_NO_CLAIM.
 */
async function cmdSuiteParallel(dirArg: string, flags: Flags, pool: LanePool): Promise<number> {
  const { platform } = pool;
  if (ensureDeviceTarget(flags) !== null) {
    // Refused on EVERY pool path, not just `--devices`. The parallel suite builds no
    // backend of its own, so nothing would consume the flag: `resolveBackend` — the only
    // place `ensureLocalDevice`/`ensureRemoteDevice` are called — is never reached, and
    // `SUITE_ONLY_FLAGS` strips it from the children. Accepting it would boot nothing
    // while reading as though it had. (Its bare form is also unsafe here: "the one
    // startable device" may well be another lane's emulator.)
    throw new CliError(
      '--ensure-device cannot be combined with a device pool — nothing would consume it. ' +
        'Start the devices first with `vk devices start <name>`, or drop the pool flags to run serially.',
      2,
    );
  }
  const app = flagStr(flags, 'app');
  if (app) assertSafeAppId(app);
  // One device across every lane (a one-device pool, or `--concurrency 1`) is still a
  // fact about the whole suite, so record it the way the serial path does — otherwise a
  // pooled run of one phone reports LESS than the plain command it replaced.
  const lanes = pool.lanes;
  const sole = lanes.length && lanes.every((l) => l.device && l.device === lanes[0].device) ? lanes[0].device : undefined;
  /**
   * The PARENT's hold on every local lane's device, for the suite's lifetime.
   *
   * One `DeviceGrant` per lane rather than a serial list plus a timer beside it: the
   * grant owns acquire / heartbeat / release together, so this is now the only place that
   * decides WHICH devices are held and none of the places that decide HOW. That matters
   * because the heartbeat is not optional here — `touchClaim` normally rides along on
   * `executeOutcome`, which this parent never runs (every device call happens in a child,
   * and the children run with VERIKUN_NO_CLAIM=1), so without one each claim keeps its
   * start-of-suite timestamp: `vk devices` reports the whole pool as stale, and a suite
   * outlasting `PID_TRUST_MAX_MS` has its claims read as DEAD by a concurrent job, which
   * then takes the phones out from under the running lanes — the exact collision claims
   * exist to prevent.
   */
  const grants: DeviceGrant[] = [];
  try {
    return await cmdSuite(dirArg, flags, {
      platform,
      ...(sole ? { device: sole } : {}),
      lanes,
      ...(pool.server ? { server: pool.server } : {}),
      // Claiming happens HERE, on the lanes the suite actually kept: taking every lane in
      // the pool up front would hold phones that `--concurrency` throttles away, refusing
      // them to every other job on the host while nothing ran on them. VERIKUN_NO_CLAIM=1
      // must restore the pre-claims behaviour EXACTLY (it is what makes the mechanism
      // debuggable by bisection) — the grant constructors own that gate, so it cannot be
      // honoured here and forgotten at the next acquisition site.
      claimLanes: (used) => grantLanes(used, platform, pool.elastic, grants),
      runTest: (file, lane) => runLaneTest(file, lane, flags, platform, app),
      preflight: (lane) => lanePreflight(lane, flags, platform),
      // `reset` is deliberately NOT wired: against a pooled server a reset issued from
      // here would take its own lease and could land on a different device than the test
      // that follows. `vk ai --reset-app` does it inside the test's own lease instead.
    });
  } finally {
    // The grants ARE this parent's claims: it builds no driver of its own (`poolSerials`
    // only lists), so nothing else here can have taken one. The children run with
    // VERIKUN_NO_CLAIM=1 and have none. A prepped device needs nothing further — prep
    // leaves it a short display timeout, so it sleeps by itself once the lanes stop.
    await releaseGrants(grants);
  }
}

async function cmdSuiteEntry(positionals: string[], flags: Flags): Promise<number> {
  const dirArg = positionals[0];
  if (!dirArg) {
    throw new CliError(
      'Usage: verikun suite <dir> [--app <id>] [--server url] [--devices a,b] [--servers u1,u2] ' +
        '[--concurrency n] [--name n] [--retries n] [--json]',
      2,
    );
  }
  const opts = parseAiOptions(flags);
  setProcessScoped(true); // one process for the whole suite — see claims.ts's isLive
  // Pre-flight the provider BEFORE touching any device/server: every test needs it
  // to compile (on a cache miss) or to repair at runtime.
  if (!providerAvailable(opts.model)) {
    throw new CliError(`${providerRequirement(opts.model)} — needed to compile/repair tests (model ${opts.model}).`, 3);
  }
  const reqPlatform = platformFromFlags(flags);

  const pool = await buildLanePool(flags, reqPlatform);
  if (pool) return cmdSuiteParallel(dirArg, flags, pool);

  const { backend, platform, device, grant, remote, moves } = await resolveBackend(reqPlatform, deviceFromFlags(flags, reqPlatform), flags);
  const app = flagStr(flags, 'app');
  if (app) assertSafeAppId(app);
  try {
    return await cmdSuite(dirArg, flags, {
      platform,
      // A thunk: the server may fail over mid-suite, and the manifest should name where
      // the suite ENDED, exactly as `vk ai --json` does for a single test.
      device: () => (moves.length ? moves[moves.length - 1].to : device),
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
    await grant.release();
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
    // `errorKind` carries the error's CLASS across the process boundary, the same job
    // rpc.ts's codec does across the HTTP one. A child's stderr is prose, and rebuilding
    // a bare CliError from it flattens `NoWindowError` into an unknown — which is exactly
    // how a healthy phone mid-launch gets retired from a lane pool (see lanePreflight).
    if (flagBool(flags, 'json')) json({ error: e.message, exitCode: e.exitCode, errorKind: describeError(e).kind });
    else err(e.message);
    return e.exitCode;
  }
  // `--json` everywhere, including errors — an UNEXPECTED throw most of all. A caller that
  // set --json once and parses stdout would otherwise get a document for every failure
  // except the one it least expects. This is also the only way `errorKind: 'Error'` is
  // produced: every other kind subclasses CliError and is answered above.
  if (flagBool(flags, 'json')) json({ error: (e as Error).message, exitCode: 3, errorKind: describeError(e as Error).kind });
  else err('Unexpected error: ' + (e as Error).message);
  if (process.env.VERIKUN_DEBUG) err((e as Error).stack ?? '');
  return 3;
}

/** The driver's serial, or undefined when it cannot be resolved — the command handler is
 *  what surfaces that failure with the real message; callers here only need the serial
 *  to stamp the device claim and the recorded step. */
function tryResolvedSerial(driver: Driver): string | undefined {
  try {
    return driver.resolvedSerial();
  } catch {
    return undefined;
  }
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
      // detect a device change.
      const serial = tryResolvedSerial(driver);
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
  const serial = tryResolvedSerial(driver);
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
  device prep [--dry-run] [--json]    Prepare a TEST device once, stickily: animations off,
                                      display timeout ${PREP_SCREEN_TIMEOUT}, Do Not Disturb on,
                                      battery idle off. Survives the run (unlike \`device set\`),
                                      so it is undone only by \`--revert\`. A PHYSICAL device must
                                      be named with --device — prep must never land on a personal
                                      phone. --no-sleep-when-idle keeps the display on for good.
  device prep --revert [--dry-run]    Put a prepared device back the way it was found
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
            [--package pkg] [--app-build id] [--reset-app id] [--show-plan]
            [--recompile] [--json]
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
                                      --reset-app <id> clears (iOS: force-stops) that
                                      app before the first step, on this run's own
                                      device — which is what \`vk suite\` uses across a
                                      pool, where a reset from outside the run could
                                      land on a different device than the test.
                                      Models: claude-haiku-4-5 | claude-sonnet-4-6
                                      (default) | claude-opus-4-8 | claude-fable-5 |
                                      gpt-5.4-mini | gpt-5.4 | gpt-5.5 | gpt-4.1 |
                                      codex-cli | cursor-cli.

SUITE (run a directory of natural-language tests as one gated suite)
  suite <dir> [--app <id>] [--name n] [--retries n] [--json]
              [--devices a,b] [--servers u1,u2] [--concurrency n]
              [--max-suite-cost-usd n]
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
                                      PARALLEL: --devices/--servers spread the tests
                                      across a pool, next-free-device-takes-the-next-
                                      test, and file order no longer sequences them.
                                      A \`vk server --devices\` pool is used
                                      automatically by a plain --server. --concurrency
                                      caps how many run at once; --max-suite-cost-usd
                                      stops the suite once total model spend crosses
                                      it (exit 1). One merged report either way, with
                                      wall-clock reported apart from device time.

SERVER (expose a locally-connected device to remote verikun clients)
  server [--bind addr] [--port n] [--auth-key k] [--devices all|all-android|all-ios|a,b]
         [--allow-install]
         [--allow-device-control[=names]] [--allow-failover[=serials]|--no-failover]
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
  Failover is ON by default: if the bound device cannot serve a request, the server
  moves to another attached, healthy, unclaimed one and rules the bad one out until it
  is power-cycled. An install is retried there; a mid-run step is NOT — it fails on the
  device it ran on, and the next request lands on the healthy one. Passing --device
  pins the binding and turns this off; --allow-failover[=serials] turns it back on (and
  bounds where it may go), --no-failover / VERIKUN_NO_FAILOVER disables it outright.

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
