# verikun companion (Android)

A resident helper that **runs on the device**. It is Java compiled to dex, pushed to
`/data/local/tmp` and executed by the phone's own ART runtime; the host side is only a
socket through `adb forward`. Nothing is installed — no APK, no root, and the device's
package list is untouched.

It serves one thing — UI-hierarchy reads — because that is where the time goes: a stock
`adb shell uiautomator dump` costs ~2.4s per read, the companion ~10ms, returning
byte-identical XML. It is wired in and **on by default** (`VERIKUN_COMPANION=0` turns it
off); the host side is `src/companion/`, covered by `tests/companion-*.test.ts`. What it
costs, when it stands down, and how it calibrates: the
[companion guide](https://ddikman.github.io/verikun/guides/companion/).

## How it runs

scrcpy's pattern — a jar pushed to `/data/local/tmp` and started with `app_process` as the
shell user, so it works on locked-down devices and does not perturb the app under test.

```sh
adb push prebuilt/verikun-companion.jar /data/local/tmp/verikun-companion.jar
adb forward tcp:8299 localabstract:verikun-companion
adb shell "CLASSPATH=/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:/data/local/tmp/verikun-companion.jar \
  app_process / dev.verikun.companion.CompanionApp"
```

verikun itself starts it detached (`nohup … app_process … >/dev/null 2>&1 &`), so the shell
it was launched from can exit.

The protocol is line-in, bytes-out, one request per connection, version `2` on both sides
(`PROTOCOL_VERSION` here, `COMPANION_PROTOCOL` in `src/companion/protocol.ts`): `ping`,
`size`, `state`, `claim-calibration`, `calibrated [real|app]`, `release`, `acquire`,
`dump [idleMs] [real]`, `quit`. `dump` on a released companion is a loud error, never a
silent reconnect — quietly taking the connection back would SIGKILL whatever the host handed
it to.

It borrows the platform's own `UiAutomationShellWrapper` and `AccessibilityNodeInfoDumper`
out of `/system/framework/uiautomator.jar` by reflection, which is what makes the XML
byte-identical rather than merely equivalent — no second serialiser to keep in sync with
`ui/android-parse.ts`.

## Build

```sh
./build.sh          # javac + d8 -> prebuilt/verikun-companion.jar (~4KB)
```

Needs an Android SDK (`ANDROID_HOME`, any recent platform + build-tools) and a JDK. No
Gradle: it is one source file with no dependencies beyond the platform.

## Hazards (all measured)

- **Only one `UiAutomation` may be connected per device, and the loser is killed.** While
  the companion holds the connection a stock `uiautomator dump` exits 137. `release` /
  `acquire` exist for exactly this; a fallback read costs `release` + a stock dump + a later
  `acquire` (≈3.4s).
- **A dead companion answers with an empty reply, not `ECONNREFUSED`** — `adb forward` keeps
  the host port open regardless. Treat a short or empty response as "unavailable".
- **Only one process may calibrate at a time, and the lock cannot live on the host.** The
  claim is granted by the companion's own single-threaded accept loop, because Android's
  toybox `mkdir` succeeds on an existing directory and so cannot serve as a mutex.
- **One instance per device.** Several phones at once are fine with a serial → port map.
- **Which display size to clip to differs by Android version** (`getSize()` through 13,
  `getRealSize()` from 14), and getting it wrong shifts every element near the bottom of the
  screen without failing — hence the calibration handshake, never a hard-coded choice.
- Holding a connection suppresses the user's accessibility services (accepted: a device
  under test is not running TalkBack), and the companion exits after 15 minutes idle; any
  read restarts it — ~1.5s to start, about 2s before the first answer.
