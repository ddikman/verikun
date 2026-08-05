---
name: verikun
description: >-
  Drive and verify a connected Android device/emulator the way Puppeteer drives a
  browser: tap, type, swipe, screenshot, and — most importantly — inspect the UI
  hierarchy by semantic identifiers (resource-id, visible text, accessibility
  label) to confirm what is on screen. Use whenever a task means interacting with
  or asserting the state of a native app on a device/emulator: "tap the login
  button", "type into the email field", "verify the screen shows X", "scroll down
  and check Y", "automate this signup flow", "screenshot the current screen",
  "is the spinner gone yet". Prefer this over raw adb. Selector commands auto-wait
  ~5s for elements to appear, so you rarely need explicit waits (`--no-wait` opts
  out). Recorded actions form a
  test run you can archive to a JUnit + HTML report (`vk run archive`) — use when
  asked to "test", "verify the flow", or "produce a report". Run a whole known
  flow in one call with `vk batch` (commands piped on stdin or via --file); run a
  directory of natural-language tests as a gated suite with `vk suite <dir>`
  (overview report + non-zero exit on failure — the CI gate). A remote device is
  reachable via `--server <url>` (ai/suite/install) against a `vk server` running
  next to it. iOS (--ios): full parity via idb (tap/type/swipe/`ui` +
  screenshot/launch/stop), on simulators and devices; install idb and see
  `vk doctor --ios`.
---

# verikun — drive & verify mobile apps

`vk` operates a connected Android device/emulator and reads its screen as
structured, **semantic** elements, so you can act and then *verify* — like
Puppeteer for native apps. Prefer it over raw `adb`.

The command is `vk` (after `npm install -g verikun`, or `npm link` from a source
clone) or, if not linked, `node dist/bin/verikun.js` from the repo root. All
examples below use `vk`.

## The loop: act → inspect → assert

1. **See** the screen → `vk ui`
2. **Act** by semantic selector → `vk tap @login_button`
3. **Verify** the result → `vk assert text:"Welcome"` (or `vk ui` again)

Never guess coordinates. Reference elements by their identifiers and let `vk`
resolve the tap point. This is the whole point of the tool.

## Inspect — the core capability

- `vk ui` — compact list of every interactive/labeled element, one per line:
  ```
  [3] Button "Sign in" @sign_in_btn (540,1020) tap
  [4] EditText @email_input (540,720) focused
  ```
  Fields: `[index] Type "text" @resource-id (centerX,centerY) flags`. The `@id`
  token can be pasted straight back into a selector.
- `vk ui --tree` — indented to show nesting. Add `--all` to include layout nodes.
- `vk ui --json` — structured output for parsing.
- `vk find <selector>` — print matching elements; exit 1 if none.
- `vk assert <selector> [--text S] [--gone]` — exit 0 pass / 1 fail. For checks.
- `vk wait <selector> [--gone] [--timeout ms] [--interval ms]` — poll until the
  element appears (or disappears with `--gone`). Essential for async UI.
- `vk current` — foreground app/activity.
- `vk log [package] [-n N]` — recent device logs (Android `logcat` snapshot).
  Reach for this **after a failure** to read the crash/stack trace the screen
  can't show you. **Inside a run it defaults to logs since the run started**, so
  you only see this session's output (not stale logs from before); `-n N` gives
  the last N lines instead, `--since '<MM-DD HH:MM:SS.mmm>'` sets an explicit
  start, `--full` dumps everything. A `package` scopes to that app (system-wide
  if it has already crashed). Unlike other inspect commands it is *recorded*, so
  during a run the logs are pulled **into the archived report** next to the step.

## Act

