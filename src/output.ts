import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Output discipline: primary results -> stdout, diagnostics/errors -> stderr.
// Everything that prints data also supports --json for structured consumption.

// `vk ai` runs many leaf commands in one process; their per-step `out()`
// confirmations ("tapped …") would pollute stdout (which must stay the one
// parseable result). The engine sets quiet for the duration of the run so that
// per-step `out()` is suppressed while `err()` (stderr progress) still streams.
let quiet = false;

/** Suppress/restore `out()` (not `err()`/`json()`). Returns the previous value. */
export function setOutputQuiet(q: boolean): boolean {
  const prev = quiet;
  quiet = q;
  return prev;
}

export function out(s: string): void {
  if (quiet) return;
  process.stdout.write(s + '\n');
}

/**
 * A second destination for `err()`, or null.
 *
 * Diagnostics are written in ~90 places across `server.ts`, the pool and the drivers, and
 * every one of them already goes through `err()`. Teeing HERE is what lets `vk server`
 * capture all of them — including the worker threads, whose prefixed stderr is forwarded
 * into this process (see `server-worker.ts`) — without editing a single call site, and
 * without a second "log this too" primitive that new code could forget to use.
 *
 * Deliberately NOT applied to `out()`: stdout is the data channel, and a server silences
 * it entirely (`setOutputQuiet`). A sink on stdout would tee a `--json` payload into a log
 * file, which is a different thing wearing the same name.
 */
let errSink: ((line: string) => void) | null = null;

/** Tee `err()` into `fn` as well as stderr. Pass null to stop. */
export function setErrSink(fn: ((line: string) => void) | null): void {
  errSink = fn;
}

export function err(s: string): void {
  process.stderr.write(s + '\n');
  // A log sink must never be able to turn a DIAGNOSTIC into a crash: this runs on the
  // error path of every subsystem, often while something has already gone wrong. A full
  // disk or a revoked descriptor drops the line and leaves stderr — which is exactly the
  // pre-sink behaviour — rather than unwinding through a caller's catch block.
  if (errSink) {
    try {
      errSink(s);
    } catch {
      /* the log is best-effort; stderr above already carried it */
    }
  }
}

export function json(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Local run artifacts live in ./.verikun (gitignored). */
export function artifactDir(): string {
  const dir = resolve(process.cwd(), '.verikun');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * This process's lane, or '' when it is not part of a parallel suite.
 *
 * Sanitised rather than validated: the value is spliced into a directory name and
 * into run ids, so anything outside `[A-Za-z0-9._-]` is dropped instead of being
 * allowed to steer a path. A value that sanitises away entirely reads as "no lane",
 * which is the safe direction — worst case two lanes share a directory exactly as
 * they did before lanes existed. Exported for tests.
 */
export function laneId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VERIKUN_LANE ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
}

/**
 * A stable-per-session id, if the environment provides one — the identity run rollover
 * and device claims share. Opt-in by design: in an agent harness each command may be a
 * fresh shell, so it is never derived from the process tree (that would roll over on
 * every action).
 */
export function currentSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.VERIKUN_SESSION || env.TERM_SESSION_ID || undefined;
}

/**
 * The default `vk screenshot` destination, per lane.
 *
 * Lane-scoped for the same reason the active run directory is: `vk ai`'s grammar tells
 * the model to insert screenshot steps liberally, so N concurrent lanes would otherwise
 * `writeFileSync` one `./.verikun/screen.png` at once — last writer wins, and a reader
 * can see it torn. The report is unaffected (the buffer is attached to the lane's own
 * run), which is exactly why this would have gone unnoticed.
 */
export function defaultScreenshotPath(): string {
  const lane = laneId();
  return join(artifactDir(), lane ? `screen-${lane}.png` : 'screen.png');
}
