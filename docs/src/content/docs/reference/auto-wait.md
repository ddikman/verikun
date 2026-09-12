---
title: Auto-wait & auto-scroll
description: Selector lookups retry until they resolve, and actions bring their target into view first. Both are on by default.
sidebar:
  order: 3
---

Two things happen automatically before an action, and together they are why a verikun flow
needs far fewer explicit `wait` and `swipe` calls than you would expect.

## Auto-wait

A UI rarely settles the instant the previous action returns. So selector commands — `tap`,
`text`, `find`, `assert`, and `swipe --on` — **do not fail the moment a lookup misses**. They
re-capture the hierarchy and retry until it resolves or a **5-second** window elapses.

```sh
vk tap @next                 # waits up to 5s for @next to appear, then taps
vk assert text:"Done"        # waits up to 5s for "Done" to show, then asserts
vk find @spinner --no-wait   # existence probe: answer now, don't wait
```

| Flag | Effect |
|---|---|
| *(none)* | Wait up to **5s** (the default) for the lookup to resolve |
| `--wait <dur>` | Override the window: `8s`, `800ms`, or a bare number of ms (`3000`). `0` disables. |
| `--no-wait` | Fail immediately on the first miss (identical to `--wait 0`) |
| `--interval <ms>` | Poll cadence while waiting (default `300`) |

### Three deliberate boundaries

**Ambiguity is never waited on.** If the lookup matches more than one element, they are
already on screen — the command reports the candidates and exits `2` at once. Add `--index N`
or refine the selector.

**Bare-index taps and `--at x,y` never wait.** An index refers to a specific prior `ui` dump,
and polling would re-capture and shift the indices underneath you.

**`assert` polls the whole predicate**, not just presence. So `assert --gone` waits for
*disappearance*, and `--text` waits for the text to match. `assert @spinner --gone` therefore
subsumes "`wait --gone` then assert" in one call.

### It is reported

Handlers that waited append ` (waited 1.2s)` to the confirmation on stderr, and the recorded
step's duration includes the wait.

### A modal barrier is not an absence

Right after a sheet or dialog opens or closes, an Android read can hold the modal's barrier
and nothing else. verikun re-reads such a tree before returning it, from every read, `vk ui`
included. A barrier that outlives the whole wait is still a miss (exit `1`), and the message
says so: *"The hierarchy held only a modal barrier (desc="Scrim") for the whole wait…"* — a
modal is up with nothing addressable inside it, so dismiss it. iOS does not need this.

### The `wait` command is different

`vk wait` is the explicit blocking poll, with its own `--timeout` / `--interval` and `--gone`.
Use it when you want to block on a condition **as a step in its own right** — something the
report should show as a distinct thing that took time. `--wait` (the flag) and `wait` (the
command) are unrelated.

## Auto scroll-into-view

An element can be in the hierarchy without being reachable at the point a tap would land:
scrolled past the edge of its list, or with a sticky bar drawn across its middle. Pressing
its coordinates then hits whatever is actually there — and **the step reports success**.

So **actions scroll; inspection does not.**

`tap` and `text` bring their target into the clear first — into its scroll container, and out
from under anything drawn over it — then act, adding `(scrolled into view: N swipes)` to the
confirmation. "Scroll down to X and tap it" is therefore just `vk tap X`.

`ui`, `find` and `assert` **never scroll and never hide anything**: an element with no pixel
on screen is listed as usual, marked `offscreen`. Inspection has no side effects.

| Flag | Effect |
|---|---|
| `--no-scroll` | Act where the element is; do not scroll to it |

### The two causes it handles

- **Cut off by its container.** The element must sit fully inside its nearest scrollable
  ancestor's visible area, not merely on screen.
- **Covered by something painted later.** A covered target inside a scroll container is
  scrolled to the container's middle; outside one, verikun picks a different point on the
  element.

### When it refuses

Refusing to act is reserved for an element with **no on-screen pixel at all** — exit `1`, so
[`vk ai`](/verikun/guides/natural-language-tests/) can repair the step or give up. Occlusion
only ever produces a stderr warning, because a wrong refusal would be worse than the tap it
prevented.

Known gap: with `--no-scroll`, a tap on an element verikun has already found unreachable is
still issued at its centre and exits `0`
([#54](https://github.com/ddikman/verikun/issues/54)).

:::caution
A control covered by something the accessibility tree does not contain — a decorative
container with no label or id — is invisible to any tool reading that tree. Scrolling the
target clear of screen edges avoids most of these; verikun warns on stderr when it presses an
element it believes is covered.
:::

### Platform note

Android's dumper drops nodes it considers invisible and clips the rest to the display, so a
fully off-screen element is usually **not in the tree at all**. `offscreen` is mostly an iOS
signal — do not assume it fires on Android. Every unknown degrades to "visible": if verikun
cannot read the screen size, it does not scroll and does not mark anything.
