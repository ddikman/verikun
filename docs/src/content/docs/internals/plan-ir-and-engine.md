---
title: Plan IR & the replay engine
description: Why the IR is shallow, what the engine does at replay, and where the model is and is not in the loop.
sidebar:
  order: 3
---

`vk ai` runs a natural-language test by treating an LLM as a **compiler, not a runtime**:
compile the prose into a deterministic plan IR once, replay it model-free, and wake the model
only to *repair* a step whose selector stops resolving.

That is the cost model. A green suite costs roughly \$0 in tokens; you pay only on first
compile and on a genuine repair, and a green run persists the repaired plan — on a machine that
keeps the plan cache, which a disposable CI runner does not
([Self-healing in CI](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache)).

All of this lives in `src/agent/`. The rest of the CLI is **reused, not reinvented**.

## Why the IR is shallow

`ir.ts` defines uniform typed nodes — a `command` leaf, or a control node
(`if-present` / `repeat` / `when` / `while-present` / `read`).

Control bodies hold **leaves only**, with one narrow exception. This shallowness is not a
simplification for its own sake: it keeps the structured-output JSON schema
(`PLAN_JSON_SCHEMA`) **non-recursive**, and the model APIs reject a recursive schema.

The exception — `if-present` and `while-present` may nest one level deeper inside a
`repeat { when { … } }` — exists because that shape appears in real flows and could not be
expressed otherwise.

`validateNode` is the grammar gate, applied to **both** compile output and every model
repair. A hallucinated command is rejected, never run.

## The engine

`runPlan(plan, deps)` in `engine.ts` is a dependency-injected interpreter. It imports no
`cli.ts` — so there is no cycle, and it unit-tests against a fake `exec`.

The seam into the existing CLI is **`executeOutcome`** in `cli.ts`: the recordable-command
core, split out of `executeParsed`, returning `{code, error}` with the error *not* mapped to
an exit code. That is what lets the engine distinguish a heal trigger from a terminal
failure.

Action handlers stay **untouched**. The resolved element they already record via `note()` is
everything the engine needs.

`cmdAi` builds one shared driver and one explicit run, then injects `executeOutcome` (bound
to that driver) as the engine's `exec`. Per-step `out()` is suppressed via `setOutputQuiet`
so stdout stays the one final result while progress streams to stderr for CI liveness.

## Heal versus terminal

This is the single most load-bearing rule in the agent runner.

| Situation | Behaviour |
|---|---|
| Selector **miss** (`SelectorNotFoundError`, exit `1`) | **Heals** via the model |
| Selector **ambiguity** (`AmbiguousSelectorError`, exit `2`) | **Heals** via the model |
| **`assert` failure** | **Terminal.** Never healed. |
| Model returns **`give_up`** | **Terminal.** |
| Budget or timeout abort | **Terminal.** |
| Environment error (exit `3`) | **Aborts** — not recorded as a regression |

`assert` **returns** exit `1` rather than throwing, and that is precisely the mechanism that
makes it unhealable: the engine only heals on a *thrown* selector error. Healing an assertion
would mask a real regression, which is the worst thing this tool could do.

## A repair is a decision, not a forced substitution

The model returns a replacement leaf **or** `give_up` (`replaceStep: null`) when the live
screen has no element serving the failed step's intent — the flow drifted to the wrong screen
or app.

A `give_up` is **terminal**. Without it, a "too kind" fallback tap onto an unrelated screen
would pass as a false green. `REPAIR_DECISION_JSON_SCHEMA` plus the strict `REPAIR_GRAMMAR`
enforce the two-way choice.

## Loop safety

Loops carry a hard cap **and** a structural no-progress early exit, computed from a sorted
id-plus-text signature of the screen.

The raw hierarchy is deliberately **not** hashed: its node order is nondeterministic, so a
hash would report "changed" on every iteration and the early exit would never fire.

## The provider seam

`provider.ts` defines `AgentProvider`, with **four** backends behind it. `providerFor(model)`
in `cost.ts` chooses one from the `--model` name alone — there is no `--provider` flag.

| Backend | File | Mechanism |
|---|---|---|
| Anthropic | `claude.ts` | Messages API over built-in `fetch`, no SDK |
| OpenAI | `openai.ts` | Chat Completions; `toStrictSchema` adapts the shared schema to OpenAI's strict dialect |
| `codex-cli` | `cli-provider.ts` (`CODEX_SPEC`) | Shells to the logged-in `codex` binary |
| `cursor-cli` | `cli-provider.ts` (`CURSOR_SPEC`) | Shells to `cursor-agent` |

Both HTTP providers use structured output, a cached grammar prefix, and 429/5xx backoff.

The two CLI backends are served by the **single spec-parameterized** `cli-provider.ts`.
Adding another CLI agent is a new `CliAgentSpec` plus a `MODELS` row plus a `CLI_SPECS` entry
— **not a new class**.

A CLI backend is billed to the user's subscription, so it reports empty `usage` (cost `$0`,
with `--max-cost-usd` and `--cost-override` inert). It runs read-only in a neutral temp
directory and — whether or not it has a native schema flag — is still gated by `parsePlan`
and `validateNode` like every other provider.

## The grammar prompt is a cached prefix

`grammar.ts` exports `GRAMMAR` and `REPAIR_GRAMMAR`. It is the large, **stable** prefix of
every compile and repair prompt, so the provider marks it `cache_control: ephemeral` and
repeat calls bill at roughly 0.1×.

It mirrors `SKILL.md` — `SKILL.md` is the human source of truth, `grammar.ts` the compact
runtime copy. **Keep the two in sync.**

`grammar.ts` also exports `SECTION_NOTE`, added to the *user* message (not the cached system
prefix) when compiling one chunk of an
[`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests)d test. It
exists because of a measured failure: a paragraph *summarising* a test is context when the
whole test is compiled at once, but the entire prompt when that chunk is compiled alone — and
the model turned one such summary into three steps the test never asked for. The note says the
chunk is a section, that setup and teardown belong to its neighbours, and that emitting no
steps is a valid answer. It is folded into the compiler fingerprint like the other two.

`compileUserPrompt` in `provider.ts` assembles that user message for all four providers, which
differ only in how they send it.

## Compile-fidelity lint

`lint.ts` catches two specific compile failures and hands the finding back to the model:

- a directive in the prose silently **dropped** from the plan
- conditional prose compiled to an **unconditional** step

Both produce a plan that runs and looks fine while testing something other than what was
written.

## Before trusting seeding or shallow-IR depth

Run the validation gate described in the design doc: hand-write the flakiest flow's plan and
measure step survival across two builds. The shallow IR and the seed-from-prior-build
behaviour are both bets, and that is how they get checked.

## Where to go next

- [AI plans & models](/verikun/reference/ai-plans/) — the user-facing grammar reference
- [Contracts](/verikun/internals/contracts/) — the plan cache fingerprint and the rest
