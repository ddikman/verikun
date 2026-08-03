---
name: suggest-verikun-improvement
description: >-
  Draft an improvement suggestion for verikun itself (the `vk` CLI) when driving a device
  surfaced a rough edge in the tool — a model heal on a *cached* replay, a repair give-up,
  or a recurring gotcha. Produces a light, TL;DR-first DRAFT the user reviews before
  anything is submitted to the verikun repo (ddikman/verikun), and strips every
  app-under-test specific (package, on-screen text, selector values, test prose, logs,
  screenshots) so no client code or logic can leak. Invoked from the main `verikun` skill;
  use whenever verikun *itself* — not the app, not your selector — was the problem and it is
  worth reporting upstream.
---

# suggest-verikun-improvement — report verikun's own rough edges

verikun improves from the friction people hit while driving it. When verikun **itself** was
the problem, help draft a short suggestion to `ddikman/verikun`. Two rules override
everything else:

1. **It is a DRAFT.** Never submit anything without showing it to the user first and getting
   an explicit go-ahead. The user reviews before submission — always.
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

## Rule 2 — Draft first; the user submits

Never file silently. Build the draft, **show it in chat**, and state plainly that it is a
draft and nothing has been sent. Submit only after an explicit go-ahead, and prefer a path
where the **user** is the one who clicks submit:

- **`gh` available →** `gh issue create --web --repo ddikman/verikun --title '<t>' --body '<b>'`
  opens the prefilled GitHub form for a final human review + submit. (No `--label` — the
  repo doesn't use labels.)
- **User explicitly wants it filed directly** (e.g. from CI) → `gh issue create --repo
  ddikman/verikun --title '<t>' --body '<b>'`.
- **No `gh` →** print the prefilled
  `https://github.com/ddikman/verikun/issues/new?title=<enc>&body=<enc>` URL and the raw
  markdown for the user to open and submit.

If `--web` rejects a long body (URL length limit), show the markdown for manual paste
instead. Never block a run on any of this.

## Keep it light — the report shape

Lead with a one-line **TL;DR**; keep the whole thing scannable. Cut any section that would
just repeat another. Template:

```markdown
<!-- vk-improve: <fingerprint> -->

**TL;DR:** <one sentence — the verikun weakness, generalised>

**Pattern:** <cached-replay heal | give-up | gotcha> — <what verikun did, structurally>

**Evidence (generalised):**
- <the verikun-side signal, e.g. `--json` "cached": true + "modelRepairs": 1>
- <the mechanic, e.g. a `text:` selector on a label-only control (no resource-id) healed to
  `desc:`, then re-missed on the next cached replay>

**Environment:** verikun <version> · <android|ios> <os version> · <emulator|physical>

**Repro (generalised):** <steps that reproduce the verikun behaviour WITHOUT the app>

**Suggested fix:** <optional, verikun-side>
```

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

Found → propose adding a one-line `seen again on v<version>, <platform>` comment. Not found
→ draft a new one carrying the `<!-- vk-improve: <fp> -->` marker so the next search matches.

## Worked example (fully generalised)

Signal: a green `vk ai` replay logged `plan cache hit` yet did 1 model repair (`"cached":
true`, `"modelRepairs": 1`). The repaired step tapped a control that exposes only an
accessibility label — no resource-id — so verikun's compiled `text:` selector wasn't
deterministic; the model swapped it for a `desc:` match that itself re-missed next replay.
Nothing from the app (its package, the control's text, the flow) goes in the report:

```markdown
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

**Suggested fix:** for a target with no resource-id, prefer the accessibility label
(`desc:`) at compile and anchor on the full label, so the persisted selector resolves
deterministically and the replay stays $0.
```
