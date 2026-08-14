---
name: changelog-entry
description: >-
  Write or rewrite a `CHANGELOG.md` entry in the terse, one-line-per-change house style used by
  axios, React and lodash. Use whenever you are about to add, edit, trim or review a changelog
  entry — including when the user says "add a changelog entry", "update the CHANGELOG", "note
  this in the changelog", "cut the release notes", or complains that an entry reads too long,
  verbose, wordy or essay-like. Use it *before* writing the `## [Unreleased]` bullet this repo
  requires for every behaviour change, so the entry lands short the first time instead of being
  trimmed later, and use it when cutting `## [Unreleased]` to a dated version heading.
metadata:
  internal: true
---

# Changelog entries

A changelog entry is a **scan target**, not an explanation. Its reader is deciding *should I
upgrade* and *did this break me* — they arrive with a symptom or a version number and skim the
left edge of the bullets. Every extra clause pushes the next entry further down the page, so a
verbose changelog is read less thoroughly than a terse one, not more.

Write **one line per change**. Target **≤ 25 words**; treat 40 as the ceiling.

For calibration, median words per bullet in the changelogs this style is drawn from:

| axios | React | lodash | this repo (before this skill) |
|--:|--:|--:|--:|
| 10 | 14 | ~3 (bug/docs bullets) | **66** (mean 96, longest 712) |

## The shape

```
- **<surface>**: <what a user now observes>. ([#123](https://github.com/ddikman/verikun/issues/123))
```

- **Lead with the surface** — the command, flag, API or subsystem, bolded or in backticks:
  `**\`vk server\`**`, `**\`--no-wait\`**`, `**Android screenshots**`. Someone scanning for
  `vk launch` finds it at the left edge or not at all; a bullet that opens *"After a force-stop
  the platform reports…"* is invisible to them.
- **State the new behaviour, not the bug's mechanism.** "does this affect me" is answered by
  symptom + resolution. Root cause is the pull request's job.
- **Link out.** The issue/PR reference is what lets the entry be short: the depth still exists,
  one click away and out of the scan path.

## What belongs somewhere else

This is the whole trick. Long entries happen because good engineering content has nowhere else to
go — so give it a home rather than deleting it. In this repo every one of these homes is already
required by `CLAUDE.md` in the *same commit*, which means a paragraph in the changelog is usually
a third copy of something `docs/` now owns.

| Content | Where it goes |
|---|---|
| Root cause; why the fix is shaped this way | commit body / PR description |
| Benchmark tables, measurement runs, before/after timings | PR description (keep the single headline number in the entry) |
| Design rationale, alternatives rejected, "the obvious approach doesn't work" | `CLAUDE.md` or `docs/internals/` |
| A gotcha a future maintainer must not undo | a code comment at the site |
| How to use the new thing | the owning `docs/` page + `SKILL.md` |

## Keep, cut

**Keep** — headline numbers (`2.44s → 0.18s`, `12x`, `exit 3`), the platform if the change is
one-platform-only, the issue link, and every item of **negative space** below.

**Cut** — measurement tables; *"Measured on a Pixel 3a…"*; *"worth recording:"*; profiling
breakdowns; what the code used to do internally; internal module and file paths; the story of how
the bug was found; any sentence whose subject is a private function.

### Negative space survives the cut

Trimming attacks one category first, and it is the most expensive one to lose: the **boundary** of
a change — what it does *not* fix, and what it obliges the reader to do. A one-line entry naturally
keeps the good news, because that is the sentence you set out to write. These four survive anyway,
even if they cost the bullet a second clause:

- **An unchanged failure case — name the command that still fails, and its exit code.** *"A bare
  `vk ui` still exits `3`."* Without it the reader upgrades expecting a fix, hits the same error,
  and concludes the release was a lie. Bounding the fix from the positive side is the near-miss to
  avoid: *"polling commands now wait through it"* leaves the reader to work out that `vk ui` is not
  a polling command **and** that it therefore still fails — two inferences, at the moment they are
  least able to make them. Say which command still breaks.
