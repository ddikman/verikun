// Custom reporter for Node's built-in test runner (`node --test --test-reporter
// ./scripts/github-test-summary.mjs`). It renders the run as a GitHub-flavored
// markdown summary — a totals line, any failures with their message, and a
// collapsible list of every test — which CI appends to $GITHUB_STEP_SUMMARY so a
// formatted test list shows on the Actions run page instead of a raw log dump.
//
// Why a reporter and not a post-hoc parse of the JUnit XML: the event stream
// hands us the real test names and error messages as plain JS strings, whereas
// Node's JUnit output escapes (and, for quotes, double-escapes) punctuation in a
// lossy way — e.g. a test literally named `<failure type="AssertionFailure">`
// round-trips correctly here but not through the XML. It is plain ESM with zero
// dependencies on purpose: `node --test` loads the reporter module directly, so
// it does not go through this repo's tsc build.

export default async function* githubTestSummary(source) {
  const tests = [];
  let totalDurationMs = 0;

  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    // Only leaf tests carry a real result; skip `describe()` suite nodes. (This
    // suite is flat — every test is nesting 0 — but guard anyway.)
    if (data.details?.type === 'suite') continue;
    const failed = event.type === 'test:fail';
    totalDurationMs += data.details?.duration_ms ?? 0;
    tests.push({
      name: data.name,
      failed,
      message: failed ? firstLineOfError(data.details?.error) : '',
    });
  }

  const failures = tests.filter((t) => t.failed);
  const passed = tests.length - failures.length;
  const icon = failures.length ? '❌' : '✅';
  const label = process.env.TEST_SUMMARY_LABEL ? ` — ${process.env.TEST_SUMMARY_LABEL}` : '';

  let md = `## ${icon} Unit tests${label}\n\n`;
  const passText = failures.length ? `${passed} passed` : `**${passed} passed**`;
  const failText = failures.length ? `**${failures.length} failed**` : '0 failed';
  md += `${passText} · ${failText} · ${tests.length} total · ${Math.round(totalDurationMs)} ms\n`;

  if (failures.length) {
    md += '\n### Failures\n\n';
    for (const t of failures) {
      md += `- ❌ ${mdEscape(t.name)}${t.message ? ` — ${inlineCode(t.message)}` : ''}\n`;
    }
  }

  md += `\n<details><summary>All ${tests.length} tests</summary>\n\n`;
  for (const t of tests) {
    md += `- ${t.failed ? '❌' : '✅'} ${mdEscape(t.name)}\n`;
  }
  md += '\n</details>\n';

  yield md;
}

// node:test wraps the thrown assertion error in error.cause; surface a single
// concise line for the summary.
function firstLineOfError(error) {
  if (!error) return '';
  const msg = error.cause?.message ?? error.message ?? String(error);
  return String(msg).split('\n')[0].trim();
}

// Test names can contain markdown-significant punctuation (e.g. `<failure
// type=...>`, backticks, pipes); escape the few characters that would otherwise
// corrupt a bullet line or be parsed as inline HTML.
function mdEscape(s) {
  return String(s).replace(/[\\`*_<>|]/g, (c) => '\\' + c);
}

// Render a failure message as inline code, widening the fence if it itself
// contains a backtick.
function inlineCode(s) {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}
