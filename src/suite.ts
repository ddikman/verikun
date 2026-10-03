// `vk suite <dir>` — run a directory of natural-language tests as one suite: reset the
// app between tests, collect each test's result, and write a suite overview (index.json
// manifest + index.html) that links every test's archived report. Exits 1 when any test
// failed, so the command doubles as the CI gate.
//
// Dependency-injected like agent/engine.ts: this module imports NOTHING from cli.ts
// — the actual test execution (`runTest`, which is cli.ts's runAiTest bound to a
// local-or-remote backend) and the between-test reset come in via SuiteDeps. That
// keeps the enumeration/tally/manifest logic pure enough to unit-test without a
// device, and cli.ts free of a suite→cli import cycle.
//
// LANES. Given a pool of devices (`deps.lanes`), the suite stops being a `for` loop and
// becomes a work queue: every lane takes the next file the moment it frees, so the split
// is dynamic rather than a partition someone maintains. That matters because real suites
// have a wide duration spread — 103s to 798s in the case that prompted this — and any
// static split forfeits a chunk of what the extra devices bought. Wall-clock then falls
// to roughly the longest single test, and `SuiteTotals.durationMs` stops being elapsed
// time and becomes device time (see `wallClockMs`).
//
// The lane itself is executed by cli.ts as a child PROCESS, because exec.ts is spawnSync
// throughout: tests awaited inside one process would not overlap device I/O at all.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { Flags, flagStr, flagBool, flagNum } from './args';
import { errorOutcome, Outcome, CliError, isEnvError } from './errors';
import { artifactDir, err, json, out } from './output';
import { runId, uniqueDir, RunState } from './run';
import { SuiteRun, SuiteTestResult, SuiteAttempt, suiteTotals, toSuiteIndexJson, toSuiteHtml } from './report';
import { sleep } from './wait';
import { VERSION } from './version';

/** What one `vk ai` test run returns to its caller — produced by cli.ts's runAiTest,
 *  consumed here. Defined on the consumer side (like EngineDeps) so suite.ts never
 *  imports cli.ts. */
export interface AiRunResult {
  outcome: Outcome;
  ok: boolean;
  /** True when the plan came from the cache (a replay); false when freshly compiled. A
   *  heal (modelRepairs > 0) on a cached replay is the "recurring friction" signal — the
   *  deterministic $0 replay still had to wake the model, so the compiled selector is unstable. */
  cached: boolean;
  /** Model spend for this test (compile + repairs), rounded to 4 decimals. */
  costUsd: number;
  costLine: string;
  modelRepairs: number;
  improvements: string[];
  /** Top-level steps in the plan that ran — the compile's size, as opposed to how much of
   *  it executed. Undefined when no plan was obtained (a compile that threw). */
  planSteps?: number;
  /** Archived run directory ('' when the run never started, e.g. budget hit at compile). */
  runDir: string;
  reportHtml: string;
  junitXml: string;
  state: RunState | null;
  failure?: { where: string; reason: string };
  abortedForBudget?: boolean;
  abortedForTimeout?: boolean;
  /** The test stopped because the ENVIRONMENT broke (exit 3), not because the app did. */
  abortedForEnv?: boolean;
  /** The test never STARTED: the `vk server` refused it a device (every one leased, or none
   *  serving). Not an attempt — the suite hands the file back to its queue and waits. */
  noDevice?: boolean;
  /** The server ended this run part-way because its device left (or was taken over). Also
   *  `abortedForEnv`; the suite re-runs it as a fresh run without spending a retry. */
  evicted?: boolean;
  /** The device that actually ran the test. Against a pooled `vk server` the caller
   *  asked for a URL, so only the lease ever knew this. */
  device?: string;
  /** The test could not even start — a flag the child rejected, an unreadable file, a
   *  payload the server refused. The one failure a rerun provably cannot change, so
   *  `--retries` must not spend three more devices on it. The serial path reaches the
   *  same verdict from a thrown exit-2 `CliError` (`isRetryableThrow`); a lane child
   *  turns that throw into an exit CODE, which is why the flag has to travel. */
  usageError?: boolean;
}

