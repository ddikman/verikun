// `vk suite <dir>` — run a directory of natural-language tests sequentially as one
// suite: reset the app between tests, collect each test's result, and write a suite
// overview (index.json manifest + index.html) that links every test's archived
// report. Exits 1 when any test failed, so the command doubles as the CI gate.
//
// Dependency-injected like agent/engine.ts: this module imports NOTHING from cli.ts
// — the actual test execution (`runTest`, which is cli.ts's runAiTest bound to a
// local-or-remote backend) and the between-test reset come in via SuiteDeps. That
// keeps the enumeration/tally/manifest logic pure enough to unit-test without a
// device, and cli.ts free of a suite→cli import cycle.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { Flags, flagStr, flagBool, flagNum } from './args';
import { CliError, isEnvError } from './errors';
import { artifactDir, err, json, out } from './output';
import { runId, uniqueDir, RunState } from './run';
import { SuiteRun, SuiteTestResult, SuiteAttempt, suiteTotals, toSuiteIndexJson, toSuiteHtml } from './report';
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
}

export interface SuiteDeps {
  platform: string;
  device?: string;
  /** Run one NL test through the shared backend; returns data, writes no stdout. */
  runTest(file: string): Promise<AiRunResult>;
  /** Reset the app-under-test between tests (wired when --app was given). */
  reset?: () => Promise<void> | void;
  /** Re-probe the device toolchain. Called ONLY after an environment-flavoured failure,
   *  to decide whether it was a transient hiccup or a genuinely broken box. Throws
   *  (CliError exit 3) when still broken. Optional: unwired means "never abort". */
  preflight?: () => Promise<void> | void;
  /** Gap between the two health probes; defaults to PROBE_RETRY_MS. Exists so the unit
   *  suite can set 0 instead of sleeping a real second per abort case. */
  probeRetryMs?: number;
}

/** Gap between the two health probes below. Long enough to outlast a USB
 *  re-enumeration or a simulator relaunch, short enough not to pad a real abort. */
const PROBE_RETRY_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * An environment-flavoured failure is only FATAL if the toolchain is STILL broken when
 * we re-probe. This distinction is load-bearing: a transient uiautomator dump failure
 * also surfaces as exit 3 (matchWaiting/resolveOneWaiting don't catch a thrown
 * getElements), so aborting on the exit code alone would let one flaky dump vaporize a
 * 20-test suite. Returns the reason when broken, undefined when it was transient.
 */
