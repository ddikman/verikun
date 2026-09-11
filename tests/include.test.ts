import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveIncludes, hasInstruction, statesInstruction, segmentLabel } from '../src/agent/include';
import { CliError } from '../src/errors';

// A fake filesystem: `@include` resolution is pure path arithmetic plus one read, so the
// resolver takes its reader as a parameter and the bulk of the suite needs no disk.
function fs(files: Record<string, string>): (p: string) => string {
  return (p: string) => {
    const key = p.startsWith(process.cwd()) ? p.slice(process.cwd().length + 1) : p;
    if (!(key in files)) throw new Error(`ENOENT: no such file, open '${p}'`);
    return files[key];
  };
}

/** The CliError a call threw — failing the test if it did not throw one. */
function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error('expected a CliError, but the call returned');
}

// --- resolution -------------------------------------------------------------

test('resolveIncludes: a test with no includes is one segment, text unchanged', () => {
  const { nl, segments } = resolveIncludes('t.md', fs({ 't.md': '1. Tap Login\n2. Confirm home\n' }));
  assert.equal(nl, '1. Tap Login\n2. Confirm home\n');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startLine, 1);
  assert.equal(segments[0].compilable, true);
});

test('resolveIncludes: @include splices the fragment in place, in file order', () => {
  const { nl } = resolveIncludes(
    't.md',
    fs({ 't.md': '# Buy a widget\n@include _preamble.md\n3. Tap Buy\n', '_preamble.md': '1. Launch\n2. Sign in\n' }),
  );
  assert.equal(nl, '# Buy a widget\n1. Launch\n2. Sign in\n3. Tap Buy\n');
});

test('resolveIncludes: each chunk is its own segment, tagged with its source file and line', () => {
  const { segments } = resolveIncludes(
    't.md',
    fs({ 't.md': '# Buy a widget\n@include _preamble.md\n3. Tap Buy\n', '_preamble.md': '1. Launch\n2. Sign in\n' }),
  );
  assert.deepEqual(
    segments.map((s) => [segmentLabel(s), s.text]),
    [
      ['t.md:1', '# Buy a widget\n'],
      ['_preamble.md:1', '1. Launch\n2. Sign in\n'],
      ['t.md:3', '3. Tap Buy\n'],
    ],
  );
});

test('resolveIncludes: a path is relative to the INCLUDING file, not the cwd', () => {
  const { nl } = resolveIncludes(
    'suite/t.md',
    fs({ 'suite/t.md': '@include shared/_preamble.md\n', 'suite/shared/_preamble.md': '1. Launch\n' }),
  );
  assert.equal(nl, '1. Launch\n');
});

test('resolveIncludes: a fragment may include another fragment', () => {
  const { nl, segments } = resolveIncludes(
    't.md',
    fs({ 't.md': '@include _a.md\n9. Done\n', '_a.md': '1. Launch\n@include _b.md\n', '_b.md': '2. Sign in\n' }),
  );
  assert.equal(nl, '1. Launch\n2. Sign in\n9. Done\n');
  assert.deepEqual(segments.map((s) => segmentLabel(s)), ['_a.md:1', '_b.md:1', 't.md:2']);
});

test('resolveIncludes: the same fragment may be included twice (a diamond is not a cycle)', () => {
  const { nl } = resolveIncludes(
    't.md',
    fs({ 't.md': '@include _a.md\n2. Middle\n@include _a.md\n', '_a.md': '1. Launch\n' }),
  );
  assert.equal(nl, '1. Launch\n2. Middle\n1. Launch\n');
});

test('resolveIncludes: an include CYCLE is exit 2 naming the chain, not an OOM', () => {
  const e = caught(() => resolveIncludes('t.md', fs({ 't.md': '@include _a.md\n', '_a.md': '@include t.md\n' })));
  assert.equal(e.exitCode, 2);
  assert.match(e.message, /include cycle/);
  assert.match(e.message, /t\.md → _a\.md → t\.md/);
});

test('resolveIncludes: a missing fragment names the file that asked for it, and its line', () => {
  const e = caught(() => resolveIncludes('t.md', fs({ 't.md': '1. Launch\n@include _gone.md\n' })));
  assert.equal(e.exitCode, 2);
  assert.match(e.message, /included from t\.md:2/);
});

test('resolveIncludes: @include inside a code fence is documentation, not a directive', () => {
  const { nl } = resolveIncludes(
    't.md',
    fs({ 't.md': 'Write:\n\n```\n@include _preamble.md\n```\n\n1. Tap Buy\n', '_preamble.md': 'SHOULD NOT APPEAR\n' }),
  );
  assert.match(nl, /@include _preamble\.md/);
  assert.doesNotMatch(nl, /SHOULD NOT APPEAR/);
});

