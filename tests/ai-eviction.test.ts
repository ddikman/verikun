import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject, laneResult, runAiTest } from '../src/cli';
import { spawnCollect } from '../src/exec';
import { writePlan } from '../src/agent/cache';
import { DEFAULT_MODEL, priceFor } from '../src/agent/cost';
import { resolveIncludes } from '../src/agent/include';
import type { LeafStep } from '../src/agent/ir';
import type { ExecBackend } from '../src/rpc';
import { CliError, RunEvictedError } from '../src/errors';

// `vk ai` over a pooled `vk server`: the server can END a run part-way, when its phone leaves
// the pool. That run DID run — it has steps and an archive — so it has to come back as a
// result carrying both, not as a bare error. A parallel suite re-runs it as a fresh run
// without spending a retry, and keeps this attempt as the evidence of which phone left (#147).
//
// The run is archived under ./.verikun (cwd-relative), so each case runs in a throwaway dir.
// The plan is seeded into the cache, so no model is ever called: the key only has to make
// `makeProvider` return something, because a run with no provider refuses to start.

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'VERIKUN_NO_RUN', 'VERIKUN_LANE', 'VERIKUN_SERVER', 'VERIKUN_SERVER_AUTH_KEY'] as const;
let dir: string;
let cwd: string;
let saved: Record<string, string | undefined>;
let stderr: typeof process.stderr.write;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-ai-evict-'));
  process.chdir(dir);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_API_KEY = 'never-used-the-plan-is-cached';
  delete process.env.VERIKUN_NO_RUN;
  delete process.env.VERIKUN_LANE;
  delete process.env.VERIKUN_SERVER;
  delete process.env.VERIKUN_SERVER_AUTH_KEY;
  stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true; // progress goes to stderr by contract, and is chatty
});

