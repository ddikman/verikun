// Pure report rendering: a finished RunState in -> a JUnit XML / HTML string out,
// and a finished SuiteRun in -> the suite index.json / index.html out.
// No fs, no device, no side effects — so it is trivially testable and the run
// recorder (run.ts) / suite runner (suite.ts) own all the I/O. The RunState data
// model lives in run.ts; we import the types only.

import type { RunState, RunStep } from './run';

// --- escaping -------------------------------------------------------------

// XML 1.0 forbids most control chars even when escaped; drop them so a stray
// byte in a UI label can't produce an unparseable report.
const stripCtl = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const xmlAttr = (s: string) =>
  stripCtl(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const xmlText = (s: string) =>
  stripCtl(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const htmlEsc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// --- shared labels --------------------------------------------------------

function selectorLabel(s: RunStep): string {
  return s.selector ? `${s.selector.raw} (${s.selector.kind})` : '';
}

function resolvedLabel(s: RunStep): string {
  const r = s.resolved;
  if (!r) return '';
  const id = r.id || (r.idShort ? '@' + r.idShort : '') || r.type;
  const text = r.text ? ` ${JSON.stringify(r.text)}` : '';
  return `${id}${text} (${r.center.x},${r.center.y})`;
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The run's verdict, taken from the ENGINE rather than inferred from step statuses.
 *
 * A `vk ai` run can fail outside any command — a `repeat` that never sees its target,
 * a budget/timeout abort — and those record no step, so a tally-only report declared
 * the run green (issue #41). `Recorder.recordTerminalFailure` now writes `failure`, and
 * `ai.ok` is the older, coarser signal we still fall back to; between them an
 * unrecorded failure can no longer read as success.
 */
export function runFailure(run: RunState): { where: string; reason: string } | null {
  if (run.failure) return run.failure;
  if (run.ai && !run.ai.ok) return { where: 'run', reason: 'the run did not pass (no step recorded the failure)' };
  return null;
}

function counts(run: RunState) {
  const passed = run.steps.filter((s) => s.status === 'passed').length;
  const failures = run.steps.filter((s) => s.status === 'failed').length;
  const errors = run.steps.filter((s) => s.status === 'error').length;
  const timeMs = run.steps.reduce((a, s) => a + s.durationMs, 0);
  // Belt and braces. Normally the terminal failure IS a step by the time we render, so
  // this stays false; it fires only if the failure never reached the recorder, and then
  // both renderers emit one extra entry — hence `tests` grows too, so the tally never
  // disagrees with the testcase list it is supposed to describe.
  const unrecorded = failures + errors === 0 && runFailure(run) !== null;
  return {
    tests: run.steps.length + (unrecorded ? 1 : 0),
    passed,
    failures: failures + (unrecorded ? 1 : 0),
    errors,
    timeMs,
    unrecorded,
  };
}

// --- JUnit ----------------------------------------------------------------

export function toJUnitXml(run: RunState): string {
  const c = counts(run);
  const suiteTime = (c.timeMs / 1000).toFixed(3);

  const cases = run.steps
    .map((s) => {
      const time = (s.durationMs / 1000).toFixed(3);
      const classname = 'verikun.' + s.command;
      const attrs = `name="${xmlAttr(s.name)}" classname="${xmlAttr(classname)}" time="${time}"`;

      const lines: string[] = [];
      if (selectorLabel(s)) lines.push(`selector: ${selectorLabel(s)}`);
      if (s.tier && s.tier !== 'exact') lines.push(`healed: matched via ${s.tier}, not exact`);
      if (s.healed) lines.push(`model-healed: ${s.message ?? 'repaired'}`);
      if (resolvedLabel(s)) lines.push(`resolved: ${resolvedLabel(s)}`);
      if (s.failImage) lines.push(`screenshot: ${s.failImage}`);
      if (s.image) lines.push(`image: ${s.image}`);

      let body = '';
      if (s.status === 'failed' || s.status === 'error') {
        const tag = s.status === 'failed' ? 'failure' : 'error';
        const type = s.status === 'failed' ? 'AssertionFailure' : 'EnvironmentError';
        const detail = [
          s.message ?? s.status,
          ...lines,
          s.failHierarchy ? `\nUI hierarchy at failure:\n${s.failHierarchy}` : '',
          s.logs ? `\nDevice logs:\n${s.logs}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        body =
          `\n    <${tag} message="${xmlAttr(s.message ?? s.status)}" type="${type}">` +
          `${xmlText(detail)}</${tag}>`;
      } else if (lines.length || s.logs) {
        const sysOut = [...lines, s.logs ? `Device logs:\n${s.logs}` : ''].filter(Boolean).join('\n');
        body = `\n    <system-out>${xmlText(sysOut)}</system-out>`;
      }

      return `  <testcase ${attrs}>${body}\n  </testcase>`;
    })
    .join('\n');

  const f = runFailure(run);
  const unrecordedCase =
    c.unrecorded && f
      ? `  <testcase name="${xmlAttr(`run did not pass (${f.where})`)}" classname="verikun.run" time="0.000">` +
        `\n    <failure message="${xmlAttr(f.reason)}" type="AssertionFailure">${xmlText(
          `${f.where}: ${f.reason}`,
        )}</failure>\n  </testcase>`
      : '';
  const allCases = [cases, unrecordedCase].filter(Boolean).join('\n');

  const suiteAttrs =
    `name="${xmlAttr(run.name)}" tests="${c.tests}" failures="${c.failures}" ` +
    `errors="${c.errors}" time="${suiteTime}" timestamp="${xmlAttr(run.startedAt)}"`;

  const suiteExtras: string[] = [];
  if (run.logFile) suiteExtras.push(`device log: ${run.logFile}`);
  if (run.ai) {
    suiteExtras.push(
      'vk ai: ' +
        run.ai.cost +
        (run.ai.improvements.length ? '\nSuggested improvements:\n' + run.ai.improvements.join('\n') : ''),
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="verikun" tests="${c.tests}" failures="${c.failures}" errors="${c.errors}" time="${suiteTime}">\n` +
    `<testsuite ${suiteAttrs}>\n` +
    `${allCases}\n` +
    (suiteExtras.length
      ? `  <system-out>${xmlText(suiteExtras.join('\n'))}</system-out>\n`
      : '') +
    `</testsuite>\n</testsuites>\n`
  );
}

// --- HTML -----------------------------------------------------------------

const STYLE = `
  :root { --pass:#1a7f37; --fail:#cf222e; --err:#9a6700; --bg:#f6f8fa; --line:#d0d7de; --muted:#57606a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; color:#1f2328; background:var(--bg); }
  .wrap { max-width: 920px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  .meta code { background:#eaeef2; padding:1px 5px; border-radius:4px; }
  .summary { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom: 20px; }
  .chip { font-weight:600; font-size:13px; padding:4px 10px; border-radius:999px; color:#fff; }
  .chip.pass{background:var(--pass)} .chip.fail{background:var(--fail)} .chip.err{background:var(--err)}
  .chip.warn{background:var(--err)}
  .chip.muted{ background:#eaeef2; color:var(--muted); }
  ol.steps { list-style:none; margin:0; padding:0; }
  li.step { background:#fff; border:1px solid var(--line); border-left-width:4px; border-radius:8px; margin-bottom:10px; padding:12px 14px; }
  li.step.passed{ border-left-color:var(--pass) } li.step.failed{ border-left-color:var(--fail) } li.step.error{ border-left-color:var(--err) }
  .row { display:flex; align-items:center; gap:10px; }
  .idx { color:var(--muted); font-variant-numeric:tabular-nums; }
  .st { font-weight:700; font-size:11px; letter-spacing:.04em; padding:2px 7px; border-radius:4px; color:#fff; }
  .st.passed{background:var(--pass)} .st.failed{background:var(--fail)} .st.error{background:var(--err)}
  .name { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .time { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
  .detail { margin-top:8px; font-size:13px; color:#1f2328; }
  .detail .k { color:var(--muted); }
  .detail code { background:#eaeef2; padding:1px 5px; border-radius:4px; font-size:12px; }
  .msg { margin-top:6px; font-size:13px; }
  .msg.fail { color:var(--fail); }
  img.shot { display:block; margin-top:10px; max-width:300px; max-height:520px; border:1px solid var(--line); border-radius:6px; }
  details { margin-top:8px; }
  details.run-log { margin-top:20px; background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 14px; }
  details.run-log > summary { font-weight:600; color:#1f2328; }
  details.run-log > summary a { font-weight:400; }
  details.run-log pre { max-height:480px; }
  summary { cursor:pointer; color:var(--muted); font-size:13px; }
  pre { background:#0d1117; color:#e6edf3; padding:12px; border-radius:6px; overflow:auto; font-size:12px; line-height:1.45; max-height:360px; }
  .aibox { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:20px; font-size:13px; }
  .aibox .cost { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); margin-top:4px; }
  .aibox ul { margin:8px 0 0; padding-left:18px; }
  .failbox { background:#fff; border:1px solid var(--fail); border-left-width:4px; border-radius:8px; padding:12px 14px; margin-bottom:20px; font-size:13px; }
  .failbox .where { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
  .failbox .why { color:var(--fail); margin-top:4px; }
`;

function aiPanelHtml(ai: NonNullable<RunState['ai']>): string {
  const improvements = ai.improvements.length
    ? `<details open><summary>Suggested test improvements (${ai.improvements.length})</summary><ul>${ai.improvements
        .map((s) => `<li>${htmlEsc(s)}</li>`)
        .join('')}</ul></details>`
    : '';
  return `<div class="aibox">
      <div><span class="k">vk ai</span> ${ai.ok ? 'passed' : 'did not pass'}${ai.modelRepairs ? ` &middot; ${ai.modelRepairs} model repair(s)` : ''}</div>
      <div class="cost">${htmlEsc(ai.cost)}</div>
      ${improvements}
    </div>`;
}

/** The run-level failure, stated once at the top. This page is where a human looks
 *  first, so the verdict has to be visible without reading 26 green rows. */
function failBoxHtml(f: { where: string; reason: string }): string {
  return `<div class="failbox">
      <div><strong>This run did not pass.</strong> <span class="where">${htmlEsc(f.where)}</span></div>
      <div class="why">${htmlEsc(f.reason)}</div>
    </div>`;
}

function stepHtml(s: RunStep): string {
  const detail: string[] = [];
  if (selectorLabel(s)) detail.push(`<span class="k">selector</span> <code>${htmlEsc(s.selector!.raw)}</code> <span class="k">(${htmlEsc(s.selector!.kind)})</span>`);
  if (s.tier && s.tier !== 'exact') detail.push(`<span class="k">healed</span> <code>${htmlEsc(s.tier)}</code>`);
  if (s.healed) detail.push(`<span class="k">model-healed</span>`);
  if (resolvedLabel(s)) detail.push(`<span class="k">resolved</span> <code>${htmlEsc(resolvedLabel(s))}</code>`);

  const parts: string[] = [];
  parts.push(`<div class="row">
      <span class="idx">#${s.index}</span>
      <span class="st ${s.status}">${s.status.toUpperCase()}</span>
      <span class="name">${htmlEsc(s.name)}</span>
      <span class="time">${fmtDuration(s.durationMs)}</span>
    </div>`);
  if (detail.length) parts.push(`<div class="detail">${detail.join(' &middot; ')}</div>`);
  if (s.message) parts.push(`<div class="msg ${s.status !== 'passed' ? 'fail' : ''}">${htmlEsc(s.message)}</div>`);
  if (s.image) parts.push(`<a href="${htmlEsc(s.image)}"><img class="shot" src="${htmlEsc(s.image)}" alt="screenshot"></a>`);
  if (s.failImage) parts.push(`<a href="${htmlEsc(s.failImage)}"><img class="shot" src="${htmlEsc(s.failImage)}" alt="screen at failure"></a>`);
  if (s.failHierarchy)
    parts.push(`<details><summary>UI hierarchy at failure</summary><pre>${htmlEsc(s.failHierarchy)}</pre></details>`);
  if (s.logs) parts.push(`<details><summary>Device logs</summary><pre>${htmlEsc(s.logs)}</pre></details>`);

  return `<li class="step ${s.status}">${parts.join('\n    ')}</li>`;
}

// --- suite (vk suite) -------------------------------------------------------
//
// The suite manifest (index.json) is the STABLE OUTPUT CONTRACT for reporting
// providers: CI steps (upload-artifact, rclone, aws s3) compose over these files
// rather than verikun growing in-core upload plugins. Bump schemaVersion on any
// breaking change to the shape.

/** One archived attempt of a suite test — kept when `--retries` re-ran the file. */
export interface SuiteAttempt {
  /** Archived run id under .verikun/runs/ ('' when the attempt never started a run). */
  id: string;
  ok: boolean;
  durationMs: number;
  costUsd: number;
  /** Failure summary when not ok. */
  failure?: string;
}

export interface SuiteTestResult {
  /** Archived run id — the directory name under .verikun/runs/. */
  id: string;
  /** Test source file as the suite enumerated it (relative path). */
  file: string;
  /** Display name (file basename without extension). */
  name: string;
  ok: boolean;
  /**
   * Which device ran this test. Only meaningful (and only set) when the suite ran
   * across a pool: serially every row shares `SuiteRun.device`, but in parallel the
   * assignment is dynamic — and against a pooled `vk server` the client asked for a
   * URL, so the LEASE is the only thing that ever knew the answer. Without it "is
   * this device bad, or is this test bad?" stays unanswerable.
   */
  device?: string;
  durationMs: number;
  /** Model spend for this test (compile + repairs); 0 on a full cache-hit replay. */
  costUsd: number;
  steps: number;
  passedSteps: number;
  failedSteps: number;
  modelRepairs: number;
  /** Terminal failure summary when not ok (assert failure, drift, budget/timeout abort). */
  failure?: string;
  /**
   * Prior attempts when `--retries` re-ran this test. The primary `id` is the final
   * (winning or last-failed) run; these rows keep the failed archives visible so a
   * flake that later passed does not erase its red evidence.
   */
  attempts?: SuiteAttempt[];
  /** True when this test passed only after one or more failed attempts. */
  flaky?: boolean;
}

export interface SuiteRun {
  schemaVersion: 1;
  id: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  platform: string;
  device?: string;
  /** verikun version of the process that produced this suite — the CLIENT's, which for a
   *  `--server` run is NOT the version that drove the device. See `server` below. */
  verikun: string;
  /**
   * Set only for a `--server` run: which server drove the device, on which verikun, and
   * which hierarchy read path it used.
   *
   * A remote artifact previously recorded only the client's version, so it could not say
   * which verikun executed the steps, let alone how it read the screen — the two facts you
   * need to explain a suite that got slower after a server upgrade (issue #77). Additive;
   * schemaVersion stays 1.
   */
  server?: { url: string; verikun: string; reads?: string };
  /**
   * How many devices ran this suite at once. `1` is the serial suite (and every suite
   * produced before parallelism existed, where the field is simply absent). Additive;
   * schemaVersion stays 1.
   */
  concurrency?: number;
  totals: SuiteTotals;
  tests: SuiteTestResult[];
  /**
   * Set only when the suite STOPPED EARLY: either the device environment broke mid-run
   * (exit 3 — tool gone, device unplugged, server unreachable) and a re-probe confirmed
   * it, or a `--max-suite-cost-usd` ceiling was crossed. The `notRun` files have NO rows
   * in `tests`, and `totals` counts only what actually ran — deliberately, so
   * `passed + failed === tests` still holds and a dashboard never reports a not-run test
   * as a regression.
   *
   * `kind` decides the exit code, so the two cases cannot page the same person: an
   * environment abort is exit 3 ("the runner is broken"), a budget abort is exit 1
   * (the run did not pass), mirroring what `vk ai` already returns for `--max-cost-usd`.
   * ABSENT on suites written before the field existed; treat that as `'environment'`,
   * which is what they all were.
   */
  aborted?: { reason: string; notRun: string[]; kind?: 'environment' | 'budget' };
  /**
   * Soft signals that did not fail the suite — today: tests that passed only after a
   * retry (flake recovered). Additive; schemaVersion stays 1.
   */
  warnings?: string[];
}

export interface SuiteTotals {
  tests: number;
  passed: number;
  failed: number;
  steps: number;
  costUsd: number;
  /**
   * DEVICE TIME: the sum of every test's duration. Serially this equals the elapsed
   * time, which is why it was printed as though it were — but across N devices it
   * becomes "how many device-seconds did the gate cost", a genuinely different number.
   * Read `wallClockMs` for "how long did I wait".
   */
  durationMs: number;
  /**
   * Elapsed time from the suite's `startedAt` to its `finishedAt` — the number an
   * operator actually watches. Derivable from the two timestamps, which were already
   * recorded; nothing computed it. ABSENT on suites written before the field existed,
   * where `durationMs` was the same number anyway.
   */
  wallClockMs?: number;
}

/** Tally a suite's tests into its totals (pure; used by suite.ts and tests). */
export function suiteTotals(tests: SuiteTestResult[], wallClockMs?: number): SuiteTotals {
  const round = (n: number) => Number(n.toFixed(4));
  return {
    tests: tests.length,
    passed: tests.filter((t) => t.ok).length,
    failed: tests.filter((t) => !t.ok).length,
    steps: tests.reduce((a, t) => a + t.steps, 0),
    costUsd: round(tests.reduce((a, t) => a + t.costUsd, 0)),
    durationMs: tests.reduce((a, t) => a + t.durationMs, 0),
    ...(wallClockMs === undefined ? {} : { wallClockMs: Math.max(0, Math.round(wallClockMs)) }),
  };
}

export function toSuiteIndexJson(suite: SuiteRun): string {
  return JSON.stringify(suite, null, 2) + '\n';
}

const SUITE_STYLE = `
  table.tests { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  table.tests th, table.tests td { text-align:left; padding:10px 12px; border-top:1px solid var(--line); font-size:13px; }
  table.tests th { background:#eaeef2; color:var(--muted); border-top:none; font-size:12px; letter-spacing:.03em; text-transform:uppercase; }
  table.tests td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  table.tests td.dev { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--muted); white-space:nowrap; }
  table.tests a { color:inherit; }
  .fail-reason { color:var(--fail); font-size:12px; margin-top:2px; }
  .flake-note { color:var(--err); font-size:12px; margin-top:2px; }
  .attempts { margin-top:4px; font-size:12px; color:var(--muted); }
  .attempts a { color:var(--fail); }
  .aborted { background:#fff4e5; border:1px solid #f0b429; border-radius:8px; padding:12px 14px; margin:0 0 14px; font-size:13px; }
  .aborted strong { color:#8a5300; }
  .aborted ul { margin:6px 0 0; padding-left:20px; color:var(--muted); }
  .warnings { background:#fff8c5; border:1px solid #d4a72c; border-radius:8px; padding:12px 14px; margin:0 0 14px; font-size:13px; }
  .warnings strong { color:#7d4e00; }
  .warnings ul { margin:6px 0 0; padding-left:20px; color:var(--muted); }
`;

function suiteAttemptLinks(attempts: SuiteAttempt[], linkBase: string): string {
  const links = attempts
    .map((a, i) => {
      const label = `attempt ${i + 1}`;
      if (!a.id) return htmlEsc(label);
      return `<a href="${htmlEsc(`${linkBase}runs/${encodeURIComponent(a.id)}/report.html`)}">${htmlEsc(label)}</a>`;
    })
    .join(', ');
  return `<div class="attempts">prior failed: ${links}</div>`;
}

function suiteTestRow(t: SuiteTestResult, linkBase: string, showDevice: boolean): string {
  // A test that errored before its run started (id '') has no report to link.
  const label = t.id
    ? `<a href="${htmlEsc(`${linkBase}runs/${encodeURIComponent(t.id)}/report.html`)}">${htmlEsc(t.name)}</a>`
    : htmlEsc(t.name);
  const failure = t.failure ? `<div class="fail-reason">${htmlEsc(t.failure)}</div>` : '';
  const flake = t.flaky ? `<div class="flake-note">passed on retry (flake)</div>` : '';
  const prior = t.attempts?.length ? suiteAttemptLinks(t.attempts, linkBase) : '';
  const status = t.flaky ? 'FLAKY' : t.ok ? 'PASS' : 'FAIL';
  const statusClass = t.ok ? 'passed' : 'failed';
  // Only across a pool: serially every row would repeat SuiteRun.device, which the
  // meta line already says once.
  const device = showDevice ? `\n    <td class="dev">${htmlEsc(t.device ?? '—')}</td>` : '';
  return `  <tr>
    <td><span class="st ${statusClass}">${status}</span></td>
    <td>${label}${flake}${failure}${prior}</td>${device}
    <td class="num">${t.passedSteps}/${t.steps}${t.failedSteps ? ` (${t.failedSteps} failed)` : ''}</td>
    <td class="num">${t.modelRepairs || ''}</td>
    <td class="num">$${t.costUsd.toFixed(4)}</td>
    <td class="num">${fmtDuration(t.durationMs)}</td>
  </tr>`;
}

/**
 * The suite overview page. `linkBase` is the relative path from index.html to the
 * directory holding `runs/<id>/report.html` — '../../' when the suite lives at
 * .verikun/suites/<id>/ and runs at .verikun/runs/<id>/ (the default layout).
 */
export function toSuiteHtml(suite: SuiteRun, opts: { linkBase?: string } = {}): string {
  const linkBase = opts.linkBase ?? '../../';
  const t = suite.totals;
  const flaky = suite.tests.filter((x) => x.flaky).length;
  const parallel = (suite.concurrency ?? 1) > 1;
  // Across a pool the sum is device time, not elapsed — say which is which, or the
  // headline number silently changes meaning the day a second device is added.
  const timeChip = parallel
    ? `${fmtDuration(t.wallClockMs ?? t.durationMs)} wall &middot; ${fmtDuration(t.durationMs)} device time on ${suite.concurrency} devices`
    : fmtDuration(t.durationMs);
  const chips = [
    `<span class="chip pass">${t.passed} passed</span>`,
    t.failed ? `<span class="chip fail">${t.failed} failed</span>` : '',
    flaky ? `<span class="chip warn">${flaky} flaky</span>` : '',
    suite.aborted ? `<span class="chip fail">ABORTED</span>` : '',
    `<span class="chip muted">${t.tests} tests &middot; ${t.steps} steps &middot; ${timeChip} &middot; $${t.costUsd.toFixed(4)}</span>`,
  ]
    .filter(Boolean)
    .join('\n      ');

  // The banner, not a table row per skipped file: a not-run test is not a result, and
  // faking a FAIL row for one would be the very "phantom regression" this prevents.
  const abortedBanner = suite.aborted
    ? `  <div class="aborted">
    <strong>${
      suite.aborted.kind === 'budget'
        ? 'Suite stopped early — the cost ceiling was reached.'
        : 'Suite aborted — the device environment broke mid-run.'
    }</strong>
    <div>${htmlEsc(suite.aborted.reason)}</div>
${
  suite.aborted.notRun.length
    ? `    <ul>${suite.aborted.notRun.map((f) => `<li>${htmlEsc(f)} — not run</li>`).join('')}</ul>\n`
    : ''
}  </div>
`
    : '';

  const warningsBanner =
    suite.warnings?.length
      ? `  <div class="warnings">
    <strong>Warnings</strong>
    <ul>${suite.warnings.map((w) => `<li>${htmlEsc(w)}</li>`).join('')}</ul>
  </div>
`
      : '';

  const metaBits = [
    `<code>${htmlEsc(suite.id)}</code>`,
    htmlEsc(suite.platform) + (suite.device ? ` · ${htmlEsc(suite.device)}` : ''),
    parallel ? `${suite.concurrency} devices in parallel` : '',
    `started ${htmlEsc(suite.startedAt)}`,
    `finished ${htmlEsc(suite.finishedAt)}`,
    `verikun ${htmlEsc(suite.verikun)}`,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>verikun suite — ${htmlEsc(suite.name)}</title>
<style>${STYLE}${SUITE_STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>verikun test suite — ${htmlEsc(suite.name)}</h1>
  <div class="meta">${metaBits.join(' &middot; ')}</div>
  <div class="summary">
      ${chips}
  </div>
${abortedBanner}${warningsBanner}  <table class="tests">
    <thead><tr><th></th><th>Test</th>${parallel ? '<th>Device</th>' : ''}<th>Steps</th><th>Repairs</th><th>Cost</th><th>Duration</th></tr></thead>
    <tbody>
${suite.tests.map((x) => suiteTestRow(x, linkBase, parallel)).join('\n')}
    </tbody>
  </table>
</div>
</body>
</html>
`;
}

/**
 * @param opts.appLog  app-scoped logcat body for the bottom accordion (kept out
 *                     of RunState / run.json — pass the file contents when writing
 *                     report.html). The full device dump stays a meta-row file link.
 */
export function toHtml(run: RunState, opts: { appLog?: string } = {}): string {
  const c = counts(run);
  const failure = runFailure(run);
  const chips = [
    `<span class="chip pass">${c.passed} passed</span>`,
    c.failures ? `<span class="chip fail">${c.failures} failed</span>` : '',
    c.errors ? `<span class="chip err">${c.errors} errors</span>` : '',
    `<span class="chip muted">${c.tests} steps &middot; ${fmtDuration(c.timeMs)}</span>`,
  ]
    .filter(Boolean)
    .join('\n      ');

  const metaBits = [
    `<code>${htmlEsc(run.id)}</code>`,
    htmlEsc(run.platform) + (run.device ? ` · ${htmlEsc(run.device)}` : ''),
    `started ${htmlEsc(run.startedAt)}`,
    run.finishedAt ? `finished ${htmlEsc(run.finishedAt)}` : '',
    run.implicit ? 'implicit run' : '',
    run.logFile ? `<a href="${htmlEsc(run.logFile)}">device log</a>` : '',
  ].filter(Boolean);

  // Bottom accordion: app-scoped dump only. The noisy full device log stays a
  // download via the meta link — same shape on every framework (package/uid scope).
  const appLabel = run.appId ? ` for ${htmlEsc(run.appId)}` : '';
  const appFileLink = run.appLogFile
    ? ` (<a href="${htmlEsc(run.appLogFile)}">${htmlEsc(run.appLogFile)}</a>)`
    : '';
  const appLogPanel =
    opts.appLog !== undefined && opts.appLog !== ''
      ? `\n  <details class="run-log">
    <summary>App log${appLabel}${appFileLink}</summary>
    <pre>${htmlEsc(opts.appLog)}</pre>
  </details>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>verikun run — ${htmlEsc(run.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>verikun test run — ${htmlEsc(run.name)}</h1>
  <div class="meta">${metaBits.join(' &middot; ')}</div>
  <div class="summary">
      ${chips}
  </div>
  ${failure ? failBoxHtml(failure) : ''}
  ${run.ai ? aiPanelHtml(run.ai) : ''}
  <ol class="steps">
    ${[
      ...run.steps.map(stepHtml),
      // Only when the failure reached no step — otherwise it is already a red row.
      ...(c.unrecorded && failure
        ? [
            stepHtml({
              index: run.steps.length,
              command: 'ai',
              name: `run did not pass (${failure.where})`,
              startedAt: run.startedAt,
              durationMs: 0,
              status: 'failed',
              exitCode: 1,
              message: failure.reason,
            }),
          ]
        : []),
    ].join('\n    ')}
  </ol>${appLogPanel}
</div>
</body>
</html>
`;
}
