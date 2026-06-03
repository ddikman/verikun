import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Output discipline: primary results -> stdout, diagnostics/errors -> stderr.
// Everything that prints data also supports --json for structured consumption.

export function out(s: string): void {
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