afterEach(() => {
  process.stderr.write = stderr;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const tap = (id: string): LeafStep => ({ type: 'command', command: 'tap', positionals: [id], flags: [] });
const OPTS = { model: DEFAULT_MODEL, price: priceFor(DEFAULT_MODEL), maxCostUsd: 1, timeoutMs: 60_000, recompile: false };

/** A test whose two-step plan is already cached, so the run is pure replay. */
function cachedTest(): string {
  const file = join(dir, 'flow.md');
  writeFileSync(file, 'Tap go, then tap next.\n');
  writePlan({ nl: resolveIncludes(file).nl, platform: 'android' }, { version: 1, steps: [tap('@go'), tap('@next')] });
  return file;
}

/** A backend whose SECOND command throws — the first has already run on the phone. */
function backendThrowingOnStep2(error: Error): ExecBackend {
  let n = 0;
  return {
    exec: async () => {
      n += 1;
      if (n === 2) throw error;
      return { code: 0 };
    },
    getElements: () => [],
    install: () => undefined,
    reset: () => undefined,
  };
}

test('runAiTest: an EVICTED run returns as an environment abort, with its archive, instead of throwing', async () => {
  const file = cachedTest();
  const evicted = new RunEvictedError('verikun server ended this run (409): this run lost its device (R58N): R58N left the pool.');
  const r = await runAiTest(file, OPTS, backendThrowingOnStep2(evicted), 'android', 'R58N');
  assert.equal(r.ok, false);
  assert.equal(r.evicted, true, 'the suite keys its free re-run on this');
  assert.equal(r.abortedForEnv, true, 'still exit 3 for everything that does not know about evictions');
  assert.match(r.failure?.reason ?? '', /R58N left the pool/);
  assert.ok(r.runDir && existsSync(r.runDir), 'the partial run is archived and its report linkable');
  assert.ok((r.state?.steps.length ?? 0) > 0, 'the attempt keeps what it recorded');
});

test('runAiTest: a step that died WITH its phone is an eviction when the server says so afterwards', async () => {
  // The usual shape, measured on hardware: the step running when the phone vanished fails with
  // the phone's own error (a 200 carrying exit 3 — the server never replays a step), and the
  // server sheds the phone and evicts the run only while answering it. Only a LATER request
  // hears the eviction, so the backend remembers it and the run asks afterwards.
  const file = cachedTest();
  let n = 0;
  const backend: ExecBackend = {
    exec: async () => {
      n += 1;
      return n === 2
        ? { code: 3, error: new CliError("Failed to capture UI hierarchy after 3 attempts. adb: device 'R58N' not found", 3) }
        : { code: 0 };
    },
    getElements: () => [],
    install: () => undefined,
    reset: () => undefined,
    wasEvicted: () => true,
  };
  const r = await runAiTest(file, OPTS, backend, 'android', 'R58N');
  assert.equal(r.abortedForEnv, true);
  assert.equal(r.evicted, true, 'the suite re-runs it as a fresh run');
  assert.match(r.failure?.reason ?? '', /device 'R58N' not found/, "the step keeps the phone's own error");
});

test('runAiTest: an ASSERTION failure is never re-labelled an eviction', async () => {
  // A real regression that happened to be followed by the phone leaving is still a regression:
  // only an environment abort can be the eviction's doing.
  const file = cachedTest();
  let n = 0;
  const backend: ExecBackend = {
    exec: async () => ((n += 1) === 2 ? { code: 1 } : { code: 0 }),
    getElements: () => [],
    install: () => undefined,
    reset: () => undefined,
    wasEvicted: () => true,
  };
  const r = await runAiTest(file, OPTS, backend, 'android', 'R58N');
  assert.equal(r.ok, false);
  assert.equal(r.evicted, undefined);
});

test('runAiTest: a THROWN environment error on a run the server evicted returns as an eviction', async () => {
  // A worker that died mid-step answers with an error rather than a result; the server marks
  // that response, and the run must still come back with its archive, not as a bare throw.
  const file = cachedTest();
  const backend = { ...backendThrowingOnStep2(new CliError('device R58N is no longer available (worker exited with code 1)', 3)), wasEvicted: () => true };
  const r = await runAiTest(file, OPTS, backend, 'android', 'R58N');
  assert.equal(r.evicted, true);
  assert.equal(r.abortedForEnv, true);
  assert.ok(r.runDir && existsSync(r.runDir));
});

test('runAiTest: a reset that finds its phone gone is an eviction, not a broken box', async () => {
  // `--reset-app` runs inside the lane's child before the run starts. When the phone this run
  // was dealt left the pool while idle, the reset is the first request to fail — and the one
  // the server marks. No run exists yet to carry a result, so the eviction is thrown.
  const file = cachedTest();
  const deviceGone = new CliError("adb: device 'R58N' not found", 3);
  const withReset = (evicted: boolean): ExecBackend => ({
    exec: async () => ({ code: 0 }),
    getElements: () => [],
    install: () => undefined,
    reset: () => {
      throw deviceGone;
    },
    wasEvicted: () => evicted,
  });
  await assert.rejects(
    () => runAiTest(file, { ...OPTS, resetApp: 'dev.x' }, withReset(true), 'android', 'R58N'),
    (e: unknown) => e instanceof RunEvictedError && /device 'R58N' not found/.test(e.message),
  );
  await assert.rejects(
    () => runAiTest(file, { ...OPTS, resetApp: 'dev.x' }, withReset(false), 'android', 'R58N'),
    (e: unknown) => e === deviceGone,
    'an ordinary failed reset is unchanged',
  );
});

test('runAiTest: any OTHER throw mid-run still propagates, unchanged', async () => {
  // Only an eviction is known to be "this run, not this box": a server that stopped
  // answering is still an error the caller maps to an exit code, exactly as before.
  const file = cachedTest();
  const gone = new CliError('cannot reach verikun server at http://h:8391/v1/exec (fetch failed)', 3);
  await assert.rejects(
    () => runAiTest(file, OPTS, backendThrowingOnStep2(gone), 'android', 'R58N'),
    (e: unknown) => e === gone,
  );
});

// --- the lane child → suite parent contract, end to end ------------------------------
//
// A parallel suite runs each test as a `vk ai --json` child and reads its outcome with
// `laneResult`. These run the REAL child entry point against a stand-in server and feed what
// it printed to the real parser, so the two ends cannot drift apart.

/** A stand-in pooled `vk server`. `refuse`: phone `a` has left, `b` is busy with another
 *  run. `evict`: the run leases `a`, whose first step runs and whose second finds it gone. */
async function fakeServer(mode: 'refuse' | 'evict' | 'die' | 'marked'): Promise<{ url: string; close: () => Promise<void> }> {
  let execs = 0;
  // `die`: the second step is the one running when the phone vanishes. It fails with the
  // phone's own error, and only then does the server shed the phone and evict the run.
  let evicted = false;
  const eviction = {
    error: 'this run lost its device (a): a left the pool and nothing healthy replaced it — start a fresh run; this one cannot continue on another device',
    exitCode: 3,
    errorKind: 'RunEvictedError',
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      switch (req.url) {
        case '/v1/health':
          return send(200, {
            ok: true, version: 'test', platform: 'android', serial: null, installEnabled: false,
            ...(mode === 'refuse'
              ? { capacity: 1, devices: ['b'], quarantined: [{ serial: 'a', reason: 'the device is not attached' }] }
              : { capacity: 2, devices: ['a', 'b'] }),
          });
        case '/v1/lease':
          return mode === 'refuse'
            ? send(409, { error: 'device is locked by another active run — retry when it finishes', exitCode: 3 })
            : send(200, { platform: 'android', serial: 'a' });
        case '/v1/exec':
          execs += 1;
          // `marked`: the phone this run was dealt is already gone, so the FIRST request (the
          // `--reset-app` clear) fails with its own error — and the server marks that response,
          // then answers the release that follows with a plain 200, as it really does.
          if (mode === 'marked') {
            return send(200, {
              code: 3,
              error: { kind: 'CliError', name: 'CliError', message: "adb: device 'a' not found", exitCode: 3 },
              evicted: true,
            });
          }
          if (execs === 1) return send(200, { code: 0 });
          if (mode === 'die' && !evicted) {
            evicted = true;
            return send(200, {
              code: 3,
              error: { kind: 'CliError', name: 'CliError', message: "Failed to capture UI hierarchy after 3 attempts. adb: device 'a' not found", exitCode: 3 },
            });
          }
          return send(409, eviction);
        case '/v1/elements':
          return evicted ? send(409, eviction) : send(200, { elements: [] });
        case '/v1/logs':
          return evicted ? send(409, eviction) : send(200, { logs: '' });
        case '/v1/release':
          return send(200, { ok: true, released: true });
        default:
          return send(404, { error: `no route ${req.url}`, exitCode: 2 });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Run `vk ai --json` as a CHILD PROCESS, exactly as a lane does, and return its exit code and
 * document. A real process rather than an in-process `run()`: the child's stdout is the
 * contract, and capturing this process's stdout would also swallow the test runner's own.
 */
async function aiChild(file: string, url: string, extra: string[] = []): Promise<{ code: number; doc: Record<string, unknown> | null }> {
  const entry = join(__dirname, '..', 'src', 'bin', 'verikun.js');
  const { code, stdout } = await spawnCollect(process.execPath, [entry, 'ai', file, '--json', `--server=${url}`, ...extra], {
    cwd: dir,
    env: { ...process.env },
  });
  return { code, doc: lastJsonObject(stdout) };
}

const LANE = { id: 'd1', label: 'h:8391#1' };

test('contract: a refused lease reaches the suite as "never ran", naming the phone that left', async () => {
  const server = await fakeServer('refuse');
  try {
    const { code, doc } = await aiChild(cachedTest(), server.url);
    assert.equal(code, 3, 'the exit code does not move');
    const r = laneResult(code, doc, '', { ...LANE, server: server.url });
    assert.equal(r.noDevice, true, 'the suite hands the test back instead of failing it');
    assert.equal(r.abortedForEnv, undefined);
    assert.match(r.failure?.reason ?? '', /ruled out: a \(the device is not attached\)/, 'the warning can name the phone, not the lane');
  } finally {
    await server.close();
  }
});

test('contract: an evicted run reaches the suite as an eviction, with its archive and its device', async () => {
  const server = await fakeServer('evict');
  try {
    const { code, doc } = await aiChild(cachedTest(), server.url);
    assert.equal(code, 3, 'an environment abort, as before');
    const r = laneResult(code, doc, '', { ...LANE, server: server.url });
    assert.equal(r.evicted, true, 'the suite re-runs it without spending a retry');
    assert.equal(r.device, 'a', 'the phone that left is named on the attempt');
    assert.ok(r.runDir && existsSync(r.runDir), 'and the partial run stays linkable');
  } finally {
    await server.close();
  }
});

test('contract: a step that died with its phone still reaches the suite as an eviction', async () => {
  const server = await fakeServer('die');
  try {
    const { code, doc } = await aiChild(cachedTest(), server.url);
    assert.equal(code, 3);
    const r = laneResult(code, doc, '', { ...LANE, server: server.url });
    assert.equal(r.evicted, true, 'heard from the requests after the failed step');
    assert.equal(r.device, 'a');
    assert.match(r.failure?.reason ?? '', /device 'a' not found/);
  } finally {
    await server.close();
  }
});

test('contract: a --reset-app that finds its phone gone reaches the suite as an eviction', async () => {
  const server = await fakeServer('marked');
  try {
    const { code, doc } = await aiChild(cachedTest(), server.url, ['--reset-app=dev.verikun.testapp']);
    assert.equal(code, 3);
    const r = laneResult(code, doc, '', { ...LANE, server: server.url });
    assert.equal(r.evicted, true, 'a free re-run, not a FAIL row for a test that never started');
    assert.match(r.failure?.reason ?? '', /device 'a' not found/);
  } finally {
    await server.close();
  }
});
