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
  assert.ok(tagged instanceof RunEvictedError);
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
      { deviceHealth:1,leaseHold:1,deviceStates:[],ok: true, version: 'test', platform: 'android', serial: 'device-a', installEnabled: true },
    );
    await backend.install(app);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const route of ['/v1/elements','/v1/exec']) test(`socket reset on ${route}: retry reads once, never replay actions`,async()=>{
  let calls=0;
  const server=createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      if (++calls===1) {req.socket.destroy();return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({elements:[],code:0}));
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const backend=createRemoteBackend({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`},
    {deviceHealth:1,leaseHold:1,deviceStates:[],ok:true,version:'test',platform:'android',serial:'a',installEnabled:false});
  try{
    if(route==='/v1/elements'){assert.deepEqual(await backend.getElements(),[]);assert.equal(calls,2);}
    else {await assert.rejects(backend.exec('home',[],{}),e=>(e as Error).name==='ServerUnreachableError');assert.equal(calls,1);}
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});


test('the major client rejects an old server before acquiring or driving a device',()=>{
  assert.throws(()=>createRemoteBackend({url:'http://unused'}, {ok:true,version:'0.31.0',platform:'android',serial:'a',installEnabled:false}),/upgrade the server/);
});
