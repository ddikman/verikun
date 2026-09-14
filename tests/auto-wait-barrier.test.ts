import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ReadTally, matchWaiting, resolveOneWaiting } from '../src/commands/auto-wait';
import type { Ctx } from '../src/commands/context';
import { DumpKilledError, NoWindowError, SelectorNotFoundError } from '../src/errors';
import { parseSelector } from '../src/ui/selector';
import type { Element } from '../src/types';
import { makeDriver, makeEl } from './helpers';

// The auto-wait loop is the layer that saw every read, so it is the one that can say a
// selector missed BECAUSE the tree held only a modal barrier — the "cheap half" of issue
// #131: "never appeared" sent the reporter looking for a missing identifier in app code.

const VP = { width: 1080, height: 2400 };
const content = () => makeEl({ id: 'android:id/content', idShort: 'content', bounds: { x1: 0, y1: 0, x2: 1080, y2: 2184 } });
const scrim = () => makeEl({ desc: 'Scrim', clickable: true, bounds: { x1: 0, y1: 0, x2: 1080, y2: 1620 } });
const confirm = () => makeEl({ id: 'vk_sheet_confirm', idShort: 'vk_sheet_confirm', desc: 'Confirm', clickable: true, bounds: { x1: 63, y1: 1791, x2: 1017, y2: 1917 } });

/** A ctx whose driver serves the given snapshots in order, repeating the last one. */
function ctxWith(snapshots: Element[][], flags: Ctx['flags'] = { wait: '40', interval: '5' }): Ctx {
  let i = 0;
  const driver = makeDriver({
    getElements: () => snapshots[Math.min(i++, snapshots.length - 1)],
    viewport: () => VP,
  });
  return { driver, platform: 'android', positionals: [], flags };
}

test('resolveOneWaiting: a miss on a barrier-only tree for the whole window names the barrier', async () => {
  const ctx = ctxWith([[content(), scrim()]]);
  await assert.rejects(
    resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')),
    (e: unknown) => {
      assert.ok(e instanceof SelectorNotFoundError, 'still a selector miss — exit 1, still a heal trigger');
      assert.match(e.message, /No element matched selector '@vk_sheet_confirm' after 0\.0s\./);
      assert.match(e.message, /only a modal barrier \(desc="Scrim"\) for the whole wait/);
      assert.match(e.message, /Run `verikun ui`/);
      return true;
    },
  );
});

test('resolveOneWaiting: a barrier that appeared late is reported as "on the last read"', async () => {
  // First read: an ordinary screen without the target. Then a sheet opens and blocks it.
  const ctx = ctxWith([[makeEl({ text: 'Home' })], [content(), scrim()]]);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.match((e as Error).message, /\(desc="Scrim"\) on the last read/);
    return true;
  });
});

test('resolveOneWaiting: an ordinary miss keeps the ordinary message', async () => {
  const ctx = ctxWith([[makeEl({ text: 'Home' })]]);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.doesNotMatch((e as Error).message, /modal barrier/);
    assert.match((e as Error).message, /No element matched selector '@vk_sheet_confirm' after 0\.0s\. Run `verikun ui`/);
    return true;
  });
});

test('resolveOneWaiting: the transient case resolves once the sheet lands, with no note', async () => {
  // The measured shape: barrier-only on the first read, the sheet on the next.
  const ctx = ctxWith([[content(), scrim()], [content(), confirm(), scrim()]]);
  const { element, waitedMs } = await resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm'));
  assert.equal(element.id, 'vk_sheet_confirm');
  assert.ok(waitedMs >= 0);
});

test('resolveOneWaiting: a barrier seen earlier in the window but gone at the end is not blamed', async () => {
  // A miss whose LAST read was a normal screen is a normal miss — the barrier is not what
  // the caller is looking at any more.
  const ctx = ctxWith([[content(), scrim()], [makeEl({ text: 'Home' })]]);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.doesNotMatch((e as Error).message, /modal barrier/);
    return true;
  });
});

test('matchWaiting: hands the tally back so find/assert can use the same clause', async () => {
  const ctx = ctxWith([[content(), scrim()]]);
  const res = await matchWaiting(ctx, parseSelector('text:Confirm'));
  assert.equal(res.matches.length, 0);
  assert.match(res.barrier.clause(), /for the whole wait/);

  const hit = await matchWaiting(ctxWith([[content(), confirm(), scrim()]]), parseSelector('text:Confirm'));
  assert.equal(hit.matches.length, 1);
  assert.equal(hit.barrier.clause(), '', 'a hit never carries a barrier clause');
});

test('ReadTally: an empty snapshot is not a barrier, and resets the verdict', () => {
  const tally = new ReadTally(ctxWith([]));
  tally.note([content(), scrim()]);
  assert.match(tally.clause(), /whole wait/);
  tally.note([]);
  assert.equal(tally.clause(), '', 'a blank read (NoWindowError absorbed as []) is a different signal');
});

test('ReadTally: the viewport comes from the driver, so the size floor applies', () => {
  // With the viewport known, a lone small tap target is a screen, not a barrier.
  const tally = new ReadTally(ctxWith([]));
  tally.note([makeEl({ desc: 'OK', clickable: true, bounds: { x1: 390, y1: 1100, x2: 690, y2: 1200 } })]);
  assert.equal(tally.clause(), '');
});

// --- a window that never once read the screen (issue #137) ---------------------------
//
// A killed dump is absorbed like a no-window, so a caller with a budget polls through it.
// The difference is what happens when the budget runs out: a null root is the device ANSWERING
// "nothing is drawn", so "absent" is a true reading of it — a kill is no answer at all.

