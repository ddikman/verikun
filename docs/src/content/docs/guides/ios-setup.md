---
title: iOS setup
description: Install idb, drive a simulator or physical device with --ios, and understand the documented gaps.
sidebar:
  order: 6
---

`vk --ios` reaches feature parity with Android — `ui` / `find`, `tap`, `text` / `type`,
`swipe`, `key`, `assert`, `wait`, `screenshot`, `launch` / `stop`, plus
[`vk batch`](/verikun/guides/writing-test-cases/), [`vk ai`](/verikun/guides/natural-language-tests/),
and the JUnit + HTML reports — on both simulators and physical devices.

Parity is not total, and it differs between a simulator and a physical device.
[Platform support](/verikun/guides/platform-support/) is the command-by-command matrix; this
page is how to get the toolchain working.

## Install idb

Everything interactive is powered by **[`idb`](https://github.com/facebook/idb)** (Facebook's
iOS Development Bridge), shelled one-shot like `adb`:

```sh
brew tap facebook/fb && brew install idb-companion   # the companion daemon
pip install fb-idb                                    # the idb CLI (needs Python 3.6+)
```

Then boot a simulator and check the toolchain:

```sh
xcrun simctl boot "iPhone 17 Pro"    # or start Simulator.app
vk doctor --ios
```

`vk --ios ui`, `vk --ios tap`, and the rest then work.

:::tip
Set `IDB=/path/to/idb` if the binary is not on your `PATH` — for example when it lives in a
Python virtualenv. See [Environment variables](/verikun/reference/environment-variables/).
:::

## Which tool does what

verikun picks between `simctl` and `idb` per operation, based on whether the resolved UDID
is a simulator:

| Operation | Simulator | Physical device |
|---|---|---|
| Accessibility hierarchy | `idb ui describe-all` | `idb ui describe-all` |
| Tap / type / swipe / key | `idb ui …` | `idb ui …` |
| Screen size | `idb describe` | `idb describe` |
| Screenshot | `xcrun simctl` | `idb` |
| Launch / stop | `xcrun simctl` | `idb` |
| Device logs | `xcrun simctl` (`log show`) | **unsupported** |
| `device set dark` / `font-scale` | `xcrun simctl ui` | **unsupported** |

`--device booted` is resolved to the concrete UDID of the booted simulator, since `idb`
cannot address the `booted` alias itself.

## Documented limitations

Where the platform has no clean equivalent, verikun refuses with a named reason rather than
half-implementing it. [Platform support](/verikun/guides/platform-support/) is the full
matrix; two entries there decide which target you should pick:

- **A physical iOS device supports no device settings at all** — `dark` and `font-scale`,
  the two keys that work on a simulator, refuse on a device.
- **`log` capture is simulator-only.** For a physical device use Console.app or `idb log`
  directly, and expect an archived run from one to carry no device log.

## Writing selectors that work on iOS

The advice does not change on iOS — **`@id` first, `text:` second, `desc:` never**; the
reasoning is in [Selectors](/verikun/reference/selectors/#which-selector-to-reach-for).

What *is* iOS-specific is where a label ends up. An accessibility label arrives as `desc` on
Android but as `text` on iOS, so a `desc:` selector written against Android **silently stops
matching** when you point the same test at a simulator. `desc:` on iOS reaches only the
accessibility *hint*, which almost nothing sets.

`--selected` and `--focused` exit `3` on iOS rather than matching nothing; `--enabled` and
`--checked` work on both — see
[Platform support](/verikun/guides/platform-support/#selectors-and-state-modifiers).

## Where to go next

- [Platform support](/verikun/guides/platform-support/) — the full per-platform matrix
- [Troubleshooting](/verikun/guides/troubleshooting/#ios-and-idb) — idb-specific failures
- [Device state](/verikun/reference/device-state/) — how snapshot and restore work
- [Selectors](/verikun/reference/selectors/) — the complete grammar
- [`example/flutter-app/README.md`](https://github.com/ddikman/verikun/blob/main/example/flutter-app/README.md)
  — what `vk` reports for each Flutter widget, per platform
