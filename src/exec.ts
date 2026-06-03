import { spawnSync } from 'node:child_process';
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

/** Run a command and capture stdout/stderr as UTF-8 text. */
export function runText(
  cmd: string,
  args: string[],
  opts: { input?: string; timeout?: number } = {},
): TextResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 30000,
    input: opts.input,
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) throw describeError(cmd, args, r.error as NodeJS.ErrnoException);
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
