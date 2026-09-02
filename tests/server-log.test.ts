import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors';
import { MAX_LOG_BYTES, openServerLog, resolveLogPath } from '../src/server-log';

// `home` and `env` are both injected, so the value-domain tests never read the developer's
// real $HOME or environment.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vk-serverlog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('resolveLogPath: the default is host-global and port-scoped', () => {
  assert.equal(
    resolveLogPath({ port: 4300, home: '/home/x', env: {} }),
    join('/home/x', '.verikun', 'logs', 'server-4300.log'),
  );
  // Two servers on one host must not interleave into one unreadable file.
  assert.notEqual(
    resolveLogPath({ port: 4300, home: '/home/x', env: {} }),
    resolveLogPath({ port: 4301, home: '/home/x', env: {} }),
  );
});

test('resolveLogPath: the flag takes a path or turns the log off', () => {
  assert.equal(resolveLogPath({ flags: { 'log-file': '/tmp/a.log' }, port: 1, env: {} }), '/tmp/a.log');
  assert.equal(resolveLogPath({ flags: { 'log-file': 'off' }, port: 1, env: {} }), null);
  // The value domain is closed but case-insensitive — an operator typing OFF meant off.
  assert.equal(resolveLogPath({ flags: { 'log-file': 'OFF' }, port: 1, env: {} }), null);
});

test('resolveLogPath: VERIKUN_LOG_FILE shares the value domain, and the flag beats it', () => {
  assert.equal(resolveLogPath({ port: 1, home: '/h', env: { VERIKUN_LOG_FILE: '/tmp/env.log' } }), '/tmp/env.log');
  assert.equal(resolveLogPath({ port: 1, home: '/h', env: { VERIKUN_LOG_FILE: 'off' } }), null);
  assert.equal(
    resolveLogPath({ flags: { 'log-file': '/tmp/flag.log' }, port: 1, home: '/h', env: { VERIKUN_LOG_FILE: 'off' } }),
    '/tmp/flag.log',
  );
  // An empty env var is not a request for a file named '' — it reads as unset.
  assert.equal(
    resolveLogPath({ port: 7, home: '/h', env: { VERIKUN_LOG_FILE: '  ' } }),
    join('/h', '.verikun', 'logs', 'server-7.log'),
  );
});

test('resolveLogPath: a valueless --log-file is a usage error, not a silent default', () => {
  // `log-file` is deliberately NOT in args.ts's BOOLEAN set, so a bare flag parses as
  // `true`. Defaulting there would silently ignore an operator who meant to redirect.
  assert.throws(
    () => resolveLogPath({ flags: { 'log-file': true }, port: 1, env: {} }),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});

test('openServerLog: writes timestamped lines and creates its directory', () => {
  const path = join(dir, 'nested', 'server.log');
  const log = openServerLog(path);
  assert.ok(log);
  log.write('[server] hello');
  log.close();
  const body = readFileSync(path, 'utf8');
  assert.match(body, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[server] hello\n$/);
});

test('openServerLog: writing after close is a no-op rather than a throw', () => {
  const path = join(dir, 'server.log');
  const log = openServerLog(path);
  assert.ok(log);
  log.close();
  log.close(); // idempotent
  log.write('[server] late');
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('openServerLog: an oversized existing log is rotated aside on open', () => {
  const path = join(dir, 'server.log');
  writeFileSync(path, 'x'.repeat(MAX_LOG_BYTES + 1));
  const log = openServerLog(path);
  assert.ok(log);
  log.write('[server] fresh');
  log.close();
  // The new file holds only the new line; the old bytes survive in .1 rather than being
  // deleted — the run that just failed is usually the one in the previous generation.
  assert.match(readFileSync(path, 'utf8'), /\[server] fresh/);
  assert.equal(statSync(`${path}.1`).size, MAX_LOG_BYTES + 1);
});

test('openServerLog: a log that grows past the cap rotates while running', () => {
  const path = join(dir, 'server.log');
  const log = openServerLog(path);
  assert.ok(log);
  const chunk = 'y'.repeat(64 * 1024);
  for (let i = 0; i * chunk.length <= MAX_LOG_BYTES; i++) log.write(chunk);
  log.write('[server] after rotation');
  log.close();
  assert.ok(existsSync(`${path}.1`), 'the previous generation should exist');
  // Rotation resets the active file, so it is far below the cap again rather than growing
  // without bound — the property that stops a long-lived server filling its own disk.
  assert.ok(statSync(path).size < MAX_LOG_BYTES, 'the active log restarts after rotating');
  assert.match(readFileSync(path, 'utf8'), /after rotation/);
});

test('openServerLog: an unwritable path degrades to null instead of throwing', () => {
  // A log is never a new way for a server to fail: the caller falls back to the stderr it
  // always had. Same judgement spawnDetached makes about the emulator's log file.
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  try {
    assert.equal(openServerLog(join(locked, 'sub', 'server.log')), null);
  } finally {
    chmodSync(locked, 0o700);
  }
});
