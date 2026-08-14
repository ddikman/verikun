---
title: Contracts
description: The rules a change can be checked against — healing, recording, rollover, the plan cache, and packaging.
sidebar:
  order: 4
---

This page exists so that a change can be checked against **written intent** rather than
re-derived from several files at once. Each entry states the rule, then why it is that way.

## Heal vs terminal

| Trigger | Behaviour | Why |
|---|---|---|
| Selector **miss** — `SelectorNotFoundError`, exit `1` | Heals | The element moved or was relabelled; that is drift, not a regression |
| Selector **ambiguity** — `AmbiguousSelectorError`, exit `2` | Heals | The model can disambiguate from the live screen |
| **`assert` failure** | **Terminal** | Healing it would mask the exact regression the test exists to catch |
| Model **`give_up`** | **Terminal** | A fallback tap onto an unrelated screen would pass as a false green |
| Budget / timeout abort | **Terminal** | A bound that heals is not a bound |
| Environment error, exit `3` | **Aborts**, not recorded as a regression | The box is broken; the app is not implicated |

The mechanism that makes `assert` unhealable is that it **returns** exit `1` rather than
throwing. The engine heals only on a *thrown* selector error. If you ever make `assert`
throw, you silently make regressions healable.

## What is recordable

`RECORDABLE` in `run.ts` is actions plus `wait` and `assert`. **Not** inspection — `ui`,
`find`, `devices` — because reading the screen is not a test step.

**The one exception is `log`**, recorded precisely so its on-demand device-log capture lands
in the report.

Adding a command means deciding whether it belongs in `RECORDABLE`. A new action that is not
listed there is invisible in every report.

## A failed run can never archive green

Recording is a side effect of running a *command*. So a failure the **engine** produced — a
control node giving up, a budget or timeout abort — has no command to attach itself to. Such
a run used to reach the archive with nothing red in it, and the report, which tallied step
statuses, declared a failed test `failures="0"`.

Three layers close it:

1. `Recorder.recordTerminalFailure(failure, evidence?)` sets `RunState.failure` (the run-level
   `where` plus reason) and appends **one** synthetic failed step — but **only when no step is
   already red**, since a leaf failure already has its own testcase and must not be counted
   twice.
2. `cli.ts`'s `terminalFailure()` builds that record from the `runPlan` result, composes the
   reason for budget and timeout aborts (which the engine returns as a bare flag), and is
   **also** what prints the `[ai] …` verdict — so the archive and the console cannot disagree.
3. `report.ts`'s `runFailure()` is belt and braces: it trusts `failure` (falling back to
   `ai.ok`) over the tally, and emits a synthetic failing testcase if a failed run somehow
   still has no red step.

Evidence comes from `ExecBackend.captureFailure()` — screenshot plus hierarchy locally,
hierarchy only over `--server`, which has no screenshot route.

## Run rollover

The active run **auto-closes (archives) and a fresh one starts** when the context changes:

| Trigger | Applies to | Tune with |
|---|---|---|
| Idle beyond the limit | **implicit runs only** | `VERIKUN_RUN_IDLE_MIN` (default 30; `0` disables) |
| Different device serial | any run | — |
| Different session | any run | `VERIKUN_SESSION`, falling back to `TERM_SESSION_ID` |

A named run is **sticky to idle**. Rollover always *archives*, never discards.

The serial is resolved via `driver.resolvedSerial()` (cached, so no extra device round-trip)
and passed into `beginStep`. `Recorder.seal()` is the shared finalize-and-move used by both
rollover and `vk run archive`.

### Rollover must not strand a device snapshot

Because `deviceOverrides` lives in the run and `rolloverReason` *seals* runs, a rollover used
to carry the snapshot into the archive while `vk device reset` — which reads the **active**
run — reported "nothing to restore".

Measured, not theoretical: two workspaces driving different devices from one working
directory ping-pong the active run via device-change rollover, and a phone was left dark and
rotated with nothing tracking it.

