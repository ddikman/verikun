---
title: The Android companion
description: An opt-in on-device helper that makes reading the UI hierarchy about 10x faster, and what it costs you.
sidebar:
  order: 7
---

Reading the UI hierarchy is the single most expensive thing verikun does on Android — about
**2.4s per call**, and every selector command makes at least one. On a guard-heavy suite
that is the overwhelming majority of the runtime.

The companion is a small program pushed to the device that answers the same question in
about **40ms end to end**, returning byte-identical results.

```sh
export VERIKUN_COMPANION=1
vk ui          # ~0.2s instead of ~2.4s
```

It is **opt-in** — see [What it costs you](#what-it-costs-you) for why.

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

That is why this is opt-in rather than the default. Hand the connection back at any time:

```sh
vk companion stop
vk companion status     # "running on port 8486 (ready app held)" / "not running"
```

## It will not fail your test

verikun falls back to the stock read whenever the companion cannot serve one, and gets it
off the connection first so the fallback actually works. Measured:

| Situation | Result |
|---|---|
| Companion dump fails | Connection released, stock read used, run continues |
| Companion killed or crashed | Stock read works immediately — process death frees the connection |
| Companion cannot start | Stock read, one line on stderr |
| Output disagrees with the platform | Companion declined for the session |

A fallback read costs about **3.4s** against 2.4s if the companion had never existed — a
~1s penalty on the rare failure path, in exchange for ~40ms on every other read.

## Calibration

On first use verikun takes **one** real `uiautomator dump` and checks the companion
reproduces it exactly, then remembers the answer. That costs ~3.5s once per companion.

This exists because the dumper clips every node's bounds to a display size, and which size
the platform uses varies by build — AOSP reads the physical display, a physical SM-A415F's
stock dump matches the app window (a 216px difference on that device). Guessing wrong would
not fail loudly; it would shift elements near the bottom of the screen so a tap lands
somewhere else while still reporting success. So verikun does not guess, and if neither
candidate reproduces the platform's dump it declines the companion and stays on the stock
path.

## iOS

Not applicable, and not needed: `idb` already keeps a companion process alive and reads the
hierarchy in ~0.2s. `vk companion` exits `3` on iOS. See
[Platform support](/verikun/guides/platform-support/).

## Related

- [Why a test run takes as long as it does](/verikun/guides/troubleshooting/#why-a-test-run-takes-as-long-as-it-does)
- [Environment variables](/verikun/reference/environment-variables/)
