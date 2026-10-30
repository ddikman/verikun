import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DeviceTable } from '../src/server-devices';
import { DeviceGoneError, DeviceUnresponsiveError, DumpKilledError, NoWindowError, UnsupportedOnPlatformError, CliError } from '../src/errors';

function fixture() {
  let now = 1000;
  const evicted: string[] = [];
  const table = new DeviceTable(() => now, (s, r) => evicted.push(`${s}:${r}`));
  table.transition('a', 'ready', 'boot');
  return { table, evicted, advance: (ms: number) => now += ms };
}
for (const ErrorClass of [DeviceGoneError, DeviceUnresponsiveError]) test(`${ErrorClass.name}: checking evicts even when the echo recovers`, () => {
  const {table, evicted} = fixture();
  table.transition('a', 'leased', 'run');
  assert.equal(table.report('a', new ErrorClass('lost')), 'check');
  assert.equal(table.get('a')?.state, 'checking');
  assert.equal(evicted.length, 1);
  table.transition('a', 'ready', 'echo passed');
  assert.deepEqual(table.ready(), ['a']);
});
test('a watchdog suspicion keeps the holder until a confirmed down transition', () => {
  const {table, evicted} = fixture();
  assert.equal(table.echo('a', false), 'stay');
  assert.equal(table.echo('a', false), 'check');
  assert.deepEqual(evicted, []);
  table.transition('a', 'down', 'echo grace expired');
  table.transition('a', 'down', 'echo grace expired');
  assert.equal(evicted.length, 1, 'leave is idempotent');
});
for (const e of [new NoWindowError(), new UnsupportedOnPlatformError('unsupported')]) test(`${e.name} never strikes`, () => {
  const {table} = fixture();
  for (let i = 0; i < 9; i++) assert.equal(table.report('a', e), 'stay');
  assert.equal(table.get('a')?.strikes, 0);
});
for (const e of [new DumpKilledError(), new CliError('unclassified environment', 3)]) test(`${e.name} checks after exactly three windows`, () => {
  const {table, evicted} = fixture();
  assert.equal(table.report('a', e), 'stay');
  assert.equal(table.report('a', e), 'stay');
  assert.equal(table.report('a', e), 'check');
  assert.equal(evicted.length, 0);
  assert.deepEqual(table.ready(), []);
  table.transition('a', 'ready', 'HOME and hierarchy answered');
  assert.equal(table.get('a')?.strikes, 0);
});
test('real work resets strikes; checking and down health are disjoint', () => {
  const {table} = fixture(); table.report('a', new DumpKilledError()); table.report('a');
  assert.equal(table.get('a')?.strikes, 0);
  table.transition('a', 'checking', 'suspect');
  assert.deepEqual(table.degraded().map(d => d.serial), ['a']);
  assert.deepEqual(table.quarantined(), []);
  table.transition('a', 'down', 'dead');
  assert.deepEqual(table.degraded(), []);
  assert.deepEqual(table.quarantined().map(d => d.serial), ['a']);
});
test('readmission backoff uses an injected clock, doubles, and caps at five minutes', () => {
  const {table, advance} = fixture();
  table.transition('a', 'down', 'gone');
  assert.equal(table.get('a')?.nextTryAt, 6000);
  advance(5000);
  for (let i = 0; i < 10; i++) { table.transition('a', 'joining', 'attempt'); table.transition('a', 'down', 'still gone'); }
  assert.equal(table.get('a')!.nextTryAt - 6000, 300_000);
});
test('install failures use a longer backoff and preserve retained build identity', () => {
  const {table} = fixture();
  table.transition('a', 'installing', 'build', { installedSha: 'abc', bootId: 'boot' });
  table.transition('a', 'down', 'install timeout', { installFailure: true });
  assert.equal(table.get('a')?.nextTryAt, 61_000);
  assert.equal(table.get('a')?.installedSha, 'abc');
  assert.equal(table.get('a')?.bootId, 'boot');
});
test('joining for a host event keeps leases and removes capacity temporarily', () => {
  const {table, evicted} = fixture(); table.transition('a', 'leased', 'run');
  table.transition('a', 'joining', 'host event');
  assert.equal(evicted.length, 0); assert.deepEqual(table.ready(), []);
  table.transition('a', 'ready', 'host recovered');
  assert.equal(evicted.length, 0); assert.deepEqual(table.ready(), ['a']);
});

test('failed admission backoff is measured from attempt start, not slow probe completion',()=>{
  let now=1000;const table=new DeviceTable(()=>now);
  table.transition('a','joining','admission');now=5000;
  table.transition('a','down','echo failed');
  assert.equal(table.get('a')?.nextTryAt,6000);
});

test('an install preserves its attempt clock while draining and retires once after eviction',()=>{
  let now=1000;const events:string[]=[];
  const table=new DeviceTable(()=>now,()=>events.push('evict'),()=>{},()=>events.push('retire'));
  table.transition('a','ready','boot');
  table.transition('a','installing','build');now=91_000;
  table.transition('a','draining','response grace elapsed');now=241_000;
  table.transition('a','down','install deadline',{installFailure:true});
  table.transition('a','down','worker exited');
  assert.equal(table.get('a')?.nextTryAt,61_000,'cleanup can immediately readmit a four-minute failed attempt');
  assert.deepEqual(events,['evict','retire'],'restore originals before killing the group, once');
});
