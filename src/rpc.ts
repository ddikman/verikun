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
import type { Element, Platform } from './types';
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
}

export interface ElementsResponse {
  elements: Element[];
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  platform: Platform;
  serial: string;
  /** Whether POST /v1/install is enabled on this server (`--allow-install`). */
  installEnabled: boolean;
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
  /** Install an app build (`vk install`). */
  install(appPath: string): Promise<void> | void;
  /** Reset app state between suite tests (clear on Android; honest degrade to stop on iOS). */
  reset(appId: string): Promise<void> | void;
  /** Release held resources when the command finishes — the remote backend frees
   *  the server's device lock so the NEXT command (a fresh run token) isn't 409'd
   *  until the idle takeover. Best-effort; local backends need none. */
  close?(): Promise<void> | void;
}
