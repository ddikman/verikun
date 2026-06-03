# verikun

Drive a connected Android device/emulator (and, later, iOS simulators) the way
Puppeteer drives a browser — **tap, type, swipe, screenshot**, and most
importantly **inspect the UI hierarchy by semantic identifiers** so an AI agent
can act and then *verify* what happened.

It is a thin, deterministic, zero-runtime-dependency wrapper over `adb` (and
`xcrun simctl` for iOS) that turns the raw `uiautomator` dump into a compact,
token-efficient list of meaningful elements addressable by `resource-id`,
visible text, accessibility label, or class.

```
$ vk ui
[0] TextView "Welcome back" (540,360)
[1] EditText @email_input (540,720) focused
[2] EditText @password_input (540,860) pwd
[3] Button "Sign in" @sign_in_btn (540,1020) tap
[4] TextView "Forgot password?" @forgot (540,1140) tap

$ vk tap @sign_in_btn
tapped [3] Button "Sign in" @sign_in_btn (540,1020) tap
```

## Install

Requires Node ≥ 18 and the Android platform-tools (`adb`) on your `PATH`.

```sh
npm install      # dev deps (typescript, @types/node) only
npm run build    # compile src/ -> dist/
npm link         # optional: put `verikun` and `vk` on your PATH
```

Without `npm link`, run it as `node dist/bin/verikun.js <command>`.

### Install as a Claude Code plugin

This repo doubles as a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). Installing the plugin gives Claude the `verikun` skill — the agent-facing usage guide — so it knows how to drive devices.

```sh
/plugin marketplace add ddikman/verikun   # add this repo as a marketplace
/plugin install verikun@verikun           # install the plugin (ships the skill)
```

