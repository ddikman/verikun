import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  cmdSuite, sortTestFiles, listTestFiles, toSuiteResult, mergeSuiteAttempts, orderTests,
  readDurationHints, laneCount, deviceWaitMs, AiRunResult, SuiteDeps, Lane,
} from '../src/suite';
import { laneResult } from '../src/cli';
import { RunState, RunStep } from '../src/run';
import { SuiteRun } from '../src/report';
import { CliError, envError, usageError } from '../src/errors';

// --- sortTestFiles ----------------------------------------------------------

test('sortTestFiles: lexicographic, so 01-/02- prefixes sequence the suite', () => {
  assert.deepEqual(sortTestFiles(['10-last.md', '02-second.md', '01-first.md']), [
    '01-first.md',
    '02-second.md',
    '10-last.md',
  ]);
});

test('sortTestFiles: does not mutate its input', () => {
  const input = ['b.md', 'a.md'];
  sortTestFiles(input);
  assert.deepEqual(input, ['b.md', 'a.md']);
});

// --- listTestFiles ----------------------------------------------------------

test('listTestFiles: only top-level *.md, sorted, README excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-suite-'));
  try {
    writeFileSync(join(dir, '02-checkout.md'), 'x');
    writeFileSync(join(dir, '01-login.md'), 'x');
    writeFileSync(join(dir, 'README.md'), 'about this suite');
    writeFileSync(join(dir, 'notes.txt'), 'not a test');
    mkdirSync(join(dir, 'nested.md')); // a directory that merely looks like a test
    assert.deepEqual(listTestFiles(dir), ['01-login.md', '02-checkout.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listTestFiles: a _-prefixed fragment is shared prose, not a test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-suite-'));
  try {
    writeFileSync(join(dir, '01-login.md'), 'x');
    writeFileSync(join(dir, '_preamble.md'), 'shared steps every test @includes');
    assert.deepEqual(listTestFiles(dir), ['01-login.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- toSuiteResult ----------------------------------------------------------

function step(status: RunStep['status']): RunStep {
  return {
    index: 0,
    command: 'tap',
    name: 'tap @x',
    startedAt: new Date().toISOString(),
    durationMs: 10,
    status,
    exitCode: status === 'passed' ? 0 : 1,
  };
}

function state(steps: RunStep[]): RunState {
  return {
    id: 'r1',
    name: 'ai: t.md',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    platform: 'android',
    implicit: false,
    steps,
  };
}

function aiResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    ok: true,
    cached: false,
    costUsd: 0.05,
    costLine: 'est $0.05',
    modelRepairs: 0,
    improvements: [],
    runDir: '/tmp/proj/.verikun/runs/20260713-1015',
    reportHtml: '/tmp/proj/.verikun/runs/20260713-1015/report.html',
    junitXml: '/tmp/proj/.verikun/runs/20260713-1015/report.xml',
    state: state([step('passed'), step('passed'), step('failed')]),
    ...overrides,
  };
}

test('toSuiteResult: tallies steps and derives the id from the run dir', () => {
  const r = toSuiteResult('01-login.md', aiResult(), 12345);
  assert.equal(r.id, '20260713-1015'); // basename — uniqueDir may have suffixed -2
  assert.equal(r.name, '01-login');
  assert.equal(r.steps, 3);
  assert.equal(r.passedSteps, 2);
  assert.equal(r.failedSteps, 1);
  assert.equal(r.durationMs, 12345);
  assert.equal(r.costUsd, 0.05);
  assert.equal(r.failure, undefined, 'a green test carries no failure');
});

test('toSuiteResult: planSteps records the COMPILE size, next to the executed tally', () => {
  // The two are different questions, and conflating them is what made a truncated compile
  // undetectable by eye: `steps` reads short for every FAILURE, so a genuinely short plan
  // drowns among them (issue #127).
  const r = toSuiteResult('t.md', aiResult({ planSteps: 40 }), 1);
  assert.equal(r.planSteps, 40);
  assert.equal(r.steps, 3, 'still what executed');
  // Omitted, not zeroed, when no plan was ever obtained — a compile that threw.
  assert.equal(Object.hasOwn(toSuiteResult('t.md', aiResult(), 1), 'planSteps'), false);
});

test('toSuiteResult: a failing test carries the engine failure summary', () => {
  const r = toSuiteResult('t.md', aiResult({ ok: false, failure: { where: 'steps[2]', reason: 'assert failed' } }), 1);
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'FAIL at steps[2]: assert failed');
});

test('toSuiteResult: budget/timeout aborts read as aborted, not silent failures', () => {
  const budget = toSuiteResult('t.md', aiResult({ ok: false, abortedForBudget: true, failure: undefined }), 1);
  assert.equal(budget.failure, 'aborted: cost ceiling reached');
  const timeout = toSuiteResult('t.md', aiResult({ ok: false, abortedForTimeout: true, failure: undefined }), 1);
  assert.equal(timeout.failure, 'aborted: run timeout reached');
});

test('toSuiteResult: a test that never ran (no run dir, no state) is zeroed', () => {
  const r = toSuiteResult('t.md', aiResult({ ok: false, runDir: '', state: null, failure: { where: 'compile', reason: 'over budget' } }), 1);
  assert.equal(r.id, '');
  assert.equal(r.steps, 0);
  assert.equal(r.failure, 'FAIL at compile: over budget');
});

test('toSuiteResult: an environment abort is labelled as such, not as a test failure', () => {
  const r = toSuiteResult(
    't.md',
    aiResult({ ok: false, abortedForEnv: true, failure: { where: 'steps[2]', reason: "'idb' was not found on PATH." } }),
    1,
  );
  assert.equal(r.failure, "aborted: environment — 'idb' was not found on PATH.");
});

// --- mergeSuiteAttempts -----------------------------------------------------

test('mergeSuiteAttempts: a single attempt is returned unchanged', () => {
  const one = toSuiteResult('t.md', aiResult(), 100);
  assert.deepEqual(mergeSuiteAttempts([one]), one);
});

test('mergeSuiteAttempts: fail-then-pass is flaky, sums cost/duration, keeps prior evidence', () => {
  const fail = toSuiteResult(
    '01-login.md',
    aiResult({
      ok: false,
      runDir: '/tmp/.verikun/runs/fail-1',
      costUsd: 0.02,
      failure: { where: 'steps[1]', reason: 'assert failed' },
    }),
    1000,
  );
  const pass = toSuiteResult(
    '01-login.md',
    aiResult({ ok: true, runDir: '/tmp/.verikun/runs/pass-2', costUsd: 0.03, modelRepairs: 1 }),
    2000,
  );
  const merged = mergeSuiteAttempts([fail, pass]);
  assert.equal(merged.ok, true);
  assert.equal(merged.flaky, true);
  assert.equal(merged.id, 'pass-2', 'primary id is the winning run');
  assert.equal(merged.durationMs, 3000);
  assert.equal(merged.costUsd, 0.05);
  assert.equal(merged.modelRepairs, 1);
  assert.equal(merged.attempts?.length, 1);
  assert.equal(merged.attempts![0].id, 'fail-1');
  assert.equal(merged.attempts![0].ok, false);
  assert.match(merged.attempts![0].failure ?? '', /assert failed/);
});

test('mergeSuiteAttempts: a pass after an EVICTION is not flaky — the phone left, the test did not flake', () => {
  const evicted = toSuiteResult('t.md', aiResult({ ok: false, abortedForEnv: true, evicted: true, failure: { where: 'run', reason: 'a left the pool' } }), 400);
  assert.equal(evicted.evicted, true, 'the attempt row says what happened to it');
  const merged = mergeSuiteAttempts([evicted, toSuiteResult('t.md', aiResult({ ok: true }), 900)]);
  assert.equal(merged.ok, true);
  assert.equal(merged.flaky, undefined);
  assert.equal(merged.attempts?.[0].evicted, true, 'kept as evidence, marked as an eviction');
  assert.equal(merged.durationMs, 1300, 'its time still counts');
});

test('mergeSuiteAttempts: still-failing after retries keeps prior attempts but is not flaky', () => {
  const a = toSuiteResult('t.md', aiResult({ ok: false, runDir: '/tmp/runs/a', failure: { where: 's', reason: 'x' } }), 10);
  const b = toSuiteResult('t.md', aiResult({ ok: false, runDir: '/tmp/runs/b', failure: { where: 's', reason: 'y' } }), 20);
  const merged = mergeSuiteAttempts([a, b]);
  assert.equal(merged.ok, false);
  assert.equal(merged.flaky, undefined);
  assert.equal(merged.id, 'b');
  assert.equal(merged.attempts?.length, 1);
  assert.equal(merged.attempts![0].id, 'a');
});

// --- cmdSuite: the loop, its abort rule, and the manifest it writes ----------
//
// cmdSuite writes under artifactDir() = resolve(process.cwd(), '.verikun'), which is
// NOT env-overridable — so each case runs inside a temp cwd and restores it on every
// path (node --test runs test files in-process, so a leaked chdir would poison the
// rest of the suite).

async function inTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'vk-suite-run-'));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A suite dir holding `n` numbered test files: 01-t.md, 02-t.md, … */
function suiteDir(root: string, n: number): string {
  const dir = join(root, 'tests');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `${String(i).padStart(2, '0')}-t.md`), 'tap the thing');
  return dir;
}

