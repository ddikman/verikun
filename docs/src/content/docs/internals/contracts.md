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

Recording is a side effect of running a *command*, so a failure the **engine** produced — a
control node giving up, a budget or timeout abort — has no command to attach itself to, and
such a run used to archive with nothing red in it. Three layers close that:

1. `Recorder.recordTerminalFailure(failure, evidence?)` sets `RunState.failure` and appends
   **one** synthetic failed step — only when no step is already red, so a leaf failure is
   never counted twice.
2. `cli.ts`'s `terminalFailure()` builds that record from the `runPlan` result **and** prints
   the `[ai] …` verdict, so the archive and the console cannot disagree.
3. `report.ts`'s `runFailure()` trusts `failure` (falling back to `ai.ok`) over the tally and
   emits a synthetic failing testcase if a failed run somehow still has no red step.

Evidence comes from `ExecBackend.captureFailure()` — screenshot plus hierarchy locally,
hierarchy only over `--server`.

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

### One active run per lane

The active run directory is `./.verikun/run/`, or `./.verikun/run-<lane>/` when `VERIKUN_LANE`
is set — a [parallel suite](/verikun/guides/suites/#running-across-several-devices) sets the
lane on each child. Every test starts its run with `force`, which removes that directory, so
two concurrent tests sharing one path would delete each other's in-flight state; artifacts are
keyed on step index alone, which is safe only because they live *inside* that directory.

Archives still land in the shared `./.verikun/runs/<id>/`, so the suite index's links do not
change. `runId()` appends the lane (a one-second timestamp is not unique across devices) and
`uniqueDir()` claims its directory with an exclusive `mkdir`, never an `existsSync` check.

### Rollover must not strand a device snapshot

`deviceOverrides` lives in the run and `rolloverReason` *seals* runs, so a rollover used to
carry the snapshot into the archive while `vk device reset` — which reads the **active** run —
reported "nothing to restore", leaving a phone dark and rotated with nothing tracking it.

So `beginStep` carries unrestored overrides **forward** on a same-device rollover, and on a
device-change rollover warns loudly with the exact `vk device set … --device <serial>` needed
to undo it — it cannot drive the old device from a process pointed at the new one, and
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
a device is a fact about the machine, and the jobs that collide are in different directories
by definition. One file per device, because the premise is concurrent writers — separate
files make every write atomic with no read-modify-write race.

**Acquisition publishes first and judges second; `ok` means a create actually succeeded.**
Write-then-`link()`, not `writeFileSync(…, {flag:'wx'})`: `wx` creates the file empty and
fills it a moment later, so a racer reading the gap sees a corrupt claim and takes the device
too. **Replacing a *dead* claim is serialized by a `<claim>.takeover` token**, because POSIX
has no "remove this file only if it is still the one I read" — unlink-then-create let 16
racers over one dead claim produce two winners. Only the token holder writes the claim path,
and it re-reads *inside* the token; token liveness is the owning PID alone.

**Liveness combines a live pid with an idle TTL**, because a heartbeat can only fire
*between* commands. A live pid always means live (a ten-minute `install` cannot report that
it is working); a dead pid additionally means *done* only for `processScoped` owners
(`ai`/`suite`/`batch`/`server`), which are one process for the whole job — a one-off
`vk tap` falls back to the TTL. `setProcessScoped()` is the latch, because the claim is
acquired lazily inside `Driver.resolvedSerial()`.

**Reads are tolerant; the store may never be a new way to fail.** A corrupt claim reads as
unclaimed, an unwritable store logs and continues. Ownership matches on session **or** cwd —
the one unsafe error is accusing your own job. `VERIKUN_NO_CLAIM=1` disables reads and writes
and restores the pre-claims behaviour exactly, including exit 2 on multiple devices; preserve
that equivalence, it is what makes the mechanism debuggable by bisection.

## Three scopes, one grant

Exclusive device assignment is solved at three scopes, and only two of them are the same kind
of thing:

| | Where | Identity | Question it answers |
|---|---|---|---|
| **Claims** | `device/claims.ts`, `~/.verikun/devices/` | cwd / session / pid | Which of this **host's** jobs may drive this serial? |
| **Leases** | `server.ts` (`leaseFor`, `/v1/lease`) | the run token every remote backend mints | Which serial does this **server's** run hold? |
| **Lanes** | `suite.ts` | lane id | Which worker pulls the next test? |

**Claims and leases stay separate implementations** — different trust domains (a pid on the
host versus a token on the wire); collapsing them would mean putting host-global files behind
an HTTP endpoint or trusting a client-supplied token to fence a machine. **What they share is
a lifecycle, and that is `DeviceGrant`** (`device/grant.ts`): take a device, keep it warm,
hand it back — `claimGrant` / `requireClaimGrant` over the claim store, `leaseGrant` over a
server lease, `releaseGrants` as the teardown.

**The two acquisition polarities are the whole API.** `claimGrant` returns `null` for a device
somebody else holds (`--devices all` asked for a *set*); `requireClaimGrant` throws exit `2`
(a named serial must not be dropped silently). `poolSerials` applies the same polarity to a
serial that is not attached.

**Idle takeover, eviction and affinity are pool policy** and live only in the server, the one
place with a pool to arbitrate. **A lane is not a grant**: it is a scheduler slot — a lane
pinned to a local serial runs on a grant the suite *parent* holds, and a lane pointed at a
pooled server holds nothing, because its child leases under its own run token.

## Only the server may repoint the server

`vk server` binds a device at startup, and no `/v1/exec` request can change it. Two things
can: **a client, via `/v1/devices/*`** — gated on `--allow-device-control` and allowlisted by
name, a privilege granted to a caller and therefore opt-in — and **the server itself, by
failing over**: never at a client's request, never to a device outside the operator's set,
never to one that is not already running, and never when `--device` pinned the binding. A
server started without `--device` already auto-selected a free device, so moving to another
free, healthy, unclaimed one is that same decision made again — which is why it is on by
default.

| Invariant | Why |
|---|---|
| **A step is never replayed on the new device.** Only `install` retries (it is idempotent and carries no app session); everything else rebinds and returns the **original** device's error, and `/v1/elements` never answers with the new device's hierarchy. | Replaying step 12 on a device that never ran 1–11 is either a false green or a repair against the wrong screen. |
| **The install classifier enumerates the FILE, not the device.** The file-attributable set is small and closed; everything else moves. The named device-state strings are a fast path, never the gate. | The device side is open-ended and OEM-specific — the failure that prompted this carried no `INSTALL_FAILED_*` code at all. `tests/failover.test.ts` feeds the classifier gibberish that must still move. |
| **On exhaustion the client gets the FIRST device's error.** A step keeps the opposite default — stay unless a two-probe re-check confirms the device dead — and the re-probe's **own** error is classified too. | A wrong move costs time, never the diagnosis. Exit 3 on a step is dominated by transient noise, and an adb restart fails every probe on the host. |
| **An install that fails on EVERY device condemns the build, not the pool**: the per-device quarantines are rolled back. | The fan-out has just proved the artifact is the common factor. |

The failure strings, the two-move cap and the operator's view of a quarantine:
[When the bound device fails](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails).

## A pool degrades, it does not shrink

A pool's own members are excluded from its failover candidates, so on `--devices all` "nothing
healthier to move to" is the **normal** case. Shedding there took a three-device pool to one in
two failures, with nothing to grow it back.

- **Demote, never shed.** A failing member keeps its worker, claim and slot and is reported as
  `degraded` (disjoint from `quarantined`). Only a device whose worker actually **died** leaves.
- **Ordering makes that safe.** Leases are dealt healthy-first, then least-recently-used —
  first-fit handed a *broken* device out most often, because it fails fastest.
- **Recovery is proven by traffic, not a clock.** Any exec that is not an environment failure,
  or any successful hierarchy read, restores the device.
- **A device that left is swept for.** Once a minute a pooled server re-adopts whatever
  `--devices` asked for that is not serving; starting the worker **is** the probe, each failure
  doubles the wait to a 30-minute ceiling, and a rejoining device gets the session's last
  install before any work. Single-device servers do not sweep.
- **A worker call is bounded.** A wedged thread used to leave its lease in-flight forever; it is
  terminated instead, which turns a wedged device into a departed one the sweep can replace.

How it looks from the client:
[Failover on a pool](/verikun/guides/remote-devices-and-ci/#failover-on-a-pool) and
[A device that comes back rejoins by itself](/verikun/guides/remote-devices-and-ci/#a-device-that-comes-back-rejoins-by-itself).

## The plan cache fingerprint

Each cache entry records a **compiler fingerprint** = verikun's version + `GRAMMAR` +
`REPAIR_GRAMMAR` + `SECTION_NOTE`.

- `readPlan` treats a fingerprint mismatch as a **miss**. So updating verikun — a version
  bump *or* any grammar/repair/section-prompt edit — recompiles instead of replaying a plan
  the old compiler produced.
- `findSeed` **ignores** the fingerprint. An older plan is still a fine starting point —
  unless it does not cover its own prose, because a truncated plan handed to the model as
  "adapt this" is how one bad compile outlives the bump that invalidated its own entry.
- A plan that [does not cover its test](/verikun/reference/ai-plans/#the-compile-must-cover-the-test)
  is **never written**. Caching is what turns one truncated compile into a pass replayed
  against every later build, so the rejection has to happen before the write, not after.

The cache is keyed by prose + package + app build. The prose is the **resolved** text, with
every [`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests)
inlined — so editing a fragment invalidates every test that includes it, and each chunk of
an included test also has its own entry under its own text. It reads tolerantly (a bad entry is a
miss, not a crash), writes atomically, caches the compile immediately so an unchanged test
never recompiles and re-persists, and re-persists the healed plan on green.

## The plan-compile lock

Atomic writes make a *concurrent* write safe; they do not stop two processes doing the same
work. A pooled `vk suite` is one child process per test sharing one cache, so on a cold cache
every lane missed the same `@include`d fragment at the same instant and compiled its own — N×
the tokens, and N different nondeterministic draws of one preamble alive in one suite run.

A **per-key lock** closes it: a compile takes `./.verikun/plan-locks/<key>.lock`, the losers
wait and re-read the cache under the lock. Four properties are load-bearing.

- **Beside the cache, never inside it.** `.verikun/plans` is the directory CI restores with
  `actions/cache`; a lock packed into that tarball would come back on a fresh runner as a
  foreign-host corpse, on exactly the cold-cache run the cache exists to make cheap.
- **Taken only on a miss.** The steady state is all hits and does no lock I/O.
- **Liveness is the pid, with an age ceiling.** There is no heartbeat and there cannot be one:
  a CLI provider compiles inside a blocking `spawnSync`, so a timer in the holder could not
  fire. Same rule as a device claim's — a live pid always means live.
- **It can never be a new way to fail.** An unwritable directory, a corrupt lock, or a holder
  that outlives the wait ceiling all mean *compile anyway* — one duplicate compile, which is
  the state being improved on. The wait ceiling is derived from `--timeout`, because the run's
  own deadline starts before the plan is obtained. `VERIKUN_NO_PLAN_LOCK=1` restores the
  pre-lock behaviour exactly.

Unlike a [device claim](/verikun/reference/device-claims/), a lost race here is cheap — one
wasted compile, not two jobs driving one phone — so breaking a stale lock is deliberately
*not* serialised with a takeover token. The two mechanisms share their primitives and nothing
else.

`VERSION` is generated from `package.json` at build, which is why a rebuild rotates the
fingerprint automatically.

## Selector matching stays time-free

Matching is a pure function of one snapshot (`ui/selector.ts`). **Waiting is layered on top in
`commands/auto-wait.ts`, never in `selector.ts`.** Only an empty match set is retried — a
present-but-plural match exits `2` at once, because waiting cannot disambiguate elements that
are already there; bare-index `tap N` and `tap --at x,y` never wait, because an index names a
specific prior `ui` dump and a re-capture shifts indices; `assert` polls the whole predicate,
so `--gone` waits for disappearance. Route a new selector-resolving command through
`resolveOneWaiting()` / `matchWaiting()`, never a raw `resolveOne` / `matchElements`.

## State modifiers are exactly one attribute

Each state predicate tests one attribute and nothing else — strengthening one with a conjunct
the platform reports unreliably once turned `--enabled` into phantom misses. `stateFromFlags()`
must leave an absent flag `undefined`, or every selector silently gains "must be disabled,
unselected, unchecked and unfocused".

## Auto-scroll: measured constants

- **Pace the swipe by distance** (~0.75 px/ms). The same 1118px swipe over 400ms took the app
  off the screen entirely on emulator API 34; over 1500ms it scrolled cleanly.
- **The platform is the first filter.** Android's dumper drops invisible nodes and clips the
  rest, so `Element.offscreen` is mostly an iOS signal.
- **Refusing to act** is reserved for an element with **no** on-screen pixel (exit `1`);
  occlusion only ever warns, because a wrong refusal is worse than the tap it prevents.

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
