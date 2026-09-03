---
title: Natural-language tests
description: How vk ai compiles plain English into a deterministic plan, replays it model-free, and self-heals a drifted step.
sidebar:
  order: 2
---

`vk ai <file>` runs a test written in plain English. It treats the model as a **compiler,
not a runtime**.

## The cost model

This is the idea the whole feature is built around:

1. **Compile once.** The prose is compiled into a deterministic
   [plan IR](/verikun/reference/ai-plans/). You pay tokens for this.
2. **Cache it**, keyed by the test text plus the app build.
3. **Replay model-free.** On the happy path, the plan runs with **no model calls at all**.
4. **Repair on drift.** The model is woken only to fix a step whose selector stopped
   resolving. A green run persists the repaired plan, so the next run is free again.

That is what keeps a CI suite's steady-state token cost near zero. A green suite costs
roughly \$0; you pay on first compile and on a genuine repair.

That steady state assumes a machine that **keeps** `./.verikun/plans/`. A throwaway CI runner
starts cold and recompiles every test on every run unless you persist it — see
[Self-healing in CI](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache).

For the arithmetic behind the number — when a model is called, how the estimate is computed,
and why the `--max-cost-usd` ceiling is per test rather than per suite — see
[Cost & budget](/verikun/reference/cost/).

```sh
vk ai onboarding.md                       # first run: compile, then run
vk ai onboarding.md                       # cached: replays with no model call
vk ai onboarding.md --show-plan           # print the compiled plan, don't run
vk ai onboarding.md --max-cost-usd 0.50   # tighten the spend cap (default $3)
vk ai onboarding.md --timeout 5m          # tighten the run timeout (default 15m)
vk ai onboarding.md --recompile           # ignore the cache
```

## Writing the test

A test is a plain Markdown file. Write it the way you would describe the flow to a
colleague:

```md title="onboarding.md"
Launch com.example.app fresh.
If a notifications permission dialog appears, allow it.
Tap "Get started", then assert the home tab is visible.
```

Guidance that materially improves the compiled plan:

- **Name the app package explicitly** in the first line, or pass `--package`.
- **Say "if … appears"** for anything optional. That is what compiles to an `if-present`
  guard rather than an unconditional step that fails when the dialog is absent.
- **Say what to assert**, not just what to tap. An assertion is the only part of the plan
  that is never healed, so it is the part that actually tests something.
- **Prefer identifiers you know** over descriptions of appearance. "Tap `@get_started`" is
  compiled verbatim; "tap the big green button" is a guess.

## Share a preamble between tests

Every test in a suite tends to need the same opening — cold start, sign in, dismiss whatever
post-auth screens appear, land on a known screen. Written out per test, that block is
maintained N times and drifts. `@include <path>` on its own line splices another file's prose
in where the line sits:

```md title="tests/checkout.md"
# Checkout

@include _signed-in.md

1. Tap the basket (`@basket`).
2. Assert the total reads "£12.00".
```

```md title="tests/_signed-in.md"
Launch com.example.app with its data cleared.
Type the credentials from the environment into the sign-in form and submit it.
If a "rate this app" dialog appears, dismiss it.
Repeat until the home tab (`@home`) is showing, tapping past any onboarding card.
```

- **Paths are relative to the including file**, so a fragment moves with the tests that use
  it. A fragment may include another; an include *cycle* is a usage error (exit `2`) naming
  the chain.
- **Name a fragment `_something.md`.** `vk suite` skips `_`-prefixed files, so a fragment
  never runs as a test of its own — no report row, and no `--app` data reset that would
  leave nothing behind for the test that included it. (A fragment in a subdirectory is
  skipped too: suite discovery is not recursive.)
- **The cache key is the resolved text**, so editing a fragment recompiles every test that
  includes it. It cannot silently replay a stale plan.
- **Each chunk compiles and caches on its own**, and the compiled steps are spliced together.
  A preamble shared by nine tests is compiled once; editing it costs one compile rather than
  nine, because each test's own prose is still cached. Progress names the file and line each
  chunk came from. "Once" holds across a [parallel suite](/verikun/guides/suites/) too — the
  lanes share a cache, so the first to reach a fragment compiles it and the rest wait.
- **A fragment holds steps, not a whole test.** It is compiled knowing it is one section of
  a larger test, so it neither re-launches the app nor adds a teardown the surrounding test
  already owns.

`@include` inside a fenced code block is left alone — that is documentation, not a directive.

## Getting the credentials in place

`vk ai` needs a model. You have three options:

| Option | Set up | Cost |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | metered |
| OpenAI | `OPENAI_API_KEY` | metered |
| A logged-in agent CLI | `codex login` or `cursor-agent login`, then `--model codex-cli` / `--model cursor-cli` | **no key needed** — billed to your existing subscription |

The CLI backends run read-only in a scratch directory, so they never touch your working
tree. Their reported cost is `$0`, which also means `--max-cost-usd` and `--cost-override`
are no-ops for them.

