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

## Start the server

On the machine with the device attached:

```sh
export VERIKUN_SERVER_AUTH_KEY=$(openssl rand -base64 32)   # or let vk generate one
vk server --allow-install                    # 127.0.0.1:8391 by default
vk server --bind 100.64.0.7 --allow-install  # expose on a tailnet IP
```

From anywhere that can reach it:

```sh
export VERIKUN_SERVER=http://100.64.0.7:8391
export VERIKUN_SERVER_AUTH_KEY=<the same key>

vk install ./app-debug.apk --server "$VERIKUN_SERVER"
vk ai onboarding.md --server "$VERIKUN_SERVER"
vk suite tests/ --app com.example.app --server "$VERIKUN_SERVER"
```

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

The device and platform are **fixed when the server starts** — client flags cannot repoint
them.

### Installs are opt-in

`POST /v1/install` requires `--allow-install`; a read-only server refuses builds. It accepts
only single-file `.apk` / `.ipa` uploads, writes to a **server-generated** temp path (never a
client-supplied one), and verifies a sha256 of the body.

### One run at a time

A run-token holds the device lock. A second concurrent caller gets **`409`**.

The lock is released when the command finishes, so `vk install` then `vk suite` chain
seamlessly. An idle lock (5 minutes silent) is taken over, so a crashed CI job cannot wedge
the device permanently.

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
  group: device-suite      # one suite at a time — the server holds a single device lock
  cancel-in-progress: false
```

The `concurrency` group is **load-bearing**. The server permits one run at a time; a second
job would get `409` rather than queueing. `cancel-in-progress: false` means a queued run
waits instead of killing the one holding the device.

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

## Running the server as a long-lived service

For anything beyond experimentation, the server should survive a reboot. On macOS, a
`launchd` agent; on Linux, a `systemd` unit. The essentials either way:

- Set `VERIKUN_SERVER_AUTH_KEY` in the service environment, not on the command line.
- Bind to the tailnet address, not `0.0.0.0`.
- Pass `--allow-install` only if CI actually needs to push builds.
- Restart on failure — the device lock's 5-minute idle takeover means a restart mid-run does
  not permanently wedge anything.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `409` from the server | Another run holds the device lock. Check your `concurrency` group; an idle lock is taken over after 5 minutes. |
| `401` | The auth key does not match. Both sides must use the same `VERIKUN_SERVER_AUTH_KEY`. |
| Exit `3`, "server unreachable" | Network path, not verikun. Check the tailnet is up on the runner. |
| Installs rejected | The server was started without `--allow-install`. |

More in [Troubleshooting](/verikun/guides/troubleshooting/).

## Known gap

Under `--server`, the [device-state](/verikun/reference/device-state/) snapshot is written by
the **server** process. A client that crashes outright therefore leaves overrides applied on
the device — `vk device reset` from the device box puts them back.
