# verikun

Drive a connected Android device/emulator (and, later, iOS simulators) the way
Puppeteer drives a browser — **tap, type, swipe, screenshot**, and most
importantly **inspect the UI hierarchy by semantic identifiers** so an AI agent
can act and then *verify* what happened.

It is a thin, deterministic, zero-runtime-dependency wrapper over `adb` (and
`xcrun simctl` for iOS) that turns the raw `uiautomator` dump into a compact,
token-efficient list of meaningful elements addressable by `resource-id`,
visible text, accessibility label, or class.

```
$ vk ui
[0] TextView "Welcome back" (540,360)
[1] EditText @email_input (540,720) focused
[2] EditText @password_input (540,860) pwd
[3] Button "Sign in" @sign_in_btn (540,1020) tap
[4] TextView "Forgot password?" @forgot (540,1140) tap

$ vk tap @sign_in_btn
tapped [3] Button "Sign in" @sign_in_btn (540,1020) tap
```

## Install

Requires Node ≥ 18 and the Android platform-tools (`adb`) on your `PATH`.

```sh
npm install      # dev deps (typescript, @types/node) only
npm run build    # compile src/ -> dist/
npm link         # optional: put `verikun` and `vk` on your PATH
```

Without `npm link`, run it as `node dist/bin/verikun.js <command>`.

### Install as a Claude Code plugin

This repo doubles as a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Installing the plugin gives Claude the `verikun` skill — the agent-facing usage guide — so it knows how to drive devices.

```sh
/plugin marketplace add ddikman/verikun   # add this repo as a marketplace
/plugin install verikun@verikun           # install the plugin (ships the skill)
```

