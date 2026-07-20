# verikun

> **Agent-driven, natural-language mobile tests — during agent development or in CI.** Self-healing and self-improving, with cost caps and test reports.

- **Agent CLI** — `vk <command>`: one-shot commands to inspect the screen as a semantic tree (or screenshot) and act on it.
- **Puppeteer for native mobile** — a thin wrapper over native Android and iOS automation runners with zero runtime dependencies.
- **Natural-language tests** — `vk ai <file>`: runs plain-English tests, compiled once and replayed model-free (~$0), calling a model only to self-heal a drifted step.
- **Self-improving** — the agent runner will provide prescriptive improvements to existing scripts to help stabilise flakiness for future runs.
- **CI-ready** — `vk suite` runs a folder of tests as one gated pass/fail run; `vk server` exposes a real device over an authenticated tunnel so a disposable CI runner (no phone attached) can still drive it.

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

## Skill/plugin instead of MCP

verikun ships as a skill and plugin, not an MCP server, and that is deliberate. A skill lets us **guide the agent on how to use verikun** — when to inspect the hierarchy, what to assert, which command fits the step, and how to read the result back. That domain knowledge travels with the tool, so the agent drives the device *well*, not just correctly.

There is also no need for an MCP here: verikun runs locally with all its dependencies, and the agent calls it through the plain `vk` CLI — no shared session, data, or authentication to broker.

## Install

Requires Node ≥ 18 and the Android platform-tools (`adb`) on your `PATH`.

```sh
npm install -g verikun    # installs the `verikun` and `vk` commands globally
```

Then run `vk doctor` to check your setup. Re-run the same command to upgrade later.

### Install as a Claude Code plugin

This repo doubles as a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Installing the plugin gives Claude the `verikun` skill — the agent-facing usage guide — so it knows how to drive devices.

```sh
/plugin marketplace add ddikman/verikun   # add this repo as a marketplace
/plugin install verikun@verikun           # install the plugin (ships the skill)
```

