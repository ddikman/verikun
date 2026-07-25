---
name: create-pr
description: >-
  Create a GitHub pull request for the current branch with a concise, intent-driven
  description that fills this repo's PR template. Use whenever the user asks to "create a
  PR", "open a pull request", "raise a PR", "put up a PR", "submit this for review", or
  "make a draft PR" — including right after finishing a change on a branch. Rebases the
  branch onto `origin/main` first, then creates a draft with `gh pr create --draft --base
  main`. For a user-facing change it also bumps the SemVer version and cuts the CHANGELOG
  entry. Produces a short summary that leads with
  intent, bans filler openers and file-by-file narration, and points the reviewer at the
  real risk areas. Does not publish (mark ready for review) unless explicitly asked.
metadata:
  internal: true
---

# Create PR

Open a pull request for the current branch with a description a reviewer can scan in seconds. In order: **rebase onto main → summarise scope → draft a concise, intent-led body → create it as a draft**. The description leads with *why*, not a re-narration of the diff.

To keep the PR's base current, **rebase onto `origin/main`** before opening it, then create the PR with `gh`.

## High-level flow

1. Pre-flight — for a user-facing change, bump the version + cut the CHANGELOG entry; commit everything; get the local gate (`npm run build`, `npm test`) green.
2. Rebase the branch onto `origin/main`, then push.
3. Summarise scope from the commit log + diffstat (never the full diff).
4. Draft the body against `.github/pull_request_template.md`, applying the rules below.
5. Create the PR as a draft with `gh pr create` (or update an existing one for this branch).
6. Verify it's a draft and report the URL.

## Step 1 — Pre-flight

Do these as part of the change and commit them **together** with your code:

- **Changelog & version — user-facing changes only** (a new/changed command, flag, selector, or exit code, or a bug a user would notice). Purely internal work — refactors, tests, CI, docs — gets neither; if that's worth stating, put it in the PR's *Out of scope*.
  1. **Pick the SemVer bump** from what changed: `patch` (a fix, no new surface), `minor` (a new command/flag or other back-compatible feature), `major` (a breaking change — pre-1.0 you may fold a break into `minor`; use judgment).
  2. **Bump the version — `package.json` is the source of truth; two other spots must match, and one is generated:** run `npm version <patch|minor|major> --no-git-tag-version` (updates `package.json` **and** `package-lock.json`, no git tag/commit), then edit the `version` in `.claude-plugin/plugin.json` (the Claude Code plugin manifest — it has drifted before) to the same value. `src/version.ts`'s `VERSION` (what `vk --version` prints, and the plan-cache compiler fingerprint) is **generated from `package.json`** by the `prebuild` step (`scripts/gen-version.mjs`) — do NOT hand-edit it; the gate's `npm run build` below regenerates it and recompiles `dist/`.
  3. **Cut the changelog entry:** in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - <today>` (new version + today's date), describe this change under the right `### Added` / `### Fixed` / `### Changed` heading, and add a fresh empty `## [Unreleased]` above it.
- **Keep the docs contract:** if you changed CLI behaviour (command / flag / selector / exit code), update `README.md` **and** `.claude/skills/verikun/SKILL.md`, and tick the matching box in the PR's *Docs & contracts* section.

Then:

- Commit everything; confirm the working tree is clean.
- Run the gate locally so you don't push red — this is exactly what CI reruns on Node 20.x + 22.x:
  ```sh
  npm run build   # tsc strict — the only static check
  npm test        # node:test unit suite (platform-agnostic core)
  ```
  Don't restate these in the PR body — CI proves them (see the template's own note).
- The base / scope ref is `origin/main` — this repo's default branch is `main`.

## Step 2 — Rebase onto main & push

Bring the branch up to date on top of the latest `main` before opening the PR:

```sh
git fetch origin
git rebase origin/main
```

- If there are conflicts you can't resolve cleanly and correctly, `git rebase --abort` and surface it to the user — don't guess at a resolution. The usual conflict here is the version / `CHANGELOG.md` lines you just bumped (another PR released a version first); resolve it by re-applying your bump on top of the updated `main`, not by hand-merging the numbers.
- Rebasing rewrites the branch's history, so push with a lease (safe force):
  ```sh
  git push --force-with-lease
  ```
  If the branch has never been pushed, use `git push -u origin HEAD` instead.

## Step 3 — Summarise scope

Summarise from these — do **not** read or paste the full diff:

```sh
git log origin/main..HEAD --oneline       # commits in scope
git diff origin/main...HEAD --stat        # files touched + churn (merge-base form)
```

If a ticket/issue id is on the branch name or in the conversation, capture it for the "Why" section. Draw the *why* (and the rationale for any new default) from the ticket/commits/conversation — never invent it.

