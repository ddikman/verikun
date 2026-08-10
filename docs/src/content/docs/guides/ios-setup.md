---
title: iOS setup
description: Install idb, drive a simulator or physical device with --ios, and understand the documented gaps.
sidebar:
  order: 5
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
iOS Development Bridge), shelled one-shot exactly like `adb`, so verikun stays
zero-runtime-dependency and one-process-per-command.

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

`resolvedSerial()` always returns a **concrete UDID** — `idb` cannot address the
simctl-only `booted` alias.

## Documented limitations

These are deliberate honest degradations, not bugs. Where a platform has no clean
equivalent, verikun says so rather than half-implementing it.

**[Platform support](/verikun/guides/platform-support/) is the full matrix** — every command
and feature, per platform, with simulator and physical device separated. Two entries there
decide which target you should pick:

- **A physical iOS device supports no device settings at all.** `simctl` drives simulators
  only and `idb` covers interaction rather than preferences, so `dark` and `font-scale` — the
  two keys that work on a simulator — refuse on a device. Note that `vk device caps --ios`
  reports the simulator answer either way, because the capability table is static.
- **`log` capture is simulator-only.** For a physical device use Console.app or `idb log`
  directly. That also means an archived run from a physical device carries no device log.

## Writing selectors that work on iOS

The advice does not change on iOS: **`@id` first, `text:` second, `desc:` never.** `@id` is
the only selector that means the same thing on both platforms, and it is the only one that
survives localisation. The per-kind mapping and the reasoning are in
[Selectors](/verikun/reference/selectors/#which-selector-to-reach-for).

What *is* iOS-specific is where a label ends up. An accessibility label arrives as `desc` on
Android but as `text` on iOS, so a `desc:` selector written against Android **silently stops
matching** when you point the same test at a simulator. `desc:` on iOS reaches only the
accessibility *hint*, which almost nothing sets.

For a Flutter app, `@id` comes from `Semantics(identifier:)` and `Semantics(label:)` is the
label that moves fields. Note that an element carrying an identifier but **no** label, value
or action survives in the Android hierarchy and vanishes from the iOS one entirely — so
anything that has to be findable on both needs a label as well as an id.

`--selected` and `--focused` exit `3` on iOS rather than matching nothing; `--enabled` and
`--checked` work on both. See
[Platform support](/verikun/guides/platform-support/#selectors-and-state-modifiers).

## Measured Flutter facts

The repository ships a Flutter fixture app whose accessibility semantics are controlled, so
cross-platform behaviour can be measured rather than assumed. Two findings there are
**verikun gaps rather than fixture quirks**:

- `obscureText` does not set the `password` flag on iOS, so
  [text redaction](/verikun/reference/reports-and-test-runs/#secrets) never fires there for
  Flutter.
- A tap issued immediately after `launch` can exit `0` having done nothing — the first dump
  after launch can be stale.

The full measured list lives in
[`example/flutter-app/README.md`](https://github.com/ddikman/verikun/blob/main/example/flutter-app/README.md).

## Where to go next

- [Platform support](/verikun/guides/platform-support/) — the full per-platform matrix
- [Troubleshooting](/verikun/guides/troubleshooting/#ios-and-idb) — idb-specific failures
- [Device state](/verikun/reference/device-state/) — how snapshot and restore work
- [Selectors](/verikun/reference/selectors/) — the complete grammar