The plugin ships the **skill**; the `vk` **CLI** is a separate Node package — install it with `npm install -g verikun` (see [Install](#install) above) so `vk` lands on your `PATH`. The compiled `dist/` is gitignored, so it isn't bundled into the installed plugin.

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
| `clear <app>` | Wipe the app's locally stored data — login/session, preferences, caches — resetting it to a just-installed state (Android `pm clear`, which also force-stops the app). iOS unsupported: there is no per-app data reset. |
| `install <app.apk\|.ipa> [--server url]` | Install a build on the device (`adb install -r` / `idb install`). With `--server`, the file is uploaded to a remote [`vk server`](#remote-devices--vk-server) started with `--allow-install` (single-file `.apk`/`.ipa`, sha256-verified). |

### Batch
| Command | Description |
|---|---|
| `batch [--file <path>] [--quiet]` | Run newline-separated commands — from `--file`, else piped **stdin** — each exactly as its own command (same auto-wait, recording, exit codes). Streams each result to stdout and **stops on the first non-zero exit**, propagating that code. Blank lines and `#` comments are skipped; `--quiet` hides per-line progress. See [Batch](#batch). |

### AI
| Command | Description |
|---|---|
| `ai <file> [--model m] [--max-cost-usd n] [--timeout dur] [--cost-override in/out] [--effort e] [--package pkg] [--app-build id] [--server url] [--show-plan] [--recompile] [--json]` | Run a plain-English test: compile it to a deterministic plan once, replay it model-free, and self-heal failures via the model. Needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (per model), or no key with `--model codex-cli` (a logged-in `codex` CLI). See [AI](#ai--natural-language-tests). |
| `suite <dir> [--app <id>] [--name n] [--server url] [--json]` (+ all `ai` flags) | Run every `*.md` in `<dir>` as one sequential suite with an overview report and a non-zero exit on failure — the CI gate. See [Suites](#suites--run-a-directory-of-tests). |

### Remote
| Command | Description |
|---|---|
| `server [--bind addr] [--port n] [--auth-key k] [--allow-install] [--allow-unsafe-anonymous]` | Expose this machine's connected device to remote verikun clients (`ai`/`suite`/`install --server`). Auth is mandatory unless explicitly disabled; only verikun's validated command grammar is executable. See [Remote devices](#remote-devices--vk-server). |

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
Needs `ANTHROPIC_API_KEY` (Claude models) or `OPENAI_API_KEY` (OpenAI models) — or **no
key** with `--model codex-cli`, which drives an already-logged-in `codex` CLI off your
ChatGPT subscription (`codex login` once; verikun just needs the binary on PATH).

```sh
# onboarding.md (plain English):
#   Launch com.example.app fresh.
#   If a notifications permission dialog appears, allow it.
#   Tap "Get started", then assert the home tab is visible.

vk ai onboarding.md                       # first run: compile, then run
vk ai onboarding.md                       # cached: replays with no model call
vk ai onboarding.md --show-plan           # print the compiled plan, don't run
vk ai onboarding.md --max-cost-usd 0.50   # tighten the spend cap (default $3)
vk ai onboarding.md --timeout 5m          # tighten the run timeout (default 15m)
```

The compiled plan supports **conditions** (`if-present`, for optional interstitials
like permission dialogs) and **bounded loops** (`repeat … until`, e.g. scroll until a
row appears) — control flow a flat [`batch`](#batch) script can't express. Loops carry
a hard iteration cap and stop early if the screen stops changing.

- **Progress streams to stderr** (so a CI job never goes silent); **stdout is the
  report path** (or a JSON summary with `--json`). The compiled plan is logged to the
  run before it executes, for troubleshooting.
- **Cost and time are bounded by default.** Each run reports `compile / repairs /
  replay=$0 / est $…` and aborts if the estimate crosses **`--max-cost-usd` (default
  $3)** or the wall-clock passes **`--timeout` (default 15m)** — so a runaway loop or
  repair can't spend or hang without limit. `--cost-override <input/output>` overrides
  the bundled per-1M price table if it drifts.
- **`--model`** picks the model and its provider — Anthropic (`claude-haiku-4-5` ·
  `claude-sonnet-4-6` (default) · `claude-opus-4-8` · `claude-fable-5`), OpenAI
  (`gpt-5.4-mini` · `gpt-5.4` · `gpt-5.5`), each read from its own key
  (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), or the CLI backend **`codex-cli`** (no key —
  the logged-in `codex` binary; spend is on your subscription, so its cost line is `$0` and
  `--max-cost-usd` / `--cost-override` are no-ops); **`--recompile`** ignores the cache.
- An `ai` run records like any other flow, so it produces the same JUnit + HTML report —
  with the cost line and any **suggested test improvements** (workarounds the model
  applied, which you can fold back into the prose to stabilize the test and cut tokens).
- **Review screenshots are inserted automatically.** The compiler adds `screenshot` steps
  around transitions and inside loops, so the report carries a before/after visual trail
  for post-run review. They are dumped for humans, never read back by the model (no token
  cost on replay), and never gate the test — a capture that hiccups is logged and skipped,
  not a failure.

## Suites — run a directory of tests

`vk suite <dir>` runs every `*.md` in a directory through the [`vk ai`](#ai--natural-language-tests)
engine, sequentially, against one shared device (local or [remote](#remote-devices--vk-server)):

```sh
vk suite tests/ --app com.example.app          # local device
vk suite tests/ --app com.example.app --server "$VERIKUN_SERVER"   # remote device
```

- **Ordering is lexicographic** — prefix files `01-…`, `02-…` to sequence them.
  `README.md` is skipped (it documents the suite, it isn't a test).
- **Isolation between tests:** with `--app <id>`, the app's data is cleared before
  each test (`pm clear`; iOS degrades to a force-stop since it has no per-app
  reset). Without `--app`, make each test self-isolating (start with
  `launch <pkg> --clear` in the prose).
- **Each test is a full `vk ai` run** — plan cache, self-healing, cost budget, and
  its own archived JUnit + HTML report under `./.verikun/runs/<id>/`. A test that
  fails (or errors) doesn't stop the suite; the rest still run.
- **The suite writes an overview** to `./.verikun/suites/<id>/`:
  - **`index.json`** — a stable, `schemaVersion`ed manifest: per-test pass/fail,
    steps, model repairs, cost, duration, and the run id, plus suite totals. This
    is the **output contract for reporting** — upload/publish steps compose over
    it (see the [CI recipe](#ci-recipe)) instead of verikun growing upload plugins.
  - **`index.html`** — a summary page linking every test's `report.html`.
- **Exit code is the CI gate:** `1` if any test failed, `0` all green, `2` bad/empty
  directory. All `ai` flags (`--model`, `--max-cost-usd`, `--timeout`, …) apply to
  every test; the provider (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or the `codex` CLI for
  `--model codex-cli`) is checked up front.

## Remote devices — `vk server`

CI runners don't have your phone plugged into them. `vk server` exposes a
locally-connected device to remote verikun clients so a **disposable CI runner**
can drive it — without a self-hosted runner executing arbitrary PR code on the
machine that owns the device:

```sh
# On the machine with the device attached:
export VERIKUN_SERVER_AUTH_KEY=$(openssl rand -base64 32)   # or let vk generate one
vk server --allow-install                    # 127.0.0.1:8391 by default
vk server --bind 100.64.0.7 --allow-install  # expose on a tailnet IP

# From anywhere that can reach it:
export VERIKUN_SERVER=http://100.64.0.7:8391
export VERIKUN_SERVER_AUTH_KEY=<the same key>
vk install ./app-debug.apk --server "$VERIKUN_SERVER"
vk ai onboarding.md --server "$VERIKUN_SERVER"
vk suite tests/ --app com.example.app --server "$VERIKUN_SERVER"
```

**Split execution.** The client runs the whole `vk ai` engine — compile, plan
cache, repairs, the Anthropic key, run recording, suite aggregation — and only
**validated device commands** cross the network, one HTTP round-trip per command
(selector auto-wait polls on the server, next to the device). Each step's detail
(selector, heal tier, resolved element, failure screenshot + hierarchy) returns
with the response and is spliced into the client's run, so the archived report is
identical to a local run's.

**Security model** (the server is the boundary, not the transport):

- **Auth is mandatory.** Pass a key via `--auth-key` / `VERIKUN_SERVER_AUTH_KEY`
  (the env var keeps it out of `ps`), or one is generated and printed at startup.
  Clients send it as a bearer token; comparison is constant-time.
  `--allow-unsafe-anonymous` disables auth loudly — only for networks that are
  themselves the boundary (e.g. a private tailnet), and it cannot be combined
  with a key.
- **Only the validated grammar runs.** Every `/v1/exec` request passes the same
  `validateNode` gate that guards `vk ai` model repairs: action verbs only
  (`tap`/`text`/`assert`/`launch`/…), never `ui`/`log`, never a shell. The
  device and platform are fixed when the server starts — client flags cannot
  repoint them.
- **Installs are opt-in.** `POST /v1/install` requires `--allow-install` (a
  read-only server refuses builds), accepts only single-file `.apk`/`.ipa`
  uploads to a server-generated temp path (never a client path), and verifies a
  sha256 of the body.
- **One run at a time.** A run-token holds the device lock; a second concurrent
  caller gets `409`. The lock is released when the command finishes (so
  `vk install` then `vk suite` chain seamlessly), and an idle lock (5 min
  silent) is taken over, so a crashed CI job can't wedge the device.
- **Bind is loopback by default.** `--bind <addr>` opts into exposure. For a
  NAT'd box, [Tailscale](https://tailscale.com) is the recommended transport; for
  a public host, terminate TLS in front (the server itself speaks plain HTTP).
- Failure evidence (screenshots, UI hierarchies) crosses the authenticated
  channel like the rest — same caveat as `vk log`: device output is not redacted.

### CI recipe

[`.github/workflows/suite.yml`](.github/workflows/suite.yml) is a working
reference: a plain `ubuntu-latest` job builds verikun, installs the app build on
the remote device (`vk install --server`), runs `vk suite --server`, uploads
`.verikun/suites` + `.verikun/runs` as artifacts, and **fails the job when any
test fails** (the suite's exit code). Publishing anywhere else is a composable
step over the `index.json` manifest — the workflow includes commented `rclone`
(Google Drive) and `aws s3 cp` examples.

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
| `--server <url>` | For `ai`/`suite`/`install`: run against a remote [`vk server`](#remote-devices--vk-server) (or `VERIKUN_SERVER`). The server's device/platform apply. |
| `--auth-key <k>` | Key for `--server` (or `VERIKUN_SERVER_AUTH_KEY`, which keeps it out of `ps`). |
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

**Read-back vs evidence.** The downscaling above matters when an agent *reads a
screenshot back into its context* to decide the next action — that is the token cost to
manage. A screenshot taken purely as **report evidence and never read back** costs nothing
at runtime, so driving a flow to a report should capture liberally around transitions.
`vk ai` does this automatically (see [AI](#ai--natural-language-tests)); when driving by
hand, `vk screenshot` around each screen change and leave the PNG in the report.

## How it works

```
cli.ts ──> drivers/ ──> adb (Android) / idb + simctl (iOS)   (platform I/O)
   │           └─ produces normalized Element[]
   ├─ ui/android-parse.ts   uiautomator XML -> Element[]
   ├─ ui/ios-parse.ts       idb describe-all JSON -> Element[]
   ├─ ui/selector.ts        @id / text: / desc: / class: matching
   └─ ui/format.ts          compact / tree / json rendering
```

The `Driver` interface (`src/types.ts`) is the seam between platforms. The
selector, formatting, and command layers operate only on the normalized
`Element[]`, so they are entirely platform-agnostic.

- **Android** (`drivers/adb.ts`): `uiautomator dump` for the hierarchy,
  `screencap -p` for screenshots, `input tap/text/swipe/keyevent`, `wm size`.
- **iOS** (`drivers/ios.ts`): `idb ui describe-all` for the hierarchy,
  `idb ui tap/text/swipe/key/button` for interaction, `idb describe` for screen
  size; simulator `screenshot`/`launch`/`stop`/`log` stay on `xcrun simctl` (no
  idb needed for those). See [iOS setup](#ios-setup) below.

Run artifacts (screenshots, dumps) are written under `./.verikun/` (gitignored).

## iOS setup

`vk --ios` reaches feature parity with Android — `ui`/`find`, `tap`, `text`/`type`,
`swipe`, `key`, `assert`, `wait`, `screenshot`, `launch`/`stop`, plus `vk batch`,
`vk ai`, and the JUnit/HTML reports — on both simulators and physical devices.

Everything interactive is powered by **[`idb`](https://github.com/facebook/idb)**
(Facebook's iOS Development Bridge), a CLI shelled one-shot exactly like `adb`, so
verikun stays zero-runtime-dependency and one-process-per-command. Install it once:

```sh
brew tap facebook/fb && brew install idb-companion   # the companion daemon
pip install fb-idb                                    # the idb CLI (needs Python 3.6+)
```

Then boot a simulator (Simulator.app, or `xcrun simctl boot <name>`) and check
your setup with `vk doctor --ios`. `vk --ios tap`, `vk --ios ui`, etc. then work.

**Caveats (documented limitations, not bugs):**
- `clear` is unsupported — iOS has no per-app data reset (uninstall + reinstall is
  the manual equivalent, but it removes the app too). Exits 3 with an explanation.
- `current` returns `(unknown)` — iOS exposes no reliable foreground-app query.
- `swipe` duration is not honored (idb has no millisecond duration knob).
- `log` capture is simulator-only (via `log show`); for a physical device use
  Console.app or `idb log` directly.
- `--tree` renders flat — idb's accessibility list has no nesting depth.

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

## Build from source

For local development, or to run an unreleased version, build from a clone:

```sh
git clone https://github.com/ddikman/verikun && cd verikun
npm install      # installs dev deps (typescript, @types/node) and builds dist/ via the prepare hook
npm link         # optional: put `verikun` and `vk` on your PATH
```

Without `npm link`, run it as `node dist/bin/verikun.js <command>`. See [Development](#development) below for the watch/test loop.

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
