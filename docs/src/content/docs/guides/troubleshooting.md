---
title: Troubleshooting
description: What common verikun failures actually mean, and what to do about each.
sidebar:
  order: 8
---

## Start here: read the exit code

verikun's exit codes tell you which *kind* of problem you have before you read a single line
of output:

| Code | Meaning | Who fixes it |
|---|---|---|
| `0` | Success | — |
| `1` | Not found · assertion failed · wait timeout | **The app** — a regression, or the test is wrong |
| `2` | Usage error, or **ambiguous selector** | **The test** — refine the selector or fix the arguments |
| `3` | Environment — tool missing, no usable device, dump failed | **The machine** — nothing to do with your app |

Full detail: [Exit codes](/verikun/reference/exit-codes/).

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
guess**, and it never waits on ambiguity — the elements are already on screen.

```sh
vk tap text:"Continue" --index 1     # pick the Nth match, 0-based
vk tap @continue_btn                 # or use an id, which is usually unique
```

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
re-rendered in between, the index moved. This is also why bare-index taps and `--at x,y`
**never auto-wait** — polling would re-capture and shift the indices underneath you. Prefer
`@id` and `text:` selectors for anything you will run twice.

## Waiting and timing

### The wait timed out but the element appears a moment later

Raise the window: `--wait 10s`, or `--wait 800ms` for a fast probe. A bare number is
milliseconds. See [Auto-wait](/verikun/reference/auto-wait/).

If a screen is *consistently* slower than 5 seconds, put the longer wait in the test rather
than raising a global default — the default exists so that ordinary flows need no waits at
all.

### `vk ui` reads a screen mid-transition

