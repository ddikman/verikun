import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, RunState } from '../src/run';
import { parseSelector } from '../src/ui/selector';
import { makeEl } from './helpers';

// The remote-recording seam: `vk server` records each command into an EPHEMERAL
// single-step recorder (never touching ./.verikun), and the calling verikun
// splices the returned step + artifacts into its own active run via
// appendForeignStep. Both write cwd-relative state, so each test runs in a
// throwaway temp dir (node:test runs a file's tests sequentially — chdir is safe).

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-run-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const runJsonPath = () => join(dir, '.verikun', 'run', 'run.json');
const loadRun = (): RunState => JSON.parse(readFileSync(runJsonPath(), 'utf8')) as RunState;

// --- ephemeral recorder -----------------------------------------------------

test('beginEphemeralStep: records a full step in memory and never touches disk', () => {
  const rec = Recorder.beginEphemeralStep('tap', ['@login'], {}, 'android', 'SERIAL1');
  rec.note({ selector: parseSelector('@login'), tier: 'partial', element: makeEl({ idShort: 'login', text: 'Log in' }) });
  rec.finish(0);
  const { step, artifacts } = rec.takeEphemeral();

  assert.equal(step.name, 'tap @login');
  assert.equal(step.status, 'passed');
  assert.equal(step.selector?.raw, '@login');
  assert.equal(step.tier, 'partial');
  assert.equal(step.resolved?.idShort, 'login');
  assert.deepEqual(artifacts, {});
  assert.ok(!existsSync(join(dir, '.verikun')), 'ephemeral mode must not create ./.verikun');
});

test('beginEphemeralStep: artifacts (screenshots) land in the sink, not on disk', () => {
  const rec = Recorder.beginEphemeralStep('screenshot', [], {}, 'android');
  const png = Buffer.from('not-really-a-png');
  rec.attachImage(png);
  rec.finish(0);
  const { step, artifacts } = rec.takeEphemeral();

  assert.equal(step.image, 'artifacts/step-0-screenshot.png');
  assert.deepEqual(artifacts['artifacts/step-0-screenshot.png'], png);
  assert.ok(!existsSync(join(dir, '.verikun')));
});

test('beginEphemeralStep: a thrown failure is captured as a failed step', () => {
  const rec = Recorder.beginEphemeralStep('assert', ['@gone'], {}, 'android');
  rec.finishError(Object.assign(new Error('nope'), { exitCode: 1 }) as Error);
  const { step } = rec.takeEphemeral();
  assert.equal(step.status, 'error'); // a plain Error maps to error (exit 3), like local recording
  assert.equal(step.message, 'nope');
});

// --- appendForeignStep ------------------------------------------------------

test('appendForeignStep: auto-starts an implicit run and re-indexes each step', () => {
  const make = (name: string) => {
    const rec = Recorder.beginEphemeralStep('tap', [name], {}, 'android', 'SERIAL1');
    rec.finish(0);
    return rec.takeEphemeral();
  };

  const a = make('@first');
  Recorder.appendForeignStep(a.step, a.artifacts, { platform: 'android', device: 'SERIAL1' });
  const b = make('@second');
  Recorder.appendForeignStep(b.step, b.artifacts, { platform: 'android', device: 'SERIAL1' });

  const state = loadRun();
  assert.equal(state.steps.length, 2);
  assert.equal(state.steps[0].index, 0);
  assert.equal(state.steps[1].index, 1);
  assert.equal(state.steps[1].name, 'tap @second');
  assert.equal(state.device, 'SERIAL1');
  assert.equal(state.implicit, true);
});

test('appendForeignStep: rewrites artifact paths to the new index and writes the bytes', () => {
  // Server-side both steps are index 0; locally the second must become step 1.
  const rec1 = Recorder.beginEphemeralStep('screenshot', [], {}, 'android');
  rec1.attachImage(Buffer.from('one'));
  rec1.finish(0);
  const e1 = rec1.takeEphemeral();
  Recorder.appendForeignStep(e1.step, e1.artifacts);

  const rec2 = Recorder.beginEphemeralStep('screenshot', [], {}, 'android');
  rec2.attachImage(Buffer.from('two'));
  rec2.finish(0);
  const e2 = rec2.takeEphemeral();
  Recorder.appendForeignStep(e2.step, e2.artifacts);

  const state = loadRun();
  assert.equal(state.steps[1].image, 'artifacts/step-1-screenshot.png');
  const bytes = readFileSync(join(dir, '.verikun', 'run', 'artifacts', 'step-1-screenshot.png'), 'utf8');
  assert.equal(bytes, 'two');
});

test('appendForeignStep: rejects artifact paths that could escape artifacts/', () => {
  const rec = Recorder.beginEphemeralStep('screenshot', [], {}, 'android');
  rec.finish(0);
  const { step } = rec.takeEphemeral();
  Recorder.appendForeignStep(step, { 'artifacts/../../evil.png': Buffer.from('x') });
  assert.ok(!existsSync(join(dir, 'evil.png')), 'traversal path must be skipped');
  assert.equal(loadRun().steps.length, 1, 'the step itself still records');
});

test('appendForeignStep: VERIKUN_NO_RUN disables it like local recording', () => {
  process.env.VERIKUN_NO_RUN = '1';
  try {
    const rec = Recorder.beginEphemeralStep('tap', ['@x'], {}, 'android');
    rec.finish(0);
    const { step } = rec.takeEphemeral();
    Recorder.appendForeignStep(step, {});
    assert.ok(!existsSync(runJsonPath()));
  } finally {
    delete process.env.VERIKUN_NO_RUN;
  }
});
