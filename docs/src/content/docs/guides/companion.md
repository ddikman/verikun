---
title: The Android companion
description: The on-device helper that makes reading the UI hierarchy about 10x faster — on by default, and how to turn it off.
sidebar:
  order: 7
---

Reading the UI hierarchy is the single most expensive thing verikun does on Android — about
**2.4s per call**, and every selector command makes at least one. On a guard-heavy suite
that is the overwhelming majority of the runtime.

The companion is a small program pushed to the device that answers the same question in
about **40ms end to end**, returning byte-identical results.

```sh
vk ui          # ~0.2s instead of ~2.4s — nothing to enable
```

**It is on by default.** verikun starts it the first time it reads the hierarchy, and
`VERIKUN_COMPANION=0` turns it off — see [What it costs you](#what-it-costs-you) for when
you would want to.

The first read on a device pays for setting it up: about **6s** to push, start and
[calibrate](#calibration). After that every read is ~0.2s, and the verdict is remembered on
the device, so when the companion idle-shuts-down a later run restarts it in about **2.1s**
without recalibrating.

It also makes auto-wait behave. A 5s wait for an element that never appears takes ~6.4s with
the companion but ~10.8s without: the stock path's final 2.4s read starts just before the
deadline, so every timeout overshoots by most of a read.

**Every command that resolves a selector benefits**, not just `vk ui` — they all read the
hierarchy through the same path. Measured on a settled screen, same device:

| Command | Stock | Companion | |
|---|--:|--:|--:|
| `vk find` | 2.48s | 0.20s | 12.3x |
| `vk assert` | 2.45s | 0.20s | 12.0x |
| `vk wait` | 2.44s | 0.21s | 11.5x |
| `vk tap` | 2.48s | 0.31s | 8.1x |
| `vk text` | 3.03s | 0.85s | 3.6x |

The remainder is the *action* itself. `adb shell input tap` costs ~0.1s and typing rather
more, and neither goes through the companion today — which is why `text` gains least. Auto-wait
polling, auto-scroll re-reads, `vk ai` guards and failure-evidence capture all read through
the same path, so they benefit identically.

## Why the stock read is slow

Measured on a physical SM-A415F (Android 12). Almost none of it is work:

| Stage | Cost |
|---|--:|
| Starting ART and loading `uiautomator.jar` | ~1.22s |
| `waitForIdle(1000, 10000)` | ~1.00s |
| Actually walking and serialising the tree | ~0.10s |

Both large terms are **per-invocation**, and `adb shell uiautomator dump` is one invocation
per read. Neither depends on how complex your screen is: a 57-node launcher and a deep app
screen both cost ~2.4s.

The idle wait is the interesting one. It is not a flat one-second sleep — it waits for the
accessibility event stream to have been *quiet* for 1000ms, and a **freshly connected**
bridge has no history of quiet, so it has to sit and observe one. A long-lived connection
already knows the screen has been idle for ages and returns immediately.

So the companion keeps the full idle semantics and still returns in milliseconds. This is
not a case of trading safety for speed.

## What it actually does

It is Java compiled to dex, pushed to `/data/local/tmp`, and run by the phone's own runtime
via `app_process` — the same approach scrcpy uses. **Nothing is installed**: no APK, no
root, and your device's package list is untouched. verikun starts it on first use and it
shuts itself down after 15 minutes idle.

It **does not cache the hierarchy.** Every read still walks the live tree; what it keeps
alive is the *connection*. verikun's rule that every command re-captures the screen fresh
is unchanged.

It borrows the platform's own serialiser, so the XML is byte-for-byte what
`uiautomator dump` would have produced — verified on-device, not assumed.

## What it costs you

**A device has exactly one `UiAutomation` connection, and the companion holds it.** While
it runs, anything else that wants that connection loses:

- `adb shell uiautomator dump` is **killed** (exit 137)
- Appium and Android Studio's Layout Inspector cannot attach
- accessibility services such as TalkBack are suppressed

If you need any of those on the same device, turn the companion off — the connection goes
back and verikun uses the stock read:

```sh
export VERIKUN_COMPANION=0    # for a whole session
vk companion stop             # or just hand it back once
vk companion status           # "running on port 8486 (ready app held)" / "not running"
```

`0`, `false`, `off` and `no` all opt out. Anything else — including an empty value — leaves
it on: failing *open* is the safe direction here, because the worst case is the fast path,
which already falls back on its own.

It is on by default because the alternative did not work. A hierarchy read is the dominant
cost of every Android run, and nobody discovers an environment variable they were never
told about — the people who most need the speedup are the least likely to go looking for
it.

## It will not fail your test

verikun falls back to the stock read whenever the companion cannot serve one, and gets it
off the connection first so the fallback actually works. Measured:

| Situation | Result |
|---|---|
| Companion dump fails | Connection released, stock read used, run continues |
| Companion killed or crashed | Stock read works immediately — process death frees the connection |
| Companion running but released | Connection retaken (~1.7s), then reads are fast again |
| Companion cannot start | Stock read, one line on stderr — and the device is marked so it is not retried |
| Output disagrees with the platform | Companion declined for the session |

A fallback read costs about **3.4s** against 2.4s if the companion had never existed — a
~1s penalty on the rare failure path, in exchange for ~40ms on every other read.

## Calibration

On first use verikun takes **one** real `uiautomator dump` and checks the companion
reproduces it exactly. That is most of the ~5.8s first read.

The answer is then remembered **on the device** (`/data/local/tmp/verikun-companion.note`,
keyed by verikun version), so it is paid once per device rather than once per companion —
a restart after the idle shutdown reuses it and costs ~2.1s. The same note records a device
where the companion could not start at all, so that phone falls straight through to the
stock read instead of paying a doomed startup on every command.

This exists because the dumper clips every node's bounds to a display size, and **which size
the platform uses genuinely differs between devices**:

| Device | Vendor | Android | Clips to |
|---|---|---|---|
| Samsung SM-A415F | Samsung | 12 | the **app window** (1080x2184) |
| Pixel 3a | Google | 12 | the **app window** (1080x2176) |
| Pixel 6 emulator | AOSP | 14 | the **physical display** (1080x2400) |

The boundary is the **platform version, not the vendor**, and it is in AOSP itself:
`DumpCommand` reads `getSize()` on the `android12-release` and `android13-release` branches
and `getRealSize()` from `android14-release` onward. A Samsung and a Google device on
Android 12 therefore agree with each other, and both differ from Android 14.

So any hard-coded choice is wrong on one side of that boundary. verikun could pin a version
table instead — but the platform has already changed this once, and calibrating against the
device in front of you handles the next change without an update.

The gap ranges from 44px to 254px, and guessing wrong would not fail loudly — it would shift
elements near the bottom of the screen so a tap lands somewhere else while still reporting
success. So verikun does not guess, and if neither candidate reproduces the platform's dump
it declines the companion and stays on the stock path.

## iOS

Not applicable, and not needed: `idb` already keeps a companion process alive and reads the
hierarchy in ~0.2s. `vk companion` exits `3` on iOS. See
[Platform support](/verikun/guides/platform-support/).

## Related

- [Why a test run takes as long as it does](/verikun/guides/troubleshooting/#why-a-test-run-takes-as-long-as-it-does)
- [Environment variables](/verikun/reference/environment-variables/)
