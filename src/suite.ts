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
import { CliError, isEnvError } from './errors';
import { artifactDir, err, json, out } from './output';
import { runId, uniqueDir, RunState } from './run';
import { SuiteRun, SuiteTestResult, SuiteAttempt, suiteTotals, toSuiteIndexJson, toSuiteHtml } from './report';
import { sleep } from './wait';
import { VERSION } from './version';

/** What one `vk ai` test run returns to its caller — produced by cli.ts's runAiTest,
 *  consumed here. Defined on the consumer side (like EngineDeps) so suite.ts never
 *  imports cli.ts. */
export interface AiRunResult {
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
  server?: { url: string; verikun: string; reads?: string };
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
}

/** Gap between the two health probes below. Long enough to outlast a USB
 *  re-enumeration or a simulator relaunch, short enough not to pad a real abort. */
const PROBE_RETRY_MS = 1000;

/** How often an idle lane re-checks the queue while another lane is still working.
 *  Only reached on the tail of a suite, and only when a requeue is still possible. */
const IDLE_POLL_MS = 25;


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
    modelRepairs: r.modelRepairs,
    ...(r.ok ? {} : { failure: failure ?? 'failed' }),
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
  const flaky = last.ok && prior.some((a) => !a.ok);
  return {
    ...last,
    durationMs: attempts.reduce((a, t) => a + t.durationMs, 0),
    costUsd: round(attempts.reduce((a, t) => a + t.costUsd, 0)),
    modelRepairs: attempts.reduce((a, t) => a + t.modelRepairs, 0),
    attempts: prior,
    ...(flaky ? { flaky: true } : {}),
  };
}

// What --retries will and won't spend an attempt on. The bias is deliberate and
// asymmetric: a retry costs one test, while giving up costs the whole suite plus a
// human rerunning it. So the rule is *retry unless a rerun provably cannot change the
// outcome* — the two predicates below are the only "provably" cases, everything else
// (flaky selector, wedged app, a wobbling network to `vk server`) earns another go.

/**
 * The row for a test that THREW rather than returning a result.
 *
 * One helper, because there are two throw sites (out of attempts, and an escape past the
 * attempt loop) and hand-building an 11-field row twice is how the `device` column went
 * missing from both — for exactly the crash-shaped failures a pool makes common.
 */
function erroredRow(file: string, lane: Lane, message: string, durationMs: number): SuiteTestResult {
  return {
    id: '',
    file,
    name: basename(file, extname(file)),
    ok: false,
    ...(lane.device ? { device: lane.device } : {}),
    durationMs,
    costUsd: 0,
    steps: 0,
    passedSteps: 0,
    failedSteps: 0,
    modelRepairs: 0,
    failure: message.split('\n')[0],
  };
}

/** Two "provably" cases. A BUDGET abort won't heal: each attempt gets its own cost
 *  ceiling, so a rerun just re-aborts at the same place having spent the money twice. A
 *  USAGE error (exit 2 from a lane child) is the same verdict `isRetryableThrow` reaches
 *  on the serial path, where it arrives as a throw rather than an exit code. */
function isRetryable(r: AiRunResult): boolean {
  return !r.ok && !r.abortedForBudget && !r.usageError;
}

/** A thrown USAGE error (exit 2) is the one throw a rerun cannot change — an unreadable
 *  test file, a payload the server refuses, a flag it doesn't understand. Everything
 *  else, including every environment error, is retried while attempts remain. */
