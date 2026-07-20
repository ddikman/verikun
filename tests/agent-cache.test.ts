import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planKey, readPlan, writePlan, findSeed, nlHash } from '../src/agent/cache';
import { Plan, RepeatNode } from '../src/agent/ir';

// The cache writes under ./.verikun (cwd-relative), so each test runs inside a
// throwaway temp dir. node:test runs a file's tests sequentially, so chdir is safe.

const samplePlan: Plan = {
  version: 1,
  package: 'com.x',
  platform: 'android',
  steps: [{ type: 'command', command: 'tap', positionals: ['@a'], flags: [] }],
};

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-cache-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

test('planKey: stable for the same inputs and sensitive to the build', () => {
  const a = planKey({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' });
  const b = planKey({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' });
  const c = planKey({ nl: 'x', pkg: 'com.x', build: '2', platform: 'android' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('readPlan: a miss returns null; write then read returns the plan', () => {
  const key = { nl: 'x', pkg: 'com.x', build: '1', platform: 'android' };
  assert.equal(readPlan(key), null);
  writePlan(key, samplePlan);
  const got = readPlan(key);
  assert.ok(got);
  assert.equal(got!.plan.steps.length, 1);
  assert.equal(got!.nlHash, nlHash('x'));
});

test('readPlan: a repeat-body leaf survives the write→read round-trip (control-body persistence, #18)', () => {
  const key = { nl: 'ctrl', pkg: 'com.x', build: '1', platform: 'android' };
  const withBody: Plan = {
    version: 1,
    package: 'com.x',
    platform: 'android',
    steps: [
      {
        type: 'repeat',
        selector: 'text:Done',
        cap: 5,
        body: [{ type: 'command', command: 'tap', positionals: ['@signin'], flags: [] }],
      },
    ],
  };
  writePlan(key, withBody);
  const got = readPlan(key);
  assert.ok(got);
  const step0 = got!.plan.steps[0];
  assert.equal(step0.type, 'repeat');
  // the nested body leaf (what a heal rewrites) must round-trip intact — not dropped by
  // writePlan's serialization nor by parsePlan's re-validation on read
  assert.equal((step0 as RepeatNode).body[0].positionals[0], '@signin');
});

test('readPlan: a plan compiled by a different verikun/grammar is invalidated (forces recompile)', () => {
  const key = { nl: 'x', pkg: 'com.x', build: '1', platform: 'android' };
  writePlan(key, samplePlan);
  assert.ok(readPlan(key)); // current compiler fingerprint matches -> hit
  // Simulate a plan left behind by an older verikun (different compiler fingerprint):
  const path = join(dir, '.verikun', 'plans', `${planKey(key)}.json`);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(entry.compilerFingerprint && entry.verikunVersion); // the record carries both
  entry.compilerFingerprint = 'stale-from-an-older-build';
  writeFileSync(path, JSON.stringify(entry));
  assert.equal(readPlan(key), null); // invalidated -> miss -> recompile against the new compiler
});

test('readPlan: a corrupt cache file is treated as a miss (not a crash)', () => {
  const key = { nl: 'x', pkg: 'com.x', build: '1', platform: 'android' };
  writePlan(key, samplePlan);
  writeFileSync(join(dir, '.verikun', 'plans', `${planKey(key)}.json`), '{ not valid json');
  assert.equal(readPlan(key), null);
});

test('findSeed: returns a prior-build plan for the same NL + package', () => {
  writePlan({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' }, samplePlan);
  const seed = findSeed({ nl: 'x', pkg: 'com.x', build: '2', platform: 'android' });
  assert.ok(seed);
  assert.equal(seed!.build, '1');
});

test('findSeed: returns null when the NL differs', () => {
  writePlan({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' }, samplePlan);
  assert.equal(findSeed({ nl: 'DIFFERENT', pkg: 'com.x', build: '2', platform: 'android' }), null);
});

test('findSeed: ignores the exact-key entry (never seeds from itself)', () => {
  writePlan({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' }, samplePlan);
  assert.equal(findSeed({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' }), null);
});

test('findSeed: returns null when the package differs', () => {
  writePlan({ nl: 'x', pkg: 'com.x', build: '1', platform: 'android' }, samplePlan);
  assert.equal(findSeed({ nl: 'x', pkg: 'com.y', build: '2', platform: 'android' }), null);
});

test('readPlan: valid JSON whose plan is invalid (right fingerprint) is a miss', () => {
  const key = { nl: 'x', pkg: 'com.x', build: '1', platform: 'android' };
  writePlan(key, samplePlan);
  const p = join(dir, '.verikun', 'plans', `${planKey(key)}.json`);
  const entry = JSON.parse(readFileSync(p, 'utf8'));
  entry.plan.steps = [{ type: 'command', command: 'frobnicate', positionals: [], flags: [] }];
  writeFileSync(p, JSON.stringify(entry));
  assert.equal(readPlan(key), null);
});
