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

// --- aborted suites (the environment broke mid-run) -------------------------

test('toSuiteIndexJson: an aborted suite carries reason + notRun, still schemaVersion 1', () => {
  // Purely additive: a reader that only knows `tests`/`totals` is unaffected, which is
  // why the schema version does not move.
  const s = { ...suite([result()]), aborted: { reason: "'idb' was not found on PATH.", notRun: ['02-x.md', '03-y.md'] } };
  const parsed = JSON.parse(toSuiteIndexJson(s)) as SuiteRun;
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.aborted?.notRun, ['02-x.md', '03-y.md']);
  assert.match(parsed.aborted?.reason ?? '', /idb/);
  // Not-run tests are NOT rows and NOT counted — passed + failed === tests must hold,
  // or every dashboard's arithmetic breaks and reports phantom regressions.
  assert.equal(parsed.tests.length, 1);
  assert.equal(parsed.totals.tests, 1);
  assert.equal(parsed.totals.passed + parsed.totals.failed, parsed.totals.tests);
});

test('toSuiteHtml: an aborted suite renders a banner listing the not-run tests', () => {
  const s = { ...suite([result()]), aborted: { reason: 'device disconnected', notRun: ['02-x.md'] } };
  const html = toSuiteHtml(s);
  assert.ok(html.includes('Suite aborted'), 'banner');
  assert.ok(html.includes('device disconnected'), 'reason');
  assert.ok(html.includes('02-x.md — not run'), 'the skipped test is named, not faked as a FAIL row');
  assert.ok(html.includes('ABORTED'), 'summary chip');
});

test('toSuiteHtml: the abort banner escapes its reason and filenames', () => {
  const s = { ...suite([result()]), aborted: { reason: 'saw <tag> & more', notRun: ['<evil>.md'] } };
  const html = toSuiteHtml(s);
  assert.ok(html.includes('saw &lt;tag&gt; &amp; more'));
  assert.ok(html.includes('&lt;evil&gt;.md'));
  assert.ok(!html.includes('<evil>.md'));
});

test('toSuiteHtml: a normal suite has no abort banner', () => {
  const html = toSuiteHtml(suite([result()]));
  assert.ok(!html.includes('Suite aborted'));
  assert.ok(!html.includes('ABORTED'));
});

// --- flaky / retries evidence -----------------------------------------------

test('toSuiteIndexJson: a recovered flake carries flaky + attempts + warnings, still schemaVersion 1', () => {
  const flaky = result({
    id: 'pass-2',
    flaky: true,
    attempts: [{ id: 'fail-1', ok: false, durationMs: 500, costUsd: 0.01, failure: 'FAIL at steps[1]: assert' }],
  });
  const s = { ...suite([flaky]), warnings: ['01-login.md passed on retry after 1 failed attempt'] };
  const parsed = JSON.parse(toSuiteIndexJson(s)) as SuiteRun;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tests[0].flaky, true);
  assert.equal(parsed.tests[0].attempts?.[0].id, 'fail-1');
  assert.equal(parsed.warnings?.[0], '01-login.md passed on retry after 1 failed attempt');
  // Recovered flakes count as passed, not failed.
  assert.equal(parsed.totals.passed, 1);
  assert.equal(parsed.totals.failed, 0);
});

test('toSuiteHtml: a flaky test shows FLAKY, links prior attempts, and renders the warnings banner', () => {
  const flaky = result({
    id: 'pass-2',
    flaky: true,
    attempts: [{ id: 'fail-1', ok: false, durationMs: 500, costUsd: 0.01, failure: 'FAIL at steps[1]: assert' }],
  });
  const s = { ...suite([flaky]), warnings: ['01-login.md passed on retry after 1 failed attempt'] };
  const html = toSuiteHtml(s, { linkBase: '../../' });
  assert.ok(html.includes('FLAKY'));
  assert.ok(html.includes('passed on retry (flake)'));
  assert.ok(html.includes('href="../../runs/fail-1/report.html"'), 'prior failed attempt linked');
  assert.ok(html.includes('href="../../runs/pass-2/report.html"'), 'winning run linked');
  assert.ok(html.includes('1 flaky'), 'summary chip');
  assert.ok(html.includes('Warnings'));
  assert.ok(html.includes('01-login.md passed on retry after 1 failed attempt'));
});

test('toSuiteHtml: the warnings banner escapes its text', () => {
  const s = { ...suite([result()]), warnings: ['saw <tag> & more'] };
  const html = toSuiteHtml(s);
  assert.ok(html.includes('saw &lt;tag&gt; &amp; more'));
  assert.ok(!html.includes('saw <tag> & more'));
});

test('toSuiteHtml: the Device column follows the ROWS, not the lane count', () => {
  // A pooled server the suite sized to one lane, or `--concurrency 1` over two phones,
  // still ran somewhere the header cannot name — and gating the column on
  // `concurrency > 1` made that pooled run report LESS than the plain command it
  // replaced. Conversely a serial run must not grow a redundant column.
  const pooled: SuiteRun = { ...suite([result({ device: 'emulator-5554' })]), device: undefined };
  const html = toSuiteHtml(pooled);
  assert.match(html, /<th>Device<\/th>/);
  assert.match(html, /emulator-5554/);

  const serial = suite([result({ device: 'R58R42SGVNR' })]); // same serial as the header
  assert.doesNotMatch(toSuiteHtml(serial), /<th>Device<\/th>/, 'the header already says it');
  assert.doesNotMatch(toSuiteHtml(suite([result()])), /<th>Device<\/th>/);
});
