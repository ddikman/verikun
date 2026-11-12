import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const cli = (args: string[], server = '') => promisify(execFile)(process.execPath,
  [join(__dirname, '../src/bin/verikun.js'), 'install', ...args], {
    env: { ...process.env, VERIKUN_SERVER: server, VERIKUN_NO_UPDATE_CHECK: '1', VERIKUN_NO_CLAIM: '1' },
  });

test('install --url sends a descriptor to VERIKUN_SERVER and keeps signed URLs out of CLI output', async () => {
  const posted: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.end(JSON.stringify({ ok: true, version: 'test', platform: 'android', serial: 'a',
        deviceHealth: 1, leaseHold: 1, deviceStates: [], installEnabled: true, installFromUrl: true }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/install') posted.push(JSON.parse(body));
      res.end(JSON.stringify({ ok: true, devices: ['a'] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'https://storage.invalid/download?signature=SECRET';
    const sha = 'a'.repeat(64);
    const { stdout, stderr } = await cli(['--url', url, '--sha256', sha, '--json'],
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(posted, [{ url, sha256: sha }]);
    assert.equal(JSON.parse(stdout).installed, 'APK from URL');
    assert.ok(!(stdout + stderr).includes('SECRET'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('install URL misuse fails with usage errors before touching a device or server', async () => {
  for (const args of [
    ['--url', 'https://example.com/app.apk'],
    ['file.apk', '--url', 'https://example.com/app.apk', '--server', 'http://127.0.0.1:1'],
    ['--url'], ['--sha256', 'a'.repeat(64)],
    ['--url', 'https://example.com/app.apk', '--sha256'],
    ['--url', 'file:///SECRET', '--server', 'http://127.0.0.1:1'],
    ['--url', 'https://example.com/app.apk', '--sha256', 'bad', '--server', 'http://127.0.0.1:1'],
  ]) {
    await assert.rejects(cli(args), (e: unknown) => {
      const error = e as { code: number; stdout: string; stderr: string };
      assert.equal(error.code, 2, error.stderr);
      assert.ok(!(error.stdout + error.stderr).includes('SECRET'));
      return true;
    });
  }
});
