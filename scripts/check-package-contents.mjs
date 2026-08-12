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

// `npm pack --dry-run` writes no tarball. --json describes the tarball it would have
// written: one entry carrying `files: [{ path, size, mode }]`, paths relative to the package
// root (no "package/" prefix).
//
// The SHAPE of that entry depends on the npm major, and publish.yml deliberately runs
// `npm@latest` (trusted publishing needs >= 11.5.1) — so this script gets whatever npm ships
// on release day, which is exactly how it broke once: npm <= 11 returns an ARRAY of pack
// results, npm 12 returns an OBJECT keyed by package name, and `[0]` on it was `undefined`
// (a TypeError, mid-release, that no CI run saw because ci.yml uses the bundled npm).
// Accept both, and if a future npm invents a third shape, say so instead of throwing a
// stack trace at whoever is trying to cut a release.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
const parsed = JSON.parse(raw);
const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed ?? {})[0];
if (!Array.isArray(result?.files)) {
  console.error(
    'Could not read a file list out of `npm pack --dry-run --json`.\n' +
      `npm version: ${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}\n` +
      'Its output shape is not one this script knows (expected an array of pack results, or\n' +
      'an object keyed by package name, each entry carrying a "files" array). Raw output:\n' +
      raw,
  );
  process.exit(1);
}
const paths = result.files.map((f) => f.path);

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
  // The on-device companion. Shipped prebuilt because `npm install verikun` must not need
  // an Android SDK — so if this is missing, every install silently loses the fast
  // hierarchy read and falls back to the ~2.4s stock dump with nothing to explain why.
  'tools/verikun-companion/prebuilt/verikun-companion.jar',
];

// Patterns that must NOT appear. create-pr is contributor-only (metadata.internal: true);
// src/ and tests/ appearing means the "files" allowlist stopped being applied at all.
const forbidden = [
  // Highest-consequence check here, and the only one that is not recoverable: a published tarball
  // is mirrored and cached within seconds, so an unpublish does not un-leak a credential.
  // Two layers already keep these out — the "files" allowlist, and .gitignore's `.env` / `.env.*`
  // (npm falls back to gitignore rules when "files" is absent). This is a third, independent layer,
  // because npm's own always-excluded list does NOT cover .env: drop the allowlist and edit
  // .gitignore and the fallback is gone with no warning.
  {
    label: 'environment / secret files',
    match: (p) => /(^|\/)\.env/.test(p) || /\.(pem|key|p12|keystore|jks)$/.test(p),
  },
  { label: 'the contributor-only create-pr skill', match: (p) => p.includes('create-pr') },
  // Only the built jar ships. The Java, the build script and the READMEs are repo
  // infrastructure like example/flutter-app/ — a bare `tools` entry in "files" would sweep
  // them in, which is the same mistake `example/*.md` exists to prevent.
  {
    label: 'companion sources (only prebuilt/*.jar should ship)',
    match: (p) => p.startsWith('tools/') && !p.startsWith('tools/verikun-companion/prebuilt/'),
  },
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
