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

verikun ships as a skill and a plugin rather than an MCP server. A skill lets us **guide the
agent on how to use verikun** — when to inspect the hierarchy, what to assert, which command
fits the step, and how to read the result back — so the agent drives the device well rather
than merely correctly. There is also nothing for MCP to broker: verikun runs locally with all
its dependencies, and the agent calls it through the plain `vk` CLI.

## The loop: act → inspect → assert

1. **See** the screen — `vk ui`
2. **Act** by semantic selector — `vk tap @login_button`
3. **Verify** the result — `vk assert text:"Welcome"` (or `vk ui` again)

**Never guess coordinates.** Reference elements by their identifiers and let `vk` resolve
the tap point. A coordinate tap that lands on the wrong thing still exits `0`, and the run
continues from the wrong place.

## Be frugal: text over images

**Perceive with text, not pixels.** `vk ui`, `vk find` and `vk assert` return a few hundred
bytes. A screenshot read back as an image costs far more tokens — one image can outweigh
dozens of `vk ui` calls.

Reach for `vk screenshot` and read the PNG only when you genuinely need pixels: visual
layout, a rendering or spacing bug, or content that carries no text, id or description. When
you do, verikun already [downscales](/verikun/reference/screenshots/) the PNG to a 700px
longest edge so the read stays cheap while text stays legible.

Known gap: very large output, such as `vk ui --json` on a busy screen, can be truncated when
piped, with exit `0` ([#81](https://github.com/ddikman/verikun/issues/81)).

### Two uses of a screenshot — keep them apart

The cost above is about *reading a screenshot back* to decide the next move. One taken purely
as **report evidence and never read back** costs nothing at runtime — so when driving a flow
to produce a report, capture around each significant transition and before any risky or
verification step, and leave the PNG in the report. A failing step already auto-captures its
own screen, and [`vk ai`](/verikun/guides/natural-language-tests/) inserts these review
screenshots itself.

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
identifiers resilient to small label and casing changes.

## Batch a known flow into one call

Once the steps are known, run them as a single
[`vk batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch) rather than one
tool call per command — one process, far fewer round-trips:

```sh
vk batch --file signup.flow
```

## Worked example: an onboarding walkthrough

An agent driving a multi-step Android onboarding flow end to end, with no coordinates and no
hardcoded waits:

```sh
vk screenshot                       # 1. see where we are (read the PNG once)
vk tap @get_started_button_id       # 2. welcome splash
vk tap @tap_to_continue_label_id    # 3. intro screens — same button each time
vk tap @tap_to_continue_label_id
vk tap @target_item_id              # 4. an item further down a list: tap scrolls to it
vk tap @tap_to_continue_label_id    # 5. transition screen
vk ui                               # 6. option grid — [4] ImageView desc="My preferred option"
vk tap 4
vk tap @tap_to_continue_label_id    # 7. sign-up screen reached; onboarding complete
```

The whole session cost about \$0.45 in agent tokens over roughly four minutes.

## Report friction upstream

When verikun *itself* is the friction — a step that heals on every cached replay, a repair
that gives up, or a gotcha in its own operation — that is worth an issue at
[github.com/ddikman/verikun/issues](https://github.com/ddikman/verikun/issues). An agent
running the skill hands off to the **`suggest-verikun-improvement`** skill, which writes a
short suggestion **to a local file for you to read and edit**, **files nothing until you say
so**, and **redacts every app-under-test specific** (package, on-screen text, selector values,
test prose, logs) so no client code or logic can leak.