/** Read back the manifest cmdSuite just wrote (stdout is the suite dir). */
function readManifest(outDir: string): SuiteRun {
  return JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8')) as SuiteRun;
}

interface HarnessOpts {
  files: number;
  /** Per-file (1-indexed) result or thrown error. Defaults to a green run. */
  onTest?: (n: number) => AiRunResult | Error;
  /** undefined = deps.preflight not wired at all. */
  preflight?: () => void;
  reset?: () => void;
}

function harness(o: HarnessOpts) {
  const ran: string[] = [];
  let probes = 0;
  const deps: SuiteDeps = {
    platform: 'ios',
    device: 'SIM-1',
    probeRetryMs: 0, // the real 1s gap would make every abort case sleep
    runTest: async (file) => {
      ran.push(basename(file));
      const r = o.onTest?.(ran.length) ?? aiResult();
      if (r instanceof Error) throw r;
      return r;
    },
    ...(o.reset ? { reset: o.reset } : {}),
    ...(o.preflight
      ? {
          preflight: () => {
            probes++;
            o.preflight!();
          },
        }
      : {}),
  };
  return { deps, ran, probeCount: () => probes };
}

const healthy = () => {};
const broken = () => {
  throw envError("'idb' was not found on PATH.");
};
const envFailedRun = () =>
  aiResult({ ok: false, abortedForEnv: true, failure: { where: 'steps[2]', reason: "'idb' was not found on PATH." } });

test('cmdSuite: runs every test and exits 1 when one fails', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran } = harness({
      files: 3,
      onTest: (n) => (n === 2 ? aiResult({ ok: false, failure: { where: 'steps[1]', reason: 'assert failed' } }) : aiResult()),
      preflight: healthy,
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1);
    assert.deepEqual(ran, ['01-t.md', '02-t.md', '03-t.md']);
  });
});

test('cmdSuite: an env abort STOPS the suite and exits 3 when the box is still broken', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    const { deps, ran, probeCount } = harness({
      files: 4,
      onTest: (n) => (n === 2 ? envFailedRun() : aiResult()),
      preflight: broken,
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 3, 'environment, not a regression');
    assert.deepEqual(ran, ['01-t.md', '02-t.md'], 'stopped after the broken test');
    assert.equal(probeCount(), 2, 'probed twice before declaring the box dead');

    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    assert.deepEqual(suite.aborted?.notRun, ['03-t.md', '04-t.md']);
    assert.match(suite.aborted?.reason ?? '', /idb/);
    // The test that hit the error still has a real row; the not-run ones do NOT.
    assert.deepEqual(suite.tests.map((t) => t.file), ['01-t.md', '02-t.md']);
    // Totals count only what ran, so passed + failed === tests still holds.
    assert.equal(suite.totals.tests, 2);
    assert.equal(suite.totals.passed + suite.totals.failed, suite.totals.tests);
  });
});

test('cmdSuite: an env-flavoured blip does NOT abort when the re-probe says the box is fine', async () => {
  // The regression guard that makes the re-probe worth having: a transient uiautomator
  // dump failure also exits 3, and must not vaporize the rest of the suite.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    const { deps, ran, probeCount } = harness({
      files: 4,
      onTest: (n) => (n === 2 ? envFailedRun() : aiResult()),
      preflight: healthy,
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1, 'the blip is just a failed test');
    assert.equal(ran.length, 4, 'every test still ran');
    assert.equal(probeCount(), 1);
  });
});

test('cmdSuite: a probe that fails once then recovers is a blip, not an abort', async () => {
  // The retry is the whole reason the probe is two attempts: a USB re-enumeration or a
  // simulator relaunch can fail one probe and pass the next.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let probe = 0;
    const { deps, ran } = harness({
      files: 3,
      onTest: (n) => (n === 1 ? envFailedRun() : aiResult()),
      preflight: () => {
        if (++probe === 1) throw envError('transient: device busy');
      },
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1, 'recovered — just a failed test');
    assert.equal(ran.length, 3, 'the suite carried on');
    assert.equal(probe, 2);
  });
});

test('cmdSuite: a test that THREW an env error aborts once the re-probe confirms it', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran } = harness({
      files: 3,
      onTest: (n) => (n === 2 ? envError('device disconnected') : aiResult()),
      preflight: broken,
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 3);
    assert.equal(ran.length, 2);
    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    // A thrown test still gets its own failed row, then the suite stops.
    assert.equal(suite.tests.length, 2);
    assert.deepEqual(suite.aborted?.notRun, ['03-t.md']);
  });
});

