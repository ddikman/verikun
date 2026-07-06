# Examples: natural-language `vk ai` tests

Two complete [`vk ai`](../README.md#ai--natural-language-tests) tests written **entirely in
plain English** — no resource-ids, indexes, or device-specific selectors hard-coded. Each
lets you watch `vk ai` do its whole job: compile the prose into a deterministic plan once,
**self-heal** the selectors that don't resolve verbatim, then **replay the cached plan
model-free** (`$0`) on every later run.

- **Android — [`example-test.md`](./example-test.md):** drives the stock camera
  (`com.android.camera`): open it, then **take a photo at 2× zoom and delete it — twice.**
  Watch it heal — the `2.0X zoom` description is ambiguous so it adds `--index`, and the
  trash icon's real id turns out to be `oneup_delete`.
- **iOS — [`example-test-ios.md`](./example-test-ios.md):** drives the stock Settings app
  (`com.apple.Preferences`): open **General → About**, verify the device details, navigate
  back (iOS has no hardware Back — you tap the on-screen control, whose label is the
  previous screen's title), then **search** the settings. Non-destructive.

## Prerequisites

- **A built CLI.** `npm run build` from the repo root (`dist/` is gitignored). Optionally
  `npm link` to put `vk` on your PATH; otherwise use `node dist/bin/verikun.js` wherever
  the commands below say `vk`.
- **A device/simulator with the target app.** List what's attached with `vk devices`; if
  more than one is present, add `--device <serial|udid>`.
  - *Android:* a connected device or emulator with the stock Camera app
    (`com.android.camera`).
  - *iOS:* a booted simulator (or a connected device) plus **`idb`** for interaction —
    `brew install idb-companion` then `pip install fb-idb`. Verify the toolchain with
    `vk doctor --ios`.
- **`ANTHROPIC_API_KEY` in the environment.** `vk ai` needs it to compile the test and to
  repair a drifted step. It is **not** read from a `.env` file automatically, so export it
  first (`export ANTHROPIC_API_KEY=sk-ant-…`).

## Run it

```sh
export ANTHROPIC_API_KEY=sk-ant-...            # vk ai reads it from the environment

# Android (stock camera):
vk ai example/example-test.md                  # first run: compile + run (heals a few selectors)
vk ai example/example-test.md                  # again: replays the cached plan, no model call ($0)

# iOS (stock Settings) — just add --ios:
vk ai --ios example/example-test-ios.md        # first run: compile + run + heal
vk ai --ios example/example-test-ios.md        # again: cached replay ($0)

# Either one:
vk ai <file> [--ios] --show-plan               # just print the compiled plan, don't run
vk ai <file> [--ios] --recompile               # ignore the cache and recompile from the prose
```

Progress streams to **stderr**; the final **stdout** line is the path to the generated
JUnit + HTML report. The first run costs a few cents (one compile + a couple of repairs)
and prints any **suggested improvements** (the heals it applied, which you could fold back
into the prose to skip them); every green run after that replays for `$0`.

> **Heads-up:**
> - The Android test really takes and deletes two photos each run (deletes go to the
>   recycle bin, so they're recoverable). Verified against the stock camera on a
>   Xiaomi/HyperOS phone.
> - The iOS test is **non-destructive** — it only navigates Settings and types into the
>   search field. Its steps were verified on an iPhone 17 Pro simulator (iOS 26.5).
>
> Both are healing-driven, so on a different app version most selector differences are
> absorbed automatically — occasionally the prose may need a small tweak.