The plugin ships the **skill**; the `vk` **CLI** is a separate Node package — build and link it from a clone (see [Install](#install) above) so `vk` lands on your `PATH`. The compiled `dist/` is gitignored, so it isn't bundled into the installed plugin.

## Quick start

```sh
vk doctor --fix                 # check adb/device; disable animations for stable dumps
vk devices                      # list attached devices
vk ui                           # semantic snapshot of the current screen
vk tap @login_button            # tap by resource-id
vk text @email "me@example.com" # focus a field and type
vk wait text:"Welcome" --timeout 8000
vk screenshot                   # -> ./.verikun/screen.png
```

## Commands

### Inspect
| Command | Description |
|---|---|
| `ui [--all] [--tree] [--json]` | Compact list of interactive/labeled elements. `--all` keeps layout nodes; `--tree` indents by nesting; `--json` is structured. |
| `find <selector> [--json] [--wait <dur>\|--no-wait]` | Print elements matching a selector. [Auto-waits](#auto-wait) up to 5s; exit 1 if still none. |
| `assert <selector> [--text S] [--gone] [--contains] [--wait <dur>\|--no-wait]` | Assertion for tests. [Auto-waits](#auto-wait) until it passes. Exit 0 pass / 1 fail. |
| `wait <selector> [--timeout ms] [--interval ms] [--gone]` | Poll the hierarchy until match (or absence). Exit 1 on timeout. (Explicit polling — distinct from the `--wait` flag.) |
| `current` | Best-effort foreground app/activity. |
| `log [package] [-n lines] [--since t] [--out path] [--full] [--json]` | Recent device logs (Android `logcat` snapshot — Android only). Prints to stdout; `--out` saves to a file, `--json` is structured. **Inside a run, defaults to logs since the run started** (so pre-session logs are excluded); `-n` caps to the last N lines instead, `--since <MM-DD HH:MM:SS.mmm>` sets an explicit start, `--full` dumps everything. A `package` scopes logs to that app's process, **falling back to system-wide when the app isn't running** (e.g. it crashed) so the crash trace is still captured. Unlike other inspection commands it **is recorded**, so its output lands in the archived report. ⚠️ logs are raw device output and may contain anything the app logged, including secrets. |

### Act
| Command | Description |
|---|---|
| `tap <selector\|index>` / `tap --at x,y` | Tap an element (or raw coordinates). Selector taps [auto-wait](#auto-wait); a bare integer taps `[index]` from the latest `ui` (never waits). |
| `text <selector> <text…> [--clear] [--enter]` | Focus a field and type. `--clear` deletes existing text first. The field lookup [auto-waits](#auto-wait). Punctuation/symbols (e.g. emails like `bob@mail.com`) are escaped for the device shell and type verbatim — quote the value in your shell, or use [`batch`](#batch)/stdin (no host shell), so the caller's shell can't drop the `@`. |
| `type <text…> [--enter]` | Type into the currently focused field. |
| `key <name\|code>` / `back` / `home` / `enter` | Send a key event (named keys or a raw Android keycode). |
| `swipe <up\|down\|left\|right> [--on <selector>] [--distance f] [--duration ms]` | Directional swipe over the screen (or within an element via `--on`, whose lookup [auto-waits](#auto-wait)). `--distance` is a fraction of the region (default 0.6). |
| `swipe --from x,y --to x,y [--duration ms]` | Explicit swipe between two points. |
| `screenshot [--out path] [--more] [--max px] [--full] [--json]` | Save a PNG (default `./.verikun/screen.png`); prints the path. [Downscaled](#screenshots) to a 700px longest edge by default to save tokens; `--more` bumps detail, `--max px` sets an exact cap, `--full` keeps the original. |
| `launch <app> [--clear] [--no-restart]` / `stop <app>` | App lifecycle by package id (Android) / bundle id (iOS). `launch` **restarts by default** — it force-stops the app first (a no-op if it isn't running) so a rerun starts fresh instead of resurfacing a still-running instance's current screen; `--no-restart` skips that. `--clear` also wipes the app's local data (login/session, prefs, cache) for a fresh-install start. |
| `clear <app>` | Wipe the app's locally stored data — login/session, preferences, caches — resetting it to a just-installed state (Android `pm clear`, which also force-stops the app). iOS not supported yet. |

### Batch
| Command | Description |
|---|---|
| `batch [--file <path>] [--quiet]` | Run newline-separated commands — from `--file`, else piped **stdin** — each exactly as its own command (same auto-wait, recording, exit codes). Streams each result to stdout and **stops on the first non-zero exit**, propagating that code. Blank lines and `#` comments are skipped; `--quiet` hides per-line progress. See [Batch](#batch). |

### AI
| Command | Description |
|---|---|
| `ai <file> [--model m] [--max-cost-usd n] [--cost-override in/out] [--effort e] [--package pkg] [--app-build id] [--show-plan] [--recompile] [--json]` | Run a plain-English test: compile it to a deterministic plan once, replay it model-free, and self-heal failures via the model. Needs `ANTHROPIC_API_KEY`. See [AI](#ai--natural-language-tests). |

### Environment
| Command | Description |
|---|---|
| `devices [--json]` | List attached devices/simulators. |
| `doctor [--fix]` | Diagnose adb + device; `--fix` sets the three animation scales to 0 for deterministic UI. |

### Test runs
| Command | Description |
|---|---|
| `run start [name] [--force]` | Begin a named run. One auto-starts on the first action if you don't. |
| `run status` | Show the active run and its recorded steps. |
| `run archive [name]` | Write JUnit + HTML report to `./.verikun/runs/<id>/`; exits non-zero if any step failed. |
| `run clear` | Discard the active run without a report. |

## Test runs & reports

Actions are recorded into a **test run** — one auto-starts on the first action
(set `VERIKUN_NO_RUN=1` to disable). Every command becomes a step with its
timing, the selector + identifier it resolved through, and pass/fail; a failing
step also captures a screenshot **and** the UI hierarchy of the page. When a
step fails you can additionally run `vk log <package>` to pull the device logs —
that step records the logs **into the same run**, so the crash trace shows up in
the report alongside the failure.

`vk run archive` finalizes the run into `./.verikun/runs/<id>/`:

- **`report.xml`** — JUnit: one `<testcase>` per step with timings, `<failure>`
  for failed assertions, `<error>` for environment errors, and the resolved
  identifier in `<system-out>`. Drops straight into CI.
- **`report.html`** — a self-contained report: every step, the identifiers used,
  any screenshots taken, the screenshot + hierarchy of any failed page, and any
  device logs captured via `vk log`.
- **`run.json`** — the raw recording.

`vk run archive` exits non-zero when the run contained failures, so the same
command both produces the report and gates CI.

### Automatic rollover

So an implicit run never silently merges unrelated activity, the active run
**auto-closes (archives) and a fresh one starts** when the context changes:

| Trigger | Applies to | Tune with |
|---|---|---|
| Idle too long (default 30 min) | implicit runs only | `VERIKUN_RUN_IDLE_MIN` (minutes; `0` disables) |
| Different device serial | any run | — |
| Different session | any run | `VERIKUN_SESSION` (falls back to `TERM_SESSION_ID`) |

A run you named with `vk run start` is **sticky to idle** — only a hard context
change (device or session) rolls it over. Rollover always *archives* the old run
(never discards it) and prints the reason + destination to stderr. Set
`VERIKUN_NO_RUN=1` to disable recording entirely.

## Batch

Drive a whole flow from a single process instead of one `vk` call per step.
`vk batch` reads newline-separated commands — from `--file <path>`, or piped on
**stdin** — and runs each **exactly as if you'd typed it as its own `vk` command**:
the same [selector auto-wait](#auto-wait), the same
[test-run recording](#test-runs--reports) (every line is its own step), and the
same stdout/stderr split and [exit codes](#exit-codes).

```sh
vk batch --file login.flow            # from a file

vk batch <<'EOF'                      # …or piped on stdin
launch com.example.app
text @email_input "user@example.com"
text @password_input "hunter2" --enter
assert text:"Welcome back" --wait 8s
EOF
```

- **Each result streams to stdout** as the command finishes — the same bytes you'd
  get running the line on its own.
- **It stops at the first command that exits non-zero**, noting where it halted (on
  stderr) and **exiting with that command's code**. A failed `tap`/`assert` means
  the rest of the flow can no longer be trusted, so it breaks rather than press on.
- **Blank lines and `#` comments** are skipped, so a flow file can be annotated.
- **Globals on the `batch` call carry into every line** unless the line overrides
  them — `--device`, `--platform` / `--ios` / `--android`, and `--json`. So
  `vk batch --ios --file f` runs the whole flow against the simulator.
- `--quiet` silences the per-line progress notes on stderr; stdout data is untouched.

Because each line records like an individual action, ending a batch with
`run archive` turns the flow into a JUnit + HTML report in one shot:

```sh
printf 'launch com.example.app\nassert @home_tab\nrun archive smoke\n' | vk batch
```

## AI — natural-language tests

`vk ai <file>` runs a test written in plain English. It treats the model as a
**compiler, not a runtime**: it compiles the prose into a deterministic plan once
(paying tokens), caches that plan by the test text + app build, then **replays it
with no model calls on the happy path**. The model is woken only to *repair* a step
whose selector stops resolving; a green run persists the repaired plan, so the next
run is free again. That is what keeps a CI suite's steady-state token cost near zero.
Needs `ANTHROPIC_API_KEY`.

```sh
# onboarding.md (plain English):
#   Launch com.example.app fresh.
#   If a notifications permission dialog appears, allow it.
#   Tap "Get started", then assert the home tab is visible.

vk ai onboarding.md                       # first run: compile, then run
vk ai onboarding.md                       # cached: replays with no model call
vk ai onboarding.md --show-plan           # print the compiled plan, don't run
vk ai onboarding.md --max-cost-usd 0.50   # abort if the estimated spend crosses $0.50
```

The compiled plan supports **conditions** (`if-present`, for optional interstitials
like permission dialogs) and **bounded loops** (`repeat … until`, e.g. scroll until a
row appears) — control flow a flat [`batch`](#batch) script can't express. Loops carry
a hard iteration cap and stop early if the screen stops changing.

- **Progress streams to stderr** (so a CI job never goes silent); **stdout is the
  report path** (or a JSON summary with `--json`). The compiled plan is logged to the
  run before it executes, for troubleshooting.
- **Cost is shown and bounded.** Each run reports `compile / repairs / replay=$0 /
  est $…`; `--max-cost-usd` aborts the run when the estimate crosses the ceiling.
  `--cost-override <input/output>` overrides the bundled per-1M price table if it drifts.
- **`--model`** picks the model (`claude-haiku-4-5` · `claude-sonnet-4-6` (default) ·
  `claude-opus-4-8` · `claude-fable-5`); **`--recompile`** ignores the cache.
- An `ai` run records like any other flow, so it produces the same JUnit + HTML report —
  with the cost line and any **suggested test improvements** (workarounds the model
  applied, which you can fold back into the prose to stabilize the test and cut tokens).

## Selectors

```
@login          shorthand for id:login
id:login        resource-id — matches full id, idShort, or a "/login" suffix
text:Sign in    visible text (exact, case-insensitive, trimmed)
desc:Submit     content-desc / accessibility label
class:Button    simplified type ("Button") or full class ("android.widget.Button")
"Sign in"       a bare string is treated as text: (exact)
```

Modifiers: `--contains` makes text/desc matches substring-based; `--index N`
selects the Nth match (0-based) when a selector intentionally matches several.
If a selector for an action matches more than one element and no `--index` is
given, the command fails with exit code 2 and lists the candidates — it never
taps a guess.

## Auto-wait

A UI rarely settles the instant the previous action returns. So selector
commands — `tap`, `text`, `find`, `assert`, and `swipe --on` — **don't fail the
moment a lookup misses**: they re-capture the hierarchy and retry until it
resolves or a **5-second** window elapses. A straightforward flow can then skip
explicit `wait` calls (fewer round-trips, fewer tokens):

```sh
vk tap @next            # waits up to 5s for @next to appear, then taps
vk assert text:"Done"   # waits up to 5s for "Done" to show, then asserts
vk find @spinner --no-wait   # existence probe: answer now, don't wait
```

| Flag | Effect |
|---|---|
| *(none)* | Wait up to **5s** (the default) for the lookup to resolve. |
| `--wait <dur>` | Override the window: `8s`, `800ms`, or a bare number of ms (`3000`). `0` disables. |
| `--no-wait` | Fail immediately on the first miss (identical to `--wait 0`). |
| `--interval <ms>` | Poll cadence while waiting (default 300 ms). |

Two deliberate boundaries:

- **Ambiguity is never waited on.** If the lookup matches more than one element,
  they're already on screen — the command reports the candidates and exits 2 at
  once (waiting can't disambiguate). Add `--index N` or refine the selector.
- **`assert --gone` waits for *disappearance*** — it polls until the element is
  absent, so it subsumes "`wait --gone` then assert" in one call.

This is distinct from the `wait` **command**, which stays for explicit polling
(with its own `--timeout`/`--interval` and `--gone`) when you want to block on a
condition as a step in its own right.

## Global flags

| Flag | Meaning |
|---|---|
| `-d, --device <serial>` | Target a specific device (or `VERIKUN_DEVICE` / `ANDROID_SERIAL`). |
| `-p, --platform <android\|ios>` | Platform (default `android`). `--ios` / `--android` are shortcuts. |
| `-j, --json` | Machine-readable output (also serializes errors). |
| `--` | End flag parsing, so text/arguments may start with `-`. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success / found / assertion passed |
| `1` | not found / assertion failed / wait timeout |
| `2` | usage error or ambiguous selector (caller must refine) |
| `3` | environment error (adb/simctl missing, no/multiple devices, dump failed) |

Data goes to stdout; diagnostics/errors go to stderr.

## Screenshots

A device screenshot is large (~1080×2400), and an agent that reads it back as an
image pays for that pixel area in tokens — yet you seldom need much detail to see
what's on screen. So `vk screenshot` **downscales by default** to a **700px
longest edge**: UI text stays legible while the image shrinks ~12× in area (and
proportionally in tokens).

| Flag | Effect |
|---|---|
| *(none)* | Cap the longest edge at **700px** (never upscales). |
| `--more` | Bump to a higher-detail **1400px** cap when 700 reads too coarse. |
| `--max <px>` | Use an exact cap — e.g. `--max 500` to save even more. |
| `--full` | Write the original, full-resolution capture. |
| `VERIKUN_SHOT_MAX_EDGE` | Env var to change the default cap globally. |

Precedence: `--full` > `--max <px>` > `--more` > the default.

Resizing is a dependency-free, pure-Node PNG resample (box filter). PNGs it can't
safely resample (palette, 16-bit, interlaced) are written through untouched, so a
screenshot is never corrupted — only sometimes left full-size (noted on stderr).
Failure-evidence captures in test-run reports stay full-resolution for debugging.

## How it works

```
cli.ts ──> drivers/ ──> adb / xcrun        (platform I/O)
   │           └─ produces normalized Element[]
   ├─ ui/android-parse.ts   uiautomator XML -> Element[]
   ├─ ui/selector.ts        @id / text: / desc: / class: matching
   └─ ui/format.ts          compact / tree / json rendering
```

The `Driver` interface (`src/types.ts`) is the seam between platforms. The
selector, formatting, and command layers operate only on the normalized
`Element[]`, so they are entirely platform-agnostic.

- **Android** (`drivers/adb.ts`): `uiautomator dump` for the hierarchy,
  `screencap -p` for screenshots, `input tap/text/swipe/keyevent`, `wm size`.
- **iOS** (`drivers/simctl.ts`): `screenshot`, `launch`, `stop` work today via
  `xcrun simctl`. Full interaction and hierarchy inspection are planned via
  WebDriverAgent — see [iOS roadmap](#ios-roadmap) below.

Run artifacts (screenshots, dumps) are written under `./.verikun/` (gitignored).

## iOS roadmap

Today `vk --ios` supports **screenshots, launch, and stop** via `xcrun simctl`.
Tapping, swiping, typing, and `vk ui` hierarchy inspection are not yet wired up.

The planned backend is **[WebDriverAgent](https://github.com/appium/WebDriverAgent)**
(WDA) — an open-source XCTest HTTP server maintained by the Appium team. It
requires no Python and works on both simulators and physical devices. Once WDA
is running, `vk` will drive it over HTTP and the command layer stays unchanged.

**One-time setup (when this lands):**
1. Clone WebDriverAgent and open it in Xcode
2. Set your Apple developer signing team
3. Build & run on the target device or simulator
4. `vk --ios tap`, `vk --ios ui`, etc. will work automatically

Until then, running any unsupported iOS command prints an explanation and exits
with code 3.

## Using it from an AI agent

See [`.claude/skills/verikun/SKILL.md`](.claude/skills/verikun/SKILL.md) — the
companion skill that teaches the act → inspect → assert loop, selector grammar,
exit-code semantics, and gotchas.

### Example: full onboarding walkthrough

A Claude agent drove a multi-step Android onboarding flow end-to-end using only
`vk` commands — no coordinates, no hardcoded waits beyond `sleep 1` on
transitions.

```sh
# 1. See where we are
vk screenshot               # read PNG to confirm current screen

# 2. Welcome splash
vk tap @get_started_button_id

# 3. Intro/explainer screens — same button each time
vk tap @tap_to_continue_label_id
vk tap @tap_to_continue_label_id

# 4. Scrollable list — scroll until the item is visible, then tap
vk swipe up
vk tap @target_item_id

# 5. Transition screen after selection
vk tap @tap_to_continue_label_id

# 6. Option grid — inspect to find the right index, tap it
vk ui                        # [4] ImageView desc="My preferred option"
vk tap 4

# 7. Final screen before sign-up
vk tap @tap_to_continue_label_id
# → sign-up screen reached; onboarding complete
```

**Cost:** $0.45 · **Wall time:** ~4 min · **Model:** Claude Sonnet 4.6 with
prompt-cache hits (1 M cache-read tokens kept cost low on a long conversation).

## Development

```sh
npm run dev       # tsc --watch
npm run build     # one-off compile
npm test          # type-check + run the unit suite
npm run test:watch  # re-run the suite on change
```

Zero runtime dependencies; the only dev dependencies are `typescript` and
`@types/node`.

### Tests

Unit tests cover the platform-agnostic core (selector matching, the
`uiautomator` XML parser, formatting, the PNG downscaler, report rendering,
argument/duration parsing, and the device-shell escaper) and run on **Node's
built-in test runner** (`node:test`) — no test framework is added, in keeping
with the zero-runtime-dependency rule. They live in `tests/*.test.ts`, compile
via `tsconfig.test.json` into the gitignored `.test-build/`, and need no device.
Driver code that talks to `adb`/`xcrun` is verified end-to-end instead, by
running the built CLI against a real device (`vk doctor`, `vk ui`).
