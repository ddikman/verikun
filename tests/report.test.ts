import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { toJUnitXml, toHtml } from '../src/report';
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
