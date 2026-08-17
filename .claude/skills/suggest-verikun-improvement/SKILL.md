---
name: suggest-verikun-improvement
description: >-
  Draft an improvement suggestion for verikun itself (the `vk` CLI) when driving a device
  surfaced a rough edge in the tool — a model heal on a *cached* replay, a repair give-up,
  or a recurring gotcha. Writes a light, TL;DR-first DRAFT to a local file for the user to
  read and edit, and files nothing to the verikun repo (ddikman/verikun) until they say so.
  Strips every app-under-test specific (package, on-screen text, selector values, test
  prose, logs, screenshots) so no client code or logic can leak. Invoked from the main
  `verikun` skill; use whenever verikun *itself* — not the app, not your selector — was the
  problem and it is worth reporting upstream.
---

# suggest-verikun-improvement — report verikun's own rough edges

verikun improves from the friction people hit while driving it. When verikun **itself** was
the problem, help draft a short suggestion to `ddikman/verikun`. Two rules override
everything else:

1. **It is a DRAFT in a file.** It ends up in `.context/`, not on GitHub. Nothing is filed —
   issue or comment — until the user has read it and said so, every time.
2. **It must never contain anything from the app under test.** No client code, copy,
   selectors, test logic, or screens. The report is about verikun's *behaviour pattern*,
   described generically. When in doubt, cut it.

## When to use

Hand off here when verikun's own behaviour was the friction:

- **Cached-replay heal (strongest signal).** After `vk ai`, stderr shows `[ai] plan cache
  hit` **and** a repair happened, or `--json` has `"cached": true` with `modelRepairs > 0` —
  the deterministic $0 replay still had to wake the model, so verikun's compiled selector
  isn't stable.
- **Give-up.** `vk ai` failed with `drifted, not repaired` — verikun couldn't self-heal a
  step it should have.
- **Recurring gotcha.** A crash, environment error, or wrong exit code in verikun's *own*
  operation you had to work around (a truncated `vk ui` dump, a `launch` that hangs).