test('cmdSuite: a NON-env throw never re-probes and never aborts', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran, probeCount } = harness({
      files: 3,
      onTest: (n) => (n === 2 ? new Error('could not read the test file') : aiResult()),
      preflight: broken, // would abort if it were ever consulted
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1);
    assert.equal(ran.length, 3);
    assert.equal(probeCount(), 0, 'a bad test file is not an environment question');
  });
});

test('cmdSuite: a reset that fails on a broken box aborts BEFORE the test runs', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let resets = 0;
    const { deps, ran } = harness({
      files: 3,
      reset: () => {
        if (++resets === 2) throw envError("'idb' was not found on PATH.");
      },
      preflight: broken,
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 3);
    assert.deepEqual(ran, ['01-t.md'], 'the second test never ran');
    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    // notRun INCLUDES the current file: its reset failed, so it has no row.
    assert.deepEqual(suite.aborted?.notRun, ['02-t.md', '03-t.md']);
    assert.equal(suite.tests.length, 1);
    assert.match(suite.aborted?.reason ?? '', /reset failed/);
  });
});

test('cmdSuite: a reset that fails on a HEALTHY box just continues', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let resets = 0;
    const { deps, ran } = harness({
      files: 3,
      reset: () => {
        if (++resets === 2) throw envError('transient');
      },
      preflight: healthy,
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 0);
    assert.equal(ran.length, 3);
  });
});

test('cmdSuite: with no preflight wired, an env failure keeps the old continue-on-failure behaviour', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran } = harness({ files: 3, onTest: (n) => (n === 2 ? envFailedRun() : aiResult()) });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1);
    assert.equal(ran.length, 3);
  });
});

test('cmdSuite: an aborted suite still writes index.json and index.html', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps } = harness({ files: 3, onTest: () => envFailedRun(), preflight: broken });
    await cmdSuite(dir, {}, deps);
    const outDir = join(root, '.verikun', 'suites');
    const suiteOut = join(outDir, readdirSync(outDir)[0]);
    assert.ok(readFileSync(join(suiteOut, 'index.json'), 'utf8').length > 0);
    assert.match(readFileSync(join(suiteOut, 'index.html'), 'utf8'), /Suite aborted/);
  });
});

// --- cmdSuite: --retries (flake recovery) -----------------------------------

test('cmdSuite: --retries recovers a flake — exit 0, warning, prior attempt kept', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    const { deps, ran } = harness({
      files: 2,
      onTest: () => {
        const file = ran[ran.length - 1];
        if (file === '01-t.md') {
          const attempt = ran.filter((f) => f === '01-t.md').length;
          if (attempt === 1) {
            return aiResult({
              ok: false,
              runDir: '/tmp/.verikun/runs/flake-fail',
              failure: { where: 'steps[1]', reason: 'transient assert' },
            });
          }
          return aiResult({ ok: true, runDir: '/tmp/.verikun/runs/flake-pass' });
        }
        return aiResult({ runDir: '/tmp/.verikun/runs/other' });
      },
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, { retries: '1' }, deps);
    assert.equal(code, 0, 'recovered flake must not fail the suite');
    assert.deepEqual(ran, ['01-t.md', '01-t.md', '02-t.md'], 'failed test re-run once');

    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    assert.equal(suite.totals.failed, 0);
    assert.equal(suite.totals.passed, 2);
    const flaky = suite.tests.find((t) => t.file === '01-t.md')!;
    assert.equal(flaky.ok, true);
    assert.equal(flaky.flaky, true);
    assert.equal(flaky.id, 'flake-pass');
    assert.equal(flaky.attempts?.length, 1);
    assert.equal(flaky.attempts![0].id, 'flake-fail');
    assert.ok(suite.warnings?.some((w) => /01-t\.md/.test(w) && /retry/.test(w)));
    const html = readFileSync(join(outDir, readdirSync(outDir)[0], 'index.html'), 'utf8');
    assert.match(html, /FLAKY/);
    assert.match(html, /flake-fail/);
    assert.match(html, /Warnings/);
  });
});

test('cmdSuite: --retries exhausted still exits 1 and keeps all attempt evidence', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    let n = 0;
    const { deps, ran } = harness({
      files: 1,
      onTest: () => {
        n++;
        return aiResult({
          ok: false,
          runDir: `/tmp/.verikun/runs/fail-${n}`,
          failure: { where: 'steps[1]', reason: `fail #${n}` },
        });
      },
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, { retries: '2' }, deps);
    assert.equal(code, 1);
    assert.equal(ran.length, 3, 'initial + 2 retries');
    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    const t = suite.tests[0];
    assert.equal(t.ok, false);
    assert.equal(t.flaky, undefined);
    assert.equal(t.id, 'fail-3');
    assert.equal(t.attempts?.length, 2);
    assert.equal(t.attempts![0].id, 'fail-1');
    assert.equal(t.attempts![1].id, 'fail-2');
    assert.equal(suite.warnings, undefined);
  });
});

test('cmdSuite: --retries spends its attempts on a confirmed env break before aborting', async () => {
  // The probe window is a couple of seconds — shorter than a server restart or a wifi
  // drop. With attempts left, riding it out costs one test; giving up costs the suite.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran } = harness({
      files: 3,
      onTest: () => (ran[ran.length - 1] === '01-t.md' ? envFailedRun() : aiResult()),
      preflight: broken,
    });
    const code = await cmdSuite(dir, { retries: '2' }, deps);
    assert.equal(code, 3, 'still an environment abort, just a later one');
    assert.deepEqual(ran, ['01-t.md', '01-t.md', '01-t.md'], 'initial + 2 retries, then abort');
  });
});

test('cmdSuite: --retries rides out an env break that clears — the suite carries on', async () => {
  // The `--server` case: the network wobbles for longer than the probe window, then
  // comes back. Aborting there would mean rerunning every test that already passed.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    // Both probes fail (so the break is CONFIRMED, not a blip), then the server is back
    // by the time the retry runs.
    let brokenProbes = 2;
    const { deps, ran } = harness({
      files: 2,
      onTest: (n) => (n === 1 ? envFailedRun() : aiResult()),
      preflight: () => {
        if (brokenProbes-- > 0) throw envError('cannot reach verikun server at http://host:4400 (fetch failed)');
      },
    });
    const outDir = join(root, '.verikun', 'suites');
    const code = await cmdSuite(dir, { retries: '1' }, deps);
    assert.equal(code, 0, 'the outage never became a suite failure');
    assert.deepEqual(ran, ['01-t.md', '01-t.md', '02-t.md']);
    const suite = readManifest(join(outDir, readdirSync(outDir)[0]));
    assert.ok(
      suite.warnings?.some((w) => /environment error on attempt 1/.test(w) && /retried/.test(w)),
      'the outage is visible as a warning, not silently swallowed',
    );
  });
});

