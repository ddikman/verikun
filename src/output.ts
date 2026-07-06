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

export function defaultScreenshotPath(): string {
  return join(artifactDir(), 'screen.png');
}
