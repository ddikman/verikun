import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isRecordable, stepName, rolloverReason, RunState } from '../src/run';

// --- isRecordable ---------------------------------------------------------

test('isRecordable: actions and assertions are recorded', () => {
  for (const c of ['tap', 'text', 'type', 'swipe', 'screenshot', 'wait', 'assert', 'launch', 'back']) {
    assert.equal(isRecordable(c), true, `${c} should be recordable`);
  }
});

test('isRecordable: inspection commands are not recorded', () => {
  for (const c of ['ui', 'find', 'devices', 'doctor', 'current']) {
    assert.equal(isRecordable(c), false, `${c} should not be recordable`);
  }
});

// --- stepName -------------------------------------------------------------

test('stepName: tap by selector vs. by coordinates', () => {
  assert.equal(stepName('tap', ['@login'], {}), 'tap @login');
  assert.equal(stepName('tap', [], { at: '100,200' }), 'tap (100,200)');
});

test('stepName: text omits the typed value (it may be a secret)', () => {
  assert.equal(stepName('text', ['@field', 'hunter2'], {}), 'text @field');
});

test('stepName: swipe renders direction/region or explicit endpoints', () => {
  assert.equal(stepName('swipe', ['up'], {}), 'swipe up');
  assert.equal(stepName('swipe', ['up'], { on: '@list' }), 'swipe up on @list');
  assert.equal(stepName('swipe', [], { from: '0,0', to: '10,10' }), 'swipe 0,0->10,10');
});

test('stepName: fixed-label and fallback commands', () => {
  assert.equal(stepName('type', ['hello'], {}), 'type');
  assert.equal(stepName('screenshot', [], {}), 'screenshot');
  assert.equal(stepName('back', [], {}), 'back');
  assert.equal(stepName('key', ['enter'], {}), 'key enter'); // default branch
});

// --- rolloverReason -------------------------------------------------------

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'r1',
    name: 'run',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    platform: 'android',
    device: 'serialA',
    session: 'sess1',
    implicit: true,
    steps: [],
    ...overrides,
  };
}

test('rolloverReason: a device change forces a rollover', () => {
  const reason = rolloverReason(state({ device: 'serialA' }), 'serialB', 'sess1');
  assert.ok(reason && /device changed \(serialA → serialB\)/.test(reason));
});

test('rolloverReason: a session change forces a rollover', () => {
  const reason = rolloverReason(state({ device: 'serialA', session: 'sess1' }), 'serialA', 'sess2');
  assert.equal(reason, 'different session');
});

test('rolloverReason: same device + session + recent activity keeps the run', () => {
  assert.equal(rolloverReason(state(), 'serialA', 'sess1'), null);
});

test('rolloverReason: an idle implicit run rolls over, a named one does not', () => {
  const prev = process.env.VERIKUN_RUN_IDLE_MIN;
  process.env.VERIKUN_RUN_IDLE_MIN = '30';
  try {
    const old = '2000-01-01T00:00:00.000Z';
    const implicit = rolloverReason(state({ implicit: true, updatedAt: old }), 'serialA', 'sess1');
    assert.ok(implicit && /idle/.test(implicit));

    const named = rolloverReason(state({ implicit: false, updatedAt: old }), 'serialA', 'sess1');
    assert.equal(named, null); // a deliberately-named run is sticky to idle
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_RUN_IDLE_MIN;
    else process.env.VERIKUN_RUN_IDLE_MIN = prev;
  }
});
