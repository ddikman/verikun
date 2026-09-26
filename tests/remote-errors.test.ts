import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteBackend, describeStatus, poolNote, transportReason } from '../src/agent/remote';
import type { RpcErrorBody } from '../src/rpc';
import {
  CliError, DumpKilledError, NoWindowError, NoFreeDeviceError, RunEvictedError, SelectorNotFoundError, AmbiguousSelectorError,
} from '../src/errors';

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

test('describeStatus: a killed dump rebuilds as its own class, not a bare CliError', () => {
  // The half of #80 that #137 inherits: without this the pooled-server runs where #137 was
  // measured would see an anonymous exit-3 and abort instead of polling through.
  const body: RpcErrorBody = { error: 'The UI hierarchy dump was killed …', exitCode: 3, errorKind: 'DumpKilledError' };
  const e = describeStatus(500, body, URL);
  assert.ok(e instanceof DumpKilledError, 'readForPoll and the guard grace both decide on this');
  assert.equal((e as CliError).exitCode, 3);
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

const LEASE_URL = 'http://host:8391/v1/lease';

test('describeStatus: a refused LEASE is a NoFreeDeviceError — the run never started (#147)', () => {
  // On the lease route both answers mean "no device for a new run right now": every device
  // leased (409) or none serving (503). A parallel suite hands such a test back to its
  // queue instead of recording a failure for a test that never ran — but only if it can
  // tell this apart from a device that broke, which is what the class is for.
  const busy = describeStatus(409, { error: 'all 2 devices are leased by other active runs — retry when one finishes', exitCode: 3 }, LEASE_URL, { lease: true });
  assert.ok(busy instanceof NoFreeDeviceError);
  assert.equal((busy as CliError).exitCode, 3, 'still an environment exit');
  assert.match(busy.message, /device is busy \(409\): all 2 devices are leased/, 'the transport wording is kept');

  const empty = describeStatus(503, { error: 'this verikun server has no device left to serve', exitCode: 3 }, LEASE_URL, { lease: true });
  assert.ok(empty instanceof NoFreeDeviceError);
  assert.match(empty.message, /no device attached \(503\)/);

  // A fresh run token cannot have been evicted, so on this route a tag changes nothing.
  const tagged = describeStatus(409, { error: 'x', exitCode: 3, errorKind: 'RunEvictedError' }, LEASE_URL, { lease: true });
  assert.ok(tagged instanceof NoFreeDeviceError);
});

test('describeStatus: a 409 the server TAGGED as an eviction is a RunEvictedError', () => {
  const e = describeStatus(
    409,
    { error: 'this run lost its device: a left the pool — this one cannot continue on another device', exitCode: 3, errorKind: 'RunEvictedError' },
    URL,
  );
  assert.ok(e instanceof RunEvictedError);
  assert.equal((e as CliError).exitCode, 3);
  assert.match(e.message, /a left the pool/, "the server's reason survives");
  assert.doesNotMatch(e.message, /busy/, 'nothing was busy — the run lost its phone');
});

test('describeStatus: an untagged 409 off the lease route stays a plain CliError', () => {
  // An OLDER server tags nothing, and its evictions must stay ordinary attempts rather than
  // be guessed at from the wording. And a 409 honours ONLY the eviction tag: any other kind a
  // body carries is ignored, as it always was.
  for (const body of [
    { error: 'the device this run was using left the pool', exitCode: 3 },
    { error: 'held', exitCode: 3, errorKind: 'NoWindowError' as const },
  ]) {
    const e = describeStatus(409, body, URL);
    assert.equal(e instanceof RunEvictedError, false);
    assert.equal(e instanceof NoFreeDeviceError, false);
    assert.equal(e instanceof NoWindowError, false);
    assert.match(e.message, /device is busy \(409\)/);
  }
  assert.equal(describeStatus(503, { error: 'none', exitCode: 3 }, URL) instanceof NoFreeDeviceError, false);
});

test('a remote backend tells a refused lease from an evicted step by the ROUTE it hit', async () => {
  // The wiring half: `request()` has to know which call it is making. A 409 on /v1/lease is
  // a run that never started; the same status on /v1/exec is one that lost its device.
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const evicted = req.url === '/v1/exec';
      const body = JSON.stringify(
        evicted
          ? { error: 'this run lost its device: a left the pool', exitCode: 3, errorKind: 'RunEvictedError' }
          : { error: 'all 2 devices are leased by other active runs', exitCode: 3 },
      );
      res.writeHead(409, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const backend = createRemoteBackend(
      { url: base },
      {
        ok: true, version: 'test', platform: 'android', serial: null, capacity: 1, devices: ['b'], installEnabled: false,
        quarantined: [{ serial: 'a', reason: 'the device is not attached' }],
      },
    );
    await assert.rejects(
      () => backend.lease(),
      (e: unknown) =>
        e instanceof NoFreeDeviceError &&
        // …and says which phone is missing and why, from the health read on the way in.
        /ruled out: a \(the device is not attached\)/.test(e.message),
    );
    assert.equal(backend.wasEvicted?.(), false, 'a refused lease is not an eviction');
    await assert.rejects(() => backend.exec('tap', ['@go'], {}), (e: unknown) => e instanceof RunEvictedError);
    // Remembered: the step that died with the phone never hears it, only a later request does.
    assert.equal(backend.wasEvicted?.(), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('poolNote: names the devices a server is serving and the ones it ruled out, with the reason', () => {
  const health = {
    ok: true, version: 't', platform: 'android' as const, serial: null, installEnabled: false,
    capacity: 1, devices: ['b-serial'], quarantined: [{ serial: 'a-serial', reason: 'the device is not attached' }],
  };
  const note = poolNote(health);
  assert.match(note, /\b1 serving/);
  assert.match(note, /b-serial/);
  assert.match(note, /a-serial \(the device is not attached\)/, "the shed phone is named, with the server's reason");
  const empty = poolNote({ ...health, capacity: 0, devices: [], quarantined: undefined });
  assert.match(empty, /\b0 serving/);
  assert.doesNotMatch(empty, /ruled out/, 'nothing ruled out, nothing said');
});

test('a remote backend remembers an eviction the server marked on a FAILING step or read', async () => {
  // The failing step is the only response that knows the run is over: it is a 200 carrying the
  // phone's own error, and the client's next request is usually a release, which clears the
  // server's mark. So the mark on the response itself is latched (#147).
  const deviceError = { kind: 'CliError', name: 'CliError', message: "adb: device 'a' not found", exitCode: 3 };
  let marked = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.url === '/v1/exec') return send(200, { code: 3, error: deviceError, ...(marked ? { evicted: true } : {}) });
      return send(500, { error: deviceError.message, exitCode: 3, errorKind: 'CliError', evicted: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const health = { ok: true, version: 'test', platform: 'android' as const, serial: null, capacity: 2, installEnabled: false };
  try {
    const plain = createRemoteBackend({ url }, health);
    assert.equal((await plain.exec('tap', ['@go'], {})).code, 3);
    assert.equal(plain.wasEvicted?.(), false, 'an ordinary failed step is not an eviction');

    marked = true;
    const onStep = createRemoteBackend({ url }, health);
    assert.equal((await onStep.exec('tap', ['@go'], {})).code, 3, "the step keeps the phone's own verdict");
    assert.equal(onStep.wasEvicted?.(), true);

    const onRead = createRemoteBackend({ url }, health);
    await assert.rejects(async () => onRead.getElements(), (e: unknown) => e instanceof CliError && !(e instanceof RunEvictedError));
    assert.equal(onRead.wasEvicted?.(), true, 'the error body carries it too');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('describeStatus: an unknown kind from a newer server degrades, it does not throw', () => {
  // rebuildError's switch has a default arm. A field we do not recognise must read as a
  // plain error rather than crash the client parsing its own transport.
  const e = describeStatus(500, { error: 'from the future', exitCode: 3, errorKind: 'SomethingNew' as never }, URL);
  assert.equal(e.message, 'from the future');
});

// --- transportReason --------------------------------------------------------
//
// The OTHER half of the boundary: a request that never produced a status at all. Node's
// global fetch reports its own header/body timeouts as a bare `TypeError: fetch failed`
// with the cause one level down — indistinguishable, in the message, from a server that is
// genuinely unreachable. That is how a five-minute install came to read as a dead phone.

test('transportReason: the caller aborting names its own budget', () => {
  const e = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.equal(transportReason(e, 90_000), 'timed out after 90s');
});

test("transportReason: undici's header timeout says whose clock ran out", () => {
  // MEASURED on Node v20.20.2: a server holding its headers for 310s rejects the fetch at
  // 301s with exactly this shape, whatever the caller's AbortController was set to.
  const e = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
  });
  const reason = transportReason(e, 15 * 60_000);
  assert.match(reason, /300s/, "the REAL ceiling, not the caller's 900s");
  assert.match(reason, /CLIENT, not the device/, 'the whole point: do not blame the phone');
  assert.doesNotMatch(reason, /^fetch failed$/);
});

test('transportReason: a body timeout is named separately from a header one', () => {
  const e = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }),
  });
  assert.match(transportReason(e, 60_000), /finish its response/);
});

test('transportReason: anything else is passed through untouched', () => {
  // A genuinely unreachable server must keep reading as one — this may not become a
  // catch-all that blames Node for every connection error.
  const e = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4400'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(transportReason(e, 10_000), 'fetch failed');
  assert.equal(transportReason(new Error('socket hang up'), 10_000), 'socket hang up');
});

test('remote install uses the long-running HTTP transport, not fetch\'s 300s ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-remote-install-'));
  const app = join(dir, 'app.apk');
  writeFileSync(app, 'APKBYTES');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify({ ok: true, bytes: 8, sha256: 'test', devices: ['device-a'] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('install must not call fetch'); }) as typeof fetch;
  try {
    const backend = createRemoteBackend(
      { url: base },
      { ok: true, version: 'test', platform: 'android', serial: 'device-a', installEnabled: true },
    );
    await backend.install(app);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