test('resolveIncludes: an include ends its chunk, so a fragment cannot glue onto the line above', () => {
  const { nl } = resolveIncludes(
    't.md',
    fs({ 't.md': 'Given the app is installed:\n@include _p.md', '_p.md': '1. Launch' }),
  );
  assert.equal(nl, 'Given the app is installed:\n1. Launch\n');
});

// --- hasInstruction (which chunks are worth a model call) -------------------

test('hasInstruction: a headings-only chunk compiles to nothing, so it is never sent', () => {
  assert.equal(hasInstruction('# Login smoke test\n\n## Sign in\n'), false);
  assert.equal(hasInstruction('---\n'), false);
  assert.equal(hasInstruction('<!-- a note to the reader -->\n'), false);
});

test('hasInstruction: anything with a sentence in it IS compiled — skipping prose would lose steps', () => {
  assert.equal(hasInstruction('# Title\n\n1. Tap Login\n'), true);
  assert.equal(hasInstruction('> Dismiss the rating prompt if it appears.\n'), true);
  assert.equal(hasInstruction('This test signs in and buys a widget.\n'), true);
});

// --- descriptions (prose that states no step is folded, never compiled alone) #133 -------

test('statesInstruction: a title and a summary of what the test checks state no step', () => {
  assert.equal(statesInstruction('# Device-state smoke test\n'), false);
  assert.equal(statesInstruction('Checks that the settings screen opens and closes cleanly.\n'), false);
  assert.equal(statesInstruction('This test signs in, sends a message, then ends and returns home.\n'), false);
});

test('statesInstruction: a list item of ANY kind, or a verb anywhere in the line, IS a step', () => {
  // Each of these scores ZERO with lint.ts's instructionUnits, whose undercount is safe where
  // it is used and would be a moved step here. That is why this asks for positive evidence.
  assert.equal(statesInstruction('- Launch the app with its data cleared.\n'), true);
  assert.equal(statesInstruction('1. Tap Login\n'), true);
  assert.equal(statesInstruction('First, launch the app.\n'), true);
  assert.equal(statesInstruction('The fixture app is `x`. Open it and wait for the home screen.\n'), true);
});

test('statesInstruction: a fenced block is shown, not performed', () => {
  assert.equal(statesInstruction('Checks the output.\n\n```\nvk tap @login\n```\n'), false);
});

test('resolveIncludes: a description above an include folds into the file’s own next chunk', () => {
  const { segments } = resolveIncludes(
    't.md',
    fs({
      't.md': '# Buy a widget\n\nChecks that a widget can be bought.\n\n@include _p.md\n\n1. Tap Buy\n',
      '_p.md': '1. Launch\n',
    }),
  );
  assert.deepEqual(
    segments.map((s) => [segmentLabel(s), s.text]),
    [
      ['_p.md:1', '1. Launch\n'],
      ['t.md:1', '# Buy a widget\n\nChecks that a widget can be bought.\n\n1. Tap Buy\n'],
    ],
  );
});

test('resolveIncludes: folding a description leaves the fragment above it untouched', () => {
  // The reason the host must be the SAME FILE: a fragment shared by nine tests keeps ONE cache
  // key only while its text is byte-identical in all nine.
  const withDesc = resolveIncludes(
    'a.md',
    fs({ 'a.md': 'Checks the widget.\n@include _p.md\n1. Tap Buy\n', '_p.md': '1. Launch\n' }),
  );
  const without = resolveIncludes('b.md', fs({ 'b.md': '@include _p.md\n1. Tap Buy\n', '_p.md': '1. Launch\n' }));
  assert.equal(withDesc.segments[0].text, without.segments[0].text);
});

test('resolveIncludes: a description with no later chunk of its own file folds backward', () => {
  const { segments } = resolveIncludes(
    't.md',
    fs({ 't.md': '1. Tap Buy\n@include _p.md\nChecks the receipt is shown.\n', '_p.md': '1. Launch\n' }),
  );
  assert.deepEqual(
    segments.map((s) => [segmentLabel(s), s.text]),
    [
      ['t.md:1', '1. Tap Buy\nChecks the receipt is shown.\n'],
      ['_p.md:1', '1. Launch\n'],
    ],
  );
});

