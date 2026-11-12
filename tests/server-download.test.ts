import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, RequestListener } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadApk } from '../src/server-download';
import { parseInstallUrl, validateInstallSha } from '../src/install-url';

async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'vk-download-'));
  const path = join(dir, 'build.apk');
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/apk?signature=SECRET`);
  const logs: string[] = [];
  const controller = new AbortController();
  return {
    url, path, logs, controller,
    options: { cap: 1024, signal: controller.signal, log: (s: string) => logs.push(s), retryDelayMs: 1 },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('download follows relative redirects and hashes the exact bytes without logging signed URLs', async () => {
  const f = await fixture((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-verikun-run'], undefined);
    if (req.url!.startsWith('/apk')) { res.writeHead(302, { location: '/build?signature=SECRET' }); res.end(); }
    else res.end('APKBYTES');
  });
  try {
    const result = await downloadApk(f.url, f.path, f.options);
    assert.equal(readFileSync(f.path, 'utf8'), 'APKBYTES');
    assert.deepEqual(result, { bytes: 8, sha256: createHash('sha256').update('APKBYTES').digest('hex') });
    assert.ok(!f.logs.join().includes('SECRET'));
  } finally { await f.close(); }
});

test('download retries transient status and replaces a truncated attempt instead of appending', async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    if (requests === 1) { res.writeHead(503); res.end(); }
    else if (requests === 2) { res.writeHead(200, { 'content-length': 100 }); res.write('PARTIAL'); setImmediate(() => res.destroy()); }
    else res.end('APKBYTES');
  });
  try {
    await downloadApk(f.url, f.path, f.options);
    assert.equal(requests, 3);
    assert.equal(readFileSync(f.path, 'utf8'), 'APKBYTES');
  } finally { await f.close(); }
});

for (const kind of ['declared', 'streamed'] as const) test(`download rejects ${kind} oversized bodies without retrying`, async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    if (kind === 'declared') res.setHeader('content-length', 2048);
    else res.writeHead(200, { 'transfer-encoding': 'chunked' });
    res.end(Buffer.alloc(2048));
  });
  try {
    await assert.rejects(downloadApk(f.url, f.path, f.options), /exceeds/);
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

for (const status of [403, 404, 206]) test(`download does not retry HTTP ${status} or expose upstream response bodies`, async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.writeHead(status); res.end('SECRET'); });
  try {
    await assert.rejects(downloadApk(f.url, f.path, f.options), new RegExp(`HTTP ${status}$`));
    assert.equal(requests, 1);
  } finally { await f.close(); }
});

test('download stops retrying after three stalled connections', async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.writeHead(200); res.write('partial'); });
  try {
    await assert.rejects(downloadApk(f.url, f.path, { ...f.options, idleMs: 20 }), /after 3 attempts/);
    assert.equal(requests, 3);
  } finally { await f.close(); }
});

test('download total deadline bounds a server that never sends headers', async () => {
  const f = await fixture(() => {});
  try {
    await assert.rejects(downloadApk(f.url, f.path, { ...f.options, timeoutMs: 30 }), /deadline/);
  } finally { await f.close(); }
});

test('download cancellation stops an active transfer', async () => {
  let cancel!: () => void;
  const f = await fixture((_req, res) => { res.write('partial'); cancel(); });
  cancel = () => f.controller.abort();
  try {
    await assert.rejects(downloadApk(f.url, f.path, f.options), /cancelled/);
  } finally { await f.close(); }
});

test('download rejects redirect loops and non-HTTP targets', async () => {
  for (const location of ['/loop', 'file:///etc/passwd']) {
    const f = await fixture((_req, res) => { res.writeHead(302, { location }); res.end(); });
    try { await assert.rejects(downloadApk(f.url, f.path, f.options), /redirect/); }
    finally { await f.close(); }
  }
});

test('install URL and digest validation rejects malformed inputs without echoing credentials', () => {
  for (const url of [undefined, 'SECRET', 'file:///SECRET', 'https://user:SECRET@example.com/app', 'https://example.com/#SECRET'])
    assert.throws(() => parseInstallUrl(url), e => e instanceof Error && !e.message.includes('SECRET'));
  for (const sha of [true, '', 'nope', 'f'.repeat(63)]) assert.throws(() => validateInstallSha(sha), /64 hexadecimal/);
  assert.equal(validateInstallSha('A'.repeat(64)), 'a'.repeat(64));
});
