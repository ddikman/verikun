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

- **`clear` is unsupported.** iOS has no per-app data reset. Exits `3` with an explanation.
  The manual equivalent is uninstall plus reinstall, but that removes the app too — which is
  why it is not done automatically. [`vk suite --app`](/verikun/guides/suites/) degrades to a
  force-stop here.
- **`current` returns `(unknown)`.** iOS exposes no reliable foreground-app query.
- **`swipe` duration is not honoured** — `idb` has no millisecond duration knob.
- **`log` capture is simulator-only.** For a physical device use Console.app or `idb log`
  directly.
- **`--tree` renders flat** — `idb`'s accessibility list carries no nesting depth.
- **`--selected` and `--focused` selectors exit `3`.** `idb` emits no such key at all — not
  merely unset, the key does not exist — so a filter that could only ever match nothing is
  refused rather than silently returning zero results. `--enabled` and `--checked` work on
  both platforms. See [Selectors](/verikun/reference/selectors/#state-modifiers).
- **`device set` is partial.** `dark` and `font-scale` work on a **simulator**;
  `stay-awake` is a no-op (simulators do not sleep); `airplane` and `rotation` are
  unsupported — neither `simctl ui` nor `idb ui` exposes a radio or an orientation. A
  physical device supports none of them. Run `vk device caps --ios` for the live matrix.

## Writing selectors that work on iOS

iOS accessibility ids are often unset, which changes the usual advice.

| selector | Android | iOS | portable? |
|---|---|---|---|
| `@id` | `resource-id` | `AXUniqueId` | **yes — always prefer this** |
| `text:` | visible text, falling back to `content-desc` | `AXLabel` / `title` / `AXValue` | yes |
| `desc:` | `content-desc` | `accessibilityHint` only | **no — Android in practice** |
| `class:` | widget class | element role | no |

Two traps worth knowing:

- **`desc:` does not fall back.** `text:` falls back to `desc` when no text matches, so
  `text:Submit` finds an element carrying only an accessibility label. The reverse is not
  true. On iOS an accessibility label arrives as `text`, so a `desc:` selector written
  against Android **silently stops matching** there.
- **`class:` is mostly useless on a cross-platform toolkit.** Flutter text inputs report as
  `android.widget.EditText` / `TextField`, but almost everything else is
  `android.view.View` — so `class:Button` cannot match a Flutter button regardless of what
  the widget is.

For a Flutter app, `@id` comes from `Semantics(identifier:)`; `Semantics(label:)` gives you
`desc` on Android but `text` on iOS.

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

- [Troubleshooting](/verikun/guides/troubleshooting/#ios-and-idb) — idb-specific failures
- [Device state](/verikun/reference/device-state/) — the full per-platform matrix
- [Selectors](/verikun/reference/selectors/) — the complete grammar
