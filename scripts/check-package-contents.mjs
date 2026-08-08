// Asserts what the npm tarball ACTUALLY contains, by packing it and reading the file list.
//
// This is the artifact-level counterpart to tests/package-files.test.ts. That test checks
// package.json's "files" allowlist — our INTENT. This checks the tarball — the RESULT. The
// gap between the two is where the bug this exists to prevent lived: every release up to
// 0.10.0 published with no CHANGELOG.md, `npm publish` succeeded, CI stayed green, and
// nothing anywhere reported the omission. Only unpacking the tarball revealed it.
//
// Things only this check can catch (the allowlist test cannot):
//   - a stray .npmignore silently subtracting from "files"
//   - npm changing whether it traverses a dot-directory (.claude/ packs today; that is
//     undocumented behaviour we depend on, not a guarantee)
//   - "files" gaining `.claude/skills` ALONGSIDE the exact skill path, which would ship the
//     contributor-only create-pr skill while every allowlist assertion still passes
//   - the "files" array being deleted, which makes npm fall back to gitignore rules and
//     publish src/, tests/, CLAUDE.md and the rest of the repo
//
// Run locally with `node scripts/check-package-contents.mjs`; wired into ci.yml and, as the
// release gate, publish.yml. Plain ESM, zero deps (matches scripts/gen-version.mjs).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `npm pack --dry-run` writes no tarball. --json gives [{ files: [{ path, size, mode }] }],
// with paths relative to the package root (no "package/" prefix).
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
const paths = JSON.parse(raw)[0].files.map((f) => f.path);

// Every entry that must be in the tarball. `dist/bin/verikun.js` is the CLI itself: if the
// build or the allowlist breaks, the package installs but `vk` does not exist.
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  '.claude/skills/verikun/SKILL.md',
  'dist/bin/verikun.js',
  'dist/cli.js',
];

// Patterns that must NOT appear. create-pr is contributor-only (metadata.internal: true);
// src/ and tests/ appearing means the "files" allowlist stopped being applied at all.
const forbidden = [
  { label: 'the contributor-only create-pr skill', match: (p) => p.includes('create-pr') },
  { label: 'TypeScript sources (is "files" still set?)', match: (p) => p.startsWith('src/') },
  { label: 'the test suite (is "files" still set?)', match: (p) => p.startsWith('tests/') },
  // example/ ships as the glob `example/*.md` — the end-user NL examples only, never a
  // subdirectory. This caught a real regression: `example/flutter-app/` (the repo's own Flutter
  // e2e fixture, added in #47) is 74 files / 181 kB of Gradle, Xcode and icon PNGs, and a bare
  // `example` entry in "files" swept the whole thing into the tarball.
  {
    label: 'files nested under example/ (fixtures, not end-user examples)',
    match: (p) => p.startsWith('example/') && p.slice('example/'.length).includes('/'),
  },
];

const errors = [];

for (const entry of required) {
  if (!paths.includes(entry)) errors.push(`MISSING from the tarball: ${entry}`);
}

// Asserted as a group rather than by filename: adding or renaming an example is normal
// maintenance, shipping none of them is the regression.
if (!paths.some((p) => p.startsWith('example/'))) {
  errors.push('MISSING from the tarball: example/ (no example files were packed)');
}

for (const { label, match } of forbidden) {
  const hits = paths.filter(match);
  // Truncate: a bare `example` entry sweeps in 74 fixture files, and listing every one buries the
  // actual message in a CI log. A few examples plus the count is enough to identify the cause.
  if (hits.length) {
    const shown = hits.slice(0, 3).join(', ');
    const rest = hits.length > 3 ? ` (+${hits.length - 3} more, ${hits.length} total)` : '';
    errors.push(`SHOULD NOT ship ${label}: ${shown}${rest}`);
  }
}

if (errors.length) {
  console.error(`\n✖ npm package contents check FAILED (${paths.length} files packed)\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nInspect with: npm pack --dry-run`);
  console.error(`If you changed what ships, update package.json's "files" AND this script.\n`);
  process.exit(1);
}

console.log(`✔ npm package contents check passed (${paths.length} files packed)`);