function isRetryableThrow(e: unknown): boolean {
  return !(e instanceof CliError && e.exitCode === 2);
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

/** Consecutive environment failures that retire a lane even when the probe says the
 *  box is fine. The backstop for a POOL: `deps.preflight` on a remote lane can only ask
 *  whether the SERVER answers, so one dead device behind a healthy server would
 *  otherwise fail every test routed to it, for the whole suite, with nothing retiring
 *  it. Pool-only — with a single lane, retiring early just loses coverage. */
const ENV_STREAK_LIMIT = 2;

/** What one file's attempts produced. */
interface TestOutcome {
  /** The merged row; absent when every attempt was blocked before the test ran. */
  row?: SuiteTestResult;
  /** A CONFIRMED environment break — retires this lane (and, if it was the last one,
   *  aborts the suite). */
  envBreak?: string;
  /** The final attempt smelled like the environment, whether or not the probe agreed.
   *  Feeds ENV_STREAK_LIMIT. */
  envFlavoured?: boolean;
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

  // Longest-first only for a pool. Serially, file order IS the contract (`01-`/`02-`
  // prefixes sequence dependent flows), which a pool cannot honour anyway.
  const queue = parallel ? orderTests(files, readDurationHints(join(artifactDir(), 'suites'), name)) : [...files];
  const results: SuiteTestResult[] = [];
  const warnings: string[] = [];
  let stop: { reason: string; kind: 'environment' | 'budget' } | undefined;
  let spentUsd = 0;
  let retiredLanes = 0;
  let started = 0;

  const tag = (lane: Lane): string => (parallel && lane.label ? `[suite ${lane.label}]` : '[suite]');

  async function resetApp(lane: Lane, label: string): Promise<string | undefined> {
    // Returns the abort reason when the lane should stop (confirmed env break during reset).
    if (!deps.reset) return undefined;
    try {
      await deps.reset(lane);
      err(`${tag(lane)} app state reset${label}`);
      return undefined;
    } catch (e) {
      // A reset that failed because the BOX is broken means nothing after it is
      // trustworthy — but only if a re-probe agrees. Otherwise surface and continue:
      // a flaky reset should not zero out the whole suite, and the test itself will
      // fail loudly if the stale state actually matters.
      const broken = isEnvError(e) ? await stillBroken(deps, lane) : undefined;
      if (broken) return broken;
      err(`${tag(lane)} reset failed (${(e as Error).message}) — continuing`);
      return undefined;
    }
  }

  /** A confirmed env break with attempts left: say so, pause, and let the loop retry.
   *  The pause matters — the failures this rides out (a server restart, a wifi drop, a
   *  USB re-enumeration) clear in seconds, and retrying into the same dead socket
   *  immediately would burn every attempt inside the outage. */
  async function noteEnvRetry(lane: Lane, file: string, attempt: number, reason: string): Promise<void> {
    const warn = `${file}: environment error on attempt ${attempt + 1} (${reason}) — retried`;
    warnings.push(warn);
    err(`${tag(lane)} WARN ${warn}`);
    await sleep((deps.probeRetryMs ?? PROBE_RETRY_MS) * (attempt + 1));
  }

  /** Every attempt at one file, on one lane. */
  async function runOneTest(file: string, lane: Lane): Promise<TestOutcome> {
    // Bounded: a lane that retires re-queues its file, so a plain dispatch counter can
    // print "(9/8)". Clamp rather than drop the position — it is the only progress signal
    // a parallel run gives, and an occasional repeat reads better than a lie.
    err(`${tag(lane)} ── (${Math.min(++started, files.length)}/${files.length}) ${file} ──`);
    const attemptRows: SuiteTestResult[] = [];
    let envFlavoured = false;
    const merge = (): SuiteTestResult | undefined =>
      attemptRows.length ? mergeSuiteAttempts(attemptRows) : undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      // The last attempt is where a retryable failure becomes the verdict: a confirmed
      // env break retires the lane, anything else stands as this test's failed row.
      const lastAttempt = attempt === retries;
      if (attempt > 0) err(`${tag(lane)} retry ${attempt}/${retries} for ${file}`);

      // Re-isolate before EVERY attempt — between tests and between retries alike.
      const resetBreak = await resetApp(lane, attempt > 0 ? ' (retry)' : '');
      if (resetBreak) {
        if (!lastAttempt) {
          await noteEnvRetry(lane, file, attempt, `reset failed: ${resetBreak}`);
          continue;
        }
        // With no attempt row this test never ran, so the caller re-queues it.
        return { row: merge(), envBreak: `reset failed: ${resetBreak}` };
      }

      const t0 = Date.now();
      try {
        const r = await deps.runTest(join(dir, file), lane);
        attemptRows.push(toSuiteResult(file, r, Date.now() - t0));
        envFlavoured = !!r.abortedForEnv;
        if (r.abortedForEnv) {
          const broken = await stillBroken(deps, lane);
          if (broken) {
            if (!lastAttempt) {
              // Even a CONFIRMED break is worth an attempt: the probe window is a couple
              // of seconds, which a server restart outlives — and retiring costs a device.
              await noteEnvRetry(lane, file, attempt, broken);
              continue;
            }
            return { row: merge(), envBreak: broken };
          }
          // Transient env blip: retryable like any other failure.
        }
        if (r.ok || !isRetryable(r) || lastAttempt) break;
      } catch (e) {
        // A test that THREW (device gone, server unreachable, bad file) still becomes a
        // failed row — one broken test must not vaporize the suite report for the tests
        // that already ran. Out of attempts, a confirmed env break retires the lane.
        const msg = e instanceof Error ? e.message : String(e);
        err(`${tag(lane)} ${file} errored: ${msg}`);
        attemptRows.push(erroredRow(file, lane, msg, Date.now() - t0));
        envFlavoured = isEnvError(e);
        const broken = envFlavoured ? await stillBroken(deps, lane) : undefined;
        if (lastAttempt) {
          if (broken) return { row: merge(), envBreak: broken };
          break;
        }
        if (!isRetryableThrow(e)) break;
        if (broken) await noteEnvRetry(lane, file, attempt, broken);
      }
    }

    const merged = merge();
    if (merged?.flaky) {
      const n = merged.attempts?.length ?? 0;
      const warn = `${file} passed on retry after ${n} failed attempt${n === 1 ? '' : 's'}`;
      warnings.push(warn);
      err(`${tag(lane)} WARN ${warn}`);
    }
    return { row: merged, envFlavoured };
  }

  /** Take a lane out of service. The last one out stops the suite. */
  function retire(lane: Lane, reason: string): void {
    retiredLanes += 1;
    const remaining = lanes.length - retiredLanes;
    if (remaining > 0) {
      // Only claim a handoff when there is actually work left to hand off — the other
      // lanes may already have drained the queue.
      const moved = queue.length ? ` — its ${queue.length} remaining test(s) move to the other ${remaining} device(s)` : '';
      const warn = `device ${lane.label} retired: ${reason}${moved}`;
      warnings.push(warn);
      err(`[suite] WARN ${warn}`);
      return;
    }
    stop ??= { reason, kind: 'environment' };
  }

  /**
   * One lane, pulling from the shared queue until it is empty, the lane is retired, or
   * the suite stops. This — not a fixed partition — is what absorbs the duration spread:
   * a device that draws three short tests simply comes back for a fourth.
   */
  let busyLanes = 0;
  async function laneWorker(lane: Lane): Promise<void> {
    let envStreak = 0;
    for (;;) {
      if (stop) return;
      const file = queue.shift();
      if (file === undefined) {
        // An empty queue is NOT the end while another lane is still working: a lane that
        // dies before its test ran hands the file back, and a worker that had already
        // exited would leave it unrun — present in no row and in no `notRun` list, which
        // is the one outcome a gate must never produce. Poll rather than signal: the
        // wait only ever happens on the tail of a suite, and a condition variable here
        // would be more machinery than the case is worth.
        if (busyLanes === 0) return;
        await sleep(IDLE_POLL_MS);
        continue;
      }

      busyLanes += 1;
      let outcome: TestOutcome;
      const startedTest = Date.now();
      try {
        outcome = await runOneTest(file, lane);
      } catch (e) {
        // The file is already off the queue, so an escaping throw would erase this test
        // from the results AND from `notRun` — a suite that silently ran one fewer test
        // and still exited 0. Record it as the failure it is.
        const msg = e instanceof Error ? e.message : String(e);
        err(`${tag(lane)} ${file} errored: ${msg}`);
        outcome = { row: erroredRow(file, lane, msg, Date.now() - startedTest) };
      } finally {
        busyLanes -= 1;
      }
      if (outcome.row) {
        results.push(outcome.row);
        spentUsd += outcome.row.costUsd;
      }
      if (outcome.envBreak) {
        // Never ran: put it back so a healthy lane can still cover it.
        if (!outcome.row) queue.unshift(file);
        retire(lane, outcome.envBreak);
        return;
      }
      envStreak = outcome.envFlavoured ? envStreak + 1 : 0;
      if (parallel && envStreak >= ENV_STREAK_LIMIT) {
        retire(lane, `${envStreak} consecutive environment failures`);
        return;
      }
      // Only a ceiling that actually STOPS something is an abort. Without the queue
      // check, a suite whose last test tips the total over its budget reports ABORTED
      // with an empty `notRun` and exits 1 — a red gate on a run where every test passed.
      if (maxSuiteCost !== undefined && spentUsd >= maxSuiteCost && queue.length > 0) {
        stop ??= {
          reason: `suite cost ceiling $${maxSuiteCost} reached (spent $${spentUsd.toFixed(4)})`,
          kind: 'budget',
        };
      }
    }
  }

  // allSettled, not all: `laneWorker` can in principle throw (a malformed row, an EPIPE
  // on stderr), and `Promise.all` would reject on the spot — abandoning the other lanes'
  // in-flight children and returning before the manifest is written, so a suite that
  // mostly succeeded would produce no report at all.
  const laneOutcomes = await Promise.allSettled(lanes.map(laneWorker));
  for (const [i, o] of laneOutcomes.entries()) {
    if (o.status !== 'rejected') continue;
    const warn = `device ${lanes[i].label} stopped unexpectedly: ${(o.reason as Error)?.message ?? o.reason}`;
    warnings.push(warn);
    err(`[suite] WARN ${warn}`);
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
