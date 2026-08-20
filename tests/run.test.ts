import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRecordable,
  stepName,
  rolloverReason,
  rolloverLogsSameDevice,
  RunState,
  wantsArchiveLogs,
  archiveLogWindow,
  inferRunAppId,
  laneId,
  runId,
  uniqueDir,
} from '../src/run';

// --- isRecordable ---------------------------------------------------------

test('isRecordable: actions and assertions are recorded', () => {
  for (const c of ['tap', 'text', 'type', 'swipe', 'screenshot', 'wait', 'assert', 'launch', 'clear', 'back']) {
    assert.equal(isRecordable(c), true, `${c} should be recordable`);
  }
});

test('isRecordable: inspection commands are not recorded', () => {
  for (const c of ['ui', 'find', 'devices', 'doctor', 'current']) {
    assert.equal(isRecordable(c), false, `${c} should not be recordable`);
  }
});

test('isRecordable: device set/reset change the app\'s environment, so they record', () => {
  // A report showing "checkout failed" without "we cut the network two steps
  // earlier" would point the reader at the wrong culprit.
  assert.equal(isRecordable('device', ['set', 'airplane=on']), true);
  assert.equal(isRecordable('device', ['reset']), true);
});

test('isRecordable: device get/caps are inspection and do not record', () => {
  // Otherwise merely asking what the platform supports would auto-start a test run —
  // the same noise `ui`/`find` are excluded to avoid.
  assert.equal(isRecordable('device', ['get']), false);
  assert.equal(isRecordable('device', ['caps']), false);
  assert.equal(isRecordable('device', []), false);
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

test('stepName: device keeps the whole assignment list', () => {
  // The default branch would render "device set", which tells a report reader
  // nothing about what actually changed on the phone.
  assert.equal(stepName('device', ['set', 'dark=on'], {}), 'device set dark=on');
  assert.equal(
    stepName('device', ['set', 'dark=on', 'rotation=landscape'], {}),
    'device set dark=on rotation=landscape',
  );
  assert.equal(stepName('device', ['reset'], {}), 'device reset');
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

test('rolloverLogsSameDevice: skip archive logs when the incoming serial differs', () => {
  // Device-change rollover: the step's driver already targets serialB — do not
  // attribute its logcat to the run that lived on serialA.
  assert.equal(rolloverLogsSameDevice('serialA', 'serialB'), false);
  assert.equal(rolloverLogsSameDevice('serialA', 'serialA'), true);
  // Idle/session rollover (or an unbound run) — same-device capture is fine.
  assert.equal(rolloverLogsSameDevice(undefined, 'serialA'), true);
  assert.equal(rolloverLogsSameDevice('serialA', undefined), true);
});

// --- archive-time device logs ---------------------------------------------

test('wantsArchiveLogs: on by default for green runs', () => {
  const prev = process.env.VERIKUN_NO_LOGS;
  delete process.env.VERIKUN_NO_LOGS;
  try {
    assert.equal(wantsArchiveLogs(false), true);
    assert.equal(wantsArchiveLogs(false, false), true);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_LOGS;
    else process.env.VERIKUN_NO_LOGS = prev;
  }
});

test('wantsArchiveLogs: --no-logs / VERIKUN_NO_LOGS skips green runs only', () => {
  const prev = process.env.VERIKUN_NO_LOGS;
  try {
    delete process.env.VERIKUN_NO_LOGS;
    assert.equal(wantsArchiveLogs(false, true), false);
    assert.equal(wantsArchiveLogs(true, true), true, 'failures still capture');

    process.env.VERIKUN_NO_LOGS = '1';
    assert.equal(wantsArchiveLogs(false, false), false);
    assert.equal(wantsArchiveLogs(true, false), true, 'failures still capture with env opt-out');
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_LOGS;
    else process.env.VERIKUN_NO_LOGS = prev;
  }
});

test('archiveLogWindow: prefers session since, else a bounded trailing dump', () => {
  assert.deepEqual(archiveLogWindow({ logStart: '08-06 10:00:00.000' }), { since: '08-06 10:00:00.000' });
  const noMarker = archiveLogWindow({});
  assert.equal(noMarker.since, undefined);
  assert.ok(typeof noMarker.lines === 'number' && noMarker.lines! > 0);
});
test('inferRunAppId: prefers state.appId, else the latest lifecycle step', () => {
  assert.equal(inferRunAppId({ appId: 'com.explicit', steps: [] }), 'com.explicit');
  assert.equal(
    inferRunAppId({
      steps: [
        { index: 0, command: 'launch', name: 'launch com.first', startedAt: '', durationMs: 0, status: 'passed', exitCode: 0 },
        { index: 1, command: 'tap', name: 'tap @x', startedAt: '', durationMs: 0, status: 'passed', exitCode: 0 },
        { index: 2, command: 'launch', name: 'launch com.second', startedAt: '', durationMs: 0, status: 'passed', exitCode: 0 },
      ],
    }),
    'com.second',
  );
  assert.equal(inferRunAppId({ steps: [] }), undefined);
});

// --- lanes ------------------------------------------------------------------

test('laneId: sanitises, because the value becomes a directory name and a run id', () => {
  assert.equal(laneId({} as NodeJS.ProcessEnv), '');
  assert.equal(laneId({ VERIKUN_LANE: 'l2' } as NodeJS.ProcessEnv), 'l2');
  assert.equal(laneId({ VERIKUN_LANE: 'emulator-5554' } as NodeJS.ProcessEnv), 'emulator-5554');
  // Separators are dropped, so what survives is always ONE path component — the
  // remaining dots cannot traverse because the lane is a suffix (`run-....etc`).
  assert.equal(laneId({ VERIKUN_LANE: '../../etc' } as NodeJS.ProcessEnv), '....etc');
  assert.equal(laneId({ VERIKUN_LANE: 'a/b' } as NodeJS.ProcessEnv), 'ab');
  // A value that sanitises away entirely reads as "no lane" — the pre-lane behaviour.
  assert.equal(laneId({ VERIKUN_LANE: '///' } as NodeJS.ProcessEnv), '');
  assert.equal(laneId({ VERIKUN_LANE: 'x'.repeat(80) } as NodeJS.ProcessEnv).length, 32);
});

test('runId: a lane suffix makes concurrent same-second ids distinct', () => {
  const prev = process.env.VERIKUN_LANE;
  try {
    delete process.env.VERIKUN_LANE;
    const bare = runId();
    assert.match(bare, /^\d{8}-\d{6}$/);
    process.env.VERIKUN_LANE = 'l3';
    assert.match(runId(), /^\d{8}-\d{6}-l3$/);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_LANE;
    else process.env.VERIKUN_LANE = prev;
  }
});

test('uniqueDir: claims the directory by creating it, and advances on collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-unique-'));
  try {
    const base = join(root, 'runs', '20260820-141530');
    // Creates missing parents, and returns the base CREATED (not merely free).
    const first = uniqueDir(base);
    assert.equal(first, base);
    assert.ok(existsSync(first));
    // A second claim cannot take the same path, even though the first is empty —
    // that is the check-then-act race this replaced.
    assert.equal(uniqueDir(base), `${base}-2`);
    assert.equal(uniqueDir(base), `${base}-3`);
    assert.deepEqual(readdirSync(join(root, 'runs')).sort(), [
      '20260820-141530',
      '20260820-141530-2',
      '20260820-141530-3',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uniqueDir: skips a NON-empty pre-existing directory rather than adopting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-unique-'));
  try {
    const base = join(root, 'r');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'report.html'), 'an earlier run');
    assert.equal(uniqueDir(base), `${base}-2`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
