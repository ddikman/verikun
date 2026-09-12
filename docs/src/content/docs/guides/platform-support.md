---
title: Platform support
description: Which commands and features work on Android and iOS, on physical hardware and on an emulator or simulator — and what each gap degrades to.
sidebar:
  order: 7
---

Android is the fullest surface. iOS reaches parity for the loop that matters — inspect, act,
assert — and where it cannot, it **says so**: a named error and an exit code, never a command
that quietly does nothing.

This page is the canonical matrix. Other pages link here rather than restating it.

## How to read the tables

| | Meaning |
|---|---|
| ✅ | Works. |
| ⚠️ | Works, with a caveat that changes how you write the test. |
| ⊘ | Accepted and exits `0`, but does nothing, or answers with a placeholder. The intent is already satisfied, or there is nothing to report. |
| ❌ | Refused with a named reason and a non-zero exit — `3` for an environment/capability gap, `2` for a usage error. Never a silent no-op. |

A ⊘ is only used where the intent is already true (a simulator never sleeps, so `stay-awake`
has nothing to do). Everything else refuses rather than reporting a success that did not happen.

The two Android columns differ on exactly one row: a phone and an emulator run the same code.
What varies on Android is the **device**, and three differences bite in practice:

- **OEM skins silently ignore `settings put` / `svc` / `cmd`.** Every device-state write is
  therefore [verified by reading it back](/verikun/reference/device-state/#every-write-is-verified-by-readback).
- **Effective font scale depends on the API level.** `font-scale=1.3` lands at `1.30` on
  API 31 and about `1.26` on API 34, which scales non-linearly. Assert that a scale grew and
  was restored, never that it equals a literal.
- **Some skins break individual commands.** Known cases are noted beside the command below.

## Commands

<table>
<thead>
<tr><th rowspan="2">Command</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><th colspan="5">Inspect</th></tr>
<tr><td><code>ui</code> / <code>dump</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--tree</code> renders flat</td><td>⚠️ <code>--tree</code> renders flat</td></tr>
<tr><td><code>find</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>assert</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>wait</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>current</code></td><td>✅</td><td>✅</td><td>⊘ always <code>(unknown)</code></td><td>⊘ always <code>(unknown)</code></td></tr>
<tr><td><code>log</code> / <code>logs</code></td><td>✅ <code>logcat</code></td><td>✅</td><td>✅ via <code>log show</code></td><td>❌ <code>3</code></td></tr>
<tr><th colspan="5">Act</th></tr>
<tr><td><code>tap</code> / <code>click</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>text</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--clear</code> unreliable</td><td>⚠️ <code>--clear</code> unreliable</td></tr>
<tr><td><code>type</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>key</code></td><td>✅</td><td>✅</td><td>⚠️ different key set</td><td>⚠️ different key set</td></tr>
<tr><td><code>back</code></td><td>✅</td><td>✅</td><td>❌ <code>2</code> — no hardware Back</td><td>❌ <code>2</code> — no hardware Back</td></tr>
<tr><td><code>home</code> / <code>enter</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>swipe</code> / <code>scroll</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--duration</code> ignored</td><td>⚠️ <code>--duration</code> ignored</td></tr>
<tr><td><code>screenshot</code> / <code>shot</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>launch</code> / <code>open</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--clear</code> exits <code>3</code></td><td>⚠️ <code>--clear</code> exits <code>3</code></td></tr>
<tr><td><code>stop</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>clear</code></td><td>✅ <code>pm clear</code></td><td>✅</td><td>❌ <code>3</code> — no per-app reset</td><td>❌ <code>3</code> — no per-app reset</td></tr>
<tr><td><code>install</code></td><td>✅ <code>.apk</code> — replaces a differently-signed build</td><td>✅ <code>.apk</code> — replaces a differently-signed build</td><td>⚠️ <code>.ipa</code> or <code>.app</code> — no replace</td><td>⚠️ <code>.ipa</code> or <code>.app</code> — no replace</td></tr>
<tr><th colspan="5">Device state</th></tr>
<tr><td><code>device set</code></td><td>✅ all eight keys</td><td>✅ all eight keys</td><td>⚠️ four of eight</td><td>❌ <code>3</code> — none</td></tr>
<tr><td><code>device get</code></td><td>✅</td><td>✅</td><td>⚠️ four of eight</td><td>⊘ <code>n/a</code> for every key</td></tr>
<tr><td><code>device reset</code></td><td>✅</td><td>✅</td><td>⚠️ restores what it could read</td><td>⊘ nothing was captured</td></tr>
<tr><td><code>device prep</code></td><td>⚠️ needs an explicit <code>--device</code></td><td>✅</td><td>⊘ every knob is a no-op or unsupported</td><td>⊘ same</td></tr>
<tr><td><code>device caps</code></td><td>✅</td><td>✅</td><td>✅</td><td>⚠️ reports the simulator table</td></tr>
<tr><td><code>device release</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><th colspan="5">Run a test</th></tr>
<tr><td><code>batch</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>ai</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--reset-app</code> force-stops only</td><td>⚠️ <code>--reset-app</code> force-stops only</td></tr>
<tr><td><code>suite</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--app</code> force-stops only</td><td>⚠️ <code>--app</code> force-stops only</td></tr>
<tr><td><code>suite --devices</code> / <code>--servers</code> <em>(parallel)</em></td><td>⚠️ <code>all</code> prefers emulators; name a serial to pool a phone</td><td>✅</td><td>⚠️ <code>all</code> prefers simulators; name a UDID to pool a phone</td><td>✅</td></tr>
<tr><td><code>server --devices</code> <em>(device pool)</em></td><td>⚠️ <code>all</code> prefers emulators; name a serial to pool a phone</td><td>✅</td><td>⚠️ <code>all</code> prefers simulators; name a UDID to pool a phone</td><td>✅</td></tr>
<tr><td><code>run</code> <em>(start/status/archive/clear)</em></td><td>✅</td><td>✅</td><td>✅</td><td>⚠️ archive carries no device log</td></tr>
<tr><th colspan="5">Environment</th></tr>
<tr><td><code>devices</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>devices start</code> / <code>stop</code> / <code>restart</code></td><td>❌ <code>2</code> — never power-cycled</td><td>✅ via <code>emulator</code> / <code>adb emu kill</code></td><td>✅ via <code>simctl</code></td><td>❌ <code>2</code> — never power-cycled</td></tr>
<tr><td><code>devices start|restart --wipe</code></td><td>❌ <code>2</code></td><td>✅ <code>-wipe-data</code></td><td>✅ <code>simctl erase</code></td><td>❌ <code>2</code></td></tr>
<tr><td><code>doctor</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--fix</code> is Android-only</td><td>⚠️ <code>--fix</code> is Android-only</td></tr>
<tr><td><code>companion</code></td><td>✅</td><td>✅</td><td>❌ Android-only</td><td>❌ Android-only</td></tr>
<tr><td><code>server</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>help</code> / <code>version</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
</tbody>
</table>

Notes on the rows that carry a caveat:

- **`--tree` renders flat on iOS.** `idb`'s accessibility list carries no nesting depth. `ui`
  and `find` are unaffected; only the indentation is lost.
- **`text --clear` is Android in practice.** It sizes the deletion from the element's `text`,
  and on iOS that is the accessibility *label*, not the field's contents, so the deletion is
  the wrong length. There is also no way to read back what was typed.
- **`key` covers a different set per platform.** Android-only: `back`, `menu`, `search`,
  `center`, `app_switch` / `recents`, `volume_up`, `volume_down`, `mute`. iOS-only: `lock`,
  `side_button`, `siri`, `apple_pay`. An unknown key exits `2` listing what is available.
  Reach the back control by label instead of by key: that is portable, and on Android it also
  avoids the soft keyboard swallowing the press.
- **`swipe --duration` is ignored on iOS.** `idb` paces a swipe in pixels per step, so
  verikun passes coordinates only. [Auto-scroll](/verikun/reference/auto-wait/#auto-scroll-into-view)
  still works; it cannot pace the gesture there.
- **`suite --app` does not reset app data on iOS.** It degrades to a force-stop, so a test
  that depends on starting logged-out does not hold there — see
  [Suites](/verikun/guides/suites/).
- **`install` replaces a differently-signed build on Android only.** Android refuses to update
  a package across signing keys, which is routine on a shared device. verikun removes the
  installed build and installs again, warning on stderr that its app data is gone; a same-key
  install keeps its data. On iOS the install simply fails.
- **A device pool is one platform.** `vk server --devices` serves one platform per server, and
  `vk suite --servers a,b` exits `2` when the servers report different ones. Run a suite on
  both platforms by running it twice — see
  [Suites](/verikun/guides/suites/#running-across-several-devices).
- **`doctor --fix` is Android-only** and an alias for `device prep`, so on a physical device it
  needs the serial named with `--device`. `vk doctor --ios` still checks the toolchain.
- **`device prep` needs an explicit `--device` on a physical phone.** Naming the serial is the
  opt-in. An emulator is auto-selected, as it is for `devices start|stop|restart`, which
  likewise never power-cycles a physical device. On Android 9 the `dnd` knob is not scriptable
  and prep fails on it ([#103](https://github.com/ddikman/verikun/issues/103)).
- **`companion` is Android-only** and exits `3` on iOS. It is on by default
  (`VERIKUN_COMPANION=0` opts out) and makes the hierarchy read roughly ten times faster; iOS
  reads are already fast. On HyperOS (Android 15) it currently fails to start and every read
  silently takes the slow path ([#87](https://github.com/ddikman/verikun/issues/87)). See
  [The Android companion](/verikun/guides/companion/).

## Selectors and state modifiers

<table>
<thead>
<tr><th rowspan="2">Modifier</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><td><code>--enabled</code> / <code>--not-enabled</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>--checked</code> / <code>--not-checked</code></td><td>✅</td><td>✅</td><td>✅ derived</td><td>✅ derived</td></tr>
<tr><td><code>--selected</code> / <code>--not-selected</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code></td><td>❌ <code>3</code></td></tr>
<tr><td><code>--focused</code> / <code>--not-focused</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code></td><td>❌ <code>3</code></td></tr>
</tbody>
</table>

`idb` reports no `selected` or `focused` state at all, so a filter on either could only ever
match nothing; verikun refuses it with exit `3` instead of burning the wait window and
reporting "no element matched". `checked` is derived from the element type and value.

Which **kind** of selector to reach for is the same on both platforms: `@id` first, `text:`
second, `desc:` never. See
[Selectors](/verikun/reference/selectors/#which-selector-to-reach-for) for what each kind
maps to per platform.

## Device settings

This is the canonical per-key matrix. [Device state](/verikun/reference/device-state/) covers
how the snapshot-and-restore works and what each value domain accepts.

<table>
<thead>
<tr><th rowspan="2">Key</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><td><code>animations</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code> — nothing disables UIKit animation</td><td>❌ <code>3</code></td></tr>
<tr><td><code>airplane</code></td><td>⚠️ refused over wireless adb</td><td>✅</td><td>❌ <code>3</code> — no radio</td><td>❌ <code>3</code></td></tr>
<tr><td><code>dark</code></td><td>✅</td><td>✅</td><td>✅</td><td>❌ <code>3</code></td></tr>
<tr><td><code>font-scale</code></td><td>✅</td><td>✅</td><td>⚠️ nearest Dynamic Type category</td><td>❌ <code>3</code></td></tr>
<tr><td><code>rotation</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code> — nothing rotates it</td><td>❌ <code>3</code></td></tr>
<tr><td><code>stay-awake</code></td><td>✅</td><td>✅</td><td>⊘ no-op — simulators do not sleep</td><td>❌ <code>3</code></td></tr>
<tr><td><code>screen-timeout</code></td><td>✅</td><td>✅</td><td>⊘ no-op — simulators do not sleep</td><td>❌ <code>3</code></td></tr>
<tr><td><code>dnd</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code> — Focus is not scriptable</td><td>❌ <code>3</code></td></tr>
<tr><td><code>doze</code></td><td>✅</td><td>✅</td><td>⊘ no-op — no Doze equivalent</td><td>❌ <code>3</code></td></tr>
</tbody>
</table>

- **A physical iOS device supports none of them.** `simctl` drives simulators only and `idb`
  covers interaction, not preferences. Each key refuses with the manual equivalent named, so
  `vk device prep` is Android-only in practice.
- **`vk device caps --ios` reports the simulator answer either way.** The capability table is
  static, so on a physical device `caps` says `dark` is supported and `set` exits `3`. Trust
  this page, or `set`, over `caps` there.
- **`font-scale` on iOS maps to the nearest Dynamic Type category.** The category applied is
  printed to stderr; `1.3` can land at an effective ratio near `1.35`.

An unsupported key exits `3` **before any device I/O**. For `vk ai` and `vk suite` it is
caught when the plan is validated, so a suite asking for `rotation` on iOS fails before the
first tap rather than half-way through a half-modified device.

## Behaviour and reporting

<table>
<thead>
<tr><th rowspan="2">Feature</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><td>Auto-wait on selectors</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Modal-barrier settle on reads</td><td>✅</td><td>✅</td><td>⊘ not needed</td><td>⊘ not needed</td></tr>
<tr><td>Auto-scroll into view</td><td>✅</td><td>✅</td><td>⚠️ orientation-blind</td><td>⚠️ orientation-blind</td></tr>
<tr><td><code>offscreen</code> marker</td><td>⚠️ rarely fires</td><td>⚠️ rarely fires</td><td>✅</td><td>✅</td></tr>
<tr><td>Screenshot downscaling</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>JUnit + HTML reports</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Device log in the archive</td><td>✅</td><td>✅</td><td>✅</td><td>❌ log capture refuses</td></tr>
<tr><td>Password redaction</td><td>✅</td><td>✅</td><td>❌ flag never set</td><td>❌ flag never set</td></tr>
<tr><td>Failure screenshot + hierarchy</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Failure screenshot over <code>--server</code></td><td>❌ hierarchy only</td><td>❌ hierarchy only</td><td>❌ hierarchy only</td><td>❌ hierarchy only</td></tr>
<tr><td>Device claims (auto-pick a free device)</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>vk server</code> failover — unreachable device</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>vk server</code> failover — device cannot serve an install</td><td>✅</td><td>✅</td><td>❌ probe only</td><td>❌ probe only</td></tr>
<tr><td><code>vk server</code> pool degrade / rejoin sweep</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>vk server</code> adb-server recycle</td><td>✅ macOS host only</td><td>✅ macOS host only</td><td>⊘ no adb</td><td>⊘ no adb</td></tr>
<tr><td><code>vk server --log-file</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
</tbody>
</table>

- **The adb-server recycle needs a macOS host.** A long-running adb server leaks USB handles
  until devices drop mid-run, and the server restarts it while idle. Detecting it reads the
  macOS kernel's guard-violation log, so on a Linux host the server never recycles and
  `vk doctor` stays quiet. iOS has no adb to recycle. See
  [Remote devices & CI](/verikun/guides/remote-devices-and-ci/#it-keeps-the-hosts-adb-server-healthy).
- **Failover on iOS moves only for an unreachable device.** Telling "this device cannot take
  the build" from "this build is broken" relies on `adb`'s `INSTALL_FAILED_*` vocabulary,
  which `idb` does not share, so a full simulator does not trigger a move: the install fails.
  See [When the bound device fails](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails).
- **Device claims are host-side and identical everywhere.** Over `--server` the claim is held
  by the server process on the host where the devices are. See
  [Device claims](/verikun/reference/device-claims/).
- **The modal-barrier settle is Android-only.** Its dumper skips a sheet's contents until they
  are on screen; iOS has them in the first read. See
  [Auto-wait](/verikun/reference/auto-wait/#a-modal-barrier-is-not-an-absence).
- **`offscreen` is mostly an iOS signal.** Android's dumper drops nodes it considers invisible
  and clips the rest to the display, so a fully off-screen element is usually not in the tree
  at all. Do not write an Android test that expects `offscreen` to fire.
- **Auto-scroll is orientation-blind on iOS.** `idb` gives no orientation signal, so the
  viewport is treated as a square of the longest edge: exact along the axis a list scrolls,
  permissive across it.
- **Password redaction does not fire on iOS.** Redaction keys off the element's `password`
  flag, and `idb` reports a Flutter `obscureText` field as plain text, so the typed value
  lands in the report unredacted
  ([#44](https://github.com/ddikman/verikun/issues/44)). Do not rely on redaction
  cross-platform — see [Reports & test runs](/verikun/reference/reports-and-test-runs/#secrets).

## Toolchain

| | Android | iOS |
|---|---|---|
| Required | `adb` (platform-tools) | `xcrun` **and** `idb` **and** `idb_companion` |
| Install | Android SDK platform-tools | `brew install idb-companion` + `pip install fb-idb` |
| Override the binary path | `ADB` | `IDB` |
| Extra for a physical device | USB debugging | Developer mode, plus a reachable `idb_companion` |
| Check it | `vk doctor` | `vk doctor --ios` |

`idb` is required to drive iOS **at all**, simulator or not. `simctl` covers screenshots,
launch, stop and logs on a simulator; the hierarchy and every interaction come from `idb`.
Full setup: [iOS setup](/verikun/guides/ios-setup/).

## Where these tables come from

The Android columns and the iOS **simulator** column are measured, by running the built CLI
against the repository's Flutter fixture app on real hardware and simulators. The iOS
**physical device** column is read from the source rather than measured, so treat it as
reliable for what is refused and
[report anything that disagrees](https://github.com/ddikman/verikun/issues). The measured
findings, with the hardware each was observed on, live in
[`example/flutter-app/README.md`](https://github.com/ddikman/verikun/blob/main/example/flutter-app/README.md).

## Where to go next

- [iOS setup](/verikun/guides/ios-setup/) — install idb and pick a target
- [Troubleshooting](/verikun/guides/troubleshooting/#ios-and-idb) — what a given iOS failure means
- [Device state](/verikun/reference/device-state/) — how snapshot and restore work
- [Selectors](/verikun/reference/selectors/) — the complete grammar
- [Exit codes](/verikun/reference/exit-codes/) — what each refusal returns
