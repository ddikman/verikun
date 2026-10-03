import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LeaseTable } from '../src/server-leases';

function fixture(serials = ['a', 'b']) {
  let now = 1;
  const table = new LeaseTable(() => serials, () => now);
  return { table, advance: (ms: number) => now += ms, serials };
}
test('affinity, avoidance, round robin and tombstones are independent of pool size', () => {
  const {table, advance} = fixture();
  assert.equal(table.acquire('first', 'a'), 'b');
  assert.equal(table.acquire('second'), 'a');
  advance(20); table.release('second');
  assert.equal(table.acquire('first'), 'b');
  assert.equal(table.acquire('third'), 'a');
  table.evictDevice('b', 'lost');
  assert.equal(table.acquire('first'), null);
  assert.equal(table.evicted.get('first')?.serial, 'b');
});
test('a quiet held lease is never taken over by another token', () => {
  const {table, advance} = fixture(['a']);
  table.acquire('first'); advance(600_000);
  assert.equal(table.acquire('first'), 'a');
  assert.equal(table.acquire('second'), null);
  table.release('first', true);
  assert.equal(table.acquire('second'), 'a');
  assert.equal(table.acquire('first'), null);
});

test('same-token exclusive reentry is refused and finally hands the pool back', async () => {
  const {table} = fixture();
  await table.drainAndHold('one', async () => {
    await assert.rejects(table.drainAndHold('one', async () => {}), /already/);
    assert.equal(table.acquire('two'), null);
  });
  assert.equal(table.acquire('two'), 'a');
  await assert.rejects(table.drainAndHold('one', async () => { throw new Error('fail'); }), /fail/);
  assert.equal(table.exclusive, null);
});
test('release while work drains cannot hand the serial to a sibling', async () => {
  const {table} = fixture(['a']); table.acquire('one');
  let done!: () => void;
  const running = table.hold('one', () => new Promise<void>(r => done = r));
  table.release('one', true);
  assert.equal(table.acquire('two'), null);
  assert.equal(table.acquire('one'), null);
  done(); await running;
  assert.equal(table.acquire('two'), 'a');
});
test('FIFO waiters are dealt on release before a fresh caller can jump the queue', async () => {
  const {table} = fixture(['a']); table.acquire('one');
  const two = table.wait('two', 1000); const three = table.wait('three', 1000);
  table.release('one'); assert.equal(await two, 'a');
  assert.equal(table.acquire('fresh'), null);
  table.release('two'); assert.equal(await three, 'a');
  table.dispose();
});
test('cancelled waiters never leave an orphan lease', async () => {
  const {table} = fixture(['a']); table.acquire('one');
  const pending = table.wait('two', 1000);
  table.cancelWait('two'); assert.equal(await pending, null);
  table.release('one'); assert.equal(table.acquire('three'), 'a');
});
test('tombstones are capped at 512 entries', () => {
  const {table} = fixture(); for (let i = 0; i < 600; i++) table.evict(String(i), 'lost');
  assert.equal(table.evicted.size, 512); assert.equal(table.evicted.has('0'), false);
});

test('avoid waits for a healthy sibling already leased, but permits a healed pool of one',async()=>{
  const {table,serials}=fixture();
  table.acquire('healthy','a');
  assert.equal(table.acquire('rerun','a'),null);
  const pending=table.wait('rerun',1000,'a');
  table.release('healthy');assert.equal(await pending,'b');
  table.release('rerun');serials.splice(1,1);
  assert.equal(table.acquire('sole-rerun','a'),'a');
});