/**
 * One device's slot in the pool: an id, something to call it, and how to reach it.
 *
 * `id` is deliberately short and filesystem-safe — it becomes the child's `VERIKUN_LANE`
 * (which names its active run directory) and the suffix on every run id it mints.
 */
export interface Lane {
  avoid?: string;
  installedSha?: string;
  id: string;
  label: string;
  device?: string;
  server?: string;
}

/** The implicit single lane, so serial and parallel share one code path. */
const SERIAL_LANE: Lane = { id: '', label: '' };

export interface SuiteDeps {
  platform: string;
  /**
   * The device the suite ran on, or a thunk when it can CHANGE mid-suite.
   *
   * A `--server` suite whose server fails over lands on a different phone partway
   * through, and a field captured before the first test would name the one it left —
   * wrong in exactly the case a reader consults it. Read once, when the manifest is
   * written.
   */
  device?: string | (() => string | undefined);
  /** Set when the run went through a remote `vk server`, so the index records which verikun
   *  actually drove the device and how it read the screen — not just the client's version. */
  server?: { url: string; verikun: string; reads?: string; installedSha?: string };
  /**
   * The device pool. ABSENT is today's serial suite, running one in-process backend —
   * and it must stay exactly that, because file order is a documented contract there
   * (authors sequence flows with `01-`/`02-` prefixes) while a pool cannot honour it.
   */
  lanes?: Lane[];
  /**
   * Take whatever host-wide resources the lanes ACTUALLY used need — device claims, in
   * cli.ts's case. Called once with the post-`--concurrency` set, which is why it is a
   * callback and not something the caller does before handing the pool over: claiming
   * `pool.lanes` up front holds phones that `laneCount` then throttles away, refusing
   * them to every other job on the host for the whole suite.
   */
  claimLanes?: (lanes: Lane[]) => Lane[];
  // `lane` is REQUIRED on all three, never optional: `cmdSuite` always passes one (the
  // implicit `SERIAL_LANE` when there is no pool), so an optional parameter would only
  // buy the parallel wiring a `lane!` assertion — the escape hatch that turns a future
  // genuinely-missing lane into a runtime crash instead of a compile error. A serial
  // implementation that does not care simply declares fewer parameters.
  /** Run one NL test through the backend for this lane; returns data, writes no stdout. */
  runTest(file: string, lane: Lane): Promise<AiRunResult>;
  /** Reset the app-under-test between tests (wired when --app was given). Unwired for a
   *  pool, where the reset has to happen INSIDE the test's own lease — see cli.ts. */
  reset?: (lane: Lane) => Promise<void> | void;
  /** Re-probe the device toolchain. Called ONLY after an environment-flavoured failure,
   *  to decide whether it was a transient hiccup or a genuinely broken box. Throws
   *  (CliError exit 3) when still broken. Optional: unwired means "never abort". */
  preflight?: (lane: Lane) => Promise<void> | void;
  /** Gap between the two health probes; defaults to PROBE_RETRY_MS. Exists so the unit
   *  suite can set 0 instead of sleeping a real second per abort case. */
  probeRetryMs?: number;
  benchProbeMs?: number;
  /** How long the suite waits when NO lane can get a device before it stops (exit 3).
   *  Defaults to `deviceWaitMs()`; a seam so the unit suite need not wait ten minutes. */
  deviceWaitMs?: number;
}

/** Default for `VERIKUN_SUITE_DEVICE_WAIT_MIN`. Long enough for the server to take over a
 *  crashed client's idle lease (5 min) and for its sweep's first few readmission attempts. */
const DEFAULT_DEVICE_WAIT_MIN = 10;

/**
 * How long a suite waits when NO lane can get a device — every phone left the pool, or other
 * runs hold them all — before it stops with exit 3 and the unrun tests in `notRun`. `0` stops
 * at once. A lane that waits while another lane is still working is never bounded by this:
 * the queue drains through the working lane. Mirrors `claimTtlMs`, except that an empty
 * value means "unset" rather than zero. Exported for the unit suite.
 */