## Step 4 — Draft the description

Fill the sections of [`.github/pull_request_template.md`](../../../.github/pull_request_template.md), **deleting any that don't apply**. Keep it short — **length scales with the change**; a one-line fix gets a few lines, not a wall. Rules per section:

- **TL;DR** — one plain, user/system-facing sentence: *what happens* and the resulting behaviour, not internals. No URLs/endpoints, no raw code identifiers, minimal jargon.
- **What changed?** — the parts a reviewer can't get from the diff: the approach and any tradeoff/decision behind it, **not a file-by-file list**. If the change adds new flags/config/defaults, say they're new and why those defaults were chosen.
- **Why make this change?** — ≤2 non-technical sentences plus a link to the issue/ticket. The real motivation, not a side-effect; no irrelevant facts.
- **How to test?** — concrete reviewer steps. Skip anything CI already proves (don't write "builds clean" / "units pass"). **Show the result, not just what you ran:** where you can, include a before/after, trimmed command/test output, a screenshot, or a reference — not a bare "tested it".
  - **New tests** — the flows/edge cases now covered in `tests/*.test.ts` (the unit suite covers the platform-agnostic core), **not** a list of files. If none, say why (e.g. "driver/platform method — device-verified only", or "covered by existing `selector.test.ts`").
  - **Manual testing performed** — there is no device CI, so this is the only record of on-device behaviour: who · device or emulator + OS · which `vk` commands · what you confirmed. The connected device may be a personal phone — avoid destructive actions (submitting forms, creating accounts) while exercising it.
- **Docs & contracts** — tick the boxes that apply (README + SKILL for CLI changes; `usageText()` / `RECORDABLE` for a new command; a `tests/<module>.test.ts` case for a new pure core function). Delete the block if the PR touches none of it.
- **Out of scope & next steps** *(optional)* — what you deliberately left out and why, known rough edges, and any follow-ups. Drop it if empty.

Never add a "Generated with Claude Code" / AI-attribution footer — almost all work here is AI-aided, so it carries no signal.

### Before / after

Bad — TL;DR leaks internals, "What changed" lists files:

> **TL;DR** Add `cmdLog` + `getLogs()` to `drivers/adb.ts`.
> **What changed?** Added `logStart` to `run.ts`; edited `cli.ts`, `report.ts`, `types.ts`, `report.test.ts`, …

Good — plain intent, behaviour over files, new flags called out:

> **TL;DR** New `vk log` command pulls the device's logs into the test-run report, scoped to the current run by default.
> **What changed?** On-demand device-log capture that attaches to the run report. New window flags — `--since` / `-n` / `--full` — default to the current session so logs from before the run are excluded.

## Step 5 — Create the PR

Write the drafted body to a temp file — multi-line markdown is fragile inline. Default to a **draft**; only publish (mark ready) if the user explicitly said "publish" / "mark ready for review" / "not a draft".

First, don't create a duplicate — check whether this branch already has an open PR:

```sh
gh pr list --head "$(git branch --show-current)" --state open
```

- If one already exists, update it instead of opening another:
  ```sh
  gh pr edit <n> --title "<title>" --body-file <tmp>
  ```
- Otherwise create it as a draft:
  ```sh
  gh pr create --draft --base main --title "<title>" --body-file <tmp>
  ```

## Step 6 — Post-create

Verify draft state and grab the URL:

```sh
gh pr view --json number,url,isDraft
```

If it should be a draft but isn't, `gh pr ready <n> --undo`. Leave it as a draft (don't auto-mark-ready). Report the PR URL. Don't post to Slack or add internal thread links.

## What to avoid

- Pasting the full diff or narrating it file-by-file — the diff shows the files.
- URLs or code identifiers in the TL;DR; filler openers ("This PR introduces…", "This pull request…").
- A side-effect framed as the reason; irrelevant facts.
- Restating what CI proves ("builds clean", "units pass") — CI runs `npm run build` + `npm run test:ci` on Node 20.x and 22.x.
- Bumping the version or dating a `CHANGELOG.md` entry for a purely internal change (refactor / CI / tests / docs) — those ship without either.
- Bumping `package.json` but forgetting `package-lock.json` or `.claude-plugin/plugin.json` — they've drifted before; keep them in lockstep. (`src/version.ts` is regenerated from `package.json` by `npm run build`'s `prebuild`, so never hand-edit it — it follows automatically.)
- Skipping the testing section — if untested, say why.
- Claiming testing without showing the result — include the before/after, output, screenshot, or reference.
- A "Generated with Claude Code" footer; Slack/internal thread URLs in the body.
- Publishing (marking ready) unless the user explicitly asked.
- Inventing ticket ids, or rationale for a default you didn't actually find.
