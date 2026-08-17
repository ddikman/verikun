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

export interface ExecResponse {
  code: number;
  error?: ErrorDescriptor;
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

export interface HealthResponse {
  ok: boolean;
  version: string;
  platform: Platform;
  /** Resolved serial/udid, or null when the server is running with NO device bound
   *  — only reachable with --allow-device-control. Older servers always send a string. */
  serial: string | null;
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
