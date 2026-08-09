---
title: Your first test
description: Drive a real device, assert what is on screen, and produce a JUnit + HTML report — in under ten minutes.
sidebar:
  order: 2
---

This walks from a connected device to an HTML report you can open in a browser. It assumes
you have finished [Installation](/verikun/getting-started/installation/).

Every step here is a real command. Nothing is elided.

## 1. Check the device

```sh
vk doctor --fix
vk devices
```

`--fix` zeroes the three animation scales. Animations are the single biggest cause of a UI
dump that reads a screen mid-transition, so this is worth doing once per device.

If `vk devices` lists more than one, pick one for the rest of this page:

```sh
export VERIKUN_DEVICE=emulator-5554     # or a phone serial from `vk devices`
```

## 2. Launch the app under test

```sh
vk launch com.example.app
```

`launch` **restarts by default** — it force-stops the app first, so you begin from a cold
screen rather than wherever a previous session left off. Add `--clear` to also wipe local
data (login, preferences, caches) for a fresh-install state.

## 3. Look at the screen

This is the command that matters most:

```sh
vk ui
```

```
[0] TextView "Welcome back" (540,360)
[1] EditText @email_input (540,720) focused
[2] EditText @password_input (540,860) pwd
[3] Button "Sign in" @sign_in_btn (540,1020) tap
[4] TextView "Forgot password?" @forgot (540,1140) tap
```

Read that as: index, element type, visible text, `@resource-id`, centre coordinates, and
flags (`tap` = clickable, `pwd` = a password field, `focused`, `offscreen`).

This textual snapshot is what you should reach for instead of a screenshot whenever you can.
It is a fraction of the tokens, and it gives you the *identifiers* to act on — a screenshot
only gives you pixels. See
[Be frugal](/verikun/getting-started/using-from-an-agent/#be-frugal-text-over-images).

Useful variants:

```sh
vk ui --all      # keep layout nodes too, not just interactive/labeled ones
vk ui --tree     # indent by nesting, to understand structure
vk ui --json     # structured, for scripting
```

## 4. Act on it

Use the identifiers from step 3, not coordinates:

```sh
vk text @email_input "user@example.com"
vk text @password_input "hunter2" --enter
```

Two things happen automatically here, and they are why flows need so few explicit waits:

- **[Auto-wait](/verikun/reference/auto-wait/)** — the field lookup re-polls the screen for
  up to 5 seconds before giving up, so a form that is still animating in is fine.
- **[Auto-scroll](/verikun/reference/auto-wait/#auto-scroll-into-view)** — if the field is
  below the fold, `text` scrolls it into view first. "Scroll down and tap X" is just
  `vk tap X`.

:::caution
Quote text arguments in your shell. `user@example.com` is escaped correctly for the *device*
shell by verikun, but your *own* shell can still mangle it before verikun ever sees it.
:::

## 5. Assert the result

An assert is what makes this a test rather than a macro:

```sh
vk assert text:"Welcome back" --wait 8s
```

Exit `0` means it passed. Exit `1` means it failed. That is the whole contract, and it is
what CI reads — see [Exit codes](/verikun/reference/exit-codes/).

`assert` polls the whole predicate, not just presence, so `--gone` waits for something to
*disappear*:

```sh
vk assert @loading_spinner --gone --wait 15s
```

## 6. Produce a report

You did not have to start a test run — one auto-started on your first action. Close it:

```sh
vk run archive smoke
```

That writes to `./.verikun/runs/<id>/`:

| File | What it is |
|---|---|
| `report.html` | A self-contained report: every step, the identifier each selector resolved through, screenshots, and the screen + hierarchy of any failed step |
| `report.xml` | JUnit — drops straight into CI |
| `run.json` | The raw recording |
| `artifacts/logcat.txt` | Device log for the run window |

Open `report.html` in a browser.

:::tip
`vk run archive` **exits non-zero when the run contained failures**, so the same command
both produces the report and gates CI. You do not need a separate check step.
:::

## 7. Put it in one file

Running one `vk` per step is fine while exploring. Once the flow is known, put it in a
[batch](/verikun/guides/writing-test-cases/#explicit-steps-vk-batch) file so it runs in a
single process:

```sh
vk batch <<'EOF'
launch com.example.app
text @email_input "user@example.com"
text @password_input "hunter2" --enter
assert text:"Welcome back" --wait 8s
run archive smoke
EOF
```

Each line records as its own step, exactly as if you had typed it, and the batch stops at
the first failure.

## Where to go next

- [Writing test cases](/verikun/guides/writing-test-cases/) — the explicit form vs the
  natural-language form, and when each is right
- [Natural-language tests](/verikun/guides/natural-language-tests/) — write the same test as
  plain English and let `vk ai` compile it
- [Remote devices & CI](/verikun/guides/remote-devices-and-ci/) — run this on a real device
  from a GitHub Actions runner
- [Troubleshooting](/verikun/guides/troubleshooting/) — when a step does not do what you
  expected
