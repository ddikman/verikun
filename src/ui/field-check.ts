// Did `vk text` put the value in the field? The judgement half of the read-back (issue
// #151): given the hierarchy before and after typing, which element is the field and does it
// hold the value. Pure and time-free, like the rest of ui/; the reads, the retry and the
// failure live in commands/text-entry.ts.
//
// Every "cannot tell" here is UNVERIFIED, never a miss. A step that exits 1 because the
// check misread the screen is a new way to fail; one that passes unverified is only today's
// behaviour. The two outcomes are kept apart on purpose.

import type { Bounds, Element, Platform } from '../types';
import { INPUT_CLASS } from './barrier';

/**
 * Does the platform's hierarchy carry a text field's CONTENTS?
 *
 * Android: yes — uiautomator's `text` is the field's value, for native, Flutter and Compose
 * fields alike. iOS: no — ios-parse.ts builds `text` as `AXLabel || title || AXValue`, so a
 * labelled field reports its label and what was typed never reaches `Element`.
 */
export const FIELD_VALUE_READABLE: Record<Platform, boolean> = { android: true, ios: false };

/** Is this a text input, by class? The same test `isInteresting` keeps empty fields by. */
export function isInputField(el: Element): boolean {
  return INPUT_CLASS.test(el.class);
}

/**
 * Case, whitespace and punctuation stripped, letters and digits of EVERY script kept. Not the
 * selector's `strip`, which keeps only ASCII and would make any two CJK values compare equal.
 * NFKC folds full-width and compatibility forms, which some keyboards emit.
 */
