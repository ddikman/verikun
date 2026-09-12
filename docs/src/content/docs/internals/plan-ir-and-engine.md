---
title: Plan IR & the replay engine
description: Why the IR is shallow, what the engine does at replay, and where the model is and is not in the loop.
sidebar:
  order: 3
---

`vk ai` runs a natural-language test by treating an LLM as a **compiler, not a runtime**:
compile the prose into a deterministic plan IR once, replay it model-free, and wake the model
only to *repair* a step whose selector stops resolving. The cost model that follows from that
is in [Natural-language tests](/verikun/guides/natural-language-tests/#the-cost-model).

All of this lives in `src/agent/`. The rest of the CLI is **reused, not reinvented**.

## Why the IR is shallow

`ir.ts` defines uniform typed nodes — a `command` leaf, or a control node
(`if-present` / `repeat` / `when` / `while-present` / `read`).

Control bodies hold **leaves only**, with one narrow exception: `if-present` and
`while-present` may nest one level deeper inside a `repeat { when { … } }`, because that
shape appears in real flows. The shallowness keeps the structured-output JSON schema
(`PLAN_JSON_SCHEMA`) **non-recursive**, which the model APIs require.

`validateNode` is the grammar gate, applied to **both** compile output and every model
repair. A hallucinated command is rejected, never run.

## The engine

`runPlan(plan, deps)` in `engine.ts` is a dependency-injected interpreter. It imports no
`cli.ts` — so there is no cycle, and it unit-tests against a fake `exec`.

The seam into the existing CLI is **`executeOutcome`** in `cli.ts`: the recordable-command
core, split out of `executeParsed`, returning `{code, error}` with the error *not* mapped to
an exit code. That is what lets the engine distinguish a heal trigger from a terminal
failure. Action handlers stay **untouched**; the resolved element they already record via
`note()` is everything the engine needs.

`cmdAi` builds one shared driver and one explicit run, then injects `executeOutcome` (bound
to that driver) as the engine's `exec`. Per-step `out()` is suppressed via `setOutputQuiet`
so stdout stays the one final result while progress streams to stderr for CI liveness.

## Heal versus terminal

A thrown selector miss or ambiguity heals via the model; an `assert` failure, a model
`give_up` and a budget or timeout abort are terminal. `assert` **returns** exit `1` rather
than throwing, and that is the whole mechanism — never make `assert` throw. The full matrix:
[Heal vs terminal](/verikun/internals/contracts/#heal-vs-terminal).

## A guard has two clocks, and only one of them can abort

`present()` answers "is this selector on screen?" — and it can fail in two unrelated ways that
need different patience.

**Is the selector absent?** That is the settle window: `1500ms` for an `if-present`, and `0`
for a `repeat`'s exit guard, which is absent on every iteration by construction and would
otherwise pay the window `cap` times. Any non-zero window buys at least **two** looks
regardless of the clock, because one hierarchy read can cost more than the whole window on a
slow device.

**Is there a screen to ask at all?** That is `NoWindowError` — the app force-stopped,
mid-launch, or busy mid-transition — and it gets its own **10s** grace instead, because it is
not a fact about the selector. The grace applies only while *no* read has succeeded, so it
can never make a merely absent selector more patient. Both are bounded by the run deadline,
so no guard can overrun `--timeout`.

A guard still blind when its grace runs out throws `GuardBlindError` and aborts the run
(exit `3`). Reporting "absent" instead would skip the guarded body, and a guard-heavy plan
would finish fully green having executed nothing. The 10s figure was set from how long the
first readable hierarchy takes to arrive after `vk launch` on a physical phone; a guard's
patience is internal, so a test author cannot reach it the way a leaf's `--wait` can.

## A repair is a decision, not a forced substitution

The model returns a replacement leaf **or** `give_up` (`replaceStep: null`) when the live
screen has no element serving the failed step's intent — the flow drifted to the wrong screen
or app. A `give_up` is **terminal**; `REPAIR_DECISION_JSON_SCHEMA` plus the strict
`REPAIR_GRAMMAR` enforce the two-way choice.

## Loop safety

Loops carry a hard cap **and** a structural no-progress early exit, computed from a sorted
id-plus-text signature of the screen. The raw hierarchy is deliberately **not** hashed: its
node order is nondeterministic, so a hash would report "changed" on every iteration and the
early exit would never fire.

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
— **not a new class**. A CLI backend is billed to the user's subscription, so it reports empty
`usage` (cost `$0`, with `--max-cost-usd` and `--cost-override` inert). It runs read-only in
a neutral temp directory and is still gated by `parsePlan` and `validateNode` like every
other provider.

## The grammar prompt is a cached prefix

`grammar.ts` exports `GRAMMAR` and `REPAIR_GRAMMAR`. It is the large, **stable** prefix of
every compile and repair prompt, so the provider marks it `cache_control: ephemeral` and
repeat calls bill at roughly 0.1×.

It mirrors `SKILL.md` — `SKILL.md` is the human source of truth, `grammar.ts` the compact
runtime copy. **Keep the two in sync.**

`grammar.ts` also exports `SECTION_NOTE`, added to the *user* message (not the cached system
prefix) when compiling one chunk of an
[`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests)d test. It
says the chunk is a section, that setup and teardown belong to its neighbours, and that
emitting no steps is a valid answer. It is folded into the compiler fingerprint like the
other two.

The note is the second line of defence. The first is in `include.ts`: prose that states no
step (a title, a summary of what the test checks) is folded into the chunk of its own file
that states the steps it describes, and is never handed to the model as a chunk of its own —
a summary compiled alone is a whole prompt, and the model invents steps for it. The classifier
asks for *positive evidence* of a step (a list item of any kind, or a known verb anywhere in
a line) rather than reusing `lint.ts`'s instruction count, whose deliberate undercount is safe
as a coverage floor but would move a real step here.

`compileUserPrompt` in `provider.ts` assembles that user message for all four providers, which
differ only in how they send it.

## Compile-fidelity lint

`lint.ts` catches four specific compile failures and hands the finding back to the model:

- a directive in the prose silently **dropped** from the plan
- conditional prose compiled to an **unconditional** step
- the plan is far **shorter** than the number of instructions the prose states *(fatal)*
- the plan never references what the prose's **closing** instructions name *(fatal)*

All four produce a plan that runs and looks fine while testing something other than what was
written. Each buys one guided recompile, with the finding handed back as `retryFeedback`.

The two coverage rules are **fatal**: a plan that still trips one after that recompile is
rejected rather than run, because a truncated plan does not fail — it asserts nothing, so it
passes, and a pass is then cached and replayed against every later build. See
[AI plans & models](/verikun/reference/ai-plans/#the-compile-must-cover-the-test) for the
user-facing contract.

The floor sits at **0.35** of the prose's instruction count — well below ordinary run-to-run
variation of a healthy compile, and well above a truncation. A plan that stops after a long
shared preamble is not obviously short at all, which is what the tail-anchor rule catches.
Both counters are biased to **undercount** the prose (several sentences on one line count
once; unordered bullets never count), because an undercount only weakens detection while an
overcount would reject a correct test.

Two supporting rules live in `cli.ts`: an `@include` section that does not cover its own
prose is **not cached** and drops the split, so the test is recompiled whole rather than
assembled with its body missing (a fragment is keyed on its own text, so caching a short one
would shorten every test that includes it); and `findSeed`, which ignores the compiler
fingerprint by design, discards a seed that trips a coverage rule against its own prose.

## Where to go next

- [AI plans & models](/verikun/reference/ai-plans/) — the user-facing grammar reference
- [Contracts](/verikun/internals/contracts/) — the plan cache fingerprint and the rest
