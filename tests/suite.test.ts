import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cmdSuite, sortTestFiles, listTestFiles, toSuiteResult, AiRunResult, SuiteDeps } from '../src/suite';
import { RunState, RunStep } from '../src/run';
import { SuiteRun } from '../src/report';
import { envError } from '../src/errors';

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
