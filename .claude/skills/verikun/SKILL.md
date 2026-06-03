---
name: verikun
description: >-
  Drive and verify a connected Android device/emulator the way Puppeteer drives a
  browser: tap, type, swipe, screenshot, and — most importantly — inspect the UI
  hierarchy by semantic identifiers (resource-id, visible text, accessibility
  label) to confirm what is on screen. Use whenever a task means interacting with
  or asserting the state of a native app on a device/emulator: "tap the login
  button", "type into the email field", "verify the screen shows X", "scroll down
  and check Y", "automate this signup flow", "screenshot the current screen",
  "is the spinner gone yet". Prefer this over raw adb. iOS (--ios): screenshots +
  launch/stop work today via simctl; tap/type/swipe/hierarchy need idb (planned).
---

# verikun — drive & verify mobile apps

`vk` operates a connected Android device/emulator and reads its screen as
structured, **semantic** elements, so you can act and then *verify* — like
Puppeteer for native apps. Prefer it over raw `adb`.

The command is `vk` (after `npm link`) or, if not linked, `node dist/bin/verikun.js`
from the repo root. All examples below use `vk`.

## The loop: act → inspect → assert

1. **See** the screen → `vk ui`
2. **Act** by semantic selector → `vk tap @login_button`
3. **Verify** the result → `vk assert text:"Welcome"` (or `vk ui` again)

Never guess coordinates. Reference elements by their identifiers and let `vk`
resolve the tap point. This is the whole point of the tool.

## Inspect — the core capability

- `vk ui` — compact list of every interactive/labeled element, one per line:
  ```
  [3] Button "Sign in" @sign_in_btn (540,1020) tap
  [4] EditText @email_input (540,720) focused
  ```
  Fields: `[index] Type "text" @resource-id (centerX,centerY) flags`. The `@id`
  token can be pasted straight back into a selector.
- `vk ui --tree` — indented to show nesting. Add `--all` to include layout nodes.
- `vk ui --json` — structured output for parsing.
- `vk find <selector>` — print matching elements; exit 1 if none.
- `vk assert <selector> [--text S] [--gone]` — exit 0 pass / 1 fail. For checks.
- `vk wait <selector> [--gone] [--timeout ms] [--interval ms]` — poll until the
  element appears (or disappears with `--gone`). Essential for async UI.
- `vk current` — foreground app/activity.

## Act

- `vk tap <selector|index>`  ·  `vk tap --at x,y`
- `vk text <selector> "the text" [--clear] [--enter]` — focus the field, then type
- `vk type "text" [--enter]` — type into the already-focused field
- `vk swipe up|down|left|right [--on <selector>] [--distance f] [--duration ms]`
- `vk swipe --from x,y --to x,y [--duration ms]`
- `vk key <name|code>`  ·  `vk back`  ·  `vk home`  ·  `vk enter`
- `vk screenshot [--out path]` — saves a PNG (default `./.verikun/screen.png`) and
  prints the path; then read that file to *see* the screen.
- `vk launch <pkg>`  ·  `vk stop <pkg>`

## Selectors

| Form | Matches |
|---|---|
| `@login` | resource-id (full, `/suffix`, or short name) |
| `id:login` | same as `@login` |
| `text:Sign in` | visible text (case-insensitive; auto-heals) |
| `desc:Submit` | content-desc / accessibility label |
| `class:Button` | simplified type or full class name |
| `"Sign in"` | a bare string == `text:Sign in` |

**Matching auto-heals** — always case-insensitive, trying **exact → partial
(substring) → normalized** (ignore punctuation/whitespace/emoji), stopping at the
first tier that hits. So `text:sign up`, `text:SIGN UP`, and `text:signup` all
find a "Sign up" button. Exact always wins (a partial never shadows an exact
match); a non-exact hit is flagged in the output as `(healed: …)`. Ambiguity is
never auto-resolved — if the winning tier has >1 match, an action lists the
candidates and exits 2 rather than guess.

Modifiers: `--contains` forces substring (skips the exact tier); `--index N`
picks the Nth match (0-based) when a selector intentionally matches several.

## Be frugal: text over images, and remember identifiers

**Perceive with text, not pixels.** `vk ui` / `vk find` / `vk assert` return a
few hundred bytes; a screenshot read back as an image costs far more tokens.
Default to the textual hierarchy to see and verify state. Reach for `vk
screenshot` (then read the PNG) only when you genuinely need pixels — visual
layout, rendering/spacing bugs, or content with no text/id/desc. One image can
outweigh dozens of `vk ui` calls.

**Remember identifiers across runs.** After a flow succeeds, save the selectors
you found to memory — the mapping from human intent to selector, plus the screen
and step order, e.g.:

> Signup flow: "Get Started" → `@get_started`; intro slides → `@continue_btn`
> (tap ×2); plan picker → `text:"Free trial"`; account form → `@email_input`,
> then submit with `text:"Create account"`.

Next time a similar request comes in, **reuse the remembered selectors directly**
instead of re-inspecting from scratch — fewer round-trips, fewer tokens, faster
runs. Re-verify cheaply with `vk assert` / `vk find`; only fall back to a full
`vk ui` when a remembered selector stops resolving (the app changed — then update
the memory). Auto-healing selectors make remembered identifiers resilient to
small label/casing changes.

## Exit codes — rely on these for control flow

- `0` success / found / assertion passed
- `1` not found / assertion failed / wait timeout
- `2` usage error **or ambiguous selector** (refine it or add `--index N`)
- `3` environment error (no device, adb missing, hierarchy dump failed)

## Gotchas

- **Disable animations once** for reliable dumps: `vk doctor --fix`. Live
  animations can make `vk ui` flaky (it already retries 3×).
- **Ambiguous selector → exit 2**, never a random tap. `vk` prints the candidate
  matches; add `--index N` or use a more specific selector.
- **Indexes are per-snapshot.** `vk tap 3` taps `[3]` from the *latest* dump;
  prefer `@id` / `text:` selectors for stability across screens.
- **Text starting with `-`:** put `--` first → `vk type -- "-50% off"`.
- **One device auto-resolves.** Multiple → pass `-d <serial>` or set `VERIKUN_DEVICE`.
- **`vk text` opens the keyboard.** Use `--enter` to submit, or `vk back` to
  dismiss it before re-inspecting (it can cover elements).
- **Unicode/emoji** may not type via `adb input text` (an Android limitation);
  ASCII is reliable.
- **iOS** (`--ios`): `screenshot`, `launch`, `stop` work via simctl; everything
  interactive (tap/type/swipe/`ui`) needs `idb` and is not wired yet.

## Worked example — verify a login flow

```sh
vk doctor --fix                              # deterministic UI
vk launch com.example.app
vk wait @email_input                         # screen ready?
vk text @email_input "user@example.com"
vk text @password_input "hunter2" --enter
vk wait text:"Welcome back" --timeout 8000   # exit 0 → logged in
vk assert @error_banner --gone               # exit 0 → no error shown
```

Check `$?` after `assert`/`wait`/`find` to branch on success vs failure.
