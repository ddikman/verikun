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

The failure this closes is expensive and misleading. Two jobs on one device clobber each
other's app — same package, different build — and it surfaces as ordinary assertion failures.
Nothing says *the app under you changed*, so it reads exactly like a regression until someone
goes digging, having already spent the run.

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

A running process always counts, because the heartbeat can only fire *between* commands: a
large `install`, a `wait --timeout 600000`, or a model repair round-trip mid-`vk ai` has no
opportunity to report that it is still working, and a pure timeout would hand the device to
someone else halfway through.

The third row is the one that saves you waiting. `ai`, `suite`, `batch` and `server` are a
single process for the entire job, so when that process dies the job is genuinely over — a
`kill -9` returns the device at once rather than parking it until a timer expires. A one-off
`vk tap` cannot be read that way: its process exits after every command while the job carries
on, which is exactly what the idle window is for.

`VERIKUN_CLAIM_TTL_MIN` tunes the one-off window (`0` disables it, making every one-off claim
expire at once). One minute is usually too tight: an agent that taps, reads a screenshot,
decides and taps again can easily pause past it, and losing the device mid-flow is worse than
waiting a little for a crashed one.

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

**Host-global, not per-workspace.** Run state lives in `./.verikun/` because it describes a
working directory; a device is a fact about the machine, and the jobs that collide are in
different directories by definition. One file per device rather than one shared index,
because the whole premise is concurrent writers — separate files make every write atomic.

A claim records the serial and platform, the owning working directory and session, the pid
and hostname, when it was taken and when it was last seen. Reads are **tolerant**: a corrupt
or unreadable file counts as unclaimed, so a poisoned file can never brick a device.

## What counts as "the same job"

A claim is yours when **either** the session matches (`VERIKUN_SESSION`, else
`TERM_SESSION_ID`) **or** the working directory does.

Either, not both, deliberately: the only unsafe error here is falsely accusing your own job.
An agent harness may run every command in a fresh shell with no stable session id, so session
alone will not do; and two terminals deliberately sharing one checkout are one job, so the
directory alone will not do either.

## Remote devices

Over [`--server`](/verikun/guides/remote-devices-and-ci/) the claim is held by the server
process, on the host where the devices actually are — a client cannot see the other clients,
and does not need to. The server also has its own per-run device lock, which is a separate,
finer-grained mechanism for two clients sharing one server; claims sit beneath it, keeping
other jobs *on that host* off the server's device.

When a server [fails over](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails)
to another device, the claim moves with the binding — and in that order: it claims the new
device, probes it, commits, and only then hands the old one back. Releasing first would leave
the server bound to a device it no longer holds, and a racing job on the same host would take
it mid-request. A candidate another job already holds is simply skipped, not quarantined: busy
is not broken.