export function deviceWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VERIKUN_SUITE_DEVICE_WAIT_MIN?.trim();
  const n = raw ? Number(raw) : NaN;
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEVICE_WAIT_MIN) * 60_000;
}

/** Gap between the two health probes below. Long enough to outlast a USB
 *  re-enumeration or a simulator relaunch, short enough not to pad a real abort. */
const PROBE_RETRY_MS = 1000;

/** How often an idle lane re-checks the queue while another lane is still working.
 *  Only reached on the tail of a suite, and only when a requeue is still possible. */
const IDLE_POLL_MS = 25;

/** How many times ONE test may be re-run, without spending a retry, because the server
 *  evicted it. Enough for two independent blips; a phone that keeps vanishing under the same
 *  test is a problem worth a red row, so the next eviction counts as an ordinary attempt. */
const MAX_FREE_RERUNS = 2;


/**
 * An environment-flavoured failure is only FATAL if the toolchain is STILL broken when
 * we re-probe. This distinction is load-bearing: a transient uiautomator dump failure
 * also surfaces as exit 3 (matchWaiting/resolveOneWaiting don't catch a thrown
 * getElements), so aborting on the exit code alone would let one flaky dump vaporize a
 * 20-test suite. Returns the reason when broken, undefined when it was transient.
 */
async function stillBroken(deps: SuiteDeps, lane: Lane): Promise<string | undefined> {
  if (!deps.preflight) return undefined; // not wired -> preserve continue-on-failure
  // Two attempts a second apart, because the probe is the ONLY thing separating a
  // momentary blip from a dead box, and killing a 20-test suite is the expensive
  // mistake. A USB re-enumeration or a simulator mid-relaunch can fail one probe and
  // pass the next; a genuinely missing tool fails both in a few milliseconds.
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(deps.probeRetryMs ?? PROBE_RETRY_MS);
    try {
      await deps.preflight(lane);
      return undefined;
    } catch (e) {
      last = (e as Error).message.split('\n')[0];
    }
  }
  return last;
}

/** Lexicographic order, so authors sequence flows with 01-…, 02-… prefixes. */
export function sortTestFiles(files: string[]): string[] {
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Queue order for a POOL: longest test first, unknown durations before everything.
 *
 * Longest-first is the classic makespan heuristic, and it is worth the twenty lines
 * because the dynamic queue alone still leaves the last-dequeued test defining the
 * finish: start the 13-minute one last and every other device idles behind it.
 *
 * Unknown durations go FIRST, not last, because an unknown might BE the long one and
 * starting it early is the only bound available. It also means a first run — where
 * every duration is unknown — degenerates exactly to file order, i.e. to the previous
 * behaviour, rather than to something arbitrary.
 *
 * Never applied to a serial suite: file order is a contract there.
 */
export function orderTests(files: string[], hints: Record<string, number>): string[] {
  const known = (f: string): boolean => typeof hints[f] === 'number' && hints[f] > 0;
  const longestFirst = files.filter(known).sort((a, b) => hints[b] - hints[a] || (a < b ? -1 : a > b ? 1 : 0));
  return [...files.filter((f) => !known(f)), ...longestFirst];
}

/** Suite directories inspected for duration hints before giving up. */
const HINT_SCAN_LIMIT = 20;

/**
 * Per-file durations from the most recent previous run of this same suite, for
 * `orderTests`. Best-effort in every direction — no prior runs, an unreadable manifest,
 * a renamed suite all mean "no hints", which costs ordering quality and nothing else.
 *
 * Reads the archived manifests rather than keeping a separate hint file, so there is no
 * new artifact to explain, invalidate or clean up. In CI it works whenever `.verikun/
 * suites` is cached the way `.verikun/plans` already is. Exported for tests.
 */
export function readDurationHints(suitesDir: string, name: string): Record<string, number> {
  const hints: Record<string, number> = {};
  let dirs: string[];
  try {
    dirs = readdirSync(suitesDir);
  } catch {
    return hints; // no suite has ever run here
  }
  // Suite ids are timestamps, so reverse-lexicographic is newest-first.
  dirs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const dir of dirs.slice(0, HINT_SCAN_LIMIT)) {
    try {
      const suite = JSON.parse(readFileSync(join(suitesDir, dir, 'index.json'), 'utf8')) as SuiteRun;
      if (suite?.name !== name || !Array.isArray(suite.tests)) continue;
      for (const t of suite.tests) {
        if (typeof t?.file === 'string' && typeof t.durationMs === 'number' && t.durationMs > 0) {
          hints[t.file] = t.durationMs;
        }
      }
      return hints; // the most recent matching run wins; older ones are staler, not additive
    } catch {
      /* not a suite directory, or a manifest we cannot read — try the next */
    }
  }
  return hints;
}

