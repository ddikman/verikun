import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describeError, rebuildError } from '../src/rpc';
import type { ExecResponse, RpcErrorBody } from '../src/rpc';
import {
  DeviceGoneError, DeviceUnresponsiveError, UnsupportedOnPlatformError, ServerUnreachableError,
  CliError, SelectorNotFoundError, AmbiguousSelectorError, DumpKilledError, NoWindowError, NoFreeDeviceError, RunEvictedError,
  dumpKilledMessage, isEnvError, envError,
} from '../src/errors';
import { makeEl } from './helpers';

// The error codec is what lets the `vk ai` engine keep its heal-vs-terminal
// decision working over the wire: engine.ts checks `instanceof
// SelectorNotFoundError / AmbiguousSelectorError` and reads `.candidates` /
// `.exitCode`. Every test round-trips through JSON (like the real HTTP body)
// so a non-serializable field can't sneak through.

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

for (const ErrorClass of [DeviceGoneError, DeviceUnresponsiveError, UnsupportedOnPlatformError, ServerUnreachableError]) {
  test(`${ErrorClass.name} survives the RPC boundary as a terminal exit-3 sibling`, () => {
    const original = new ErrorClass('specific failure');
    const rebuilt = rebuildError(wire(describeError(original)));
    assert.ok(rebuilt instanceof ErrorClass);
    assert.ok(!(rebuilt instanceof NoWindowError));
    assert.equal((rebuilt as CliError).exitCode, 3);
    assert.equal(rebuilt.message, original.message);
  });
}

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

test('rpc codec: an env error is still classified as env after the round-trip', () => {
  // The remote path must reach the SAME abort decision as local: `vk suite --server`
  // relies on this to stop when the server's device disappears.
  const rebuilt = rebuildError(wire(describeError(envError("'idb' was not found on PATH."))));
  assert.equal(isEnvError(rebuilt), true);
  assert.equal(isEnvError(rebuildError(wire(describeError(new SelectorNotFoundError('miss'))))), false);
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


test('rpc codec: NoWindowError survives — it must not flatten into a bare CliError', () => {
  // describeError checks this subclass BEFORE the CliError arm; swap the order and this is
  // the test that notices. Losing the class means the `vk ai` guard stops riding it out
  // (issue #80).
  const rebuilt = rebuildError(wire(describeError(new NoWindowError())));
  assert.ok(rebuilt instanceof NoWindowError, 'instanceof NoWindowError');
  assert.ok(rebuilt instanceof CliError, 'still a CliError');
  assert.equal((rebuilt as CliError).exitCode, 3, 'a caller with no budget still exits 3');
  assert.equal(isEnvError(rebuilt), true);
});

test('rpc codec: DumpKilledError survives, and does not flatten into NoWindowError', () => {
  // Issue #137 was reported through a POOLED vk server, so the whole fix crosses this wire.
  // Both arms sit before the CliError one; collapsing them would cost the killed dump its
  // ride-out on exactly the setup it was reported from.
  const rebuilt = rebuildError(wire(describeError(new DumpKilledError(dumpKilledMessage('Killed')))));
  assert.ok(rebuilt instanceof DumpKilledError, 'instanceof DumpKilledError');
  assert.equal(rebuilt instanceof NoWindowError, false, 'a sibling, not the same signal');
  assert.equal((rebuilt as CliError).exitCode, 3);
  assert.match(rebuilt.message, /\(Killed\)$/, 'the device evidence rides along, unwrapped');
});

test('rpc codec: a refused lease and an eviction keep their classes, and stay exit 3', () => {
  // A parallel suite reads these across a process boundary (`errorKind` in a lane child's
  // --json) to decide "never ran — hand it back" vs "evicted — re-run it without spending a
  // retry". Flattened into a bare CliError, both read as an ordinary environment failure,
  // which is exactly the cascade of issue #147.
  const refused = rebuildError(wire(describeError(new NoFreeDeviceError('verikun server device is busy (409): all 2 devices are leased'))));
  assert.ok(refused instanceof NoFreeDeviceError, 'instanceof NoFreeDeviceError');
  assert.equal(refused instanceof RunEvictedError, false);
  const evicted = rebuildError(wire(describeError(new RunEvictedError('verikun server ended this run (409): a left the pool'))));
  assert.ok(evicted instanceof RunEvictedError, 'instanceof RunEvictedError');
  assert.equal(evicted instanceof NoFreeDeviceError, false);
  for (const e of [refused, evicted]) {
    assert.equal((e as CliError).exitCode, 3, 'the exit-code contract does not move');
    assert.equal(isEnvError(e), true);
  }
});

test('rpc wire: errorKind is optional on an error body — old servers simply omit it', () => {
  // Same standing rule as deviceChanged: feature-detect on the FIELD. An older server sends
  // no kind, and the client must fall back to its previous behaviour rather than fail.
  const oldServer: RpcErrorBody = { error: 'boom', exitCode: 3 };
  assert.equal(oldServer.errorKind, undefined);

  const classed: RpcErrorBody = { error: 'no window', exitCode: 3, errorKind: 'NoWindowError' };
  assert.equal(classed.errorKind, 'NoWindowError');
  // And the field is exactly what rebuildError consumes, so the two cannot drift apart.
  const rebuilt = rebuildError({ kind: classed.errorKind!, name: 'NoWindowError', message: classed.error, exitCode: 3 });
  assert.ok(rebuilt instanceof NoWindowError);
});
