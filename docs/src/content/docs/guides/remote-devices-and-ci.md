---
title: Remote devices & CI
description: Expose a real device over an authenticated tunnel with vk server, and gate a pull request on it from a disposable GitHub Actions runner.
sidebar:
  order: 4
---

CI runners do not have your phone plugged into them. `vk server` exposes a
locally-connected device to remote verikun clients, so a **disposable CI runner** can drive
it — without a self-hosted runner executing arbitrary pull-request code on the machine that
owns the device.

## The shape of it

Two machines, with a clear split:

| | Runs | Holds |
|---|---|---|
| **Device box** — the machine with the phone attached | `vk server`, and nothing else | the device |
| **CI runner** — throwaway `ubuntu-latest` | the whole `vk ai` engine: compile, plan cache, repairs, run recording, suite aggregation | the model API key, the test files |

Only **validated device commands** cross the network — one HTTP round-trip per command.
Selector [auto-wait](/verikun/reference/auto-wait/) polls on the server, next to the device,
so a slow screen does not cost a round-trip per poll.

Each step's detail — selector, heal tier, resolved element, failure screenshot and hierarchy
— returns with the response and is spliced into the client's run, so the archived report is
**identical to a local run's**.

Because the engine and the model both live on the runner, a drifted step is repaired there too.
Whether that should fail your build, and what a repair can and cannot hide, is
[Self-healing in CI](/verikun/guides/self-healing-in-ci/).

## Start the server

On the machine with the device attached:

```sh
export VERIKUN_SERVER_AUTH_KEY=$(openssl rand -base64 32)   # or let vk generate one
vk server --allow-install                    # 127.0.0.1:8391 by default
vk server --bind 100.64.0.7 --allow-install  # expose on a tailnet IP
```

### Serving several devices from one address

```sh
vk server --devices all --bind 100.64.0.7 --allow-install          # every usable device
vk server --devices all-ios --bind 100.64.0.7                      # only the simulators
vk server --devices emulator-5554,emulator-5556 --bind 100.64.0.7  # a named pair
```

`all-android` / `all-ios` both select the devices **and** pin the platform, so a host with
emulators *and* simulators attached never has to be read as two flags. A bare `all` means
"every usable device of this server's platform"; a named serial that is not attached is a
startup error rather than a silently smaller pool.

When a host has both kinds attached, `all` takes the **virtual** ones and says so — a
simulator and a plugged-in iPhone are not interchangeable (log capture is
[unsupported on the phone](/verikun/guides/platform-support/)), and `all` has no business
enlisting somebody's handset while an emulator is running. Name the serial to pool a
physical device deliberately.

`vk suite --devices` takes the same spelling, resolved against the machine the suite runs
on. It is a usage error to combine it with `--server`: those serials are local, so the
suite would quietly test the wrong machine.

