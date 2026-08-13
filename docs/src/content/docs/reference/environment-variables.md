---
title: Environment variables
description: Every environment variable verikun reads, what it controls, and its default.
sidebar:
  order: 6
---

## Device targeting

| Variable | Default | Controls |
|---|---|---|
| `VERIKUN_DEVICE` | — | Target device serial or UDID when `--device` / `-d` is absent |
| `ANDROID_SERIAL` | — | Fallback device serial, **Android only**, checked after `VERIKUN_DEVICE` |
| `ADB` | `adb` | Path to the `adb` binary |
| `IDB` | `idb` | Path to the `idb` binary — useful when it lives in a Python virtualenv |

Resolution order for the device is `--device` → `VERIKUN_DEVICE` → `ANDROID_SERIAL`. One
attached device auto-resolves; more than one exits `3` rather than guessing.

## Model providers

| Variable | Controls |
|---|---|
| `ANTHROPIC_API_KEY` | Auth for Claude models (the default provider) |
| `OPENAI_API_KEY` | Auth for `gpt-*` models |

Neither is needed with `--model codex-cli` or `--model cursor-cli`, which drive an
already-logged-in CLI off your existing subscription. See
[Models](/verikun/reference/ai-plans/#models).

## Remote server

| Variable | Controls |
|---|---|
| `VERIKUN_SERVER` | Default `--server <url>` for `ai`, `suite` and `install` |
| `VERIKUN_SERVER_AUTH_KEY` | Bearer auth key. Read by **both** the server and the client. |

Prefer the environment variable over `--auth-key` — it keeps the key out of `ps`.

`VERIKUN_SERVER_AUTH_KEY` cannot be combined with `--allow-unsafe-anonymous`; the server
refuses to start.

## Test runs and reports

| Variable | Default | Controls |
|---|---|---|
| `VERIKUN_NO_RUN` | unset | Set to `1` to disable run recording entirely — every `note`, `attachImage` and `attachLog` becomes a no-op |
| `VERIKUN_NO_LOGS` | unset | Skip archive-time device-log capture **on green runs only**. A failed run always captures. |
| `VERIKUN_RUN_IDLE_MIN` | `30` | Minutes of idleness before an **implicit** run auto-archives and rolls over. `0` disables. |
| `VERIKUN_SESSION` | — | Session identity for rollover; a change closes and archives the active run |
| `TERM_SESSION_ID` | — | Fallback session identity when `VERIKUN_SESSION` is unset |

See [Automatic rollover](/verikun/reference/reports-and-test-runs/#automatic-rollover).

:::note
The ephemeral server-side execution path deliberately ignores `VERIKUN_NO_RUN` — the server
needs step detail to return to the client, which splices it into the client's run.
:::

## Tuning behaviour

| Variable | Default | Controls |
|---|---|---|
| `VERIKUN_SHOT_MAX_EDGE` | `700` | Default screenshot longest-edge cap in pixels. Ignored unless finite and ≥ 1. |
| `VERIKUN_COMPANION` | on | The [Android companion](/verikun/guides/companion/) is used by default; `0` (or `false`/`off`/`no`) turns it off. It makes hierarchy reads ~0.2s instead of ~2.4s, at the cost of holding the device's single `UiAutomation` connection while it runs. Under `--server` it is read in the **server's** environment, since that is where reads execute — a client cannot set it across the wire. |
| `VERIKUN_GUARD_SETTLE_MS` | — | `vk ai` `if-present` guard settle window. `0` restores the old single-shot probe. |

Screenshot precedence is `--full` > `--max <px>` > `--more` > `VERIKUN_SHOT_MAX_EDGE` > the
default. See [Screenshots](/verikun/reference/screenshots/).

## Diagnostics

| Variable | Controls |
|---|---|
| `VERIKUN_DEBUG` | When set, prints the stack trace of an unexpected (non-`CliError`) error to stderr |
| `VERIKUN_NO_UPDATE_CHECK` | When set to any non-empty value, `vk doctor` skips its CLI/plugin version probes and makes no network request. For airgapped machines and anywhere the check is unwanted. |

## Read by the host, not by verikun

| Variable | Controls |
|---|---|
| `PATH` | Scanned to detect the CLI providers `codex` and `cursor-agent` |
| `PATHEXT` | Windows executable extensions for that scan. Default `.EXE;.CMD;.BAT;.COM`. |

## Inside a plan: `{{env.NAME}}`

A [plan](/verikun/reference/ai-plans/#placeholders) can read **any** environment variable at
replay time:

```
text @password {{env.TEST_ACCOUNT_PASSWORD}}
```

This is how credentials reach a test without ever appearing in the prose or the cached plan.

:::caution
An unset **or empty** variable **fails the step**. That is deliberate: a missing CI secret
must fail loudly rather than silently typing an empty string and producing a confusing
assertion failure three steps later.
:::

## A CI environment, end to end

```yaml
env:
  # model
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  # remote device
  VERIKUN_SERVER: ${{ secrets.VERIKUN_SERVER }}
  VERIKUN_SERVER_AUTH_KEY: ${{ secrets.VERIKUN_SERVER_AUTH_KEY }}
  # test credentials, referenced as {{env.…}} in the prose
  TEST_ACCOUNT_PASSWORD: ${{ secrets.TEST_ACCOUNT_PASSWORD }}
```
