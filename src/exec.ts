import { spawnSync } from 'node:child_process';
import { accessSync, statSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { CliError } from './errors';

// All external processes are run without a shell (args array) to avoid host-side
// shell injection. Device-side shell escaping (for `adb shell ...`) is handled
// explicitly by the driver where needed.

export interface TextResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 64 * 1024 * 1024; // screenshots can be a few MB

function describeError(cmd: string, args: string[], err: NodeJS.ErrnoException): CliError {
  if (err.code === 'ENOENT') {
    return new CliError(`'${cmd}' was not found on PATH. Is it installed and on your PATH?`, 3);
  }
  if (err.code === 'ETIMEDOUT') {
    return new CliError(`'${cmd} ${args.join(' ')}' timed out`, 3);
  }
  return new CliError(`Failed to run '${cmd}': ${err.message}`, 3);
}

/** Run a command and capture stdout/stderr as UTF-8 text. `cwd` runs it rooted elsewhere
 *  (the CLI-agent providers run in a neutral temp dir so they never touch the working tree). */
export function runText(
  cmd: string,
  args: string[],
  opts: { input?: string; timeout?: number; cwd?: string } = {},
): TextResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 30000,
    input: opts.input,
    cwd: opts.cwd,
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) throw describeError(cmd, args, r.error as NodeJS.ErrnoException);
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Is `bin` an executable on PATH (or a direct path to one)? Used to decide a CLI provider is
 *  available without invoking the agent — a cheap, pure PATH scan (no spawn, no runtime dep). */
export function commandExists(bin: string): boolean {
  if (bin.includes('/') || bin.includes('\\')) return isExecutableFile(bin);
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isExecutableFile(join(dir, bin + ext))) return true;
  }
  return false;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform === 'win32') return true; // Windows has no X bit; a matching file is enough
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run a command and capture stdout as raw bytes (e.g. PNG screenshots). */
export function runBinary(
  cmd: string,
  args: string[],
  opts: { timeout?: number } = {},
): { code: number; stdout: Buffer; stderr: string } {
  const r = spawnSync(cmd, args, {
    timeout: opts.timeout ?? 30000,
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) throw describeError(cmd, args, r.error as NodeJS.ErrnoException);
  return {
    code: r.status ?? 0,
    stdout: (r.stdout as Buffer) ?? Buffer.alloc(0),
    stderr: (r.stderr as Buffer | null)?.toString('utf8') ?? '',
  };
}
