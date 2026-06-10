import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CliError, usageError, notFound, envError } from '../src/errors';

test('CliError: carries the exit code and is a real Error', () => {
  const e = new CliError('boom', 2);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CliError');
  assert.equal(e.message, 'boom');
  assert.equal(e.exitCode, 2);
});

test('error helpers map to the documented exit codes', () => {
  assert.equal(usageError('x').exitCode, 2);
  assert.equal(notFound('x').exitCode, 1);
  assert.equal(envError('x').exitCode, 3);
});
