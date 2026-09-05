---
title: Selectors
description: The selector grammar, auto-healing tiers, state modifiers, and which selector kind to reach for on each platform.
sidebar:
  order: 2
---

## Grammar

```
@login          shorthand for id:login
id:login        resource-id — matches full id, idShort, or a "/login" suffix
text:Sign in    visible text (exact, case-insensitive, trimmed)
desc:Submit     content-desc / accessibility label
class:Button    simplified type ("Button") or full class ("android.widget.Button")
"Sign in"       a bare string is treated as text: (exact)
```

## Modifiers

| Modifier | Effect |
|---|---|
| `--contains` | Make text/desc matches substring-based (drops the `exact` tier) |
| `--index N` | Select the Nth match, 0-based, when a selector intentionally matches several |

If a selector for an **action** matches more than one element and no `--index` is given, the
command fails with exit `2` and lists the candidates. **It never taps a guess.**

## Auto-healing

Matching is always case-insensitive and tries progressively looser **tiers**, stopping at the
first that yields any match:

| Tier | Matches |
|---|---|
| `exact` | The value as written |
| `partial` | Substring |
| `normalized` | Case, punctuation, whitespace and emoji all stripped |

So `text:sign up`, `text:SIGN UP` and `text:signup` all find a "Sign up" button.

`--contains` drops the `exact` tier. `--index N` picks the Nth within the **winning** tier.

When a match heals — that is, resolves at a tier other than `exact` — verikun appends
` (healed: <tier> match)` to stderr, so you can tighten the selector if you want to.

:::note
**Ambiguity is never auto-resolved.** If the winning tier has more than one match and no
`--index` is given, the command throws exit `2` listing the candidates. Actions never tap a
guess.
:::

## State modifiers

A selector can also require an element's accessibility **state**, in both polarities:

| Modifier | Matches | Negative form |
|---|---|---|
| `--enabled` | actionable right now | `--not-enabled` |
| `--selected` | the current option of a segmented control, tab bar or mode picker | `--not-selected` |
| `--checked` | a ticked checkbox, switch or radio | `--not-checked` |
| `--focused` | the element holding input focus | `--not-focused` |

**Unset means *don't care*.** These never narrow a selector you did not ask them to. Passing
both `--x` and `--not-x` is a usage error (exit `2`).

State modifiers narrow the candidate pool *before* the tier ladder runs, so a state-matching
exact hit can never shadow a state-matching partial one.

### Why `--enabled` matters

Reach for it on a Submit or Check button the app disables until a form is valid. Such a
button is **present long before it is usable**, so tapping presence taps a dead control.

Combined with [auto-wait](/verikun/reference/auto-wait/) this reads as "wait until it is
pressable":

```sh
vk tap @submit --enabled
```

### Why the negative forms matter

They are what make a toggle drivable. A segmented control whose options share one handler
*flips* on any tap, so "tap the option I want" lands on the other one whenever it was already
chosen — exit `0`, nothing to notice, and the run exercises the wrong mode.

Guard it instead:

```sh
vk find "@mode_video --not-selected" --no-wait && vk tap @mode_video
```

### Writing a modifier into the selector string

A modifier can be written as a flag **or appended to the selector string**, as above.

The string form exists because a [`vk ai`](/verikun/reference/ai-plans/) control node
(`if-present`, `when`, `repeat`, `while-present`, `read`) holds a bare selector with nowhere
to put a flag — and a guard is exactly where the toggle case needs one:

```
if-present "id:mode_video --not-selected" { tap id:mode_video }
```

### Platform support

**`--selected` and `--focused` are Android-only.** `idb` reports no such attribute for iOS —
not merely unset, the key does not exist in its output — so using them with `--ios` exits
**`3`** rather than silently matching nothing.

A filter that could only ever match nothing is exactly the false signal these modifiers exist
to prevent, so refusing is the honest answer.

`--enabled` and `--checked` work on both platforms.

## Which selector to reach for

`@id` first, `text:` second, `desc:` never. Not all four kinds travel equally well, and if a
flow has to run on both Android and iOS this ordering matters:

| selector | Android | iOS | portable? |
|---|---|---|---|
| `@id` | `resource-id` | `AXUniqueId` | **yes — always prefer this** |
| `text:` | visible text, falling back to `content-desc` | `AXLabel` / `title` / `AXValue` | yes |
| `desc:` | `content-desc` | `accessibilityHint` only | **no — Android in practice** |
| `class:` | widget class | element role | no — see below |

### Two traps

- **`desc:` does not fall back.** `text:` falls back to `desc` when no text matches, so a
  `text:Submit` selector finds an element carrying only an accessibility label. The reverse
  is not true — `desc:Submit` will never match visible text. On iOS an accessibility label
  arrives as `text`, so a `desc:` selector written against Android **silently stops
  matching** there.
- **`class:` is mostly useless on a cross-platform UI toolkit.** Flutter text inputs report
  as `android.widget.EditText` / `TextField`, but almost everything else is
  `android.view.View` — so `class:Button` cannot match a Flutter button regardless of what
  the widget actually is.

### The sharper reason to prefer `@id`

It is the only selector that is **not text**, so it survives **localisation**. A flow pinned
with `text:` breaks the moment the device is in a different language.

For a Flutter app, `@id` comes from `Semantics(identifier:)`; `Semantics(label:)` gives you
`desc` on Android but `text` on iOS. A worked example, with the cross-platform gotchas
measured on real hardware, is in
[`example/flutter-app`](https://github.com/ddikman/verikun/tree/main/example/flutter-app).

## Where this is implemented

`src/ui/selector.ts` is pure and **time-free** — matching is a function of one snapshot.
Waiting is layered on top in `src/commands/auto-wait.ts`; see [Auto-wait](/verikun/reference/auto-wait/).
`src/ui/state-support.ts` is the platform gate that refuses a modifier the backend cannot
report.
