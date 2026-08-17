---
title: Using it from an AI agent
description: The act → inspect → assert loop, why the skill exists, and how to keep an agent's token cost down.
sidebar:
  order: 3
---

verikun is designed to be driven by an AI agent. Its output format and
[exit codes](/verikun/reference/exit-codes/) are a machine contract, not just human
ergonomics — an agent can branch on them without parsing prose.

## Install the skill first

The CLI drives the device. The **skill** teaches the agent to drive it well. Install both —
see [Installation](/verikun/getting-started/installation/#register-the-skill-with-your-agent).

The skill lives at
[`.claude/skills/verikun/SKILL.md`](https://github.com/ddikman/verikun/blob/main/.claude/skills/verikun/SKILL.md)
and is the agent-facing contract: the loop below, the selector grammar, exit-code semantics,
and the accumulated gotchas.

## Why a skill and not an MCP server

A skill lets us **guide the agent on how to use verikun** — when to inspect the hierarchy,
what to assert, which command fits the step, and how to read the result back. That domain
knowledge travels with the tool, so the agent drives the device well rather than merely
correctly.

There is also nothing for MCP to broker here. verikun runs locally with all its
dependencies, and the agent calls it through the plain `vk` CLI — no shared session, no
shared data, no authentication handshake.

## The loop: act → inspect → assert

1. **See** the screen — `vk ui`
2. **Act** by semantic selector — `vk tap @login_button`
3. **Verify** the result — `vk assert text:"Welcome"` (or `vk ui` again)

**Never guess coordinates.** Reference elements by their identifiers and let `vk` resolve
the tap point. This is the whole point of the tool: a coordinate tap that lands on the wrong
thing still exits `0`, and the run continues from the wrong place.

## Be frugal: text over images

**Perceive with text, not pixels.** `vk ui`, `vk find` and `vk assert` return a few hundred
bytes. A screenshot read back as an image costs far more tokens — one image can outweigh
dozens of `vk ui` calls.

Reach for `vk screenshot` and read the PNG only when you genuinely need pixels: visual
layout, a rendering or spacing bug, or content that carries no text, id or description. When
you do, verikun already [downscales](/verikun/reference/screenshots/) the PNG to a 700px
longest edge so the read stays cheap while text stays legible.

### Two uses of a screenshot — keep them apart

The cost above is about *reading a screenshot back into context* to decide the next move.
That is what to avoid.

A screenshot taken purely as **report evidence and never read back** costs nothing at
runtime. So when driving a flow to produce a report, **do** capture around each significant
transition and before any risky or verification step — then leave the PNG in the report
without reading it. A visual trail makes post-run review far easier, and a failing step
already auto-captures its own screen.

[`vk ai`](/verikun/guides/natural-language-tests/) inserts these review screenshots
automatically.

## Remember identifiers across runs

After a flow succeeds, save the selectors you found — the mapping from human intent to
selector, plus the screen and step order:

> Signup flow: "Get Started" → `@get_started`; intro slides → `@continue_btn` (tap ×2);
> plan picker → `text:"Free trial"`; account form → `@email_input`, then submit with
> `text:"Create account"`.

Next time a similar request arrives, **reuse the remembered selectors directly** instead of
re-inspecting from scratch — fewer round-trips, fewer tokens, faster runs. Re-verify cheaply
with `vk assert` or `vk find`; fall back to a full `vk ui` only when a remembered selector
stops resolving, which means the app changed and the memory needs updating.

[Selector auto-healing](/verikun/reference/selectors/#auto-healing) makes remembered
identifiers resilient to small label and casing changes, so this holds up better than you
would expect.

## Batch a known flow into one call

Once the steps are known, run them as a single
[`vk batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch) rather than one
tool call per command — one process, far fewer round-trips:

```sh
vk batch <<'EOF'
launch com.example.app
tap @get_started
tap @continue_btn
assert text:"Choose a plan" --wait 8s
EOF
```

## Worked example: an onboarding walkthrough

A Claude agent drove a multi-step Android onboarding flow end to end using only `vk`
commands — no coordinates, and no hardcoded waits beyond a `sleep 1` on transitions:

```sh
# 1. See where we are
vk screenshot               # read PNG to confirm current screen

# 2. Welcome splash
vk tap @get_started_button_id

# 3. Intro/explainer screens — same button each time
vk tap @tap_to_continue_label_id
vk tap @tap_to_continue_label_id

# 4. Scrollable list — scroll until the item is visible, then tap
vk swipe up
vk tap @target_item_id

# 5. Transition screen after selection
vk tap @tap_to_continue_label_id

# 6. Option grid — inspect to find the right index, tap it
vk ui                        # [4] ImageView desc="My preferred option"
vk tap 4

# 7. Final screen before sign-up
vk tap @tap_to_continue_label_id
# → sign-up screen reached; onboarding complete
```

**Cost:** \$0.45 · **Wall time:** ~4 min · **Model:** Claude Sonnet 4.6 with prompt-cache
hits (1M cache-read tokens kept cost low on a long conversation).

:::note
Step 4's explicit `vk swipe up` is no longer necessary — `tap` and `text` now
[scroll their target into view](/verikun/reference/auto-wait/#auto-scroll-into-view)
automatically. The walkthrough is kept as recorded.
:::

## Report friction upstream

verikun improves from the rough edges people hit while driving it. When verikun *itself* is
the friction — a step that heals on every cached replay (usually an unstable compiled
selector, often a label-only control with no resource-id), a repair that gives up, or a
gotcha in its own operation — that is worth an issue at
[github.com/ddikman/verikun/issues](https://github.com/ddikman/verikun/issues).

If you are driving verikun with an AI agent plus the skill, it hands off to the
**`suggest-verikun-improvement`** skill, which writes a short, TL;DR-first suggestion **to a
local file for you to read and edit**, **files nothing until you say so**, and **redacts every
app-under-test specific** (package, on-screen text, selector values, test prose, logs) so no
client code or logic can leak.
