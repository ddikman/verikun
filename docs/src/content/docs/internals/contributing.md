---
title: Contributing
description: Build from source, the test loop, the Flutter fixture app, versioning, and releasing.
sidebar:
  order: 5
---

## Build from source

```sh
git clone https://github.com/ddikman/verikun && cd verikun
npm install      # dev deps (typescript, @types/node); also builds dist/ via the prepare hook
npm link         # optional: put `verikun` and `vk` on your PATH
```

Without `npm link`, run it as `node dist/bin/verikun.js <command>`.

```sh
npm run build      # tsc: src/ -> dist/
npm run dev        # tsc --watch
npm test           # type-check + run the unit suite
npm run test:watch # re-run the suite on change
```

:::caution
`dist/` is gitignored. **After editing any `src/**` file you must rebuild** before the linked
`vk` reflects the change — the `dist` on your `PATH` is stale until `npm run build` runs.
:::

**No linter is configured.** TypeScript `strict` is the only static check, so a clean
`npm run build` (or `npx tsc --noEmit`) is the static gate.

## The unit suite

`npm test` type-checks and runs the suite via Node's built-in test runner (`node:test` +
`node:assert`). No test framework is installed, in keeping with the
[zero-runtime-dependency ethos](/verikun/internals/core-principles/#zero-runtime-dependencies-is-a-design-constraint).

Tests live in `tests/*.test.ts` and compile via `tsconfig.test.json` into the gitignored
`.test-build/`, which `node --test .test-build/tests/*.test.js` then runs.

### The `*.test.js` glob is load-bearing

Do not "simplify" it back to a bare directory. It matches only test files, so
`tests/helpers.ts` compiles alongside them but never runs as a test; a single `*` does not
cross a directory boundary, so the **device** suite in `tests/e2e/` is type-checked but never
*run* by `npm test` (widening it to `**` would turn CI red for everyone without a phone
attached); and an explicit file list runs the same way on Node 20 and 22, both of which are in
CI.

### Scope

The **platform-agnostic core** — the layers that never touch `adb` / `xcrun` / `idb`, so no
device is needed: `args.ts`, `ui/selector.ts`, `ui/android-parse.ts`, `ui/ios-parse.ts`,
`ui/format.ts`, `image.ts`, `report.ts`, `errors.ts`, the whole of `device/` (`claims.ts`,
`grant.ts`, `settings.ts`, `pool.ts`, `failover.ts`, `prep.ts`), plus pure helpers from
`cli.ts`, `commands/`, `run.ts` and `drivers/adb.ts`.

A handful of those helpers — `escapeText`, `evalAssert`, `parsePoint`, `healNote`, `stepName`,
`rolloverReason`, `grantLanes` — are `export`ed **solely so the suite can reach them**. Keep
them exported.

The drivers themselves and the `getElements` → `uiautomator` round-trip are intentionally
**not** unit-tested; that is what `vk doctor` and `vk ui` against a real device cover.

**When you add a pure function to the core, add a `tests/<module>.test.ts` case. When you add
a platform method, it stays device-verified.**

### Reporting

`npm test` uses the `spec` reporter. CI runs `npm run test:ci`, which fans out to **two**
reporters at once: `spec` to stdout, and a custom reporter (`scripts/github-test-summary.mjs`)
to `test-results/summary.md`, which the workflow appends to `$GITHUB_STEP_SUMMARY`. That
reporter is plain ESM with zero dependencies, because `node --test` loads it directly rather
than through `tsc`. Keep it dependency-free.

## The Flutter fixture app (device e2e)

`example/flutter-app/` is a small Flutter app whose accessibility semantics we control, and
`tests/e2e/` drives it through the **built** CLI to pin the machine contract on real
hardware. Both `example/*.md` natural-language tests target the same app, so the prose tests,
the e2e suite and the documented behaviour share one source of truth.

```sh
npm run flutter-app:apk    # fvm flutter build apk --debug
npm run flutter-app:ios    # fvm flutter build ios --simulator --debug
npm run test:e2e           # needs a real device
```

- **`npm run test:e2e` needs a real device and is NOT part of `npm test`.** Set
  `VK_E2E_DEVICE=<serial>` for Android, or `VK_E2E_PLATFORM=ios` for the simulator. With no
  device or no fixture installed, the suite **skips with a diagnostic** rather than failing.
  **`ci.yml` must stay device-free** — do not wire this into it.
- **It is a harness, not `vk batch` or `vk ai`.** `batch` cannot express *"this SHOULD exit
  2"*, and `vk ai` heals around precisely the failures worth observing.
  `tests/e2e/harness.ts` spawns `dist/bin/verikun.js` and asserts on `{code, stdout, stderr}`.
- **The app is deliberately stateless.** With all state in memory, `vk launch` (which
  force-stops first) is an identical full reset on both platforms, where `pm clear` is not
  portable. **Do not add persistence.**
- **`SemanticsBinding.instance.ensureSemantics()` in `lib/main.dart` is load-bearing** —
  without a held `SemanticsHandle`, Flutter emits no semantics tree at all and `vk ui` sees
  one empty `FlutterView`. **Never dispose it.**
- **Every widget wraps in `MergeSemantics`**, so its id, label and state flags land on one
  node. Give every identified node a label too: one with an identifier but no label survives
  on Android and vanishes from the iOS tree.
- **`example/flutter-app/README.md` holds the measured facts** — what `vk` actually reports
  for each widget, per platform. **Keep that file measured, not aspirational.**
- **`@vk_device` reads from `MediaQuery`**, so a test can assert the app *observed* a device
  change rather than only that a value landed. The app's `darkTheme` exists for the same
  reason: with only a light theme a dark-mode assertion would pass vacuously.

The Flutter SDK is pinned by the committed `example/flutter-app/.fvmrc`. **Always invoke
`fvm flutter`, never bare `flutter`.**

## The documentation site

This site is an Astro Starlight project in `docs/`, with its **own** `package.json` and
lockfile. The repo root has no `workspaces` key, so root `npm ci` never descends into it.

Run it from the repo root — these wrap the `--prefix docs` commands so you never have to
`cd`:

```sh
npm run docs:install   # once — installs the site's dependencies (needs Node >= 22.12)
npm run docs           # local preview at http://localhost:4321/verikun/
npm run docs:build     # production build; fails on a dead internal link
```

Open `http://localhost:4321/verikun/`, not bare `localhost:4321` — `base: '/verikun'` in
`astro.config.mjs` mirrors the project Pages URL, so the root path is a 404.

Astro 7 needs **Node >= 22.12** while the CLI supports Node >= 18 and CI runs 20.x, so your
shell's Node is probably too old — `nvm use 22` first, or the build dies with
`Node.js v20.x is not supported by Astro!`.

It deploys to GitHub Pages from `.github/workflows/pages.yml` on every push to `main` that
touches `docs/`. Pull requests build the site as a check without deploying.

**If you change CLI behaviour, update `SKILL.md`, `README.md` and this site in the same
change.**

## Versioning and changelog

The version is declared **once**, in `package.json`'s `"version"`.

`src/version.ts`'s `VERSION` — the `vk --version` banner **and** the plan-cache
`COMPILER_FINGERPRINT` — is **generated from it at build** by `scripts/gen-version.mjs` (the
`prebuild` script). The same script stamps `.claude-plugin/plugin.json`. **Never hand-edit
either generated file**: bump `package.json` and rebuild. `tests/version.test.ts` fails if the
committed `version.ts` has drifted.

Any change that affects behaviour — a command, flag, selector rule, exit code, the report
format, or the `vk ai` grammar/IR — **bumps the version** (semver: patch for a fix, minor for
a new capability, major for a broken contract) and **adds a `CHANGELOG.md` entry** under
`## [Unreleased]`. The rebuild rotates `COMPILER_FINGERPRINT`, so every cached `vk ai` plan
recompiles against the new build; that is intended.

## Releasing to npm

`verikun` is published to the public npm registry by **pushing a tag**;
`.github/workflows/publish.yml` runs the publish.

Prepare the release in the PR: bump `version`, run `npm run build` (regenerates the two
generated files), and move `CHANGELOG.md`'s `## [Unreleased]` heading to
`## [X.Y.Z] - YYYY-MM-DD`. `npm pack --dry-run` is worth an eyeball before you tag. Once
merged:

```sh
git tag v0.20.0 && git push origin v0.20.0
```

:::caution
**Tag a commit that contains `publish.yml`.** A tag-push event runs the workflow *as of the
tagged commit*, so tagging anything older than the commit that added the workflow does
nothing at all — no run, no error, nowhere to look.
:::

The workflow refuses a tag that disagrees with `package.json`'s version (npm forbids
republishing, so a mismatch has to fail *before* the number is burned), re-checks that the
committed generated files are current, verifies `package-lock.json` is in sync, runs the unit
suite and the packaging check, then publishes with **provenance**.

