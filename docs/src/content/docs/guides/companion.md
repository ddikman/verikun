---
title: The Android companion
description: The on-device helper that makes reading the UI hierarchy about 10x faster — on by default, and how to turn it off.
sidebar:
  order: 7
---

Reading the UI hierarchy is the single most expensive thing verikun does on Android: a stock
`uiautomator dump` costs about **2.4s per call**, every selector command makes at least one,
and on a guard-heavy suite that is most of the runtime.

The companion is a small program pushed to the device that answers the same question in
about **0.2s**, reporting every element the stock read does, with identical bounds.

```sh
vk ui          # ~0.2s instead of ~2.4s — nothing to enable
```

**It is on by default.** verikun starts it the first time it reads the hierarchy, and
`VERIKUN_COMPANION=0` turns it off — see [What it costs you](#what-it-costs-you) for when you
would want to.

The first read on a device pays for setting it up: about **6s** to push, start and
[calibrate](#calibration). After that every read is fast, and the verdict is remembered on
the device, so a later run restarts an idle-stopped companion in about 2s without
recalibrating. Every command that resolves a selector benefits, not just `vk ui`: `find`,
`assert`, `wait`, `tap`, `text`, auto-wait polling, `vk ai` guards and failure-evidence
capture all read through the same path.

## What it does

It is Java compiled to dex, pushed to `/data/local/tmp`, and run by the phone's own runtime
via `app_process` — the same approach scrcpy uses. **Nothing is installed**: no APK, no root,
and your device's package list is untouched. It shuts itself down after 15 minutes idle.

It **does not cache the hierarchy**. Every read still walks the live tree; what it keeps
alive is the accessibility *connection*, which is where the stock dump spends its time. The
XML it returns is what `uiautomator dump` would have produced.

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

`0`, `false`, `off` and `no` all opt out. Anything else, including an empty value, leaves it
on.

## It will not fail your test

verikun falls back to the stock read whenever the companion cannot serve one — a failed dump,
a crashed process, output that disagrees with the platform, a connection that has gone stale
— and releases the connection first so the fallback actually works. A fallback read costs
about a second more than a stock read would have.

A fallback suppresses the companion for about a minute, then it is tried again; when the
*screen* was the problem rather than the companion (an app that has not drawn yet), only for
a couple of seconds. Only two things stand it down for the whole process: the device note
saying the companion cannot start on this phone, and no jar to push.

Known gap: on HyperOS (Android 15) the companion crashes on startup, so every read silently
takes the slow path ([#87](https://github.com/ddikman/verikun/issues/87)). `vk companion
status`, or `reads` on a server's `/v1/health`, tells you which path is in use.

## Calibration

On first use verikun takes **one** real `uiautomator dump` and checks that the companion
reproduces it: every tappable or focusable node byte-identical, in the same order. Decor
outside the app's own window — a navigation-bar background, which nothing can tap — may be
missing from the companion's dump and is tolerated. Anything else declines the companion for
that device, and verikun stays on the stock path rather than risk a tap landing somewhere
else while reporting success.

The verdict is remembered **on the device** (`/data/local/tmp/verikun-companion.note`, keyed
by verikun version), so it is paid once per device. The same note records a device where the
companion could not start at all.

## Under `vk server`

The companion works exactly as it does locally, with two things worth knowing:

**`VERIKUN_COMPANION` is read in the server's environment, not the client's.** Reads execute
server-side, so a client cannot turn the companion on or off across the wire, and
`vk companion status|stop` has no `--server` form. To hand the connection back on a remote
host, run `vk companion stop` there, or stop the server, which releases it.

**Ask the server which path it is using** rather than inferring it from step durations:
[Check which read path the server is using](/verikun/guides/remote-devices-and-ci/#check-which-read-path-the-server-is-using).

## iOS

Not applicable, and not needed: `idb` already keeps a companion process alive and reads the
hierarchy quickly. `vk companion` exits `3` on iOS. See
[Platform support](/verikun/guides/platform-support/).

## Related

- [Why a test run takes as long as it does](/verikun/guides/troubleshooting/#why-a-test-run-takes-as-long-as-it-does)
- [Environment variables](/verikun/reference/environment-variables/)
