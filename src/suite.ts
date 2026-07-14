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
import { CliError } from './errors';
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
}

export interface SuiteDeps {
  platform: string;
  device?: string;
  /** Run one NL test through the shared backend; returns data, writes no stdout. */
  runTest(file: string): Promise<AiRunResult>;
  /** Reset the app-under-test between tests (wired when --app was given). */
  reset?: () => Promise<void> | void;
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
  const failure = r.failure
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
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    err(`[suite] ── (${i + 1}/${files.length}) ${file} ──`);
    if (deps.reset) {
      try {
        await deps.reset();
        err('[suite] app state reset');
      } catch (e) {
        // Surface but continue: a flaky reset should not zero out the whole suite —
        // the test itself will fail loudly if the stale state actually matters.
        err(`[suite] reset failed (${(e as Error).message}) — continuing`);
      }
    }
    const t0 = Date.now();
    try {
      const r = await deps.runTest(join(dir, file));
      results.push(toSuiteResult(file, r, Date.now() - t0));
    } catch (e) {
      // A test that THREW (env error: device gone, server unreachable, bad file)
      // still becomes a failed row — one broken test must not vaporize the suite
      // report for the tests that already ran.
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
    }
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

  // The CI gate: any failed test fails the invocation (mirrors `vk run archive`).
  return t.failed > 0 ? 1 : 0;
}
