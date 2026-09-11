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
// Three properties make the mechanism honest:
//
//  - **The resolved text is the cache key.** Callers hash `nl` (fragments already inlined),
//    so editing a fragment invalidates every test that includes it. Keying on the top-level
//    file would silently replay stale plans for all of them.
//  - **A fragment is not a test.** `vk suite` skips `_`-prefixed files and never recurses
//    into subdirectories, so a fragment gets no report row and no `--app` data reset.
//  - **A chunk is a whole prompt, so a chunk that is not a test must not become one.** Prose
//    that only describes the test is folded into the chunk of its own file that states the
//    steps it describes, never compiled alone (groupDescriptions, issue #133).
//
// `segments` is what makes the compile CHEAP as well as short: each chunk of prose is
// compiled on its own and cached under its own key, so a preamble shared by nine tests is
// compiled ONCE (see compileFromSegments in cli.ts). Splicing happens at the plan level,
// which the shallow IR allows — a plan is a flat list of steps.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from '../errors';
import { IMPERATIVES } from './lint';

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

/** One compile unit: prose from a single file. */
export interface Segment {
  /** The prose, verbatim, newline-terminated. Usually one contiguous run, but not always: a
   *  chunk that only DESCRIBES the test is folded into the neighbouring chunk of its own file
   *  (`groupDescriptions`), so this may skip over what an `@include` between them pulled in. */
  text: string;
  /** Absolute path of the file it came from. */
  source: string;
  /** 1-based line in `source` where `text` starts — so a failure can point at the
   *  fragment and its line rather than at an offset into expanded text. A POINTER, never a
   *  range: a folded chunk begins here but skips the include that sat between its parts. */
  startLine: number;
  /** False when the chunk is only headings/rules — no instruction to compile. */
  compilable: boolean;
}

/** A chunk plus which `expand()` call produced it. Internal: `groupDescriptions` strips it.
 *
 *  Two `@include`s of the same fragment are two expansions, so a description inside that
 *  fragment folds into ITS OWN copy's steps and both copies come out byte-identical — one
 *  cache key for both, which is the property `@include` exists for. Matching on `source`
 *  alone would let one copy's trailing description reach across into the next copy. */
interface RawSegment extends Segment {
  unit: number;
}

/** What `expand` threads through its recursion: where chunks land, how a file is read, and
 *  the next expansion id. */
interface Expansion {
  out: RawSegment[];
  read: ReadFile;
  units: number;
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

/** A list item of ANY kind — ordered or bulleted. `lint.ts` counts only ORDERED items, because
 *  there an unordered bullet carrying explanation would inflate the expected plan size and
 *  manufacture a rejection. Here the polarity is reversed: a bulleted preamble
 *  ("- Launch the app with its data cleared.") is a list of steps, and missing it is what would
 *  do damage. */
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*+])\s+/;

/**
 * Does this chunk STATE a step, or only DESCRIBE the test?
 *
 * Deliberately NOT `lint.ts`'s `instructionUnits(text) > 0`, even though that counter answers a
 * neighbouring question. It is documented as biased to UNDERCOUNT, which is safe where it is
 * used ("an undercount only weakens detection, while an overcount would reject a correct plan")
 * and exactly backwards here, where an undercount means calling a real step a description.
 * Measured, all scoring zero units: a bulleted preamble, "First, launch the app.", and this
 * repo's own `_launch-to-home.md` reworded to open with its subject instead of its verb.
 *
 * So this asks for POSITIVE EVIDENCE and errs the other way — a list item of any kind, or one
 * of the same verbs `lint.ts` knows appearing ANYWHERE in a line rather than only at its start.
 * Every misreading it can still make is the safe one: a description that happens to contain
 * "check" or "wait" reads as a step and is compiled alone, which is what happened before this
 * existed. Nothing regresses; some things stop being fabricated.
 *
 * Exported solely so the unit suite can reach it.
 */
export function statesInstruction(text: string): boolean {
  let fenced = false;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (LIST_ITEM_RE.test(line)) return true;
    for (const word of line.toLowerCase().match(/[a-z]+/g) ?? []) if (IMPERATIVES.has(word)) return true;
  }
  return false;
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
  const ex: Expansion = { out: [], read, units: 0 };
  // `nl` is assembled from `parts`, independently of `ex.out`, so regrouping the chunks below
  // cannot change the resolved text — and therefore cannot change the whole-test cache key, nor
  // what the assembled-plan lint is asked about.
  const nl = expand(resolve(process.cwd(), file), [], ex, null);
  return { nl, segments: groupDescriptions(ex.out) };
}

