// `vk text`'s type-and-verify (issue #151): focus the field without re-tapping one that
// already has focus, type, then read the field back and retype once when the value did not
// land. Which element is the field and whether it holds the value is pure and lives in
// ui/field-check.ts; this module owns the device calls and the clock. Never imports cli.ts.

import { CliError } from '../errors';
import { err } from '../output';
import type { Element, Point } from '../types';
import {
  FIELD_VALUE_READABLE,
  ReadBackVerdict,
  beforeText,
  deletesFor,
  isInputField,
  judgeReadBack,
  notLandedMessage,
  retryPlan,
} from '../ui/field-check';
import { sleep } from '../wait';
import type { Ctx } from './context';

export interface TextEntry {
  /** The selector as given, for messages. */
  selector: string;
  target: Element;
  /** The snapshot `target` was resolved from. */
  elements: Element[];
  point: Point;
  value: string;
  /** `--clear`. */
  clear: boolean;
}

/** Every wait in one place, so a unit test can shrink them rather than sleep. */
export interface EntryTiming {
  /** After a tap, before typing, so focus has landed. */
  tapSettleMs: number;
  /** After `--clear`'s deletes, before typing. */
  clearSettleMs: number;
  /**
   * A read-back may only call a value lost after this many successful reads spread over at
   * least `verifyMinMs`: a read can trail the keys, and retyping a value that did land
   * doubles it. The window is also the margin a retry's re-tap needs (see `enterText`).
   */
  verifyMinReads: number;
  verifyMinMs: number;
  verifyPollMs: number;
  /** Stop reading, unverified, when that many reads cannot be had in this long. */
  verifyMaxMs: number;
  /** After a retry's re-tap, before reading again. */
  retapSettleMs: number;
}

export const ENTRY_TIMING: EntryTiming = {
  tapSettleMs: 100,
  clearSettleMs: 200,
  verifyMinReads: 2,
  verifyMinMs: 1500,
  verifyPollMs: 300,
  verifyMaxMs: 10_000,
  retapSettleMs: 300,
};

export interface EntryOutcome {
  /** The field was read back and held the value. */
  verified: boolean;
  /** It did not on the first attempt, and was retyped. */
  retried: boolean;
}

/**
 * Focus, type and — where the platform reports a field's contents — verify. Throws a plain
 * `CliError(…, 1)` when the value is still not in the field after one retry: terminal in
 * `vk ai` (only selector errors are repaired), and never exit 3, which a suite counts toward
 * retiring a healthy device. Anything that cannot be judged passes unverified, as before.
 */
export async function enterText(ctx: Ctx, entry: TextEntry, timing: EntryTiming = ENTRY_TIMING): Promise<EntryOutcome> {
  const readable = FIELD_VALUE_READABLE[ctx.platform];
  // Where contents are not reported (iOS) the target's text is its label, and `--clear` keeps
  // sizing its deletes from it exactly as it always has.
  const before = readable ? beforeText(entry.elements, entry.target) : entry.target.text;
  const text = { before, value: entry.value, clear: entry.clear };

  // Tapping a field that already has focus restarts its input session, and a keyboard still
  // starting up (SwiftKey) aborts that session and drops every key typed next (#151) — so a
  // plan that taps a field and then types into it must not tap it twice. iOS never reports
  // focus, so it always taps.
  if (!(entry.target.focused && isInputField(entry.target))) {
    ctx.driver.tap(entry.point.x, entry.point.y);
    await sleep(timing.tapSettleMs);
  }
  await typeValue(ctx, deletesFor('first', { ...text, after: before }), entry.value, timing);

  if (!readable || entry.target.password || entry.value === '') return { verified: false, retried: false };

  let check = await readBack(ctx, entry, before, timing);
  let retried = false;
  if (check.verdict === 'missing' && retryPlan({ ...text, after: check.after }) !== 'none') {
    // Tap again: that rebinds an input session the keyboard aborted, which typing alone does
    // not. The miss was only called after `verifyMinMs` of reads, which is also the margin
    // this tap needs — in #151 a second tap ~1.5s after the keyboard appeared typed fine.
    ctx.driver.tap(check.field.center.x, check.field.center.y);
    await sleep(timing.retapSettleMs);
    // A read that was only trailing may have caught up: judge again BEFORE retyping, or a
    // value that did land gets typed twice.
    const now = readOnce(ctx, entry, before) ?? check;
    if (now.verdict !== 'missing') return settle(ctx, entry, now, false);
    const plan = retryPlan({ ...text, after: now.after });
    if (plan !== 'none') {
      err(`note: the value typed into '${entry.selector}' did not land — retyping it once`);
      await typeValue(ctx, deletesFor(plan, { ...text, after: now.after }), entry.value, timing);
      retried = true;
      check = await readBack(ctx, entry, before, timing);
    } else {
      check = now;
    }
  }
  return settle(ctx, entry, check, retried);
}

