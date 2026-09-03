---
title: AI plans & models
description: The plan IR grammar — command leaves, control nodes, placeholders and nesting rules — plus the model list and cost defaults.
sidebar:
  order: 10
---

`vk ai` compiles prose into a **plan IR**, caches it, and replays it model-free. This page is
the reference for that IR and for choosing a model.

:::note
The authoritative copies are
[`src/agent/grammar.ts`](https://github.com/ddikman/verikun/blob/main/src/agent/grammar.ts)
(the compact prompt handed to the model) and
[`SKILL.md`](https://github.com/ddikman/verikun/blob/main/.claude/skills/verikun/SKILL.md)
(the agent-facing contract). This page describes the concepts; when the two disagree, the
source wins.
:::

## A plan

```json
{ "version": 1, "package": "com.example.app", "platform": "android", "steps": [ … ] }
```

`steps` is a list of **nodes**. Every node is one of six types.

## 1. Command leaf

The only node that touches the device.

```json
{
  "type": "command",
  "command": "text",
  "positionals": ["@email_input", "user@example.com"],
  "flags": [{ "name": "clear", "value": "true" }]
}
```

A boolean flag is written as `{"name": "clear", "value": "true"}`.

Commands the grammar permits:

| Command | Flags |
|---|---|
| `launch` | `--clear`, `--no-restart` |
| `stop` | — |
| `tap` | — |
| `text` | `--clear`, `--enter` |
| `type` | — |
| `key` / `back` / `home` / `enter` | — |
| `swipe` | `--on` |
| `assert` | `--text`, `--gone` |
| `wait` | `--gone`, `--timeout` |
| `screenshot` | — |
| `device` | subcommand is the **first positional**: `set` / `get` / `reset` / `caps` |

A hallucinated command is **rejected, never run** — `validateNode` is the grammar gate
applied to both compile output and every model repair.

## 2. `if-present`

An optional interstitial — a permission dialog, a "what's new" sheet.

```json
{ "type": "if-present", "selector": "text:Allow", "body": [ … ] }
```

The guard **waits for its selector to settle** before deciding the UI is not there. See
[the settle window](/verikun/guides/natural-language-tests/#the-if-present-settle-window).

## 3. `repeat`

A bounded loop that runs until a selector appears.

```json
{ "type": "repeat", "selector": "@target_row", "cap": 10, "body": [ … ] }
```

- A hard iteration `cap`.
- A structural **no-progress early exit** — if the screen stops changing, it stops.
- **A repeat that never sees its selector FAILS.** It is not a best-effort loop.

## 4. `when`

Ordered n-way dispatch, with an optional `else`. No match and no `else` is a failure.

Use `when` for "the app is in one of these states"; use `if-present` for "this may or may not
be there".

## 5. `while-present`

Loops while a selector is present, with a bound counter.

```json
{ "type": "while-present", "selector": "@dismiss", "bind": "n", "cap": 5, "body": [ … ] }
```

`bind` starts at `0` and is referenced as `{{ctx.n}}`.

## 6. `read`

Capture a value off the screen into a variable for a later step.

```json
{ "type": "read", "selector": "@order_number", "field": "text", "into": "orderId" }
```

`field` is one of `text`, `desc`, `id`, `idShort`.

## Placeholders

| Placeholder | Resolves to |
|---|---|
| `{{ctx.NAME}}` | A value bound by `read` or a loop counter |
| `{{env.NAME}}` | An environment variable, read at replay time |
| `{{uuid}}` | A UUID, generated once per run |
| `{{timestamp}}` | The run's timestamp |
| `{{run_id}}` | The run id |

**Never inline a secret.** Use `{{env.NAME}}`; an unset **or empty** variable fails the step
rather than typing an empty string.

## Nesting

Control nodes nest **one level**. The exception: `if-present` and `while-present` may go one
deeper, so `repeat { when { while-present { … } } }` and `repeat { when { if-present { … } } }`
are legal. Three levels is not.

This shallowness is deliberate — it keeps the structured-output JSON schema
**non-recursive**, which the model APIs require. See
[Plan IR & the replay engine](/verikun/internals/plan-ir-and-engine/).

## State modifiers on a control node

A leaf writes a state modifier as a flag. A **control node** has nowhere to hang a flag, so
it appends the modifier to the selector string:

```json
{ "type": "if-present", "selector": "@mode_video --not-selected", "body": [ … ] }
```

This is exactly where a toggle guard belongs. See
[Selectors](/verikun/reference/selectors/#state-modifiers).

## Rules the compiler follows

These are in the grammar because getting them wrong produces a **false green**, which is
worse than a failure:

- Use `--enabled` when tapping a button the app disables until a form is valid.
- Guard shared-handler pickers and toggles with `--not-selected` / `--not-checked`. An
  unguarded tap flips the control and still exits `0`.
- `assert` is verification-only and **terminal**. It is never healed.
- `tap` and `text` [auto-scroll](/verikun/reference/auto-wait/#auto-scroll-into-view), so
  never compile a repeat-until-visible loop.
- Prefer resource-id and accessibility selectors over text.
- Translate literally and minimally. The one exception is `screenshot`, inserted liberally —
  free on replay, and it never affects the result.

## Repair

When a step's selector stops resolving, the model gets the live screen and a strict two-way
decision:

| Decision | Meaning |
|---|---|
| `repair` | Return **one** replacement command leaf serving the same user-facing purpose |
| `give_up` | Return a reason. The test **fails** — which is the correct result. |

"Same purpose" means the same user-facing action, not merely "a tappable element exists".
Without the `give_up` path, a too-kind fallback tap onto an unrelated screen would pass as a
false green.

Every repair goes through the same `validateNode` gate as the original compile.

## Models

`--model` picks the model **and** its provider. There is no `--provider` flag; the backend is
derived from the model name.

| Model | Backend | Key |
|---|---|---|
| `claude-haiku-4-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-sonnet-4-6` **(default)** | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-opus-4-8` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-fable-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-5.4-mini` | OpenAI | `OPENAI_API_KEY` |
| `gpt-5.4` | OpenAI | `OPENAI_API_KEY` |
| `gpt-5.5` | OpenAI | `OPENAI_API_KEY` |
| `gpt-4.1` | OpenAI | `OPENAI_API_KEY` |
| `codex-cli` | the logged-in `codex` CLI | **none** |
| `cursor-cli` | the logged-in `cursor-agent` CLI | **none** |

An unknown `--model` exits `2` with the allowlist, rather than a raw 404 from a provider.

### The CLI backends

`codex-cli` and `cursor-cli` shell out to an already-logged-in coding-agent CLI, so **you
need no API key at all** — spend goes to your existing ChatGPT or Cursor subscription.

Consequences:

- Their reported cost is `$0`, so `--max-cost-usd` and `--cost-override` are **inert
  no-ops**. The run is bounded by the repair cap and `--timeout` instead.
- Each CLI picks its own underlying model.
- They run **read-only in a neutral temp directory**, so they never touch your working tree.
- They are gated by the same `parsePlan` / `validateNode` checks as every other provider.

### Notes on `gpt-4.1`

It is the one **non-reasoning** model in the registry, and cheaper than the default. Two
consequences, both handled rather than papered over: it takes no reasoning effort, and it
bills cache reads at a different multiplier from every other model here.

## Cost

| Control | Default | Effect |
|---|---|---|
| `--max-cost-usd <n>` | `3` | Abort the run when the estimate crosses this — **per test**, not per suite |
| `--timeout <dur>` | `15m` | Abort on wall clock |
| `--cost-override <in/out>` | — | Override the bundled per-1M price table |

Each run reports a line of this shape:

```
compile=$0.0184 · repairs=$0.0000 · replay=$0 · cache_read=12043 tok · est $0.0184
```

`replay` is always `$0` — running a plan calls no model. If `compile` is not `$0` on a
repeat run, the plan is not being cached; see
[Troubleshooting](/verikun/guides/troubleshooting/#the-run-costs-more-than-expected).

For when a model is actually called, the estimate formula, the cache multipliers and how the
ceiling behaves on a breach, see [Cost & budget](/verikun/reference/cost/).

## The plan cache

Keyed by the test prose + package + app build, gated by a **compiler fingerprint**
(verikun's version plus the grammar, repair and section prompt text).

- A fingerprint mismatch is treated as a **miss**, so updating verikun recompiles rather than
  replaying a plan an older compiler produced.
- The compile is cached immediately, so an unchanged test never recompiles.
- A green run re-persists the healed plan, so the next run is free again.
- Seeding from a prior build ignores the fingerprint — an older plan is still a fine
  starting point.
- A test assembled from [`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests)
  fragments is keyed on the **resolved** text, and each chunk is additionally cached under
  its own text — so shared prose is compiled once across a suite.
- **Concurrent runs sharing one cache serialise per key.** A [parallel suite](/verikun/guides/suites/)
  is one process per test, so on a cold cache every lane would otherwise miss the same
  fragment at the same instant and compile its own. The first lane compiles; the rest wait
  and take its result, printing `compiled by a concurrent run (waited 0.5s)`. A hit takes no
  lock at all. `VERIKUN_NO_PLAN_LOCK=1` turns it off.
- `--recompile` still takes the lock, and still ignores anything already on disk — but it
  accepts an entry a run racing this one wrote, so N lanes do not each pay for one fragment.

See [Contracts](/verikun/internals/contracts/#the-plan-cache-fingerprint).
