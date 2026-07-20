import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { commandExists } from '../src/exec';

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
