import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Every command the CLI accepts must be documented. This is the mechanical half of the rule in
// CLAUDE.md's "Versioning, changelog & docs": prose asks you to update the docs, this fails CI
// when you didn't.
//
// It closes a real hole. `.github/workflows/pages.yml` — the only job that builds the docs site,
// and therefore the only thing that validates its links — is PATH-FILTERED to `docs/**`. A pull
// request that adds a command to `src/cli.ts` and touches no docs file never triggers it, so
// nothing anywhere noticed the omission. `ci.yml` runs `npm test` on every PR regardless of
// paths, so this test sees them all.
//
// Source of truth is the DISPATCH, not `usageText()`. Help text is prose — it puts two commands
// on one line (`launch <app> … stop <app>`) and names `back`/`home`/`enter` inside the `key`
// entry — so parsing it would under-count. The dispatch is rigid syntax and is what actually
// decides whether a command exists.
//
// Run from the repo root (npm test).

const CLI = resolve(process.cwd(), 'src/cli.ts');
const COMMANDS_DOC = resolve(process.cwd(), 'docs/src/content/docs/reference/commands.md');
const PLATFORM_DOC = resolve(process.cwd(), 'docs/src/content/docs/guides/platform-support.md');

/**
 * One dispatchable command plus its aliases, e.g. `['ui', 'dump']`. Aliases come from
 * fall-through `case` labels sharing a handler, which is exactly how the switch spells
 * "same command, different name".
 */
type CommandGroup = readonly string[];

function readCli(): string {
  return readFileSync(CLI, 'utf8');
}

/**
 * Pull the command groups out of `executeCommand`'s `switch (command)`.
 *
 * Consecutive `case 'x':` lines with no statement between them are one group — the fall-through
 * IS the alias declaration, so nothing has to be restated here when an alias is added.
 */
function switchGroups(src: string): CommandGroup[] {
  const start = src.indexOf('switch (command) {');
  assert.notEqual(start, -1, 'no `switch (command)` in src/cli.ts — the dispatch was restructured, so this test can no longer find the commands. Update the extraction below rather than deleting it.');

  const lines = src.slice(start).split('\n');
  const groups: CommandGroup[] = [];
  let pending: string[] = [];

  for (const line of lines) {
    if (/^\s*default:/.test(line)) break;
    const label = line.match(/^\s*case '([a-z][a-z0-9-]*)':\s*$/);
    if (label) {
      pending.push(label[1]);
      continue;
    }
    // Any non-blank line after a run of case labels is the handler: close the group.
    if (pending.length > 0 && line.trim() !== '') {
      groups.push(pending);
      pending = [];
    }
  }
  if (pending.length > 0) groups.push(pending);
  return groups;
}

/**
 * Commands dispatched by `if (command === 'x')` rather than the switch — the meta-commands
 * (`run`, `batch`, `ai`, `suite`, `install`, `server`) and `version` / `help`. These have no
 * aliases, so each is its own group.
 */
function equalityGroups(src: string): CommandGroup[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/command === '([a-z][a-z0-9-]*)'/g)) found.add(m[1]);
  return [...found].map((c) => [c]);
}

function commandGroups(): CommandGroup[] {
  const src = readCli();
  const groups = [...switchGroups(src), ...equalityGroups(src)];

  // Not a redundant guard. Every assertion below is a loop over this list, so an extraction that
  // silently returns [] would make the whole suite pass while checking nothing — the exact
  // failure mode a docs-coverage test must not have. 29 groups today; the floor only has to be
  // high enough that "the regexes stopped matching" cannot look like success.
  assert.ok(
    groups.length >= 25,
    `only ${groups.length} commands extracted from src/cli.ts (expected >= 25) — the dispatch parsing has broken, so these tests are no longer checking anything`,
  );
  return groups;
}

