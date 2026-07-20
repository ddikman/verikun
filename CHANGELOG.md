# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