/** The *.md files in a suite dir (non-recursive). Two kinds of `.md` are NOT tests and
 *  are skipped by convention: `README.md` (documentation for the suite) and any
 *  `_`-prefixed file, which is a shared FRAGMENT other tests `@include` (see
 *  agent/include.ts). A fragment run as a test would get its own report row and, under
 *  `--app`, its own app-data reset — leaving no state for the test that included it. */
export function listTestFiles(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => {
    if (!f.toLowerCase().endsWith('.md') || f.toLowerCase() === 'readme.md' || f.startsWith('_')) return false;
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
  return sortTestFiles(files);
}

/** Fold one test's AiRunResult into the manifest row (pure; unit-tested). */
export function toSuiteResult(file: string, r: AiRunResult, durationMs: number): SuiteTestResult {
  const steps = r.state?.steps ?? [];
  const passedSteps = steps.filter((s) => s.status === 'passed').length;
  const failure = r.abortedForEnv
    ? `aborted: environment — ${r.failure?.reason ?? 'device unavailable'}`
    : r.failure
      ? `FAIL at ${r.failure.where}: ${r.failure.reason}`
      : r.abortedForBudget
        ? 'aborted: cost ceiling reached'
        : r.abortedForTimeout
          ? 'aborted: run timeout reached'
          : undefined;
  return {
    id: r.runDir ? basename(r.runDir) : '',
    file,
    name: basename(file, extname(file)),
    ok: r.ok,
    ...(r.device ? { device: r.device } : {}),
    durationMs,
    costUsd: r.costUsd,
    steps: steps.length,
    passedSteps,
    failedSteps: steps.length - passedSteps,
    ...(r.planSteps === undefined ? {} : { planSteps: r.planSteps }),
    modelRepairs: r.modelRepairs,
    ...(r.ok ? {} : { failure: failure ?? 'failed' }),
    ...(r.evicted ? { evicted: true } : {}),
  };
}

/** Compact one attempt for the `attempts` evidence array (pure). */
export function toSuiteAttempt(r: SuiteTestResult): SuiteAttempt {
  return {
    id: r.id,
    ok: r.ok,
    durationMs: r.durationMs,
    costUsd: r.costUsd,
    ...(r.failure ? { failure: r.failure } : {}),
    ...(r.evicted ? { evicted: true } : {}),
  };
}

/**
 * Merge a sequence of attempt rows into the final suite row: primary `id` is the last
 * attempt (winning green, or last red), cost/duration/repairs sum across attempts, and
 * prior attempts are retained as flake evidence.
 */
export function mergeSuiteAttempts(attempts: SuiteTestResult[]): SuiteTestResult {
  if (attempts.length === 0) throw new Error('mergeSuiteAttempts: empty');
  const last = attempts[attempts.length - 1];
  if (attempts.length === 1) return last;
  const round = (n: number) => Number(n.toFixed(4));
  const prior = attempts.slice(0, -1).map(toSuiteAttempt);
  // An eviction is not a flake: the phone left, the test did not fail. Counting it would send
  // someone to stabilise a test whose only fault was being mid-run when a cable came loose.
  const flaky = last.ok && prior.some((a) => !a.ok && !a.evicted);
  return {
    ...last,
    durationMs: attempts.reduce((a, t) => a + t.durationMs, 0),
    costUsd: round(attempts.reduce((a, t) => a + t.costUsd, 0)),
    modelRepairs: attempts.reduce((a, t) => a + t.modelRepairs, 0),
    attempts: prior,
    ...(flaky ? { flaky: true } : {}),
  };
}

function parseRetries(flags: Flags): number {
  const n = flagNum(flags, 'retries');
  if (n === undefined) return 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`--retries must be a non-negative integer, got '${n}'`, 2);
  }
  return n;
}

