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

Open a pull request for the current branch with a description a reviewer can scan in seconds. In order: **rebase onto main → summarise scope → draft a concise, intent-led body → create it as a draft**. The description leads with *why*, then explains the change as **two or three ideas** — never as a re-narration of the diff.

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
  3. **Cut the changelog entry:** in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - <today>` (new version + today's date), describe this change under the right `### Added` / `### Fixed` / `### Changed` heading, and add a fresh empty `## [Unreleased]` above it. Write the bullet in the house style — **one line, ≤ 25 words, leading with the command or flag** — per `.claude/skills/changelog-entry/SKILL.md`. The root cause, the benchmarks and the design rationale go in *this PR's* body, not in the entry; that is the same split the PR rules below ask for.
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

If a ticket/issue id is on the branch name or in the conversation, capture it for the TL;DR's `Resolves` line — and if the conversation describes the problem without naming a number, look it up rather than dropping the link:

```sh
gh issue list --state all --search "<a few words from the problem>"
```

Draw the *why* (and the rationale for any new default) from the ticket/commits/conversation — never invent it.

## Step 4 — Draft the description

Fill the sections of [`.github/pull_request_template.md`](../../../.github/pull_request_template.md), **deleting any that don't apply**. Shorten a heading where a shorter one reads better — `Why`, `How it works`, `Verified`, `Deliberately not done`. It's a checklist of what a reviewer needs, not a form.

**Length scales with the change, and it tops out fast.** A one-line fix is a TL;DR and a testing line; a 2,000-line feature is still only ~800 words, because this is what a reviewer reads *once, before* opening the diff. If a draft runs longer, what's over is nearly always rationale — and rationale already has homes: the commit body, `CLAUDE.md`, `docs/`. Cutting it from here isn't losing it.

Rules per section:

- **TL;DR** — one plain, user/system-facing sentence: *what happens* and the resulting behaviour, not internals. No URLs/endpoints, no raw code identifiers, minimal jargon. If the change has a headline number, it gets **a line of its own below** — `40 min → 13 min on three devices`; one number that makes the case, not a benchmark table. When the PR **resolves** a GitHub issue in this repo, add a [closing keyword](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) — `Resolves #12` (`Closes` / `Fixes` work too) — so merging closes the issue and the two show as linked instead of someone closing it by hand:
  - **On its own line directly under the sentence** (above any headline number), not folded into it — the TL;DR stays one plain sentence, and the link sits where a reviewer sees it first.
  - **Repeat the keyword per issue:** `Resolves #12, resolves #13`. `Resolves #12 and #13` closes only #12.
  - **Only if this PR actually resolves it.** For partial or adjacent work, reference it *without* a keyword — "Part of #43", "Related to #43" — so merging doesn't close work that isn't done.
  - The keyword has to be in the **PR description** to link; the same words in a commit message or a review comment don't.
  - No issue behind the work? Leave the line off and say so in *Why make this change?* ("Requested directly — no ticket.") rather than padding it or inventing a number.
