// The remote-execution wire contract shared by `vk server` (src/server.ts) and the
// remote backend (src/agent/remote.ts): request/response shapes plus the error codec
// that carries a thrown error's SUBCLASS IDENTITY across the wire. The `vk ai` engine
// decides heal-vs-terminal via `instanceof SelectorNotFoundError/AmbiguousSelectorError`
// (agent/engine.ts), so a serialized error must rebuild into the same class — a plain
// `{message}` would silently turn every remote selector miss into a terminal failure.
//
// Pure types + pure functions only: no http, no fetch, no fs — so both sides (and the
// unit tests) can import it without dragging in transport code.

import { CliError, SelectorNotFoundError, AmbiguousSelectorError } from './errors';
import type { DeviceInfo, Element, HierarchySource, Platform } from './types';
import type { RunStep } from './run';

/** One validated leaf command, exactly the triple `executeOutcome` consumes. */
export interface ExecRequest {
  command: string;
  positionals: string[];
  /** args-parser flag map; a boolean flag is carried as "true" (same as plan-IR leafToFlags). */
  flags: Record<string, string>;
}

export interface ErrorDescriptor {
  /** Which class to rebuild. 'Error' covers a non-CliError throw (exit 3 semantics). */
  kind: 'CliError' | 'SelectorNotFoundError' | 'AmbiguousSelectorError' | 'Error';
  name: string;
  message: string;
  exitCode: number;
  /** Present only for AmbiguousSelectorError — the elements the selector hit. */
  candidates?: Element[];
}

/**
 * The server moved itself off the device it was bound to, mid-request.
 *
 * OPTIONAL twice over — absent from every older server AND absent when nothing moved —
 * so a client MUST feature-detect on the FIELD, never on `version` (the standing rule
 * on HealthResponse.deviceControlEnabled below: "old server" and "new server, nothing
 * moved" are indistinguishable and need the same answer).
 */
export interface DeviceChange {
  /** The device that failed. */
  from: string;
  /** The device the server is now bound to. */
  to: string;
  /** One line: "the device is out of space (INSTALL_FAILED_INSUFFICIENT_STORAGE)". */
  reason: string;
  /**
   * Was the failed operation REPLAYED on `to`?
   *
   * true only for `install`, which is stateless. false everywhere else, and that is the
   * load-bearing half: a `vk ai` step twelve deep presupposes the eleven before it ran
   * on `from`, so replaying it on `to` would either pass meaninglessly (a false green)
   * or wake the repair model against the wrong screen. The step still fails; it is the
   * NEXT one that benefits from the move.
   */
  retried: boolean;
}

export interface ExecResponse {
  code: number;
  error?: ErrorDescriptor;
  /** Set when this request moved the server's device. `retried` is always false here. */
  deviceChanged?: DeviceChange;
  /** The step the server's ephemeral recorder produced (selector, tier, resolved
   *  element, failure evidence refs) — spliced into the caller's run verbatim. */
  step?: RunStep;
  /** Artifact files the step references (screenshots), rel path → base64 bytes. */
  artifacts?: Record<string, string>;
  /** Device-clock marker (`MM-DD HH:MM:SS.mmm`) sampled at this exec, so the
   *  caller's run can set `logStart` (ephemeral recording never persists it). */
  logStart?: string;
}

export interface ElementsResponse {
  elements: Element[];
}

/** Body of a successful POST /v1/install. */
export interface InstallResponse {
  ok: true;
  bytes: number;
  sha256: string;
  /** Every device the build landed on. A pooled server installs on ALL of them, or the
   *  later lanes of a parallel suite would run the previous build. Absent on older servers. */
  devices?: string[];
  /** Set when a device failed and the build went on to another. `retried: true`. On a pool
   *  that moved more than one device this is the first move; the server logs the rest. */
  deviceChanged?: DeviceChange;
}

export interface LogsRequest {
  lines?: number;
  since?: string;
  appId?: string;
  /** When true with appId, drivers must not fall back to a system-wide dump. */
  scopedOnly?: boolean;
}

export interface LogsResponse {
  logs: string;
}

