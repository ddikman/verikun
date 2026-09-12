---
title: Contracts
description: The rules a change can be checked against — healing, recording, rollover, the plan cache, and packaging.
sidebar:
  order: 4
---

This page exists so that a change can be checked against **written intent** rather than
re-derived from several files at once. Each entry states the rule and what breaks if it is
violated.

## Heal vs terminal

| Trigger | Behaviour |
|---|---|
| Selector **miss** — `SelectorNotFoundError`, exit `1` | Heals: the element moved or was relabelled |
| Selector **ambiguity** — `AmbiguousSelectorError`, exit `2` | Heals: the model can disambiguate from the live screen |
| **`assert` failure** | **Terminal** — healing it would mask the regression the test exists to catch |
| Model **`give_up`** | **Terminal** — a fallback tap onto an unrelated screen would pass as a false green |
| Budget / timeout abort | **Terminal** — a bound that heals is not a bound |
| Environment error, exit `3` | **Aborts**, not recorded as a regression |
| **`NoWindowError`, exit `3`** | **Ridden out** for 10s, then aborts — the app has not drawn yet, which is not a broken box |

`NoWindowError` is told apart from other exit-3 errors **by class, never by exit code**, so
its class must survive every boundary it crosses: worker → main thread, child process →
parent (`errorKind` in `--json`), and server → client (`errorKind` on the error body). Any
new boundary owes the same field.

`assert` is unhealable because it **returns** exit `1` rather than throwing; the engine heals
only on a *thrown* selector error. If you ever make `assert` throw, you silently make
regressions healable.

## What is recordable

`RECORDABLE` in `run.ts` is actions plus `wait` and `assert` — not inspection (`ui`, `find`,
`devices`), with `log` as the one exception so its capture lands in the report. A new action
that is not listed there is invisible in every report.

## A failed run can never archive green

A failure the **engine** produced — a control node giving up, a budget or timeout abort — has
no command to attach itself to, so three layers close the gap:

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
`Recorder.seal()` is the shared finalize-and-move used by both rollover and `vk run archive`.

### One active run per lane

