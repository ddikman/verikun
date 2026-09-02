// The `vk server` log file.
//
// A server is a long-lived process an operator starts once and reads about later, but every
// diagnostic it produces went to stderr and nowhere else — so closing the terminal destroyed
// the entire operational history, and nothing in the docs ever said to capture it. This
// module is the file half; `setErrSink` in output.ts is the tee that fills it.
//
// It is deliberately tiny and synchronous. `err()` is synchronous and the whole CLI is
// spawnSync-shaped, so an async writer would only buy a queue that a crash discards — and a
// crash is precisely when the last line matters most.

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors';
import type { Flags } from './args';
import { flagStr } from './args';

/** The value that turns the log off, in the flag AND in the env var. */
export const LOG_OFF = 'off';

/**
 * Rotate at 10 MB, keeping ONE previous generation.
 *
 * Bounded rather than unbounded because a server that fills its own host's disk would cause
 * the exact failure this log exists to explain (`INSTALL_FAILED_INSUFFICIENT_STORAGE` is one
 * of the classifier's own rules), and a log that ends the run it is documenting is worse
 * than no log. One generation, not N: the useful window is "the run that just failed", and
 * an operator who needs more than 20 MB of history wants a real log shipper, not a bigger
 * number here.
 */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

export interface ServerLog {
  /** Where lines are being written. Named in the startup banner. */
  readonly path: string;
  write(line: string): void;
  close(): void;
}

/**
 * Where this server should log, or null when logging is off.
 *
 * PURE — no fs, no side effects — so the whole value domain is unit-testable without
 * touching a disk. Precedence is flag > env > default, the same order every other
 * server option resolves in.
 *
 * The default is HOST-GLOBAL (`~/.verikun/logs/`), not `./.verikun/`, matching the device
 * claim store rather than the run directory. Run state is per-CWD because it describes a
 * working directory; a server is a fact about the MACHINE, and an operator who started it
 * from a checkout should not have to remember which one. Port-scoped so two servers on one
 * host cannot interleave their lines into an unreadable braid.
 */
export function resolveLogPath(opts: {
  flags?: Flags;
  env?: NodeJS.ProcessEnv;
  port: number;
  home?: string;
}): string | null {
  const raw = opts.flags?.['log-file'];
  if (raw === true) {
    throw new CliError(`--log-file needs a path, or '${LOG_OFF}' to disable logging to a file.`, 2);
  }
  const flag = flagStr(opts.flags ?? {}, 'log-file');
  const env = (opts.env ?? process.env).VERIKUN_LOG_FILE;
  const chosen = flag ?? (env && env.trim() ? env.trim() : undefined);
  if (chosen !== undefined) return chosen.toLowerCase() === LOG_OFF ? null : chosen;
  return join(opts.home ?? homedir(), '.verikun', 'logs', `server-${opts.port}.log`);
}

/**
 * Open the log at `path`, rotating first if it is already at the cap.
 *
 * Returns null — never throws — when the path cannot be written. An unwritable log must not
 * stop a server from serving devices: that is the same judgement `spawnDetached` already
 * makes about the emulator's log ("an unwritable log path must not block the boot"), and the
 * caller falls back to the stderr it always had. The reason is reported to stderr so the
 * operator learns it from the banner rather than from an empty file an hour later.
 */
export function openServerLog(path: string): ServerLog | null {
  let fd: number;
  let bytes: number;
  try {
    mkdirSync(dirname(path), { recursive: true });
    bytes = rotateIfFull(path);
    fd = openSync(path, 'a');
  } catch {
    return null;
  }
  let closed = false;
  return {
    path,
    write(line: string): void {
      if (closed) return;
      // Timestamped in the FILE only. Stderr stays byte-identical to what it printed
      // before this module existed, so a terminal reads as it always did and no test that
      // matches on `[server] …` has to learn about a prefix.
      const buf = Buffer.from(`${new Date().toISOString()} ${line}\n`, 'utf8');
      try {
        writeSync(fd, buf);
        bytes += buf.length;
        if (bytes >= MAX_LOG_BYTES) {
          closeSync(fd);
          bytes = rotateIfFull(path, true);
          fd = openSync(path, 'a');
        }
      } catch {
        // Out of space, or the file was pulled from under us. Dropping the line is the
        // only sane answer — see the sink's own catch in output.ts.
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Move `path` aside when it has reached the cap. Returns the size logging resumes from. */
function rotateIfFull(path: string, force = false): number {
  try {
    const size = existsSync(path) ? statSync(path).size : 0;
    if (!force && size < MAX_LOG_BYTES) return size;
    if (size === 0 && !force) return 0;
    const prev = `${path}.1`;
    // renameSync overwrites on POSIX, but an existing .1 on a filesystem that refuses to
    // is the difference between rotating and silently growing forever.
    if (existsSync(prev)) unlinkSync(prev);
    renameSync(path, prev);
    return 0;
  } catch {
    // Could not rotate — keep appending rather than losing the log entirely. The cap is a
    // courtesy to the disk, not a correctness property.
    return 0;
  }
}
