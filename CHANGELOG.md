# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **The npm package now ships the agent skill and the `example/*.md` tests.** `npm install -g verikun`
  delivers the CLI *and* `SKILL.md` — the agent-facing contract — in one step, rather than needing a
  separate `npx skills add` / plugin install to obtain it. It lands at
  `.claude/skills/verikun/SKILL.md` inside the package, the same path it has in the repo (shipped,
  not duplicated), which also makes the relative `SKILL.md` links in the published README resolve
  rather than dangle.
- **Packaging is now verified against the built artifact, not just the config.** New
  `scripts/check-package-contents.mjs` packs the tarball and asserts its real contents — required
  docs present, the contributor-only `create-pr` skill and `src/`/`tests/` absent. It runs in CI on
  every PR and as a release gate in `publish.yml` before `npm publish`, where a mistake would
  otherwise burn a version number npm will not let us reuse. This catches what an allowlist check
  structurally cannot: a stray `.npmignore`, a change in how npm treats the `.claude/`
  dot-directory, `.claude/skills` added alongside the exact skill path, or a subdirectory appearing
  under `example/`. That last one is not hypothetical — the allowlist entry is the glob
  `example/*.md` rather than a bare `example` precisely because the directory also holds the Flutter
  e2e fixture app, 74 files of Gradle/Xcode/PNG that no end user installing the CLI should download.
- `publish.yml` also verifies `package-lock.json` is in sync with `package.json`'s version. `npm ci`
  does not catch this — it errors only on dependency drift, never on the root `version` field.

### Fixed
- **`CHANGELOG.md` is now included in the published npm package.** `package.json`'s `"files"` is an
  allowlist, and npm force-includes only `package.json`, `README`, `LICENSE`, the `main` file and the
  `bin` file(s) — a changelog is *not* on that list (npm 5/6 included one; modern npm does not).
  Every release up to 0.19.0 therefore published without a changelog, and did so silently: the
  publish succeeded, CI was green, and nothing anywhere reported the omission.
  `tests/package-files.test.ts` now guards the allowlist, including against an entry whose path no
  longer exists.

## [0.19.0] - 2026-08-08

