import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { toJUnitXml, toHtml, runFailure } from '../src/report';
import type { RunState, RunStep } from '../src/run';

function step(overrides: Partial<RunStep> & Pick<RunStep, 'command' | 'name' | 'status' | 'exitCode'>): RunStep {
  return {
    index: 0,
    startedAt: '2026-06-07T10:11:12.000Z',
    durationMs: 100,
    ...overrides,
  };
}

function runWith(steps: RunStep[]): RunState {
  return {
    id: '20260607-101112',
    name: 'run',
    startedAt: '2026-06-07T10:11:12.000Z',
    updatedAt: '2026-06-07T10:11:20.000Z',
    platform: 'android',
    device: 'emulator-5554',
    implicit: false,
    steps: steps.map((s, i) => ({ ...s, index: i })),
  };
}

const SAMPLE = runWith([
  step({
    command: 'tap',
    name: 'tap @login',
    status: 'passed',
    exitCode: 0,
    selector: { raw: '@login', kind: 'id', value: 'login' },
    tier: 'partial',
    resolved: { type: 'Button', id: 'com.app:id/login', idShort: 'login', text: 'Login', center: { x: 540, y: 1020 } },
  }),
  step({ command: 'assert', name: 'assert text:Welcome', status: 'failed', exitCode: 1, message: 'FAIL — not found' }),
  step({ command: 'launch', name: 'launch <pkg> & "x"', status: 'error', exitCode: 3, message: 'boom\x00bar' }),
]);

// --- JUnit ----------------------------------------------------------------

test('toJUnitXml: well-formed header with the right tallies', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<testsuites name="verikun" tests="3" failures="1" errors="1"'));
  assert.ok(xml.includes('<testsuite name="run" tests="3" failures="1" errors="1"'));
});

test('toJUnitXml: a failed step maps to <failure type="AssertionFailure">', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(xml.includes('<failure message="FAIL') && xml.includes('type="AssertionFailure"'));
});

test('toJUnitXml: an errored step maps to <error type="EnvironmentError">', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(xml.includes('<error') && xml.includes('type="EnvironmentError"'));
});

test('toJUnitXml: a passed step records selector, heal tier, and resolved identifier', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(xml.includes('<system-out>'));
  assert.ok(xml.includes('selector: @login (id)'));
  assert.ok(xml.includes('healed: matched via partial, not exact'));
  assert.ok(xml.includes('resolved: com.app:id/login "Login" (540,1020)'));
});

test('toJUnitXml: special characters in attributes are XML-escaped', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(xml.includes('launch &lt;pkg&gt; &amp; &quot;x&quot;'));
  assert.ok(!xml.includes('<pkg>')); // the raw, unescaped form must not appear
});

test('toJUnitXml: forbidden control characters are stripped', () => {
  const xml = toJUnitXml(SAMPLE);
  assert.ok(!xml.includes('\x00'));
  assert.ok(xml.includes('boombar')); // the NUL between the words was removed
});

test('toJUnitXml: an empty run renders zero tests without crashing', () => {
  const xml = toJUnitXml(runWith([]));
  assert.ok(xml.includes('tests="0"'));
});

// --- HTML -----------------------------------------------------------------

test('toHtml: emits a full document titled with the run name', () => {
  const html = toHtml(SAMPLE);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('verikun test run — run'));
});

test('toHtml: summary chips reflect the pass/fail/error counts', () => {
  const html = toHtml(SAMPLE);
  assert.ok(html.includes('1 passed'));
  assert.ok(html.includes('1 failed'));
  assert.ok(html.includes('1 errors'));
});

test('toHtml: step names are HTML-escaped', () => {
  const html = toHtml(SAMPLE);
  assert.ok(html.includes('launch &lt;pkg&gt; &amp; &quot;x&quot;'));
});

test('toHtml: surfaces the heal tier for a healed step', () => {
  const html = toHtml(SAMPLE);
  assert.ok(html.includes('healed') && html.includes('>partial<'));
});