/**
 * POST /v1/lease — which device this run token is driving.
 *
 * Affinity needs no device id on the wire: the `x-verikun-run` header already scopes a
 * whole run, so the server keys the lease on it and every later call of that run lands
 * on the same device. The client asks up front purely so it can ATTRIBUTE its steps
 * before the first one executes; a client that never asks still gets a lease implicitly
 * on its first /v1/exec, it just cannot name the device in its report.
 *
 * Idempotent per token, and 409 when every device is already leased.
 */
export interface LeaseResponse {
  platform: Platform;
  serial: string;
  /** The read path of THIS device — the per-device answer `/v1/health` cannot give
   *  for a pool. */
  reads?: HierarchySource;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  platform: Platform;
  /**
   * Resolved serial/udid for a SINGLE-device server, or null when there is no one
   * answer — either nothing is attached, or this server pools several devices (see
   * `capacity`). Kept as-is for one device so every existing client is untouched.
   */
  serial: string | null;
  /** How many devices this server can drive at once. ABSENT on servers predating the
   *  pool, where it is always 1 (or 0 when `serial` is null). A client sizing a
   *  parallel suite reads this; treat undefined as 1. */
  capacity?: number;
  /** The serials in the pool, for diagnostics. Absent on older servers. */
  devices?: string[];
  /** Whether POST /v1/install is enabled on this server (`--allow-install`). */
  installEnabled: boolean;
  /**
   * Which read path this server's driver will use for the next hierarchy read, and why.
   *
   * OPTIONAL because an older server does not send it (and a backend with one read path has
   * no answer). Added in 0.21.1: reads happen server-side, so a `--server` client could
   * previously only infer the read path from its own step durations — which is how a
   * companion that had silently stood down went unnoticed for a whole suite (issue #77).
   */
  reads?: HierarchySource;
  /** Whether POST /v1/devices/* is available (`--allow-device-control`). ABSENT on
   *  servers predating the flag, so a client MUST treat undefined as false — and must
   *  feature-detect on these fields rather than comparing `version`, because "old
   *  server" and "new server, flag off" are indistinguishable and need the same answer. */
  deviceControlEnabled?: boolean;
  /** Whether a named target may be requested (`--allow-device-control=<names>`). */
  deviceNamingEnabled?: boolean;
  /** Derived from `serial` wherever health is built, so the two can never disagree. */
  deviceState?: 'ready' | 'none';
  /** Whether this server may move off a device that fails. ABSENT on older servers;
   *  feature-detect on the field, as with deviceControlEnabled above. */
  failoverEnabled?: boolean;
  /**
   * Devices this server has ruled out this session, and why. Omitted when empty, so a
   * CI job can assert on its absence. Unauthenticated like the rest of /v1/health,
   * which is what makes "is the pool healthy?" answerable without a run token.
   */
  quarantined?: Array<{ serial: string; reason: string }>;
}

/** Body of POST /v1/devices/{start,restart,stop}. An empty body is the only form a
 *  server without an --allow-device-control allowlist accepts. */
export interface DeviceOpRequest {
  /** AVD name / simulator name-or-UDID. Rejected unless the server allowlists it. */
  target?: string;
  /** Erase the device's data as part of the operation. Never defaulted on. */
  wipe?: boolean;
}

export interface DeviceOpResponse {
  ok: true;
  platform: Platform;
  /** The serial the server is now bound to; null after a successful stop. */
  serial: string | null;
  /** false when the call was a no-op (a healthy device was already bound). */
  changed: boolean;
  durationMs: number;
}

export interface DeviceListResponse {
  /** What the server can see. Filtered to the allowlist when one is configured — a
   *  CI job has no business learning the names of the operator's other devices. */
  devices: DeviceInfo[];
  /** Names this server will boot on request (the --allow-device-control allowlist). */
  startable: string[];
  /** The serial currently bound, or null. */
  bound: string | null;
}

/** Body of every non-2xx JSON response (auth, lock, validation, handler crash). */
export interface RpcErrorBody {
  error: string;
  exitCode?: number;
  /**
   * The server moved device while failing this request. Lives on the ERROR body because
   * that is where it matters most: `/v1/elements` and an install that exhausted the pool
   * both fail, and the client still needs to know the ground shifted under it.
   */
  deviceChanged?: DeviceChange;
}