### Added
- **`vk device set` — change the device the app runs on, then put it back (#31).** Five settings
  to start: `airplane` (go offline, for retry/error handling), `dark`, `font-scale`, `rotation`
  and `stay-awake`, applied as `key=value` assignments so several land in one call —
  `vk device set dark=on font-scale=1.3 rotation=landscape`. Rounded out by `device get`,
  `device reset` and `device caps`. The design is snapshot → override → restore: `set` records
  what each setting held *before* it changed it, in the run file rather than in memory (every
  `vk` call is its own process, so an in-memory latch could not undo a flow that died), and
  `batch` / `ai` / `suite` restore from a `finally` — so a test that dies between `airplane=on`
  and its reset cannot leave the phone offline. A bare `vk device set` from a shell deliberately
  stays applied until you `vk device reset`.
- **A `@vk_device` screen on the Flutter fixture, so device settings are *assertable*.** Every
  line on it (`vk_dev_brightness`, `vk_dev_orientation`, `vk_dev_textscale`) is read from
  `MediaQuery` — from the platform, not from app state — so
  `assert @vk_dev_brightness --text dark` proves the app itself observed the change, rather
  than proving only that a value landed in a system database. The fixture also gains a
  `darkTheme`: with only a light theme, `ThemeMode.system` has nothing to switch to and a
  dark-mode check would pass vacuously. `example/example-test-devicestate.md` drives it on
  both platforms, and `tests/e2e/flutter-app.test.ts` covers the platform-divergent half
  (Android-only `rotation`; the iOS exit-3 refusal and its manual equivalent). Font scale is
  asserted as "grew, then was restored" rather than against a literal, because the effective
  ratio for `font-scale=1.3` differs per target — `1.30` on API 31, `1.26` on API 34 (Android
  14 scales large text non-linearly) and `1.35` on iOS (nearest Dynamic Type category). All
  three are captured in `example/flutter-app/README.md`'s measured facts.
- **A capability table (`src/device/settings.ts`) rather than five ad-hoc commands.** It declares
  each key's value domain and its per-platform support — `supported`, `unsupported`, or `noop` —
  and drives argument validation, the driver switch, `vk device caps` and the `vk ai` plan
  validator from one place. Android supports all five; on an iOS **simulator** `dark` and
  `font-scale` work via `simctl ui` (font scale maps to the nearest Dynamic Type category, and
  the applied category is echoed), `stay-awake` is an honest no-op, and `airplane`/`rotation`
  do not exist at all. Every `unsupported` entry names the manual equivalent and every `noop`
  says why it was unnecessary — both enforced by the unit suite, so a future setting cannot be
  added as a silent dead end.
- **`vk ai` can drive the device, and a bad setting fails at compile time.** `device` joins
  `KNOWN_COMMANDS` and the grammar, and `validateNode` checks a `device` leaf's keys and values
  during **plan validation** — unlike every other command, whose selector failures are runtime
  facts the engine can heal. A suite asking for `rotation` on iOS therefore fails before the
  first tap rather than twenty steps in, on a device it has already half-modified.

### Changed
- **A run rollover no longer strands the device snapshot.** `deviceOverrides` lives in the run,
  and `rolloverReason` *seals* runs on a device/session change or idle timeout — so the snapshot
  used to leave with the archive while `vk device reset`, which reads the active run, reported
  "nothing to restore" and left the device modified. Found the hard way: two workspaces driving
  different devices from one working directory ping-ponged the active run and left a phone dark
  and rotated. A same-device rollover now carries the overrides **forward**; a device-change
  rollover warns with the exact `vk device set … --device <serial>` needed to undo it, since a
  process pointed at the new device cannot drive the old one and restoring one device's values
  onto another would be worse than leaving it.
- `RunState` gained `deviceOverrides`, and `device` joined `RECORDABLE` — a report showing
  "checkout failed" without "we cut the network two steps earlier" points the reader at the
  wrong culprit. `stepName` renders the whole assignment list (`device set dark=on`).
- `exec.ts` gained `sleepSync`: the `Driver` interface is entirely synchronous, so a readback
  poll cannot await a timer. Built on `Atomics.wait`, keeping the zero-runtime-dependency rule.

### Fixed
- Nothing user-visible yet (this release adds a new capability), but two traps are handled
  rather than inherited: **`airplane=on` is verified by effect, not by its flag** — Android
  remembers a user who re-enabled wifi during a previous flight
  (`airplane_mode_toggleable_radios`), so `airplane-mode enable` can leave wifi *up*; verikun
  reads that list off the device, confirms each radio it names actually went down, and forces
  any survivor — because reporting "offline" while the app is still online would make an
  offline test pass for the wrong reason. And **`airplane=on` is refused over a wireless adb
  link** (exit 2, `--allow-wireless` overrides), since it would cut the very connection
  carrying the next command, with no way to turn it back on remotely.

## [0.18.1] - 2026-08-07

### Fixed
- **A `vk ai` run the engine failed is no longer archived as a GREEN report.** A test that
  failed because a **control node** failed — a `repeat` that exhausted without its target
  ever appearing, a `when` that matched no branch with no `else` — recorded no step, and
  both `report.xml` and `report.html` derived their verdict purely from the step tally. So
  the JUnit XML declared `failures="0"` for a failed test, in exactly the format CI trusts
  automatically, and the HTML showed all-PASS while the suite summary said FAIL. The same
  hole covered `read` failures, a repair give-up, and the budget/timeout aborts (which the
  engine reports as a bare flag with no reason attached at all).

  `Recorder.recordTerminalFailure` now records the engine's verdict before the archive: the
  run gains a top-level `failure` (`where` + reason, the same text the suite prints), and a
  synthetic failed step is appended — but **only when no step is already red**, so a leaf
  failure that already has its own testcase is not counted twice. `vk run archive`'s exit
  code and `vk suite`'s `failedSteps` follow from that with no further change.
- **Failure evidence for a failure no command produced.** `ExecBackend.captureFailure`
  grabs a screenshot + the UI hierarchy at the moment the engine gives up, attached to the
  recorded step exactly like a failing command's `step-N-fail.png`. Previously the archive
  of a control-node failure held no trace of the screen at all. Over `--server` this
  degrades honestly to the hierarchy only — the server has no screenshot route.
- **The report writer no longer infers pass/fail from the step tally alone.** `runFailure()`
  takes the run-level verdict (`failure`, falling back to `ai.ok`); if a failed run somehow
  still carries no red step, both renderers emit one synthetic failing testcase rather than
  reporting green. `report.html` also states the verdict in a banner at the top, since that
  page is where a human looks first.

## [0.18.0] - 2026-08-06

### Added
- **Archive-time device log capture by default** ([#56]) — `vk run archive` (and
  rollover / `vk ai` seals) now write a bounded, session-scoped logcat dump to
  `artifacts/logcat.txt` without requiring an explicit `vk log` step. Opt out on
  green runs with `--no-logs` or `VERIKUN_NO_LOGS`; failed runs still capture.
  Capture is best-effort and never blocks sealing the report. Full dump linked from
  `report.html` meta; when the run launched an app, an app-scoped dump is also written
  to `artifacts/logcat-app.txt` and embedded in a bottom accordion. Noted in `report.xml`.
- **`logStart` over `--server`** ([#56]) — `/v1/exec` returns the device-clock
  marker and `/v1/logs` serves archive-time dumps, so remote CI archives scope
  logs the same way a local run does.

## [0.17.0] - 2026-08-06

### Added
- **`vk suite --retries N`** ([#43]) — re-run a failed test up to N times so a
  transient flake can recover the suite instead of reding CI. A later pass exits
  `0` and surfaces a warning (`flaky` + prior `attempts` on the test row, suite
  `warnings` in the manifest/HTML); failed-attempt archives stay linked. Default
  `0` keeps today's gate.

  The bias is deliberately toward retrying: an attempt costs one test, while giving
  up costs the whole suite plus a human rerunning it. So an **environment break is
  retried too** — a `vk server` connection dropping or a device re-enumerating
  outlives the two-probe health window, and with attempts left the suite waits
  (short backoff, one `warnings` entry per blip) rather than aborting. Only two
  failures are never retried, because a rerun provably cannot change them: a **budget
  abort** (each attempt gets its own ceiling) and a **usage error** (exit `2` — an
  unreadable test file, a payload the server refuses). Once the attempts are gone, a
  still-broken environment aborts with exit `3` exactly as before.

[#43]: https://github.com/ddikman/verikun/issues/43
## [0.16.0] - 2026-08-05

### Added
- **`--selected`, `--checked`, `--focused` selector modifiers, each with a `--not-` form**
  ([#38]) — `--not-selected`, …, joining `--enabled`, which also gains `--not-enabled`. `selected`
  and `checked` were already parsed into `Element` and printed by `vk ui`; there was simply
  no way to match on them. Unset means *don't care*; the filter is applied to the candidate
  pool **before** the healing tiers, so a state-matching exact hit can never shadow a
  state-matching partial one. Combining `--x` with `--not-x` is a usage error (exit 2).

  The negative form is the load-bearing half. A segmented control whose options share one
  handler *flips* on any tap, and its default is content-driven — so "tap the option I
  want" lands on the other one whenever it was already chosen. Measured on the fixture:
  `vk tap @vk_mode_video` exits 0, prints `tapped … tap,selected`, and leaves the app in
  photo mode. The flow completes, nothing fails, and the run exercised the opposite mode —
  worse than a red test. `if-present "id:x --not-selected" { tap id:x }` makes the
  already-correct case a no-op instead.
- **A selector string may carry its own state modifiers** — `"id:mode_video --not-selected"`.
  Control nodes (`if-present`, `when`, `repeat`, `while-present`, `read`) hold a bare
  `selector: string` with nowhere to put a flag, and a guard is exactly where the toggle
  case needs one. Stripped only at the end of the string and only after whitespace, so
  `text:--selected` and `text:a --selected b` stay plain values; `Selector.raw` keeps the
  original so errors and reports echo what was written. `swipe --on` and every command
  inherit the same parser.
- **The `vk ai` grammar teaches all of it**, including the shared-handler toggle rule, so a
  compiled plan can express the guard. Verified end to end: the compiler emitted
  `{"type":"if-present","selector":"id:vk_mode_video --not-selected", …}` unprompted and
  the plan replayed model-free at `$0`.
- **A fourth fixture screen, `@vk_state`** (`example/flutter-app`) — a mode picker whose two
  options share one `_toggleMode()`, plus a field that takes real input focus. It is the
  instrument the facts below were measured with, and the device suite drives it.

### Fixed
- **`vk tap --enabled @submit` swallowed its selector.** `enabled` was missing from the
  argv parser's `BOOLEAN` set, and a non-boolean flag consumes the next token — so the
  selector became the flag's value and the command died with "Missing selector". Only the
  trailing form worked. All eight new modifier names are registered too.
- **`swipe --on <selector>` silently ignored `--index` and `--enabled`.** It built its
  selector directly instead of going through `buildSelector`; it now honours every
  modifier like the other selector commands.

### Platform notes
- **`--selected` / `--focused` are Android-only, and say so.** Measured against the fixture
  on an iPhone 17 Pro simulator: a selected and an unselected segment come back identical
  apart from label and frame. `idb ui describe-all --json` has no such key in its schema at
  all — no accessibility traits — so no app can supply it and there is nothing to derive.
  Using them with `--ios` therefore exits **3** with a named reason rather than matching
  nothing: a filter that can only ever match zero elements burns the full auto-wait window
  and then reports "No element matched selector", which is untrue about the screen and is
  precisely the false signal these modifiers were added to prevent. Same honest degrade as
  `clearApp` and `currentApp`. `--enabled` and `--checked` work on both platforms
  (`checked` is derived on iOS from the element type plus `AXValue`).

[#38]: https://github.com/ddikman/verikun/issues/38

## [0.15.0] - 2026-08-05

### Fixed
- **`tap`/`text` no longer press a point that does not reach their target** ([#42]).
  An element's centre is not always on the element: a row scrolled past the edge of its
  list arrives with bounds already clipped to the display, and a sticky bottom bar is
  drawn across the middle of whatever is under it. Pressing that point hit the *other*
  control — and the step reported success, so the run continued from the wrong place and
  failed several steps later on an unrelated symptom. Reproduced on a Pixel 3a: pressing
  a row's own centre recorded the sticky bar's button, not the row.

### Added
- **Auto scroll-into-view.** `tap` and `text` now bring their target into the clear
  before acting — into its scroll container, and out from under anything painted over
  it — then act, appending `(scrolled into view: N swipes)` to the confirmation. "Scroll
  down to X and tap it" is just `vk tap X`; the `repeat until X { swipe up }` idiom is no
  longer needed to reach something below the fold (the `vk ai` grammar now says so).
  Where the target cannot be reached at all, the action **fails with exit 1** instead of
  tapping blind coordinates. `--no-scroll` opts out.
- **`offscreen` marker** on elements with no pixel on screen, in `vk ui`'s output and
  `--json`. Nothing is hidden — inspection commands (`ui`/`find`/`assert`) neither scroll
  nor filter; only actions move the screen.
- **`Driver.viewport()`** — `screenSize()` corrected for the dump's rotation, memoized
  per driver instance. Every unknown degrades to "everything is visible", so a device
  whose screen size cannot be read behaves exactly as before.
- A **scroll screen** in the Flutter fixture (`example/flutter-app`) where every row
  records which control actually fired, plus e2e coverage that pins the wrong-tap
  reproduction, and two new measured facts in its README: Android's dumper hides
  off-screen nodes and clips the rest, and a fast swipe can take the app off the screen.

[#42]: https://github.com/ddikman/verikun/issues/42
## [0.14.0] - 2026-08-03

### Added
- **`suggest-verikun-improvement` skill.** When *verikun itself* is the friction — a model
  heal on a **cached** replay (the $0 replay that still woke the model), a repair give-up,
  or a recurring gotcha — the main `verikun` skill hands off to this new skill, which drafts
  a light, **TL;DR-first** improvement suggestion for `ddikman/verikun`. It is
  **draft-first** (the user reviews before anything is submitted) and **aggressively redacts**
  every app-under-test specific (package, on-screen text, selector values, test prose, logs,
  screenshots) so no client code or logic can leak. De-dup is by a generalised *category*
  fingerprint, so one issue tracks each verikun weakness class rather than one per app or
  control.
- **`cached` in `vk ai --json`.** The structured summary now reports whether the plan was a
  cached replay (`true`) or a fresh compile (`false`), so a heal on a cached replay — the
  signal the skill keys on — is detectable from the JSON instead of by parsing the
  `[ai] plan cache hit` stderr line.

## [0.13.0] - 2026-08-03

### Added
- **`vk ai --model gpt-4.1` — a cheaper alternative to the default `claude-sonnet-4-6`.** $2/$8 per
  1M against sonnet's $3/$15, priced in the bundled table like every other model. It reuses the
  existing `OpenAiProvider` (Chat Completions + strict `json_schema` Structured Outputs, which
  gpt-4.1 supports) and `OPENAI_API_KEY`, so it is a `MODELS` row rather than a new backend.
- `Price.cacheReadMult` — an optional per-model override for the cache-read multiplier. gpt-4.1
  bills cache reads at **0.25x** input ($0.50/1M), not the 0.1x every model in the table until now
  shared, and that table is what the `--max-cost-usd` gate meters. A `--cost-override` carries no
  multiplier and so still assumes 0.1x.

### Fixed
- `reasoning_effort` is now sent only to OpenAI models that accept it (a `REASONING_MODELS`
  allowlist, mirroring `claude.ts`'s `EFFORT_MODELS`). gpt-4.1 is the registry's first
  **non-reasoning** model and OpenAI rejects the parameter for it with a `400` — which the retry
  loop deliberately does not retry — so unguarded, `--model gpt-4.1 --effort high` would have died
  as a usage error (exit `2`) before reaching the device. An allowlist rather than a denylist: an
  unlisted model quietly forgoes effort instead of failing the run.

## [0.12.0] - 2026-08-03

### Added
- **Toolchain preflight** — device setup is now verified before tests run and will fail the suite instead of test-by-test.
  It will verify that idb and/or adb are available and that there are devices that can be used.
- **An aborted suite says which tests never ran** — `index.json` gains an `aborted` block
  and `index.html` a banner. Skipped tests are not counted as failures.

### Fixed
- **`vk ai` and `vk suite` exit `3` (was `1`) when the environment is what failed**, so a
  broken machine no longer looks like a failing app. Restores the documented exit-code contract.
- **A control-flow guard no longer reads an unreadable screen as "absent".** It used to skip
  its body, so a guard-heavy plan could pass having executed nothing.
- **No more duplicate `could not capture failure …` noise** when the toolchain is itself why
  the step failed. Evidence capture is still attempted, just not narrated twice.

### Known gap
- A failing `screenshot` step still stays green even when a missing tool caused it: a genuine
  screencap hiccup looks identical, so telling them apart needs a separate error type.

## [0.11.0] - 2026-07-31

### Added
- **`--enabled` selector modifier** — match only a control that is *actionable right now*
  (`enabled` plus, on Android, `clickable`/`longClickable`), and with auto-wait, block until it
  becomes so. A Submit/Check button that the app disables until a form validates is **present**
  long before it is **usable**, so a presence match taps a dead control, nothing happens, and the
  failure surfaces several steps later as a confusing timeout on whatever should have come next.
  Found by porting a real flow whose Maestro original needed the same guard (`enabled: true`).
  The filter is applied to the candidate pool *before* the healing tiers, so a disabled exact
  match cannot shadow an enabled partial one.
- **`vk ai` plans can branch, loop over an unknown-length list, and carry values — the fix for
  compile-from-one-playthrough (#33).** Four additions to the plan IR, all evaluated by the
  engine at replay, so a green run still costs **$0** and wakes no model:
  - **`when`** — ordered n-way dispatch: the first branch whose selector is on screen runs, and
    only it. For "this screen is one of N kinds, handle whichever it is". No match and no `else`
    is a **failure**, deliberately the opposite of `if-present` ("this may or may not be there").
    A silent skip inside a loop would spin to the cap doing nothing and report green.
  - **One level of control nesting**, so `repeat { when { … } }` — the loop-that-branches shape
    a dynamic flow needs — is finally expressible. `ir.ts` said *"a real flow that needs deeper
    nesting is the trigger to revisit"*; this was that flow.
  - **`while-present`** with an optional `bind` counter: repeats while a selector is present,
    exposing the index as `{{ctx.<name>}}`. Walks an index-addressed list whose length is not
    knowable at compile time ("tap each pair until they are all matched"). It may nest one level
    deeper than the branching nodes, since its own body is leaves.
  - **`read`** — capture `text`/`desc`/`id`/`idShort` off the live tree into `{{ctx.<name>}}`,
    for the case where a test must act on a value it cannot know in advance (an app that marks
    the correct answer in the semantic tree, and the test must then *type* it).
- **Placeholders** in any positional, flag value, or control-node selector: `{{ctx.NAME}}`,
  `{{env.NAME}}`, `{{uuid}}`, `{{timestamp}}`, `{{run_id}}`. `{{uuid}}`/`{{timestamp}}` are
  generated **once per run** and memoized, so a signup uses the same address in the email field,
  the confirm field and a later assert — and a different one next run, which is what stops a
  cached plan from colliding with the account its previous run created. The store is per
  `runPlan` call, not per process, so two tests in one `vk suite` do not share a value.
  An unset `{{ctx.*}}` or `{{env.*}}` **fails the step** rather than substituting an empty
  string. Placeholders live in the plan, never in the prose, so the cache key is unchanged.
  This is deliberately template substitution, not an expression language — there is no `eval`,
  no `vm`, and nothing to sandbox.

### Changed
- **A `repeat` that stops without ever seeing its selector now FAILS.** Both exits — cap
  exhausted and the structural no-progress bail — used to return success, so a loop whose body
  did nothing reported green. That is the reachable false green once bodies can branch (a `when`
  that matches nothing does nothing, the loop spins, the run passes). A post-loop confirmation
  check runs before failing, so a target that appears after the final iteration is not a false
  red. **This can turn a previously-green scroll-until red if it never actually found its row.**
- `validateNode` rejects an empty control body (`when`'s `else: []` is the one exception — the
  explicit "match nothing, do nothing" opt-in), and tolerates `null` for optional fields, which
  is how OpenAI/codex strict mode encodes an absent `else`/`bind`.

### Fixed
- **`vk ai`: the loop no-progress guard was blind to `content-desc`, so it aborted healthy loops
  on Flutter apps.** `structuralHash` (`src/agent/engine.ts`) fingerprinted the screen as
  `idShort|text|type`. Flutter maps `Semantics(label:)` to Android's `contentDescription` — i.e.
  to `desc`, never to `text` — so on a Flutter app every content-bearing node has an empty `text`
  and the fingerprint collapsed to `id||type` for the whole screen. Measured on a live screen: 14
  elements, **0** with `text`, 8 with `desc`. Two entirely different questions hashed
  byte-identically, and a loop answering a different one each iteration was declared stalled and
  failed. Now `id|text|desc|type` — and the full `id` rather than `idShort` (the suffix after the
  last `/`), so nodes from different namespaces cannot collide in what is meant to be a
  fingerprint. Presented as flakiness rather than a hard failure, since it only fired when the app
  happened to serve several same-shaped screens in a row.
- **`assert --text` now matches `content-desc` as well as `text`.** The same blindness in a second
  place: `evalAssert` compared `m.text` only, so on a Flutter app `assert @x --text "Welcome"`
  could never pass — while `text:Welcome` as a *selector* resolved fine, because the selector layer
  already falls back to `desc`. The two now agree. Strictly widening: it can only turn a false
  negative into a pass.
- **`vk ai`: an `if-present` guard now waits for its selector before deciding the optional UI is
  absent.** `present()` (`src/agent/engine.ts`) took a single `uiautomator` dump and trusted a
  successful-but-empty result — its retry loop only re-fired when the dump *threw*. Every
  selector-resolving leaf command auto-waits ~5s, so a guard was strictly **less patient than a
  bare `tap`**, and an interstitial that animated in a few hundred ms after a transition was
  missed by the very construct meant to catch it. This is the first of the fixes for the
  compile-from-one-playthrough problem (#33) — optional interstitials were one of its four
  variation classes.
- The window is **not** a pure wall-clock box. A UI dump measured ~2.4s on an emulator and can be
  ~10x faster on a physical device, so a time-only budget gives a fast phone a dozen looks at the
  screen and a slow emulator none — the first implementation of this fix was a silent no-op on
  exactly the devices that needed it. A non-zero window therefore guarantees **at least two
  looks**, and keeps polling while time remains. Cost of an absent guard is about one extra dump
  (~2-3.5s on the reference emulator, proportionally less on real hardware).
- A **loop's own exit check never pays the window** (`settleMs = 0`). That guard is absent on
  every iteration by construction — that is what makes it a loop — so inheriting the window would
  burn `cap ×` it (~37s at cap 25) to discover something already expected.
- The transient-dump retry is unchanged and **orthogonal** to the new window: a dump that throws
  is still retried once even with the window closed, so a flaky `uiautomator` call never reads as
  "absent" and skips a body that should have run.

### Added
- **`VERIKUN_GUARD_SETTLE_MS`** — tune the `vk ai` guard settle window without a rebuild (`0`
  restores the previous single-shot probe). The right value is device-dependent, so it is meant
  to be measured against a real app rather than guessed.


## [0.10.0] - 2026-07-26

### Added
- **`vk ai --model cursor-cli` — compile/repair off a logged-in `cursor-agent`, no API key.**
  The second CLI-agent backend, stacking on the same `CliProvider` class 0.9.0 introduced: it is
  a new `CliAgentSpec` (`CURSOR_SPEC`), not a new provider class. Anyone with a Cursor
  subscription and `cursor-agent login` can now run `vk ai` / `vk suite` without setting
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Like `codex-cli` it is billed to the subscription, so
  its cost line reads `$0` and `--max-cost-usd` / `--cost-override` are inert.
- Unlike `codex`, `cursor-agent` has **no JSON-schema flag**, so the plan schema is injected into
  the prompt and `extractJson` peels the object back out of the `--output-format json` envelope;
  `parsePlan` / `validateNode` remains the execution trust boundary either way. The call runs
  `--mode ask` (read-only) with `--workspace` pointed at a scratch dir, so it never sees — let
  alone touches — your working tree, and is never given `--force` / `--yolo`. A `cursor-agent`
  run that reports `is_error` while still exiting `0` is surfaced as an environment error (exit
  `3`) rather than a confusing "did not return parseable JSON".

### Changed
- `providerAvailable` / `providerRequirement` / `makeProvider` (`cli.ts`) now look CLI backends up
  in one `CLI_SPECS` table instead of each carrying a per-CLI `switch` arm, and the "not found on
  PATH" error reuses the spec's own `loginHint` rather than restating it. Adding a third agent CLI
  is a spec plus a table entry.
- Corrected the `AgentProvider` docs in `CLAUDE.md` and `src/agent/provider.ts`, which still
  described a single v1 Claude implementation and never mentioned the OpenAI or CLI backends.

## [0.9.0] - 2026-07-21

### Added
- **`vk ai --model codex-cli` — drive the compiler/repair off a logged-in `codex` CLI, no
  API key.** A third provider backend (`CliProvider`, `src/agent/cli-provider.ts`) shells out
  to an already-authenticated coding-agent CLI instead of calling an HTTP API, so anyone with
  a ChatGPT subscription and `codex login` can run `vk ai` / `vk suite` without setting
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. It runs `codex exec` read-only in a neutral temp
  dir (never touching the working tree) and uses codex's native `--output-schema` to constrain
  the plan JSON; `parsePlan`/`validateNode` remains the trust boundary regardless of provider.
  The provider seam (`AgentProvider`) and the shared prompt/grammar are unchanged — it's one
  more class behind the same `providerFor(model)` routing. (The `cursor-cli` backend will stack
  on the same class next.)

### Changed
- Provider availability is now per-provider: HTTP providers still need their API key in the
  environment, while a CLI provider (`codex-cli`) is available when its binary is on PATH. The
  `vk ai`/`vk suite` preflight errors reflect this (e.g. "the `codex` CLI was not found on PATH
  — run `codex login`") instead of only naming an env var.
- For `codex-cli`, spend is billed to the user's subscription rather than per token, so cost is
  reported as `$0` and `--max-cost-usd` / `--cost-override` are inert no-ops; a run is bounded
  by `maxRepairs` and `--timeout` instead. Plans stay provider-agnostic in the cache, so a plan
  compiled by any model replays for free under `--model codex-cli` (use `--recompile` to force
  a fresh compile when comparing providers).

## [0.8.1] - 2026-07-21

### Changed
- `vk devices` now prints an aligned, headed table — a header row plus columns that
  line up across Android/iOS rows, with empty optional columns (MODEL/PRODUCT/NOTE)
  omitted. Previously rows were tab-joined and dropped empty cells, so a device
  missing a model/product slid its remaining cells out of alignment. `--json` output
  is unchanged.

## [0.8.0] - 2026-07-15

### Added
- **Automatic review screenshots in `vk ai` / `vk suite`.** The compiler now inserts
  `screenshot` steps around screen transitions and inside `if-present`/`repeat` bodies,
  so the archived HTML/JUnit report carries a before/after visual trail for post-run
  review. They are dumped for humans, never read back by the model (no token cost on
  replay), and are best-effort — a capture that fails is logged and skipped, never a
  test failure. Guidance for driving `vk` by hand is in SKILL.md / README (a screenshot
  taken as report evidence and never read back is free — only *reading* an image into an
  agent's context costs tokens).

### Changed
- `vk ai` / `vk suite` reports and JUnit now contain more `<testcase>` steps per run
  (the auto-inserted screenshots), so step/testcase counts are higher than in 0.7.0.
- The `vk ai` engine treats a `screenshot`/`shot` step that fails to capture as
  best-effort: it logs the failure and continues instead of failing the run.

## [0.7.0] - 2026-07-14

### Added
- **`vk suite <dir>`** — run a directory of natural-language tests (`*.md`,
  lexicographic order, `README.md` skipped) as one sequential suite: app data is
  reset between tests when `--app <id>` is given (iOS degrades to a force-stop),
  each test runs through the `vk ai` engine against one shared backend, and the
  suite writes an overview to `./.verikun/suites/<id>/` — `index.json` (a stable,
  `schemaVersion`ed manifest with per-test pass/fail, steps, repairs, cost, and
  duration) plus `index.html` linking every test's archived report. Exits 1 when
  any test failed, so the command doubles as the CI gate. Reporting providers
  compose over the manifest as CI steps (upload-artifact, rclone, `aws s3`) —
  no in-core upload plugins.
- **`vk server`** — expose the locally-connected device/simulator to remote
  verikun clients over HTTP+JSON (Node built-ins only). Only verikun's validated
  action grammar is executable (every `/v1/exec` request passes the same
  `validateNode` gate that guards `vk ai` model repairs — never `ui`/`log`, never
  a shell), the device/platform are fixed at startup (client flags can't repoint
  them), and auth is mandatory: a bearer key via `--auth-key` /
  `VERIKUN_SERVER_AUTH_KEY` (auto-generated and printed if omitted), compared with
  `crypto.timingSafeEqual`; `--allow-unsafe-anonymous` opts out loudly for
  networks that are themselves the boundary (e.g. Tailscale). Binds `127.0.0.1`
  by default (`--bind`/`--port` to expose); one run-token holds the device lock
  at a time (409 otherwise, idle locks are taken over); `--allow-install` enables
  the build-upload endpoint.
- **`--server <url>` remote mode for `vk ai` / `vk suite` / `vk install`** (or
  `VERIKUN_SERVER`, with `--auth-key` / `VERIKUN_SERVER_AUTH_KEY`): the whole
  engine — compile, plan cache, repair, run recording, reports, cost budget —
  runs on the caller (e.g. a disposable CI runner with the Anthropic key), while
  only validated leaf commands cross the network, one round-trip per command
  (auto-wait polling stays server-side). Each step's detail (selector, heal tier,
  resolved element, failure screenshot + hierarchy) is spliced back into the
  local run, so a remote run's report is identical to a local one's.
- **`vk install <app.apk|.ipa>`** — install a build on the device (`adb install
  -r` / `idb install`). With `--server`, the file is streamed to the server
  (which must run `--allow-install`) with sha256 integrity verification; the
  remote path accepts single-file `.apk`/`.ipa` only.
- **`.github/workflows/suite.yml`** — a reference GitHub Actions recipe: a
  throwaway `ubuntu-latest` runner builds verikun, installs the app build on the
  remote device via `vk install --server`, runs `vk suite --server` against it,
  uploads `.verikun/suites` + `.verikun/runs` as artifacts (with commented rclone
  / S3 provider examples over the manifest), and fails the job on any failed test.

## [0.6.0] - 2026-07-10

### Added
- **OpenAI models for `vk ai`.** `--model` now switches provider as well as model:
  alongside the Claude models it accepts `gpt-5.4-mini`, `gpt-5.4`, and `gpt-5.5`, served
  by a new `OpenAiProvider` (`src/agent/openai.ts`) that calls OpenAI's Chat Completions
  API over Node's built-in `fetch` — no SDK, so the zero-runtime-dependency rule still
  holds. OpenAI models read `OPENAI_API_KEY`; Claude models continue to read
  `ANTHROPIC_API_KEY`. The compile-once / replay-model-free engine, plan cache, and cost
  budget are unchanged — the provider is chosen behind the existing `AgentProvider` seam.
  Because the endpoint is the de-facto OpenAI-compatible shape, the same provider can
  later target Groq/xAI/Together/etc. by base URL.

## [0.5.0] - 2026-07-10

### Added
- **iOS simulator + device support at parity with Android**, via Facebook's
  [`idb`](https://github.com/facebook/idb). `vk --ios` now drives the full loop —
  `ui`/`find`, `tap`, `text`/`type`, `swipe`, `key`, `assert`, `wait`, plus the
  existing `screenshot`/`launch`/`stop`, and therefore `vk batch`, `vk ai`, and
  the JUnit/HTML test-run reports. The hierarchy comes from `idb ui describe-all`
  (parsed by the new `ui/ios-parse.ts` into the same `Element` model as Android);
  interaction, keys, and screen size use `idb ui …`; simulator
  screenshots/launch/stop/logs stay on `xcrun simctl` (no idb needed for those).
  Install idb with `brew install idb-companion` + `pip install fb-idb`;
  `vk doctor --ios` verifies it. The old `SimctlDriver` is replaced by `IdbDriver`.
  Documented caveats: `clear` is unsupported (iOS has no per-app data reset),
  `current` returns `(unknown)`, `swipe` duration is not honored, and `log`
  capture is simulator-only.
- **iOS `vk ai` example** (`example/example-test-ios.md`) — a plain-English Settings
  navigate-and-search smoke test, the iOS counterpart to the Android camera example.

## [0.4.1] - 2026-07-07

### Added
- **Published to npm** — install the CLI with `npm install -g verikun` (ships the
  compiled `dist/`, so no build-from-source needed). Added a root MIT `LICENSE`
  file and npm package metadata (`repository`, `homepage`, `bugs`, `keywords`,
  `author`, `publishConfig`).

### Changed
- **Build runs on the `prepare` lifecycle hook** (was `prepublishOnly`), so
  `npm publish`, `npm pack`, and install-from-git all compile `dist/` first —
  fixing an `npm pack` that previously produced a `dist`-less tarball.
- **`scripts/gen-version.mjs` now also stamps `.claude-plugin/plugin.json`'s
  `version`** from `package.json` (previously a manual sync), guarded by a new
  `tests/plugin-version.test.ts` drift check.

## [0.4.0] - 2026-07-06

### Added
- **`clear` command and `launch --clear`** to wipe an app's locally stored data —
  login/session, preferences, caches — resetting it to a just-installed state
  before a flow. Android via `pm clear` (which also force-stops the app);
  recorded as a test-run step like other lifecycle actions. iOS is not supported
  yet (`simctl` has no per-app data reset).
- **Unit test suite** (`npm test`) for the platform-agnostic core — selector
  matching/auto-healing, the `uiautomator` XML parser, element formatting, the
  PNG downscaler, JUnit/HTML report rendering, argument/duration parsing, and
  the device-shell escaper. It runs on Node's built-in test runner
  (`node:test`), so no test framework is added and the zero-runtime-dependency
  rule holds (dev deps remain `typescript` + `@types/node`). Tests live in
  `tests/*.test.ts`, compile via `tsconfig.test.json` into a gitignored
  `.test-build/`, and need no connected device.
- **`vk ai <file>`** — run a natural-language test: compiled once to a deterministic
  plan IR, replayed model-free, with the model woken only to repair a drifted selector
  (`src/agent/`). Every run is bounded by default — spend by `--max-cost-usd` (default
  $3) and wall-clock by `--timeout` (default 15m, e.g. `--timeout 5m`) — so a runaway
  compile/repair loop can't spend or hang without limit.
- **`launch`/`open` `--no-restart`** to bring an app forward without restarting it.
- **`example/`** — a natural-language `vk ai` example test and README.

### Changed
- `launch`/`open` **restarts by default** (force-stops the app first) so a rerun starts
  from a fresh state instead of a stale screen; `--no-restart` opts out.
- The `vk ai` plan cache is gated by a compiler fingerprint (verikun version + grammar)
  and written at compile time, so an unchanged test never recompiles and a verikun
  update never replays a plan an older build produced.

### Fixed
- `launch` resolves the launcher activity and uses `am start` instead of `monkey -c
  LAUNCHER` (which hangs on MIUI/HyperOS), and now detects a failed start (stderr + exit
  code), not just stdout.
- `vk ai` repair can **give up** (terminal failure) instead of substituting a wrong
  element onto a drifted screen and passing falsely.
- `vk log` hardened: `--since` is validated against the logcat timestamp charset (no
  device-shell injection) and `--out` is confined to the working directory.
- The `vk ai` trust boundary is tightened to every model-reachable sink, not just `vk
  log`: `screenshot --out` is confined to the working directory (was unguarded), and the
  `launch`/`stop`/`clear` package id is validated against a safe charset so model output
  can't inject into the device shell.
- `vk ai` rejects an empty compiled/cached plan instead of reporting a green pass for a
  test that ran no steps.
- `launch --no-restart` is parsed as a boolean, so it works before the package argument
  (`vk launch --no-restart <pkg>`) instead of swallowing it.
- A model-healed step no longer shows the failed attempt's screenshot/hierarchy in the
  report (it is a pass, not a failure).

## [0.3.0] - 2026-06-07

### Added
- **Screenshots are downscaled by default** to a 700px longest edge, so an agent
  reading one back spends far fewer tokens (image cost scales with pixel area)
  while UI text stays legible — a typical capture shrinks ~12× in area. New
  `vk screenshot` flags: `--more` (bump to a 1400px cap when 700 reads too
  coarse), `--max <px>` (an exact cap), and `--full` (write the original).
  `VERIKUN_SHOT_MAX_EDGE` changes the default globally.
- A dependency-free, pure-Node PNG resampler (`src/image.ts`, built on
  `node:zlib`). PNGs it can't safely resample (palette, 16-bit, interlaced) are
  written through untouched, so a capture is never corrupted — only left
  full-size. It never upscales.

### Fixed
- `vk --version` and `package-lock.json` now report the actual package version
  (both had drifted behind `package.json`).

## [0.2.0] - 2026-06-05

### Added
- **Test runs**: recordable actions form a run that archives to a JUnit
  `report.xml` plus a self-contained HTML report
  (`vk run start|status|archive|clear`), capturing timings, the resolved
  identifier per step, and — on failure — a screenshot and the page's UI
  hierarchy. `vk run archive` exits non-zero on failures, so it doubles as a CI
  gate. An implicit run auto-starts on the first action and rolls over (archiving
  the old one) on a device or session change, or after idle.
- **Selector auto-wait**: `tap`, `text`, `find`, `assert`, and `swipe --on` retry
  the lookup for up to 5s instead of failing on the first miss. `--wait <dur>`
  tunes the window (`8s`, `800ms`, bare ms), `--no-wait` / `--wait 0` fails fast,
  and `assert --gone` waits for disappearance. Ambiguous matches are never
  waited on.

## [0.1.0] - 2026-06-03

### Added
- Initial release. Drive a connected Android device (and partial iOS via
  `simctl`) Puppeteer-style: `tap`, `text`, `type`, `swipe`, `key`,
  `screenshot`, `launch`, `stop`, plus semantic hierarchy inspection (`ui`,
  `find`, `assert`, `wait`) with auto-healing selectors (`@id` / `text:` /
  `desc:` / `class:`), a machine-readable exit-code contract, and `--json`
  output everywhere.
