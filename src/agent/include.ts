// Shared prose between `vk ai` tests: `@include <path>` on its own line splices another
// file's steps into this one at COMPILE time.
//
// The problem it solves (issue #112): every natural-language test has to be self-contained,
// so the same "cold start → authenticate → drive past whatever post-auth screens appear →
// land on a known screen" preamble is copy-pasted into every test in a suite. It drifts, it
// is maintained N times, and it is compiled N times. `vk batch --file` cannot factor it out
// because the preamble is conditional ("dismiss whichever of these six screens is present"),
// which is exactly the part only `vk ai` can express.
//
// Two properties make the mechanism honest:
//
//  - **The resolved text is the cache key.** Callers hash `nl` (fragments already inlined),
//    so editing a fragment invalidates every test that includes it. Keying on the top-level
//    file would silently replay stale plans for all of them.
//  - **A fragment is not a test.** `vk suite` skips `_`-prefixed files and never recurses
//    into subdirectories, so a fragment gets no report row and no `--app` data reset.
//
// `segments` is what makes the compile CHEAP as well as short: each contiguous chunk of
// prose is compiled on its own and cached under its own key, so a preamble shared by nine
// tests is compiled ONCE (see compileFromSegments in cli.ts). Splicing happens at the plan
// level, which the shallow IR allows — a plan is a flat list of steps.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from '../errors';

/** An include directive: `@include <path>` alone on a line (leading space allowed).
 *  Deliberately a whole-line form — a path is everything after the keyword, so it needs
 *  no quoting and can contain spaces. */
const INCLUDE_RE = /^\s*@include\s+(\S.*?)\s*$/;

/** A fenced code block delimiter. A test that *documents* `@include` in a code fence
 *  is showing the syntax, not using it. */
const FENCE_RE = /^\s*(```|~~~)/;

/** Lines that can never carry an instruction: blank, a markdown heading, or a horizontal
 *  rule. A chunk made only of these (`# Login smoke test` between two includes) is not
 *  sent to the model at all — it would compile to zero steps and cost a call to say so.
 *  Kept deliberately TIGHT: skipping prose that did carry a step would lose it silently,
 *  which is the false-green class this codebase refuses everywhere else. Anything with a
 *  sentence in it — including a blockquote — is compiled. */
const DECORATION_RE = /^\s*(#{1,6}\s|#{1,6}$|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;

/** One compile unit: a contiguous run of prose from a single file. */
export interface Segment {
  /** The prose, verbatim, newline-terminated. */
  text: string;
  /** Absolute path of the file it came from. */
  source: string;
  /** 1-based line in `source` where `text` starts — so a failure can point at the
   *  fragment and its line rather than at an offset into expanded text. */
  startLine: number;
  /** False when the chunk is only headings/rules — no instruction to compile. */
  compilable: boolean;
}

export interface ResolvedTest {
  /** Every fragment inlined, in file order: the test text, and the cache identity. */
  nl: string;
  /** The same text split into compile units. One entry when the test has no includes. */
  segments: Segment[];
}

/** Does this chunk contain anything the model could compile into a step? */
export function hasInstruction(text: string): boolean {
  const bare = text.replace(/<!--[\s\S]*?-->/g, '');
  return bare.split('\n').some((line) => line.trim() !== '' && !DECORATION_RE.test(line));
}

const endWithNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/** Read a file's text. Injected so the resolver is unit-testable without touching disk. */
export type ReadFile = (path: string) => string;

const readFile: ReadFile = (path) => readFileSync(path, 'utf8');

/**
 * Resolve `file` and every `@include` it reaches, depth-first, into one text plus the
 * segments it was assembled from.
 *
 * Paths are relative to the INCLUDING file (not the cwd), so a fragment can be moved
 * with the tests that use it. A cycle is exit 2 naming the chain — an include loop would
 * otherwise expand until it ran out of memory.
 */
export function resolveIncludes(file: string, read: ReadFile = readFile): ResolvedTest {
  const segments: Segment[] = [];
  const nl = expand(resolve(process.cwd(), file), [], segments, read, null);
  return { nl, segments };
}

function expand(path: string, stack: string[], out: Segment[], read: ReadFile, from: string | null): string {
  if (stack.includes(path)) {
    throw new CliError(`ai: include cycle — ${[...stack, path].map((p) => shortName(p)).join(' → ')}`, 2);
  }
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const where = from ? ` (included from ${from})` : '';
    throw new CliError(`ai: cannot read '${path}'${where} (${(e as Error).message})`, 2);
  }

  const parts: string[] = [];
  const lines = text.split('\n');
  // A file ending in a newline splits to a trailing '' — drop it, or an include on the
  // last line leaves a stray blank chunk behind it. Each flush re-terminates its own text.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  let buf: string[] = [];
  let bufStart = 1;
  let fenced = false;

  const flush = (): void => {
    if (buf.length === 0) return;
    const chunk = endWithNewline(buf.join('\n'));
    parts.push(chunk);
    // The label points at the chunk's first real line, not at the blank line that
    // separated it from the include above it.
    const lead = buf.findIndex((l) => l.trim() !== '');
    if (lead >= 0) out.push({ text: chunk, source: path, startLine: bufStart + lead, compilable: hasInstruction(chunk) });
    buf = [];
  };

  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) fenced = !fenced;
    const m = fenced ? null : INCLUDE_RE.exec(line);
    if (!m) {
      if (buf.length === 0) bufStart = i + 1;
      buf.push(line);
      return;
    }
    flush();
    parts.push(endWithNewline(expand(resolve(dirname(path), m[1]), [...stack, path], out, read, `${shortName(path)}:${i + 1}`)));
  });
  flush();

  return parts.join('');
}

/** A path as a human reads it: relative to the cwd when it is below it. */
function shortName(path: string): string {
  const cwd = `${process.cwd()}/`;
  return path.startsWith(cwd) ? path.slice(cwd.length) : path;
}

/** Where a segment came from, `file:line` — so progress and errors name the FRAGMENT and
 *  its own line rather than an offset into text the user never wrote. */
export function segmentLabel(seg: Segment): string {
  return `${shortName(seg.source)}:${seg.startLine}`;
}