test('resolveIncludes: a CHAIN of descriptions keeps the order the author wrote them', () => {
  const { segments } = resolveIncludes(
    't.md',
    fs({
      't.md': 'Alpha.\n@include _p.md\nBravo.\n@include _q.md\n1. Tap Buy\nCharlie.\n@include _r.md\nDelta.\n',
      '_p.md': '1. One\n',
      '_q.md': '1. Two\n',
      '_r.md': '1. Three\n',
    }),
  );
  const own = segments.find((s) => s.source.endsWith('t.md'));
  assert.equal(own?.text, 'Alpha.\nBravo.\n1. Tap Buy\nCharlie.\nDelta.\n');
  assert.equal(segmentLabel(own!), 't.md:1');
});

test('resolveIncludes: a file that states no step anywhere keeps its description as it was', () => {
  // No third disposition: a chunk this pass cannot place is left exactly where it was, rather
  // than dropped. Prose it discarded would be prose the model never sees.
  const { segments } = resolveIncludes(
    't.md',
    fs({ 't.md': '# Smoke\n\nChecks the whole flow.\n\n@include _p.md\n', '_p.md': '1. Launch\n' }),
  );
  assert.deepEqual(segments.map((s) => [segmentLabel(s), s.compilable]), [['t.md:1', true], ['_p.md:1', true]]);
});

test('resolveIncludes: a fragment included twice stays byte-identical in both places', () => {
  // The reason a chunk carries an EXPANSION id and not just a path: matching on `source` alone
  // would let the first copy's trailing description reach across into the second copy.
  const { segments } = resolveIncludes(
    't.md',
    fs({
      't.md': '@include _p.md\n1. Middle\n@include _p.md\n',
      '_p.md': '1. Launch\n@include _q.md\nChecks it landed.\n',
      '_q.md': '1. Sign in\n',
    }),
  );
  const copies = segments.filter((s) => s.source.endsWith('_p.md'));
  assert.equal(copies.length, 2);
  assert.equal(copies[0].text, copies[1].text);
  assert.equal(copies[0].text, '1. Launch\nChecks it landed.\n');
});

test('resolveIncludes: a headings-only chunk is still skipped, not folded', () => {
  const { segments } = resolveIncludes(
    't.md',
    fs({ 't.md': '# Title\n\n@include _p.md\n\n1. Tap Buy\n', '_p.md': '1. Launch\n' }),
  );
  assert.deepEqual(
    segments.map((s) => [segmentLabel(s), s.compilable]),
    [['t.md:1', false], ['_p.md:1', true], ['t.md:5', true]],
  );
});

test('resolveIncludes: folding never changes the resolved text, which is the cache key', () => {
  const { nl } = resolveIncludes(
    't.md',
    fs({ 't.md': 'Checks a widget can be bought.\n@include _p.md\n1. Tap Buy\n', '_p.md': '1. Launch\n' }),
  );
  assert.equal(nl, 'Checks a widget can be bought.\n1. Launch\n1. Tap Buy\n');
});

// --- against a real filesystem ---------------------------------------------

test('resolveIncludes: reads real files, relative to the including file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-include-'));
  try {
    mkdirSync(join(dir, 'shared'));
    writeFileSync(join(dir, 'shared', '_preamble.md'), '1. Launch the app\n');
    writeFileSync(join(dir, 'login.md'), '# Login\n@include shared/_preamble.md\n2. Tap Login\n');
    const { nl, segments } = resolveIncludes(join(dir, 'login.md'));
    assert.equal(nl, '# Login\n1. Launch the app\n2. Tap Login\n');
    assert.equal(segments[1].source, resolve(dir, 'shared', '_preamble.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('resolveIncludes: the shipped device-state example no longer compiles its summary alone (#133)', () => {
  // The repo's own instance of the reported shape — a title and a summary above the first
  // `@include`. Kept as written, so this stays a live fixture rather than a synthetic one.
  const { segments } = resolveIncludes('example/example-test-devicestate.md');
  assert.equal(segments.length, 2, 'the title and summary folded into the test’s own chunk');
  assert.match(segments[0].source, /_launch-to-home\.md$/);
  assert.equal(segmentLabel(segments[1]), 'example/example-test-devicestate.md:1');
  assert.ok(
    segments[1].text.startsWith('# Device-state smoke test'),
    'the summary is context for the steps it describes, not a test of its own',
  );
});

test('resolveIncludes: the login example, which never had the broken shape, is unchanged', () => {
  const { segments } = resolveIncludes('example/example-test.md');
  assert.deepEqual(segments.map((s) => s.compilable), [false, true, true]);
  assert.equal(segmentLabel(segments[0]), 'example/example-test.md:1');
});
