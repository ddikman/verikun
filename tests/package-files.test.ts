import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// package.json's "files" is an ALLOWLIST: anything we mean to publish beyond npm's small
// force-included set must be named there explicitly. CLAUDE.md's plugin section holds the
// canonical list of what npm force-includes — don't restate it here, it drifts (this comment
// once said "four things" and was wrong in three files at once).
//
// Dropping an entry publishes a release without that file and reports nothing: `npm publish`
// succeeds, CI stays green, and you only find out by unpacking the tarball. That is exactly how
// releases up to 0.10.0 shipped with no changelog. These tests make that failure loud.
//
// Scope note: these assert our INTENT (the allowlist). scripts/check-package-contents.mjs packs
// the tarball and asserts the RESULT; it runs in ci.yml and as a publish.yml release gate, and
// catches what an allowlist check structurally cannot (a stray .npmignore, npm changing how it
// treats the .claude/ dot-directory, or `.claude/skills` being added alongside the exact skill
// path and dragging the contributor-only create-pr skill into the tarball).
//
// Run from the repo root (npm test).
function packageFiles(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { files?: string[] };
  // Not a redundant guard: deleting "files" is the worst packaging regression available — npm
  // falls back to gitignore rules and publishes src/, tests/, CLAUDE.md, the lot. Without this
  // the tests below still fail, but as an opaque "cannot read properties of undefined".
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.length > 0,
    'package.json has no "files" array — npm would fall back to gitignore rules and publish the entire repo',
  );
  return pkg.files;
}

test('package.json "files" ships the docs we intend to publish', () => {
  const files = packageFiles();
  // `example/*.md`, deliberately not a bare `example`: the directory also holds the Flutter e2e
  // fixture app (74 files of Gradle/Xcode/PNG), which is repo test infrastructure, not something
  // an end user installing the CLI should download.
  for (const doc of ['CHANGELOG.md', '.claude/skills/verikun/SKILL.md', 'example/*.md']) {
    assert.ok(files.includes(doc), `package.json "files" is missing ${doc} — it would not be published`);
  }
});

// Catches a RENAME or MOVE: an allowlist entry pointing at a path that no longer exists is not an
// error to npm, it just silently contributes nothing to the tarball. "dist" is exempt because it
// is a build artifact (gitignored, absent until `npm run build`).
//
// A glob entry (`example/*.md`) can't be existsSync'd, so it resolves to "the directory exists AND
// at least one file matches" — otherwise renaming the examples away would leave a pattern that
// matches nothing and publishes nothing, which is the same silent failure by another route.
// Deliberately handles only the `<dir>/*.<ext>` shape the allowlist actually uses; a new glob shape
// should extend this rather than slip through unchecked.
test('every package.json "files" entry exists on disk', () => {
  for (const entry of packageFiles()) {
    if (entry === 'dist') continue;

    if (entry.includes('*')) {
      const [dir, pattern] = [entry.slice(0, entry.lastIndexOf('/')), entry.slice(entry.lastIndexOf('/') + 1)];
      assert.match(pattern, /^\*\.[a-z0-9]+$/i, `unsupported glob shape in "files": ${entry} — extend this test`);
      const ext = pattern.slice(1);
      assert.ok(existsSync(resolve(process.cwd(), dir)), `package.json "files" lists ${entry}, but ${dir}/ does not exist`);
      const matches = readdirSync(resolve(process.cwd(), dir)).filter((f) => f.endsWith(ext));
      assert.ok(matches.length > 0, `package.json "files" lists ${entry}, but nothing in ${dir}/ matches — it would publish nothing`);
      continue;
    }

    assert.ok(existsSync(resolve(process.cwd(), entry)), `package.json "files" lists ${entry}, but it does not exist`);
  }
});