// --- device logs ----------------------------------------------------------

const FATAL = 'E AndroidRuntime: FATAL EXCEPTION: main\n\tat com.app.Main.crash(Main.java:42)';

test('toJUnitXml: a passing log step carries its logs in <system-out>', () => {
  const xml = toJUnitXml(runWith([step({ command: 'log', name: 'log com.app', status: 'passed', exitCode: 0, logs: FATAL })]));
  assert.ok(xml.includes('<system-out>'));
  assert.ok(xml.includes('Device logs:'));
  assert.ok(xml.includes('FATAL EXCEPTION'));
});

test('toJUnitXml: a failed step embeds attached device logs in the <failure> body', () => {
  const xml = toJUnitXml(runWith([
    step({ command: 'assert', name: 'assert text:Home', status: 'failed', exitCode: 1, message: 'FAIL', logs: FATAL }),
  ]));
  assert.ok(xml.includes('Device logs:') && xml.includes('FATAL EXCEPTION'));
});

test('toHtml: a log step renders its logs in a <details> block', () => {
  const html = toHtml(runWith([step({ command: 'log', name: 'log com.app', status: 'passed', exitCode: 0, logs: FATAL })]));
  assert.ok(html.includes('Device logs'));
  assert.ok(html.includes('FATAL EXCEPTION'));
});

test('toHtml: archive-time logFile is linked from the run meta', () => {
  const html = toHtml({ ...SAMPLE, logFile: 'artifacts/logcat.txt' });
  assert.ok(html.includes('href="artifacts/logcat.txt"'));
  assert.ok(html.includes('device log'));
});

test('toHtml: app-scoped log renders in a bottom accordion (not the full device dump)', () => {
  const html = toHtml(
    { ...SAMPLE, logFile: 'artifacts/logcat.txt', appLogFile: 'artifacts/logcat-app.txt', appId: 'dev.verikun.testapp' },
    { appLog: 'I flutter: Signed in' },
  );
  assert.ok(html.includes('class="run-log"'));
  assert.ok(html.includes('<summary>App log for dev.verikun.testapp'));
  assert.ok(html.includes('href="artifacts/logcat-app.txt"'));
  assert.ok(html.includes('I flutter: Signed in'));
  // Full device dump stays a meta link, not the accordion body.
  assert.ok(html.includes('>device log</a>'));
  assert.ok(html.indexOf('</ol>') < html.indexOf('class="run-log"'));
});

test('toHtml: empty/absent appLog omits the accordion', () => {
  assert.ok(!toHtml(SAMPLE).includes('class="run-log"'));
  assert.ok(!toHtml(SAMPLE, { appLog: '' }).includes('class="run-log"'));
  // Device file alone is not enough — accordion is app-scoped only.
  assert.ok(!toHtml({ ...SAMPLE, logFile: 'artifacts/logcat.txt' }).includes('class="run-log"'));
});

test('toHtml: appLog body is HTML-escaped', () => {
  const html = toHtml(SAMPLE, { appLog: '<script>alert(1)</script> & more' });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&amp; more'));
});

test('toJUnitXml: archive-time logFile is noted in the suite system-out', () => {
  const xml = toJUnitXml({ ...SAMPLE, logFile: 'artifacts/logcat.txt' });
  assert.ok(xml.includes('device log: artifacts/logcat.txt'));
});

// --- vk ai panel ----------------------------------------------------------

function aiRun(): RunState {
  return {
    ...runWith([
      step({ command: 'tap', name: 'tap @x', status: 'passed', exitCode: 0, healed: true, message: 'healed: miss -> tap @y' }),
    ]),
    ai: {
      ok: true,
      cost: 'compile=$0.0100 · repairs=$0.0000 · replay=$0 · est $0.0100',
      modelRepairs: 1,
      improvements: ['steps[0]: tighten @x'],
    },
  };
}