async function stillBroken(deps: SuiteDeps): Promise<string | undefined> {
  if (!deps.preflight) return undefined; // not wired -> preserve continue-on-failure
  // Two attempts a second apart, because the probe is the ONLY thing separating a
  // momentary blip from a dead box, and killing a 20-test suite is the expensive
  // mistake. A USB re-enumeration or a simulator mid-relaunch can fail one probe and
  // pass the next; a genuinely missing tool fails both in a few milliseconds.
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(deps.probeRetryMs ?? PROBE_RETRY_MS);
    try {
      await deps.preflight();
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

/** The *.md files in a suite dir (non-recursive). README.md is documentation for
 *  the suite, not a test — skipped by convention. */
export function listTestFiles(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => {
    if (!f.toLowerCase().endsWith('.md') || f.toLowerCase() === 'readme.md') return false;
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

/** Budget aborts won't heal on retry: each attempt gets its own cost ceiling, so a
 *  rerun just re-aborts at the same place having spent the money twice. */
function isRetryable(r: AiRunResult): boolean {
  return !r.ok && !r.abortedForBudget;
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

export async function cmdSuite(dirArg: string, flags: Flags, deps: SuiteDeps): Promise<number> {
  const dir = resolve(process.cwd(), dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CliError(`suite: '${dirArg}' is not a directory`, 2);
  }
  const files = listTestFiles(dir);
  if (files.length === 0) {
    throw new CliError(`suite: no test files (*.md) in '${dirArg}'`, 2);
  }

  const retries = parseRetries(flags);
  const suiteId = runId();
  const name = flagStr(flags, 'name') || basename(dir);
  const startedAt = new Date().toISOString();
  err(
    `[suite] '${name}': ${files.length} test(s) from ${dirArg} (${deps.platform}${deps.device ? ` · ${deps.device}` : ''})${
      retries > 0 ? ` · up to ${retries} retry(ies) on failure` : ''
    }`,
  );

  const results: SuiteTestResult[] = [];
  const warnings: string[] = [];
  let aborted: { reason: string; notRun: string[] } | undefined;

  async function resetApp(label: string): Promise<string | undefined> {
    // Returns the abort reason when the suite should stop (confirmed env break during reset).
    if (!deps.reset) return undefined;
    try {
      await deps.reset();
      err(`[suite] app state reset${label}`);
      return undefined;
    } catch (e) {
      // A reset that failed because the BOX is broken means nothing after it is
      // trustworthy — but only if a re-probe agrees. Otherwise surface and continue:
      // a flaky reset should not zero out the whole suite, and the test itself will
      // fail loudly if the stale state actually matters.
      const broken = isEnvError(e) ? await stillBroken(deps) : undefined;
      if (broken) return broken;
      err(`[suite] reset failed (${(e as Error).message}) — continuing`);
      return undefined;
    }
  }

  /** A confirmed env break with attempts left: say so, pause, and let the loop retry.
   *  The pause matters — the failures this rides out (a server restart, a wifi drop, a
   *  USB re-enumeration) clear in seconds, and retrying into the same dead socket
   *  immediately would burn every attempt inside the outage. */
  async function noteEnvRetry(file: string, attempt: number, reason: string): Promise<void> {
    const warn = `${file}: environment error on attempt ${attempt + 1} (${reason}) — retried`;
    warnings.push(warn);
    err(`[suite] WARN ${warn}`);
    await sleep((deps.probeRetryMs ?? PROBE_RETRY_MS) * (attempt + 1));
  }

  for (let i = 0; i < files.length && !aborted; i++) {
    const file = files[i];
    err(`[suite] ── (${i + 1}/${files.length}) ${file} ──`);

    const attemptRows: SuiteTestResult[] = [];

    for (let attempt = 0; attempt <= retries; attempt++) {
      // The last attempt is where a retryable failure becomes the verdict: a confirmed
      // env break aborts the suite, anything else stands as this test's failed row.
      const lastAttempt = attempt === retries;
      if (attempt > 0) err(`[suite] retry ${attempt}/${retries} for ${file}`);

      // Re-isolate before EVERY attempt — between tests and between retries alike.
      const resetBreak = await resetApp(attempt > 0 ? ' (retry)' : '');
      if (resetBreak) {
        if (!lastAttempt) {
          await noteEnvRetry(file, attempt, `reset failed: ${resetBreak}`);
          continue;
        }
        // With no attempt row this test never ran, so notRun starts at the CURRENT file.
        aborted = {
          reason: `reset failed: ${resetBreak}`,
          notRun: files.slice(attemptRows.length ? i + 1 : i),
        };
        break;
      }

      const t0 = Date.now();
      try {
        const r = await deps.runTest(join(dir, file));
        attemptRows.push(toSuiteResult(file, r, Date.now() - t0));
        if (r.abortedForEnv) {
          const broken = await stillBroken(deps);
          if (broken) {
            if (!lastAttempt) {
              // Even a CONFIRMED break is worth an attempt: the probe window is a couple
              // of seconds, which a server restart outlives — and aborting costs the run.
              await noteEnvRetry(file, attempt, broken);
              continue;
            }
            aborted = { reason: broken, notRun: files.slice(i + 1) };
            break;
          }
          // Transient env blip: retryable like any other failure.
        }
        if (r.ok || !isRetryable(r) || lastAttempt) break;
      } catch (e) {
        // A test that THREW (device gone, server unreachable, bad file) still becomes a
        // failed row — one broken test must not vaporize the suite report for the tests
        // that already ran. Out of attempts, a confirmed env break stops the suite.
        const msg = e instanceof Error ? e.message : String(e);
        err(`[suite] ${file} errored: ${msg}`);
        attemptRows.push({
          id: '',
          file,
          name: basename(file, extname(file)),
          ok: false,
          durationMs: Date.now() - t0,
          costUsd: 0,
          steps: 0,
          passedSteps: 0,
          failedSteps: 0,
          modelRepairs: 0,
          failure: msg.split('\n')[0],
        });
        const broken = isEnvError(e) ? await stillBroken(deps) : undefined;
        if (lastAttempt) {
          if (broken) aborted = { reason: broken, notRun: files.slice(i + 1) };
          break;
        }
        if (!isRetryableThrow(e)) break;
        if (broken) await noteEnvRetry(file, attempt, broken);
      }
    }

    if (attemptRows.length === 0) {
      // Every attempt was blocked by a failing reset, so the test never ran and gets no
      // row — `aborted.notRun` (set above) already names it. Nothing to merge.
      break;
    }

    const merged = mergeSuiteAttempts(attemptRows);
    results.push(merged);
    if (merged.flaky) {
      const n = merged.attempts?.length ?? 0;
      const warn = `${file} passed on retry after ${n} failed attempt${n === 1 ? '' : 's'}`;
      warnings.push(warn);
      err(`[suite] WARN ${warn}`);
    }
  }
  if (aborted) {
    err(`[suite] ABORTED — environment: ${aborted.reason} (${aborted.notRun.length} test(s) not run)`);
  }

  const suite: SuiteRun = {
    schemaVersion: 1,
    id: suiteId,
    name,
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: deps.platform,
    device: deps.device,
    verikun: VERSION,
    totals: suiteTotals(results),
    tests: results,
    ...(aborted ? { aborted } : {}),
    ...(warnings.length ? { warnings } : {}),
  };

  // .verikun/suites/<id>/ sits beside .verikun/runs/<id>/, so index.html reaches a
  // test report at ../../runs/<id>/report.html — the linkBase below.
  const outDir = uniqueDir(join(artifactDir(), 'suites', suiteId));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.json'), toSuiteIndexJson(suite));
  writeFileSync(join(outDir, 'index.html'), toSuiteHtml(suite, { linkBase: '../../' }));

  const t = suite.totals;
  err(`[suite] ${t.passed}/${t.tests} passed · ${t.steps} steps · $${t.costUsd.toFixed(4)} · ${(t.durationMs / 1000).toFixed(1)}s`);
  for (const r of results) {
    const tag = r.flaky ? 'FLAKY' : r.ok ? 'PASS' : 'FAIL';
    err(`  ${tag} ${r.file}${r.failure ? ` — ${r.failure}` : r.flaky ? ' — passed on retry' : ''}`);
  }
  if (warnings.length) err(`[suite] ${warnings.length} warning(s)`);
  err(`[suite] overview: ${join(outDir, 'index.html')}`);

  if (flagBool(flags, 'json')) json(suite);
  else out(outDir); // primary machine result: the suite directory

  // The CI gate: any failed test fails the invocation (mirrors `vk run archive`). An
  // environment abort exits 3 instead, so CI can tell "the runner is broken" from "the
  // app regressed" — the whole point of stopping early. A flake that recovered is ok
  // (exit 0) with a warning — that is the whole point of --retries.
  return aborted ? 3 : t.failed > 0 ? 1 : 0;
}