**Prepare the device once**: `vk device prep` (a physical device needs `--device <serial>`).
Live animations are the main cause of flaky dumps — verikun already retries a dump 3 times, but
a running animation defeats that — and prep turns them off along with the other knobs that make
reads trustworthy. See [Device state](/verikun/reference/device-state/#preparing-a-test-device).

### Why a test run takes as long as it does

Almost all of it is **reading the UI hierarchy**, and on Android the
[companion](/verikun/guides/companion/) already makes each read about ten times faster than
the stock dump (turn it off with `VERIKUN_COMPANION=0` and you get the slow path). Beyond
that, the lever is **how many reads a test makes**, not how fast each one is:

- **Every selector command is one read** — `tap`, `text`, `find`, `assert`, `swipe --on` — and
  a step that has to wait costs one read per poll.
- **A guard that finds nothing costs *two*** (a second look before concluding "absent").
  [`VERIKUN_GUARD_SETTLE_MS=0`](/verikun/reference/environment-variables/) restores the
  single-shot probe and roughly halves a guard-heavy plan, at the price of less patience.
- **Screenshots take about a second each** and are *not* free even when never read back — see
  [Screenshots](/verikun/reference/screenshots/). Prefer one `assert` over a screenshot you
  intend to read back.

### "No window to read"

The platform reports no root window. `launch` force-stops the app before starting it (and
`--clear` also wipes its data), so for a few seconds there is no window at all; an app whose
main thread is busy mid-transition reports the same thing while fully drawn. The gap lasts
several seconds on a physical phone.

**Any command that waits absorbs this** — `wait`, `find`, `assert`, `tap`, `text` — and keeps
polling until its window elapses, so you normally never see it. `vk ai` control-flow guards
ride it out too, for up to 10s.

It still surfaces from a command with **no wait budget**, such as a bare `vk ui` issued
immediately after `launch` — that exits `3`. Give it something to wait for instead:

```sh
vk launch com.example.app --clear
vk wait @home_tab --timeout 30s      # spends its budget rather than giving up
vk ui
```

A guard that stays blind past its 10s grace **still aborts** with exit `3`, because answering
"the selector is absent" for a screen nobody could read would let a guard-heavy plan finish
green having executed nothing.

### "The hierarchy held only a modal barrier"

A sheet or dialog is up with nothing addressable inside it — its contents have no semantics,
or a previous step left a modal open. The moment right after a modal opens or closes is already
retried for you, so this is a modal that stayed. Dismiss it: tap the barrier (`vk tap desc:Scrim`
on an English device; `vk ui` shows its label) or `vk key back`.

### A tap right after `launch` did nothing

The first dump after `launch` can return the previous screen, so a selector that also matches
something there resolves against stale coordinates and the tap exits `0` having done nothing
([#45](https://github.com/ddikman/verikun/issues/45)). Assert on something from the new
screen before acting:

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

On Android, `vk text` and `vk type` with non-ASCII input (CJK, accented Latin, emoji) exit
`0` but the field stays empty — `adb input text` cannot deliver it, and nothing checks what
landed ([#85](https://github.com/ddikman/verikun/issues/85)). ASCII is reliable.

### The last character is doubled

`vk text` occasionally leaves a duplicated final character in the field, while reporting
success ([#46](https://github.com/ddikman/verikun/issues/46)). Assert on the field's value
with `--text` when it matters.

### The keyboard is covering the element I want to inspect

`vk text` opens the keyboard. Use `--enter` to submit, or `vk back` to dismiss it before
re-inspecting.

## Device and environment

### "no device" — exit 3

Nothing usable is attached, or what is attached is `offline`/`unauthorized`:

```sh
vk devices     # see what is attached, and its state
vk doctor      # and whether the toolchain can drive it
```

### "is in use by …" or "every attached device is in use" — exit 2

Another job holds the device. verikun picks a free one by itself when you do not name one, so
this means everything is genuinely busy — or you asked for a specific busy device:

```sh
vk devices                                 # who holds what, and for how long
vk device release emulator-5554            # if that job is gone
VERIKUN_NO_CLAIM=1 vk tap @x               # or opt out of coordination entirely
```

A claim from a crashed job clears on its own. Full detail:
[Device claims](/verikun/reference/device-claims/).

### Devices keep dropping off adb

Intermittent `device not found` / `no device` on a host that has been up for days, with no
pattern you can pin to one phone, one cable or one test. The usual cause is not the device:
it is the **host's adb server**, which leaks USB handles the longer it runs until it starts
losing devices mid-run. `vk doctor` says so when it can measure it:

```
adb server: adb server is leaking USB handles (~120 kernel guard violations/min, up 216h) — devices will drop
  restart it: `adb kill-server && adb start-server` (safe; devices reconnect in a few seconds)
```

The restart is safe — every device reconnects within a few seconds — but it is **host-wide**,
so it also drops any other tool talking to `adb` on that machine.

[`vk server`](/verikun/guides/remote-devices-and-ci/) does this for itself: when nothing is
running it re-checks, and restarts a rotted adb server before the next job meets it. Set
`VERIKUN_NO_ADB_RECYCLE=1` to stop it, if something else on the host uses `adb` too.

The measurement is macOS-only (it reads the kernel's guard-violation log), so on Linux hosts
doctor stays quiet and the server never recycles. If a long-lived Linux CI host starts dropping
devices, restarting `adb` by hand is still worth a try.

### The display went to sleep

A slept device does **not** reliably fail the read: it serves the **lock screen** as a
well-formed hierarchy, so every selector then misses for a reason that has nothing to do with
your app. verikun checks that the display is on before every read, screenshot, tap, swipe,
keypress or typed text, wakes it if not, and clears a **swipe** lock by itself. A **PIN,
pattern or password** is never cleared — verikun never asks for or stores a device credential
— so the read exits **`3`** naming the lock. Remove the lock on a test device (*Settings >
Security*); `vk doctor` lists, per device, whether it is prepared and what kind of lock it
has.

A prepared device gives the display a **1-minute** timeout, long enough to span the gap
between two commands of one flow. If you would rather it never slept at all — the right answer
on a device with a lock verikun cannot clear — ask for the other policy:

```sh
vk device prep --device <serial>                          # screen-timeout=1m, and more
vk device prep --no-sleep-when-idle --device <serial>     # stay-awake=on, screen-timeout=max
```

To wake a device by hand: `vk key wakeup` (`vk key sleep` is the other direction; `vk key power`
is a toggle and cannot express either).

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
trace still is. Logs are raw device output and are
[not redacted](/verikun/reference/reports-and-test-runs/#secrets).

### The agent used a flag or command that does not exist

Almost always a **version skew**. The Claude Code plugin ships the skill that teaches an
agent how to drive verikun, and it updates separately from the CLI, so an agent reading a
months-old skill will confidently use a flag your `vk` no longer has.

`vk doctor` names whichever half is behind, as a warning. Fix it, then restart Claude Code
so the new skill loads. See
[Keeping it up to date](/verikun/getting-started/installation/#keeping-it-up-to-date).

### My phone was left dark, rotated, or offline

A bare `vk device set` from a shell **stays applied**. Inside `batch`, `ai` and `suite` it is
restored automatically even if the flow dies, but a one-off is yours to undo:

```sh
vk device reset
```

If a rollover happened between the change and the reset, verikun prints the exact
`vk device set … --device <serial>` needed to undo it. See
[Device state](/verikun/reference/device-state/#restore-lives-in-the-run-file).

### `airplane=on` was refused — exit 2

You are connected over **wireless adb**. Turning on airplane mode would cut the very link
carrying the next command, and nothing could turn it back on remotely. `--allow-wireless`
overrides it if you mean it.

### The app is offline but the test says it is online

`airplane=on` is verified **by effect**, not by the flag: Android can leave wifi up after
enabling airplane mode, so verikun forces any surviving radio off and says so on stderr.

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

Failover, a full device disk, a stranded device-state snapshot and the other server-side
symptoms are in the
[Remote devices & CI troubleshooting table](/verikun/guides/remote-devices-and-ci/#troubleshooting).

## iOS and idb

| Symptom | Fix |
|---|---|
| `idb` not found | Install it, or set `IDB=/path/to/idb`. Run `vk doctor --ios`. |
| No logs from a physical device | Simulator-only. Use Console.app or `idb log`. |

Anything that exits `3` naming a capability — `clear`, `--selected`, `--focused`, a device
setting — is a documented gap, not a broken setup: `--tree` renders flat, `current` returns
`(unknown)`, `swipe --duration` is ignored. Every one of these, plus what a physical device
supports: [Platform support](/verikun/guides/platform-support/).

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
exited `0` without doing what you assumed. On a device in a non-English locale, an OS
permission dialog is a known cause
([#116](https://github.com/ddikman/verikun/issues/116)).

### An assertion failed and was not healed

Correct. **Assertions are never healed** — healing one would mask the regression the test
exists to catch.

### The suite aborted with exit 3 partway through

The device or toolchain broke mid-run. verikun re-probes before aborting, because a
transient `uiautomator` failure also exits `3`; an abort means it was still broken on the
re-probe. The tests that did not run get **no rows** in `index.json` and no place in
`totals`, so nothing downstream mistakes them for regressions. Consider `--retries 2` —
environment failures earn retries with increasing backoff.

### The run costs more than expected

Every run reports a cost line —
`compile=$0.0184 · repairs=$0.0000 · replay=$0 · cache_read=12043 tok · est $0.0184`. On a
repeat run `compile` should be `$0.0000`; if it is not, the plan is not being cached — check
whether `--recompile` is set, whether the prose changes between runs, or whether verikun was
updated (which
[rotates the cache fingerprint](/verikun/internals/contracts/#the-plan-cache-fingerprint)).
A non-zero `repairs` means steps are drifting instead — tighten the selectors the prose
names. [Reading the cost line](/verikun/reference/cost/#reading-the-cost-line) breaks down
each field.

On CI, check whether the job restores `./.verikun/plans/` at all. A fresh runner has no
cache, so every test recompiles every run —
[persisting it](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache) is what
gets you to the \$0 steady state.

Cap it: `--max-cost-usd 0.50`. Note the cap is **per test**, so a suite's ceiling is that
figure times the number of tests — see [the budget](/verikun/reference/cost/#the-budget).

## Still stuck?

- [Reports & test runs](/verikun/reference/reports-and-test-runs/) — a failed step captures
  a screenshot **and** the hierarchy of the page. Read the hierarchy; it usually answers the
  question directly.
- [github.com/ddikman/verikun/issues](https://github.com/ddikman/verikun/issues)