/** A ctx whose driver throws `e` for the first `n` reads, then serves `els`. */
function ctxThrowing(e: Error, n: number, els: Element[] = [content()]): Ctx {
  let i = 0;
  const driver = makeDriver({
    getElements: () => {
      if (i++ < n) throw e;
      return els;
    },
    viewport: () => VP,
  });
  return { driver, platform: 'android', positionals: [], flags: { wait: '200', interval: '5' } };
}

test('resolveOneWaiting: a killed dump is polled through, not fatal', async () => {
  // The bug: three back-to-back driver attempts lost the same race and a `wait` with a
  // two-minute budget aborted at ~2.5s. The budget is the caller's to spend.
  const ctx = ctxThrowing(new DumpKilledError(), 3, [content(), confirm()]);
  const { element } = await resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm'));
  assert.equal(element.idShort, 'vk_sheet_confirm');
});

test('resolveOneWaiting: a window of NOTHING but killed dumps fails as the environment', async () => {
  // Never "no element matched": reporting an absence nobody observed sends the reader looking
  // for a missing identifier in app code, when the answer is that the phone is out of memory.
  const ctx = ctxThrowing(new DumpKilledError(), Infinity);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.ok(e instanceof DumpKilledError, 'exit 3, and the class survives for the failover classifier');
    assert.equal((e as DumpKilledError).exitCode, 3);
    return true;
  });
});

test('resolveOneWaiting: ONE good read is enough to make an ordinary miss honest again', async () => {
  // The `everRead` gate, mirroring the engine's guard grace. The screen WAS legible at some
  // point in the window, so "the selector is not there" is a fair answer.
  const ctx = ctxThrowing(new DumpKilledError(), 1, [content()]);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.ok(e instanceof SelectorNotFoundError, 'a miss, not an environment failure');
    return true;
  });
});

test('resolveOneWaiting: a no-window window still reports an ordinary miss, unchanged', async () => {
  // The asymmetry, pinned. A null root IS an answer, and flipping this to exit 3 would break
  // every `--gone` assertion issued in the gap after `launch`.
  const ctx = ctxThrowing(new NoWindowError(), Infinity);
  await assert.rejects(resolveOneWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => {
    assert.ok(e instanceof SelectorNotFoundError);
    return true;
  });
});

test('matchWaiting: a blind window throws rather than handing back an empty match set', async () => {
  // matchWaiting feeds `assert --gone`, where empty is a PASS. Absorbing a kill silently
  // would manufacture a green earned from a screen nobody could read.
  const ctx = ctxThrowing(new DumpKilledError(), Infinity);
  await assert.rejects(matchWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => e instanceof DumpKilledError);
});

test('matchWaiting: --no-wait reaches the blind check too, on its single shot', async () => {
  // A zero window returns from a different branch than the polling one, and it must not be
  // the one path where a kill still reads as an absence.
  const ctx = ctxThrowing(new DumpKilledError(), Infinity);
  ctx.flags = { 'no-wait': true };
  await assert.rejects(matchWaiting(ctx, parseSelector('@vk_sheet_confirm')), (e: unknown) => e instanceof DumpKilledError);
});

test('ReadTally: a blind read is not a barrier, so it cannot borrow the barrier wording', () => {
  const tally = new ReadTally(ctxWith([[]]));
  tally.note([content(), scrim()]);
  tally.noteBlind(new DumpKilledError());
  assert.equal(tally.clause(), '', 'the last read saw nothing at all — a different signal');
});

// --- a blind read must not SATISFY a predicate, only fail to contradict one ------------
//
// Caught on a Pixel 3a while fixing #137, in the fix's own first cut: `--gone` is satisfied by
// an EMPTY tree, which is exactly what an absorbed transient hands back. The end-of-window
// check never ran because the predicate returned from inside the poll loop. `lastWasBlind()`
// is the per-read half of the rule; `rethrowIfBlind()` is the per-window half.

test('ReadTally: the last read is blind after an absorbed failure, and not after a real one', () => {
  const tally = new ReadTally(ctxWith([[]]));
  assert.equal(tally.lastWasBlind(), false, 'nothing absorbed yet');
  tally.noteBlind(new DumpKilledError());
  assert.equal(tally.lastWasBlind(), true);
  tally.note([content()]);
  assert.equal(tally.lastWasBlind(), false, 'a real read clears it — the screen came back');
});

test('ReadTally: a no-window read is blind too, even though it ends a window differently', () => {
  // The per-READ rule needs no asymmetry: an absorbed read yielded nothing to judge either
  // way. Only the per-WINDOW rule distinguishes them.
  const tally = new ReadTally(ctxWith([[]]));
  tally.noteBlind(new NoWindowError());
  assert.equal(tally.lastWasBlind(), true);
  tally.rethrowIfBlind(); // ...and still reports an ordinary miss, never throwing
});

test('ReadTally: a good read early does NOT license a pass from a blind read later', () => {
  // The subtle one. `okReads === 0` is the right gate for "report a miss or throw", and the
  // WRONG gate for "may this read satisfy --gone": one good read at the start of a window
  // would otherwise bank a green off every killed read after it.
  const tally = new ReadTally(ctxWith([[]]));
  tally.note([content()]);
  tally.noteBlind(new DumpKilledError());
  assert.equal(tally.lastWasBlind(), true, 'this read still proves nothing');
  tally.rethrowIfBlind(); // and the window as a whole was readable, so no throw
});
