# Examples

Two things live here, and both revolve around the same app:

- **[`example-test.md`](./example-test.md)** — the *showcase*: a natural-language
  [`vk ai`](../README.md#ai--natural-language-tests) test you can read to see what a
  verikun test looks like, and run on either platform.
- **[`flutter-app/`](./flutter-app/)** — the app it drives, and the fixture the device e2e
  suite (`npm run test:e2e`) measures `vk` against. Its README carries the measured,
  per-platform facts about what `vk` actually reports for a Flutter UI.

Everything targets `dev.verikun.testapp`, so there is one source of truth: the same app
backs the prose test, the e2e suite and the documented behaviour. Previously there were two
tests driving stock OEM apps — the stock camera on Android and Settings on iOS — which
depended on whatever shipped on the tester's device, and the Android one really took and
deleted two photos on every run. The single test that replaced them is **non-destructive**
and reproducible on any machine.

`vk suite example` is non-recursive, so it picks up only the `*.md` test here and ignores
the app directory.

## The test

Sign in (type a password into a form whose submit button stays disabled until it is valid,
tick a checkbox), navigate back, then start an **eight-second** load and wait for it —
longer than verikun's default five-second wait window, so an explicit `--timeout` is doing
real work rather than decorating the step.

**One file covers both platforms.** It reaches the back control by label instead of
pressing a hardware Back button, which is required on iOS (there is no hardware Back at
all) and is also the right move on Android, where the soft keyboard is still up after
typing and swallows a hardware Back press. That was found the hard way — the first version
of this test pressed Back on Android and never left the login screen.

The test names the app's semantic identifiers (`vk_user`, `vk_submit`, …) in backticks.
That is deliberate and mirrors the
[selector guidance](../README.md#which-selector-to-reach-for-id-first-text-second-desc-never):
`@id` is the only selector that means the same thing on Android and iOS, and it survives
localisation. It also keeps the test deterministic — it compiles once and replays with no
model calls, rather than healing a different way on every device.

## Prerequisites

- **A built CLI.** `npm run build` from the repo root (`dist/` is gitignored). Optionally
  `npm link` to put `vk` on your PATH; otherwise use `node dist/bin/verikun.js` wherever
  the commands below say `vk`.
- **The fixture app installed on the target.** See
  [`flutter-app/README.md`](./flutter-app/README.md) — in short, `npm run flutter-app:apk`
  (or `:ios`) then `vk install <build output>`.
- **A device or simulator.** List what's attached with `vk devices`; if more than one is
  present, add `--device <serial|udid>`. iOS additionally needs **`idb`** —
  `brew install idb-companion` then `pip install fb-idb`; verify with `vk doctor --ios`.
- **A model for `vk ai`.** Either an API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`,
  read from the environment — *not* from a `.env` file), or an already-logged-in coding
  agent CLI, which needs **no key at all**: `--model codex-cli` or `--model cursor-cli`
  bill to your existing subscription and report `$0`.

## Run it

```sh
# Android — using an already-logged-in Codex CLI, so no API key is needed:
vk ai example/example-test.md --model codex-cli      # first run: compile + run
vk ai example/example-test.md --model codex-cli      # again: cached replay, no model call

# iOS — same file, just add --ios:
vk ai example/example-test.md --model codex-cli --ios

# With an API key instead, --model is optional (Claude is the default):
export ANTHROPIC_API_KEY=sk-ant-...
vk ai example/example-test.md

# Either platform:
vk ai example/example-test.md [--ios] --show-plan    # print the compiled plan, don't run
vk ai example/example-test.md [--ios] --recompile    # ignore the cache, recompile the prose
```

Progress streams to **stderr**; the final **stdout** line is the path to the generated
JUnit + HTML report.

Verified with `--model codex-cli`: **23/23 steps on Android** (Pixel 3a, Android 12) and
**23/23 on an iPhone 17 Pro simulator** (iOS 26.5), with a second run reporting
`plan cache hit` and `repairs=$0.0000`.

## As a gate

Run the whole directory and get one overview report plus a non-zero exit on any failure —
this is what [`.github/workflows/suite.yml`](../.github/workflows/suite.yml) invokes:

```sh
vk suite example --app dev.verikun.testapp --model codex-cli
```

`--app` resets the app between tests.
