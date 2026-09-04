---
title: Writing test cases
description: The two ways to write a verikun test — explicit batch steps and natural-language prose — and when each is the right choice.
sidebar:
  order: 1
---

There are two ways to write a verikun test. They produce the **same reports** and the
**same exit codes**; they differ in who writes the steps.

| | [`vk batch`](#explicit-steps-vk-batch) | [`vk ai`](#natural-language-vk-ai) |
|---|---|---|
| You write | exact commands | plain English |
| Runs | deterministically, always | deterministically after the first compile |
| Cost | \$0 | \$0 on the happy path; you pay to compile and to repair |
| Control flow | none — a flat list | conditions, loops, branches |
| Recovers from a changed UI | no | yes, by asking the model to repair the step |
| Needs a model key | no | yes, unless you use a [CLI backend](/verikun/reference/ai-plans/#models) |

A useful rule: **`batch` for a flow you control and want pinned; `ai` for a flow that drifts
or has optional steps.**

## Explicit steps: `vk batch`

`vk batch` reads newline-separated commands — from `--file <path>`, or piped on **stdin** —
and runs each **exactly as if you had typed it as its own `vk` command**: the same
[selector auto-wait](/verikun/reference/auto-wait/), the same
[test-run recording](/verikun/reference/reports-and-test-runs/) (every line is its own
step), and the same stdout/stderr split and [exit codes](/verikun/reference/exit-codes/).

```sh
vk batch --file login.flow            # from a file

vk batch <<'EOF'                      # …or piped on stdin
launch com.example.app
text @email_input "user@example.com"
text @password_input "hunter2" --enter
assert text:"Welcome back" --wait 8s
EOF
```

What it guarantees:

- **Each result streams to stdout** as the command finishes — the same bytes you would get
  running the line on its own.
- **It stops at the first command that exits non-zero**, noting where it halted (on stderr)
  and **exiting with that command's code**. A failed `tap` or `assert` means the rest of the
  flow can no longer be trusted, so it breaks rather than pressing on.
- **Blank lines and `#` comments** are skipped, so a flow file can be annotated.
- **Globals on the `batch` call carry into every line** unless a line overrides them —
  `--device`, `--platform` / `--ios` / `--android`, and `--json`. So `vk batch --ios --file f`
  runs the whole flow against the simulator.
- `--quiet` silences the per-line progress notes on stderr; stdout data is untouched.

Because each line records like an individual action, ending a batch with `run archive` turns
the flow into a JUnit + HTML report in one shot:

```sh
printf 'launch com.example.app\nassert @home_tab\nrun archive smoke\n' | vk batch
```

:::tip
`batch` uses **no host shell**, so a value like `bob+tag@mail.com` reaches the device
verbatim. Running the same line from your own shell needs quoting.
:::

### A worked login flow

```sh title="login.flow"
# Fresh start — launch force-stops first, so this is a real reset
launch com.example.app --clear

# The field lookups auto-wait up to 5s; no explicit `wait` needed
text @email_input "user@example.com"
text @password_input "hunter2" --enter

# Verification. These are what make it a test.
assert text:"Welcome back" --wait 8s
assert @error_banner --gone

# Turn the recording into report.html + report.xml, and gate on it
run archive login-smoke
```

```sh
vk batch --file login.flow
echo $?     # 0 = green, 1 = a step failed, 2/3 = usage or environment
```

## Natural language: `vk ai`

The same test as prose:

```md title="login.md"
Launch com.example.app fresh.
If a "Allow notifications" dialog appears, dismiss it.
Type user@example.com into the email field and hunter2 into the password field, then submit.
Assert that "Welcome back" is visible and no error banner is shown.
```

```sh
vk ai login.md
```

`vk ai` treats the model as a **compiler, not a runtime**: it compiles the prose into a
deterministic plan once, caches it, and replays it with no model calls at all. The model
wakes only to repair a step whose selector stopped resolving.

Two things this buys you that `batch` cannot express:

- **Optional steps.** `If a permission dialog appears, allow it` compiles to an `if-present`
  guard. In `batch` you would need to run a probe, check `$?`, and branch in shell.
- **Bounded loops.** `Scroll until the row appears` compiles to a `repeat` with a hard
  iteration cap and a no-progress early exit.

See [Natural-language tests](/verikun/guides/natural-language-tests/) for the full model,
and [AI plans & models](/verikun/reference/ai-plans/) for the plan grammar.

## Which selectors to write

This matters more than the format you choose. In order of preference: **`@id`** (the only
selector that survives localisation and copy changes), **`text:`** (falls back to the
accessibility description), **`desc:`** (Android in practice — on iOS the label arrives as
`text`), then **`class:`** (mostly useless with Flutter). The reasoning and the per-platform
matrix: [Selectors](/verikun/reference/selectors/#which-selector-to-reach-for).

## Make each test self-isolating

A test should not depend on what the previous test left behind. Start it from a known
state:

```
launch com.example.app --clear    # wipes login/session/prefs, then starts fresh
```

If you are running a [suite](/verikun/guides/suites/), `vk suite --app <id>` does this
between tests for you.

:::caution
`--clear` is Android-only — iOS has no per-app data reset, and `vk suite --app` degrades to
a force-stop there. If a test must run on both, do not rely on data being wiped; rely on
`launch` restarting the app.
:::

## Assert deliberately

An assertion failure is **terminal** — `vk ai` will never heal one, by design, because
healing a real regression is the worst thing a test tool can do. That makes `assert` the
place to state what you actually mean:

```sh
assert text:"Welcome back" --wait 8s        # it appeared within 8s
assert @loading_spinner --gone --wait 15s   # it went away within 15s
assert @submit --enabled                    # it is actually pressable, not just present
assert @email_input --text "user@example.com"   # the field holds this value
```

`--enabled` deserves special mention: a Submit button the app disables until a form is valid
is *present* long before it is *usable*. Asserting or tapping presence taps a dead control.

## Where to go next

- [Suites](/verikun/guides/suites/) — run a directory of tests as one gated pass/fail run
- [Reports & test runs](/verikun/reference/reports-and-test-runs/) — what gets recorded and
  what the report contains
- [Troubleshooting](/verikun/guides/troubleshooting/) — when a step does not behave
