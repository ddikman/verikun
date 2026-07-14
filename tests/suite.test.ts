import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sortTestFiles, listTestFiles, toSuiteResult, AiRunResult } from '../src/suite';
import { RunState, RunStep } from '../src/run';

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
