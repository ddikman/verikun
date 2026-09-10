import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BarrierTally, matchWaiting, resolveOneWaiting } from '../src/commands/auto-wait';
import type { Ctx } from '../src/commands/context';
import { SelectorNotFoundError } from '../src/errors';
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

test('BarrierTally: an empty snapshot is not a barrier, and resets the verdict', () => {
  const tally = new BarrierTally(ctxWith([]));
  tally.note([content(), scrim()]);
  assert.match(tally.clause(), /whole wait/);
  tally.note([]);
  assert.equal(tally.clause(), '', 'a blank read (NoWindowError absorbed as []) is a different signal');
});

test('BarrierTally: the viewport comes from the driver, so the size floor applies', () => {
  // With the viewport known, a lone small tap target is a screen, not a barrier.
  const tally = new BarrierTally(ctxWith([]));
  tally.note([makeEl({ desc: 'OK', clickable: true, bounds: { x1: 390, y1: 1100, x2: 690, y2: 1200 } })]);
  assert.equal(tally.clause(), '');
});