See [AI plans & models](/verikun/reference/ai-plans/#models) for the full model list.

:::caution
Never inline a credential in the prose. Use a `{{env.NAME}}` placeholder — the value is read
at replay time, and a missing or empty variable **fails the step** rather than typing an
empty string. See [placeholders](/verikun/reference/ai-plans/#placeholders).
:::

## Control flow the plan can express

This is what a flat [`batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch)
script cannot do:

- **`if-present`** — optional interstitials such as permission dialogs.
- **`repeat … until`** — bounded loops, e.g. scroll until a row appears. Carries a hard
  iteration cap **and** stops early if the screen stops changing.
- **`when`** — ordered n-way dispatch with an optional `else`.
- **`while-present`** — loop while something is on screen, with a bound counter you can
  reference.
- **`read`** — capture a value off the screen into a variable for a later step.

Full grammar: [AI plans & models](/verikun/reference/ai-plans/).

### The `if-present` settle window

An `if-present` guard **waits for its selector to settle** before deciding the optional UI is
not there, so a dialog that animates in a beat after the transition is still caught.

The window guarantees at least two looks at the screen. Wall-clock alone is not a usable
unit here — a UI dump ranges from roughly 200 ms on a fast phone to 2.5 s on an emulator —
so an absent guard costs about one extra dump. `VERIKUN_GUARD_SETTLE_MS` tunes it; `0`
restores the old single-shot probe.

A loop's own exit check never pays this window: it is absent on every iteration by
construction, which is what makes it a loop.

## Healing, and what is never healed

When a step's selector stops resolving, verikun wakes the model with the live screen and
asks for a decision. There are exactly two answers:

- **Repair** — the model returns one replacement command leaf that serves the same
  user-facing purpose. The run continues.
- **Give up** — the live screen has nothing serving that intent (the flow drifted to the
  wrong screen or app). This is **terminal**; the test fails.

The give-up path is load-bearing. Without it, a "too kind" fallback tap onto an unrelated
screen would pass as a false green — which is worse than a failure, because nobody
investigates a green run.

**An `assert` failure is never healed.** Healing a failed assertion would mask the exact
regression the test exists to catch. See
[Contracts](/verikun/internals/contracts/#heal-vs-terminal).

## What a run gives you

- **Progress streams to stderr**, so a CI job never goes silent. **stdout is the report
  path** (or a JSON summary with `--json`). The compiled plan is logged to the run before it
  executes, for troubleshooting.
- **Cost and time are bounded by default.** Each run reports
  `compile=$… · repairs=$… · replay=$0 · cache_read=… tok · est $…` and aborts if the estimate
  crosses **`--max-cost-usd` (default \$3, per test)** or the wall clock passes **`--timeout`
  (default 15m)** — so a runaway loop or repair cannot spend or hang without limit. See
  [Cost & budget](/verikun/reference/cost/).
- **The same JUnit + HTML report** as any other flow, plus the cost line and any **suggested
  test improvements** — workarounds the model applied, which you can fold back into the
  prose to stabilise the test and cut tokens.
- **Review screenshots are inserted automatically.** The compiler adds `screenshot` steps
  around transitions and inside loops, so the report carries a before/after visual trail.
  They are dumped for humans, never read back by the model (no token cost on replay), and
  never gate the test — a capture that hiccups is logged and skipped, not a failure.

## When a plan is recompiled

The cache is keyed by the test text and the app build, and gated by a **compiler
fingerprint**. A cached plan is discarded — and the test recompiled — when:

- the prose changed — including the prose of any fragment it `@include`s
- the app build changed (`--app-build`)
- verikun itself was updated, or its grammar or repair prompt changed

That last one is deliberate: a plan an older compiler produced must never be replayed by a
newer engine. Details in
[Contracts](/verikun/internals/contracts/#the-plan-cache-fingerprint).

## Example tests

The repository ships two working examples that run against a Flutter fixture app:

- [`example/example-test.md`](https://github.com/ddikman/verikun/blob/main/example/example-test.md)
  — a login form with a disabled-until-valid submit, label-based back navigation, and an
  8-second delayed load that needs an explicit timeout.
- [`example/example-test-devicestate.md`](https://github.com/ddikman/verikun/blob/main/example/example-test-devicestate.md)
  — sets dark mode and a font scale, asserts the app *observed* the change, then resets.

Both open with `@include _launch-to-home.md`, the launch-and-confirm-home block they share.

Run them as a suite:

```sh
vk suite example --model codex-cli
```

## Where to go next

- [Suites](/verikun/guides/suites/) — many tests, one gated run
- [AI plans & models](/verikun/reference/ai-plans/) — the plan grammar and the model list
- [Plan IR & the replay engine](/verikun/internals/plan-ir-and-engine/) — why the IR is
  shaped the way it is
