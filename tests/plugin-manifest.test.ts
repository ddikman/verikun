import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// What the Claude Code plugin ships as skills. This fails SILENTLY in both directions — the
// plugin still installs, it just carries the wrong set — and neither tsc nor
// `claude plugin validate` catches it. Version lockstep lives next door in
// plugin-version.test.ts. Run from the repo root (npm test).

const SKILLS_DIR = ['.claude', 'skills'];

function manifestSkills(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { skills?: string | string[] };
  const skills = manifest.skills;
  assert.ok(skills, 'plugin.json must declare `skills`');
  return Array.isArray(skills) ? skills : [skills];
}

// `skills` takes DIRECTORIES and only ever ADDS to the scan — there is no way to subtract.
// Claude Code loads such an entry as one skill when the directory holds SKILL.md itself, and
// otherwise scans it for <name>/SKILL.md. So naming the container `./.claude/skills/`
// published every skill in it, `create-pr` included, up to and including 0.19.0 — and naming
// a single skill drops `suggest-verikun-improvement`, which the main skill hands off to.
// Hence one entry per shipped skill.
test('plugin manifest ships every user-facing skill and no contributor-only one', () => {
  const declared = manifestSkills();
  const onDisk = readdirSync(resolve(process.cwd(), ...SKILLS_DIR), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Contributor-only skills opt out via `metadata.internal: true` in their frontmatter, which
  // is what `vercel-labs/skills` honours. Claude Code ignores that key, so the manifest is the
  // only thing keeping them out of an end user's session.
  const internal = onDisk.filter((name) =>
    /^\s*internal:\s*true\s*$/m.test(readFileSync(resolve(process.cwd(), ...SKILLS_DIR, name, 'SKILL.md'), 'utf8')),
  );
  assert.ok(internal.length > 0, 'expected at least one contributor-only skill — has the marker moved?');

  for (const name of onDisk) {
    const entry = `./${[...SKILLS_DIR, name].join('/')}/`;
    if (internal.includes(name)) {
      assert.ok(!declared.includes(entry), `${name} is contributor-only and must not ship to end users`);
    } else {
      assert.ok(declared.includes(entry), `${name} is user-facing but the plugin does not ship it`);
    }
  }
});

// A rename would leave an entry pointing at nothing: the plugin then quietly ships one skill
// fewer, and still installs cleanly.
test('every declared skill path exists and holds a SKILL.md', () => {
  for (const entry of manifestSkills()) {
    const path = resolve(process.cwd(), entry.replace(/^\.\//, ''), 'SKILL.md');
    assert.ok(existsSync(path), `plugin.json declares ${entry}, but ${entry}SKILL.md does not exist`);
  }
});
