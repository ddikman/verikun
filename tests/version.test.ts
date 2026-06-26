import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERSION } from '../src/version';

// src/version.ts is GENERATED from package.json's "version" at build (scripts/gen-version.mjs
// via the prebuild script). This test guards the case where package.json was bumped but the
// build wasn't re-run, leaving a stale committed version.ts. Run from the repo root (npm test).
test('VERSION matches package.json (rebuild after a version bump)', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});
