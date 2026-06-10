# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`verikun` (CLI binaries `verikun` and `vk`) drives a connected Android device/emulator — and, partially, iOS — like Puppeteer drives a browser: tap, type, swipe, screenshot, and **inspect the UI hierarchy by semantic identifiers**. It is built to be invoked by AI agents, so its output and exit codes are a deliberate machine contract, not just human ergonomics.

## Commands

```sh
npm install        # dev deps only (typescript, @types/node) — there are NO runtime deps
npm run build      # tsc: src/ -> dist/
npm run dev        # tsc --watch
npm test           # type-check + run the unit suite (node:test) — see Unit tests below
npm link           # optional: put `verikun` + `vk` on PATH (else: node dist/bin/verikun.js <cmd>)
```

**No linter is configured;** TypeScript `strict` is the only static check — a clean `npm run build` (or `npx tsc --noEmit`) is the static gate. There is a **unit suite** (`npm test`) covering the platform-agnostic core — selector matching, XML parsing, formatting, image downscaling, report rendering, arg/duration parsing, and the device-shell escaper — but it does **not** touch a device. End-to-end behaviour is still verified by running the built CLI against a real device (`vk doctor`, `vk ui`, etc.); the connected Android device may be a personal phone, so avoid destructive actions (submitting forms, creating accounts) when exercising it.

`dist/` is gitignored. After editing any `src/**` file you must rebuild before the linked `vk`/`node dist/...` reflects the change — the dist on PATH is stale until `npm run build` runs.

## Architecture

Three layers, separated so two of them never touch a platform:

```
bin/verikun.ts → cli.ts ─┬─ ui/selector.ts   match @id / text: / desc: / class:  (platform-agnostic)
   (dispatch)            ├─ ui/format.ts      inline / compact / tree / json rendering (platform-agnostic)
                         └─ drivers/ ─→ adb | xcrun     the ONLY platform-specific code
                                  │
                                  └─ produces normalized Element[]  (ui/android-parse.ts for Android)
```

- **`src/types.ts` is the seam.** The `Driver` interface is what every platform backend implements, and `Element` is the normalized node model every other layer consumes. `cli.ts`, `ui/selector.ts`, and `ui/format.ts` operate **only** on `Element[]` and `Driver` — they contain zero `adb`/`xcrun` knowledge. Keep it that way: platform quirks belong in `drivers/`.
- **`getDriver(platform, device)` (`drivers/index.ts`)** is the only place a concrete driver is constructed (except `cmdDevices`, which probes both backends directly to list everything attached).
- **`cli.ts`** is the dispatcher: `run(argv)` parses args and builds a `Ctx { driver, platform, device, positionals, flags, record? }`; `executeCommand(command, ctx)` is the `switch` to each `cmdX(ctx)` handler. Adding a command = add a `case` (+ any aliases) **and** a line in `usageText()` — and, if it should appear in a test run, add it to `RECORDABLE` in `run.ts`.
- **`run.ts` + `report.ts`** sit beside `cli.ts` (they may use the driver, like `cli.ts` does — they are not part of the platform-agnostic core). `run.ts` records each recordable command into an on-disk test run; `report.ts` is pure (`RunState → JUnit/HTML` strings, no fs, no driver). See *Test runs* below.

Every command re-captures the hierarchy fresh (`driver.getElements()` → `uiautomator dump`); nothing is cached between invocations. This is intentional (the screen may animate/auto-advance between calls) — don't add a snapshot cache expecting staleness to be acceptable.

## Cross-cutting contracts (the reason agents can drive this)

These conventions span files; breaking one quietly breaks agent control flow.

- **Exit codes are an API.** `0` ok · `1` not found / assertion failed / wait timeout · `2` usage error or **ambiguous selector** · `3` environment error (tool missing, no/multiple devices, dump/screencap failed). They are carried by `CliError(message, exitCode)` (`src/errors.ts`) and thrown from anywhere; the single `try/catch` in `run()` is the *only* place that maps an error to a process exit code. A non-`CliError` throw becomes exit `3`. When you add logic, throw `CliError` with the right code rather than printing-and-returning.
- **stdout = data, stderr = diagnostics.** `out()` → stdout, `err()` → stderr (`src/output.ts`). Healed-match notes, "tapped …" confirmations, and warnings go to stderr so stdout stays parseable.
- **`--json` everywhere, including errors.** When `--json` is set, the catch in `run()` emits `{error, exitCode}` as JSON. New commands should honor `--json` for their success output too.
- **No host shell, ever.** `exec.ts` runs everything via `spawnSync` with an args array (no `shell: true`) — so host-side injection is impossible. *Device-side* shell escaping (for `adb shell input text …`) is the driver's job: see `escapeText()` in `drivers/adb.ts` (allowlist: backslash-escape **all** ASCII punctuation, leave alphanumerics/non-ASCII alone, then ` ` → `%s`). Add new device-shell args through that, not by string-concatenating into a command.
- **Zero runtime dependencies is a design constraint.** The XML parser (`ui/android-parse.ts`), arg parser (`args.ts`), and PNG downscaler (`image.ts`, decode/box-resample/encode over `node:zlib` only) are hand-rolled on purpose. Don't add an npm runtime dep without a deliberate decision — reach for a Node builtin first.