function expand(path: string, stack: string[], ex: Expansion, from: string | null): string {
  const unit = ex.units++;
  if (stack.includes(path)) {
    throw new CliError(`ai: include cycle — ${[...stack, path].map((p) => shortName(p)).join(' → ')}`, 2);
  }
  let text: string;
  try {
    text = ex.read(path);
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
    if (lead >= 0) {
      ex.out.push({ text: chunk, source: path, startLine: bufStart + lead, compilable: hasInstruction(chunk), unit });
    }
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
    parts.push(endWithNewline(expand(resolve(dirname(path), m[1]), [...stack, path], ex, `${shortName(path)}:${i + 1}`)));
  });
  flush();

  return parts.join('');
}

/**
 * The chunk a description folds into: the next chunk of its OWN expansion that states a step,
 * else the previous one. `-1` when that expansion states no step anywhere.
 *
 * Scanning by EXPANSION rather than by path is what keeps a fragment included twice identical in
 * both places. Scanning by FILE rather than simply "the next chunk" is the load-bearing half:
 * the next chunk is normally the fragment the `@include` pulled in, and folding a per-test
 * description into it would change the FRAGMENT's cache key per test, destroying the
 * compiled-once property `@include` exists for. Another expansion's chunks are skipped OVER, not
 * stopped at — reaching across the include to the file's own next chunk is the entire point.
 */
function hostFor(raw: RawSegment[], describes: boolean[], i: number): number {
  const usable = (j: number): boolean => raw[j].unit === raw[i].unit && raw[j].compilable && !describes[j];
  for (let j = i + 1; j < raw.length; j++) if (usable(j)) return j;
  for (let j = i - 1; j >= 0; j--) if (usable(j)) return j;
  return -1;
}

const plain = ({ text, source, startLine, compilable }: RawSegment): Segment => ({ text, source, startLine, compilable });

/**
 * Fold a chunk that only DESCRIBES the test into the chunk of the same file that states the
 * steps it describes (issue #133).
 *
 * A title and a summary paragraph written above the first `@include` used to become a chunk of
 * its own — and a chunk is a whole prompt. Compiled alone, the summary IS the test, so the model
 * invents a plan for it and those steps are spliced AHEAD of the launch the include was there to
 * perform; the reported case was 34 fabricated steps whose first act was to tap a login button on
 * the Android launcher. `SECTION_NOTE` has told the model since `@include` shipped that a summary
 * is not an instruction, and it still went the wrong way on 5 of 14 tests in one run: whether
 * prose reads as a spec is a model judgement, so the fix has to be deterministic.
 *
 * A STRICT IMPROVEMENT, deliberately: every chunk either folds into a neighbour or is left
 * exactly as it was. There is no third disposition, and in particular nothing is DROPPED — prose
 * this pass discarded would be prose the model never sees, and a fragment wrongly discarded is a
 * suite that silently stops launching its app. No coverage rule could catch that: the floor and
 * the tail anchors both measure `nl`, which this pass does not touch.
 */
function groupDescriptions(raw: RawSegment[]): Segment[] {
  const describes = raw.map((s) => s.compilable && !statesInstruction(s.text));
  const host = raw.map((_, i) => (describes[i] ? hostFor(raw, describes, i) : -1));
  // The overwhelmingly common case — no description, or one with nowhere to go — allocates
  // nothing and is byte-identical to the behaviour before this pass existed.
  if (host.every((h) => h < 0)) return raw.map(plain);

  const out: Segment[] = [];
  const slot = new Map<number, number>(); // index in `raw` -> index in `out`
  raw.forEach((s, i) => {
    if (host[i] >= 0) return; // folded into its host below
    slot.set(i, out.length);
    out.push(plain(s));
  });

  // Prepends run BACKWARDS and appends run FORWARDS. Not a style choice: each fold lands at the
  // host's edge, so whichever is written LAST ends up nearest the host. A file with two
  // descriptions separated by two includes has to come out in the order its author wrote them,
  // and a single pass in either direction reverses one of those two chains.
  for (let i = raw.length - 1; i >= 0; i--) {
    if (host[i] <= i) continue;
    const at = slot.get(host[i]) as number;
    // The earlier line, so `segmentLabel` names where the folded text now begins. That label is
    // the accounting for the fold: a chunk that printed as `t.md:8` prints as `t.md:1`, and the
    // "assembled from N chunk(s)" line drops by one. No prose moves unannounced.
    out[at] = { ...out[at], text: raw[i].text + out[at].text, startLine: Math.min(out[at].startLine, raw[i].startLine) };
  }
  for (let i = 0; i < raw.length; i++) {
    if (host[i] < 0 || host[i] > i) continue;
    const at = slot.get(host[i]) as number;
    out[at] = { ...out[at], text: out[at].text + raw[i].text };
  }
  return out;
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
