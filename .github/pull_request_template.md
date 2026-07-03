<!--
  Fill in what's relevant and DELETE any section that doesn't apply to this PR —
  keep it lean. The goal is to capture what the diff can't tell a reviewer
  (why, how it was checked, what's out of scope), not to fill every box.
-->

### TL;DR

<!-- One sentence: what this PR does and the resulting behaviour. -->

### What changed?

<!--
  The parts a reviewer can't get from the diff: the approach you took and any
  tradeoff or decision behind it. Don't restate the diff file-by-file — link it
  to the "why" instead.
-->

### Why make this change?

<!-- Motivation, and a link to the issue/ticket. What problem or need prompted it. -->

### How to test?

<!--
  What a reviewer should DO to confirm it works. Skip anything CI already proves —
  the build-and-test job runs `npm run build` (tsc strict) + `npm run test:ci` on
  Node 20.x and 22.x, so don't write "builds clean" or "units pass".
-->

#### New tests

<!--
  New/changed cases in `tests/*.test.ts` (the unit suite covers the platform-agnostic
  core — selectors, parsing, formatting, image, report, args). If none, say why, e.g.
  "driver/platform method — device-verified only" or "covered by existing selector.test.ts".
-->

#### Manual testing performed

<!--
  There is no device CI, so on-device behaviour is only as verified as what you write here.
  Who · device or emulator + OS · which `vk` commands · what you confirmed. e.g.
    - @me on Pixel 7 (Android 14): `vk doctor`, `vk ui`, then `vk tap @login` → screen advanced
  Heads-up: the connected device may be a personal phone — avoid destructive actions
  (submitting forms, creating accounts) while exercising it.
-->

### Docs & contracts

<!-- Tick what applies; delete this block if the PR touches none of it. -->

- [ ] CLI behaviour changed (command / flag / selector / exit code) → updated `README.md` **and** `.claude/skills/verikun/SKILL.md`
- [ ] New command → added to `usageText()` (+ `RECORDABLE` in `run.ts` if it should record)
- [ ] New pure core function → added a `tests/<module>.test.ts` case

### Out of scope & next steps *(optional)*

<!--
  What you deliberately left out and why, known limitations / rough edges, and any
  follow-up or stacked PRs. Delete this section if there's nothing to flag.
-->
