---
title: Device state
description: Change the device the app runs on — airplane mode, dark mode, font scale, rotation, stay-awake — and put it back.
sidebar:
  order: 8
---

Some behaviour only appears when the *device* changes underneath the app: the offline banner,
the retry path, dark theme, a layout that breaks at accessibility text sizes, landscape.

`vk device set` changes those, **verifies each one landed**, and — this is the part that
makes it safe to point at your own phone — **puts them back**.

```sh
vk device set airplane=on                                # go offline
vk tap @retry
vk assert text:"No connection"
vk device reset                                          # back online

vk device set dark=on font-scale=1.3 rotation=landscape  # several at once
vk device get --json
vk device caps                                           # what this platform supports
```

## The keys

| key | values |
|---|---|
| `animations` | `on\|off` |
| `airplane` | `on\|off` |
| `dark` | `on\|off` |
| `font-scale` | `0.5`–`3.0`, or `default` |
| `rotation` | `portrait\|landscape\|portrait-reverse\|landscape-reverse\|auto` |
| `stay-awake` | `on\|off` |
| `screen-timeout` | a duration like `30s` / `10m`, a bare number of milliseconds, or `max` |
| `dnd` | `on\|off` |
| `doze` | `on\|off` |

Android supports all nine. iOS does not, and a simulator and a physical device differ —
[Platform support](/verikun/guides/platform-support/#device-settings) is the per-key matrix.
Note that `vk device caps` on iOS reports the **simulator** answer even when you resolved a
physical device.

`screen-timeout` reads back as **milliseconds**, not as the duration you typed, because that
is what the device stores.

### Value domains

- **`on|off`** also accepts `true/false`, `yes/no`, `enable/disable`, `enabled/disabled`,
  `1/0`. All canonicalise to `on` / `off`.
- **`font-scale`** takes a number from `0.5` to `3.0`, or the literal `default` (which is
  `1.0`). `1.30`, `1.3` and `1.300` compare equal on readback.
- **`rotation`** takes only the five named values; bare integers are rejected. `auto` is a
  real value, so a snapshot can restore auto-rotate.

### When a platform cannot do it

An unsupported key exits **`3` before any device I/O**, naming the manual equivalent. For
`vk suite` and `vk ai`, device-setting keys and values are validated when the plan is
validated, so a suite asking for `rotation` on iOS fails before the first tap rather than
half-way through a half-modified device.

## Every write is verified by readback

Some OEM skins silently ignore `settings put`, `svc` and `cmd`, so verikun never trusts the
exit code: it mutates, then **polls the setting until it reads the wanted value** (200 ms,
up to 4 s), and exits `3` naming both the command and the value still being reported.

### `airplane=on` is verified by effect, not by its flag

Android can leave wifi up after `airplane-mode enable` — it remembers a radio the user
re-enabled during a previous flight. verikun reconciles the radios the device lists as
toggleable, forces any survivor off, and says so on stderr. Mobile data is not part of that
check: it is a stored preference rather than live radio state, so on a SIM-less device it
still reads on while the device is plainly offline.

### `airplane=off` re-enables the radio, not the internet

Follow it with a real wait rather than tapping straight away:

```sh
vk device set airplane=off
vk assert @content --wait 10s
```

## Preparing a test device

`device set` is for **one test**: change something, then put it back. Setting a phone up so
that reads are trustworthy at all is `vk device prep`.

```sh
vk device prep --dry-run                 # what would change, and from what
vk device prep --device 032AY1UNR2       # a physical device must be named
vk device prep                           # an emulator is auto-selected
vk device prep --revert --device 032AY1UNR2   # put it back the way you found it
```

It establishes five knobs, each preventing a failure verikun actually meets:

| knob | why |
|---|---|
| `animations=off` | a live animation makes `uiautomator dump` return a stale or empty screen |
| `stay-awake=off` | it overrides the display timeout while charging, so a tethered device would never sleep |
| `screen-timeout=1m` | the stock 15–30s blanks the display between two commands of one flow |
| `dnd=on` | a heads-up notification lands on top of the app and steals the next tap |
| `doze=off` | battery idle suspends the background work a test is waiting on |

On Android 9 the `dnd` knob is not scriptable and prep fails on it
([#103](https://github.com/ddikman/verikun/issues/103)).

### Prep is sticky; `device set` is not

`device set` snapshots into the **run file** and is auto-restored by `batch`, `ai` and
`suite`. Prep must outlive the run that established it, so its snapshot goes to a host-global
record under `~/.verikun/prepared/` and is undone only by an explicit `--revert`.

### A physical device must be named

Naming the serial with `--device` is the opt-in; there is no trust list. An emulator is
auto-selected, as it is for
[`devices start|stop|restart`](/verikun/reference/commands/), which likewise never
power-cycles a physical device.

### The device parks itself

A prepped device's display goes dark about a minute after the last command and is woken
before the next one needs it, so a longer gap between commands is not a failure.

`vk device prep --no-sleep-when-idle` selects the other policy — `stay-awake=on`,
`screen-timeout=max`, the display never turns off. That is the answer for a device with a
PIN or pattern lock, which verikun cannot clear; prep says so at the time if it finds one.

### Screen locks: warned about, never removed

verikun never asks for or stores a device credential, so it cannot remove a PIN, pattern or
password lock. `vk doctor` and `vk device prep` **report** a lock and name the fix: remove it
in *Settings > Security*. A residual **swipe** lock is cleared automatically on every run.

A locked device does not fail a read — it serves the lock screen as a perfectly valid
hierarchy, so every selector then misses. verikun detects the keyguard, wakes the device, and
exits `3` naming the lock if it stays up. See
[Troubleshooting](/verikun/guides/troubleshooting/#the-display-went-to-sleep).

## Wireless adb is refused for `airplane=on`

It would cut the very link carrying the next command, and nothing could turn it back on
remotely. Exit `2`; `--allow-wireless` overrides it if you mean it. The check classifies the
serial by shape (`host:port` is wireless); an unrecognised shape is treated as USB.

## Restore lives in the run file

`device set` records what each setting held **before** verikun first touched it — earliest
wins, so setting `dark` twice still restores to the pre-run value.

The snapshot lives in the run file, so `vk device reset` works from a later process even
when the flow that made the change died. `batch`, `ai` and `suite` reset from a `finally`,
which is what stops a test that dies between `airplane=on` and `reset` from stranding the
device.

**A bare `vk device set` from a shell stays applied.** It is yours to reset — do not strand
someone's phone offline.

### Rollover carries the snapshot

See [Rollover and device overrides](/verikun/reference/reports-and-test-runs/#rollover-and-device-overrides)
— a same-device rollover carries unrestored overrides forward; a device-change rollover warns
with the exact command needed to undo them.

### Known gap: `--server`

Under `--server` the snapshot is written by the **server** process, so a crashed client leaves
overrides applied on the device. Run `vk device reset` from the device box.
