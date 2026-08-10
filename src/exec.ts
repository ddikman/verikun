import { spawnSync, spawn } from 'node:child_process';
import { accessSync, statSync, constants, closeSync, openSync } from 'node:fs';
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

/**
 * Block the calling thread for `ms`. Needed because the Driver interface is entirely
 * synchronous (every device call is a spawnSync), so a readback poll cannot await a
 * timer. Uses Atomics.wait on a throwaway SharedArrayBuffer — a Node builtin, keeping
 * with the zero-runtime-dependency rule, and cheaper than spawning `sleep`.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

/**
 * Start a long-running process that must OUTLIVE this CLI process — today only the
 * Android emulator. Everything else in verikun is one blocking `spawnSync` per
 * command; this is the single exception, and it stays here so `node:child_process`
 * has exactly one importer.
 *
 * Two things are load-bearing:
 *
 *  - **stdio is NEVER 'inherit' or 'pipe'.** An inherited stdout means the emulator
 *    holds the write end of the CLI's stdout pipe open forever after `vk` exits, so
 *    an agent (or a shell) capturing `vk`'s output never sees EOF and hangs. Output
 *    goes to `logFile` or /dev/null, nowhere else.
 *  - **`spawn` reports ENOENT asynchronously**, on the 'error' event, unlike
 *    `spawnSync`'s `r.error`. An 'error' event with no listener is an uncaught
 *    exception, so `onError` is always wired; callers surface it via their progress
 *    channel, and the boot timeout catches whatever slips past.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { logFile?: string; cwd?: string; env?: NodeJS.ProcessEnv; onError?: (e: Error) => void } = {},
): { pid: number; logFile?: string } {
  let fd: number | undefined;
  if (opts.logFile) {
    try {
      fd = openSync(opts.logFile, 'a');
    } catch {
      /* an unwritable log path must not block the boot — fall back to discarding */
    }
  }
  try {
    const child = spawn(cmd, args, {
      detached: true, // own process group: survives our exit and a Ctrl-C on our terminal
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
    });
    child.on('error', (e) => opts.onError?.(e as Error));
    child.unref();
    if (child.pid === undefined) throw new CliError(`Could not start '${cmd}'`, 3);
    return { pid: child.pid, logFile: fd !== undefined ? opts.logFile : undefined };
  } finally {
    // The child holds its own duplicate of the descriptor; ours would otherwise leak.
    if (fd !== undefined) closeSync(fd);
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
