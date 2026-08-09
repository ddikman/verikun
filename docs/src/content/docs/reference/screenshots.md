---
title: Screenshots
description: Downscaling flags and their precedence, and why read-back and evidence captures are different things.
sidebar:
  order: 9
---

A device screenshot is large — roughly 1080×2400 — and an agent that reads it back as an
image pays for that **pixel area** in tokens. Yet you seldom need much detail to see what is
on screen.

So `vk screenshot` **downscales by default** to a **700px longest edge**: UI text stays
legible while the image shrinks about 12× in area, and proportionally in tokens.

## Flags

| Flag | Effect |
|---|---|
| *(none)* | Cap the longest edge at **700px**. Never upscales. |
| `--more` | Bump to a higher-detail **1400px** cap when 700 reads too coarse |
| `--max <px>` | Use an exact cap — e.g. `--max 500` to save even more |
| `--full` | Write the original, full-resolution capture |
| `--out <path>` | Destination. Default `./.verikun/screen.png`. |
| `--json` | Structured output |

**Precedence:** `--full` > `--max <px>` > `--more` > `VERIKUN_SHOT_MAX_EDGE` > the default.

## Read-back vs evidence

Keep these two uses apart — they have opposite cost profiles.

**Reading a screenshot back into an agent's context** to decide the next action is what costs
tokens. That is what the downscaling above manages, and what you should avoid where the
textual hierarchy would answer the question. `vk ui` returns a few hundred bytes; one image
can outweigh dozens of `vk ui` calls.

**A screenshot taken purely as report evidence and never read back costs nothing at
runtime.** So when driving a flow to produce a report, capture liberally around transitions
and before verification steps, and leave the PNGs in the report.

[`vk ai`](/verikun/guides/natural-language-tests/) does this automatically — the compiler
inserts `screenshot` steps around transitions and inside loops.

## The resampler

Resizing is a dependency-free, pure-Node PNG resample using a box filter — it parses the PNG,
inflates the image data, reverses the per-scanline filters, box-averages to the target size,
and re-encodes.

**PNGs it cannot safely resample are written through untouched**, with the reason noted on
stderr. That covers palette, 16-bit and interlaced images. A screenshot is therefore never
corrupted — only sometimes left full-size.

It never upscales.

## Failure evidence stays full-resolution

Screenshots captured automatically as failure evidence in test-run reports are **not**
downscaled. Humans read those, and a debugging session is exactly when you want the detail.

Only agent-facing captures go through the downscaler.

## Setting a different default

```sh
export VERIKUN_SHOT_MAX_EDGE=500
```

Ignored unless finite and ≥ 1. See
[Environment variables](/verikun/reference/environment-variables/).
