---
title: Troubleshooting
description: What common verikun failures actually mean, and what to do about each.
sidebar:
  order: 7
---

## Start here: read the exit code

verikun's exit codes are a deliberate contract, and they tell you which *kind* of problem
you have before you read a single line of output.

| Code | Meaning | Who fixes it |
|---|---|---|
| `0` | Success | — |
| `1` | Not found · assertion failed · wait timeout | **The app** — a regression, or the test is wrong |
| `2` | Usage error, or **ambiguous selector** | **The test** — refine the selector or fix the arguments |
| `3` | Environment — tool missing, no or multiple devices, dump failed | **The machine** — nothing to do with your app |

The `1`-vs-`3` split is the one that matters at 3am. `1` is a regression to investigate; `3`
is a box to fix. Full detail: [Exit codes](/verikun/reference/exit-codes/).

## Selector problems

### "not found" — but I can see it on screen

Work through these in order:

1. **Run `vk ui` and read the actual identifiers.** The element may carry no text at all, or
   different text than the visual label. This is the single most common cause.
2. **Check you are not matching against a `desc:` that does not exist.** `text:` falls back
   to the accessibility description; `desc:` never falls back to text. A `desc:` selector
   written against Android silently stops matching on iOS.
3. **Try `--contains`.** Matching is already case-insensitive and tries progressively looser
   [tiers](/verikun/reference/selectors/#auto-healing), but a label with an unexpected
   prefix or suffix still needs substring matching.
4. **Check whether it is `offscreen`.** `vk ui` marks it. `tap` and `text` scroll
   automatically; `find` and `assert` do not, by design.
5. **Give it longer.** `--wait 10s` if the screen is genuinely slow. The default window is
   5 seconds.

:::note
Android's dumper drops nodes it considers invisible and clips the rest to the display, so a
fully off-screen element is usually **not in the tree at all** on Android. The `offscreen`
marker is mostly an iOS signal.
:::

### "ambiguous selector" — exit 2

The selector matched more than one element. verikun prints the candidates and **never taps a
guess**.

```sh
vk tap text:"Continue" --index 1     # pick the Nth match, 0-based
vk tap @continue_btn                 # or use an id, which is usually unique
```

Note that **ambiguity is never waited on**. The elements are already on screen, so waiting
cannot disambiguate — the command reports and exits at once.

### The tap succeeded but nothing happened

Two likely causes:

- **You tapped a disabled control.** A Submit button the app disables until a form is valid
  is *present* long before it is *usable*. Add `--enabled`:
  ```sh
  vk tap @submit --enabled     # with auto-wait, reads as "wait until pressable"
  ```
- **You tapped a toggle that was already in the state you wanted.** A segmented control
  whose options share one handler *flips* on any tap, so "tap the option I want" lands on
  the other one whenever it was already chosen — exit `0`, nothing to notice, and the run
  exercises the wrong mode. Guard it:
  ```sh
  vk find "@mode_video --not-selected" --no-wait && vk tap @mode_video
  ```

### `vk tap 3` tapped the wrong thing

**Indexes are per-snapshot.** `vk tap 3` taps `[3]` from the *latest* dump. If anything
re-rendered in between, the index moved.

This is also why bare-index taps and `--at x,y` **never auto-wait** — polling would
re-capture and shift the indices underneath you.

Prefer `@id` and `text:` selectors for anything you will run twice.

## Waiting and timing

### The wait timed out but the element appears a moment later

Raise the window: `--wait 10s`, or `--wait 800ms` for a fast probe. A bare number is
milliseconds. See [Auto-wait](/verikun/reference/auto-wait/).

If a screen is *consistently* slower than 5 seconds, put the longer wait in the test rather
than raising a global default — the default exists so that ordinary flows need no waits at
all.

### `vk ui` reads a screen mid-transition

**Disable animations once**: `vk doctor --fix`. Live animations are the main cause of flaky
dumps. verikun already retries a dump 3 times, but a running animation defeats that.

### A tap right after `launch` did nothing

The first dump after `launch` can be stale — measured on real hardware. Assert on something
from the new screen before acting:

```sh
vk launch com.example.app
vk assert @home_tab --wait 10s
vk tap @get_started
```

## Typing

### My email address arrives truncated

Quote the value **in your own shell**:

```sh
vk text @email "bob+tag@mail.com"       # quoted — correct
vk text @email bob+tag@mail.com         # your shell may mangle this before vk sees it
```

verikun backslash-escapes every device-shell metacharacter before `adb input text`, so
`@ . + _ - / = : , ; ! # % &` and friends all land verbatim. The failure is almost always
the *host* shell, not the device one.

[`vk batch`](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch) and stdin use no
host shell at all, which sidesteps this entirely.

### Text starting with `-` is read as a flag

Put `--` first:

```sh
vk type -- "-50% off"
```

### Emoji or non-Latin characters do not type

An Android limitation in `adb input text`. ASCII is reliable; Unicode may not be. There is no
verikun-side fix.

### The keyboard is covering the element I want to inspect

`vk text` opens the keyboard. Use `--enter` to submit, or `vk back` to dismiss it before
re-inspecting.

## Device and environment

### "no device" or "multiple devices" — exit 3

One device auto-resolves. More than one and verikun refuses to guess:

```sh
vk devices                          # see what is attached
vk tap @x --device emulator-5554    # or export VERIKUN_DEVICE=emulator-5554
```

### The emulator's display went to sleep

A sleeping display hangs `uiautomator` dumps. Wake it first. This is worth knowing before
you conclude the app is wedged.

### `vk log` is empty

`vk log` is a **snapshot, not a stream** — it dumps recent lines and exits.

Inside a run it defaults to logs **since the run started**, so pre-session output is
excluded. If the app has been idle, there may genuinely be nothing. Widen it:

```sh
vk log com.example.app -n 500       # last N lines instead
vk log com.example.app --full       # everything
```

Scoping with a `package` filters to that app's live process. Once the app has **crashed**
its process is gone, so `vk log <pkg>` falls back to system-wide logs — where the crash
trace still is.

:::caution
Logs are **raw device output** and can contain anything the app logged, including secrets.
They are not redacted. Treat archived reports accordingly; `VERIKUN_NO_RUN=1` disables
recording entirely.
:::

### My phone was left dark, rotated, or offline

A bare `vk device set` from a shell **stays applied** — deliberately. Inside `batch`, `ai`
and `suite` it is restored automatically even if the flow dies, but a one-off is yours to
undo:

```sh
vk device reset
```

If a rollover happened between the change and the reset, verikun prints the exact
`vk device set … --device <serial>` needed to undo it. See
[Device state](/verikun/reference/device-state/#restore-lives-in-the-run-file).

### `airplane=on` was refused — exit 2

You are connected over **wireless adb**. Turning on airplane mode would cut the very link
carrying the next command, and nothing could turn it back on remotely. Recovery would mean
physically plugging in USB.

`--allow-wireless` overrides it if you mean it.

### The app is offline but the test says it is online

`airplane=on` is verified **by effect**, not by the flag — Android remembers a user who
re-enabled wifi during a previous flight, so `airplane-mode enable` can leave wifi *up*.
verikun reconciles the radios named in `airplane_mode_toggleable_radios` and forces any
survivor.

If you are chasing the opposite — `airplane=off` and the app still shows offline — note that
turning the radio back on is not the same as having internet. Follow it with a real wait:

```sh
vk device set airplane=off
vk assert @content --wait 10s     # not an immediate tap
```

## Remote server

| Symptom | Cause | Fix |
|---|---|---|
| **`409`** | Another run holds the device lock | One run at a time. Check your CI `concurrency` group; an idle lock is taken over after 5 minutes silent. |
| **`401`** | Auth key mismatch | Both sides need the same `VERIKUN_SERVER_AUTH_KEY`. It is sent as a bearer token. |
| Exit `3`, unreachable | Network path | Not verikun. Check the tailnet or route is up on the client. |
| Install rejected | Server lacks `--allow-install` | Restart the server with the flag; a read-only server refuses builds by design. |
| Device overrides stranded after a crash | Known gap: under `--server` the snapshot lives in the **server's** run file | `vk device reset` from the device box. |

## iOS and idb

| Symptom | Meaning |
|---|---|
| `clear` exits `3` | Expected. iOS has no per-app data reset. Use `launch` to restart instead. |
| `current` returns `(unknown)` | Expected. iOS exposes no reliable foreground-app query. |
| `--selected` / `--focused` exits `3` | Expected. `idb` emits no such key, so the filter could only ever match nothing. |
| `--tree` renders flat | Expected. `idb`'s accessibility list has no nesting depth. |
| `swipe --duration` ignored | Expected. `idb` has no duration knob. |
| `idb` not found | Install it, or set `IDB=/path/to/idb`. Run `vk doctor --ios`. |
| No logs from a physical device | Simulator-only. Use Console.app or `idb log`. |

Every one of these, plus what a physical device supports:
[Platform support](/verikun/guides/platform-support/).

## `vk ai` and suites

### A step heals on every replay

If a cached plan heals the same step on every run, the compiled selector is unstable —
usually a label-only control with no resource-id. You are paying repair tokens every run.

Two fixes: add a stable identifier in the app, or pin the selector in the prose. This is also
exactly the kind of friction worth
[reporting upstream](/verikun/getting-started/using-from-an-agent/#report-friction-upstream).

### The model gave up

`give_up` is **terminal** by design. It means the live screen had nothing serving the failed
step's intent — the flow drifted to the wrong screen or app.

Read the run's failure screenshot and hierarchy. The usual cause is an earlier step that
exited `0` without doing what you assumed.

### An assertion failed and was not healed

Correct. **Assertions are never healed** — healing one would mask the regression the test
exists to catch.

### The suite aborted with exit 3 partway through

The device or toolchain broke mid-run. verikun re-probes before aborting, precisely because a
transient `uiautomator` failure also exits `3`; an abort means it was still broken on the
re-probe.

The tests that did not run get **no rows** in `index.json` and no place in `totals`, so
nothing downstream mistakes them for regressions.

Consider `--retries 2` — environment failures earn retries with increasing backoff.

### The run costs more than expected

Every run reports `compile / repairs / replay=$0 / est $…`. If `replay` is not `$0`, the plan
is not being cached — check whether `--recompile` is set, whether the prose changes between
runs, or whether verikun was updated (which
[rotates the cache fingerprint](/verikun/internals/contracts/#the-plan-cache-fingerprint)
on purpose).

Cap it: `--max-cost-usd 0.50`.

## Still stuck?

- [Reports & test runs](/verikun/reference/reports-and-test-runs/) — a failed step captures
  a screenshot **and** the hierarchy of the page. Read the hierarchy; it usually answers the
  question directly.
- [github.com/ddikman/verikun/issues](https://github.com/ddikman/verikun/issues)