export function normalizeTyped(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Both sides in comparable form: normalized, or raw when the value is all emoji/punctuation
 *  (normalizing would turn it into '' — equal to an empty field, and contained in anything). */
function comparable(field: string, value: string): [string, string] {
  const v = normalizeTyped(value);
  return v ? [normalizeTyped(field), v] : [field, value];
}

export interface LandedInput {
  /** What the field held before typing. */
  before: string;
  /** What it holds now. */
  after: string;
  value: string;
  /** `--clear`: the field was emptied first. */
  clear: boolean;
}

/**
 * Did the value land? When the whole result is known — the field was empty, or `--clear`
 * emptied it — the field must EQUAL the value, which also catches a doubled or dropped
 * character (#46). Typing into a field that already held text lands wherever the cursor was,
 * so there the field must have CHANGED and CONTAIN the value; "unchanged" is what an empty
 * native field showing its hint looks like, so it can never pass for a value it happens to
 * contain.
 */
export function valueLanded({ before, after, value, clear }: LandedInput): boolean {
  if (value === '') return true;
  const [a, v] = comparable(after, value);
  if (clear || before === '') return a === v;
  return after !== before && a.includes(v);
}

/** A field showing only mask characters: an obscured value we cannot read back. */
export function isMaskedValue(s: string): boolean {
  return /^[•●*·∙]+$/u.test(s);
}

const inside = (inner: Bounds, outer: Bounds): boolean =>
  inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
const overlaps = (a: Bounds, b: Bounds): boolean => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const area = (b: Bounds): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

/**
 * What the field held before typing. A selector may resolve to a WRAPPER (a
 * TextInputLayout, a labelled container) whose own `text` is empty while the input inside it
 * holds the value — so read the one input inside it, and fall back to the target's text.
 */
export function beforeText(pre: Element[], target: Element): string {
  if (isInputField(target)) return target.text;
  const inner = pre.filter((e) => e.index !== target.index && isInputField(e) && inside(e.bounds, target.bounds));
  return inner.length === 1 ? inner[0].text : target.text;
}

/**
 * Is `post` still the screen `pre` was? At least half of pre's anchors — ids, descs, and the
 * text of anything that is not an input (inputs are what typing changes) — must survive.
 * An anchorless screen cannot be told apart from another one, so it answers no.
 */
export function sameScreen(pre: Element[], post: Element[]): boolean {
  const anchors = (els: Element[]): Set<string> => {
    const out = new Set<string>();
    for (const e of els) {
      if (e.id) out.add(`id:${e.id}`);
      if (e.desc) out.add(`desc:${e.desc}`);
      if (e.text && !isInputField(e)) out.add(`text:${e.text}`);
    }
    return out;
  };
  const was = anchors(pre);
  if (was.size === 0) return false;
  const now = anchors(post);
  let kept = 0;
  for (const a of was) if (now.has(a)) kept++;
  return kept / was.size >= 0.5;
}

/**
 * Which element in the post-typing read is the field that was typed into — or null when
 * that cannot be told, which the caller treats as UNVERIFIED.
 *
 * The keys went to the FOCUSED element, so start there, and accept it only on the same screen
 * and tied to the target: by id (the field may have moved when the keyboard opened), as the
 * input inside a wrapper target, or — for an id-less target — by place and class. Focus
 * anywhere else means the app moved it on purpose (OTP boxes auto-advancing), and a field
 * there is not ours to judge.
 *
 * The same ties are what make a RETRY safe: retyping presses keys into whatever has focus, so
 * it may only happen where that is known to be the field. One case stays indistinguishable: a
 * field that submits itself onto a near-identical screen whose field reuses its id.
 */
export function attributeField(post: Element[], target: Element, pre: Element[]): Element | null {
  // Typing that navigated (a field that submits itself) leaves another screen, and a focused
  // field there is not the one typed into — even with the same id or in the same place.
  if (!sameScreen(pre, post)) return null;
  const tied = (f: Element): boolean =>
    target.id !== ''
      ? // An id is the identity; a different id in the same place is another field — unless the
        // target is a wrapper, whose input sits inside it under an id of its own.
        f.id === target.id || (!isInputField(target) && inside(f.bounds, target.bounds))
      : inside(f.bounds, target.bounds) || (f.class === target.class && overlaps(f.bounds, target.bounds));

  const candidates = post.filter((f) => f.focused && tied(f));
  if (candidates.length) {
    // An input over the container it sits in; of several inputs, the innermost.
    return [...candidates].sort(
      (a, b) => Number(isInputField(b)) - Number(isInputField(a)) || area(a.bounds) - area(b.bounds),
    )[0];
  }
  // Nothing reports focus at all — then the target's own id is the only safe identity.
  if (!post.some((f) => f.focused) && target.id) {
    const byId = post.filter((f) => f.id === target.id && isInputField(f));
    if (byId.length === 1) return byId[0];
  }
  return null;
}

export type ReadBackVerdict =
  | { verdict: 'landed' }
  | { verdict: 'missing'; field: Element; after: string }
  | { verdict: 'unverified'; why: string; password?: boolean };

/** One post-typing read, judged: which field, and whether it holds the value. */
export function judgeReadBack(
  post: Element[],
  entry: { target: Element; elements: Element[]; before: string; value: string; clear: boolean },
): ReadBackVerdict {
  const field = attributeField(post, entry.target, entry.elements);
  if (!field) return { verdict: 'unverified', why: 'focus is no longer on the field' };
  if (field.password) return { verdict: 'unverified', why: 'it is a password field', password: true };
  const after = field.text;
  if (isMaskedValue(after)) return { verdict: 'unverified', why: 'the field shows only mask characters' };
  if (valueLanded({ before: entry.before, after, value: entry.value, clear: entry.clear })) return { verdict: 'landed' };
  return { verdict: 'missing', field, after };
}

export type RetryPlan = 'redo' | 'clear-retype' | 'none';

/**
 * How to retype after a miss. Unchanged → nothing landed, so the field is exactly where the
 * first attempt started: do it again. Otherwise the field holds some mix of old and new text;
 * that can only be rewritten when all of it is ours (it started empty, or `--clear`), because
 * text the user already had cannot be put back.
 */
export function retryPlan({ before, after, clear }: { before: string; after: string; clear: boolean }): RetryPlan {
  if (after === before) return 'redo';
  if (clear || before === '') return 'clear-retype';
  return 'none';
}

/**
 * How many characters to delete before typing. The first attempt and a `redo` delete what
 * `--clear` always did; `clear-retype` deletes whatever is there now, sized generously
 * because a read can lag behind the keys. The `+ 2` is the original `--clear` margin.
 */
export function deletesFor(
  attempt: 'first' | RetryPlan,
  t: { before: string; after: string; value: string; clear: boolean },
): number {
  if (attempt === 'clear-retype') return Math.max(t.after.length, t.before.length + t.value.length) + 2;
  return t.clear && t.before ? t.before.length + 2 : 0;
}

/**
 * The failure. Line 1 carries no value and no field contents: it is what `vk ai` prints as
 * `[ai] FAIL at …` and what a suite prints in its summary, and a value that came from a
 * `{{env.X}}` template must not reach a CI log that way. The field's contents go on line 2,
 * which only a direct `vk text` prints.
 */
export function notLandedMessage(selector: string, after: string, value: string, retried: boolean): string {
  const lines = [
    retried
      ? `Typed into '${selector}' but the value did not land: the field does not hold it, even after retyping once.`
      : `Typed into '${selector}' but the value did not land, and the field already held other text, so it was not retyped.`,
    `  The field reads ${JSON.stringify(after.length > 80 ? `${after.slice(0, 80)}…` : after)}.`,
  ];
  if (/[^\x00-\x7F]/.test(value)) {
    lines.push("  The value has non-ASCII characters, and Android's `input text` can only type ASCII.");
  }
  lines.push('  A field that reformats or rejects input on purpose: use `verikun tap` + `verikun type`, which do not check.');
  return lines.join('\n');
}
