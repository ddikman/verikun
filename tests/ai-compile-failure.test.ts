import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runAiTest } from '../src/cli';
import { priceFor } from '../src/agent/cost';
import type { ExecBackend } from '../src/rpc';

// A compile the plan validator rejects twice ends the TEST as a result at `compile`, never as an
// "Unexpected error" (issue #158). Driven through the real path: `--model codex-cli` with a fake
// `codex` on PATH that always answers with the stray `repeat` leaf. The CLI provider, the shared
// reader, the guided recompile and runAiTest's mapping all run for real; only the model is scripted.

const STRAY_PLAN = JSON.stringify({ version: 1, steps: [{ type: 'command', command: 'repeat', positionals: ['@x'], flags: [] }] });

let dir: string;
let cwd: string;
let path: string | undefined;
let stderr: typeof process.stderr.write;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-ai-compile-'));
  process.chdir(dir); // the plan cache is cwd-relative
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Writes its answer where codex writes its final message: the file named by --output-last-message.
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then printf '%s' '${STRAY_PLAN}' > "$2"; fi\n  shift\ndone\n`,
  );
  chmodSync(join(bin, 'codex'), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true; // progress goes to stderr by contract, and is chatty
});

afterEach(() => {
  process.stderr.write = stderr;
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

test('runAiTest: a plan rejected twice is a FAIL at compile, and touches no device', async () => {
  const file = join(dir, 'flow.md');
  writeFileSync(file, 'Scroll down until the Archive button shows.\n');
  let leased = 0;
  let execs = 0;
  const backend: ExecBackend = {
    exec: async () => {
      execs += 1;
      return { code: 0 };
    },
    getElements: () => [],
    install: () => undefined,
    reset: () => undefined,
    lease: async () => {
      leased += 1;
      return null;
    },
  };
  const opts = { model: 'codex-cli', price: priceFor('codex-cli'), maxCostUsd: 1, timeoutMs: 60_000, recompile: false };
  const r = await runAiTest(file, opts, backend, 'android', undefined);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fail');
  assert.equal(r.failure?.where, 'compile');
  assert.match(r.failure?.reason ?? '', /rejected twice/);
  assert.equal(execs, 0, 'nothing ran');
  assert.equal(leased, 0, 'a remote device is leased only after a plan exists');
});
