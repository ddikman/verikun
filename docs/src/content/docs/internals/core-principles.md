---
title: Core principles
description: The cross-cutting contracts that span files — break one and you quietly break agent control flow.
sidebar:
  order: 2
---

These conventions span files. Breaking one quietly breaks agent control flow, which is the
kind of bug that ships.

## Exit codes are an API

`0` ok · `1` not found / assertion failed / wait timeout · `2` usage error or ambiguous
selector · `3` environment error.

They are carried by `CliError(message, exitCode)` in `src/errors.ts` and thrown from
anywhere. The single `try`/`catch` in `run()` is the **only** place that maps an error to a
process exit code. A non-`CliError` throw becomes exit `3`.

**When you add logic, throw `CliError` with the right code** rather than printing and
returning.

Full contract: [Exit codes](/verikun/reference/exit-codes/).

## stdout is data; stderr is diagnostics

`out()` → stdout, `err()` → stderr, both in `src/output.ts`.

Healed-match notes, "tapped …" confirmations, and warnings all go to **stderr**, so stdout
stays parseable. An agent piping stdout into a parser must never have to strip a
confirmation line out of it.

## `--json` everywhere, including errors

When `--json` is set, the catch in `run()` emits `{error, exitCode}` as JSON. New commands
should honour `--json` for their success output too.

The point is that a caller sets `--json` once and parses both outcomes the same way.

## No host shell, ever

`exec.ts` runs everything via `spawnSync` with an **args array** — no `shell: true` — so
host-side injection is impossible.

*Device-side* shell escaping (for `adb shell input text …`) is the driver's job: see
`escapeText()` in `drivers/adb.ts`. The allowlist is: backslash-escape **all** ASCII
punctuation, leave alphanumerics and non-ASCII alone, then convert space to `%s`.

**Add new device-shell arguments through that**, not by string-concatenating into a command.

## Zero runtime dependencies is a design constraint

The XML parser (`ui/android-parse.ts`), the argument parser (`args.ts`) and the PNG
downscaler (`image.ts` — decode, box-resample, encode over `node:zlib` only) are hand-rolled
on purpose.

Do not add an npm runtime dependency without a deliberate decision. **Reach for a Node
builtin first.**

The only dev dependencies are `typescript` and `@types/node`. Even the test runner is Node's
built-in `node:test`.

:::note
This constraint governs the **published CLI package**. This documentation site has its own
`docs/package.json` and its own dependency tree, which never enters the npm tarball.
:::

## Pure layers stay pure

Three separations are load-bearing, and each has been violated at least once in a way that
caused a real bug:

| Layer | Must not know about |
|---|---|
| `ui/selector.ts` | **time** — matching is a pure function of one snapshot; waiting is layered on in `cli.ts` |
| `ui/viewport.ts` | **the device** — it is geometry; the orchestration lives in `cli.ts` |
| `image.ts` | **device I/O** — it is image maths |
| `report.ts` | **the filesystem and the driver** — `RunState` in, strings out |
| `agent/engine.ts` | **`cli.ts`** — dependency-injected, so no cycle and it unit-tests with a fake `exec` |

## Inspection has no side effects

`ui`, `find` and `assert` never scroll, never tap, and never hide an element. Only *actions*
move the screen.

An element that is off-screen still matches, is still listed, and is simply marked
`offscreen`. This is what lets an agent inspect freely without changing what it is
inspecting.

## Every unknown degrades to the permissive answer

If `driver.viewport()` returns null, there is no scrolling and no `offscreen` marking — which
is exactly the behaviour before that feature existed. `Element.offscreen` is optional and
negative for the same reason: an element from an older `vk server` must not read as
unreachable.

Refusing to act is reserved for cases where acting would be **wrong**, not merely
unverifiable.

## Refuse rather than report a false positive

The recurring theme, and the one worth internalising:

- An **ambiguous selector** exits `2` and lists candidates rather than tapping a guess.
- A **state modifier the platform cannot report** exits `3` rather than matching nothing.
- **`airplane=on`** is verified by *effect* rather than by its flag, because reporting
  "offline" while the app is still online would make an offline test pass for the wrong
  reason.
- A **`give_up`** from the repair model is terminal, because a fallback tap onto an unrelated
  screen would pass as green.
- A **failed run** can never archive with `failures="0"`.

A false green is worse than a failure, because nobody investigates a green run.

## Documentation is part of the change

`SKILL.md` is the agent-facing contract and `src/agent/grammar.ts` is its compact runtime
copy — **keep them in sync**.

If you change CLI behaviour (commands, selectors, exit codes, flags), update `SKILL.md`,
`README.md` **and this documentation site** in the same change. They are documentation an
agent relies on, not just prose.

## Versioning

The version is declared once, in `package.json`. `src/version.ts` is **generated from it at
build** — never hand-edit it.

Any change that affects behaviour bumps the version and adds a `CHANGELOG.md` entry under
`## [Unreleased]`. A rebuild rotates `COMPILER_FINGERPRINT`, so every cached `vk ai` plan
recompiles against the new build. That is intended: never replay a plan an older verikun
produced.