## Selector auto-healing (`ui/selector.ts`)

Matching is always case-insensitive and tries progressively looser **tiers**, stopping at the first that yields any match: `exact` → `partial` (substring) → `normalized` (strip case + all punctuation/whitespace/emoji). So `text:sign up`, `text:SIGN UP`, `text:signup` all find a "Sign up" button. `--contains` drops the `exact` tier; `--index N` picks the Nth within the winning tier.

Ambiguity is **never** auto-resolved: `resolveOne()` throws `CliError(…, 2)` listing the candidates if the winning tier has >1 match and no `--index` — actions never tap a guess. When a match heals (non-`exact` tier), `cli.ts`'s `healNote()` appends ` (healed: <tier> match)` to stderr so the caller can tighten the selector.

## Selector auto-wait (`cli.ts`)

Matching is a pure function of one snapshot; **waiting is layered on top in `cli.ts`, never in `selector.ts`** (keep `ui/selector.ts` time-free). Selector-resolving handlers (`tap`/`text`/`find`/`assert`/`swipe --on`) don't act on a single `getElements()` — they go through `resolveOneWaiting()` (one element) or `matchWaiting()` (a set), which **re-capture the hierarchy and re-match each `--interval` (default 300ms) until a hit or the wait window elapses**. `waitWindowMs(flags)` decides the window: `--no-wait`/`--wait 0` → `0` (single shot, fail fast), an explicit `--wait <dur>` (a bare number is ms; `5s`/`800ms` via `parseDuration()`), else the **5000ms default**. So *every* selector lookup auto-waits ~5s unless opted out.

Load-bearing rules, mirroring auto-healing:
- **Only an empty match set is retried.** A present-but-plural match is surfaced *immediately* via `resolveOne()` (exit 2) — waiting can't disambiguate, and the elements are already there. `resolveOneWaiting()` only loops while there are zero matches.
- **Bare-index `tap N` and `tap --at x,y` never wait** — an index refers to a specific prior `ui` dump, so polling (which re-captures, shifting indices) would be wrong.
- **`assert` polls the whole predicate**, not just presence: `evalAssert()` is re-run each interval, so `assert --gone` waits for *disappearance* and `--text` waits for the text to match.
- Handlers that wait return `waitedMs`; `waitNote()` appends ` (waited 1.2s)` to the confirmation. The recorded step's `durationMs` already includes the wait, so the report reflects it with no extra plumbing.

When you add a selector-resolving command, route it through these helpers (not a raw `resolveOne`/`matchElements`) so it inherits auto-wait, and add `--no-wait` to your mental model of its fast path. The `wait` *command* is unrelated — it stays the explicit blocking poll (own `--timeout`/`--interval`, `--gone`).

## Screenshot downscaling (`image.ts`)

An agent reading a screenshot pays tokens for its pixel **area**, so `cmdScreenshot` runs the raw capture through `downscalePng(buf, maxEdge)` before writing/attaching it — by default capping the longest edge at `DEFAULT_SHOT_MAX_EDGE` (700px; we seldom need more to tell what's on screen). Precedence for the cap is `--full` (skip resampling entirely) > `--max <px>` (explicit) > `--more` (the `MORE_SHOT_MAX_EDGE` 1400px preset) > `VERIKUN_SHOT_MAX_EDGE` env > the default. `image.ts` is platform-agnostic (it's image math, not device I/O — keep it that way, like `ui/*`) and dependency-free: it parses the PNG, `inflateSync`es IDAT, reverses the per-scanline filters, box-averages to the target size, and re-encodes with a None filter + `deflateSync` + a hand-rolled CRC-32. Load-bearing: it only handles 8-bit non-interlaced gray/RGB/gray-alpha/RGBA; **any other PNG (palette, 16-bit, interlaced) is returned untouched with a `reason`** so a capture is never corrupted, only left full-size. It never upscales. Failure-evidence captures in `run.ts` deliberately stay full-resolution (humans read those in the report), so route only agent-facing screenshots through the downscaler.

## Test runs (recording → JUnit/HTML)

Recordable commands (the `RECORDABLE` set in `run.ts` — actions + `wait`/`assert`, **not** inspection like `ui`/`find`/`devices`) are wrapped in `run()`: `Recorder.beginStep(...)` opens a step, the handler runs, then `finish(code)` / `finishError(e)` closes it. Because each `vk` call is its own process, run state is persisted to disk and reloaded per command:

```
./.verikun/run/            active run (run.json + artifacts/)   — auto-created on first action
./.verikun/runs/<id>/      archived runs (report.xml, report.html, run.json, artifacts/)
```

Key behaviours, each load-bearing:

