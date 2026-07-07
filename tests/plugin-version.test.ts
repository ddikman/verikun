import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// .claude-plugin/plugin.json's "version" is stamped from package.json's "version" at build
// (scripts/gen-version.mjs via the prebuild script), keeping the Claude Code plugin manifest
// in lockstep. Mirrors version.test.ts: guards the case where package.json was bumped but the
// build wasn't re-run, leaving a stale committed manifest. Run from the repo root (npm test).
test('plugin manifest version matches package.json (rebuild after a version bump)', () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const plugin = JSON.parse(
    readFileSync(resolve(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { version: string };
  assert.equal(plugin.version, pkg.version);
});