/** Turn the final verdict into an outcome, or the failure. */
function settle(ctx: Ctx, entry: TextEntry, check: ReadBackVerdict, retried: boolean): EntryOutcome {
  if (check.verdict === 'missing') {
    const message = notLandedMessage(entry.selector, check.after, entry.value, retried);
    // `finishError` keeps a message already noted, and cmdText noted "typed …" up front.
    ctx.record?.note({ message: message.split('\n')[0] });
    throw new CliError(message, 1);
  }
  if (check.verdict === 'unverified') {
    // The selector named a wrapper, and the field inside it turned out to be a password: the
    // "typed …" noted up front has the value in it.
    if (check.password) ctx.record?.note({ message: 'typed «redacted»' });
    else err(`note: could not check the value typed into '${entry.selector}' — ${check.why}`);
  }
  return { verified: check.verdict === 'landed', retried };
}

/** Delete `deletes` characters, then type — the sequence `vk text` has always used. */
async function typeValue(ctx: Ctx, deletes: number, value: string, timing: EntryTiming): Promise<void> {
  if (deletes > 0) {
    ctx.driver.pressKey('move_end');
    for (let i = 0; i < deletes; i++) ctx.driver.pressKey('del');
    await sleep(timing.clearSettleMs);
  }
  // Prime the input method with a space, then delete it, to avoid losing first character
  // (workaround for adb input text behavior where first char is sometimes lost)
  ctx.driver.inputText(' ');
  ctx.driver.pressKey('backspace');
  ctx.driver.inputText(value);
}

/** One read, judged — or null when the read itself failed, which proves nothing either way. */
function readOnce(ctx: Ctx, entry: TextEntry, before: string): ReadBackVerdict | null {
  let post: Element[];
  try {
    post = ctx.driver.getElements();
  } catch {
    // Deliberately every failure, transient or not: the keys were sent, and a read problem
    // must not turn into a failed step — least of all exit 3.
    return null;
  }
  return judgeReadBack(post, { ...entry, before });
}

/**
 * Read until the value is seen, or a miss has held for `verifyMinReads` reads over
 * `verifyMinMs`. Only a miss is looked at again: a landed value is done, and a field that
 * cannot be judged (focus moved, a password) will not become judgeable by waiting.
 */
async function readBack(ctx: Ctx, entry: TextEntry, before: string, timing: EntryTiming): Promise<ReadBackVerdict> {
  const started = Date.now();
  let reads = 0;
  let last: ReadBackVerdict | null = null;
  for (;;) {
    const v = readOnce(ctx, entry, before);
    if (v) {
      if (v.verdict !== 'missing') return v;
      reads++;
      last = v;
    }
    const elapsed = Date.now() - started;
    if (last && reads >= timing.verifyMinReads && elapsed >= timing.verifyMinMs) return last;
    if (elapsed >= timing.verifyMaxMs) {
      return { verdict: 'unverified', why: last ? 'the field could not be read twice' : 'the screen could not be read' };
    }
    await sleep(timing.verifyPollMs);
  }
}