test('cmdSuite: --retries does not retry a usage error — a rerun cannot change it', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    const { deps, ran, probeCount } = harness({
      files: 2,
      onTest: () => (ran[ran.length - 1] === '01-t.md' ? usageError("suite: cannot read '01-t.md'") : aiResult()),
      preflight: broken, // never consulted: a usage error is not an environment question
    });
    const code = await cmdSuite(dir, { retries: '3' }, deps);
    assert.equal(code, 1, 'a failed row, not an abort');
    assert.deepEqual(ran, ['01-t.md', '02-t.md'], 'the unreadable file is attempted once');
    assert.equal(probeCount(), 0);
  });
});

test('cmdSuite: --retries does not retry a budget abort', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    const { deps, ran } = harness({
      files: 1,
      onTest: () => aiResult({ ok: false, abortedForBudget: true, failure: undefined, runDir: '/tmp/runs/budget' }),
    });
    const code = await cmdSuite(dir, { retries: '2' }, deps);
    assert.equal(code, 1);
    assert.equal(ran.length, 1, 'budget abort is not a flake');
  });
});

test('cmdSuite: --retries retries a thrown non-env error when retries remain', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    let throws = 0;
    const { deps, ran, probeCount } = harness({
      files: 2,
      onTest: () => {
        const file = ran[ran.length - 1];
        if (file === '01-t.md' && throws++ === 0) return new Error('could not read the test file');
        return aiResult();
      },
      preflight: broken, // would abort if thrown errors were treated as retryable env blips
    });
    const code = await cmdSuite(dir, { retries: '3' }, deps);
    assert.equal(code, 0);
    assert.deepEqual(ran, ['01-t.md', '01-t.md', '02-t.md'], 'the thrown failure is retried before the suite moves on');
    assert.equal(probeCount(), 0, 'non-env throws are retried without re-probing the device');
  });
});

test('cmdSuite: --retries resets the app between attempts when --app reset is wired', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    let resets = 0;
    let n = 0;
    const { deps } = harness({
      files: 1,
      reset: () => {
        resets++;
      },
      onTest: () => {
        n++;
        return n === 1
          ? aiResult({ ok: false, runDir: '/tmp/runs/a', failure: { where: 's', reason: 'x' } })
          : aiResult({ ok: true, runDir: '/tmp/runs/b' });
      },
    });
    const code = await cmdSuite(dir, { retries: '1' }, deps);
    assert.equal(code, 0);
    assert.equal(resets, 2, 'once before the test, once before the retry');
  });
});

test('cmdSuite: rejects a negative --retries', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    const { deps } = harness({ files: 1 });
    await assert.rejects(() => cmdSuite(dir, { retries: '-1' }, deps), /non-negative integer/);
  });
});

// --- orderTests -------------------------------------------------------------

test('orderTests: longest known first, unknowns ahead of everything', () => {
  // An unknown might BE the long one, and starting it early is the only bound
  // available — putting it last is how a newly added 13-minute flow defines the finish.
  const files = ['a.md', 'b.md', 'c.md', 'new.md'];
  const hints = { 'a.md': 100, 'b.md': 800, 'c.md': 400 };
  assert.deepEqual(orderTests(files, hints), ['new.md', 'b.md', 'c.md', 'a.md']);
});

test('orderTests: with no hints at all it degenerates to file order', () => {
  const files = ['01-a.md', '02-b.md', '03-c.md'];
  assert.deepEqual(orderTests(files, {}), files);
});

test('orderTests: equal durations tie-break by name, so the order is deterministic', () => {
  assert.deepEqual(orderTests(['b.md', 'a.md'], { 'a.md': 500, 'b.md': 500 }), ['a.md', 'b.md']);
});

test('orderTests: a zero or non-numeric hint counts as unknown', () => {
  const order = orderTests(['a.md', 'b.md'], { 'a.md': 0, 'b.md': 300 });
  assert.deepEqual(order, ['a.md', 'b.md']);
});

// --- readDurationHints ------------------------------------------------------

function writeSuiteManifest(suitesDir: string, id: string, suite: Partial<SuiteRun>): void {
  mkdirSync(join(suitesDir, id), { recursive: true });
  writeFileSync(join(suitesDir, id, 'index.json'), JSON.stringify({ name: 'tests', tests: [], ...suite }));
}

test('readDurationHints: takes the most recent run of the SAME suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-hints-'));
  try {
    writeSuiteManifest(root, '20260101-100000', {
      name: 'tests',
      tests: [{ file: 'a.md', durationMs: 111 }] as SuiteRun['tests'],
    });
    writeSuiteManifest(root, '20260202-100000', {
      name: 'tests',
      tests: [{ file: 'a.md', durationMs: 222 }] as SuiteRun['tests'],
    });
    // A different suite in the same store must not contribute.
    writeSuiteManifest(root, '20260303-100000', {
      name: 'other',
      tests: [{ file: 'a.md', durationMs: 999 }] as SuiteRun['tests'],
    });
    assert.deepEqual(readDurationHints(root, 'tests'), { 'a.md': 222 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readDurationHints: no store, junk manifests and missing files all mean "no hints"', () => {
  assert.deepEqual(readDurationHints(join(tmpdir(), 'vk-does-not-exist-4a1f'), 'tests'), {});
  const root = mkdtempSync(join(tmpdir(), 'vk-hints-'));
  try {
    mkdirSync(join(root, 'empty-dir'), { recursive: true });
    writeSuiteManifest(root, 'junk', {});
    writeFileSync(join(root, 'junk', 'index.json'), 'not json at all');
    assert.deepEqual(readDurationHints(root, 'tests'), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- laneCount --------------------------------------------------------------

test('laneCount: bounded by the pool, the test count, and --concurrency', () => {
  assert.equal(laneCount(3, 7, {}), 3);
  assert.equal(laneCount(3, 2, {}), 2, 'a lane with nothing to run only pads the report');
  assert.equal(laneCount(3, 7, { concurrency: '2' }), 2);
  assert.equal(laneCount(3, 7, { concurrency: '9' }), 3, 'never more than the pool');
  assert.equal(laneCount(1, 5, {}), 1);
});

test('laneCount: a non-positive or fractional --concurrency is a usage error', () => {
  for (const bad of ['0', '-1', '1.5']) {
    assert.throws(
      () => laneCount(3, 7, { concurrency: bad }),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  }
});

// --- cmdSuite across a pool -------------------------------------------------

const LANES: Lane[] = [
  { id: 'l1', label: 'device-a', device: 'device-a' },
  { id: 'l2', label: 'device-b', device: 'device-b' },
];

interface PoolOpts {
  lanes?: Lane[];
  /** Per-file result, keyed on the file's basename. */
  onTest?: (file: string, lane: Lane) => AiRunResult | Error;
  delayMs?: number;
  preflight?: (lane: Lane) => void;
}

/** A pool harness that records who ran what, and how many ran at once. */
function poolHarness(o: PoolOpts = {}) {
  const byLane = new Map<string, string[]>();
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: SuiteDeps = {
    platform: 'android',
    lanes: o.lanes ?? LANES,
    probeRetryMs: 0,
    runTest: async (file, lane) => {
      const name = basename(file);
      byLane.set(lane.id, [...(byLane.get(lane.id) ?? []), name]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        const r = o.onTest?.(name, lane) ?? aiResult({ device: lane.device });
        if (r instanceof Error) throw r;
        return { ...r, device: r.device ?? lane.device };
      } finally {
        inFlight -= 1;
      }
    },
    ...(o.preflight ? { preflight: (lane: Lane) => o.preflight!(lane) } : {}),
  };
  return { deps, byLane, maxInFlight: () => maxInFlight };
}

test('cmdSuite: a pool runs every test exactly once, spread across the devices', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 6);
    const { deps, byLane, maxInFlight } = poolHarness({ delayMs: 20 });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 0);
    const all = [...byLane.values()].flat().sort();
    assert.equal(all.length, 6, 'no test runs twice, none is dropped');
    assert.equal(new Set(all).size, 6);
    assert.equal(maxInFlight(), 2, 'both devices are genuinely busy at the same time');
    assert.equal(byLane.size, 2, 'both lanes drew work');
  });
});

test('cmdSuite: the manifest separates wall-clock from device time, and names the device per row', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    const { deps } = poolHarness({ delayMs: 40 });
    const suites = join(root, '.verikun', 'suites');
    await cmdSuite(dir, {}, deps);
    const suite = readManifest(join(suites, readdirSync(suites)[0]));
    assert.equal(suite.concurrency, 2);
    assert.ok(suite.totals.wallClockMs !== undefined);
    assert.ok(
      suite.totals.wallClockMs! < suite.totals.durationMs,
      `wall ${suite.totals.wallClockMs} should be below device time ${suite.totals.durationMs}`,
    );
    for (const t of suite.tests) assert.ok(t.device === 'device-a' || t.device === 'device-b', `row ${t.file} has no device`);
    // Rows are file-ordered regardless of who finished first, so two runs compare.
    assert.deepEqual(suite.tests.map((t) => t.file), ['01-t.md', '02-t.md', '03-t.md', '04-t.md']);
  });
});

