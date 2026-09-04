// The `vk batch` line grammar: how one line of a batch becomes argv, and which globals
// on the `batch` call every line inherits. Pure string scanning, like args.ts — no host
// shell is ever involved. The runner itself (`cmdBatch`) stays with the dispatcher, whose
// executor it needs.

import { Flags } from '../args';
import { CliError } from '../errors';

const BATCH_GLOBALS = ['device', 'platform', 'ios', 'android', 'json'] as const;

/**
 * Split a batch line into argv tokens with shell-like single/double quoting and
 * backslash escapes — but WITHOUT a shell: this is pure string scanning, so a line
 * can never spawn a host process or expand a variable (the same no-host-shell rule
 * the rest of the CLI follows). Throws on an unterminated quote.
 */
export function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false; // lets an empty "" / '' still produce a real empty token
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === '"' || c === "'") {
      started = true;
      i++;
      while (i < line.length && line[i] !== c) {
        if (c === '"' && line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
          cur += line[i + 1];
          i += 2;
        } else {
          cur += line[i++];
        }
      }
      if (i >= line.length) {
        throw new CliError(`batch: unterminated ${c === '"' ? 'double' : 'single'} quote in: ${line}`, 2);
      }
      i++; // consume the closing quote
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      started = true;
      i += 2;
    } else if (c === ' ' || c === '\t') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      i++;
    } else {
      cur += c;
      started = true;
      i++;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** Globals on the `batch` call become defaults for each line (the line may override). */
export function withBatchGlobals(lineFlags: Flags, batchFlags: Flags): Flags {
  const merged: Flags = { ...lineFlags };
  for (const k of BATCH_GLOBALS) {
    if (merged[k] === undefined && batchFlags[k] !== undefined) merged[k] = batchFlags[k];
  }
  return merged;
}
