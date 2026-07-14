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

function counts(run: RunState) {
  const passed = run.steps.filter((s) => s.status === 'passed').length;
  const failures = run.steps.filter((s) => s.status === 'failed').length;
  const errors = run.steps.filter((s) => s.status === 'error').length;
  const timeMs = run.steps.reduce((a, s) => a + s.durationMs, 0);
  return { tests: run.steps.length, passed, failures, errors, timeMs };
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

  const suiteAttrs =
    `name="${xmlAttr(run.name)}" tests="${c.tests}" failures="${c.failures}" ` +
    `errors="${c.errors}" time="${suiteTime}" timestamp="${xmlAttr(run.startedAt)}"`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="verikun" tests="${c.tests}" failures="${c.failures}" errors="${c.errors}" time="${suiteTime}">\n` +
    `<testsuite ${suiteAttrs}>\n` +
    `${cases}\n` +
    (run.ai
      ? `  <system-out>${xmlText(
          'vk ai: ' +
            run.ai.cost +
            (run.ai.improvements.length ? '\nSuggested improvements:\n' + run.ai.improvements.join('\n') : ''),
        )}</system-out>\n`
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
  summary { cursor:pointer; color:var(--muted); font-size:13px; }
  pre { background:#0d1117; color:#e6edf3; padding:12px; border-radius:6px; overflow:auto; font-size:12px; line-height:1.45; max-height:360px; }
  .aibox { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:20px; font-size:13px; }
  .aibox .cost { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); margin-top:4px; }
  .aibox ul { margin:8px 0 0; padding-left:18px; }
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

export interface SuiteTestResult {
  /** Archived run id — the directory name under .verikun/runs/. */
  id: string;
  /** Test source file as the suite enumerated it (relative path). */
  file: string;
  /** Display name (file basename without extension). */
  name: string;
  ok: boolean;
  durationMs: number;
  /** Model spend for this test (compile + repairs); 0 on a full cache-hit replay. */
  costUsd: number;
  steps: number;
  passedSteps: number;
  failedSteps: number;
  modelRepairs: number;
  /** Terminal failure summary when not ok (assert failure, drift, budget/timeout abort). */
  failure?: string;
}

export interface SuiteRun {
  schemaVersion: 1;
  id: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  platform: string;
  device?: string;
  /** verikun version that produced this suite. */
  verikun: string;
  totals: SuiteTotals;
  tests: SuiteTestResult[];
}

export interface SuiteTotals {
  tests: number;
  passed: number;
  failed: number;
  steps: number;
  costUsd: number;
  durationMs: number;
}

/** Tally a suite's tests into its totals (pure; used by suite.ts and tests). */
export function suiteTotals(tests: SuiteTestResult[]): SuiteTotals {
  const round = (n: number) => Number(n.toFixed(4));
  return {
    tests: tests.length,
    passed: tests.filter((t) => t.ok).length,
    failed: tests.filter((t) => !t.ok).length,
    steps: tests.reduce((a, t) => a + t.steps, 0),
    costUsd: round(tests.reduce((a, t) => a + t.costUsd, 0)),
    durationMs: tests.reduce((a, t) => a + t.durationMs, 0),
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
  table.tests a { color:inherit; }
  .fail-reason { color:var(--fail); font-size:12px; margin-top:2px; }
`;

function suiteTestRow(t: SuiteTestResult, linkBase: string): string {
  // A test that errored before its run started (id '') has no report to link.
  const label = t.id
    ? `<a href="${htmlEsc(`${linkBase}runs/${encodeURIComponent(t.id)}/report.html`)}">${htmlEsc(t.name)}</a>`
    : htmlEsc(t.name);
  const failure = t.failure ? `<div class="fail-reason">${htmlEsc(t.failure)}</div>` : '';
  return `  <tr>
    <td><span class="st ${t.ok ? 'passed' : 'failed'}">${t.ok ? 'PASS' : 'FAIL'}</span></td>
    <td>${label}${failure}</td>
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
  const chips = [
    `<span class="chip pass">${t.passed} passed</span>`,
    t.failed ? `<span class="chip fail">${t.failed} failed</span>` : '',
    `<span class="chip muted">${t.tests} tests &middot; ${t.steps} steps &middot; ${fmtDuration(t.durationMs)} &middot; $${t.costUsd.toFixed(4)}</span>`,
  ]
    .filter(Boolean)
    .join('\n      ');

  const metaBits = [
    `<code>${htmlEsc(suite.id)}</code>`,
    htmlEsc(suite.platform) + (suite.device ? ` · ${htmlEsc(suite.device)}` : ''),
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
  <table class="tests">
    <thead><tr><th></th><th>Test</th><th>Steps</th><th>Repairs</th><th>Cost</th><th>Duration</th></tr></thead>
    <tbody>
${suite.tests.map((x) => suiteTestRow(x, linkBase)).join('\n')}
    </tbody>
  </table>
</div>
</body>
</html>
`;
}

export function toHtml(run: RunState): string {
  const c = counts(run);
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
  ].filter(Boolean);

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
  ${run.ai ? aiPanelHtml(run.ai) : ''}
  <ol class="steps">
    ${run.steps.map(stepHtml).join('\n    ')}
  </ol>
</div>
</body>
</html>
`;
}