test('cmdSuite: --concurrency 1 collapses a pool back to one device at a time', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    const { deps, maxInFlight } = poolHarness({ delayMs: 10 });
    const code = await cmdSuite(dir, { concurrency: '1' }, deps);
    assert.equal(code, 0);
    assert.equal(maxInFlight(), 1);
  });
});

test('cmdSuite: a broken device retires its lane and the others finish the work', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 6);
    // device-a is dead: every test routed to it aborts for the environment.
    const { deps, byLane } = poolHarness({
      onTest: (_file, lane) => (lane.id === 'l1' ? envFailedRun() : aiResult({ device: lane.device })),
      preflight: (lane) => {
        if (lane.id === 'l1') throw envError('device-a is gone');
      },
    });
    const code = await cmdSuite(dir, {}, deps);
    // The suite still ran to completion on the surviving device.
    assert.equal(code, 1, 'the tests device-a already failed stay failed');
    const ranOnB = byLane.get('l2') ?? [];
    assert.ok(ranOnB.length >= 5, `device-b should have absorbed the rest, got ${ranOnB.length}`);
    assert.equal((byLane.get('l1') ?? []).length, 1, 'device-a is retired after its first confirmed break');
  });
});

test('cmdSuite: when every lane retires the suite aborts (exit 3) and names what did not run', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 6);
    const { deps } = poolHarness({
      onTest: () => envFailedRun(),
      preflight: () => {
        throw envError('the whole box is gone');
      },
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 3);
  });
});

test('cmdSuite: a lane that dies before producing a row hands its file back to the pool', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let firstResetOnA = true;
    const lanes = LANES;
    const attempted: string[] = [];
    const deps: SuiteDeps = {
      platform: 'android',
      lanes,
      probeRetryMs: 0,
      // The reset fails only on device-a, and only the once — so its file never ran.
      reset: (lane) => {
        if (lane!.id === 'l1' && firstResetOnA) {
          firstResetOnA = false;
          throw envError('device-a vanished during reset');
        }
      },
      runTest: async (file, lane) => {
        attempted.push(basename(file));
        return aiResult({ device: lane!.device });
      },
      preflight: (lane) => {
        if (lane!.id === 'l1') throw envError('device-a is gone');
      },
    };
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 0, 'device-b covered everything');
    assert.deepEqual(attempted.sort(), ['01-t.md', '02-t.md', '03-t.md'], 'the requeued file still ran');
  });
});

test('cmdSuite: --max-suite-cost-usd stops dequeuing and exits 1, not 3', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 8);
    const { deps, byLane } = poolHarness({
      onTest: (_f, lane) => aiResult({ costUsd: 0.5, device: lane.device }),
    });
    const code = await cmdSuite(dir, { 'max-suite-cost-usd': '1' }, deps);
    // The box is fine; the run just did not finish — exit 1 mirrors `vk ai --max-cost-usd`.
    assert.equal(code, 1);
    const ran = [...byLane.values()].flat();
    assert.ok(ran.length < 8, `should have stopped early, ran ${ran.length}`);
  });
});

test('cmdSuite: --max-suite-cost-usd must be positive', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    const { deps } = poolHarness();
    await assert.rejects(
      () => cmdSuite(dir, { 'max-suite-cost-usd': '0' }, deps),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  });
});

test('cmdSuite: a pool retires a lane after repeated env failures even when the probe says fine', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 6);
    // The shape of one dead device behind a HEALTHY pooled server: the probe can only
    // ask whether the server answers, so without this backstop device-a would keep
    // drawing work and failing it for the whole suite.
    const { deps, byLane } = poolHarness({
      onTest: (_file, lane) => (lane.id === 'l1' ? envFailedRun() : aiResult({ device: lane.device })),
      preflight: () => {},
    });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1);
    assert.equal((byLane.get('l1') ?? []).length, 2, 'retired at the streak limit, not after every test');
    assert.ok((byLane.get('l2') ?? []).length >= 4);
  });
});

test('cmdSuite: the serial path keeps its old tolerance for repeated env blips', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    // Same signal as above with ONE lane: retiring early would only lose coverage,
    // since there is nothing to redistribute to. Every test must still be attempted.
    const { deps, ran } = harness({ files: 4, onTest: () => envFailedRun(), preflight: healthy });
    const code = await cmdSuite(dir, {}, deps);
    assert.equal(code, 1);
    assert.deepEqual(ran, ['01-t.md', '02-t.md', '03-t.md', '04-t.md']);
  });
});

