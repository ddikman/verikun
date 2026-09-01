import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveIncludes, hasInstruction, segmentLabel } from '../src/agent/include';
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
