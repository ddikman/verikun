---
title: Platform support
description: Which commands and features work on Android and iOS, on physical hardware and on an emulator or simulator — and what each gap degrades to.
sidebar:
  order: 7
---

Android is the fullest surface. iOS reaches parity for the loop that matters — inspect, act,
assert — and where it cannot, it **says so** rather than half-implementing: a named error and
an exit code, never a command that quietly does nothing.

This page is the canonical matrix. Every other page links here rather than restating it.

## How to read the tables

| | Meaning |
|---|---|
| ✅ | Works. |
| ⚠️ | Works, with a caveat that changes how you write the test. |
| ⊘ | Accepted and exits `0`, but does nothing, or answers with a placeholder. The intent is already satisfied, or there is nothing to report. |
| ❌ | Refused with a named reason and a non-zero exit — `3` for an environment/capability gap, `2` for a usage error. Never a silent no-op. |

The distinction between ⊘ and ❌ is deliberate. A no-op is only honest when the intent is
*already true* (a simulator never sleeps, so `stay-awake` has nothing to do). Everything else
refuses, because a testing tool reporting success for something that did not happen is the
worst failure mode it has.

## The two axes are not symmetric

Before reading the matrix, know why two of its columns are near-identical:

- **Android has no physical-vs-emulator branch.** The only place verikun looks at the *shape*
  of an Android serial is to classify the transport as `usb`, `tcp` or `emulator`, and the
  only consumer of that is the refusal to enable airplane mode over wireless adb. Every other
  command is the same code path on a phone and on an emulator. The two Android columns below
  differ on exactly **one row**.
- **iOS branches in six places** — screenshots, launch, stop, logs, the device clock, and
  device settings. Everything else (hierarchy, tap, swipe, typing, keys, install) runs one path
  on both.

So Android variation is *device* variation rather than emulator-ness, and it does not fit in a
column. The three that bite in practice:

