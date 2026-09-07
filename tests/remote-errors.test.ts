import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { describeStatus } from '../src/agent/remote';
import type { RpcErrorBody } from '../src/rpc';
import { CliError, NoWindowError, SelectorNotFoundError, AmbiguousSelectorError } from '../src/errors';

// How a `--server` client turns a non-2xx into an error. This is the boundary that used to
// destroy the thrown error's class: `/v1/exec` answers a failed step with a 200 carrying a
// full ErrorDescriptor, but every OTHER route answers with a status code and a
// `{error, exitCode}` body, so the client rebuilt a bare CliError from it.
//
// That is why issue #80 survived a fix to the engine alone: all 19 measured aborts were
// `--server` runs, where `e instanceof NoWindowError` was false no matter what the server
// had thrown.

const URL = 'http://host:8391/v1/elements';

test('describeStatus: a 500 carrying errorKind rebuilds the original class', () => {
  const body: RpcErrorBody = { error: 'No window to read: …', exitCode: 3, errorKind: 'NoWindowError' };
  const e = describeStatus(500, body, URL);
  assert.ok(e instanceof NoWindowError, 'the engine decides on this instanceof');
  assert.equal((e as CliError).exitCode, 3);
  assert.equal(e.message, 'No window to read: …', 'the server’s own message, unwrapped');
});

test('describeStatus: a selector error keeps its heal-trigger identity and exit code', () => {
  const miss = describeStatus(500, { error: "No element matched '@login'.", exitCode: 1, errorKind: 'SelectorNotFoundError' }, URL);
  assert.ok(miss instanceof SelectorNotFoundError);
  assert.equal((miss as CliError).exitCode, 1, 'not the HTTP class’s 3');

  const ambiguous = describeStatus(500, { error: "'@row' matched 3 elements.", exitCode: 2, errorKind: 'AmbiguousSelectorError' }, URL);
  assert.ok(ambiguous instanceof AmbiguousSelectorError);
  assert.equal((ambiguous as CliError).exitCode, 2);
});

test('describeStatus: no errorKind (an older server) behaves exactly as before', () => {
  // The compatibility half. Feature-detect on the FIELD: an old server and a new one with
  // nothing to classify send the same body, and both must keep the wrapped wording.
  const e = describeStatus(500, { error: 'boom', exitCode: 3 }, URL);
  assert.ok(e instanceof CliError);
  assert.equal(e instanceof NoWindowError, false);
  assert.equal((e as CliError).exitCode, 3);
  assert.match(e.message, /verikun server error 500 at http:\/\/host:8391\/v1\/elements: boom/);
});

test('describeStatus: a body-less failure still yields an exit code from the HTTP class', () => {
  assert.equal((describeStatus(400, null, URL) as CliError).exitCode, 2);
  assert.equal((describeStatus(404, null, URL) as CliError).exitCode, 2);
  assert.equal((describeStatus(413, null, URL) as CliError).exitCode, 2);
  assert.equal((describeStatus(500, null, URL) as CliError).exitCode, 3);
});

test('describeStatus: 401/409/503 keep their transport wording, kind or no kind', () => {
  // These describe the CONNECTION, not something a driver threw — a wrong key, a device
  // another run holds, nothing attached. Their text is what an operator acts on, so the
  // rebuild must not reach them even if a body somehow carries a kind.
  const auth = describeStatus(401, { error: 'nope', exitCode: 3, errorKind: 'NoWindowError' }, URL);
  assert.match(auth.message, /rejected the auth key \(401\)/);
  assert.equal(auth instanceof NoWindowError, false);

  assert.match(describeStatus(409, { error: 'held', exitCode: 3 }, URL).message, /device is busy \(409\)/);
  assert.match(describeStatus(503, { error: 'none', exitCode: 3 }, URL).message, /no device attached \(503\)/);
});

test('describeStatus: an unknown kind from a newer server degrades, it does not throw', () => {
  // rebuildError's switch has a default arm. A field we do not recognise must read as a
  // plain error rather than crash the client parsing its own transport.
  const e = describeStatus(500, { error: 'from the future', exitCode: 3, errorKind: 'SomethingNew' as never }, URL);
  assert.equal(e.message, 'from the future');
});
