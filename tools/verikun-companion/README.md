# verikun companion (Android)

A resident helper that **runs on the device**. It is Java compiled to dex, pushed to
`/data/local/tmp` and executed by the phone's own ART runtime; the host side is only a
socket through `adb forward`. Nothing is installed — no APK, no root, and the device's
package list is untouched.

Today it serves one thing — UI-hierarchy reads — because that is where the time goes.
Taps and typing are the obvious next tenants: each `adb shell input …` pays its own
(smaller, 60–160ms) process startup, and a "tap, then hand me the resulting screen"
round trip would collapse two of those into one.

**Status: prototype.** Built and measured on real hardware; not yet wired into `AdbDriver`.

`adb shell uiautomator dump` costs ~2.4s on a mid-range phone, and on a guard-heavy suite
that is the overwhelming majority of the runtime (issue #69). This is a ~200-line resident
process that answers the same question in **~10ms**, returning **byte-identical XML**.

## Measured, on a physical Samsung SM-A415F (Android 12, USB)

| | Stock `uiautomator dump` | Companion |
|---|--:|--:|
| One hierarchy read | **2400ms** | **11ms** (median of 10; min 8, max 27) |
| Cold start (push + forward + spawn + first answer) | — | **1.5s**, once |

Where the stock 2.4s goes, and why almost none of it survives:

| Stage | Cost | Why the companion does not pay it |
|---|--:|---|
| ART startup + loading `uiautomator.jar` | ~1.22s | Paid once, at daemon start |
| `waitForIdle(1000, 10000)` | ~1.00s | **A cold-connection artifact** — see below |
| connect + walk + serialise + transfer | ~0.15s | This is all that is left |

The idle wait is the surprise. AOSP's `DumpCommand` hardcodes
`uiAutomation.waitForIdle(1000, 10000)`, and it reads like a flat one-second sleep — but
it is not. It waits for the accessibility event stream to have been **quiet for 1000ms**,
and a *freshly connected* bridge has no history of quiet, so it must sit and observe one.
A warm bridge already knows the screen has been idle for ages and returns immediately.
Measured: `dump 1000` (full stock-parity idle window) on the companion costs the same
~10ms as `dump 0`. So the companion keeps the full idle semantics for free — this is not
a case of trading safety for speed.

Confirmation that the wait is real: a stock dump taken *during* a continuous swipe costs
**5.85s** against 2.33s on a static screen.

## How it runs

scrcpy's pattern — a jar pushed to `/data/local/tmp` and started with `app_process` as the
shell user. That matters for locked-down devices and for not perturbing the app under test.

```sh
adb push prebuilt/verikun-companion.jar /data/local/tmp/verikun-companion.jar
adb forward tcp:8299 localabstract:verikun-companion
adb shell "CLASSPATH=/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:/data/local/tmp/verikun-companion.jar \
  app_process / dev.verikun.companion.CompanionApp"
```

Protocol is line-in, bytes-out, one request per connection: `ping` (protocol version, for
detecting an instance left by an older verikun), `size`, `dump [idleMs]`, `release`,
`acquire`, `quit`. `dump` on a released companion is a loud error, never a silent
reconnect — quietly taking the connection back would SIGKILL whatever the host handed it to.

It borrows the platform's own `UiAutomationShellWrapper` and `AccessibilityNodeInfoDumper`
out of `/system/framework/uiautomator.jar` by reflection, rather than reimplementing them.
That is what makes the XML byte-identical instead of merely equivalent — no second
serialiser to keep in sync with `ui/android-parse.ts`.

## Build

```sh
./build.sh          # javac + d8 -> prebuilt/verikun-companion.jar (~4KB)
```

Needs an Android SDK (`ANDROID_HOME`, any recent platform + build-tools) and a JDK. No
Gradle: it is one source file with no dependencies beyond the platform.

## Things that will bite whoever integrates this

Measured, not speculative:

- **Only one `UiAutomation` may be connected per device, and the loser is killed.** While
  the companion holds its connection, `adb shell uiautomator dump` exits **137 (SIGKILL)**.
  So "fall back to the stock path" is **not** available as a live safety net the way
  `screenshotRaw()`'s is — the host has to get the companion off the connection first. The
  same applies to anything else wanting it: Appium, Layout Inspector, a second verikun.

  Falling back is still entirely possible, and `release` / `acquire` exist for exactly
  this. Measured end to end:

  | Situation | Does stock work? | What the host must do |
  |---|---|---|
  | Companion holding the connection | no — exit **137** | `release` first |
  | After `release` | **yes**, 2.36s | `acquire` when it wants the fast path back (1.05s) |
  | Companion killed or crashed | **yes**, 2.38s | nothing — binder death frees the connection |
  | Companion never started | yes | nothing — it never held anything |

  So one fallback read costs `release` + a stock dump + a later `acquire` ≈ **3.4s**, against
  2.4s if the companion had never existed. A ~1s penalty on the failure path, in exchange for
  ~10ms on every other read. `release` keeps the warm ART process, so recovering does not
  cost the 1.5s cold start — only the 1.05s reconnect (which is the cold-bridge idle wait
  again, and is itself the clearest confirmation of where the stock 2.4s goes).

- **A dead companion answers with silence, not a refused connection.** `adb forward` keeps
  the host port open regardless of whether anything is listening behind it, so a killed
  companion yields an **empty reply**, not `ECONNREFUSED`. A client that only handles
  connect-errors will hang or misread it — treat a short/empty response as "unavailable".
- **Only one process may calibrate at a time, and the lock cannot live on the host.**
  Calibration releases the UiAutomation connection to take a stock dump, so two processes
  doing it at once SIGKILL each other — five concurrent first reads measured as
  `[3,3,0,3,3]`. The claim is therefore granted by the companion's own single-threaded
  accept loop. The obvious alternative does not work: Android's toybox `mkdir` **succeeds on
  an existing directory**, so a `mkdir` mutex grants itself to every caller (verified: five
  concurrent attempts, five successes). A waiting process must also not acquire the
  connection while the holder has released it, or it kills the dump it is waiting for.

- **One instance per device.** The constraint above is per-device, so driving several phones
  at once is fine; the host just needs a serial → forwarded-port map, and the abstract
  socket name can stay fixed.
- **Which display size to clip to genuinely differs per device — do not hard-code it.**
  MEASURED on two devices, and they disagree:

  | Device | Vendor | Android | Stock dump clips to | Source |
  |---|---|---|---|---|
  | Samsung SM-A415F | Samsung | 12 | 1080x2184 | `getSize()` — app window |
  | Pixel 3a | Google | 12 | 1080x2176 | `getSize()` — app window |
  | Pixel 6 emulator | AOSP | 14 | 1080x2400 | `getRealSize()` — physical display |

  The split is by PLATFORM VERSION, not vendor, and it is in AOSP itself — `DumpCommand`
  reads `getSize()` on `android12-release` and `android13-release`, and `getRealSize()` from
  `android14-release` onward. So a Samsung and a Google device on Android 12 agree, and both
  differ from Android 14. A hard-coded choice is wrong on one side of that boundary whichever
  side you pick, and a pinned version table would only be right until the platform changes it
  again — which it has already done once. The gap ranges 44-254px, and getting it wrong does
  not fail loudly — it shifts every element near the bottom of the screen so a tap
  lands somewhere else while still reporting success. The first build of this hard-coded
  `getSize()` because that is what the only device to hand did; it would have mis-placed
  taps on the emulator. Hence the calibration handshake, which is not defensive
  over-engineering — it is the only thing that makes this safe on a device nobody has tried.

- **`getSize()`, not `getRealSize()`.** The dumper clips every node's bounds to the
  width/height it is handed, so these numbers decide the geometry verikun taps and scrolls
  against. On this device stock clips to **1080x2184** (the app window, `getSize()`) while
  `getRealSize()` reports **1080x2400** (physical, including status and navigation bars) —
  and AOSP's own `DumpCommand` reads `getRealSize()`. Getting this wrong silently shifts
  every element near the bottom of the screen; it is what stopped the first build being
  byte-identical. **This needs checking on more than one device** — n=1 today.
- **Holding a connection suppresses the user's accessibility services** unless
  `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` (API 24+) is passed. Accepted for now: a
  device under automated test is not running TalkBack.
- It self-terminates after 15 minutes idle, so a forgotten instance does not hold the
  connection all day. Any read starts a fresh one in ~1.5s.

## Not done yet

No TypeScript client, no lazy start, no per-device port allocation, no daemon-vs-stock
arbitration, no `vk doctor` integration, no tests, no version handshake enforcement. This
directory currently proves the number and nothing more.