test('cmdSuite: only the lanes it actually keeps are claimed', async () => {
  await inTempCwd(async (root) => {
    // Claiming the whole pool up front holds phones that `--concurrency` (or a one-test
    // directory) then throttles away — refusing them to every other job on the host for
    // the suite's lifetime while nothing ever runs on them.
    const dir = suiteDir(root, 4);
    const claimed: string[][] = [];
    const { deps } = poolHarness({ lanes: [...LANES, { id: 'l3', label: 'device-c', device: 'device-c' }] });
    await cmdSuite(dir, { concurrency: '2' }, { ...deps, claimLanes: (used) => { claimed.push(used.map((l) => l.device!)); return used; } });
    assert.deepEqual(claimed, [['device-a', 'device-b']], 'device-c was never used, so it is never held');
  });
});

test('cmdSuite: a usage error from a lane is not retried', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    let attempts = 0;
    const { deps } = poolHarness({
      onTest: () => {
        attempts += 1;
        return aiResult({ ok: false, usageError: true, failure: { where: 'run', reason: 'unknown flag' } });
      },
    });
    const code = await cmdSuite(dir, { retries: '3' }, deps);
    assert.equal(code, 1);
    assert.equal(attempts, 1, 'a rerun provably cannot change a usage error');
  });
});

// --- a pool behind ONE vk server: lanes are slots, the server deals the phones (#147) ---
//
// Over `--server` a lane is a concurrency slot, not a device: every dispatch is a `vk ai`
// child that leases whichever phone is free. When a phone leaves the pool the suite has more
// slots than phones, and the slot that lost its phone must WAIT — never fail tests that never
// got a device, never burn their retries, never retire. These stand in for the server and
// its children; outcomes are built by the REAL `laneResult` from the documents a child
// prints, so the suite sees exactly what production feeds it.

const SERVER = 'http://srv:8391';
const SLOTS: Lane[] = [
  { id: 's1', label: 'srv:8391#1', server: SERVER },
  { id: 's2', label: 'srv:8391#2', server: SERVER },
];

type Outcome = 'pass' | 'fail' | 'evict';
interface PoolCtl {
  shed(phone: string, why?: string): void;
  readmit(phone: string): void;
  /** A run OUTSIDE this suite takes (and later gives back) a phone. */
  hold(phone: string): void;
  release(phone: string): void;
}

function serverPool(o: {
  /** Phones each server serves at the start. Default: one server with `a` and `b`. */
  servers?: Record<string, string[]>;
  /** Phones already ruled out at the start (they left before the suite began). */
  ruledOut?: Record<string, string>;
  lanes?: Lane[];
  /** What a dispatch that GOT a phone does. Default: pass. */
  script?: (x: { file: string; lane: Lane; phone: string; pool: PoolCtl }) => Outcome;
  /** Wire `serverSlots` from the fake's own truth — the production shape. */
  gated?: boolean;
  deviceWaitMs?: number;
  delayMs?: number;
  /** Per-dispatch run time, when one phone must be slower than another. */
  delay?: (phone: string) => number;
}) {
  const servers = o.servers ?? { [SERVER]: ['a', 'b'] };
  const serving = new Map(Object.entries(servers).map(([url, phones]) => [url, new Set(phones)]));
  const ruledOut = new Map(Object.entries(o.ruledOut ?? {}));
  const held = new Set<string>();
  const ran: Array<{ file: string; lane: string; phone: string; outcome: Outcome }> = [];
  let refused = 0;
  let maxLeased = 0;
  let slotCalls = 0;
  const pool: PoolCtl = {
    shed(phone, why = 'the device is not attached') {
      for (const set of serving.values()) set.delete(phone);
      ruledOut.set(phone, why);
    },
    readmit(phone) {
      ruledOut.delete(phone);
      const [first] = serving.values();
      first.add(phone);
    },
    hold: (phone) => void held.add(phone),
    release: (phone) => void held.delete(phone),
  };
  const note = (url: string): string => {
    const phones = [...(serving.get(url) ?? [])];
    const out = [...ruledOut].map(([p, why]) => `${p} (${why})`).join(', ');
    return `pool: ${phones.length} serving (${phones.join(', ')})${out ? `; ruled out: ${out}` : ''}`;
  };
  const deps: SuiteDeps = {
    platform: 'android',
    lanes: o.lanes ?? SLOTS,
    probeRetryMs: 0,
    deviceWaitMs: o.deviceWaitMs ?? 5_000,
    // The server answers, which is exactly why the old probe called every refusal a blip.
    preflight: () => {},
    runTest: async (file, lane) => {
      const url = lane.server!;
      const phone = [...(serving.get(url) ?? [])].find((p) => !held.has(p));
      if (!phone) {
        refused += 1;
        return laneResult(
          3,
          {
            error: `verikun server device is busy (409): all devices are leased by other active runs. [${note(url)}]`,
            exitCode: 3,
            errorKind: 'NoFreeDeviceError',
          },
          '',
          lane,
        );
      }
      held.add(phone);
      maxLeased = Math.max(maxLeased, held.size);
      try {
        await new Promise((r) => setTimeout(r, o.delay?.(phone) ?? o.delayMs ?? 5));
        const outcome = o.script?.({ file: basename(file), lane, phone, pool }) ?? 'pass';
        ran.push({ file: basename(file), lane: lane.id, phone, outcome });
        if (outcome === 'evict') {
          pool.shed(phone);
          return laneResult(
            3,
            {
              ok: false,
              abortedForEnv: true,
              evicted: true,
              device: phone,
              failure: { where: 'run', reason: `verikun server ended this run (409): this run lost its device (${phone}): ${phone} left the pool` },
            },
            '',
            lane,
          );
        }
        if (outcome === 'fail') {
          return laneResult(1, { ok: false, device: phone, failure: { where: 'steps[0]', reason: 'assert failed' } }, '', lane);
        }
        return laneResult(0, { ok: true, device: phone }, '', lane);
      } finally {
        held.delete(phone);
      }
    },
    ...(o.gated
      ? {
          serverSlots: async (lane: Lane) => {
            slotCalls += 1;
            return { capacity: serving.get(lane.server!)?.size ?? 0, note: note(lane.server!) };
          },
        }
      : {}),
  };
  return { deps, pool, ran, stats: () => ({ refused, maxLeased, slotCalls }) };
}

function lastManifest(root: string): SuiteRun {
  const suites = join(root, '.verikun', 'suites');
  return readManifest(join(suites, readdirSync(suites).sort().pop()!));
}

/** The issue's timeline: the first test dealt phone `a` loses it mid-run; the sweep
 *  readmits `a` after the surviving phone has passed two more tests. */
function issue147Script() {
  let shed = false;
  let passesSince = 0;
  return ({ phone, pool }: { phone: string; pool: PoolCtl }): Outcome => {
    if (!shed && phone === 'a') {
      shed = true;
      return 'evict';
    }
    if (shed && ++passesSince === 2) pool.readmit('a');
    return 'pass';
  };
}