- **A new default**, and what it was before.
- **A new outbound call, file write or permission** — the thing a firewalled or airgapped user must
  know before upgrading.
- **The opt-out** — the flag or env var that switches the new behaviour off, named exactly.

Everything else — root cause, benchmarks, rejected alternatives — really can go. If a change has no
boundary of this kind, the entry is genuinely one clause and you are done.

## Worked examples

Drawn from this repo's own history — each *before* is what actually shipped.

**Before** (216 words, plus a four-row benchmark table):

> **The companion no longer switches itself off for the rest of a long-lived process** — which is
> why `vk server` got no speedup from 0.21.0 at all ([#77]). It engages there exactly as it does
> locally; it just stopped at the first hiccup and never started again. […] A stand-down was
> latched for the life of the process and `dims` was cached, so `ensureReady()` — the only path
> that restarts the companion from its device note — became unreachable after the first
> successful read. […]

**After** (23 words):

> - **`vk server` no longer drops to the slow read path permanently** after one companion hiccup —
>   a 12-command flow goes 42.6s → 7.9s. ([#77])

---

**Before** (89 words):

> **`vk server` says which read path it is using**, on startup (`[server] reads: companion (ready
> app held)`) and as a `reads` field on `/v1/health`; a `--server` client echoes it once at run
> start. Reads execute server-side, so this was the one end of the connection that knew — and
> without it a companion that had silently stood down was indistinguishable from one that never
> engaged, for a whole suite. […]

**After** (19 words):

> - **`vk server` reports its read path** on startup and as `reads` on `/v1/health`; `--server`
>   clients echo it once. ([#77])

---

**Before** (198 words about `screencap -p`, host-side encoding costs, and a new optional
`Driver.screenshotRaw()`):

**After** (22 words):

> - **Android screenshots are ~2x faster** and byte-for-byte identical — `vk screenshot` 2.60s →
>   1.12s on an SM-A415F. iOS is unchanged.

Note what survived: the user-visible speedup, the number, and the scope. `screenshotRaw()` is an
internal seam — it belongs in `docs/internals/`, and the *"why the larger transfer is fine"*
reasoning belongs in the PR.

## When a longer entry is earned

Two cases, and only two:

1. **A breaking change with a migration.** Spend the extra lines on the *fix the reader must
   apply* — a before/after snippet is fine — never on the rationale for breaking it.
2. **A release-level summary.** One sentence directly under a version heading, saying what the
   release is about, the way axios opens each release. One sentence, not a paragraph.

Everything else that feels like it needs three paragraphs is a signal that two of them belong in
the table above.

## This repo's mechanics

- Entries go under `## [Unreleased]` with a Keep a Changelog heading: `### Added`, `### Changed`,
  `### Fixed`, `### Removed`, `### Deprecated`, `### Security`. Pick by what the reader
  experiences, not by how the code changed — a refactor that fixes a symptom is `Fixed`.
- Cutting a release renames `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and adds a fresh empty
  `## [Unreleased]` above it. `CLAUDE.md` owns the rest of that ritual (version bump, docs).
- Collect reference-style links (`[#77]: https://…`) at the end of the version's section, as the
  file already does, so bullets stay narrow.
- A docs-only change still takes an entry, but `No version bump: no CLI behaviour changed.` goes
  in the **commit body** — it is a note to reviewers, not to users.

## Before you finish

Read each bullet back and ask, in order:

1. **Does the first four words name the thing the reader uses?** If not, rewrite the opening.
2. **Count the words.** Over 25, find the clause a reader must *act* on and keep only that; the
   rest goes to the PR body.
3. **What does this change still not do?** If there is an unchanged failure case, a new default, a
   new outbound call or an opt-out, it belongs in the entry — this is the one thing trimming
   reliably eats, because the sentence you set out to write was the good news.
4. **Would this still make sense to someone who has never seen the code?** Internal names,
   function names and file paths usually mean the sentence is aimed at the wrong reader.
5. **Is there a link carrying the detail?** If the entry feels thin without one, add the link
   rather than the paragraph.