The plugin ships the **skill**; the `vk` **CLI** is a separate Node package — build and link it from a clone (see [Install](#install) above) so `vk` lands on your `PATH`. The compiled `dist/` is gitignored, so it isn't bundled into the installed plugin.

## Quick start

```sh
vk doctor --fix                 # check adb/device; disable animations for stable dumps
vk devices                      # list attached devices
vk ui                           # semantic snapshot of the current screen
vk tap @login_button            # tap by resource-id
vk text @email "me@example.com" # focus a field and type
vk wait text:"Welcome" --timeout 8000
vk screenshot                   # -> ./.verikun/screen.png
```

## Commands

### Inspect
| Command | Description |
|---|---|
| `ui [--all] [--tree] [--json]` | Compact list of interactive/labeled elements. `--all` keeps layout nodes; `--tree` indents by nesting; `--json` is structured. |
| `find <selector> [--json]` | Print elements matching a selector. Exit 1 if none. |
| `assert <selector> [--text S] [--gone] [--contains]` | Assertion for tests. Exit 0 pass / 1 fail. |
| `wait <selector> [--timeout ms] [--interval ms] [--gone]` | Poll the hierarchy until match (or absence). Exit 1 on timeout. |
| `current` | Best-effort foreground app/activity. |

### Act
| Command | Description |
|---|---|
| `tap <selector\|index>` / `tap --at x,y` | Tap an element (or raw coordinates). A bare integer taps `[index]` from the latest `ui`. |
| `text <selector> <text…> [--clear] [--enter]` | Focus a field and type. `--clear` deletes existing text first. |
| `type <text…> [--enter]` | Type into the currently focused field. |
| `key <name\|code>` / `back` / `home` / `enter` | Send a key event (named keys or a raw Android keycode). |
| `swipe <up\|down\|left\|right> [--on <selector>] [--distance f] [--duration ms]` | Directional swipe over the screen (or within an element via `--on`). `--distance` is a fraction of the region (default 0.6). |
| `swipe --from x,y --to x,y [--duration ms]` | Explicit swipe between two points. |
| `screenshot [--out path] [--json]` | Save a PNG (default `./.verikun/screen.png`); prints the path. |
| `launch <app>` / `stop <app>` | App lifecycle by package id (Android) / bundle id (iOS). |

### Environment
| Command | Description |
|---|---|
| `devices [--json]` | List attached devices/simulators. |
| `doctor [--fix]` | Diagnose adb + device; `--fix` sets the three animation scales to 0 for deterministic UI. |

## Selectors

```
@login          shorthand for id:login
id:login        resource-id — matches full id, idShort, or a "/login" suffix
text:Sign in    visible text (exact, case-insensitive, trimmed)
desc:Submit     content-desc / accessibility label
class:Button    simplified type ("Button") or full class ("android.widget.Button")
"Sign in"       a bare string is treated as text: (exact)
```

Modifiers: `--contains` makes text/desc matches substring-based; `--index N`
selects the Nth match (0-based) when a selector intentionally matches several.
If a selector for an action matches more than one element and no `--index` is
given, the command fails with exit code 2 and lists the candidates — it never
taps a guess.

## Global flags

| Flag | Meaning |
|---|---|
| `-d, --device <serial>` | Target a specific device (or `VERIKUN_DEVICE` / `ANDROID_SERIAL`). |
| `-p, --platform <android\|ios>` | Platform (default `android`). `--ios` / `--android` are shortcuts. |
| `-j, --json` | Machine-readable output (also serializes errors). |
| `--` | End flag parsing, so text/arguments may start with `-`. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success / found / assertion passed |
| `1` | not found / assertion failed / wait timeout |
| `2` | usage error or ambiguous selector (caller must refine) |
| `3` | environment error (adb/simctl missing, no/multiple devices, dump failed) |

Data goes to stdout; diagnostics/errors go to stderr.

## How it works

```
cli.ts ──> drivers/ ──> adb / xcrun        (platform I/O)
   │           └─ produces normalized Element[]
   ├─ ui/android-parse.ts   uiautomator XML -> Element[]
   ├─ ui/selector.ts        @id / text: / desc: / class: matching
   └─ ui/format.ts          compact / tree / json rendering
```

The `Driver` interface (`src/types.ts`) is the seam between platforms. The
selector, formatting, and command layers operate only on the normalized
`Element[]`, so they are entirely platform-agnostic.

- **Android** (`drivers/adb.ts`): `uiautomator dump` for the hierarchy,
  `screencap -p` for screenshots, `input tap/text/swipe/keyevent`, `wm size`.
- **iOS** (`drivers/simctl.ts`): `screenshot`, `launch`, `stop` work today via
  `xcrun simctl`. Full interaction and hierarchy inspection are planned via
  WebDriverAgent — see [iOS roadmap](#ios-roadmap) below.

Run artifacts (screenshots, dumps) are written under `./.verikun/` (gitignored).

## iOS roadmap

Today `vk --ios` supports **screenshots, launch, and stop** via `xcrun simctl`.
Tapping, swiping, typing, and `vk ui` hierarchy inspection are not yet wired up.

The planned backend is **[WebDriverAgent](https://github.com/appium/WebDriverAgent)**
(WDA) — an open-source XCTest HTTP server maintained by the Appium team. It
requires no Python and works on both simulators and physical devices. Once WDA
is running, `vk` will drive it over HTTP and the command layer stays unchanged.

**One-time setup (when this lands):**
1. Clone WebDriverAgent and open it in Xcode
2. Set your Apple developer signing team
3. Build & run on the target device or simulator
4. `vk --ios tap`, `vk --ios ui`, etc. will work automatically

Until then, running any unsupported iOS command prints an explanation and exits
with code 3.

## Using it from an AI agent

See [`.claude/skills/verikun/SKILL.md`](.claude/skills/verikun/SKILL.md) — the
companion skill that teaches the act → inspect → assert loop, selector grammar,
exit-code semantics, and gotchas.

### Example: full onboarding walkthrough

A Claude agent drove a multi-step Android onboarding flow end-to-end using only
`vk` commands — no coordinates, no hardcoded waits beyond `sleep 1` on
transitions.

```sh
# 1. See where we are
vk screenshot               # read PNG to confirm current screen

# 2. Welcome splash
vk tap @get_started_button_id

# 3. Intro/explainer screens — same button each time
vk tap @tap_to_continue_label_id
vk tap @tap_to_continue_label_id

# 4. Scrollable list — scroll until the item is visible, then tap
vk swipe up
vk tap @target_item_id

# 5. Transition screen after selection
vk tap @tap_to_continue_label_id

# 6. Option grid — inspect to find the right index, tap it
vk ui                        # [4] ImageView desc="My preferred option"
vk tap 4

# 7. Final screen before sign-up
vk tap @tap_to_continue_label_id
# → sign-up screen reached; onboarding complete
```

**Cost:** $0.45 · **Wall time:** ~4 min · **Model:** Claude Sonnet 4.6 with
prompt-cache hits (1 M cache-read tokens kept cost low on a long conversation).

## Development

```sh
npm run dev      # tsc --watch
npm run build    # one-off compile
```

Zero runtime dependencies; the only dev dependencies are `typescript` and
`@types/node`.