The active run directory is `./.verikun/run/`, or `./.verikun/run-<lane>/` when `VERIKUN_LANE`
is set — a [parallel suite](/verikun/guides/suites/#running-across-several-devices) sets the
lane on each child. Every test starts its run with `force`, which removes that directory, so
two concurrent tests sharing one path would delete each other's in-flight state; artifacts are
keyed on step index alone, which is safe only because they live *inside* that directory.

Archives still land in the shared `./.verikun/runs/<id>/`. `runId()` appends the lane (a
one-second timestamp is not unique across devices) and `uniqueDir()` claims its directory
with an exclusive `mkdir`, never an `existsSync` check.

### Rollover must not strand a device snapshot

`deviceOverrides` lives in the run and a rollover seals runs, so `beginStep` carries
unrestored overrides **forward** on a same-device rollover, and on a device-change rollover
warns with the exact `vk device set … --device <serial>` needed to undo them — it cannot
drive the old device from a process pointed at the new one, and restoring one device's values
onto another would be worse than leaving them. `tests/run-device-overrides.test.ts` pins
both paths.

## Device overrides: earliest wins

`RunState.deviceOverrides` maps each key to the value that was live *before* verikun first
touched it, so setting `dark` twice still restores to the **pre-run** value. The snapshot
lives in the run file, not memory, so `vk device reset` works from a later process.
`cmdBatch`, `cmdAi` and `cmdSuiteEntry` call reset from a `finally`; a bare `vk device set`
from a shell stays applied.

**Known gap:** under `--server` the snapshot is written by the *server* process, so a crashed
client leaves overrides applied.

## Device claims: acquire exclusively, prove liveness

The claim store (`src/device/claims.ts`) answers "which attached device is another job
already driving". User-facing behaviour: [Device claims](/verikun/reference/device-claims/).

- **Host-global, one file per device** (`~/.verikun/devices/<serial>.json`): a device is a
  fact about the machine, and separate files make every write atomic with no
  read-modify-write race.
- **Acquisition is write-then-`link()`**, not `writeFileSync(…, {flag:'wx'})`, which exposes
  an empty file that a racer would read as a corrupt claim and take the device too.
  **Replacing a dead claim is serialised by a `<claim>.takeover` token**; only the token
  holder writes the claim path, and it re-reads *inside* the token.
- **Liveness combines a live pid with an idle TTL.** A live pid always means live (a
  ten-minute `install` cannot heartbeat); a dead pid means *done* only for `processScoped`
  owners (`ai`/`suite`/`batch`/`server`, latched by `setProcessScoped()` because the claim
  is acquired lazily inside `Driver.resolvedSerial()`); a one-off `vk tap` falls back to
  the TTL.
- **Reads are tolerant; the store may never be a new way to fail.** A corrupt claim reads as
  unclaimed, an unwritable store logs and continues. Ownership matches on session **or** cwd.
- **`VERIKUN_NO_CLAIM=1` disables reads and writes and restores the pre-claims behaviour
  exactly**, including exit 2 on multiple devices. Preserve that equivalence; it is what
  makes the mechanism debuggable by bisection.

## Three scopes, one grant

| | Where | Identity | Question it answers |
|---|---|---|---|
| **Claims** | `device/claims.ts`, `~/.verikun/devices/` | cwd / session / pid | Which of this **host's** jobs may drive this serial? |
| **Leases** | `server.ts` (`leaseFor`, `/v1/lease`) | the run token every remote backend mints | Which serial does this **server's** run hold? |
| **Lanes** | `suite.ts` | lane id | Which worker pulls the next test? |

Claims and leases stay **separate implementations** (different trust domains: a pid on the
host versus a token on the wire). What they share is a lifecycle, `DeviceGrant`
(`device/grant.ts`): take a device, keep it warm, hand it back. `claimGrant` returns `null`
for a device somebody else holds (`--devices all` asked for a *set*); `requireClaimGrant`
throws exit `2` (a named serial must not be dropped silently). Idle takeover, eviction and
affinity are pool policy and live only in the server.

## Only the server may repoint the server

`vk server` binds a device at startup, and no `/v1/exec` request can change it. Two things
can: **a client, via `/v1/devices/*`** — gated on `--allow-device-control` and allowlisted by
name — and **the server itself, by failing over**: never at a client's request, never to a
device outside the operator's set, never to one that is not already running, and never when
`--device` pinned the binding.

| Invariant | Because |
|---|---|
| **A step is never replayed on the new device.** Only `install` retries; everything else rebinds and returns the **original** device's error, and `/v1/elements` never answers with the new device's hierarchy. | Replaying step 12 on a device that never ran 1–11 is a false green or a repair against the wrong screen. |
| **The install classifier enumerates the FILE, not the device.** The file-attributable set is small and closed; everything else moves, including wordings nobody has met. The named device-state strings are a fast path, never the gate. | The device side is open-ended and OEM-specific. `tests/failover.test.ts` feeds the classifier gibberish that must still move. |
| **On exhaustion the client gets the FIRST device's error.** A step keeps the opposite default — stay unless a two-probe re-check confirms the device dead — and the re-probe's own error is classified too. | Exit 3 on a step is dominated by transient noise; a wrong move must cost time, never the diagnosis. |
| **An install that fails on EVERY device condemns the build, not the pool**: the per-device quarantines are rolled back. | The fan-out has just proved the artifact is the common factor. |

Operator view: [When the bound device fails](/verikun/guides/remote-devices-and-ci/#when-the-bound-device-fails).

## A pool degrades, it does not shrink

A pool's own members are excluded from its failover candidates, so on `--devices all`
"nothing healthier to move to" is the **normal** case.

- **Demote, never shed.** A failing member keeps its worker, claim and slot and is reported as
  `degraded` (disjoint from `quarantined`). Only a device whose worker actually **died** leaves.
- **Leases are dealt healthy-first, then least-recently-used.** First-fit would hand a broken
  device out most often, because it fails fastest.
- **Recovery is proven by traffic, not a clock.** Any exec that is not an environment failure,
  or any successful hierarchy read, restores the device.
- **A device that left is swept for**, once a minute, from what `--devices` asked for;
  starting the worker is the probe, each failure doubles the wait to a 30-minute ceiling, and a
  rejoining device gets the session's last install first. Single-device servers do not sweep.
- **Every worker call is bounded** (`WORKER_CALL_TIMEOUT_MS`): a wedged thread is terminated,
  which turns a wedged device into a departed one the sweep can replace.

Operator view: [Failover on a pool](/verikun/guides/remote-devices-and-ci/#failover-on-a-pool).

## Recycling adb is host-global, so it needs evidence

A long-lived adb server leaks IOKit Mach ports until it drops devices mid-run, and only a
restart clears it. Measured on macOS: a 9-day-old server emitting kernel guard violations at
2/sec, all from the adb pid; a restart took it to zero and every device returned in ~5s.

Why the server owns this rather than the operator: **adb rot defeats device failover.**
`device/failover.ts` moves off a device that fails, but every candidate sits behind the same
host adb — so when the transport is what broke, failover retires healthy phones for a
host-side fault. That is the polarity error `ARTIFACT_RULES` exists to prevent on the install
path: attribute only what you can actually attribute.

Four rules hold a default-on, host-global restart safe:

- **Evidence, never age.** A healthy server measures exactly zero violations; a rotted one
  60–120 per minute. There is no middle ground to tune a threshold against, so any nonzero
  count is the signal — and a healthy host is never touched. Age alone would restart a good
  server on a timer, which is a new way to fail.
- **The rate is a leaked-handle counter.** adb scans USB at ~1 Hz and each *stale* handle
  throws one violation per pass, so the per-minute count reads as "how many handles adb has
  leaked". It steps up at the instant a device re-enumerates and never comes back down.
- **Fully idle only.** `kill-server` drops every transport on the machine, so anything
  mid-run vetoes. `othersActive` is the gate, and it already steps over an idle lease, so a
  crashed client cannot wedge the recycle forever. `exclusive` is held across the restart, so
  a client arriving inside the ~2s window gets the clean refusal the lease layer already
  gives — accepted deliberately, because we only get here when adb is *already* dropping
  devices.
- **No evidence is never rot.** Off macOS there is no guard-violation log, so the check
  reports nothing and the server does nothing. It never degrades to a blind restart.

`VERIKUN_NO_ADB_RECYCLE=1` restores the previous behaviour exactly, the equivalence
`VERIKUN_NO_CLAIM` and `VERIKUN_NO_FAILOVER` are held to.

## The plan cache fingerprint

Each cache entry records a **compiler fingerprint** = verikun's version + `GRAMMAR` +
`REPAIR_GRAMMAR` + `SECTION_NOTE`; `VERSION` is generated from `package.json` at build, so a
rebuild rotates it.

- `readPlan` treats a fingerprint mismatch as a **miss**: updating verikun recompiles instead
  of replaying a plan the old compiler produced.
- `findSeed` **ignores** the fingerprint (an older plan is still a fine seed) but discards a
  seed that does not cover its own prose, and never seeds across platforms.
- A plan that [does not cover its test](/verikun/reference/ai-plans/#the-compile-must-cover-the-test)
  is **never written**; the rejection has to happen before the write, or caching turns one
  truncated compile into a pass replayed against every later build.

The key is the **resolved** prose (every [`@include`](/verikun/guides/natural-language-tests/#share-a-preamble-between-tests)
inlined) + package + build + platform, and each included chunk also has its own entry under
its own text. Reads are tolerant (a bad entry is a miss), writes are atomic, the compile is
cached immediately, and a green run re-persists the healed plan.

## The plan-compile lock

A pooled `vk suite` is one child process per test sharing one cache, so on a cold cache every
lane would miss the same fragment at once and compile its own. A **per-key lock**
(`./.verikun/plan-locks/<key>.lock`) makes the first process compile and the rest wait and
re-read.

- **Beside the cache, never inside it.** `.verikun/plans` is what CI restores with
  `actions/cache`; a lock in that tarball would come back on a fresh runner as a foreign-host
  corpse.
- **Taken only on a miss.** The steady state does no lock I/O.
- **Liveness is the pid, with an age ceiling.** There is no heartbeat, because a CLI provider
  compiles inside a blocking `spawnSync`. The wait ceiling is derived from `--timeout`, since
  the run's own deadline starts before the plan is obtained.
- **Never a new way to fail.** An unwritable directory, a corrupt lock, or a holder that
  outlives the ceiling all mean *compile anyway*. `VERIKUN_NO_PLAN_LOCK=1` restores the
  pre-lock behaviour exactly.
- **One lock at a time.** `compileFromSegments` takes and releases per segment; pre-acquiring
  every segment's lock deadlocks when two tests enumerate shared fragments in different orders.

Breaking a stale lock is deliberately *not* serialised with a takeover token: a lost race here
costs one duplicate compile, not two jobs on one phone. The two mechanisms share their
primitives (`pidAlive`, `writeExclusive`, `tmpPath`) and nothing else.

## Selector matching stays time-free

Matching is a pure function of one snapshot (`ui/selector.ts`). Waiting is layered on top in
`commands/auto-wait.ts`: only an empty match set is retried (a present-but-plural match exits
`2` at once), bare-index `tap N` and `tap --at x,y` never wait, and `assert` polls the whole
predicate. Route a new selector-resolving command through `resolveOneWaiting()` /
`matchWaiting()`, never a raw `resolveOne` / `matchElements`.

## A barrier-only tree is a read to repeat, not an absence

A tree holding only a modal barrier (`ui/barrier.ts`: a clickable, id-less, text-less node
covering a large part of the screen, nothing readable beside it) is re-read after a settle
**in the Android driver**, so every consumer meets it. Detection is by shape, never by the
localised label; an empty tree is a different signal. A barrier that persists is returned and
**named** in the miss, after one companion recycle at ~3s — only when the companion served the
reads, since a recycle would SIGKILL a stock dump.

## State modifiers are exactly one attribute

Each state predicate tests one attribute and nothing else; never strengthen one with a
conjunct the platform reports unreliably. `stateFromFlags()` must leave an absent flag
`undefined`, or every selector silently gains "must be disabled, unselected, unchecked and
unfocused".

## Auto-scroll: measured constants

- **Pace the swipe by distance** (~0.75 px/ms). The same 1118px swipe over 400ms took the app
  off the screen entirely on emulator API 34; over 1500ms it scrolled cleanly.
- **The platform is the first filter.** Android's dumper drops invisible nodes and clips the
  rest, so `Element.offscreen` is mostly an iOS signal.
- **Refusing to act** is reserved for an element with **no** on-screen pixel (exit `1`);
  occlusion only ever warns, because a wrong refusal is worse than the tap it prevents.

## Secrets

Step names never include typed text; `cmdText` redacts the value into the step message when
the field's `password` flag is set. **Keep that property if you add input commands.** Device
logs and failure evidence are raw and **not** redacted.

## Packaging: `"files"` is an allowlist

npm force-includes only five things: `package.json`, `README*`, `LICENSE`/`LICENCE` (either
spelling, any case or extension), the `main` file, and the `bin` file(s). **Not
`CHANGELOG.md`**, and not the skill. Anything else must be named in `"files"`, or it is
silently absent from the tarball: `npm publish` succeeds and nothing reports the omission.

Two guards, at different levels:

| Guard | Checks |
|---|---|
| `tests/package-files.test.ts` | The allowlist — **intent** |
| `scripts/check-package-contents.mjs` | The packed tarball's real contents — **result** |

Only the artifact check can catch a stray `.npmignore`, npm changing how it treats the
`.claude/` dot-directory (it traverses it today; undocumented behaviour we depend on), or a
new subdirectory appearing under `example/`.

The `example` entry is the glob **`example/*.md`**, not a bare `example`: that directory also
holds the Flutter e2e fixture, and a bare directory entry would sweep all of it into the
tarball. **Keep the glob.** The docs site in `docs/` is not in `"files"` and never enters the
tarball.