So `beginStep` now carries unrestored overrides **forward** on a same-device rollover, and on
a device-change rollover warns loudly with the exact `vk device set … --device <serial>`
needed to undo it. It cannot drive the old device from a process pointed at the new one, and
restoring one device's values onto another would be worse than leaving them.

`tests/run-device-overrides.test.ts` pins both paths.

## Device overrides: earliest wins

`RunState.deviceOverrides` maps each key to the value that was live *before* verikun first
touched it. Setting `dark` twice must still restore to the **pre-run** value.

The snapshot lives in the run file rather than in memory, because every `vk` call is its own
process — an in-memory latch could not undo a flow that died.

`cmdBatch`, `cmdAi` and `cmdSuiteEntry` call reset from a `finally`. A bare `vk device set`
from a shell deliberately stays applied.

**Known gap:** under `--server` the snapshot is written by the *server* process, so a crashed
client leaves overrides applied.

## Device claims: acquire exclusively, prove liveness

The claim store (`src/device/claims.ts`) answers "which attached device is another job
already driving". Four properties are load-bearing; user-facing behaviour is
[Device claims](/verikun/reference/device-claims/).

**Host-global, one file per device.** `~/.verikun/devices/<serial>.json`, not `./.verikun/`:
run state describes a working directory, but a device is a fact about the machine, and the
jobs that collide are in different directories by definition. One file *per device* rather
than one index, because the premise is concurrent writers — separate files make every write
atomic with no read-modify-write race.

**Acquisition is an exclusive create, and `ok` means a create actually succeeded.** Publish
first, judge second: write-then-`link()` (not `writeFileSync(…, {flag:'wx'})`, which creates
the file empty and fills it a moment later, so a racer reading the gap sees a corrupt claim
and takes the device too). Success is never returned on the strength of a decision that
could have gone stale before the write — that is exactly how two jobs end up on one device.

**Replacing a *dead* claim is serialized by a token**, because POSIX has no "remove this file
only if it is still the one I read". Unlink-then-create is unsound: between reading "dead"
and unlinking, another taker can publish, and the unlink then deletes a *live* claim.
Measured — 16 racers over one dead claim produced two winners. So a taker first wins
`<claim>.takeover` by exclusive create; only the holder writes the claim path, and it
re-reads *inside* the token before replacing. The token is held across three syscalls and no
I/O, so its liveness is the owning PID alone — a dead claim is the routine steady state,
whereas a stranded token needs a crash inside a microsecond window.

**Liveness combines a live pid with an idle TTL**, because a heartbeat can only fire
*between* commands. A live pid always means live — a ten-minute `install` or a `wait
--timeout 600000` has no chance to report that it is working, so the pid **extends**
liveness and never shortens it. The one exception is `processScoped` owners
(`ai`/`suite`/`batch`/`server`), which are a single process for the entire job: there a dead
pid also means *done*, which is what returns a device the instant a `kill -9` lands instead
of parking it until a timer expires. A one-off `vk tap` exits after every command while the
job carries on, so it can only fall back to the TTL. `setProcessScoped()` is the latch that
distinguishes them, shaped like `setOutputQuiet()` and for the same reason — the claim is
acquired lazily inside `Driver.resolvedSerial()`, long after dispatch.

**Reads are tolerant; the store may never be a new way to fail.** A corrupt claim reads as
unclaimed, an unwritable store logs and continues unclaimed. Ownership matches on session
**or** cwd — forgiving in the only safe direction, since the one unsafe error is falsely
accusing your own job.

`VERIKUN_NO_CLAIM=1` disables reads and writes and restores the pre-claims behaviour exactly,
including the old exit-2-on-multiple-devices. Preserve that equivalence: it is what makes the
mechanism debuggable by bisection.

## The plan cache fingerprint

Each cache entry records a **compiler fingerprint** = verikun's version + `GRAMMAR` +
`REPAIR_GRAMMAR`.

- `readPlan` treats a fingerprint mismatch as a **miss**. So updating verikun — a version
  bump *or* any grammar/repair-prompt edit — recompiles instead of replaying a plan the old
  compiler produced.
- `findSeed` **ignores** the fingerprint. An older plan is still a fine starting point.

