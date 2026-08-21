# verikun

> **Agent-driven, natural-language mobile tests — during agent development or in CI.** Self-healing and self-improving, with cost caps and test reports.

**📚 [Documentation](https://ddikman.github.io/verikun/)** — installation, guides, full command reference, and internals.

- **Agent CLI** — `vk <command>`: one-shot commands to inspect the screen as a semantic tree (or screenshot) and act on it.
- **Puppeteer for native mobile** — a thin wrapper over native Android and iOS automation runners with zero runtime dependencies.
- **Natural-language tests** — `vk ai <file>`: runs plain-English tests, compiled once and replayed model-free (~$0), calling a model only to self-heal a drifted step. [What that costs](https://ddikman.github.io/verikun/reference/cost/), and how the `--max-cost-usd` ceiling bounds it.
- **Self-improving** — the agent runner will provide prescriptive improvements to existing scripts to help stabilise flakiness for future runs.
- **CI-ready** — `vk suite` runs a folder of tests as one gated pass/fail run; `vk server` exposes a real device over an authenticated tunnel so a disposable CI runner (no phone attached) can still drive it, and moves to another attached device if that one goes bad.

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
npm install -g verikun    # installs the `verikun` and `vk` commands globally
```

Then run `vk doctor` to check your setup. Re-run the install later to upgrade — `vk doctor` warns you when there is a newer release, or when the Claude Code plugin's skill docs have fallen behind the CLI, without failing on either.

The package also carries the agent [`SKILL.md`](.claude/skills/verikun/SKILL.md), the [`CHANGELOG`](CHANGELOG.md) and the [`example/`](example) tests, so they ship with your install. *Registering* that skill with a particular agent is a separate step — see [Installation](https://ddikman.github.io/verikun/getting-started/installation/) for Claude Code, Cursor, Copilot, Windsurf and others.

## Quick start

```sh
vk doctor                       # check adb/device (read-only — never changes anything)
vk device prep --device <id>    # set a TEST device up once: animations off, stays awake
vk devices                      # list attached devices
vk ui                           # semantic snapshot of the current screen
vk tap @login_button            # tap by resource-id
vk text @email "me@example.com" # focus a field and type
vk assert text:"Welcome"        # auto-waits ~5s, then asserts — exit 0 pass / 1 fail
vk run archive smoke            # -> JUnit + HTML report, non-zero exit if anything failed
```

Selector lookups **auto-wait** for the element to appear and **scroll it into view**, so a flow needs far fewer explicit waits and swipes than you would expect.

Walk through the whole thing, including reading the report: **[Your first test](https://ddikman.github.io/verikun/getting-started/your-first-test/)**.

## Skill/plugin instead of MCP

verikun ships as a skill and plugin, not an MCP server, and that is deliberate. A skill lets us **guide the agent on how to use verikun** — when to inspect the hierarchy, what to assert, which command fits the step, and how to read the result back. That domain knowledge travels with the tool, so the agent drives the device *well*, not just correctly.

There is also no need for an MCP here: verikun runs locally with all its dependencies, and the agent calls it through the plain `vk` CLI — no shared session, data, or authentication to broker.

## Documentation

| | |
|---|---|
| **Getting started** | [Installation](https://ddikman.github.io/verikun/getting-started/installation/) · [Your first test](https://ddikman.github.io/verikun/getting-started/your-first-test/) · [Using it from an AI agent](https://ddikman.github.io/verikun/getting-started/using-from-an-agent/) |
| **Guides** | [Writing test cases](https://ddikman.github.io/verikun/guides/writing-test-cases/) · [Natural-language tests](https://ddikman.github.io/verikun/guides/natural-language-tests/) · [Suites](https://ddikman.github.io/verikun/guides/suites/) · [Remote devices & CI](https://ddikman.github.io/verikun/guides/remote-devices-and-ci/) · [iOS setup](https://ddikman.github.io/verikun/guides/ios-setup/) · [Platform support](https://ddikman.github.io/verikun/guides/platform-support/) · [Troubleshooting](https://ddikman.github.io/verikun/guides/troubleshooting/) |
| **Reference** | [Commands](https://ddikman.github.io/verikun/reference/commands/) · [Selectors](https://ddikman.github.io/verikun/reference/selectors/) · [Auto-wait](https://ddikman.github.io/verikun/reference/auto-wait/) · [Global flags](https://ddikman.github.io/verikun/reference/global-flags/) · [Exit codes](https://ddikman.github.io/verikun/reference/exit-codes/) · [Environment variables](https://ddikman.github.io/verikun/reference/environment-variables/) · [Reports & test runs](https://ddikman.github.io/verikun/reference/reports-and-test-runs/) · [Device state](https://ddikman.github.io/verikun/reference/device-state/) · [Device claims](https://ddikman.github.io/verikun/reference/device-claims/) · [Screenshots](https://ddikman.github.io/verikun/reference/screenshots/) · [AI plans & models](https://ddikman.github.io/verikun/reference/ai-plans/) |
| **Internals** | [Architecture](https://ddikman.github.io/verikun/internals/architecture/) · [Core principles](https://ddikman.github.io/verikun/internals/core-principles/) · [Plan IR & the replay engine](https://ddikman.github.io/verikun/internals/plan-ir-and-engine/) · [Contracts](https://ddikman.github.io/verikun/internals/contracts/) · [Contributing](https://ddikman.github.io/verikun/internals/contributing/) |

**Exit codes**, since they are the machine contract everything else rests on: `0` success · `1` not found / assertion failed / timeout · `2` usage error, ambiguous selector, or a device another job is driving · `3` environment error. Data goes to stdout; diagnostics to stderr. [Full contract](https://ddikman.github.io/verikun/reference/exit-codes/). Parallel agents share a host-level [device claim](https://ddikman.github.io/verikun/reference/device-claims/) so two jobs do not silently land on the same phone.

## Feedback — help improve verikun

verikun improves from the rough edges people hit while driving it. When verikun *itself* is the friction — a step that heals on every cached replay (an unstable compiled selector, often a label-only control with no resource-id), a repair "give-up", or a gotcha in its own operation — that's worth an issue at [github.com/ddikman/verikun/issues](https://github.com/ddikman/verikun/issues).

Driving verikun with an AI agent + the [skill](.claude/skills/verikun/SKILL.md)? It hands off to the **`suggest-verikun-improvement`** skill, which writes a short, TL;DR-first suggestion **to a local file for you to read and edit**, **files nothing until you say so**, and **redacts every app-under-test specific** (package, on-screen text, selector values, test prose, logs) so no client code or logic can leak.

## Contributing

```sh
git clone https://github.com/ddikman/verikun && cd verikun
npm install      # dev deps (typescript, @types/node); also builds dist/ via the prepare hook
npm test         # type-check + the unit suite (no device needed)
npm link         # optional: put `verikun` and `vk` on your PATH
```

Zero runtime dependencies; the only dev dependencies are `typescript` and `@types/node`. The full contributor guide — the test loop, the Flutter device fixture, versioning and releasing — is in [Contributing](https://ddikman.github.io/verikun/internals/contributing/).

To work on the [documentation site](https://ddikman.github.io/verikun/), which is an Astro Starlight project in `docs/` with its own dependencies (so `npm install` above does not cover it):

```sh
npm run docs:install   # once — installs the site's dependencies (needs Node >= 22.12)
npm run docs           # dev server with live reload at http://localhost:4321/verikun/
npm run docs:build     # production build; fails on a dead internal link
```

Open **http://localhost:4321/verikun/** — the site is served under a base path, so bare `localhost:4321` is a 404. Astro needs **Node ≥ 22.12** while the CLI supports Node ≥ 18, so `nvm use 22` first if your shell's Node is older.

## License

[MIT](LICENSE)