A tag carrying a prerelease suffix (`v1.0.0-rc.1`) goes out under the `next` dist-tag rather
than `latest`, so `npm install -g verikun` is untouched and testers opt in with
`npm install -g verikun@next`. The GitHub release is marked as a pre-release too, and its
notes come from the section of **the release it is a candidate for** — `v1.0.0-rc.1` uses
`## [1.0.0]` — unless the rc has a `## [1.0.0-rc.1]` section of its own, which then wins.

The GitHub release is a **separate job** — so if the publish succeeded and only that job
failed, *do not* re-push the tag (the republish would fail). Re-run the job, or create the
release by hand.

### Auth

npm **trusted publishing** (OIDC). There is no `NPM_TOKEN` in this repo and nothing to
rotate.

npm's per-package config names the workflow **by filename**, so renaming or moving
`publish.yml` breaks publishing with an auth error at publish time and nothing sooner.
Rename it and the npm side in the same change.

Break-glass: a local `npm login` plus `npm publish` still works, until or unless the npm
account turns on "require 2FA and disallow tokens".

## The repo doubles as a Claude Code plugin

`.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` make this repo installable
as a marketplace plugin. Validate manifest changes with `claude plugin validate .`.

The plugin ships the skill at `.claude/skills/verikun/SKILL.md` — referenced via the
manifest's `"skills": "./.claude/skills/verikun/"`, not moved or duplicated.

`skills` lists **one entry per shipped skill** — never the container `./.claude/skills/`,
which would publish the contributor-only `create-pr` skill, and never just one, which would
drop `suggest-verikun-improvement` even though the main skill hands off to it.
`tests/plugin-manifest.test.ts` derives the expected set from `metadata.internal: true` on
disk, so a new skill fails the test until the manifest lists it.

Because `dist/` is gitignored, an installed plugin carries the skill but **not** a runnable
`vk`; the CLI is a separate npm step.

For what `"files"` must name and why, see
[Contracts](/verikun/internals/contracts/#packaging-files-is-an-allowlist).