**Not** a first-compile heal (expected), a genuine app bug or missing element (that's the
app's issue), or an ambiguous selector you can just refine with `--index`.

## Rule 1 — Redact and generalise EVERYTHING app-specific (critical)

Decide the **class** of the verikun problem and describe only that. Strip the app entirely.

**Never include (remove completely):**

- app package / bundle id; app, brand, or company names
- any on-screen text, label, copy, or content-desc **value**
- selector **values** (`text:"…"`, `desc:"…"`, `@resource_id`) — keep only the selector
  *kind*, never the string it matched
- the natural-language test prose, test file names, or step wording
- screenshots, `vk log` / logcat output, stack traces (may carry secrets)
- device serials, account data (emails, tokens), URLs / endpoints

**Generalise like this:**

| Saw while driving (do NOT send) | Put in the report instead |
|---|---|
| `com.acme.app` | omit — "the app under test" |
| `text:"Already have an account? Sign in"` | "a `text:` selector on a label-only control" |
| healed to `desc:"…the label…"` | "healed to a `desc:` (content-desc) match" |
| `@acme_email_field` | "a field addressed by resource-id" (only if the *kind* matters) |
| NL step "on the paywall, tap Start trial" | "an early onboarding step" — or omit |
| a logcat / stack-trace line | omit entirely |

**Scrub check (do this last, every time):** re-read the finished draft. If any token could
name the app, reveal a screen, quote its copy, or reproduce its selectors or flow, replace
it with the structural description or delete it. If you cannot describe the verikun weakness
without an app specific, the report isn't ready — generalise further.

## Rule 2 — The draft is a file the user reads; you file nothing until they say so

**Being asked to report the friction is not permission to file it.** The only go-ahead that
counts is the user answering *after* they have seen the draft. Until then nothing is
published — no issue, no comment.

**1. Write the draft to a file.** `.context/vk-improve-<fp-slug>.md`, where `<fp-slug>` is the
fingerprint (defined below) with `/` → `-`. Use `.context/` when that directory exists (the
workspace's gitignored scratch dir); otherwise write to the system temp dir and say where it
went — never create a directory inside the repo under test. Line 1 is `# <issue title>` and
everything after it is the issue body, so the title is reviewable and editable like the rest.

**2. Raise it, then stop.** Print the path, the title, the TL;DR line, and — plainly — that
nothing has been sent. Not the whole markdown again: the file is the artifact, the message is
the pointer. Then stop. Don't poll, don't re-ask, and never read silence as a yes.

```
Draft ready — **nothing has been sent.**

Review: .context/vk-improve-android-vk-ai-cached-replay-heal-label-only-no-id.md
Title:  vk ai re-heals label-only controls on every cached replay
TL;DR:  the "$0" cached replay still wakes the model on every run

Edit the file if you want it worded differently, then say "file it" and I'll submit
exactly what it contains.
```

**3. On an explicit go-ahead, file exactly what the file contains** — the user may have edited
it, and what they approved is what goes up:

```sh
FILE=".context/vk-improve-<fp-slug>.md"
# line 1 of the draft is the issue title; everything after it is the body
TITLE=$(head -1 "$FILE" | sed 's/^# *//')
tail -n +2 "$FILE" | gh issue create --repo ddikman/verikun --title "$TITLE" --body-file -
```

Then print the issue URL `gh` returns. (No `--label` — the repo doesn't use labels.)

**4. A comment on an existing issue is a publish too** — same flow, no exception: write it to
`.context/vk-improve-<fp-slug>-comment.md`, raise it, and only on a go-ahead run
`gh issue comment <n> --repo ddikman/verikun --body-file "<that file>"`.

**No `gh`?** Hand over the file path and <https://github.com/ddikman/verikun/issues/new> for
the user to paste into. Never block a run on any of this.

## Keep it light — the report shape

Lead with a one-line **TL;DR**; keep the whole thing scannable. Cut any section that would
just repeat another. This is the whole file — line 1 is the issue title:

```markdown
# <issue title — the weakness in one line>

<!-- vk-improve: <fingerprint> -->

**TL;DR:** <one sentence — the verikun weakness, generalised>

**Pattern:** <cached-replay heal | give-up | gotcha> — <what verikun did, structurally>

**Evidence (generalised):**
- <the verikun-side signal, e.g. `--json` "cached": true + "modelRepairs": 1>
- <the mechanic, e.g. a `text:` selector on a label-only control (no resource-id) healed to
  `desc:`, then re-missed on the next cached replay>

**Environment:** verikun <version> · <android|ios> <os version> · <emulator|physical>

**Repro (generalised):** <steps that reproduce the verikun behaviour WITHOUT the app>

**Proposed fix**
- <2–4 bullets, verikun-side>
```

**Use these field names.** A report that invents its own headings is harder to scan, and
harder to recognise as a duplicate of one already filed.

**`Proposed fix` is a direction, not a design.** Two to four bullets on what should change and
roughly where — never the flag name, the schema, the code, or a section that reads like a
spec. (A long `Shape of the fix` block is exactly what this replaced. That detail belongs in
the implementer's PR, where it can be argued with.)

## De-dup by category (one issue per weakness, not per app)

The fingerprint is a **generalised category** — it carries no app data, and it groups every
app that hits the same verikun weakness into one issue (which is exactly what "improve
verikun" wants):

```
fp = "<platform>/<area>/<category>"
  platform : android | ios
  area     : vk-ai | ui | launch | text | wait | …   (the verikun surface)
  category : a short slug of the weakness class, generalised (no app specifics)
Normalise each part: lowercase; every run of non-[a-z0-9] -> single '-'; trim '-'.
  e.g.  android/vk-ai/cached-replay-heal-label-only-no-id
        ios/vk-ai/give-up-drift
        android/ui/dump-truncation
```

Search before drafting; if it exists, propose a comment rather than a duplicate:

```sh
gh issue list --repo ddikman/verikun --state all --search "vk-improve: <fp>"
```

Found → propose adding a one-line `seen again on v<version>, <platform>` comment, through the
same review as everything else (Rule 2, step 4). Not found → draft a new one carrying the
`<!-- vk-improve: <fp> -->` marker so the next search matches.

## Worked example (fully generalised)

Signal: a green `vk ai` replay logged `plan cache hit` yet did 1 model repair (`"cached":
true`, `"modelRepairs": 1`). The repaired step tapped a control that exposes only an
accessibility label — no resource-id — so verikun's compiled `text:` selector wasn't
deterministic; the model swapped it for a `desc:` match that itself re-missed next replay.
Nothing from the app (its package, the control's text, the flow) goes in the report:

```markdown
# vk ai re-heals label-only controls on every cached replay

<!-- vk-improve: android/vk-ai/cached-replay-heal-label-only-no-id -->

**TL;DR:** `vk ai` re-heals label-only controls (no resource-id) on every cached replay, so
the "$0 replay" still pays for a model repair.

**Pattern:** cached-replay heal — a step whose target exposes only an accessibility label
gets a `text:` selector at compile that isn't deterministically resolvable; the persisted
plan re-misses and wakes the model each replay.

**Evidence (generalised):**
- `vk ai --json`: "cached": true, "modelRepairs": 1
- original selector kind `text:` → healed to `desc:` (content-desc); the control has no
  resource-id, so neither is stable across dumps.

**Environment:** verikun 0.14.0 · android 12 · physical device

**Repro (generalised):** replay any cached `vk ai` plan whose flow taps a control that has
only an accessibility label (no resource-id); run 2 logs `plan cache hit` yet still performs
1 model repair.

**Proposed fix**
- For a target with no resource-id, prefer the accessibility label over `text:` at compile.
- Anchor on the full label, so the persisted selector resolves without waking the model.
```

That file is what gets filed, verbatim, once the user says so — see Rule 2.
