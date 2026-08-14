---
title: Global flags
description: Flags accepted by every command, and their environment-variable equivalents.
sidebar:
  order: 4
---

| Flag | Meaning |
|---|---|
| `-d, --device <serial>` | Target a specific device (or `VERIKUN_DEVICE` / `ANDROID_SERIAL`) |
| `-p, --platform <android\|ios>` | Platform, default `android`. `--ios` / `--android` are shortcuts. |
| `-j, --json` | Machine-readable output — **also serializes errors** |
| `--server <url>` | For `ai` / `suite` / `install`: run against a remote [`vk server`](/verikun/guides/remote-devices-and-ci/) (or `VERIKUN_SERVER`). The server's device and platform apply. |
| `--auth-key <k>` | Key for `--server` (or `VERIKUN_SERVER_AUTH_KEY`, which keeps it out of `ps`) |
| `--` | End flag parsing, so text and arguments may start with `-` |

## Device resolution

Resolution order:

1. `--device` / `-d`
2. `VERIKUN_DEVICE`
3. `ANDROID_SERIAL` (Android only)

With none of those set, verikun picks a device **no other job is currently driving** and says
which on stderr. Exit `2` is reserved for the case where every attached device is already
claimed, and the message names each holder. See
[Device claims](/verikun/reference/device-claims/).

Naming a device another job holds is **refused** (exit `2`) rather than silently shared.
`VERIKUN_NO_CLAIM=1` opts out of the whole mechanism, which restores the older behaviour:
one attached device auto-resolves and more than one exits `2` rather than guessing.

## `--json` covers errors too

When `--json` is set, a failure emits `{error, exitCode}` as JSON rather than plain text on
stderr. The exit code is unchanged.

This means an agent or script can set `--json` once and parse both outcomes the same way,
without branching on whether the command succeeded.

## `--` and text starting with a dash

```sh
vk type -- "-50% off"
```

Without `--`, `-50% off` is parsed as a flag.

## Globals inside `batch`

Globals passed to the [`batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch)
call **carry into every line** unless a line overrides them — `--device`, `--platform` /
`--ios` / `--android`, and `--json`.

```sh
vk batch --ios --file login.flow    # whole flow runs against the simulator
```
