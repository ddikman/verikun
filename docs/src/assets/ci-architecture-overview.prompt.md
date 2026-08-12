# Source prompt: `ci-architecture-overview.png`

How the CI architecture diagram on
[Self-healing in CI](../content/docs/guides/self-healing-in-ci.mdx) was produced, so it can be
regenerated rather than reverse-engineered.

Kept here rather than in the page's frontmatter because **Astro/Starlight silently strips
unknown frontmatter keys** — the build succeeds and the value never reaches the output, so it
would look like it worked while discarding the prompt. Measured, not assumed.

- **Model:** `nano-banana-pro` (Gemini 3 Pro Image)
- **Generated:** 2026-08-12
- **Raw output:** 2400×1792, ~3.9 MB PNG

## Post-processing — do not skip

The raw output is ~25× too large to commit. Run it through the same reduction, or the
repository gains a multi-megabyte binary for a flat vector diagram:

```sh
magick raw.png -resize 1600x -strip -colors 64 \
  -define png:compression-level=9 \
  docs/src/assets/ci-architecture-overview.png
```

3.9 MB → ~146 KB with no visible loss (the diagram uses few distinct colours, so a 64-colour
palette is effectively lossless). Astro then serves it as an ~85 KB `.webp`. Check 32 and 128
colours too — which one wins is not monotonic, and 32 has come out smaller *and* fine before.

## Where the image differs from the prompt

The model took three liberties. All cosmetic, none affecting accuracy — noted so a
regeneration that reproduces them is not mistaken for a new bug:

- **4:3 delivered, 16:9 requested.**
- **Two parallel arrows instead of one bidirectional arrow** across the divider. Arguably
  clearer; still reads as a single channel, which is the point.
- **Solid green header bars with a grey subtitle band** on each zone panel — not specified, and
  an improvement.

## The bottom strip is deliberately absent

Earlier drafts of this prompt carried a three-callout strip beneath both panels
("Compile once, replay free" / "Heals drift, not regressions — a failed assertion is never
healed" / "The exit code is the gate"). It was **removed on purpose**; do not "restore" it
thinking it was lost in generation.

The consequence worth knowing: *a failed assertion is never healed* is the load-bearing claim
for the question this page exists to answer, and the image no longer carries it. **The page
prose is its sole carrier.** If the prose is ever trimmed, that claim must not go with it.

## The prompt

Verbatim, as used. Hand it to a model that emits **SVG or HTML/CSS** where possible — this
diagram is ~90% label text, which pure diffusion image models mangle.

```
Create a clean, modern technical infographic titled "How verikun CI run works".

Format: landscape, 16:9, suitable for a slide and for a README hero image.
Style: flat vector, generous whitespace, thin 2px connector lines, rounded rectangles,
subtle drop shadows. Not isometric, not 3D, no clip-art robots or phones-with-faces.
Palette: a deep green primary (#16794a), a warm amber accent for the model/AI elements,
neutral grey for infrastructure, white background. Sans-serif labels (Inter or similar).
Text must be crisp and legible — this diagram is mostly labels.

STRUCTURE — two clearly separated zones, side by side, divided by a vertical dashed
line labelled "private tunnel (e.g. Tailscale)". Exactly ONE arrow crosses that line.

LEFT ZONE — a bordered panel titled "CI runner (throwaway, e.g. ubuntu-latest)"
with a subtitle "holds the model API key and the test files".
Inside it, a numbered vertical flow:
  1. "tests/*.md" — a document icon, labelled "your test, in plain English"
  2. A decision diamond "plan cached?"
     - branch "HIT" (thick green) goes straight to step 4, labelled "no model call — $0"
     - branch "MISS" (thin amber) goes to step 3
  3. An amber-accented box "MODEL — compile to plan IR", marked "once, then cached"
  4. A large box "replay engine" — the heart of the diagram
  5. A box "report.html + index.json" with an "upload as CI artifact" arrow leaving the
     panel downward
Attach an amber callout box to the "replay engine", connected by a short dashed line,
labelled "MODEL — repair a drifted step, or give up (max 3 attempts)". Add a small
caption under it: "woken only when a selector stops resolving".

RIGHT ZONE — a bordered panel titled "Device box (the machine with the phone)"
with a subtitle "no model key, no pull-request code".
Inside it, stacked vertically:
  - a box "vk server"
  - an arrow down to "adb / idb"
  - an arrow down to a simple, clean phone outline labelled "the app under test"

THE SINGLE CROSSING ARROW: a bidirectional arrow between "replay engine" (left) and
"vk server" (right), crossing the dashed divider. Label it in two lines:
  →  "one validated command per HTTP round-trip"
  ←  "pass / fail + step evidence"
Make this arrow visually prominent — it is the main point of the diagram.

CRITICAL ACCURACY CONSTRAINTS — do not redraw these:
  - The model/AI elements appear ONLY in the left zone. The device box never talks
    to a model and holds no API key.
  - The compile step, the plan cache, the replay engine, the repair loop and the
    report are ALL in the left zone.
  - Exactly one arrow crosses between the two zones. Do not draw the plan, the model,
    or the report crossing the divider.
  - Do not label the right zone as running an "engine" or "AI" — it is a proxy that
    executes one command at a time.
```
