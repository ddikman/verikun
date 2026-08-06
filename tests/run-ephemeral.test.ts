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

test('appendForeignStep: records server logStart on the first splice', () => {
  const rec = Recorder.beginEphemeralStep('tap', ['@x'], {}, 'android', 'SERIAL1');
  rec.finish(0);
  const { step, artifacts } = rec.takeEphemeral();
  Recorder.appendForeignStep(step, artifacts, {
    platform: 'android',
    device: 'SERIAL1',
    logStart: '08-06 12:00:00.000',
  });
  assert.equal(loadRun().logStart, '08-06 12:00:00.000');

  // A later step must not overwrite the run's original marker.
  const rec2 = Recorder.beginEphemeralStep('tap', ['@y'], {}, 'android', 'SERIAL1');
  rec2.finish(0);
  const e2 = rec2.takeEphemeral();
  Recorder.appendForeignStep(e2.step, e2.artifacts, { logStart: '08-06 12:05:00.000' });
  assert.equal(loadRun().logStart, '08-06 12:00:00.000');
});

// --- archive-time logcat artifact -----------------------------------------

test('archive: fetchLogs writes artifacts/logcat.txt and sets logFile', () => {
  Recorder.start('probe', 'android', 'SERIAL1', true);
  const rec = Recorder.beginEphemeralStep('screenshot', [], {}, 'android');
  rec.finish(0);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {});

  const calls: { since?: string; lines?: number; appId?: string; scopedOnly?: boolean }[] = [];
  const sealed = Recorder.archive(undefined, {
    fetchLogs: (opts) => {
      calls.push(opts);
      return '08-06 12:00:01.000 I ActivityManager: hello from logcat';
    },
  });

  // No launch in the run → full dump only (no app-scoped second fetch).
  assert.equal(calls.length, 1);
  assert.equal(sealed.state.logFile, 'artifacts/logcat.txt');
  assert.equal(sealed.state.appLogFile, undefined);
  const logPath = join(sealed.dir, 'artifacts', 'logcat.txt');
  assert.ok(existsSync(logPath));
  assert.ok(readFileSync(logPath, 'utf8').includes('ActivityManager'));
  const runJson = JSON.parse(readFileSync(join(sealed.dir, 'run.json'), 'utf8')) as RunState;
  assert.equal(runJson.logFile, 'artifacts/logcat.txt');
  // The log body must NOT be inlined into run.json (that was the whole point).
  assert.ok(!JSON.stringify(runJson).includes('ActivityManager'));
  // Accordion is app-scoped — absent without an appId.
  assert.ok(!readFileSync(join(sealed.dir, 'report.html'), 'utf8').includes('class="run-log"'));
});

test('archive: with a launch step, also writes app-scoped logcat-app.txt into the accordion', () => {
  Recorder.start('with-app', 'android', 'SERIAL1', true);
  const launch = Recorder.beginEphemeralStep('launch', ['dev.verikun.testapp'], {}, 'android');
  launch.finish(0);
  Recorder.appendForeignStep(launch.takeEphemeral().step, {});

  const calls: { appId?: string; scopedOnly?: boolean }[] = [];
  const sealed = Recorder.archive(undefined, {
    fetchLogs: (opts) => {
      calls.push(opts);
      if (opts.appId) return 'I flutter: app only';
      return 'I ActivityManager: full device';
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.some((c) => !c.appId));
  assert.ok(calls.some((c) => c.appId === 'dev.verikun.testapp' && c.scopedOnly === true));
  assert.equal(sealed.state.logFile, 'artifacts/logcat.txt');
  assert.equal(sealed.state.appLogFile, 'artifacts/logcat-app.txt');
  assert.equal(sealed.state.appId, 'dev.verikun.testapp');
  assert.equal(readFileSync(join(sealed.dir, 'artifacts', 'logcat.txt'), 'utf8'), 'I ActivityManager: full device');
  assert.equal(readFileSync(join(sealed.dir, 'artifacts', 'logcat-app.txt'), 'utf8'), 'I flutter: app only');
  const html = readFileSync(join(sealed.dir, 'report.html'), 'utf8');
  assert.ok(html.includes('App log for dev.verikun.testapp'));
  assert.ok(html.includes('I flutter: app only'));
  assert.ok(!html.includes('I ActivityManager: full device'), 'full dump stays out of the accordion');
});

test('archive: --no-logs skips a green run', () => {
  Recorder.start('green', 'android', undefined, true);
  const rec = Recorder.beginEphemeralStep('tap', ['@ok'], {}, 'android');
  rec.finish(0);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {});

  let fetched = 0;
  const sealed = Recorder.archive(undefined, {
    noLogs: true,
    fetchLogs: () => {
      fetched++;
      return 'should-not-appear';
    },
  });
  assert.equal(fetched, 0);
  assert.equal(sealed.state.logFile, undefined);
  assert.ok(!existsSync(join(sealed.dir, 'artifacts', 'logcat.txt')));
});

test('archive: failures still capture even with --no-logs', () => {
  Recorder.start('red', 'android', undefined, true);
  const rec = Recorder.beginEphemeralStep('assert', ['@gone'], {}, 'android');
  rec.finish(1);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {});

  const sealed = Recorder.archive(undefined, {
    noLogs: true,
    fetchLogs: () => 'FAIL TRACE',
  });
  assert.equal(sealed.state.logFile, 'artifacts/logcat.txt');
  assert.equal(readFileSync(join(sealed.dir, 'artifacts', 'logcat.txt'), 'utf8'), 'FAIL TRACE');
});

test('archive: a throwing fetchLogs never derails sealing', () => {
  Recorder.start('broken-device', 'android', undefined, true);
  const rec = Recorder.beginEphemeralStep('tap', ['@x'], {}, 'android');
  rec.finish(0);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {});

  const sealed = Recorder.archive(undefined, {
    fetchLogs: () => {
      throw new Error('device gone');
    },
  });
  assert.ok(existsSync(join(sealed.dir, 'report.html')));
  assert.equal(sealed.state.logFile, undefined);
});

test('attachArchiveLogs: pre-seeds logFile so archive skips the full fetch', () => {
  Recorder.start('pre', 'android', undefined, true);
  const rec = Recorder.beginEphemeralStep('tap', ['@x'], {}, 'android');
  rec.finish(0);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {});
  Recorder.attachArchiveLogs('prefetched remote logcat');

  let fetched = 0;
  const sealed = Recorder.archive(undefined, {
    fetchLogs: () => {
      fetched++;
      return 'should-not-run';
    },
  });
  assert.equal(fetched, 0);
  assert.equal(readFileSync(join(sealed.dir, 'artifacts', 'logcat.txt'), 'utf8'), 'prefetched remote logcat');
});

test('archive: scopes fetchLogs to logStart when present', () => {
  Recorder.start('scoped', 'android', undefined, true);
  const rec = Recorder.beginEphemeralStep('tap', ['@x'], {}, 'android');
  rec.finish(0);
  Recorder.appendForeignStep(rec.takeEphemeral().step, {}, { logStart: '08-06 09:30:00.000' });

  let seen: { since?: string; lines?: number } | undefined;
  Recorder.archive(undefined, {
    fetchLogs: (opts) => {
      seen = opts;
      return 'ok';
    },
  });
  assert.deepEqual(seen, { since: '08-06 09:30:00.000' });
});
