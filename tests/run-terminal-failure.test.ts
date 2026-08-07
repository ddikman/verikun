import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, RunState } from '../src/run';
import { makeEl } from './helpers';

// `vk ai` can fail where no command ran — a `repeat` that exhausts without its
// target, a `when` matching no branch, a budget/timeout abort. Those never go
// through beginStep, so nothing marked the run red and the archived report
// declared a failed test fully green (issue #41). recordTerminalFailure is the
// seam that fixes it; it writes cwd-relative state, so each test runs in a
// throwaway temp dir (node:test runs a file's tests sequentially — chdir is safe).

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-fail-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const loadRun = (): RunState => JSON.parse(readFileSync(join(dir, '.verikun', 'run', 'run.json'), 'utf8')) as RunState;

/** A started run with one green step, i.e. the shape that used to archive green. */
function greenRunWithOneStep(): void {
  Recorder.start('ai: test.md', 'android', 'SERIAL1', true);
  const rec = Recorder.beginStep('tap', ['@x'], {}, 'android', 'SERIAL1', 'SERIAL1');
  assert.ok(rec);
  rec.finish(0);
}

const REPEAT_FAILURE = {
  where: 'steps[24]',
  reason: "repeat stopped after 4 iteration(s) without 'id:target' ever appearing",
  kind: 'fail' as const,
};

test('recordTerminalFailure: appends a red step carrying the where and reason', () => {
  greenRunWithOneStep();
  Recorder.recordTerminalFailure(REPEAT_FAILURE);

  const state = loadRun();
  assert.deepEqual(state.failure, { where: REPEAT_FAILURE.where, reason: REPEAT_FAILURE.reason });
  assert.equal(state.steps.length, 2);
  const last = state.steps[1];
  assert.equal(last.index, 1);
  assert.equal(last.status, 'failed');
  assert.equal(last.exitCode, 1);
  assert.equal(last.message, REPEAT_FAILURE.reason);
  assert.match(last.name, /steps\[24\]/);
});

test('recordTerminalFailure: an environment abort records as an error, not an assertion failure', () => {
  greenRunWithOneStep();
  Recorder.recordTerminalFailure({ where: 'steps[3]', reason: 'adb is gone', kind: 'env' });

  const last = loadRun().steps[1];
  assert.equal(last.status, 'error');
  assert.equal(last.exitCode, 3); // mirrors `vk ai`'s own exit for abortedForEnv
});

test('recordTerminalFailure: evidence lands as a fail screenshot + hierarchy on the step', () => {
  greenRunWithOneStep();
  const png = Buffer.from('not-really-a-png');
  Recorder.recordTerminalFailure(REPEAT_FAILURE, { png, hierarchy: [makeEl({ idShort: 'target_missing' })] });

  const last = loadRun().steps[1];
  assert.equal(last.failImage, 'artifacts/step-1-fail.png');
  assert.deepEqual(readFileSync(join(dir, '.verikun', 'run', last.failImage!)), png);
  assert.match(last.failHierarchy ?? '', /target_missing/);
});

test('recordTerminalFailure: a step that already failed is not double-counted', () => {
  Recorder.start('ai: test.md', 'android', 'SERIAL1', true);
  const rec = Recorder.beginStep('assert', ['@gone'], {}, 'android', 'SERIAL1', 'SERIAL1');
  assert.ok(rec);
  rec.finish(1); // a leaf failure — already red, already its own testcase

  Recorder.recordTerminalFailure({ where: 'steps[0]', reason: 'assert failed', kind: 'fail' });

  const state = loadRun();
  assert.equal(state.steps.length, 1, 'the failure is already recorded; a synthetic step would count it twice');
  assert.deepEqual(state.failure, { where: 'steps[0]', reason: 'assert failed' });
});

test('recordTerminalFailure: no active run is a no-op, not a crash', () => {
  Recorder.recordTerminalFailure(REPEAT_FAILURE);
  // Unlike appendForeignStep, this never auto-starts a run: a terminal failure with
  // no run to attach to has no report to correct, and inventing a one-step run would
  // archive a "test" that never ran. (The empty .verikun/ dir is artifactDir()'s
  // doing — every path that reads run state creates it.)
  assert.ok(!existsSync(join(dir, '.verikun', 'run', 'run.json')));
});

test('recordTerminalFailure: VERIKUN_NO_RUN disables it like every other recording path', () => {
  greenRunWithOneStep();
  process.env.VERIKUN_NO_RUN = '1';
  try {
    Recorder.recordTerminalFailure(REPEAT_FAILURE);
  } finally {
    delete process.env.VERIKUN_NO_RUN;
  }
  const state = loadRun();
  assert.equal(state.steps.length, 1);
  assert.equal(state.failure, undefined);
});