A pooled server keeps one URL and one secret. Each run token **leases** one device for its
whole run — compile, every step, every repair — so a client needs no device id and cannot end
up half-way through a flow on a different phone. A parallel
[`vk suite --server`](/verikun/guides/suites/#running-across-several-devices) reads the pool's
capacity from `/v1/health` and sizes itself to match, so the CI line does not change.

Two things behave differently on a pool: `vk install --server` installs on **every** device
(otherwise later lanes would run the previous build), and `/v1/devices/{start,restart,stop}`
answer `403` — there is no single device for them to act on, and guessing would let one job
power-cycle a phone another is mid-test on. Run one server per device if you need that.

From anywhere that can reach it:

```sh
export VERIKUN_SERVER=http://100.64.0.7:8391
export VERIKUN_SERVER_AUTH_KEY=<the same key>

vk install ./app-debug.apk --server "$VERIKUN_SERVER"
vk ai onboarding.md --server "$VERIKUN_SERVER"
vk suite tests/ --app com.example.app --server "$VERIKUN_SERVER"
```

### Check which read path the server is using

Reads happen server-side, so how the server reads the hierarchy sets the pace of your whole
suite — on Android the difference between the [companion](/verikun/guides/companion/) and the
stock dump is roughly 0.2s and 2.4s per read. The server reports it:

```sh
curl -s "$VERIKUN_SERVER/v1/health" | jq .reads
# { "path": "companion", "detail": "ready app held" }
```

`/v1/health` needs no auth key, so this works as a CI preflight assertion. The server also
prints it at startup, every `--server` client echoes it once at run start, and a suite's
`index.json` records it alongside the **server's** verikun version — which, for a `--server`
run, is the one that actually drove the device.

## The transport: Tailscale

The device box is usually behind NAT — a desk, an office, someone's home. It has no routable
address for a GitHub-hosted runner to dial.

[Tailscale](https://tailscale.com) is the recommended answer. It gives the device box a
stable `100.x.y.z` address on a private tailnet, and the runner joins that tailnet for the
duration of the job. Any routable address works; Tailscale is simply the least work.

In a workflow, add the Tailscale action **before** the suite step:

```yaml
- name: Connect to the tailnet
  uses: tailscale/github-action@v3
  with:
    oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
    oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
    tags: tag:ci
```

For a public host instead, terminate TLS in front of the server — it speaks plain HTTP by
design, and does not try to be a TLS endpoint.

## The security model

**The server is the boundary, not the transport.** Even on a private tailnet, these hold:

### Auth is mandatory

Pass a key via `--auth-key` or `VERIKUN_SERVER_AUTH_KEY` (the environment variable keeps it
out of `ps`), or one is generated and printed at startup. Clients send it as a bearer token,
and comparison is constant-time.

`--allow-unsafe-anonymous` disables auth loudly. It is only for networks that are themselves
the boundary, and it **cannot be combined with a key**.

### Only the validated grammar runs

Every `/v1/exec` request passes the same `validateNode` gate that guards `vk ai` model
repairs: action verbs only (`tap`, `text`, `assert`, `launch`, …), never `ui` or `log`, and
never a shell.

The device and platform are **fixed when the server starts** — no flag on an `exec` request
can repoint them. Only `/v1/devices/*` can change that binding, and it is off unless you opt
in (below).

### Installs are opt-in

`POST /v1/install` requires `--allow-install`; a read-only server refuses builds. It accepts
only single-file `.apk` / `.ipa` uploads, writes to a **server-generated** temp path (never a
client-supplied one), and verifies a sha256 of the body.

That one flag also authorizes the removal an install sometimes needs: an Android build signed
by a different key than the installed one cannot be updated over, so the server removes the
installed build and installs again — losing that build's app data, and logging it. There is no
separate permission; if you do not want that, do not pass `--allow-install`.

### Device control is opt-in, and naming is allowlisted

`--allow-device-control` lets an authenticated client `restart` or `stop` **the server's own
device** — the recovery path for a device that has gone flaky mid-suite. It names nothing.

`--allow-device-control=Pixel_6_API_34,...` additionally lets a client **start** one of those
operator-declared targets. Enumerating the host's AVDs is autocomplete, not authorization, so
the allowlist is the boundary: a request naming anything else is rejected with a message that
does not reveal whether it exists.

Every mutation takes the device lock, so a restart while another run holds the device is a
`409` — but the **holder** may power-cycle its own device, which is what makes recovery work.

With the flag the server will also start with **no device attached**: `/v1/health` reports
`serial: null` and the device endpoints answer `503` telling you to boot one. Without that, a
server whose device is down could never be fixed remotely. An *ambiguous* device still fails
fast at startup — that is an operator error, and booting another device makes it worse.

:::caution
Enabling device control also lets that client **erase** the device (`--wipe`). That is the
honest cost of the flag; leave it off if you do not want it.
:::

### One run per device

A run token **leases** a device. A caller that arrives when every device is already leased
gets **`409`**.

The lease is released when the command finishes, so `vk install` then `vk suite` chain
seamlessly. A lease that has been silent for **5 minutes** may be taken over — but only by a
run that actually needs a device, so a crashed CI job cannot wedge a device permanently while
a merely slow one (a cold compile, a model repair) keeps its own phone. A run that *does* lose
its device is told so with a `409` naming it, never handed a different one: its earlier steps
ran somewhere else, and continuing elsewhere would report one run that executed on two.

A pooled server therefore serves as many concurrent runs as it has devices — and no more.

### Bind is loopback by default

`--bind <addr>` is what opts into exposure. The default is `127.0.0.1`.

:::caution
Failure evidence — screenshots, UI hierarchies — crosses the authenticated channel like
everything else, and carries the same caveat as `vk log`: **device output is not redacted.**
Treat archived reports as potentially containing whatever the app logged.
:::

## A GitHub Actions workflow you can copy

[`.github/workflows/suite.yml`](https://github.com/ddikman/verikun/blob/main/.github/workflows/suite.yml)
in the verikun repository is a working reference. Here is what each part does.

### Trigger and concurrency

```yaml
on:
  workflow_dispatch:
    inputs:
      tests_dir:
        description: Directory of *.md tests to run
        default: example
      app_id:
        description: App package/bundle id to reset between tests (optional)
        default: ''

concurrency:
  group: device-suite      # one suite at a time — the server's devices are all leased by it
  cancel-in-progress: false
```

The `concurrency` group is **load-bearing**. A second job would get `409` rather than
queueing, because a parallel suite leases every device the server has. `cancel-in-progress:
false` means a queued run waits instead of killing the one holding the devices.

If you want two jobs to share a host, give each its own server (`--devices` naming disjoint
serials, on different ports) rather than relaxing this group.

Start with `workflow_dispatch` while you prove the setup, then add `pull_request` once the
device server is reliably reachable from PR builds.

### Secrets it expects

| Secret | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | The model key for compile and repair. Not needed if you use a [CLI backend](/verikun/reference/ai-plans/#models). |
| `VERIKUN_SERVER` | The server's address, e.g. `http://100.64.0.7:8391` |
| `VERIKUN_SERVER_AUTH_KEY` | The server's auth key |

### Build verikun on the runner

```yaml
- name: Check out the repository
  uses: actions/checkout@v7

- name: Set up Node.js
  uses: actions/setup-node@v7
  with:
    node-version: 22.x
    cache: npm

- name: Build verikun
  run: |
    npm ci
    npm run build
    npm link
```

In your own repository you would install the published package instead —
`npm install -g verikun` — and skip the build.

### Restore the plan cache

```yaml
- name: Restore the vk ai plan cache
  uses: actions/cache/restore@v6
  with:
    path: .verikun/plans
    key: verikun-plans-${{ github.run_id }}
    restore-keys: verikun-plans-
```

A fresh runner has no `./.verikun/plans/`, so **without this every test recompiles on every
run** and the suite never reaches the near-\$0 steady state. There is a matching
`actions/cache/save` with `if: always()` after the suite — a failed run's compiles are worth
keeping too. Cache `.verikun/plans` only: the sibling `.verikun/plan-locks/` is per-machine
and must not travel. Why the key does not have to be exact, and the caveats:
[Self-healing in CI](/verikun/guides/self-healing-in-ci/#what-it-costs--and-the-cold-cache).

### Install the app build on the remote device

```yaml
- name: Install app build on the remote device
  run: |
    if compgen -G "*.apk" > /dev/null; then
      vk install ./*.apk --server "$VERIKUN_SERVER"
    else
      echo "no .apk in the workspace — skipping install"
    fi
  env:
    VERIKUN_SERVER: ${{ secrets.VERIKUN_SERVER }}
    VERIKUN_SERVER_AUTH_KEY: ${{ secrets.VERIKUN_SERVER_AUTH_KEY }}
```

Produce or fetch the build in an earlier step — a build job artifact, a release download,
whatever you already have. The guard means a plain suite re-run still works when no build is
present.

This requires the server to have been started with `--allow-install`.

### Run the suite — this is the gate

```yaml
- name: Run the test suite
  run: |
    APP_FLAG=""
    if [ -n "${{ inputs.app_id }}" ]; then APP_FLAG="--app ${{ inputs.app_id }}"; fi
    vk suite "${{ inputs.tests_dir }}" --server "$VERIKUN_SERVER" $APP_FLAG
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    VERIKUN_SERVER: ${{ secrets.VERIKUN_SERVER }}
    VERIKUN_SERVER_AUTH_KEY: ${{ secrets.VERIKUN_SERVER_AUTH_KEY }}
```

The suite [exits non-zero when any test fails](/verikun/guides/suites/#the-exit-code-is-the-ci-gate),
which fails this step and therefore the job. **The CI gate needs no extra plumbing** — no
result parsing, no separate check step.

### Upload the evidence

```yaml
- name: Upload suite reports
  if: always()
  uses: actions/upload-artifact@v7
  with:
    name: verikun-suite
    path: |
      .verikun/suites
      .verikun/runs
    if-no-files-found: warn
```

`if: always()` is the important bit — the evidence uploads exactly when it matters, on a
failed suite. Without it, the artifact step is skipped by the failing suite step above and
you get a red job with nothing to look at.

### Publishing results elsewhere

Reporting providers are **composable CI steps over the stable `index.json` manifest**, not
verikun plugins. Two examples, commented out in the reference workflow:

```yaml
- name: Publish to Google Drive (rclone)
  if: always()
  run: rclone copy .verikun/suites "gdrive:ci-reports/${{ github.run_id }}"

- name: Publish to S3
  if: always()
  run: aws s3 cp .verikun/suites "s3://my-reports/${{ github.run_id }}/" --recursive
```

## Recovering a dead or flaky device

```sh
# On the server host — let clients boot the AVD by name:
vk server --device emulator-5554 --allow-device-control=Pixel_6_API_34 --allow-install

# From the client:
vk devices --server "$VERIKUN_SERVER"                         # what can it see / boot?
vk devices restart --server "$VERIKUN_SERVER"                 # its device is wedged
vk devices start Pixel_6_API_34 --server "$VERIKUN_SERVER"    # it has none bound
vk suite tests/ --ensure-device --server "$VERIKUN_SERVER"    # boot once, then run
```

`--ensure-device[=<name>]` also works locally and on `vk ai` / `vk install`. It runs **once,
before the first step** — never between tests and never mid-run, so it cannot turn a red test
green. It means "boot something if nothing is usable"; when a device is already available it
is a no-op and says so, even if you named a different one.

There is deliberately **no** automatic mid-run restart: a reboot destroys the app session, so
the retried step would pass meaninglessly or cascade into confusing failures. Failover, below,
is a *lateral* move under the same rule — it never reboots, and it never replays a step.

## When the bound device fails

A pool that cannot route around one bad member has the availability of its worst member. So
when the device a server is bound to cannot serve a request, the server moves to another
attached device and rules the bad one out.

```
[server] install: FAILED on emulator-5554 — the device is out of space (INSTALL_FAILED_INSUFFICIENT_STORAGE)
[server] failover: emulator-5554 quarantined (the device is out of space)
[server] failover: 2 candidate(s) — emulator-5556, 032AY1UNR2
[server] failover: emulator-5556 probe ok — moving
[server] device: android · emulator-5556
[server] install: retrying on emulator-5556… done on emulator-5556 (after 1 move)
```

### It is on by default, unless you pinned the device

|  | Failover |
|---|---|
| `vk server` (no `--device`) | **on** — the server already auto-selected a free device; moving to another free one is that same decision made again |
| `vk server --device X` | **off** — you named the device, and a pin means what it says |
| `--allow-failover` | on even for a pinned server; any attached, running, unclaimed device |
| `--allow-failover=<a,b>` | as above, bounded to those serials or AVD/simulator names |
| `--no-failover`, `VERIKUN_NO_FAILOVER=1` | off outright |

A candidate must already be **running**: failover never boots anything. Booting is
`vk devices start --server`'s job, it takes minutes inside a held device lock, and letting a
client cause a boot it is not allowed to *name* would be an escalation. Failover is lateral,
never upward.

### An install is retried. A step is not.

This is the important half, and the asymmetry is deliberate.

`install` is idempotent, carries no app session, and its uploaded bytes are still on the
server's disk — so it is replayed on the new device and your job simply succeeds.

A **step** is not. Step 12 of a flow presupposes steps 1–11 ran *on that device*; the new
device's app is wherever an earlier run left it. Replaying there would either find something
matching and go **green** — a false green that ships a regression — or wake the repair model
against the wrong screen. So the step fails, honestly, carrying **the old device's error**:

```
[verikun] server moved device: emulator-5554 → 032AY1UNR2 (the device is not attached) — this step failed on the old device; the next runs on the new one
```

The run that hit the bad device still fails. It is the **next** one that lands somewhere
healthy — the next `vk suite` test, or the next `--retries` attempt, with no intervention.

### Deciding whose fault a failure was

Reachability is not the signal — a phone with a full disk answers `adb get-state` happily. So
verikun enumerates the install failures that are provably about the **build**
(`INSTALL_PARSE_FAILED_*`, `INSTALL_FAILED_INVALID_APK`, `_TEST_ONLY`, an unreadable `.apk`)
and treats **everything else** as the device's fault, including wordings nobody has seen
before: a broken build fails identically everywhere, anything else might work next door.

A step keeps the opposite default — exit `3` there is dominated by transient device noise, so
verikun re-probes the device twice a second apart and only moves if it is genuinely gone.

At most **two** moves per request, and on exhaustion the client is given the **first** device's
error, never the last, so the real cause stays the headline:

```
Failed to install '…apk': adb: device offline
[failover] no working device remains; ruled out:
  emulator-5554  the device is offline
[failover] reattach or fix a device and the pool re-adopts it within a minute; an emulator can also be power-cycled with `vk devices restart <name> --server <url>`
```

### Failover on a pool

With [`--devices`](#serving-several-devices-from-one-address) the same machinery keeps the pool
at **full capacity** rather than moving a single binding: a healthy unclaimed device that is
attached and not yet a member joins, the failed one leaves, and every other lease keeps
serving. Usually there is no such spare, because `--devices all` already pooled everything
attached. Then the failing device is **demoted, not dropped**:

- It keeps its worker, its claim and its place in the pool, and `/v1/health` lists it under
  `degraded` rather than `quarantined`.
- Leases are dealt **healthy first, then least-recently-used**, so a demoted device is chosen
  only when nothing else is free.
- It is **restored by working**, not by a timer — the first step or hierarchy read that
  succeeds on it puts it back in the healthy rotation.

**The lease follows the move.** The run whose device failed lands on the replacement the server
just announced, without losing its place in the queue; the failing *step* is still never
replayed — the client seals that run and opens a fresh one on the new device, so no report
spans two. **The last device is never shed**: a server down to its final device stays on it,
because a bare `503` would replace the real diagnosis with a message that names nothing.

### A device that comes back rejoins by itself

A pooled server sweeps once a minute for devices that *should* be serving and are not — a
worker that died, a phone unplugged and replugged, an emulator restarted out of band, or (with
`--devices all`) one attached after startup; an explicit `--devices a,b,c` only re-adopts from
that list. Starting the worker **is** the probe, so a device that is still broken simply fails
to come back; each failure doubles the wait, up to 30 minutes, and every attempt is logged. A
rejoining device is brought up to the session's last install before it is dealt any work, and
stays out if that install fails.

```
[server] pool: emulator-5556 left the pool — worker exited with code 1
[server] reconcile: emulator-5556 should be serving and is not — attempt 1
[server] reconcile: emulator-5556 did not rejoin — next attempt in 120s
[server] pool: emulator-5556 joined the pool (2 device(s) serving)
[server] reconcile: emulator-5556 brought up to the current build
```

### What was ruled out, and how to clear it

A quarantine says "never move *onto* this device". It lasts as long as the server process and
has no timer, on purpose — a device that ran out of disk ten minutes ago is still out of disk.
A successful `vk devices restart|start|stop` for that device clears it, and so does rejoining
the pool, because coming up is a real probe. An install that fails on *every* device is read
as a bad build, not a bad pool, so the quarantines that attempt set are rolled back.

```sh
curl -s "$VERIKUN_SERVER/v1/health" | jq '{capacity, devices, degraded, quarantined}'
vk devices --server "$VERIKUN_SERVER"     # a NOTE column shows why each was ruled out
```

Failover makes a full disk *survivable*, not impossible: a long-lived CI device accumulates
builds and app data from every job pointed at it, so budget for cleaning it up.

## Running the server as a long-lived service

For anything beyond experimentation, the server should survive a reboot. On macOS, a
`launchd` agent; on Linux, a `systemd` unit. The essentials either way:

- Set `VERIKUN_SERVER_AUTH_KEY` in the service environment, not on the command line.
- Bind to the tailnet address, not `0.0.0.0`.
- Pass `--allow-install` only if CI actually needs to push builds.
- Restart on failure — the device lock's 5-minute idle takeover means a restart mid-run does
  not permanently wedge anything.

The server writes its own log, so a service unit needs no output redirection — by default
`~/.verikun/logs/server-<port>.log`, rotated at 10 MB keeping one previous generation and named
in the startup banner; `--log-file <path>` moves it (useful when the service runs as a user
whose `$HOME` is not where you look) and `--log-file off` leaves stderr only. It records every
request with its status, run
token and leased device, the reason behind every error the client was sent, and every lease,
failover and pool change:

```
2026-09-02T09:14:22.108Z [server] POST /v1/exec run=a1b2c3d4 dev=emulator-5554 → 200 (812ms)
2026-09-02T09:14:31.744Z [server] pool: emulator-5556 degraded — the device stopped answering (dealt last until it works again)
2026-09-02T09:14:31.745Z [server] lease: run 9f8e7d6c… evicted from emulator-5556 — emulator-5556 is no longer in the pool
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `409` from the server | Another run holds the device. Check your `concurrency` group; a lease silent for 5 minutes is taken over when someone else needs it. A `409` saying the run "cannot continue on another device" means yours was the one taken over — rerun it. |
| `401` | The auth key does not match. Both sides must use the same `VERIKUN_SERVER_AUTH_KEY`. |
| Exit `3`, "server unreachable" | Network path, not verikun. Check the tailnet is up on the runner. |
| Installs rejected | The server was started without `--allow-install`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / `signatures do not match` | The device holds a build of the same package signed by a different key. On Android the server removes it and retries by itself; if it still fails, the message names the package and the `adb uninstall` to run on the host. iOS has no such recovery. |
| `not enough space` / `INSTALL_FAILED_INSUFFICIENT_STORAGE` | The device's disk is full. With failover on the server moves to another attached device by itself; if it reports `no working device remains`, free space on the named device or `vk devices restart` it. |
| The suite ran on a device you did not expect | The server failed over. `[verikun] server moved device:` on the client, and `/v1/health`'s `quarantined`, say which device was ruled out and why. |
| A pool's `capacity` fell during a run | Read the server log (`~/.verikun/logs/server-<port>.log`). A device only leaves the pool when its worker died; one that merely failed is `degraded` and still serving. Anything that left is retried automatically, with the reason and the next attempt logged. |
| A device never rejoins the pool | Its rejoin attempts are failing — the log names the reason each time. Backoff doubles to a 30-minute ceiling, so check the most recent `reconcile:` line rather than waiting. |
| Steps take ~2.4s each on Android | The server is on the stock read path. `curl "$VERIKUN_SERVER/v1/health" \| jq .reads` says which, and why — most often `VERIKUN_COMPANION` is set in the **server's** environment, or the [companion](/verikun/guides/companion/) declined on that device. |

More in [Troubleshooting](/verikun/guides/troubleshooting/).

## Known gap

Under `--server`, the [device-state](/verikun/reference/device-state/) snapshot is written by
the **server** process. A client that crashes outright therefore leaves overrides applied on
the device — `vk device reset` from the device box puts them back.
