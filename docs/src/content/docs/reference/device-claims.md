---
title: Device claims
description: How verikun tracks which attached device another job is already driving, picks a free one, and refuses a busy one.
sidebar:
  order: 8
---

Running two or three agents in parallel against one pool of phones, emulators and simulators,
the question that matters is *which device is free right now*. verikun answers it itself: the
first device-touching command **claims** the device it resolves, so a second job picks a
different one — or is told, in milliseconds, that everything is busy and who has it. Without
that, two jobs on one device clobber each other's app, and it surfaces as ordinary assertion
failures that read exactly like a regression.

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

You named a busy device explicitly. Also exit `2` — see [Why there is no
`--force`](#why-there-is-no---force):

```
$ vk tap @submit --device emulator-5554
emulator-5554 is in use by workspace 'brussels' (last seen 2m ago).
  free now:             032AY1UNR2 (Pixel_3a)
  if that job is gone:  verikun device release emulator-5554
  to ignore claims:     VERIKUN_NO_CLAIM=1
```

## Seeing who holds what

`vk devices` grows a `USED BY` column when anything is claimed — and only then, so a host
where nothing is ever claimed sees the table it always saw:

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

That releases another job's claim too. You had to type the serial, and refusing would leave
no way to recover a stuck device at all.

## When a claim expires

A claim is refreshed between commands, so two signals decide whether it is still live:

| Signal | Effect |
|---|---|
| The owning process is **still running** (same host) | Live, regardless of idle time |
| Idle time since the last command | Live for **5 minutes** by default |
| The owning process is **gone**, and it owned the whole job (`ai` / `suite` / `batch` / `server`) | Free **immediately** |

A running process always counts because the heartbeat can only fire *between* commands — a
large `install` or a model repair round-trip cannot report that it is still working. `ai`,
`suite`, `batch` and `server` are one process for the whole job, so their death frees the
device at once; a one-off `vk tap` exits after every command while the job carries on, which is
what the idle window is for. `VERIKUN_CLAIM_TTL_MIN` tunes it (`0` expires one-off claims at
once); one minute is usually too tight for an agent that pauses to think between taps.

## Turning it off

`VERIKUN_NO_CLAIM=1` disables reads **and** writes. That restores the previous behaviour
exactly — one attached device auto-resolves, more than one exits `2` rather than guessing —
and makes the run invisible to other jobs. It is the escape hatch for a takeover, for a
single-user machine that wants nothing to do with any of this, and for debugging (if
behaviour differs with it set, the claim store is involved).

### Why there is no `--force`

Taking a device another job is driving is precisely the thing that breaks both runs, so it is
not a flag. Making it an environment variable keeps it deliberate — you opt a whole
invocation out of coordination, rather than reaching for a convenient flag mid-flow.

## Where claims live

One JSON file per device under `~/.verikun/devices/`:

```
~/.verikun/devices/emulator-5554-3c9a1f04.json
```

**Host-global, not per-workspace**: a device is a fact about the machine, and the jobs that
collide are in different directories by definition. One file per device, because the premise is
concurrent writers. A claim records the serial and platform, the owning working directory and
session, the pid and hostname, and when it was taken and last seen. Reads are **tolerant**: a
corrupt or unreadable file counts as unclaimed.

## What counts as "the same job"

A claim is yours when **either** the session matches (`VERIKUN_SESSION`, else
`TERM_SESSION_ID`) **or** the working directory does. Either, not both, deliberately: the only
unsafe error is falsely accusing your own job, and an agent harness may run every command in a
fresh shell with no stable session id.

## Remote devices

Over [`--server`](/verikun/guides/remote-devices-and-ci/) the claim is held by the server
process, on the host where the devices are; the server's own per-run lease is the finer
mechanism for two clients sharing one server, and claims sit beneath it. When a server
[fails over](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails), the claim
moves with the binding — the new device is claimed, probed and committed before the old one is
released — and a candidate another job holds is skipped, not quarantined.