for (const gated of [false, true]) {
  test(`cmdSuite: a phone leaving a pooled server costs no test and no lane (#147, ${gated ? 'gated' : 'ungated'})`, async () => {
    await inTempCwd(async (root) => {
      const dir = suiteDir(root, 6);
      // 30ms tests, so the surviving phone is still busy when the waiting lane next looks
      // after the readmission — otherwise the queue drains first and nothing proves it rejoined.
      const { deps, ran, stats } = serverPool({ script: issue147Script(), gated, delayMs: 30 });
      // --retries 0 on purpose: a phone leaving must not cost a test even with no retries.
      const code = await cmdSuite(dir, {}, deps);
      const suite = lastManifest(root);
      const failed = suite.tests.filter((t) => !t.ok).map((t) => `${t.file}: ${t.failure}`);
      assert.deepEqual(failed, [], 'no test fails for a phone that left');
      assert.equal(code, 0, 'a device blip is not a red gate');
      assert.equal(suite.tests.length, 6, 'every test has exactly one row');
      assert.equal(suite.aborted, undefined);

      const reRun = suite.tests.filter((t) => t.attempts?.length);
      assert.equal(reRun.length, 1, 'only the interrupted test was re-run');
      assert.equal(reRun[0].attempts?.[0].evicted, true, 'the evicted attempt is kept as evidence');
      assert.equal(reRun[0].flaky, undefined, 'a phone leaving is not the test being flaky');

      const warnings = suite.warnings ?? [];
      assert.equal(warnings.some((w) => /retired/.test(w)), false, `no lane is retired: ${warnings.join(' | ')}`);
      assert.ok(warnings.some((w) => /\ba left the pool/.test(w)), `the phone that left is named: ${warnings.join(' | ')}`);
      assert.ok(
        ran.some((r) => r.phone === 'a' && r.outcome === 'pass'),
        'once readmitted, the phone is dealt work again',
      );
      if (gated) {
        // Knowing the capacity, the suite never even asks for a lease it cannot get — a lease
        // request that finds nothing free is what lets the server take over a quiet sibling.
        assert.equal(stats().refused, 0, 'no refused lease was ever requested');
      }
      assert.ok(stats().maxLeased <= 2);
    });
  });
}

test('cmdSuite: a refused lease spends no retry, records no row, and ticks no streak', async () => {
  await inTempCwd(async (root) => {
    // One phone, two slots: the second slot is refused over and over while the first works.
    const dir = suiteDir(root, 4);
    const { deps, stats } = serverPool({ servers: { [SERVER]: ['a'] } });
    const code = await cmdSuite(dir, {}, deps);
    const suite = lastManifest(root);
    assert.equal(code, 0);
    assert.ok(stats().refused > 0, 'the refusals really happened');
    assert.equal(suite.tests.length, 4);
    assert.ok(suite.tests.every((t) => t.ok && !t.attempts), 'each test ran once, green');
    assert.equal((suite.warnings ?? []).some((w) => /retired/.test(w)), false);
  });
});

test('cmdSuite: a retry that is refused goes back to the queue with its first attempt', async () => {
  await inTempCwd(async (root) => {
    // 01 fails once on a real assertion; its retry is refused (the phone is shed at that
    // moment), so the file must travel back WITH that attempt and its remaining retries.
    const dir = suiteDir(root, 2);
    let firstFail = true;
    const { deps, pool } = serverPool({
      servers: { [SERVER]: ['a', 'b'] },
      script: ({ file, phone, pool: p }) => {
        if (file === '01-t.md' && firstFail) {
          firstFail = false;
          p.shed(phone === 'a' ? 'b' : 'a'); // the other phone leaves: no free device for the retry
          setTimeout(() => p.readmit(phone === 'a' ? 'b' : 'a'), 60);
          return 'fail';
        }
        return 'pass';
      },
    });
    void pool;
    const code = await cmdSuite(dir, { retries: '1' }, deps);
    const suite = lastManifest(root);
    const first = suite.tests.find((t) => t.file === '01-t.md')!;
    assert.equal(code, 0);
    assert.equal(first.ok, true);
    assert.equal(first.attempts?.length, 1, 'the real failure is kept');
    assert.equal(first.flaky, true, 'and a real failure that later passed IS a flake');
  });
});

test('cmdSuite: evictions are re-run for free only twice — the third counts', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    let runs = 0;
    const { deps } = serverPool({
      script: ({ phone, pool }) => {
        runs += 1;
        setTimeout(() => pool.readmit(phone), 1); // the phone keeps coming back, and leaving
        return 'evict';
      },
    });
    const code = await cmdSuite(dir, {}, deps);
    const [row] = lastManifest(root).tests;
    assert.equal(runs, 3, 'two free re-runs, then the eviction is an ordinary attempt');
    assert.equal(code, 1);
    assert.equal(row.ok, false);
    assert.equal(row.attempts?.length, 2);
    assert.ok(row.attempts?.every((a) => a.evicted));
  });
});

test('cmdSuite: when NO lane can get a device the suite stops after the wait — exit 3, nothing failed', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps, ran } = serverPool({
      servers: { [SERVER]: [] },
      ruledOut: { a: 'the device is not attached' },
      gated: true,
      deviceWaitMs: 200,
    });
    const t0 = Date.now();
    const code = await cmdSuite(dir, {}, deps);
    const suite = lastManifest(root);
    assert.equal(code, 3, 'the environment, not the app');
    assert.equal(suite.aborted?.kind, 'environment');
    assert.match(suite.aborted?.reason ?? '', /ruled out: a \(the device is not attached\)/);
    assert.deepEqual(suite.aborted?.notRun, ['01-t.md', '02-t.md', '03-t.md'], 'never run, never failed');
    assert.equal(suite.tests.length, 0);
    assert.equal(ran.length, 0, 'no child was spent asking');
    assert.ok(Date.now() - t0 < 3_000, 'bounded by the wait, not by the probe backoff');
  });
});

test('cmdSuite: a zero wait stops at once when blocked, yet still waits while a lane is working', async () => {
  await inTempCwd(async (root) => {
    const blocked = suiteDir(root, 2);
    const stuck = serverPool({ servers: { [SERVER]: [] }, gated: true, deviceWaitMs: 0 });
    const t0 = Date.now();
    assert.equal(await cmdSuite(blocked, {}, stuck.deps), 3);
    assert.ok(Date.now() - t0 < 1_000, 'no waiting at all');
  });
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 6);
    const { deps } = serverPool({ script: issue147Script(), gated: true, deviceWaitMs: 0 });
    assert.equal(await cmdSuite(dir, {}, deps), 0, 'the other lane is working, so this is not "blocked"');
  });
});

