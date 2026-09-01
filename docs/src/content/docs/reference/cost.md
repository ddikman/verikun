---
title: Cost & budget
description: When verikun calls a model, how the spend estimate is calculated, and how --max-cost-usd bounds it.
sidebar:
  order: 11
---

## What costs money

**Only `vk ai` and `vk suite` ever call a model.** Every other command — `tap`, `text`, `ui`,
`find`, `assert`, `swipe`, `screenshot`, `batch`, `run archive`, `device set`, `devices` — drives
the device directly and costs nothing, ever. They need no API key and have no budget.

Within `vk ai`, a model is called in exactly **two** phases, and neither of them is the phase that
does the work:

| Phase | Model calls | Bounded by |
|---|---|---|
| **Compile** — prose → plan IR | 1 on a cache miss, plus 1 if the plan lint asks for a guided retry | `--max-cost-usd` |
| **Repair** — a step's selector stopped resolving | up to 3 per failing step | `--max-cost-usd`, `--timeout` |
| **Replay** — running the plan on the device | **none** — always `$0` | — |

That is the whole cost model: pay once to compile, replay free, pay again only when the app drifts
under a step. See [Natural-language tests](/verikun/guides/natural-language-tests/#the-cost-model)
for the design rationale.

## When the model is called

### Compile

A compile happens when the [plan cache](/verikun/reference/ai-plans/#the-plan-cache) misses. Four
things cause a miss:

| Cause | Detail |
|---|---|
| The cache key changed | Key is the test prose **byte-exact**, plus `--package`, `--app-build` and the platform. A reworded sentence is a new key. |
| The compiler fingerprint rotated | verikun's version plus its grammar and repair-prompt text. **A verikun upgrade re-spends the whole suite** — deliberately, so a plan an older compiler produced is never replayed. |
| `--recompile` / `--no-cache` | Skips the read outright. |
| No cache on disk | A fresh CI runner has no `./.verikun/plans/` — see [the cold cache](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache). |

The **lint retry** can add a second call: after compiling, verikun checks the plan against the
prose, and one finding triggers exactly one guided recompile. It is skipped if the budget is
already spent, in which case the first plan is kept rather than paying for a better one.

Two spenders that surprise people:

- **`--show-plan` still compiles, and still spends.** It skips the device, not the model.
- **Seeding from a prior build is still a paid compile.** A prior plan goes into the prompt as a
  starting point, which makes the *result* better, not the call cheaper — it is a larger input for
  the same one call.

### Repair

A repair is triggered **only** by a selector that misses or resolves ambiguously. It is capped at
**3 attempts per failing step** — a fixed number with no flag.

An `assert` failure never heals, so it never costs anything: a failed assertion returns exit `1`
rather than throwing, which is what makes it structurally unhealable. Neither does an environment
error, a guard, or a `read`. See [Self-healing in CI](/verikun/guides/self-healing-in-ci/).

## How the estimate is calculated

Each API response reports its token usage. Every response is priced with the same formula:

```
(input × in$  +  output × out$  +  cache_write × in$ × 1.25  +  cache_read × in$ × 0.1)  ÷  1,000,000
```

where `in$` and `out$` are the model's price per **1M** tokens
([where they come from](#where-the-rates-come-from)). Worked through, with an illustrative rate of
\$3 in / \$15 out per 1M — read your model's real rate from the table:

```
input        1,500 tok
output       2,000 tok
cache_write  6,000 tok    the stable grammar prefix, written on the first call
cache_read       0 tok

(1500 × 3  +  2000 × 15  +  6000 × 3 × 1.25  +  0)  ÷  1,000,000
= (4,500  +  30,000  +  22,500)  ÷  1,000,000
= $0.0570
```

Four things about that formula are worth knowing, and none of them are visible from the outside:

- **Cache write is `1.25 ×` the input rate, and is *added to* normal input — not substituted for
  it.** The large, stable part of the prompt (the grammar) is cached so that repeat calls read it
  cheaply, but the call that *writes* the cache pays a surcharge. Caching only pays off from the
  second call onward, and compile and repair use **different** prefixes, so a compile's cache write
  does not serve a later repair.
- **Cache read is `0.1 ×` the input rate** for every model except `gpt-4.1`, which bills it at
  `0.25 ×`.
- **`--effort` raises cost through the *output* rate.** Reasoning models bill their reasoning
  tokens as completion tokens, so a higher effort is a bigger output bill, not a bigger input one.
  It has no effect on `gpt-4.1` (non-reasoning) or on the CLI backends.
- **It is an estimate, and it under-counts.** Usage is only recorded from a *successful* response,
  so an attempt that was rate-limited and retried contributes nothing to the number, and a response
  that arrives without a usage block is counted as zero. The repair cap and `--timeout` are what
  keep that bounded.

## Where the rates come from

Every model carries two numbers: USD per 1M input tokens and USD per 1M output tokens.

**The single source of truth is
[`src/agent/cost.ts`](https://github.com/ddikman/verikun/blob/main/src/agent/cost.ts)** — read your
model's rate there. The same table drives the `--model` allowlist and the provider routing, so a
model's price, its allowed-ness and its backend can never disagree. The file also records the date
each vendor's prices were captured.

For which models exist, which backend serves each, and which key it needs, see
[AI plans & models](/verikun/reference/ai-plans/#models).

:::caution
Vendor prices drift between releases. `--cost-override <input/output>` (dollars per 1M, e.g.
`--cost-override 3/15`) is the escape hatch, and is authoritative when supplied — it wholly
replaces the bundled entry for that run.

Two things it does **not** do. It carries no cache-read multiplier, so overriding `gpt-4.1` drops
it from `0.25 ×` back to the `0.1 ×` default. And it only moves verikun's *estimate* — it changes
nothing about what the vendor actually charges you.
:::

## The budget

`--max-cost-usd <n>`, default **\$3**, aborts the run when the running estimate reaches the
ceiling. `--timeout <dur>`, default **15m**, is the second bound.

:::caution[The ceiling is per test, not per suite]
`vk suite` runs each `*.md` file as its own `vk ai` run with its own fresh budget. At the default,
a 20-test suite has an effective ceiling of **\$60**, not \$3. `--retries` compounds it further —
each attempt gets a fresh budget too.

Two ways to bound the total. Lower the per-test figure and multiply out — 20 tests at
`--max-cost-usd 0.25` tops out at \$5, times `1 + --retries` — or set
**`vk suite --max-suite-cost-usd <n>`**, which sums what each test actually spent and stops the
suite once the total crosses it. That one is off by default and exits `1`, not `3`: the box is
fine, the run just did not finish.

The aggregate cap bounds the *total*, not each test — a suite can still overshoot it by up to one
test's ceiling, because the check happens after a test finishes rather than mid-run.
:::

### When it is checked

The budget is a **pre-spend** gate, tested at four points:

1. **Before each further compile of a multi-chunk test** — fatal. A test built from
   [`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests) fragments
   compiles a chunk at a time, and falls back to compiling the whole file if the assembled plan
   fails the lint. Every one of those after the first asks, so a compile cannot quietly cost
   several times the ceiling. Crossing it on the *last* chunk is not a breach — nothing further
   is being asked for, so the plan is finished and point 3 declines to run it.
2. **Before the lint retry** — non-fatal. It keeps the first plan and carries on rather than paying
   for a better one.
3. **After compile, before the device run** — fatal. The run never starts.
4. **Before each repair attempt** — fatal.

Because the check happens *before* a call rather than during it, the actual spend can overshoot the
ceiling by up to one call. It is never checked during replay, because replay never spends.

### What a breach looks like

```
[ai] ABORTED — cost ceiling $3 reached · compile=$3.0142 · repairs=$0.0000 · replay=$0 · cache_read=0 tok · est $3.0142
```

- **Exit `1`** — the same code as an ordinary test failure. There is no distinct budget exit code;
  `abortedForBudget: true` in `--json` is the discriminator. See
  [Exit codes](/verikun/reference/exit-codes/).
- **The run is recorded as failed**, so the JUnit and HTML report show it red. A budget abort can
  never archive green.
- **`--retries` never retries it.** Each attempt would get its own fresh ceiling and simply
  re-abort, having spent twice.
- **A compile-time abort produces no artifacts at all** — no run directory, no report, no JUnit,
  and therefore **empty stdout**. Worth knowing if you script `REPORT=$(vk ai …)`.

## Reading the cost line

Every run prints one line in this shape:

```
compile=$0.0184 · repairs=$0.0000 · replay=$0 · cache_read=12043 tok · est $0.0184
```

| Field | Meaning |
|---|---|
| `compile` | Spend on compiling the prose into a plan, including any lint retry |
| `repairs` | Spend on model repairs of drifted steps |
| `replay` | Always `$0` — running the plan calls no model |
| `cache_read` | Cached input tokens read across the run |
| `est` | `compile + repairs`, the figure `--max-cost-usd` meters |

`cache_read` is the **only** token count ever printed. Input, output and cache-write counts are
converted to dollars and discarded.

Where the line surfaces:

| Surface | Where |
|---|---|
| stderr | Appended to the `[ai] PASS` / `[ai] FAIL …` / `[ai] ABORTED …` verdict, then repeated on a completed run as `[ai] estimated total cost: $…` |
| `vk ai --json` | `cost` (the line) and `costUsd` (the number, 4 dp) |
| HTML report | The `vk ai` box at the top of the run report |
| JUnit XML | `<testsuite><system-out>`, prefixed `vk ai:`. There is no per-`<testcase>` cost. |
| Suite overview | A **Cost** column per test, plus the summary chip |
| Suite `index.json` | `totals.costUsd`, per-test `costUsd`, per-attempt `costUsd` |

## What is free

- **A cache hit.** The plan replays with no model call, so the line reads `est $0.0000`.
- **The CLI backends.** `--model codex-cli` / `--model cursor-cli` shell out to an already-logged-in
  `codex` or `cursor-agent`, billing your ChatGPT or Cursor subscription rather than per token.
  They report `$0`, which also makes `--max-cost-usd` and `--cost-override` **inert no-ops** — the
  run is bounded by the repair cap and `--timeout` instead.

:::caution
A fully-cached run still needs the provider. `vk ai` exits `3` when the API key is missing or the
CLI is not on PATH, **even at a 100% cache hit**, because it must be able to repair a drifted step
at runtime. Caching cuts spend, not the key requirement. Only `--show-plan` degrades gracefully.
:::

## Keeping it cheap

| Do this | Because |
|---|---|
| **Persist `./.verikun/plans/`** between CI runs | It is the difference between \$0 and a full recompile of every test, every run. [How](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache) |
| **Name identifiers in the prose** — `Tap @get_started`, not "tap the big green button" | A selector that resolves never triggers a repair. Repairs are the only recurring cost on a warm cache. |
| **Assert, don't just act** | An assert failure is terminal and never healed, so it costs nothing and fails fast instead of paying for three repair attempts. |
| **Pick a cheaper model**, or a CLI backend | Compile is output-heavy (the plan is JSON), so the output rate dominates. |
| **Leave `--effort` alone** unless a test needs it | It bills through the output rate. |
| **Tighten `--max-cost-usd` per test** | It is the only cap that exists; the suite has none. |
| **Expect a full re-spend after upgrading verikun** | The compiler fingerprint rotates on purpose. Budget for it rather than being surprised. |

## What is not metered here

This page is about **verikun's own** model spend — the compile and repair calls it makes on your
behalf.

It is not about the tokens **your** agent spends while driving the device: reading a `vk ui` dump
back into its context, or looking at a screenshot. That is a separate budget, on a separate bill,
and it is usually the larger of the two. It is covered in
[Using it from an AI agent](/verikun/getting-started/using-from-an-agent/) and
[Screenshots](/verikun/reference/screenshots/).