/**
 * Everything the page marks up as code: backtick spans plus `<code>` elements. The platform
 * matrix is a raw HTML table (a GFM table cannot express its grouped `colspan` header), so its
 * command names arrive as `<code>tap</code>` rather than in backticks.
 *
 * Matching only inside code markup keeps a passing mention meaningful — a command named in a
 * sentence is not a reference entry.
 */
function codeSpans(path: string): string {
  const doc = readFileSync(path, 'utf8');
  const spans: string[] = [];
  for (const m of doc.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  for (const m of doc.matchAll(/<code>([^<]*)<\/code>/g)) spans.push(m[1]);
  return spans.join('\n');
}

/**
 * Deliberately a whole-word search rather than an exact match: `device` is documented as
 * `device set` / `device get`, and `ui` as `ui [--all] [--tree]`. The question this answers is
 * "did anyone document this at all", not "is it phrased my way" — a stricter check would fail on
 * ordinary rewording and get deleted.
 */
function mentions(haystack: string, command: string): boolean {
  return new RegExp(`\\b${command.replace(/[-]/g, '\\-')}\\b`).test(haystack);
}

describe('docs coverage: every command is documented', () => {
  test('extraction finds the commands and their aliases', () => {
    const groups = commandGroups();
    const flat = groups.flat();

    // Spot-check the three shapes, so a regression in extraction is diagnosable rather than
    // just a count that moved: a plain case, a fall-through alias pair, and the if-chain.
    assert.ok(flat.includes('tap'), 'expected `tap` among the extracted commands');
    assert.ok(
      groups.some((g) => g.includes('ui') && g.includes('dump')),
      'expected `ui` and `dump` to extract as ONE group — the fall-through is how an alias is declared',
    );
    assert.ok(flat.includes('suite'), 'expected `suite` (dispatched by `command === ...`, not the switch)');
    assert.equal(new Set(flat).size, flat.length, 'a command name was extracted twice');
  });

  test('reference/commands.md documents every command AND every alias', () => {
    const doc = codeSpans(COMMANDS_DOC);
    const missing = commandGroups()
      .flat()
      .filter((c) => !mentions(doc, c));

    assert.deepEqual(
      missing,
      [],
      `undocumented in reference/commands.md: ${missing.join(', ')}\n` +
        'Every command and alias belongs in the command reference — that page is the one users are ' +
        'pointed at to find out what exists. Add a row (see CLAUDE.md, "Adding a command is five edits").',
    );
  });

  test('guides/platform-support.md covers every command', () => {
    const doc = codeSpans(PLATFORM_DOC);
    // One label per group is enough: an alias has identical capability, and listing every alias
    // in a four-column matrix is noise rather than information.
    const missing = commandGroups()
      .filter((group) => !group.some((c) => mentions(doc, c)))
      .map((group) => group.join('/'));

    assert.deepEqual(
      missing,
      [],
      `missing from the platform matrix: ${missing.join(', ')}\n` +
        'Every command gets a row, including one that behaves identically everywhere — say so with ' +
        'four ticks. Omitting it reads as "unknown", which is the ambiguity that page exists to remove.',
    );
  });

  test('every `device set` key is in the platform matrix', () => {
    // Same rule one level down, and the one most likely to be missed: `device/settings.ts` is a
    // table whose per-platform support column has no automated tie to the page that publishes it.
    const keys = [...readFileSync(resolve(process.cwd(), 'src/device/settings.ts'), 'utf8').matchAll(/^\s{2}(?:'([a-z-]+)'|([a-z-]+)):\s*\{$/gm)]
      .map((m) => m[1] ?? m[2])
      .filter((k) => k !== undefined);

    assert.ok(keys.length >= 5, `only ${keys.length} setting keys extracted from src/device/settings.ts (expected >= 5) — extraction has broken`);

    const doc = codeSpans(PLATFORM_DOC);
    const missing = keys.filter((k) => !mentions(doc, k));
    assert.deepEqual(missing, [], `device-set keys missing from the platform matrix: ${missing.join(', ')}`);
  });
});
