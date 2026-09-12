---
title: Device claims
description: How verikun tracks which attached device another job is already driving, picks a free one, and refuses a busy one.
sidebar:
  order: 8
---

Running two or three agents in parallel against one pool of phones, emulators and simulators,
the question that matters is *which device is free right now*. verikun answers it itself: the
first device-touching command **claims** the device it resolves, so a second job picks a
different one — or is told, in milliseconds, that everything is busy and who has it.

## What you see

Several devices attached, none claimed — verikun takes one and says so:

```
$ vk ui
[verikun] auto-selected 032AY1UNR2 — 2 attached, 0 held by another job
```

Another job already has that one:

```
$ vk ui
[verikun] auto-selected emulator-5554 — 2 attached, 1 held by another job
```

Everything is busy. Exit `2`, before anything touches a device:

```
$ vk ui
Every attached device is in use:
  032AY1UNR2 (Pixel_3a)               workspace 'islamabad' · 1m ago
  emulator-5554 (sdk_gphone64_arm64)  workspace 'brussels' · 2s ago
Wait for one, free it with `verikun device release <serial>`, or set VERIKUN_NO_CLAIM=1 to ignore claims.
```

You named a busy device explicitly. Also exit `2` — there is no `--force`, see
[Releasing](#releasing):

```
$ vk tap @submit --device emulator-5554
emulator-5554 is in use by workspace 'brussels' (last seen 2m ago).
  free now:             032AY1UNR2 (Pixel_3a)
  if that job is gone:  verikun device release emulator-5554
  to ignore claims:     VERIKUN_NO_CLAIM=1
```

## Seeing who holds what

`vk devices` grows a `USED BY` column when anything is claimed — and only then:

```
$ vk devices
PLATFORM  SERIAL         STATE   MODEL               USED BY
android   032AY1UNR2     device  Pixel_3a            this job
android   emulator-5554  device  sdk_gphone64_arm64  workspace 'brussels' · 2m ago
```

`vk devices --json` carries the same information as a `claim` object per device, and
`vk doctor` annotates its device list the same way.

## Releasing

Nothing needs releasing by hand in the normal case:

- `vk ai`, `vk suite` and `vk batch` release when the flow ends **or fails**.
- `vk run archive` and `vk run clear` release — the run is over.
- A claim that stops being refreshed goes stale on its own (see below).

When you do not want to wait — a machine went down, a job was killed from somewhere you
cannot reach — hand it back explicitly:

```sh
vk device release emulator-5554
```

That releases another job's claim too. There is deliberately no `--force` on ordinary
commands: taking a device another job is driving breaks both runs. To ignore claims for a
whole invocation, set `VERIKUN_NO_CLAIM=1` (below).

## When a claim expires

A claim is refreshed between commands, so two signals decide whether it is still live:

| Signal | Effect |
|---|---|
| The owning process is **still running** (same host) | Live, regardless of idle time |
| Idle time since the last command | Live for **5 minutes** by default |
| The owning process is **gone**, and it owned the whole job (`ai` / `suite` / `batch` / `server`) | Free **immediately** |

A running process always counts as live, however long it has been silent — a large `install`
or a model round-trip cannot refresh the claim while it runs. `ai`, `suite`, `batch` and
`server` are one process for the whole job, so their death frees the device at once; a
one-off `vk tap` exits after every command while the job carries on, which is what the idle
window is for. `VERIKUN_CLAIM_TTL_MIN` tunes it (`0` expires one-off claims at once).

## Turning it off

`VERIKUN_NO_CLAIM=1` disables claim reads **and** writes: one attached device auto-resolves,
more than one exits `2` rather than guessing, and the run is invisible to other jobs. Use it
to take over a device on purpose, on a single-user machine that wants none of this, or to
check whether the claim store is involved in a problem.

## Where claims live

One JSON file per device under `~/.verikun/devices/`:

```
~/.verikun/devices/emulator-5554-3c9a1f04.json
```

Claims are **host-global, not per-workspace**: a device is a fact about the machine, and the
jobs that collide are in different directories. A claim records the serial and platform, the
owning working directory and session, the pid and hostname, and when it was taken and last
seen. A corrupt or unreadable file counts as unclaimed, and an unwritable store logs and
continues — the store is never a new way to fail.

## What counts as "the same job"

A claim is yours when **either** the session matches (`VERIKUN_SESSION`, else
`TERM_SESSION_ID`) **or** the working directory does. An agent harness may run every command
in a fresh shell with no stable session id, so either signal is enough.

## Remote devices

Over [`--server`](/verikun/guides/remote-devices-and-ci/) the claim is held by the server
process, on the host where the devices are; two clients sharing one server are arbitrated by
the server's own per-run lease. When a server
[fails over](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails), the claim
moves with the binding, and a candidate another job holds is skipped.
