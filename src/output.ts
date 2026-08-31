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

export function err(s: string): void {
  process.stderr.write(s + '\n');
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