/** `--max-suite-cost-usd` — an aggregate ceiling across every test. Off by default:
 *  `--max-cost-usd` already caps each test, so the total was always bounded; what a
 *  pool changes is the RATE, and this is the brake for it. */
function parseMaxSuiteCost(flags: Flags): number | undefined {
  const n = flagNum(flags, 'max-suite-cost-usd');
  if (n === undefined) return undefined;
  if (!(n > 0)) throw new CliError(`--max-suite-cost-usd must be greater than 0, got '${n}'`, 2);
  return n;
}

/**
 * How many of the available lanes to actually use.
 *
 * More devices is not monotonically better: the host that reported this feature also
 * measured itself thrashing at load ~11 with a SINGLE emulator, and that thrash is what
 * produced the splash-render timeouts of issue #36. So the pool is a ceiling and this is
 * the throttle — three devices need not mean three emulators on one box.
 */
export function laneCount(available: number, tests: number, flags: Flags): number {
  // `--concurrency` with no value parses to boolean true (args.ts), and `flagNum` would
  // read that as "unset" — silently opening a lane per device on a box the operator just
  // asked to cap, which is the load thrash this flag exists to prevent. Same refusal
  // `--devices` / `--servers` make for the same shape.
  if (flags['concurrency'] === true) {
    throw new CliError('--concurrency needs a value, e.g. --concurrency=2', 2);
  }
  const n = flagNum(flags, 'concurrency');
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    throw new CliError(`--concurrency must be a positive integer, got '${n}'`, 2);
  }
  // Never open a lane with nothing to run — it only adds a device to the report.
  return Math.max(1, Math.min(available, tests, n ?? available));
}

/** Consecutive local environment failures bench a device even when its probe passes.
 *  Remote device health belongs entirely to the server. */
const ENV_STREAK_LIMIT = 2;

export function outcomeAction(outcome: Outcome): 'done' | 'retry' | 'rerun' | 'wait' | 'stop' {
  switch (outcome) {
    case 'pass': return 'done';
    case 'lost-device': return 'rerun';
    case 'no-device': case 'server-unreachable': return 'wait';
    case 'budget': case 'usage': return 'stop';
    default: return 'retry';
  }
}