The cache is keyed by prose + package + app build. It reads tolerantly (a bad entry is a
miss, not a crash), writes atomically, caches the compile immediately so an unchanged test
never recompiles and re-persists, and re-persists the healed plan on green.

`VERSION` is generated from `package.json` at build, which is why a rebuild rotates the
fingerprint automatically.

## Selector matching stays time-free

Matching is a pure function of one snapshot (`ui/selector.ts`). **Waiting is layered on top in
`cli.ts`, never in `selector.ts`.**

Rules that mirror auto-healing:

- **Only an empty match set is retried.** A present-but-plural match is surfaced immediately
  via `resolveOne()` (exit `2`) — waiting cannot disambiguate, and the elements are already
  there.
- **Bare-index `tap N` and `tap --at x,y` never wait.** An index refers to a specific prior
  `ui` dump, so polling — which re-captures and shifts indices — would be wrong.
- **`assert` polls the whole predicate**, so `--gone` waits for disappearance.

When you add a selector-resolving command, route it through `resolveOneWaiting()` /
`matchWaiting()` rather than a raw `resolveOne` / `matchElements`, so it inherits auto-wait.

## State modifiers are exactly one attribute

Each state predicate tests exactly one attribute and nothing else. **Do not strengthen one
with a conjunct the platform reports unreliably** — that mistake once turned `--enabled` into
phantom "not found" misses.

`stateFromFlags()` must leave an absent flag `undefined` rather than passing a `false`
through, or every selector on every command silently gains "must be disabled, unselected,
unchecked and unfocused".

## Auto-scroll: measured constants

- **Pace the swipe by distance** (~0.75 px/ms). The same 1118px swipe over 400ms took the app
  off the screen entirely on emulator API 34; over 1500ms it scrolled cleanly. A fast swipe
  also flings past the target.
- **The platform is the first filter.** Android's dumper drops nodes it considers invisible
  and clips the rest, so `Element.offscreen` is mostly an iOS signal. Do not assume it fires
  on Android.
- **Refusing to act** is reserved for an element with **no** on-screen pixel (exit `1`).
  Occlusion only ever produces a stderr warning — it is an ordering heuristic, and a wrong
  refusal would be worse than the tap it prevents.

## Secrets

Step names never include typed text. `cmdText` redacts the value into the step message when
the field's `password` flag is set. **Keep that property if you add input commands.**

Device logs are raw output and are **not** redacted.

## Packaging: `"files"` is an allowlist

npm force-includes only five things: `package.json`, `README*`, `LICENSE`/`LICENCE` (either
spelling, any case or extension), the `main` file, and the `bin` file(s).

**Not `CHANGELOG.md`** — npm 5/6 did; modern npm does not. And not the skill.

Anything else you want published must be named explicitly in `"files"`, or it is silently
absent from the tarball: `npm publish` succeeds, CI stays green, and nothing reports the
omission. That is how every release up to 0.10.0 shipped with no changelog.

Two guards, deliberately at different levels:

| Guard | Checks |
|---|---|
| `tests/package-files.test.ts` | The allowlist — **intent** |
| `scripts/check-package-contents.mjs` | The packed tarball's real contents — **result** |

Only the artifact check can catch a stray `.npmignore`, npm changing how it treats the
`.claude/` dot-directory (it traverses it today; that is undocumented behaviour we depend
on), `.claude/skills` added alongside the exact skill path and dragging the contributor-only
`create-pr` skill in, or a new subdirectory appearing under `example/`.

The `example` entry is the glob **`example/*.md`**, not a bare `example`: that directory also
holds the Flutter e2e fixture — 74 files of Gradle, Xcode and icon PNGs that are repo test
infrastructure, not end-user guidance. A bare directory entry sweeps all of it into the
tarball, which is a quarter of the package. **Keep the glob.**

:::note
This documentation site lives in `docs/`, which is **not** in `"files"` and therefore never
enters the tarball. Its `package.json` and `node_modules` are inert to the root install
because the root has no `workspaces` key.
:::
