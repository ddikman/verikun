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

/**
 * Run a command to completion WITHOUT blocking the event loop, capturing stdout and
 * streaming stderr line-by-line as it arrives.
 *
 * The second deliberate exception to "everything is one blocking spawnSync", after
 * `spawnDetached`. It exists for the parallel `vk suite` scheduler, which runs each
 * test as a child `vk ai`: `spawnSync` blocks the whole thread, so a parent that used
 * it could not have two tests in flight — the very thing parallelism is for. It is
 * SCHEDULER code and must never become a `Driver` method; the Driver interface is
 * synchronous on purpose (see `sleepSync` above for what that buys).
 *
 * `onStderrLine` is what keeps N concurrent tests legible: the caller prefixes each
 * line with its lane instead of receiving one interleaved blob at the end. Lines are
 * reassembled across chunk boundaries, and a trailing partial line is flushed on exit
 * so a child that dies mid-line still reports what it managed to say.
 *
 * Unlike `runText` this never throws for a failed spawn: ENOENT arrives as an 'error'
 * event and is reported as exit 127 with the reason on stderr, because a scheduler
 * wants a failed lane, not an exception unwinding the whole suite.
 */
/** How much of a child's stderr `spawnCollect` keeps. Only the tail is ever read. */
const STDERR_TAIL_BYTES = 64 * 1024;

export function spawnCollect(
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    onStderrLine?: (line: string) => void;
    /** Kill the child after this long. OMITTED BY DEFAULT, unlike `runText`: a lane's
     *  `vk ai` legitimately runs for many minutes and a wrong ceiling would fail a
     *  passing test. Set it for bounded work — a probe, a version check. */
    timeout?: number;
    /** Keep only the last N bytes of stdout, for a caller that reads a small trailing
     *  document out of an output whose SUCCESS case is large (`vk ui --json` buffers a
     *  whole hierarchy that a liveness probe then discards). */
    stdoutTailBytes?: number;
  } = {},
): Promise<TextResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const emit = (line: string): void => {
      stderr += line + '\n';
      // Bounded by construction. Every line is already forwarded LIVE through
      // `onStderrLine`; the retained copy exists only so a caller can read the last line
      // of a failure, and a lane's `vk ai` streams progress for ten minutes or more.
      if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.slice(-STDERR_TAIL_BYTES);
      opts.onStderrLine?.(line);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
      const cap = opts.stdoutTailBytes;
      if (cap !== undefined && stdout.length > cap) stdout = stdout.slice(-cap);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      pending += c;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) emit(line);
    });
    let failure: string | undefined;
    child.on('error', (e) => {
      failure = describeError(cmd, args, e as NodeJS.ErrnoException).message;
    });
    child.on('close', (code, signal) => {
      if (pending) {
        emit(pending);
        pending = '';
      }
      if (failure) {
        stderr += failure + '\n';
        resolve({ code: 127, stdout, stderr });
        return;
      }
      // A signalled child has a null exit code; report it as a non-zero outcome so a
      // killed lane reads as failed rather than as a silent pass.
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
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
