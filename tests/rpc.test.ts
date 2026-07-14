import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describeError, rebuildError } from '../src/rpc';
import { CliError, SelectorNotFoundError, AmbiguousSelectorError } from '../src/errors';
import { makeEl } from './helpers';

// The error codec is what lets the `vk ai` engine keep its heal-vs-terminal
// decision working over the wire: engine.ts checks `instanceof
// SelectorNotFoundError / AmbiguousSelectorError` and reads `.candidates` /
// `.exitCode`. Every test round-trips through JSON (like the real HTTP body)
// so a non-serializable field can't sneak through.

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('rpc codec: SelectorNotFoundError survives with class + exit code', () => {
  const original = new SelectorNotFoundError("No element matched selector '@login'.");
  const rebuilt = rebuildError(wire(describeError(original)));
  assert.ok(rebuilt instanceof SelectorNotFoundError, 'instanceof SelectorNotFoundError');
  assert.ok(rebuilt instanceof CliError, 'still a CliError');
  assert.equal((rebuilt as CliError).exitCode, 1);
  assert.equal(rebuilt.message, original.message);
});

test('rpc codec: AmbiguousSelectorError keeps its candidates', () => {
  const candidates = [
    makeEl({ index: 3, idShort: 'login', text: 'Log in' }),
    makeEl({ index: 7, idShort: 'login_alt', text: 'Log in with email' }),
  ];
  const original = new AmbiguousSelectorError("Selector 'text:log in' matched 2 elements.", candidates);
  const rebuilt = rebuildError(wire(describeError(original)));
  assert.ok(rebuilt instanceof AmbiguousSelectorError);
  assert.equal((rebuilt as CliError).exitCode, 2);
  const got = (rebuilt as AmbiguousSelectorError).candidates;
  assert.equal(got.length, 2);
  assert.equal(got[0].idShort, 'login');
  assert.equal(got[1].text, 'Log in with email');
});

test('rpc codec: a plain CliError keeps its exact exit code', () => {
  for (const code of [1, 2, 3]) {
    const rebuilt = rebuildError(wire(describeError(new CliError(`env ${code}`, code))));
    assert.ok(rebuilt instanceof CliError);
    assert.ok(!(rebuilt instanceof SelectorNotFoundError), 'must not upgrade to a heal trigger');
    assert.ok(!(rebuilt instanceof AmbiguousSelectorError), 'must not upgrade to a heal trigger');
    assert.equal((rebuilt as CliError).exitCode, code);
  }
});

test('rpc codec: a non-CliError throw maps to a plain Error (exit 3 semantics)', () => {
  const d = wire(describeError(new TypeError('boom')));
  assert.equal(d.kind, 'Error');
  assert.equal(d.exitCode, 3);
  const rebuilt = rebuildError(d);
  assert.ok(!(rebuilt instanceof CliError));
  assert.equal(rebuilt.name, 'TypeError');
  assert.equal(rebuilt.message, 'boom');
});