// --- error codec ------------------------------------------------------------

/** Serialize a thrown error for the wire, preserving what the engine needs to
 *  tell a heal trigger from a terminal failure. */
export function describeError(e: Error): ErrorDescriptor {
  if (e instanceof AmbiguousSelectorError) {
    return { kind: 'AmbiguousSelectorError', name: e.name, message: e.message, exitCode: e.exitCode, candidates: e.candidates };
  }
  if (e instanceof SelectorNotFoundError) {
    return { kind: 'SelectorNotFoundError', name: e.name, message: e.message, exitCode: e.exitCode };
  }
  if (e instanceof CliError) {
    return { kind: 'CliError', name: e.name, message: e.message, exitCode: e.exitCode };
  }
  return { kind: 'Error', name: e.name || 'Error', message: e.message, exitCode: 3 };
}

/** Rebuild the error a server serialized, restoring its class so `instanceof`
 *  checks (and `candidates` / `exitCode`) behave as if it were thrown locally. */
export function rebuildError(d: ErrorDescriptor): Error {
  switch (d.kind) {
    case 'AmbiguousSelectorError':
      return new AmbiguousSelectorError(d.message, d.candidates ?? []);
    case 'SelectorNotFoundError':
      return new SelectorNotFoundError(d.message);
    case 'CliError':
      return new CliError(d.message, d.exitCode);
    default: {
      const e = new Error(d.message);
      e.name = d.name || 'Error';
      return e;
    }
  }
}

// --- execution backend seam ---------------------------------------------------

/**
 * Where `vk ai` / `vk suite` / `vk install` run their device work — local (wrapping a
 * Driver) or remote (wrapping the HTTP transport to a `vk server`). Injected at the
 * ENGINE-DEPS level (exec + getElements), not as a RemoteDriver: executeOutcome's
 * auto-wait re-polls driver.getElements() every ~300ms, so wrapping the Driver would
 * put every poll on the network — injecting at the command level keeps the whole
 * auto-wait loop server-side and makes a leaf command exactly one round-trip.
 */
export interface ExecBackend {
  /** Run one leaf command, returning its raw outcome (matches the engine's ExecFn). */
  exec(command: string, positionals: string[], flags: Record<string, string>): Promise<{ code: number; error?: Error }>;
  /** Live hierarchy for engine control-flow guards and repair context. */
  getElements(): Element[] | Promise<Element[]>;
  /** One-shot device-log snapshot (archive-time capture / diagnostics). Optional:
   *  older remotes without `/v1/logs` simply omit it and archive proceeds without. */
  getLogs?(opts?: { lines?: number; since?: string; appId?: string; scopedOnly?: boolean }): string | Promise<string>;
  /** Install an app build (`vk install`). */
  install(appPath: string): Promise<void> | void;
  /** Reset app state between suite tests (clear on Android; honest degrade to stop on iOS). */
  reset(appId: string): Promise<void> | void;
  /** Verify the backend can actually drive the device, throwing CliError(…, 3) if not
   *  (locally: the driver's toolchain; remotely: the server still answers). Called once
   *  up front by `vk ai` / `vk suite`, and again by the suite as a health probe after an
   *  environment-flavoured failure — so it must stay cheap and STATELESS. */
  preflight?(): Promise<void> | void;
  /** Release held resources when the command finishes — the remote backend frees
   *  the server's device lock so the NEXT command (a fresh run token) isn't 409'd
   *  until the idle takeover. Best-effort; local backends need none. */
  close?(): Promise<void> | void;
  /** Best-effort evidence for a failure the `vk ai` ENGINE produced outside a command
   *  (a control node giving up, a budget/timeout abort). Those never run through
   *  exec(), so no step recorder captured the screen. Never throws — a piece it cannot
   *  get is simply omitted, since the device being gone is often WHY we failed. The
   *  remote backend has no screenshot route, so it returns the hierarchy only. */
  captureFailure?(): Promise<{ png?: Buffer; hierarchy?: Element[] }>;
}
