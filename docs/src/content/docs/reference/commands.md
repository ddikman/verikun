---
title: Commands
description: Every verikun command and its flags, grouped by what it does.
sidebar:
  order: 1
---

`vk help` prints this same list from the CLI itself. Aliases are noted where they exist.

Not every command works everywhere — [Platform support](/verikun/guides/platform-support/) is
the matrix of what runs on Android and iOS, on physical hardware and on an emulator or
simulator.

## Inspect

The semantic hierarchy is the core feature. These commands never change the screen and never
scroll.

| Command | Description |
|---|---|
| `ui [--all] [--tree] [--json]` <br/>*alias:* `dump` | Compact list of interactive/labeled elements. `--all` keeps layout nodes; `--tree` indents by nesting; `--json` is structured. |
| `find <selector> [--json] [--wait <dur>\|--no-wait]` | Print elements matching a selector. [Auto-waits](/verikun/reference/auto-wait/) up to 5s; exit `1` if still none. |
| `assert <selector> [--text S] [--gone] [--contains] [--wait <dur>\|--no-wait]` | Assertion for tests. [Auto-waits](/verikun/reference/auto-wait/) until it passes. Exit `0` pass / `1` fail. |
| `wait <selector> [--timeout ms] [--interval ms] [--gone]` | Poll the hierarchy until match (or absence). Exit `1` on timeout. Explicit polling — distinct from the `--wait` *flag*. |
| `current` | Best-effort foreground app/activity. Returns `(unknown)` on iOS. |
| `log [package] [-n lines] [--since t] [--out path] [--full] [--json]` <br/>*alias:* `logs` | Recent device logs (Android `logcat` snapshot; simulator-only on iOS). See [below](#vk-log-in-detail). |

### `vk log` in detail

Prints to stdout; `--out` saves to a file, `--json` is structured.

**Inside a run it defaults to logs since the run started**, so pre-session logs are excluded.
`-n` caps to the last N lines instead, `--since <MM-DD HH:MM:SS.mmm>` sets an explicit start,
and `--full` dumps everything. Precedence: `--since` > `-n` > `--full` > session window >
last-N.

A `package` scopes logs to that app's process, **falling back to system-wide when the app is
not running** (for example because it crashed) so the crash trace is still captured.

Unlike other inspection commands it **is recorded**, so its output lands in the archived
report.

:::caution
Logs are raw device output and may contain anything the app logged, **including secrets**.
They are not redacted.
:::

## Act

| Command | Description |
|---|---|
| `tap <selector\|index>` / `tap --at x,y` <br/>*alias:* `click` | Tap an element (or raw coordinates). Selector taps [auto-wait](/verikun/reference/auto-wait/) and [auto-scroll](/verikun/reference/auto-wait/#auto-scroll-into-view); a bare integer taps `[index]` from the latest `ui` and **never waits**. |
| `text <selector> <text…> [--clear] [--enter]` | Focus a field and type. `--clear` deletes existing text first. The field lookup auto-waits. Punctuation and symbols are escaped for the device shell and type verbatim — [quote the value in your shell](/verikun/guides/troubleshooting/#my-email-address-arrives-truncated). |
| `type <text…> [--enter]` | Type into the currently focused field. |
| `key <name\|code>` / `back` / `home` / `enter` | Send a key event (named keys, or a raw Android keycode). |
| `swipe <up\|down\|left\|right> [--on <selector>] [--distance f] [--duration ms]` <br/>*alias:* `scroll` | Directional swipe over the screen, or within an element via `--on` (whose lookup auto-waits). `--distance` is a fraction of the region, default `0.6`. |
| `swipe --from x,y --to x,y [--duration ms]` | Explicit swipe between two points. |
| `screenshot [--out path] [--more] [--max px] [--full] [--json]` <br/>*alias:* `shot` | Save a PNG (default `./.verikun/screen.png`) and print the path. [Downscaled](/verikun/reference/screenshots/) to a 700px longest edge by default. |
| `launch <app> [--clear] [--no-restart]` <br/>*alias:* `open` | Start an app by package id (Android) or bundle id (iOS). **Restarts by default** — see below. |
| `stop <app>` | Force-stop the app. |
| `clear <app>` | Wipe the app's locally stored data — login/session, preferences, caches — resetting it to just-installed state (Android `pm clear`, which also force-stops). **iOS unsupported**: there is no per-app data reset. |
| `install <app.apk\|.ipa> [--server url]` | Install a build (`adb install -r` / `idb install`). With `--server`, the file is uploaded to a remote [`vk server`](/verikun/guides/remote-devices-and-ci/) started with `--allow-install` (single-file `.apk`/`.ipa`, sha256-verified). |

### Why `launch` restarts by default

Re-issuing a launch intent to an app that is already running just resurfaces its current —
often mid-flow, stale — screen rather than starting fresh. That is what made reruns flaky.

So `launch` force-stops first. Force-stop is a no-op when the app is not running, so no "is
it running?" probe is needed, and none would be portable (iOS has no foreground query).

- `--no-restart` opts out and brings the existing instance forward.
- `--clear` instead wipes data via `pm clear`, which already force-stops.

## Device state

Change the *device* the app runs on, then put it back. Full detail:
[Device state](/verikun/reference/device-state/).

| Command | Description |
|---|---|
| `device set <key>=<value> …` | Apply settings, snapshotting each original first. Keys: `airplane`, `dark`, `font-scale`, `rotation`, `stay-awake`. Every change is **verified by reading it back**. Refuses `airplane=on` over wireless adb; `--allow-wireless` overrides. |
| `device get [key] [--json]` <br/>*alias:* `device status` | Current values; `n/a` where the platform cannot answer. |
| `device reset [key …]` | Restore what this run changed. `batch`, `ai` and `suite` also do this automatically when the flow ends **or fails**. |
| `device caps [--json]` | What the active platform supports, and the manual equivalent where it does not. |
| `device release [serial] [--json]` | Hand a claimed device back to the pool. Claims expire on their own; this is for when you do not want to wait. Releases another job's claim too. See [Device claims](/verikun/reference/device-claims/). |

## Batch

| Command | Description |
|---|---|
| `batch [--file <path>] [--quiet]` | Run newline-separated commands — from `--file`, else piped **stdin** — each exactly as its own command (same auto-wait, recording, exit codes). Streams each result to stdout and **stops on the first non-zero exit**, propagating that code. Blank lines and `#` comments are skipped; `--quiet` hides per-line progress. See [Writing test cases](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch). |

## AI

| Command | Description |
|---|---|
| `ai <file> [--model m] [--max-cost-usd n] [--timeout dur] [--cost-override in/out] [--effort e] [--package pkg] [--app-build id] [--server url] [--show-plan] [--recompile] [--json]` | Run a plain-English test: compile to a deterministic plan once, replay model-free, self-heal failures via the model. Needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` per model, or no key with `--model codex-cli` / `cursor-cli`. See [Natural-language tests](/verikun/guides/natural-language-tests/). |
| `suite <dir> [--app <id>] [--name n] [--retries n] [--server url] [--json]` <br/>(+ all `ai` flags) | Run every `*.md` in `<dir>` as one sequential suite with an overview report and a non-zero exit on failure — the CI gate. See [Suites](/verikun/guides/suites/). |

### `ai` flags

| Flag | Default | Effect |
|---|---|---|
| `--model <m>` | `claude-sonnet-4-6` | Model **and** provider — see [Models](/verikun/reference/ai-plans/#models) |
| `--max-cost-usd <n>` | `3` | Abort the run if the cost estimate crosses this |
| `--timeout <dur>` | `15m` | Abort on wall clock |
| `--cost-override <in/out>` | — | Override the bundled per-1M price table if it drifts |
| `--effort <e>` | — | Reasoning effort, where the provider supports it |
| `--package <pkg>` | inferred | App id, used as part of the plan-cache key |
| `--app-build <id>` | — | Build identity; a change invalidates the cached plan |
| `--server <url>` | `VERIKUN_SERVER` | Run device I/O against a remote [`vk server`](/verikun/guides/remote-devices-and-ci/) |
| `--show-plan` | — | Print the compiled IR and exit without running |
| `--recompile` | — | Ignore the cache |

## Remote

| Command | Description |
|---|---|
| `server [--bind addr] [--port n] [--auth-key k] [--allow-install] [--allow-device-control[=names]] [--allow-unsafe-anonymous]` | Expose this machine's connected device to remote verikun clients (`ai` / `suite` / `install --server`). Auth is mandatory unless explicitly disabled; only verikun's validated command grammar is executable. Binds `127.0.0.1:8391` by default. See [Remote devices & CI](/verikun/guides/remote-devices-and-ci/). |

Clients pass `--server <url>` (or `VERIKUN_SERVER`) plus `--auth-key` (or
`VERIKUN_SERVER_AUTH_KEY`) to `ai`, `suite` and `install`. **The server's device and platform
apply** — no flag on an `exec` request can repoint them.

`--allow-device-control` is the one exception, and it is opt-in: it lets a client
`restart`/`stop` the server's *own* device, and `--allow-device-control=<names>` additionally
lets it `start` one of those operator-declared targets. The device lifecycle commands below all
accept `--server <url>` to act on a remote server's device.

## Environment

| Command | Description |
|---|---|
| `devices [--all] [--json]` | List attached devices and simulators. Probes both backends. A `USED BY` column appears when another job holds one — see [Device claims](/verikun/reference/device-claims/). `--all` also lists **startable** (not-yet-booted) AVDs and simulators. |
| `devices start <name> [--wipe] [--timeout dur] [--no-wait]` | Boot an Android AVD or iOS simulator, waiting until it is genuinely drivable; prints the resolved serial on stdout. Already running = a no-op. |
| `devices stop <name\|serial>` | Shut a running emulator or simulator down. |
| `devices restart <name> [--wipe]` | Stop then boot — the fix for a wedged or flaky device. |
| `doctor [--fix]` | Diagnose adb + device, and report the CLI/plugin versions. `--fix` sets the three animation scales to `0` for deterministic UI. `--ios` checks the idb toolchain. Version staleness is reported as a **warning** and does not affect the exit code — only a genuinely unusable setup gives `3`. |
| `companion <status\|stop> [--json]` | Inspect or stop the on-device hierarchy reader (Android only). `stop` hands back the device's single `UiAutomation` connection so Appium or Layout Inspector can use it. See [Companion](/verikun/guides/companion/). |

`vk devices stop` powers a **device** off; `vk stop <appId>` force-stops an **app**, and
`vk device set` (singular) changes settings on the device you are driving.

Physical devices are never power-cycled — `start`/`stop`/`restart` refuse them with exit 2.
An ambiguous name is exit 2 with the candidates listed: simulator names repeat across iOS
runtimes, so `iPhone 17 Pro` genuinely identifies two devices and you pass the UDID instead.
A boot that times out is exit **1** (retryable — the device is left running); a missing
toolchain is exit **3**. Set `VERIKUN_EMULATOR` if the SDK's `emulator` binary is not on
`PATH` or under `$ANDROID_HOME`.

`--wipe` (`emulator -wipe-data` / `simctl erase`) is the only destructive path: `start` and
`restart` only, never a physical device, and never against an already-running target — use
`restart --wipe`, whose name says it tears the device down.

## Test runs

Actions are recorded automatically; a run auto-starts on the first action. Full detail:
[Reports & test runs](/verikun/reference/reports-and-test-runs/).

| Command | Description |
|---|---|
| `run start [name] [--force]` | Begin a named run. One auto-starts on the first action if you do not. Refuses to clobber a non-empty active run without `--force`. |
| `run status` | Show the active run, its device and session, and its recorded steps. This is the default when `run` is given no subcommand. |
| `run archive [name] [--no-logs]` <br/>*aliases:* `finish`, `save` | Write JUnit + HTML report to `./.verikun/runs/<id>/`. **Exits non-zero if any step failed.** Captures `artifacts/logcat.txt` by default. |
| `run clear` <br/>*aliases:* `stop`, `discard` | Discard the active run without a report. |

## Meta

| Command | Description |
|---|---|
| `help` / `--help` | Print usage. Exit `0`. |
| `version` / `--version` | Print the version. Exit `0`. |

An unrecognised command exits **`2`**.
