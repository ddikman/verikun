# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
