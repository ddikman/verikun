---
title: Core principles
description: The cross-cutting contracts that span files — break one and you quietly break agent control flow.
sidebar:
  order: 2
---

These conventions span files. Breaking one quietly breaks agent control flow, which is the
kind of bug that ships.

## Exit codes are an API

`0` ok · `1` not found / assertion failed / wait timeout · `2` usage error, ambiguous
selector, or a device another job holds · `3` environment error. They are carried by
`CliError(message, exitCode)` (`src/errors.ts`) and mapped to a process exit in exactly one
place, the `try`/`catch` in `run()`; a non-`CliError` throw becomes `3`. **Throw `CliError`
with the right code rather than printing and returning.** Full contract:
[Exit codes](/verikun/reference/exit-codes/).

## stdout is data; stderr is diagnostics

`out()` → stdout, `err()` → stderr (`src/output.ts`). Confirmations, healed-match notes and
warnings all go to **stderr**, so a caller parsing stdout never has to strip one out.

## `--json` everywhere, including errors

With `--json`, the catch in `run()` emits `{error, exitCode, errorKind}`. `errorKind` is the
error's **class** — `SelectorNotFoundError`, `AmbiguousSelectorError`, `NoWindowError`,
`CliError`, `Error` — so a caller can tell "the app has not drawn yet" from "the device is
gone" without matching on message text. New commands honour `--json` for success output too.

## No host shell, ever

`exec.ts` runs everything with an **args array** — no `shell: true`. `spawnDetached` (the
emulator must outlive the CLI) and `spawnCollect` (a parallel suite must not block on its
children) are the only non-`spawnSync` paths, and take the same args array. *Device-side*
escaping is the driver's job: add device-shell arguments through `escapeText()` in
`drivers/adb.ts`, never by string-concatenating into a command.

## Zero runtime dependencies is a design constraint

The XML parser, the argument parser and the PNG downscaler are hand-rolled on purpose; the
only dev dependencies are `typescript` and `@types/node`, and the test runner is `node:test`.
**Reach for a Node builtin first.** This governs the published CLI package — the docs site has
its own dependency tree, which never enters the tarball.

## Pure layers stay pure

These separations are load-bearing, and each has been violated at least once in a way that
caused a real bug:

| Layer | Must not know about |
|---|---|
| `ui/selector.ts` | **time** — matching is a pure function of one snapshot; waiting is layered on in `commands/auto-wait.ts` |
| `ui/viewport.ts` | **the device** — it is geometry; the orchestration lives in `cli.ts` |
| `image.ts` | **device I/O** — it is image maths |
| `report.ts` | **the filesystem and the driver** — `RunState` in, strings out |
| `agent/engine.ts` | **`cli.ts`** — dependency-injected, so no cycle and it unit-tests with a fake `exec` |
| `device/grant.ts` | **`agent/`** — a server lease reaches it as a structural `LeaseSource`, not as an import of the remote backend, so the device layer never depends on the transport |

## Inspection has no side effects

`ui`, `find` and `assert` never scroll, never tap, and never hide an element; an off-screen
element still matches and is simply marked `offscreen`. Only *actions* move the screen.

## Every unknown degrades to the permissive answer

No screen size means no scrolling and no `offscreen` marking; `Element.offscreen` is optional
and negative so an element from an older `vk server` never reads as unreachable. Refusing to
act is reserved for cases where acting would be **wrong**, not merely unverifiable.

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

`SKILL.md` is the agent-facing contract and `src/agent/grammar.ts` its compact runtime copy —
keep them in sync — and every behaviour change updates `SKILL.md`, `README.md` and this site
in the same commit: [Contributing](/verikun/internals/contributing/#the-documentation-site).

## Versioning

The version is declared once, in `package.json`; `src/version.ts` is generated from it. Any
behaviour change bumps it and adds a `CHANGELOG.md` line, and the rebuild rotates
`COMPILER_FINGERPRINT` so a plan an older compiler produced is never replayed:
[Contributing](/verikun/internals/contributing/#versioning-and-changelog).