test('cmdSuite: a test that ran once and was then refused is a row when the suite stops, not "not run"', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let once = true;
    const { deps } = serverPool({
      servers: { [SERVER]: ['a'] },
      gated: true,
      deviceWaitMs: 150,
      script: ({ phone, pool }) => {
        if (once) {
          once = false;
          pool.shed(phone); // its retry, and everything after, finds no phone at all
          return 'fail';
        }
        return 'pass';
      },
    });
    const code = await cmdSuite(dir, { retries: '1' }, deps);
    const suite = lastManifest(root);
    assert.equal(code, 3);
    assert.equal(suite.tests.length, 1, 'the test that ran has its row');
    assert.equal(suite.tests[0].ok, false);
    assert.match(suite.tests[0].failure ?? '', /assert failed/);
    assert.equal(suite.aborted?.notRun.includes(suite.tests[0].file), false, 'a file is in exactly one list');
    assert.equal(suite.aborted?.notRun.length, 2);
    assert.equal(suite.totals.passed + suite.totals.failed, suite.totals.tests);
  });
});

test('cmdSuite: a lane waiting for a device does not hold the suite open once the work is done', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const { deps } = serverPool({ servers: { [SERVER]: ['a'] }, gated: true, deviceWaitMs: 60_000 });
    const t0 = Date.now();
    assert.equal(await cmdSuite(dir, {}, deps), 0);
    assert.ok(Date.now() - t0 < 2_000, `finished in ${Date.now() - t0}ms, not after the 60s wait`);
  });
});

test('cmdSuite: the device gate is per server — an empty one does not starve the other', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    const A = 'http://a:8391';
    const B = 'http://b:8391';
    const { deps, ran } = serverPool({
      servers: { [A]: [], [B]: ['b1'] },
      lanes: [
        { id: 's1', label: 'a:8391', server: A },
        { id: 's2', label: 'b:8391', server: B },
      ],
      gated: true,
      deviceWaitMs: 60_000,
    });
    assert.equal(await cmdSuite(dir, {}, deps), 0);
    assert.deepEqual(ran.map((r) => r.phone), ['b1', 'b1', 'b1'], 'everything ran on the server that had a phone');
  });
});

test('cmdSuite: local lanes are never gated', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 3);
    let asked = 0;
    const { deps } = poolHarness();
    const code = await cmdSuite(dir, {}, {
      ...deps,
      serverSlots: async () => {
        asked += 1;
        return { capacity: 0, note: 'must never be consulted for a local device' };
      },
    });
    assert.equal(code, 0);
    assert.equal(asked, 0);
  });
});

test('deviceWaitMs: VERIKUN_SUITE_DEVICE_WAIT_MIN in minutes, 0 allowed, junk falls back to 10', () => {
  assert.equal(deviceWaitMs({}), 600_000);
  assert.equal(deviceWaitMs({ VERIKUN_SUITE_DEVICE_WAIT_MIN: '0' }), 0);
  assert.equal(deviceWaitMs({ VERIKUN_SUITE_DEVICE_WAIT_MIN: '2.5' }), 150_000);
  for (const junk of ['abc', '-1', '', ' ']) {
    assert.equal(deviceWaitMs({ VERIKUN_SUITE_DEVICE_WAIT_MIN: junk }), 600_000, `'${junk}'`);
  }
});

/** Everything cmdSuite printed to stderr while `fn` ran. */
async function stderrOf(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

test('cmdSuite: a lane LOOKING for a device prints nothing for a refused look', async () => {
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 2);
    // A job outside this suite holds the only phone, so the gate sees a serving phone, asks,
    // and is refused — over and over — until that job lets go. Each refused look used to print
    // `── (1/2) 01-t.md ──` for a test that never started, measured on hardware.
    const { deps, pool, stats } = serverPool({ servers: { [SERVER]: ['a'] }, lanes: [SLOTS[0]], gated: true, deviceWaitMs: 5_000 });
    pool.hold('a');
    setTimeout(() => pool.release('a'), 250);
    const lines = await stderrOf(() => cmdSuite(dir, {}, deps));
    assert.ok(stats().refused >= 2, `the lane really was refused while it looked (${stats().refused})`);
    const headers = lines.filter((l) => l.includes(' ── ')).map((l) => l.replace(/^.*── /, ''));
    // The first dispatch announces at once — the lane has no reason yet to think it is blocked,
    // and the "no free device … goes back to the queue" line follows it. After that the lane is
    // LOOKING, and a look that is refused says nothing: one more header, when 01 really runs.
    assert.deepEqual(headers, ['(1/2) 01-t.md ──', '(1/2) 01-t.md ──', '(2/2) 02-t.md ──']);
    assert.ok(lines.some((l) => /no free device .* goes back to the queue/.test(l)));
  });
});

test('cmdSuite: a server lane still says "retry k/N" before a retry', async () => {
  // Every pooled `--server` suite is gated, and the gated header was idempotent — so after the
  // first attempt announced itself, a retry's output streamed straight on from the failure's.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    let first = true;
    const { deps } = serverPool({
      gated: true,
      script: () => {
        if (!first) return 'pass';
        first = false;
        return 'fail';
      },
    });
    const lines = await stderrOf(() => cmdSuite(dir, { retries: '1' }, deps));
    assert.ok(lines.some((l) => /retry 1\/1 for 01-t\.md/.test(l)), lines.join('\n'));
  });
});

test('cmdSuite: before giving up, a waiting lane takes one last look', async () => {
  // Backing off toward 30 looks' worth of waiting, a lane's last look before the deadline could
  // be half the wait old — so a phone that came back in between was never seen, and the suite
  // exited 3 saying none had become free.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 1);
    const t0 = Date.now();
    const { deps } = serverPool({ servers: { [SERVER]: ['a'] }, lanes: [SLOTS[0]], deviceWaitMs: 300 });
    const code = await cmdSuite(dir, {}, {
      ...deps,
      // No phone until the wait has run out; from then on, one is free.
      serverSlots: async () => ({ capacity: Date.now() - t0 >= 300 ? 1 : 0, note: 'pool: 0 serving' }),
    });
    assert.equal(code, 0, 'the last look found the phone');
  });
});

test('cmdSuite: a look that ran a test ends the waiting spell, even if its phone then leaves too', async () => {
  // The lane was WORKING while that test ran. Folding it into one long spell counted the test's
  // own run time as waiting, and said nothing when the lane started waiting again.
  await inTempCwd(async (root) => {
    const dir = suiteDir(root, 4);
    let evictions = 0;
    const { deps } = serverPool({
      gated: true,
      // `b` is slow, so the other lane is still busy on it whenever `a` is lost.
      delay: (phone) => (phone === 'b' ? 60 : 5),
      script: ({ phone, pool }) => {
        if (phone !== 'a' || evictions >= 2) return 'pass';
        evictions += 1;
        setTimeout(() => pool.readmit('a'), 30); // the sweep brings it back
        return 'evict';
      },
    });
    const code = await cmdSuite(dir, {}, deps);
    const suite = lastManifest(root);
    assert.equal(code, 0, suite.tests.map((t) => `${t.file}:${t.ok}:${t.failure ?? ''}`).join(' '));
    assert.equal(evictions, 2, 'the phone really left twice');
    const spells = (suite.warnings ?? []).filter((w) => /^srv:8391#1 waited .* for a free device/.test(w));
    assert.equal(spells.length, 2, (suite.warnings ?? []).join(' | '));
  });
});