- **OEM skins silently ignore `settings put` / `svc` / `cmd`.** This is why every device-state
  write is [verified by reading it back](/verikun/reference/device-state/#every-write-is-verified-by-readback)
  instead of trusting the exit code.
- **`monkey -c LAUNCHER` hangs indefinitely on some skins** (MIUI/HyperOS), which is why
  `launch` resolves the activity and uses `am start` instead.
- **Effective font scale depends on the API level, not the hardware.** `font-scale=1.3` lands
  at `1.30` on API 31 and about `1.26` on API 34, which applies non-linear scaling. Assert that
  a scale grew and was restored, never that it equals a literal.

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
<tr><td><code>install</code></td><td>✅ <code>.apk</code></td><td>✅ <code>.apk</code></td><td>✅ <code>.ipa</code> or <code>.app</code></td><td>✅ <code>.ipa</code> or <code>.app</code></td></tr>
<tr><th colspan="5">Device state</th></tr>
<tr><td><code>device set</code></td><td>✅ all five keys</td><td>✅ all five keys</td><td>⚠️ two of five</td><td>❌ <code>3</code> — none</td></tr>
<tr><td><code>device get</code></td><td>✅</td><td>✅</td><td>⚠️ two of five</td><td>⊘ <code>n/a</code> for every key</td></tr>
<tr><td><code>device reset</code></td><td>✅</td><td>✅</td><td>⚠️ restores what it could read</td><td>⊘ nothing was captured</td></tr>
<tr><td><code>device caps</code></td><td>✅</td><td>✅</td><td>✅</td><td>⚠️ reports the simulator table</td></tr>
<tr><td><code>device release</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><th colspan="5">Run a test</th></tr>
<tr><td><code>batch</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>ai</code></td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td><code>suite</code></td><td>✅</td><td>✅</td><td>⚠️ <code>--app</code> force-stops only</td><td>⚠️ <code>--app</code> force-stops only</td></tr>
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

- **`--tree` renders flat on iOS.** `idb`'s accessibility list carries no nesting depth, so
  every element reports depth zero. `ui` and `find` are unaffected — only the indentation is
  lost.
- **`text --clear` is Android in practice.** It sizes the deletion from the resolved element's
  `text`, and on iOS an element's `text` is its accessibility *label*, not its contents. A
  field labelled "Username" holding `someone@example.com` reports `text="Username"`, so the
  deletion is the wrong length. There is also no way to read back what was typed.
- **`key` covers a different set per platform.** Android-only: `back`, `menu`, `search`,
  `center`, `app_switch` / `recents`, `volume_up`, `volume_down`, `mute`. iOS-only: `lock`,
  `side_button`, `siri`, `apple_pay`. An unknown key exits `2` listing what is available.
  Reach the back control by label instead of by key — that is portable, and on Android it also
  avoids the soft keyboard swallowing the press.
- **`swipe --duration` is ignored on iOS.** `idb` paces a swipe by pixels-per-step rather than
  milliseconds, and the flag that sets it varies by idb version, so verikun passes coordinates
  only. [Auto-scroll](/verikun/reference/auto-wait/#auto-scroll-into-view) still works; it just
  cannot pace the gesture on iOS.
- **`suite --app` does not reset app data on iOS.** It degrades to a force-stop. If your test
  depends on starting logged-out, that assumption does not hold there — see
  [Suites](/verikun/guides/suites/).
- **`doctor --fix` is Android-only.** It zeroes the three animation scales; iOS has no
  equivalent knob. `vk doctor --ios` still checks the toolchain.
- **`companion` is Android-only**, and exits `3` on iOS. It is **on by default**
  (`VERIKUN_COMPANION=0` opts out). It speeds up the UI-hierarchy read,
  which on Android costs ~2.4s per call because `uiautomator dump` starts a fresh VM every
  time. iOS has no equivalent problem: `idb` already keeps a companion process alive and
  reads in ~0.2s, so there is nothing to win. See the companion guide.

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

`selected` and `focused` are not merely unset on iOS — `idb ui describe-all` has **no such key
in its schema at all**. There are no accessibility traits to carry them and nothing to derive
them from, so no app can supply them. A filter that could only ever match zero elements would
burn the full auto-wait window and then report "no element matched", which is an untrue claim
about the screen and precisely the false signal these modifiers were added to prevent. So they
refuse instead. `checked` *is* derivable, from the element type plus its value, which is why it
survives.

Which **kind** of selector to reach for is a separate question, and the answer is the same on
both platforms: `@id` first, `text:` second, `desc:` never. See
[Selectors](/verikun/reference/selectors/#which-selector-to-reach-for) for why, and for what
each kind maps to per platform.

## Device settings

This is the canonical per-key matrix. [Device state](/verikun/reference/device-state/) covers
how the snapshot-and-restore works and what each value domain accepts.

<table>
<thead>
<tr><th rowspan="2">Key</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><td><code>airplane</code></td><td>⚠️ refused over wireless adb</td><td>✅</td><td>❌ <code>3</code> — no radio</td><td>❌ <code>3</code></td></tr>
<tr><td><code>dark</code></td><td>✅</td><td>✅</td><td>✅</td><td>❌ <code>3</code></td></tr>
<tr><td><code>font-scale</code></td><td>✅</td><td>✅</td><td>⚠️ nearest Dynamic Type category</td><td>❌ <code>3</code></td></tr>
<tr><td><code>rotation</code></td><td>✅</td><td>✅</td><td>❌ <code>3</code> — nothing rotates it</td><td>❌ <code>3</code></td></tr>
<tr><td><code>stay-awake</code></td><td>✅</td><td>✅</td><td>⊘ no-op — simulators do not sleep</td><td>❌ <code>3</code></td></tr>
</tbody>
</table>

Three things this table says that nothing else did:

- **A physical iOS device supports none of the five.** `simctl` drives simulators only, and
  `idb` covers interaction rather than preferences, so there is no scriptable settings surface
  at all. Each key refuses with the manual equivalent named.
- **`vk device caps --ios` reports the *simulator* answer either way.** The capability table is
  static and describes a simulator; only the driver knows what it resolved. So on a physical
  device `caps` will say `dark` is supported and `set` will exit `3`. Trust this page, or trust
  `set`, over `caps` there.
- **`stay-awake` is a no-op on a simulator but a refusal on a device.** The no-op is honest —
  a simulator never sleeps, so the intent already holds. A physical device has no way to
  satisfy it, so it refuses rather than pretending.

`font-scale` on iOS maps to the nearest named Dynamic Type category, because iOS has named
sizes where Android has a float. The category actually applied is printed to stderr, so the
mapping is never silent — but it does mean `1.3` can land at an effective ratio near `1.35`.

An unsupported key exits `3` **before any device I/O**, and for `vk ai` and `vk suite` it is
caught at plan-validation time. A suite asking for `rotation` on iOS therefore fails before the
first tap rather than half-way through a half-modified device.

## Behaviour and reporting

<table>
<thead>
<tr><th rowspan="2">Feature</th><th colspan="2">Android</th><th colspan="2">iOS</th></tr>
<tr><th>Physical</th><th>Emulator</th><th>Simulator</th><th>Physical</th></tr>
</thead>
<tbody>
<tr><td>Auto-wait on selectors</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Auto-scroll into view</td><td>✅</td><td>✅</td><td>⚠️ orientation-blind</td><td>⚠️ orientation-blind</td></tr>
<tr><td><code>offscreen</code> marker</td><td>⚠️ rarely fires</td><td>⚠️ rarely fires</td><td>✅</td><td>✅</td></tr>
<tr><td>Screenshot downscaling</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>JUnit + HTML reports</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Device log in the archive</td><td>✅</td><td>✅</td><td>✅</td><td>❌ log capture refuses</td></tr>
<tr><td>Password redaction</td><td>✅</td><td>✅</td><td>❌ flag never set</td><td>❌ flag never set</td></tr>
<tr><td>Failure screenshot + hierarchy</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
<tr><td>Failure screenshot over <code>--server</code></td><td>❌ hierarchy only</td><td>❌ hierarchy only</td><td>❌ hierarchy only</td><td>❌ hierarchy only</td></tr>
<tr><td>Device claims (auto-pick a free device)</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>
</tbody>
</table>

- **Device claims are host-side, so they behave identically everywhere.** They coordinate
  which *job* drives which device, and never touch the device itself — the four ✅ above are
  literal, not approximate. The one asymmetry is remote: over `--server` the claim is held by
  the server process on the host where the devices are. See
  [Device claims](/verikun/reference/device-claims/).
- **`offscreen` is mostly an iOS signal.** Android's dumper drops nodes it considers invisible
  and clips the rest to the display, so a fully off-screen element is usually not in the tree
  at all. Do not write an Android test that expects `offscreen` to fire — its real failure
  shape there is an element that *is* on screen but covered, or clipped to a sliver.
- **Auto-scroll is orientation-blind on iOS.** `idb` gives no orientation signal, so the
  viewport is treated as a square of the longest edge: exact along the axis a list scrolls,
  permissive across it. Deliberately permissive — refusing to act on a reachable element would
  be worse than a missed warning.
- **Password redaction does not fire on iOS.** Redaction keys off the resolved element's
  `password` flag, which comes from a secure-text element type. A Flutter field with
  `obscureText: true` is reported by `idb` as a plain text field, so nothing marks it as
  secret and the typed value is **not** redacted from the report. Do not rely on redaction
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
launch, stop and logs on a simulator, but the hierarchy and every interaction come from `idb`.
Full setup: [iOS setup](/verikun/guides/ios-setup/).

## What is measured, and what is asserted

The Android columns and the iOS **simulator** column are measured. The repository ships a
Flutter fixture app with controlled accessibility semantics, and its device suite runs the
built CLI against real hardware — a Pixel 3a (API 32), a Samsung SM-A415F (API 31), a Pixel 6
emulator (API 34) and an iPhone 17 Pro simulator (iOS 26.5).

The iOS **physical device** column is asserted from the source, not measured. The fixture
cannot be installed on one — that needs code signing, which is out of scope for the test suite
— so no physical iPhone has been exercised end to end here. The entries are read off the six
places the driver branches on simulator-versus-device, and they are the behaviour verikun
*intends*. Treat them as reliable for what is refused, and report anything that disagrees.

The measured findings, each with the hardware it was observed on, live in
[`example/flutter-app/README.md`](https://github.com/ddikman/verikun/blob/main/example/flutter-app/README.md).

## Where to go next

- [iOS setup](/verikun/guides/ios-setup/) — install idb and pick a target
- [Troubleshooting](/verikun/guides/troubleshooting/#ios-and-idb) — what a given iOS failure means
- [Device state](/verikun/reference/device-state/) — how snapshot and restore work
- [Selectors](/verikun/reference/selectors/) — the complete grammar
- [Exit codes](/verikun/reference/exit-codes/) — what each refusal returns
