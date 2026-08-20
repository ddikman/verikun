import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { commandExists, spawnCollect } from '../src/exec';

// commandExists is a pure PATH scan (no spawn) used to decide a CLI provider is available.
// `node` is guaranteed present when the test runner is running, so it is a safe positive.

test('commandExists: finds a binary that is on PATH', () => {
  assert.equal(commandExists('node'), true);
});

test('commandExists: returns false for a binary that is not on PATH', () => {
  assert.equal(commandExists('definitely-not-a-real-binary-xyz-123'), false);
});

test('commandExists: an absolute path to a non-file is false', () => {
  assert.equal(commandExists('/definitely/not/here/nope'), false);
});

// --- spawnCollect -----------------------------------------------------------

test('spawnCollect: captures stdout and streams stderr line-by-line', async () => {
  const lines: string[] = [];
  const r = await spawnCollect(
    process.execPath,
    ['-e', 'process.stdout.write("{\\"ok\\":true}"); process.stderr.write("a\\nb\\n"); process.exit(3)'],
    { onStderrLine: (l) => lines.push(l) },
  );
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '{"ok":true}');
  assert.deepEqual(lines, ['a', 'b']);
  assert.equal(r.stderr, 'a\nb\n');
});

test('spawnCollect: a trailing partial stderr line is still reported', async () => {
  // A child that dies mid-line must not swallow what it managed to say — that is
  // usually the reason it died.
  const lines: string[] = [];
  const r = await spawnCollect(process.execPath, ['-e', 'process.stderr.write("no newline")'], {
    onStderrLine: (l) => lines.push(l),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(lines, ['no newline']);
});

test('spawnCollect: a missing binary is a failed lane, not a thrown suite', async () => {
  const r = await spawnCollect('vk-definitely-not-a-real-binary-9d2f', []);
  assert.equal(r.code, 127);
  assert.match(r.stderr, /not found on PATH/);
});

test('spawnCollect: env overrides reach the child', async () => {
  const r = await spawnCollect(process.execPath, ['-e', 'process.stdout.write(process.env.VERIKUN_LANE ?? "")'], {
    env: { ...process.env, VERIKUN_LANE: 'l7' },
  });
  assert.equal(r.stdout, 'l7');
});
