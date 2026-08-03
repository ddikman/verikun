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
import { Flags, flagStr, flagBool } from './args';
import { CliError, isEnvError } from './errors';
import { artifactDir, err, json, out } from './output';
import { runId, uniqueDir, RunState } from './run';
import { SuiteRun, SuiteTestResult, suiteTotals, toSuiteIndexJson, toSuiteHtml } from './report';
import { VERSION } from './version';

/** What one `vk ai` test run returns to its caller — produced by cli.ts's runAiTest,
 *  consumed here. Defined on the consumer side (like EngineDeps) so suite.ts never
 *  imports cli.ts. */
export interface AiRunResult {
  ok: boolean;
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

export async function cmdSuite(dirArg: string, flags: Flags, deps: SuiteDeps): Promise<number> {
  const dir = resolve(process.cwd(), dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CliError(`suite: '${dirArg}' is not a directory`, 2);
  }
  const files = listTestFiles(dir);
  if (files.length === 0) {
    throw new CliError(`suite: no test files (*.md) in '${dirArg}'`, 2);
  }

  const suiteId = runId();
  const name = flagStr(flags, 'name') || basename(dir);
  const startedAt = new Date().toISOString();
  err(`[suite] '${name}': ${files.length} test(s) from ${dirArg} (${deps.platform}${deps.device ? ` · ${deps.device}` : ''})`);

  const results: SuiteTestResult[] = [];
  let aborted: { reason: string; notRun: string[] } | undefined;
  for (let i = 0; i < files.length && !aborted; i++) {
    const file = files[i];
    err(`[suite] ── (${i + 1}/${files.length}) ${file} ──`);
    if (deps.reset) {
      try {
        await deps.reset();
        err('[suite] app state reset');
      } catch (e) {
        // A reset that failed because the BOX is broken means nothing after it is
        // trustworthy — but only if a re-probe agrees. Otherwise surface and continue:
        // a flaky reset should not zero out the whole suite, and the test itself will
        // fail loudly if the stale state actually matters.
        const broken = isEnvError(e) ? await stillBroken(deps) : undefined;
        if (broken) {
          // This test never ran, so it gets no row — notRun starts at the CURRENT file.
          aborted = { reason: `reset failed: ${broken}`, notRun: files.slice(i) };
          break;
        }
        err(`[suite] reset failed (${(e as Error).message}) — continuing`);
      }
    }
    const t0 = Date.now();
    try {
      const r = await deps.runTest(join(dir, file));
      results.push(toSuiteResult(file, r, Date.now() - t0));
      // The test itself reported an environment abort (exit 3 mid-plan). Same rule:
      // fatal only if the box is still broken. This test HAS a row and a real report,
      // so notRun starts after it.
      if (r.abortedForEnv) {
        const broken = await stillBroken(deps);
        if (broken) aborted = { reason: broken, notRun: files.slice(i + 1) };
      }
    } catch (e) {
      // A test that THREW (device gone, server unreachable, bad file) still becomes a
      // failed row — one broken test must not vaporize the suite report for the tests
      // that already ran. But if it threw because the environment is gone, stop.
      const msg = e instanceof Error ? e.message : String(e);
      err(`[suite] ${file} errored: ${msg}`);
      results.push({
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
      if (broken) aborted = { reason: broken, notRun: files.slice(i + 1) };
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
  };

  // .verikun/suites/<id>/ sits beside .verikun/runs/<id>/, so index.html reaches a
  // test report at ../../runs/<id>/report.html — the linkBase below.
  const outDir = uniqueDir(join(artifactDir(), 'suites', suiteId));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.json'), toSuiteIndexJson(suite));
  writeFileSync(join(outDir, 'index.html'), toSuiteHtml(suite, { linkBase: '../../' }));

  const t = suite.totals;
  err(`[suite] ${t.passed}/${t.tests} passed · ${t.steps} steps · $${t.costUsd.toFixed(4)} · ${(t.durationMs / 1000).toFixed(1)}s`);
  for (const r of results) err(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.file}${r.failure ? ` — ${r.failure}` : ''}`);
  err(`[suite] overview: ${join(outDir, 'index.html')}`);

  if (flagBool(flags, 'json')) json(suite);
  else out(outDir); // primary machine result: the suite directory

  // The CI gate: any failed test fails the invocation (mirrors `vk run archive`). An
  // environment abort exits 3 instead, so CI can tell "the runner is broken" from "the
  // app regressed" — the whole point of stopping early.
  return aborted ? 3 : t.failed > 0 ? 1 : 0;
}
