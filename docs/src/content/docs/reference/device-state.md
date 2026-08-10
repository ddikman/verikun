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
| `airplane` | `on\|off` |
| `dark` | `on\|off` |
| `font-scale` | `0.5`–`3.0`, or `default` |
| `rotation` | `portrait\|landscape\|portrait-reverse\|landscape-reverse\|auto` |
| `stay-awake` | `on\|off` |

Android supports all five. iOS does not, and a simulator and a physical device differ —
[Platform support](/verikun/guides/platform-support/#device-settings) is the per-key matrix.

`vk device caps` prints what the active platform supports, but note that on iOS it reports the
**simulator** answer whether or not you resolved a physical device: the capability table is
static, and only the driver knows what it found.

### Value domains

- **`on|off`** also accepts `true/false`, `yes/no`, `enable/disable`, `enabled/disabled`,
  `1/0`. All canonicalise to `on` / `off`.
- **`font-scale`** takes a number from `0.5` to `3.0`, or the literal `default` (which is
  `1.0`). Values are canonicalised, so `1.30`, `1.3` and `1.300` compare equal on readback.
- **`rotation`** takes only the five named values. Bare integers are rejected on purpose.
  `auto` is a real value, so a snapshot can restore auto-rotate.

### When a platform cannot do it

An unsupported key exits **`3` before any device I/O**, naming the manual equivalent. A test
asking for something the platform cannot do therefore fails on the first step rather than
half-way through a half-modified device.

For `vk suite` and `vk ai`, device-setting keys and values are validated at **plan-validation
time** — unlike every other command, whose selector failures are runtime facts the engine can
heal. That is what makes a suite asking for `rotation` on iOS fail before the first tap.

## Every write is verified by readback

`svc`, `cmd` and `settings put` are all fire-and-forget, and are silently ignored on some OEM
skins. Trusting the exit code would report success for a change that never happened.

So verikun mutates, then **polls the setting until it reads the wanted value** (200 ms up to
4 s) and throws exit `3` naming both the command and the value still being reported.

### `airplane=on` is verified by effect, not by its flag

Android keeps `airplane_mode_toggleable_radios` — typically `bluetooth,wifi,nfc` — and
remembers a user who re-enabled wifi during a previous flight. So `airplane-mode enable`
**can leave wifi up**.

verikun reads that list off the device, reconciles only the radios it names, forces any
survivor, and announces it on stderr.

Deliberately **not** `mobile_data`: cellular is never in that list (the flag cuts it
outright), and `mobile_data` is a stored user *preference* rather than live radio state — so
on a SIM-less device it keeps reading `1` while the device is plainly offline, and would fail
a perfectly good offline state.

Reporting "offline" while the app is still online would make an offline test pass for the
wrong reason. That is the worst failure mode a testing tool has.

### `airplane=off` re-enables the radio, not the internet

Follow it with a real wait rather than tapping straight away:

```sh
vk device set airplane=off
vk assert @content --wait 10s
```

## Wireless adb is refused for `airplane=on`

It would cut the very link carrying the next command, and nothing could turn it back on
remotely — recovery means physically plugging in USB.

Exit `2`; `--allow-wireless` overrides it if you mean it.

verikun classifies a serial as `usb`, `tcp` or `emulator`. An unrecognised serial shape
deliberately falls back to `usb`: this is a foot-gun net, not a security boundary, so
blocking a legitimate run is the worse error.

## Restore lives in the run file

`device set` records what each setting held **before** verikun first touched it — earliest
wins, so setting `dark` twice still restores to the pre-run value.

That snapshot lives in the **run file**, not in memory. Because every `vk` call is its own
process, an in-memory latch could not undo a flow that died; the run file can, so
`vk device reset` works from a later process.

`batch`, `ai` and `suite` call reset from a `finally`, which is what stops a test that dies
between `airplane=on` and `reset` from stranding the device.

**A bare `vk device set` from a shell deliberately stays applied.** It is yours to reset —
do not strand someone's phone offline.

### Rollover carries the snapshot

See [Rollover and device overrides](/verikun/reference/reports-and-test-runs/#rollover-and-device-overrides)
— a same-device rollover carries unrestored overrides forward; a device-change rollover warns
with the exact command needed to undo them.

### Known gap: `--server`

Under `--server` the snapshot is written by the **server** process, so a crashed client leaves
overrides applied on the device. Run `vk device reset` from the device box.

## Why this is safe to expose over RPC

Every device token issued comes from a **closed enum** in the settings table, so no
caller-supplied string ever reaches the device shell. That is why `device` is exposed over
[`vk server`](/verikun/guides/remote-devices-and-ci/) RPC without a new `--allow-*` flag —
unlike `install`, which writes an arbitrary binary.

## Where this is implemented

`src/device/settings.ts` is a **table, not code**. It declares every key: its value domain,
its per-platform support (`supported` / `unsupported` / `noop`), and — where unsupported —
the manual equivalent.

One table drives four consumers: argument validation, the driver switch, `vk device caps`,
and the `vk ai` plan validator. Adding a setting is a table row plus a `case` in each driver,
so a platform gap can never be documented in one place and forgotten in another.

Two invariants the unit suite enforces: every `unsupported` entry names a manual equivalent,
and every `noop` says why it was unnecessary.