- **What changed?** — **the design as two or three named ideas**, not a tour of the diff. Each idea is a bolded one-line claim followed by two or three plain sentences on the constraint that forced it; a reviewer should understand the shape of the change before meeting a single filename. If the change adds new flags/config/defaults, say they're new and why those defaults were chosen. Resist a fourth idea: a decision-by-decision list is a commit body, not a PR body.
- **Where the risk is** *(large PRs — add it under "What changed?")* — a short **reading order**, hardest first: the two or three files where a wrong change would be *silent* rather than loud, one sentence each on why. An ordered pointer, not an inventory — leave out everything the diff explains by itself.
- **Why make this change?** — ≤2 non-technical sentences: the real motivation, not a side-effect; no irrelevant facts. State the problem as the cost someone was paying, not as the code that caused it. The issue link itself lives in the TL;DR, so don't repeat it here.
- **How to test?** — concrete reviewer steps. Skip anything CI already proves (don't write "builds clean" / "units pass"). **Show the result, not just what you ran:** a before/after, trimmed command/test output, a screenshot, or a reference — not a bare "tested it". Beyond a small fix, make it **a table, one row per claim**, each row something the reviewer could go and check; that scans better than prose and usually absorbs both sub-sections below.
  - **New tests** — the flows/edge cases now covered in `tests/*.test.ts` (the unit suite covers the platform-agnostic core), plus the total, **not** a list of files. If none, say why (e.g. "driver/platform method — device-verified only", or "covered by existing `selector.test.ts`").
  - **Manual testing performed** — there is no device CI, so this is the only record of on-device behaviour: device or emulator + OS, and what you confirmed — claims and outcomes, not a transcript of the session. The connected device may be a personal phone — avoid destructive actions (submitting forms, creating accounts) while exercising it.
- **Docs & contracts** — tick the boxes that apply (README + SKILL for CLI changes; `usageText()` / `RECORDABLE` for a new command; a `tests/<module>.test.ts` case for a new pure core function). Delete the block if the PR touches none of it.
- **Out of scope & next steps** *(optional)* — what you deliberately left out and why, known rough edges, and any follow-ups. Drop it if empty — but **don't shorten it when it isn't**. Everything above is explanation a reviewer can skip; this is the part they're being asked to sign off, so it's the wrong economy.

Never add a "Generated with Claude Code" / AI-attribution footer — almost all work here is AI-aided, so it carries no signal.

### Before / after

Bad — TL;DR leaks internals, "What changed" lists files:

> **TL;DR** Add `cmdLog` + `getLogs()` to `drivers/adb.ts`.
> **What changed?** Added `logStart` to `run.ts`; edited `cli.ts`, `report.ts`, `types.ts`, `report.test.ts`, …

Good — plain intent, behaviour over files, new flags called out:

> **TL;DR** New `vk log` command pulls the device's logs into the test-run report, scoped to the current run by default.
> **What changed?** On-demand device-log capture that attaches to the run report. New window flags — `--since` / `-n` / `--full` — default to the current session so logs from before the run are excluded.

Bad — the reference is buried in the "Why", and a bare URL links nothing, so the issue stays open after merge:

> **TL;DR** Taps no longer land on a covered control.
> **Why make this change?** Fixes the issue. See https://github.com/ddikman/verikun/issues/42

Good — keyword on its own line under the TL;DR, motivation left plain:

> **TL;DR** A tap aimed at a control something else is painted over now fails instead of reporting success.
>
> Resolves #42.
>
> **Why make this change?** A tap could land on a different control and still report success, so a green run didn't mean the flow had worked.

Bad — a decision log: every sentence is true, none of it is the design, and the reviewer meets six internals before one idea:

> **What changed?** The app reset moved inside the test, because from the parent it could reset one phone and test another. The parent holds the device claims and children run `VERIKUN_NO_CLAIM=1`, since `isMine` matches on session or cwd. An empty queue isn't the end while another lane is busy, so the worker idle-polls. Lane retirement has two triggers because the probe can't see through a server…

Good — one named idea, the constraint that forced it, no filenames:

> **A child process per test.** Every device call bottoms out in a blocking `spawnSync`, so tests awaited inside one process wouldn't overlap at all — they'd take turns. A process per test is the smallest thing that makes the parallelism real, and it hands us crash isolation and per-test run state for free.

Bad — a transcript of the session; nothing in it is a claim a reviewer could check:

> Started the server with two phones, ran the suite, disconnected one over TCP, checked the pool, checked the lease, checked the other lease, restored USB, cleaned up the temp dirs.

Good — one row per claim, each one checkable, the numbers left in (a headerless two-column table; the left cell is the claim):

> | | |
> |---|---|
> | Parallel suite through a pooled server | 3/3 green, **43.7s wall vs 81.2s device time** |
> | Failover on a pool | killed a leased device for real: quarantined, spare joined, capacity held at 2, lease followed, the other lease undisturbed |

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
- More than three ideas in "What changed?", or a decision-by-decision rationale list — that is the commit body's job, and `CLAUDE.md`'s. A body much past ~800 words means something in it belongs elsewhere, however big the change.
- A benchmark table where one number makes the case; a session transcript where a row of claims would do.
- URLs or code identifiers in the TL;DR *sentence* (the `Resolves #12` line below it is the exception); filler openers ("This PR introduces…", "This pull request…").
- A side-effect framed as the reason; irrelevant facts.
- Restating what CI proves ("builds clean", "units pass") — CI runs `npm run build` + `npm run test:ci` on Node 20.x and 22.x.
- Bumping the version or dating a `CHANGELOG.md` entry for a purely internal change (refactor / CI / tests / docs) — those ship without either.
- Bumping `package.json` but forgetting `package-lock.json` or `.claude-plugin/plugin.json` — they've drifted before; keep them in lockstep. (`src/version.ts` is regenerated from `package.json` by `npm run build`'s `prebuild`, so never hand-edit it — it follows automatically.)
- Skipping the testing section (if untested, say why), or claiming testing without the result — include the before/after, output, screenshot, or reference.
- A "Generated with Claude Code" footer; Slack/internal thread URLs in the body.
- Publishing (marking ready) unless the user explicitly asked.
- Inventing ticket ids, or rationale for a default you didn't actually find.
- An issue link that doesn't link: a bare `#42` or a plain URL leaves it open after merge — use `Resolves #42` on its own line under the TL;DR, not buried in the "Why". And the inverse — a closing keyword on an issue this PR only *partly* addresses closes work that isn't done; say "Part of #43".
