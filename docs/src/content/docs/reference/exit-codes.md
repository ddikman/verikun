---
title: Exit codes
description: The four exit codes, what produces each, and the suite-specific and HTTP mappings.
sidebar:
  order: 5
---

Exit codes are an **API**, not a convenience. An agent or a CI job branches on them without
parsing prose, so they are stable.

| Code | Meaning |
|---|---|
| `0` | success / found / assertion passed |
| `1` | not found / assertion failed / wait timeout |
| `2` | usage error, **ambiguous selector** (the caller must refine), or a device another job is driving |
| `3` | environment error — `adb`/`idb`/`simctl` missing, no usable device, dump failed |

Over [`--server`](/verikun/guides/remote-devices-and-ci/), a server that failed over does not
change these: an install that succeeded on another device is `0`, one that exhausted the pool
is `3` carrying the **first** device's error, and a step that failed on a device the server
has since moved off keeps that device's code — it is never re-run elsewhere.

**stdout is data; stderr is diagnostics.** Healed-match notes, "tapped …" confirmations and
warnings all go to stderr so stdout stays parseable.

## The `1` vs `3` split

This is the distinction that matters operationally:

- **`1` is a regression to investigate.** The app did not do what the test said it should.
- **`3` is a machine to fix.** Nothing about your app is implicated.

`ai`, `suite`, `install` and `server` verify the toolchain **up front**, so a `3` arrives
immediately with an install hint instead of halfway through a flow. A `suite` whose device
dies mid-run stops with `3` rather than reporting every remaining test as a failure.

## Warnings have no code of their own

Warnings go to **stderr and leave the exit code alone**: `vk doctor` prints an out-of-date
CLI or plugin and the command that fixes it, then still exits `0`. A fifth code would be read
as a failure by every `set -e` script.

## What produces each code

| Situation | Code |
|---|---|
| Unknown command | `2` |
| Ambiguous selector with no `--index` | `2` |
| Bad flag value, malformed `key=value`, unknown device-setting key | `2` |
| `airplane=on` refused over wireless adb | `2` |
| Every attached device is claimed by another job | `2` |
| A `--device` another job is driving | `2` |
| Several devices attached, none free, with `VERIKUN_NO_CLAIM=1` | `2` |
| Selector not found after the wait window | `1` |
| `assert` predicate false | `1` |
| `wait` timed out | `1` |
| Element has no reachable on-screen pixel | `1` |
| `run archive` where the run contained failures | `1` |
| A `vk ai` compile that does not cover its test | `1` |
| Tool missing, no usable device, dump/screencap failed | `3` |
| `devices start`/`restart` where the device did not finish booting in time | `1` |
| `devices start`/`stop`/`restart` naming a device that does not exist | `1` |
| Device name matching more than one target (e.g. a simulator in two runtimes) | `2` |
| `devices start`/`stop`/`restart` against a **physical** device | `2` |
| `--wipe` against an already-running target, or on `devices stop` | `2` |
| The SDK `emulator` binary cannot be found (set `VERIKUN_EMULATOR`) | `3` |
| Unsupported device setting for the platform | `3` |
| State modifier the platform cannot report (`--selected`/`--focused` on iOS) | `3` |
| iOS `clear` (no per-app data reset exists) | `3` |
| Any unexpected, non-`CliError` throw | `3` |

:::note
`assert` **returns** exit `1` — it never throws. That is what stops
[`vk ai`](/verikun/guides/natural-language-tests/) from ever healing a real assertion
failure. See [Contracts](/verikun/internals/contracts/#heal-vs-terminal).
:::

## `run archive` doubles as the gate

`vk run archive` exits non-zero when the run contained failures, so the same command both
produces the report and gates CI. There is no separate check step to wire up.

## `batch`

[`vk batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch) stops at the first
line that exits non-zero and **propagates that line's exit code**. It therefore cannot express
"this step *should* fail" — for that you need a harness that asserts on the code.

## `vk ai`

| Outcome | Code |
|---|---|
| Plan ran green | `0` |
| A step failed, a control node gave up, the model gave up | `1` |
| The compile [did not cover the test](/verikun/reference/ai-plans/#the-compile-must-cover-the-test) | `1` |
| Environment aborted (`abortedForEnv`) | `3` |

An environment abort is `3` so it is never read as a regression. A rejected compile is `1`,
not `2`, so `vk suite --retries` retries it.

## `vk suite`

| Code | Meaning |
|---|---|
| `0` | All green — **including flakes that recovered** under `--retries` |
| `1` | A test failed |
| `2` | Bad or empty directory |
| `3` | Environment — the provider or device toolchain is unavailable, or the box broke mid-run |

Retry interaction: a thrown **exit `2`** (usage) is the only non-retryable throw. Every other
code, including `3`, is retried while attempts remain. A
[**budget abort**](/verikun/reference/cost/#the-budget) is never retried, since each attempt
would get its own fresh ceiling; it exits `1` like any other failure, and `abortedForBudget`
in `--json` is what tells them apart.

`--max-suite-cost-usd` stops the suite at **`1`**, not `3`: the box is fine, the run just did
not finish. `index.json`'s `aborted.kind` says which of the two happened.

Across a [pool](/verikun/guides/suites/#running-across-several-devices), a broken device
retires its lane and its tests move to the others; `3` arrives only once **every** device is
gone.

## `vk server` — HTTP mapping

The server preserves exit codes across the wire, so a remote selector miss stays a heal
trigger rather than becoming a terminal failure.

| HTTP | Exit code |
|---|---|
| `400` | `2` |
| `404` | `2` |
| `413` | `2` |
| `401` | `3` (auth failure, client-side) |
| `409` | every device is leased by another run |
| `500` | `3` |

Response bodies carry `{ error, exitCode, errorKind? }`. `errorKind` is the thrown error's
**class**, so the client rebuilds it with its identity intact — that is what lets a `vk ai`
guard tell a mid-launch `NoWindowError` from a broken device when both are exit `3`. Older
servers omit the field; feature-detect on it, never on `version`.

## Using them from a script

```sh
vk assert text:"Welcome back" --wait 8s
case $? in
  0) echo "logged in" ;;
  1) echo "regression — investigate the app" ; exit 1 ;;
  2) echo "my selector is wrong" ; exit 1 ;;
  3) echo "the machine is broken" ; exit 1 ;;
esac
```

## Where this is implemented

`CliError(message, exitCode)` in `src/errors.ts` carries the code from wherever it is thrown;
the one `try`/`catch` in `run()` maps it to the process exit, and any other throw becomes `3`.
