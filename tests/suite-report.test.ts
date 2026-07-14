import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SuiteRun, SuiteTestResult, suiteTotals, toSuiteIndexJson, toSuiteHtml } from '../src/report';

function result(overrides: Partial<SuiteTestResult> = {}): SuiteTestResult {
  return {
    id: '20260713-101500',
    file: '01-login.md',
    name: '01-login',
    ok: true,
    durationMs: 4200,
    costUsd: 0.01,
    steps: 5,
    passedSteps: 5,
    failedSteps: 0,
    modelRepairs: 0,
    ...overrides,
  };
}

function suite(tests: SuiteTestResult[]): SuiteRun {
  return {
    schemaVersion: 1,
    id: '20260713-101459',
    name: 'smoke',
    startedAt: '2026-07-13T10:14:59.000Z',
    finishedAt: '2026-07-13T10:16:10.000Z',
    platform: 'android',
    device: 'R58R42SGVNR',
    verikun: '0.6.0',
    totals: suiteTotals(tests),
    tests,
  };
}

// --- suiteTotals ------------------------------------------------------------

test('suiteTotals: sums tests/steps/cost/duration and splits pass/fail', () => {
  const t = suiteTotals([
    result(),
    result({ ok: false, failedSteps: 1, passedSteps: 4, costUsd: 0.2, durationMs: 800 }),
    result({ costUsd: 0.0001 }),
  ]);
  assert.equal(t.tests, 3);
  assert.equal(t.passed, 2);
  assert.equal(t.failed, 1);
  assert.equal(t.steps, 15);
  assert.equal(t.costUsd, 0.2101); // rounded, no float dust
  assert.equal(t.durationMs, 4200 + 800 + 4200);
});

test('suiteTotals: empty suite is all zeroes', () => {
  const t = suiteTotals([]);
  assert.deepEqual(t, { tests: 0, passed: 0, failed: 0, steps: 0, costUsd: 0, durationMs: 0 });
});

// --- index.json -------------------------------------------------------------

test('toSuiteIndexJson: round-trips as JSON and carries the schema version', () => {
  const s = suite([result(), result({ ok: false, failure: 'FAIL at steps[2]: assert' })]);
  const parsed = JSON.parse(toSuiteIndexJson(s)) as SuiteRun;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tests.length, 2);
  assert.equal(parsed.totals.failed, 1);
  assert.equal(parsed.tests[1].failure, 'FAIL at steps[2]: assert');
  assert.equal(parsed.verikun, '0.6.0');
});

// --- index.html -------------------------------------------------------------

test('toSuiteHtml: links each test report through the linkBase', () => {
  const html = toSuiteHtml(suite([result()]), { linkBase: '../../' });
  assert.ok(html.includes('href="../../runs/20260713-101500/report.html"'), 'report link');
  assert.ok(html.includes('smoke'), 'suite name');
  assert.ok(html.includes('1 passed'), 'totals chip');
});

test('toSuiteHtml: a test with no run (id empty) renders without a link', () => {
  const html = toSuiteHtml(suite([result({ id: '', ok: false, failure: 'server unreachable' })]));
  assert.ok(!html.includes('href="../../runs//report.html"'), 'no dangling link');
  assert.ok(html.includes('server unreachable'), 'failure reason shown');
});

test('toSuiteHtml: escapes HTML in names and failure text', () => {
  const html = toSuiteHtml(suite([result({ name: '<b>x</b>', ok: false, failure: 'saw <hierarchy> & stuff' })]));
  assert.ok(!html.includes('<b>x</b>'), 'name is escaped');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('saw &lt;hierarchy&gt; &amp; stuff'));
});
