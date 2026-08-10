import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pollUntil, sleep } from '../src/wait';

// --- pollUntil (the device-boot wait; must never overshoot its deadline) ----

test('pollUntil: returns the first non-undefined probe result without sleeping', async () => {
  const t0 = Date.now();
  const got = await pollUntil(() => 'ready', { timeoutMs: 5000, intervalMs: 1000 });
  assert.equal(got, 'ready');
  // A hit on the first probe must not wait out an interval.
  assert.ok(Date.now() - t0 < 200, 'should return immediately');
});

test('pollUntil: keeps polling while the probe returns undefined', async () => {
  let calls = 0;
  const got = await pollUntil(
    () => {
      calls++;
      return calls >= 3 ? calls : undefined;
    },
    { timeoutMs: 5000, intervalMs: 5 },
  );
  assert.equal(got, 3);
  assert.equal(calls, 3);
});

test('pollUntil: returns undefined at the deadline', async () => {
  const got = await pollUntil(() => undefined, { timeoutMs: 30, intervalMs: 5 });
  assert.equal(got, undefined);
});

test('pollUntil: never probes after the deadline has passed', async () => {
  let calls = 0;
  await pollUntil(
    () => {
      calls++;
      return undefined;
    },
    { timeoutMs: 30, intervalMs: 5 },
  );
  const after = calls;
  await sleep(30);
  assert.equal(calls, after, 'probe must not run once pollUntil resolved');
});

test('pollUntil: a zero window still probes exactly once (single shot)', async () => {
  let calls = 0;
  const got = await pollUntil(
    () => {
      calls++;
      return undefined;
    },
    { timeoutMs: 0 },
  );
  assert.equal(got, undefined);
  assert.equal(calls, 1);
});

test('pollUntil: onTick fires once per failed probe, never after a hit', async () => {
  let calls = 0;
  const ticks: number[] = [];
  await pollUntil(
    () => {
      calls++;
      return calls >= 3 ? 'ok' : undefined;
    },
    { timeoutMs: 5000, intervalMs: 5, onTick: (ms) => ticks.push(ms) },
  );
  assert.equal(ticks.length, 2, 'two failed probes → two ticks');
  assert.ok(ticks.every((ms) => ms >= 0));
});

test('pollUntil: a probe that throws propagates (callers own their retries)', async () => {
  await assert.rejects(
    () => pollUntil(() => { throw new Error('adb exploded'); }, { timeoutMs: 100 }),
    /adb exploded/,
  );
});

test('pollUntil: a falsy-but-defined value counts as a hit', async () => {
  assert.equal(await pollUntil(() => 0, { timeoutMs: 100 }), 0);
  assert.equal(await pollUntil(() => false, { timeoutMs: 100 }), false);
  assert.equal(await pollUntil(() => '', { timeoutMs: 100 }), '');
});