Selector lookups **auto-wait up to 5s** (see [Auto-wait](#auto-wait)), so you
usually don't need a `wait` before an action — `vk tap @next` already polls for
`@next` to appear.

- `vk tap <selector|index>`  ·  `vk tap --at x,y`
- `vk text <selector> "the text" [--clear] [--enter]` — focus the field, then type
- `vk type "text" [--enter]` — type into the already-focused field
- `vk swipe up|down|left|right [--on <selector>] [--distance f] [--duration ms]`
- `vk swipe --from x,y --to x,y [--duration ms]`
- `vk key <name|code>`  ·  `vk back`  ·  `vk home`  ·  `vk enter`
- `vk screenshot [--out path] [--more] [--max px] [--full]` — saves a PNG (default
  `./.verikun/screen.png`) and prints the path; then read that file to *see* the
  screen. It's **downscaled to a 700px longest edge by default** to save tokens
  (text stays legible); add `--more` if a screen reads too coarse, `--max px` for
  an exact cap, or `--full` for the original.
- `vk launch <pkg> [--clear] [--no-restart]`  ·  `vk stop <pkg>`  ·  `vk clear <pkg>`
  `vk launch` **restarts by default**: it force-stops the app first so a rerun starts
  from a fresh launch instead of landing on whatever screen a still-running instance
  was left on (re-issuing the launch intent to a live app just resurfaces its current
  state). force-stop is a no-op if the app isn't running. `--no-restart` skips it (just
  bring the existing instance forward).
  `vk clear` (and `vk launch --clear`) additionally wipe the app's local data —
  login/session, prefs, cache — so a flow starts from a clean, logged-out,
  fresh-install state. Android only (`pm clear`, which also force-stops the app); iOS
  has no per-app data reset, so `clear` exits 3 there.

## Change the device, not just the app

Some behaviour only appears when the device changes underneath the app — the offline
banner, the retry path, dark theme, a layout that breaks at accessibility text sizes.

- `vk device set <key>=<value> ...` · `vk device get [key]` · `vk device reset` · `vk device caps`

  | key | values | Android | iOS simulator |
  |---|---|---|---|
  | `airplane` | `on\|off` | yes | **no** — a simulator has no radio |
  | `dark` | `on\|off` | yes | yes |
  | `font-scale` | `0.5`–`3.0`, `default` | yes | yes (nearest Dynamic Type category) |
  | `rotation` | `portrait\|landscape\|portrait-reverse\|landscape-reverse\|auto` | yes | **no** |
  | `stay-awake` | `on\|off` | yes | no-op (simulators don't sleep) |

  Set several at once: `vk device set dark=on font-scale=1.3`. Each change is **verified by
  reading it back**, so success means it actually landed — these device commands silently
  no-op on some OEM skins. An unsupported key exits **3 before touching the device** and
  names the manual equivalent; `vk device caps` prints the live matrix for your platform.

  **Always `vk device reset` when the scenario is done.** It restores what the run changed,
  from the snapshot taken before each change. `batch`, `ai` and `suite` reset automatically
  even when the flow *fails* — but a bare `vk device set` from a shell stays applied until
  you reset it, so don't leave someone's phone in airplane mode.

  Two traps:
  - **`airplane=off` brings the radio back, not the internet.** Follow it with
    `vk assert <selector> --wait 10s`, never an immediate `tap`.
  - **Over wireless adb, `airplane=on` is refused** (exit 2) — it would cut the connection
    carrying your next command. Use USB, or `--allow-wireless` if you accept losing it.

## Selectors

| Form | Matches |
|---|---|
| `@login` | resource-id (full, `/suffix`, or short name) |
| `id:login` | same as `@login` |
| `text:Sign in` | visible text (case-insensitive; auto-heals) |
| `desc:Submit` | content-desc / accessibility label |
| `class:Button` | simplified type or full class name |
| `"Sign in"` | a bare string == `text:Sign in` |

**Matching auto-heals** — always case-insensitive, trying **exact → partial
(substring) → normalized** (ignore punctuation/whitespace/emoji), stopping at the
first tier that hits. So `text:sign up`, `text:SIGN UP`, and `text:signup` all
find a "Sign up" button. Exact always wins (a partial never shadows an exact
match); a non-exact hit is flagged in the output as `(healed: …)`. Ambiguity is
never auto-resolved — if the winning tier has >1 match, an action lists the
candidates and exits 2 rather than guess.

Modifiers: `--contains` forces substring (skips the exact tier); `--index N`
picks the Nth match (0-based) when a selector intentionally matches several;
`--no-scroll` stops an action scrolling its target into view (see below).

**State modifiers** require an a11y attribute, in both polarities. Unset means
*don't care*:

| Modifier | Matches | Negative |
|---|---|---|
| `--enabled` | actionable right now | `--not-enabled` |
| `--selected` | current option of a segmented control / tab / mode picker | `--not-selected` |
| `--checked` | ticked checkbox / switch / radio | `--not-checked` |
| `--focused` | holds input focus | `--not-focused` |

Reach for `--enabled` on any button the app keeps disabled until something else
is done — a Check/Submit/Continue that lights up only once an answer is picked
or a form validates. Such a button is *present* long before it is usable, so a
plain presence match taps a dead control, nothing happens, and the failure
surfaces several steps later as a puzzling timeout on whatever should have come
next. With auto-wait, `--enabled` means "wait until it is actually pressable".

Reach for the **negative** forms whenever tapping a control *toggles* it. A
segmented control whose options share one handler flips on any tap, so an
unconditional "tap the option I want" lands on the other one whenever it was
already chosen — exit 0, no warning, and the rest of the run exercises the wrong
mode. Check first, then act:

```sh
vk find "@mode_video --not-selected" --no-wait && vk tap @mode_video
```

A modifier is a flag **or** a suffix on the selector string (as above) — the
string form is what lets a `vk ai` control node carry one, since `if-present` /
`when` / `repeat` / `while-present` / `read` hold a bare selector with nowhere to
put a flag: `if-present "id:mode_video --not-selected" { tap id:mode_video }`.

**`--selected` and `--focused` do not exist on iOS.** `idb` emits no such key, so
using them with `--ios` exits **3** instead of matching nothing forever.
`--enabled` and `--checked` work on both platforms.

## Auto-wait

Selector commands (`tap`, `text`, `find`, `assert`, `swipe --on`) **retry the
lookup for up to 5s** instead of failing on the first miss — they re-capture the
hierarchy until it resolves. The screen is usually still settling after the prior
action, so this lets you act/verify directly without a `wait` in between, saving
round-trips and tokens.

- **Default:** 5s. `--wait <dur>` overrides it (`--wait 8s`, `--wait 800ms`, or a
  bare ms count like `--wait 3000`).
- **`--no-wait` (or `--wait 0`):** fail immediately if the lenient lookup misses.
  Use it for a pure existence probe where you want the answer *now*, e.g.
  `vk find @spinner --no-wait` to check "is it there this instant".
- **Ambiguity is never waited on** — a present-but-plural match exits 2 right
  away (the elements are already there); add `--index N` or refine the selector.
- **`vk assert <sel> --gone` waits for *disappearance*** — it polls until the
  element is absent, so you don't need a separate `wait --gone`.

When you *do* want to block on a condition as an explicit step (e.g. a long
network wait beyond 5s), the `wait` command is still there with its own
`--timeout`/`--interval`; or just bump the inline window with `--wait`.

## Auto scroll-into-view

**You do not need to scroll before tapping.** `tap` and `text` bring their target
into the clear first — into its scroll container, and out from under anything
drawn over it (a sticky bottom bar, a floating button) — then act, reporting
`(scrolled into view: N swipes)`. So "scroll down to the card and tap it" is just
`vk tap @card`. Reach for an explicit `swipe` only when the scrolling itself is
the thing under test, or to make a lazy list build rows it has not built yet.

- `ui` / `find` / `assert` never scroll, and hide nothing: an element with no
  pixel on screen is listed as usual with an `offscreen` marker.
- An element that cannot be reached is a **failure (exit 1)**, never a blind tap
  on its coordinates. `--no-scroll` turns the scrolling off.
- Caveat worth knowing: a control covered by something the accessibility tree
  does not contain is invisible to any tool reading that tree. verikun warns on
  stderr when it presses an element it believes is covered — if a tap "succeeds"
  and nothing happens, that warning is the first thing to look for.

## Be frugal: text over images, and remember identifiers

**Perceive with text, not pixels.** `vk ui` / `vk find` / `vk assert` return a
few hundred bytes; a screenshot read back as an image costs far more tokens.
Default to the textual hierarchy to see and verify state. Reach for `vk
screenshot` (then read the PNG) only when you genuinely need pixels — visual
layout, rendering/spacing bugs, or content with no text/id/desc. One image can
outweigh dozens of `vk ui` calls. When you do, `vk` already downscales the PNG
(700px longest edge) so the read stays cheap while text remains legible — add
`--more` if a screen is too coarse to read, or `--full` when you need exact detail.

**Two uses of a screenshot — keep them apart.** The cost above is about *reading a
screenshot back into context* to decide your next move; that is what to avoid (perceive
and verify with the hierarchy instead). A screenshot taken purely as **report evidence
and never read back** costs nothing at runtime. So when you drive a flow to produce a
report, **do** `vk screenshot` around each significant transition (and before a risky or
verification step) — then leave it in the report, don't read the PNG back. A visual trail
makes post-run review far easier, and a failing step already auto-captures its own screen.

**Remember identifiers across runs.** After a flow succeeds, save the selectors
you found to memory — the mapping from human intent to selector, plus the screen
and step order, e.g.:

> Signup flow: "Get Started" → `@get_started`; intro slides → `@continue_btn`
> (tap ×2); plan picker → `text:"Free trial"`; account form → `@email_input`,
> then submit with `text:"Create account"`.

Next time a similar request comes in, **reuse the remembered selectors directly**
instead of re-inspecting from scratch — fewer round-trips, fewer tokens, faster
runs. Re-verify cheaply with `vk assert` / `vk find`; only fall back to a full
`vk ui` when a remembered selector stops resolving (the app changed — then update
the memory). Auto-healing selectors make remembered identifiers resilient to
small label/casing changes.

## Batch a known flow into one call

When you already know the steps (e.g. from a remembered flow), run them as a single
`vk batch` instead of one tool call per command — one process, far fewer
round-trips. Pipe newline-separated commands on **stdin**, or pass `--file <path>`:

```sh
vk batch <<'EOF'
launch com.example.app
text @email_input "user@example.com"
text @password_input "hunter2" --enter
assert text:"Welcome back" --wait 8s
run archive login-smoke
EOF
```

Each line runs **exactly as if called standalone** — same [auto-wait](#auto-wait),
same recording as a test-run step, same exit codes. The batch **streams each result
to stdout, then stops at the first non-zero exit and propagates that code**, so a
failed `tap`/`assert` halts the flow (its screenshot + hierarchy are captured in the
run, like any failed step). Blank lines and `#` comments are skipped, and the
`batch` call's `--device` / `--ios` / `--android` / `--json` apply to every line.

Reach for it once a flow is *known*; keep using single commands while you're still
**discovering** a screen (you need `vk ui` between steps anyway). If a batch halts,
read its stderr line (`batch stopped at line N (…)`) to see which command failed,
fix that selector, and re-run.

## Run a natural-language test (vk ai)

`vk ai <file>` is the inverse of driving the device yourself: instead of you
issuing `tap`/`text`/`assert` and inspecting between them, it hands a plain-English
test file to a model that **compiles it once into a deterministic plan**, then
replays that plan with **no model calls on the happy path**. The model is woken only
to *repair* a step whose selector stops resolving, and a green run caches the repaired
plan so the next run is free. Reach for it when the task is "run this whole English
test and give me a report"; keep using single commands while you're still
*discovering* a screen.

```sh
vk ai onboarding.md                     # compile (first run) or replay (cached)
vk ai onboarding.md --show-plan         # print the compiled plan IR, do not run
vk ai onboarding.md --max-cost-usd 0.50 # tighten the spend cap (default $3)
vk ai onboarding.md --timeout 5m        # tighten the run timeout (default 15m)
```

- Needs `ANTHROPIC_API_KEY` (Claude models) or `OPENAI_API_KEY` (OpenAI models) — **or no key
  at all** with `--model codex-cli` / `--model cursor-cli`, which drive an already-logged-in
  `codex` or `cursor-agent` CLI off your ChatGPT / Cursor subscription (run `codex login` or
  `cursor-agent login` once; verikun just needs the binary on PATH). Default model
  `claude-sonnet-4-6`; `--model` switches model **and** provider — Anthropic
  (`claude-haiku-4-5` · `claude-sonnet-4-6` · `claude-opus-4-8` · `claude-fable-5`),
  OpenAI (`gpt-5.4-mini` · `gpt-5.4` · `gpt-5.5` · `gpt-4.1` — cheaper than the default sonnet,
  and non-reasoning, so `--effort` does not apply to it), or a CLI backend (`codex-cli` · `cursor-cli`).
- For the CLI backends, spend is on your subscription, not per token, so the cost line reads `$0`
  and `--max-cost-usd` / `--cost-override` are no-ops (the run is still bounded by repairs +
  `--timeout`). Each CLI chooses its own underlying model, and is run read-only in a scratch
  directory so it never touches your working tree. Plans are provider-agnostic, so one compiled
  by any model replays for free under a CLI backend; use `--recompile` to force a fresh compile
  when comparing providers.
- The plan expresses **conditions** (`if-present`, for optional interstitials like a
  permission dialog) and **bounded loops** (`repeat … until`, e.g. scroll-until) —
  control flow `vk batch` cannot, so a flaky popup or a scroll-to-find no longer breaks
  the flow. An `if-present` guard **waits for its selector to settle** (at least two looks
  at the screen) before deciding the optional UI is absent, so a dialog that animates in a
  beat after the transition is still caught. An absent guard costs about one extra UI dump;
  `VERIKUN_GUARD_SETTLE_MS=0` restores the old single-shot probe.
- **Progress streams to stderr** (never silent in CI); **stdout is the report path**
  (`--json` for a structured summary). It records like any flow, so it ends with the
  same JUnit + HTML report — including the token/cost line and **suggested improvements**
  you can fold back into the English to stabilize the test and cut future tokens.
- **Review screenshots are automatic.** The compiler sprinkles `screenshot` steps around
  transitions (and inside loops) so the report shows a before/after visual trail for
  post-run review — dumped, never read back by the model, so they add no token cost on
  replay and never gate the test (a capture that hiccups is logged and skipped, not a
  failure).
- **Bounded by default:** the run aborts if the estimated spend crosses **$3**
  (`--max-cost-usd`) or the wall-clock passes **15m** (`--timeout`), so a runaway
  compile/repair loop can't spend or hang without limit.
- Exit `0` pass · `1` a step failed (or the budget/timeout was hit) · `2` usage · `3` environment
  (e.g. the model's API key — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — unset, or the `codex` /
  `cursor-agent` CLI missing / not logged in for `--model codex-cli` / `cursor-cli`).
- **`3` also means the device toolchain is broken**, checked *before* anything is compiled
  (missing `adb`/`idb`, no device, an ambiguous target) and again if it breaks mid-run. Treat
  it as "fix the machine", never as a failing test — the message carries the install hint.

## Run a suite of tests (vk suite)

When the task is "run all the tests" / "run the test directory", use
`vk suite <dir>` instead of looping `vk ai` yourself:

```sh
vk suite tests/ --app com.example.app        # reset app data between tests
```

- Runs every `*.md` in the directory (lexicographic — `01-…`, `02-…` sequences
  them; `README.md` is skipped) through the `vk ai` engine; all `ai` flags apply.
- `--app <id>` clears the app's data before each test (iOS: force-stop only).
  Without it, each test must self-isolate (e.g. start with `launch <pkg> --clear`).
- A failing test doesn't stop the suite. stdout is the suite directory
  (`./.verikun/suites/<id>/` with `index.json` + `index.html` linking every
  test's report); **exit 1 if any test failed** — so it gates CI directly.
- **`--retries N`** (default `0`) re-runs a failed test up to N times. A later
  pass recovers the suite (exit `0`) and surfaces a warning — failed-attempt
  archives stay linked via `attempts` / suite `warnings`. An **environment break is
  retried too** (a dropped `--server` connection, a device re-enumerating), with a
  short backoff and a warning per blip; only a **budget abort** and a **usage error**
  (exit `2`) are never retried, since a rerun cannot change either.
- **A broken *environment* does stop it: exit `3`.** If a test dies from an environment
  error the toolchain is re-probed; only if it's still broken — and no retries remain —
  does the suite abort (so a one-off flaky dump doesn't kill the run). The tests that
  never ran are listed in `index.json`'s `aborted.notRun` and in the HTML banner — they
  are **not** counted as failures. So `3` = fix the machine and rerun; `1` = a real
  regression to investigate.

## Drive a remote device (--server)

If the device is attached to another machine running `vk server`, point
`vk ai` / `vk suite` / `vk install` at it — everything else works identically
(same reports, same exit codes; the server's device/platform apply):

```sh
export VERIKUN_SERVER=http://100.64.0.7:8391
export VERIKUN_SERVER_AUTH_KEY=<key printed/configured by the server>
vk install ./app-debug.apk --server "$VERIKUN_SERVER"   # server needs --allow-install
vk suite tests/ --app com.example.app --server "$VERIKUN_SERVER"
```

A wrong URL/key fails fast with exit 3; `409` means another run holds the
device. To expose a device from THIS machine: `vk server --allow-install`
(add `--bind <addr>` to leave loopback; auth key auto-generates if unset).

## Test runs & reports

Every action is **recorded into a test run** — one auto-starts on your first
action, no setup needed. Each command becomes a step with its timing, the
selector + identifier it resolved through, and pass/fail. When a step fails, `vk`
automatically captures a screenshot **and** the UI hierarchy of that page.
`vk run archive` also captures a session-scoped device-log dump into
`artifacts/logcat.txt` by default, plus an app-scoped dump into
`artifacts/logcat-app.txt` (shown in the HTML accordion) when the run launched
an app. You can still run `vk log <package>` mid-run to attach a snapshot to a
step. Opt out on green runs with `--no-logs` / `VERIKUN_NO_LOGS` (failures still
capture).

- `vk run status` — the current run's steps and outcomes
- `vk run archive [name] [--no-logs]` — finish the run: writes a **JUnit XML** + a
  self-contained **HTML report** (screenshots, captured hierarchies, device log,
  and the identifiers used) to `./.verikun/runs/<id>/`, and exits non-zero if any
  step failed — so it gates CI
- `vk run clear` — discard the run, no report
- `vk run start [name]` — begin a fresh named run explicitly (optional)

An implicit run **rolls over automatically** when the context changes — a
different device, a different `VERIKUN_SESSION`, or 30 min idle
(`VERIKUN_RUN_IDLE_MIN`, 0 disables): the stale run is archived and a fresh one
starts, so unrelated sessions never merge into one report. A run you named with
`vk run start` is sticky to idle (only a device/session change rolls it over).

When the task is "run/verify flow X and give me a report", just drive the flow
and end with `vk run archive` — the report *is* the deliverable. **Drop a
`vk screenshot` around each significant transition** (before/after a navigation tap,
a submit, a screen change) so the report carries a visual trail for post-run review —
these are write-only evidence, so don't read the PNGs back (see [Be frugal](#be-frugal-text-over-images-and-remember-identifiers)).
A failing step already auto-captures its own screen + hierarchy on top of that. The
archived `run.json` records which selector resolved each step, so it doubles as the
identifier memory described above. Set `VERIKUN_NO_RUN=1` to disable recording.

## Improve verikun (report friction upstream)

When **verikun itself** — not the app, not your selector — is the friction (a model heal on
a *cached* replay: `[ai] plan cache hit` + a repair, or `"cached": true` with
`modelRepairs > 0` in `--json`; a `drifted, not repaired` give-up; or a recurring gotcha in
vk's own operation), use the **`suggest-verikun-improvement`** skill. It drafts a light,
TL;DR-first suggestion — **redacted** of every app-under-test specific (package, on-screen
text, selector values, test prose, logs) — for you to **review before it's submitted** to
`ddikman/verikun`. Don't hand-roll the issue: that skill owns the redaction and the
draft-first flow.

## Exit codes — rely on these for control flow

- `0` success / found / assertion passed
- `1` not found / assertion failed / wait timeout
- `2` usage error **or ambiguous selector** (refine it or add `--index N`)
- `3` environment error (no device, adb/idb missing, hierarchy dump failed) — for
  `ai`/`suite`/`install`/`server` the toolchain is verified up front, so this arrives
  immediately with an install hint rather than mid-flow

## Gotchas

- **Disable animations once** for reliable dumps: `vk doctor --fix`. Live
  animations can make `vk ui` flaky (it already retries 3×).
- **Ambiguous selector → exit 2**, never a random tap. `vk` prints the candidate
  matches; add `--index N` or use a more specific selector.
- **Indexes are per-snapshot.** `vk tap 3` taps `[3]` from the *latest* dump;
  prefer `@id` / `text:` selectors for stability across screens.
- **Text starting with `-`:** put `--` first → `vk type -- "-50% off"`.
- **`vk device set` from a plain shell stays applied.** Inside `batch`/`ai`/`suite` it is
  restored automatically even if the flow dies, but a one-off `vk device set airplane=on`
  is yours to `vk device reset` — don't strand someone's phone offline.
- **One device auto-resolves.** Multiple → pass `-d <serial>` or set `VERIKUN_DEVICE`.
- **`vk text` opens the keyboard.** Use `--enter` to submit, or `vk back` to
  dismiss it before re-inspecting (it can cover elements).
- **Unicode/emoji** may not type via `adb input text` (an Android limitation);
  ASCII is reliable.
- **`vk log` is a snapshot, not a stream** — it dumps recent lines and exits.
  Scoping with a `package` filters to that app's live process; once the app has
  **crashed** its process is gone, so `vk log <pkg>` falls back to system-wide
  logs (where the crash trace still is). The logs are **raw device output** and
  can contain anything the app logged — including secrets — so treat archived
  reports accordingly (`VERIKUN_NO_RUN=1` disables recording).
- **Special characters type fine.** Emails and symbols (`@ . + _ - / = : , ; ! # % & …`)
  go in verbatim — `vk` backslash-escapes every device-shell metacharacter before
  `adb input text`, so `vk text @email "bob+tag@mail.com"` lands the whole address,
  not just `bob`. **Quote the value** when you build the command in a shell (or feed
  it via `vk batch`/stdin, which uses no host shell) so your *own* shell can't split
  or drop the `@`/`#`/`&` before `vk` sees it.
- **iOS** (`--ios`): full parity with Android — `ui`/`find`, `tap`, `text`/`type`,
  `swipe`, `key`, `assert`, `screenshot`, `launch`/`stop` — on simulators and
  physical devices. Interaction + hierarchy come from `idb` (`brew install
  idb-companion` + `pip install fb-idb`); simulator screenshots/launch/stop/logs
  use `xcrun simctl`. Run `vk doctor --ios` to check the toolchain. Caveats: `clear`
  is unsupported (no per-app reset), `current` is `(unknown)`, device logs are
  simulator-only, and `device set` is partial — `dark`/`font-scale` work on a simulator
  while `airplane`/`rotation` do not exist there at all (`vk device caps --ios`). iOS
  accessibility ids are often unset, so prefer `text:`/`desc:` selectors there.

## Worked example — verify a login flow

```sh
vk doctor --fix                              # deterministic UI
vk launch com.example.app
vk text @email_input "user@example.com"      # field lookup auto-waits up to 5s
vk text @password_input "hunter2" --enter
vk assert text:"Welcome back" --wait 8s      # poll up to 8s, then assert → exit 0 = logged in
vk assert @error_banner --gone               # exit 0 → no error banner shown
vk run archive login-smoke                   # -> ./.verikun/runs/<id>/report.html (+ report.xml)
```

Note there's no explicit `wait @email_input` — `text` auto-waits for the field.
Check `$?` after `assert`/`wait`/`find` to branch on success vs failure.
