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
  flow in one call with `vk batch` (commands piped on stdin or via --file). iOS (--ios):
  screenshots + launch/stop work today via simctl; tap/type/swipe/hierarchy need
  idb (planned).
---

# verikun — drive & verify mobile apps

`vk` operates a connected Android device/emulator and reads its screen as
structured, **semantic** elements, so you can act and then *verify* — like
Puppeteer for native apps. Prefer it over raw `adb`.

The command is `vk` (after `npm link`) or, if not linked, `node dist/bin/verikun.js`
from the repo root. All examples below use `vk`.

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
  not yet supported.

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
picks the Nth match (0-based) when a selector intentionally matches several.

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

## Be frugal: text over images, and remember identifiers

**Perceive with text, not pixels.** `vk ui` / `vk find` / `vk assert` return a
few hundred bytes; a screenshot read back as an image costs far more tokens.
Default to the textual hierarchy to see and verify state. Reach for `vk
screenshot` (then read the PNG) only when you genuinely need pixels — visual
layout, rendering/spacing bugs, or content with no text/id/desc. One image can
outweigh dozens of `vk ui` calls. When you do, `vk` already downscales the PNG
(700px longest edge) so the read stays cheap while text remains legible — add
`--more` if a screen is too coarse to read, or `--full` when you need exact detail.

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
vk ai onboarding.md --max-cost-usd 0.50 # bound the spend; aborts if the estimate crosses it
```

- Needs `ANTHROPIC_API_KEY`. Default model `claude-sonnet-4-6`; `--model` switches it
  (`claude-haiku-4-5` · `claude-sonnet-4-6` · `claude-opus-4-8` · `claude-fable-5`).
- The plan expresses **conditions** (`if-present`, for optional interstitials like a
  permission dialog) and **bounded loops** (`repeat … until`, e.g. scroll-until) —
  control flow `vk batch` cannot, so a flaky popup or a scroll-to-find no longer breaks
  the flow.
- **Progress streams to stderr** (never silent in CI); **stdout is the report path**
  (`--json` for a structured summary). It records like any flow, so it ends with the
  same JUnit + HTML report — including the token/cost line and **suggested improvements**
  you can fold back into the English to stabilize the test and cut future tokens.
- Exit `0` pass · `1` a step failed (or the budget was hit) · `2` usage · `3` environment
  (e.g. `ANTHROPIC_API_KEY` unset).

## Test runs & reports

Every action is **recorded into a test run** — one auto-starts on your first
action, no setup needed. Each command becomes a step with its timing, the
selector + identifier it resolved through, and pass/fail. When a step fails, `vk`
automatically captures a screenshot **and** the UI hierarchy of that page. To
also get the device logs (the crash/stack trace), run `vk log <package>` after
the failure — that step records the logs into the same run, so they appear in
the report next to the failure.

- `vk run status` — the current run's steps and outcomes
- `vk run archive [name]` — finish the run: writes a **JUnit XML** + a
  self-contained **HTML report** (screenshots, captured hierarchies, and the
  identifiers used) to `./.verikun/runs/<id>/`, and exits non-zero if any step
  failed — so it gates CI
- `vk run clear` — discard the run, no report
- `vk run start [name]` — begin a fresh named run explicitly (optional)

An implicit run **rolls over automatically** when the context changes — a
different device, a different `VERIKUN_SESSION`, or 30 min idle
(`VERIKUN_RUN_IDLE_MIN`, 0 disables): the stale run is archived and a fresh one
starts, so unrelated sessions never merge into one report. A run you named with
`vk run start` is sticky to idle (only a device/session change rolls it over).

When the task is "run/verify flow X and give me a report", just drive the flow
and end with `vk run archive` — the report *is* the deliverable. The archived
`run.json` records which selector resolved each step, so it doubles as the
identifier memory described above. Set `VERIKUN_NO_RUN=1` to disable recording.

## Exit codes — rely on these for control flow

- `0` success / found / assertion passed
- `1` not found / assertion failed / wait timeout
- `2` usage error **or ambiguous selector** (refine it or add `--index N`)
- `3` environment error (no device, adb missing, hierarchy dump failed)

## Gotchas

- **Disable animations once** for reliable dumps: `vk doctor --fix`. Live
  animations can make `vk ui` flaky (it already retries 3×).
- **Ambiguous selector → exit 2**, never a random tap. `vk` prints the candidate
  matches; add `--index N` or use a more specific selector.
- **Indexes are per-snapshot.** `vk tap 3` taps `[3]` from the *latest* dump;
  prefer `@id` / `text:` selectors for stability across screens.
- **Text starting with `-`:** put `--` first → `vk type -- "-50% off"`.
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
- **iOS** (`--ios`): `screenshot`, `launch`, `stop` work via simctl; everything
  interactive (tap/type/swipe/`ui`) needs `idb` and is not wired yet.

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
