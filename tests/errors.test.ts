import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CliError, usageError, notFound, envError, isEnvError, SelectorNotFoundError, AmbiguousSelectorError } from '../src/errors';

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

test('isEnvError: true only for exit 3 — "the box is broken", not "the app is"', () => {
  assert.equal(isEnvError(envError('idb not on PATH')), true);
  assert.equal(isEnvError(new CliError('boom', 3)), true);
});

test('isEnvError: false for every other failure shape', () => {
  // Exit 1/2 are the app's problem (assertion, selector) — never an env abort.
  assert.equal(isEnvError(notFound('x')), false);
  assert.equal(isEnvError(usageError('x')), false);
  // The selector heal-trigger subclasses must not be swept up: healing them is the
  // whole point, and classifying them as env would abort the run instead.
  assert.equal(isEnvError(new SelectorNotFoundError('miss')), false);
  assert.equal(isEnvError(new AmbiguousSelectorError('ambiguous', [])), false);
  // Non-CliError inputs (catch bindings are `unknown`) must not throw.
  assert.equal(isEnvError(new Error('plain')), false);
  assert.equal(isEnvError(undefined), false);
  assert.equal(isEnvError(null), false);
  assert.equal(isEnvError('idb not found'), false);
});