- **Implicit start.** If no run is active, the first recordable command auto-starts one (`implicit: true`) and prints a one-time note to stderr. `vk run start` makes one explicitly and **refuses to clobber** a non-empty active run without `--force`.
- **Context rollover.** Before recording a step, `rolloverReason()` checks the active run against the current context; on a mismatch the old run is *sealed* (archived, never discarded) and a fresh one starts. Triggers: device serial change or session change (`VERIKUN_SESSION`/`TERM_SESSION_ID`) for any run; idle beyond `VERIKUN_RUN_IDLE_MIN` (default 30) for *implicit* runs only — a named run is sticky to idle. The serial is resolved in `run()` via `driver.resolvedSerial()` (cached, so no extra device round-trip) and passed into `beginStep`. `Recorder.seal()` is the shared finalize-and-move used by both rollover and `vk run archive`.
- **Step = testcase.** Each step records timing, exit code, and pass/fail. Handlers enrich it via `ctx.record?.note({ selector, tier, element, message })` — that is how the selector and the **resolved identifier** get into the report (the "which identifier worked" record). Add a `note(...)` when you write a new selector-resolving handler.
- **Failure evidence.** On a non-zero step, `Recorder.capture(driver)` best-effort grabs a screenshot + the UI hierarchy of the page (swallowing errors — the device may be why it failed). `screenshot` steps attach their PNG via `attachImage`.
- **Pass/fail mapping.** Returned exit code or thrown `CliError.exitCode`: `0`→passed, `1`→`<failure>` (assertion), `≥2`→`<error>` (env/usage). `vk run archive` itself **exits non-zero when the run had failures**, so the archive command doubles as a CI gate.
- **Secrets.** Step names never include typed text; `cmdText` redacts the value into the step message when the field `password` flag is set. Keep that property if you add input commands.
- **Disable** with `VERIKUN_NO_RUN=1` (`beginStep` returns null → `ctx.record` undefined → every `note`/`attachImage` is a no-op).

## Unit tests

`npm test` type-checks and runs the suite via **Node's built-in test runner** (`node:test` + `node:assert`) — no test framework is installed, keeping with the zero-runtime-dependency ethos (the only dev deps remain `typescript` + `@types/node`). Tests live in `tests/*.test.ts` and are compiled by `tsconfig.test.json` (extends the base, `rootDir: "."`, `outDir: ".test-build"`, includes `src` + `tests`) into the gitignored `.test-build/`, which `node --test` then runs. The directory is named `tests/` (plural) on purpose: `node --test`'s default discovery treats every file under a `test/` dir as a test, so `tests/helpers.ts` (shared `makeEl` / `makePng` fixtures) is only picked up under the plural name.

Scope is the **platform-agnostic core** — the layers that never touch `adb`/`xcrun`, so no device is needed: `args.ts`, `ui/selector.ts`, `ui/android-parse.ts`, `ui/format.ts`, `image.ts`, `report.ts`, `errors.ts`, plus pure helpers from `cli.ts`/`run.ts`/`drivers/adb.ts`. A handful of those helpers (`escapeText`, `tokenizeLine`, `evalAssert`, `parseDuration`, `waitWindowMs`, `parsePoint`, `healNote`, `waitNote`, `withBatchGlobals`, `stepName`, `rolloverReason`) are `export`ed **solely so the suite can reach them** — they are otherwise internal; keep them exported. The drivers themselves and the `getElements`→`uiautomator` round-trip are intentionally **not** unit-tested (that is what `vk doctor`/`vk ui` against a real device cover). When you add a pure function to the core, add a `tests/<module>.test.ts` case; when you add a platform method, it stays device-verified.

## Extending a platform backend

To add a capability, add the method to the `Driver` interface in `types.ts`, then implement it in **both** drivers. iOS is intentionally partial: `SimctlDriver` (`drivers/simctl.ts`) implements `screenshot`/`launch`/`stop` via `xcrun simctl` and lists physical devices via `devicectl`; everything interactive calls `notSupported(feature)` → `CliError(…, 3)` pointing at the planned WebDriverAgent backend. Follow that pattern (graceful, explained, exit 3) rather than half-implementing.

Known rough edge: `AdbDriver.launch()` uses `monkey -c LAUNCHER`, which can hang on some OEM skins (e.g. MIUI/HyperOS). The intended fix is `am start` via `cmd package resolve-activity` — prefer that if you touch launch.

## Repo doubles as a Claude Code plugin

- `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` make this repo installable as a marketplace plugin (`source: "./"`). Validate manifest changes with `claude plugin validate .`.
- The plugin ships the **skill** at `.claude/skills/verikun/SKILL.md` (referenced via the manifest's `"skills": "./.claude/skills/"` — not moved or duplicated). That SKILL.md is the agent-facing contract: the act→inspect→assert loop, selector grammar, exit-code semantics, the "prefer textual hierarchy lookups over screenshots to save tokens" guidance, and the convention of remembering semantic identifiers across runs. **If you change CLI behaviour (commands, selectors, exit codes, flags), update SKILL.md and README.md in the same change** — they are documentation an agent relies on, not just prose.
- Because `dist/` is gitignored, the installed plugin carries the skill but **not** a runnable `vk` binary; the CLI is a separate build-from-source / npm step. Don't assume an installed-plugin environment has `vk` on PATH.
