# Example: a natural-language `vk ai` test

[`example-test.md`](./example-test.md) is a complete
[`vk ai`](../README.md#ai--natural-language-tests) test written **entirely in plain
English** — no resource-ids, indexes, or device-specific selectors are hard-coded. It
drives the stock Android camera: open the camera, then **take a photo at 2× zoom and
delete it — twice.**

It is kept deliberately natural-language so you can watch `vk ai` do its whole job:
compile the prose into a deterministic plan once, **self-heal** the selectors that don't
resolve verbatim (the `2.0X zoom` description is ambiguous → it adds `--index`; the trash
icon's real id turns out to be `oneup_delete`; …), then **replay the cached plan
model-free** on every later run.

## Prerequisites

- **A built CLI.** `npm run build` from the repo root (`dist/` is gitignored). Optionally
  `npm link` to put `vk` on your PATH; otherwise use `node dist/bin/verikun.js` wherever
  the commands below say `vk`.
- **A connected Android device or emulator** with the stock Camera app
  (`com.android.camera`). List what's attached with `vk devices`; if more than one is
  connected, add `--device <serial>`.
- **`ANTHROPIC_API_KEY` in the environment.** `vk ai` needs it to compile the test and to
  repair a drifted step. It is **not** read from a `.env` file automatically, so export it
  first (`export ANTHROPIC_API_KEY=sk-ant-…`).

## Run it

```sh
export ANTHROPIC_API_KEY=sk-ant-...          # vk ai reads it from the environment

vk ai example/example-test.md                # first run: compile + run (heals a few selectors)
vk ai example/example-test.md                # run again: replays the cached plan, no model call ($0)
vk ai example/example-test.md --show-plan    # just print the compiled plan, don't run
vk ai example/example-test.md --recompile    # ignore the cache and recompile from the prose
```

Progress streams to **stderr**; the final **stdout** line is the path to the generated
JUnit + HTML report. The first run costs a few cents (one compile + a couple of repairs)
and prints any **suggested improvements** (the heals it applied, which you could fold back
into the prose to skip them); every green run after that replays for `$0`.

> **Heads-up:** the test really takes and deletes two photos on each run (deletes go to
> the recycle bin, so they're recoverable). It was verified against the stock camera on a
> Xiaomi/HyperOS phone — on a very different camera app the prose may need a small tweak,
> but because the test is healing-driven, most selector differences are absorbed
> automatically.