export async function cmdSuite(dirArg: string, flags: Flags, deps: SuiteDeps): Promise<number> {
  const dir = resolve(process.cwd(), dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CliError(`suite: '${dirArg}' is not a directory`, 2);
  }
  const files = listTestFiles(dir);
  if (files.length === 0) {
    throw new CliError(`suite: no test files (*.md) in '${dirArg}' (README.md and _-prefixed fragments are not tests)`, 2);
  }

  const retries = parseRetries(flags);
  const maxSuiteCost = parseMaxSuiteCost(flags);
  const suiteId = runId();
  const name = flagStr(flags, 'name') || basename(dir);
  const startedAt = new Date().toISOString();

  const pool = deps.lanes?.length ? deps.lanes : [SERIAL_LANE];
  // AFTER the throttle, not before: claiming a lane `--concurrency` (or a one-test
  // directory) then discards would hold that phone against every other job on the host
  // for the whole suite while nothing ever ran on it. The callback may also RETURN FEWER
  // lanes — a `--devices all` pool drops a device another job is already driving rather
  // than failing the whole run.
  const throttled = pool.slice(0, laneCount(pool.length, files.length, flags));
  const lanes = deps.claimLanes?.(throttled) ?? throttled;
  const parallel = lanes.length > 1;
  const where = deps.lanes?.length
    ? `${lanes.length} of ${pool.length} device(s): ${lanes.map((l) => l.label).join(', ')}`
    : `${deps.platform}${deps.device ? ` · ${deps.device}` : ''}`;
  err(
    `[suite] '${name}': ${files.length} test(s) from ${dirArg} (${where})${
      retries > 0 ? ` · up to ${retries} retry(ies) on failure` : ''
    }${maxSuiteCost !== undefined ? ` · suite budget $${maxSuiteCost}` : ''}`,
  );

  const ordered = parallel ? orderTests(files, readDurationHints(join(artifactDir(), 'suites'), name)) : [...files];
  interface QueueItem { file: string; rows: SuiteTestResult[]; attempt: number; freeReruns: number; avoid?: string }
  const work: QueueItem[] = ordered.map(file => ({ file, rows: [], attempt: 0, freeReruns: 0 }));
  const results: SuiteTestResult[] = [];
  const warnings: string[] = [];
  let stop: { reason: string; kind: 'environment' | 'budget' } | undefined;
  let spentUsd = 0;
  let busyLanes = 0;
  let lastProgressAt = Date.now();
  const waitMs = deps.deviceWaitMs ?? deviceWaitMs();
  const tag = (lane: Lane): string => parallel && lane.label ? `[suite ${lane.label}]` : '[suite]';
  const warn = (lane: Lane, message: string): void => { warnings.push(message); err(`${tag(lane)} WARN ${message}`); };
  const boundedWait = (): boolean => busyLanes === 0 && Date.now() - lastProgressAt >= waitMs;
  const finish = (item: QueueItem): void => {
    const row = mergeSuiteAttempts(item.rows);
    results.push(row);
    if (row.flaky) warn(SERIAL_LANE, `${item.file} passed on retry after ${item.rows.length - 1} failed attempt(s)`);
    if (maxSuiteCost !== undefined && spentUsd >= maxSuiteCost && work.length)
      stop ??= { reason: `suite cost ceiling $${maxSuiteCost} reached (spent $${spentUsd.toFixed(4)})`, kind: 'budget' };
  };
  async function laneWorker(lane: Lane): Promise<void> {
    let envStreak = 0;
    let benched = false;
    let nextProbe = 0;
    for (;;) {
      if (stop) return;
      if (!work.length) {
        if (!busyLanes) return;
        await sleep(IDLE_POLL_MS); continue;
      }
      if (benched) {
        if (Date.now() >= nextProbe) {
          const broken = await stillBroken(deps, lane);
          if (!broken) { benched = false; warn(lane, 'device recovered — rejoining the suite'); }
          else nextProbe = Date.now() + (deps.benchProbeMs ?? 45_000);
        }
        if (benched) {
          if (boundedWait()) { stop = { reason: 'no usable device returned within the device wait window', kind: 'environment' }; return; }
          await sleep(Math.min(1000, Math.max(1, waitMs))); continue;
        }
      }
      const index = work.findIndex(item => !lane.device || item.avoid !== lane.device);
      if (index < 0) {
        if (boundedWait()) { stop = { reason: 'no other device became available for a fresh rerun', kind: 'environment' }; return; }
        await sleep(IDLE_POLL_MS); continue;
      }
      const item = work.splice(index, 1)[0];
      lane.avoid = item.avoid;
      busyLanes++;
      let r: AiRunResult;
      const start = Date.now();
      try {
        if (deps.reset) {
          try { await deps.reset(lane); err(`${tag(lane)} app state reset`); }
          catch (e) {
            const broken = isEnvError(e) ? await stillBroken(deps, lane) : undefined;
            if (broken) {
              work.unshift(item);
              if (!deps.lanes) { stop = { reason: `reset failed: ${broken}`, kind: 'environment' }; return; }
              benched = true; nextProbe = Date.now() + (deps.benchProbeMs ?? 45_000);
              warn(lane, `device ${lane.label} benched: ${broken}`); continue;
            }
            err(`${tag(lane)} reset failed (${(e as Error).message}) — continuing`);
          }
        }
        if (item.attempt > 0) err(`${tag(lane)} retry ${item.attempt}/${retries} for ${item.file}`);
        r = await deps.runTest(join(dir, item.file), lane);
      } catch (e) {
        r = { ok: false, outcome: errorOutcome(e), cached: false, costUsd: 0, costLine: '', modelRepairs: 0,
          improvements: [], runDir: '', reportHtml: '', junitXml: '', state: null,
          failure: { where: 'run', reason: e instanceof Error ? e.message : String(e) },
          abortedForEnv: isEnvError(e), usageError: e instanceof CliError && e.exitCode === 2,
          device: lane.device };
      } finally { busyLanes--; }
      const action = outcomeAction(r.outcome);
      if (action === 'wait') {
        work.unshift(item);
        if (boundedWait()) { stop = { reason: r.failure?.reason ?? 'no device became available within the device wait window', kind: 'environment' }; return; }
        // Reachable servers own admission waiting. Yield before another hold; only
        // a transport outage needs a client-side reconnection backoff.
        await sleep(r.outcome === 'server-unreachable' ? Math.max(1, deps.probeRetryMs ?? 500) : 0);
        continue;
      }
      if (!item.rows.length) err(`${tag(lane)} ── (${Math.min(results.length + busyLanes + 1, files.length)}/${files.length}) ${item.file} ──`);
      lastProgressAt = Date.now();
      const row = toSuiteResult(item.file, r, Date.now() - start);
      if (action === 'rerun' && (lane.server || (parallel && !!lane.device)) && item.freeReruns < MAX_FREE_RERUNS) {
        row.evicted = true;
        item.rows.push(row); item.freeReruns++; item.avoid = r.device ?? lane.device;
        spentUsd += row.costUsd;
        warn(lane, `${item.file}: its device ${item.avoid ?? '(unknown)'} left the pool mid-run — re-run as a fresh run (${item.freeReruns}/${MAX_FREE_RERUNS}, not counted toward --retries)`);
        work.unshift(item);
        if (lane.device) { benched = true; nextProbe = Date.now() + (deps.benchProbeMs ?? 45_000); }
        continue;
      }
      // Loss beyond the allowance consumes a normal retry and may be flaky.
      if (action === 'rerun') delete row.evicted;
      item.rows.push(row); spentUsd += row.costUsd;
      if (!r.ok && action !== 'stop' && item.attempt < retries) {
        item.attempt++;
        if (r.abortedForEnv) warn(lane, `${item.file}: environment error on attempt ${item.attempt} — retried`);
        work.unshift(item); continue;
      }
      finish(item);
      if (lane.server) { envStreak = 0; continue; }
      const broken = r.abortedForEnv ? await stillBroken(deps, lane) : undefined;
      envStreak = r.abortedForEnv ? envStreak + 1 : 0;
      if (broken || (parallel && envStreak >= ENV_STREAK_LIMIT)) {
        if (!deps.lanes) { stop = { reason: broken ?? 'environment remains broken', kind: 'environment' }; return; }
        if (lane.device) {
          benched = true; nextProbe = Date.now() + (deps.benchProbeMs ?? 45_000);
          warn(lane, `device ${lane.label} benched: ${broken ?? 'repeated environment failures'}`);
        } else {
          warn(lane, `device ${lane.label} retired: ${broken ?? 'repeated environment failures'}`);
          return;
        }
      }
    }
  }
  const laneOutcomes = await Promise.allSettled(lanes.map(laneWorker));
  for (const [i, o] of laneOutcomes.entries()) if (o.status === 'rejected')
    warn(lanes[i], `device stopped unexpectedly: ${(o.reason as Error)?.message ?? o.reason}`);
  const queue: string[] = [];
  for (const item of work) {
    if (item.rows.length) finish(item);
    else queue.push(item.file);
  }

  // Belt and braces: work left in the queue with nothing explaining why would be a
  // silently short suite. Every real path (retirement, budget) has already set `stop`.
  if (!stop && queue.length) {
    stop = { reason: `${queue.length} test(s) were never dispatched`, kind: 'environment' };
  }

  // Report in FILE order regardless of who ran what when, so two runs of the same suite
  // produce comparable pages and a diff of two index.json files is readable.
  const fileOrder = new Map(files.map((f, i) => [f, i]));
  const byFile = (a: { file: string }, b: { file: string }): number =>
    (fileOrder.get(a.file) ?? 0) - (fileOrder.get(b.file) ?? 0);
  results.sort(byFile);

  const aborted = stop
    ? { reason: stop.reason, notRun: queue.sort((a, b) => (fileOrder.get(a) ?? 0) - (fileOrder.get(b) ?? 0)), kind: stop.kind }
    : undefined;
  if (aborted) {
    err(
      `[suite] ${aborted.kind === 'budget' ? 'STOPPED' : 'ABORTED — environment:'} ${aborted.reason} ` +
        `(${aborted.notRun.length} test(s) not run)`,
    );
  }

  const finishedAt = new Date().toISOString();
  const suite: SuiteRun = {
    schemaVersion: 1,
    id: suiteId,
    name,
    startedAt,
    finishedAt,
    platform: deps.platform,
    device: typeof deps.device === 'function' ? deps.device() : deps.device,
    verikun: VERSION,
    ...(deps.server ? { server: deps.server } : {}),
    ...(parallel ? { concurrency: lanes.length } : {}),
    totals: suiteTotals(results, Date.parse(finishedAt) - Date.parse(startedAt)),
    tests: results,
    ...(aborted ? { aborted } : {}),
    ...(warnings.length ? { warnings } : {}),
  };

  // .verikun/suites/<id>/ sits beside .verikun/runs/<id>/, so index.html reaches a
  // test report at ../../runs/<id>/report.html — the linkBase below. uniqueDir claims
  // the directory by creating it, so nothing needs to mkdir it here.
  const outDir = uniqueDir(join(artifactDir(), 'suites', suiteId));
  writeFileSync(join(outDir, 'index.json'), toSuiteIndexJson(suite));
  writeFileSync(join(outDir, 'index.html'), toSuiteHtml(suite, { linkBase: '../../' }));

  const t = suite.totals;
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  // Across a pool the sum is DEVICE time; saying only that would quietly redefine the
  // headline number the day a second device was added.
  const timing = parallel
    ? `${secs(t.wallClockMs ?? t.durationMs)} wall (${secs(t.durationMs)} device time on ${lanes.length} devices)`
    : secs(t.durationMs);
  err(`[suite] ${t.passed}/${t.tests} passed · ${t.steps} steps · $${t.costUsd.toFixed(4)} · ${timing}`);
  for (const r of results) {
    const status = r.flaky ? 'FLAKY' : r.ok ? 'PASS' : 'FAIL';
    const on = parallel && r.device ? ` · ${r.device}` : '';
    err(`  ${status} ${r.file}${on}${r.failure ? ` — ${r.failure}` : r.flaky ? ' — passed on retry' : ''}`);
  }
  if (warnings.length) err(`[suite] ${warnings.length} warning(s)`);
  err(`[suite] overview: ${join(outDir, 'index.html')}`);

  if (flagBool(flags, 'json')) json(suite);
  else out(outDir); // primary machine result: the suite directory

  // The CI gate: any failed test fails the invocation (mirrors `vk run archive`). An
  // environment abort exits 3 instead, so CI can tell "the runner is broken" from "the
  // app regressed" — the whole point of stopping early. A BUDGET stop is exit 1, not 3:
  // the box is fine, the run just did not finish, which is what `vk ai` already returns
  // for --max-cost-usd. A flake that recovered is ok (exit 0) with a warning — that is
  // the whole point of --retries.
  if (aborted) return aborted.kind === 'budget' ? 1 : 3;
  return t.failed > 0 ? 1 : 0;
}