test('toHtml: renders the vk ai panel (cost, repair count, improvements) and the model-healed step', () => {
  const html = toHtml(aiRun());
  assert.ok(html.includes('vk ai'));
  assert.ok(html.includes('compile=$0.0100'));
  assert.ok(html.includes('1 model repair(s)'));
  assert.ok(html.includes('tighten @x'));
  assert.ok(html.includes('model-healed'));
});

test('toJUnitXml: carries the vk ai cost line and suggested improvements', () => {
  const xml = toJUnitXml(aiRun());
  assert.ok(xml.includes('vk ai:'));
  assert.ok(xml.includes('compile=$0.0100'));
  assert.ok(xml.includes('tighten @x'));
});

// --- run-level failure ------------------------------------------------------
//
// A `vk ai` run can fail where no command ran — a `repeat` that never sees its
// target, a budget/timeout abort. Those recorded no step, so a tally-only report
// declared the failed run green in the very format CI trusts (issue #41).

const PASSING_STEP = step({ command: 'tap', name: 'tap @x', status: 'passed', exitCode: 0 });

function unrecordedRun(): RunState {
  return {
    ...runWith([PASSING_STEP, PASSING_STEP]),
    failure: { where: 'steps[24]', reason: "repeat stopped after 4 iteration(s) without 'id:target' ever appearing" },
  };
}

test('runFailure: prefers the engine verdict, falls back to ai.ok, else null', () => {
  assert.equal(runFailure(runWith([PASSING_STEP])), null);
  assert.equal(runFailure(unrecordedRun())?.where, 'steps[24]');
  // No `failure` field (an older run.json, or a path that only set the ai summary).
  const aiOnly: RunState = { ...runWith([PASSING_STEP]), ai: { ok: false, cost: '', modelRepairs: 0, improvements: [] } };
  assert.match(runFailure(aiOnly)?.reason ?? '', /did not pass/);
});

test('toJUnitXml: a run-level failure with only passing steps is NOT reported green', () => {
  const xml = toJUnitXml(unrecordedRun());
  assert.ok(xml.includes('failures="1"'), 'a failed run must never report failures="0"');
  // The synthetic case is emitted too, so the tally still describes the case list.
  assert.ok(xml.includes('tests="3"'));
  assert.equal(xml.match(/<testcase /g)?.length, 3);
  assert.ok(xml.includes('classname="verikun.run"'));
  assert.ok(xml.includes('repeat stopped after 4 iteration(s)'));
  assert.ok(xml.includes('steps[24]'));
});

test('toJUnitXml: a run-level failure already carried by a red step is not double-counted', () => {
  const xml = toJUnitXml({
    ...runWith([PASSING_STEP, step({ command: 'assert', name: 'assert @x', status: 'failed', exitCode: 1, message: 'FAIL' })]),
    failure: { where: 'steps[1]', reason: 'assert failed' },
  });
  assert.ok(xml.includes('tests="2"'));
  assert.ok(xml.includes('failures="1"'));
  assert.equal(xml.match(/<testcase /g)?.length, 2);
});

test('toHtml: a run-level failure states the verdict up top and adds a red row', () => {
  const html = toHtml(unrecordedRun());
  assert.ok(html.includes('This run did not pass.'));
  assert.ok(html.includes('steps[24]'));
  assert.ok(html.includes('repeat stopped after 4 iteration(s)'));
  assert.ok(html.includes('1 failed'), 'the summary chips must show the failure');
  assert.ok(html.includes('<li class="step failed">'));
});

test('toHtml: a run with a red step shows the banner but no extra synthetic row', () => {
  const html = toHtml({
    ...runWith([step({ command: 'assert', name: 'assert @x', status: 'failed', exitCode: 1, message: 'FAIL' })]),
    failure: { where: 'steps[0]', reason: 'assert failed' },
  });
  assert.ok(html.includes('This run did not pass.'));
  assert.equal(html.match(/<li class="step /g)?.length, 1);
});
