---
title: Installation
description: Install the verikun CLI, connect a device, and register the agent skill.
sidebar:
  order: 1
---

## Requirements

- **Node ≥ 18**
- **Android platform-tools** (`adb`) on your `PATH` — for Android devices and emulators
- **[`idb`](https://github.com/facebook/idb)** — only if you want to drive iOS. See
  [iOS setup](/verikun/guides/ios-setup/).

## Install the CLI

```sh
npm install -g verikun    # installs the `verikun` and `vk` commands globally
```

Re-run the same command later to upgrade.

Then check your setup:

```sh
vk doctor
```

`vk doctor` reports whether `adb` is present, whether exactly one device is resolvable, whether
the device has been prepared for testing, and whether it has a screen lock. It is **read-only**
— it never changes a device.

To actually set a test device up, prepare it once. This turns animations off, keeps the display
awake, silences notifications and disables battery idle:

```sh
vk device prep --device <serial>   # a physical device must be named
vk device prep                     # an emulator is auto-selected
```

The `--device` requirement is the point: prep changes settings that outlive the run, so it must
never land on a personal phone that happened to be plugged in. `vk device prep --revert` puts it
back. `vk doctor --fix` is an alias for the same thing and inherits the same gate. Full detail:
[Device state](/verikun/reference/device-state/#preparing-a-test-device).

:::note
The package also carries the agent
[`SKILL.md`](https://github.com/ddikman/verikun/blob/main/.claude/skills/verikun/SKILL.md),
the [changelog](https://github.com/ddikman/verikun/blob/main/CHANGELOG.md) and the
[`example/`](https://github.com/ddikman/verikun/tree/main/example) tests, so they ship with
your install. *Registering* that skill with a particular agent is a separate step — the two
sections below do that.
:::

## Connect a device

Any of these works:

- **A physical Android phone** over USB with developer options and USB debugging enabled, or
  over wireless adb.
- **An Android emulator** (`emulator -avd <name>`, or start one from Android Studio).
- **An iOS simulator** (`xcrun simctl boot <name>`, or Simulator.app) — see
  [iOS setup](/verikun/guides/ios-setup/).

Confirm verikun can see it:

```sh
vk devices
```

If more than one device is attached, every command needs
[`--device <serial>`](/verikun/reference/global-flags/) (or the `VERIKUN_DEVICE`
environment variable) — verikun will not guess which one you meant, and exits `3` instead.

## Register the skill with your agent

The CLI is what drives the device. The **skill** is what teaches an AI agent to drive it
well — the act → inspect → assert loop, the selector grammar, exit-code semantics, and the
gotchas. Installing one does not install the other.

### Claude Code plugin

This repository doubles as a Claude Code
[plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces):

```sh
/plugin marketplace add ddikman/verikun   # add this repo as a marketplace
/plugin install verikun@verikun           # install the plugin
```

The plugin ships the **skill**; the `vk` **CLI** is a separate Node package, so install it
with `npm install -g verikun` as above. Because they update independently they can fall out
of step — [Keeping it up to date](#keeping-it-up-to-date) covers how to notice.

### Cursor, Copilot, Windsurf, and others

The skill is a plain `SKILL.md` with `name`/`description` frontmatter, so
[`vercel-labs/skills`](https://github.com/vercel-labs/skills) can install it into any of the
70+ agents it supports:

```sh
npx skills add ddikman/verikun --skill verikun    # pick your agent when prompted
```

Add `--agent cursor` (or `windsurf`, `github-copilot`, `opencode`, …) to target one
directly, and `-g` to install globally rather than into the current project. As with the
plugin, this installs the **skill** only — the CLI still comes from
`npm install -g verikun`.

## Keeping it up to date

`vk doctor` warns when either half is stale:

```
verikun: 0.19.0 — npm has 0.20.0
  npm install -g verikun@latest
claude-code-plugin: 0.11.0 — behind this CLI (0.20.0); the agent is reading stale skill docs
  claude plugin update verikun@verikun   (then restart Claude Code)
```

The second matters more than it looks: the skill teaches an agent *how* to drive verikun, so
a stale one means an agent confidently using a flag your CLI no longer has. That is why the
skill asks the agent to run `vk doctor` once at the start of a session.

Both are warnings — being out of date does not change doctor's exit code. Set
`VERIKUN_NO_UPDATE_CHECK=1` to skip the check entirely.

:::caution[Claude Code will not update the plugin for you by default]
Marketplace auto-update is **off by default for third-party marketplaces**, and no plugin
author can turn it on — the setting lives in your own config. Turn it on under `/plugin` →
**Marketplaces** → **verikun**, or refresh by hand with `/plugin marketplace update verikun`.
:::

## Build from source

To run an unreleased version, or to work on verikun itself:

```sh
git clone https://github.com/ddikman/verikun && cd verikun
npm install      # dev deps + builds dist/ via the prepare hook
npm link         # optional: put `verikun` and `vk` on your PATH
```

Without `npm link`, invoke it as `node dist/bin/verikun.js <command>`. See
[Contributing](/verikun/internals/contributing/) for the watch/test loop.

## Next

[Your first test →](/verikun/getting-started/your-first-test/)
