import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  VIOLATION_WINDOW_MS,
  adbHealthProbe,
  adbRecycleEnabled,
  adbServerRotting,
  countViolations,
  describeRot,
  parseEtime,
} from '../src/adb-health';

// A verbatim line from a rotted server (macOS 26, adb 37.0.1), trimmed only in length.
const REAL_LINE =
  '2026-09-12 16:18:38.347 E  kernel[0:2373f9a] ERROR: [adb:96399] EXC_GUARD AST: type=0x1 flavor=0x200 target=0x2d33';
// `log show --style compact` ALWAYS emits this first. Counting it is the bug this guards.
const HEADER = 'Timestamp               Ty Process[PID:TID]';

test('parseEtime: the three `ps -o etime=` shapes', () => {
  assert.equal(parseEtime('45:03'), (45 * 60 + 3) * 1000);
  assert.equal(parseEtime('09:45:03'), ((9 * 60 + 45) * 60 + 3) * 1000);
  assert.equal(parseEtime('09-08:33:29'), (((9 * 24 + 8) * 60 + 33) * 60 + 29) * 1000);
});

test('parseEtime: anything unrecognised is undefined, never a wrong number', () => {
  // This feeds an advisory, so a parse failure must degrade to silence.
  for (const bad of ['', '   ', 'nope', '1:2:3:4', '-5:00', 'x-01:02:03']) {
    assert.equal(parseEtime(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
  }
});

test('countViolations: the compact-output header is NOT a violation', () => {
  // A naive line count reports 1 on a healthy host, which would cry rot forever.
  assert.equal(countViolations(HEADER), 0);
  assert.equal(countViolations(`${HEADER}\n`), 0);
  assert.equal(countViolations(''), 0);
});

test('countViolations: counts only lines naming adb', () => {
  const other = '2026-09-12 16:18:38.347 E  kernel[0:1] ERROR: [Spotify:123] EXC_GUARD AST: type=0x1';
  assert.equal(countViolations([HEADER, REAL_LINE, REAL_LINE, other].join('\n')), 2);
});

test('adbServerRotting: any nonzero count is rot; a healthy server is exactly zero', () => {
  // Measured: healthy sits at 0 over the window, rotted at 60-120/min. No middle ground,
  // so there is no threshold to tune — which is why this is `> 0` and not a constant.
  assert.equal(adbServerRotting({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), false);
  assert.equal(adbServerRotting({ violations: 1, windowMs: VIOLATION_WINDOW_MS }), true);
  assert.equal(adbServerRotting({ violations: 239, windowMs: VIOLATION_WINDOW_MS }), true);
});

test('adbServerRotting: an unmeasurable host is never rot', () => {
  // Not macOS, or the query failed. We must not restart a host transport on a hunch.
  assert.equal(adbServerRotting({}), false);
  assert.equal(adbServerRotting({ pid: 497, ageMs: 9 * 864e5 }), false);
});

test('describeRot: reports a per-minute rate, not the raw window count', () => {
  // 239 over 2 minutes is the measured rotted rate; the operator needs /min to compare.
  const d = describeRot({ violations: 239, windowMs: VIOLATION_WINDOW_MS, ageMs: 9 * 864e5 });
  assert.ok(d && d.includes('~120'), `expected ~120/min, got: ${d}`);
  assert.ok(d.includes('216h'), `expected the age, got: ${d}`);
});

test('describeRot: silent on a healthy server', () => {
  assert.equal(describeRot({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), undefined);
  assert.equal(describeRot({}), undefined);
});

test('adbHealthProbe: null when healthy, so doctor stays quiet', () => {
  assert.equal(adbHealthProbe({ violations: 0, windowMs: VIOLATION_WINDOW_MS }), null);
  assert.equal(adbHealthProbe({}), null);
});

test('adbHealthProbe: ADVISORY — it must never change doctor exit code', () => {
  // Exit 3 means "a machine that cannot drive a device". A rotted adb server is a thing to
  // fix, not that. Same rule the version check holds.
  const p = adbHealthProbe({ violations: 239, windowMs: VIOLATION_WINDOW_MS, ageMs: 9 * 864e5 });
  assert.ok(p);
  assert.equal(p.ok, true);
  assert.equal(p.advisory, true);
  assert.ok(p.hint?.includes('kill-server'), 'the remedy must be named, like `vk device release` is');
});

test('adbRecycleEnabled: on by default for Android, never for iOS', () => {
  const prev = process.env.VERIKUN_NO_ADB_RECYCLE;
  delete process.env.VERIKUN_NO_ADB_RECYCLE;
  try {
    // `vk server` sits on a CI host for days, which is what rots adb — so default-on.
    assert.equal(adbRecycleEnabled('android'), true);
    // iOS has no adb to recycle; it must never pay for the check.
    assert.equal(adbRecycleEnabled('ios'), false);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_ADB_RECYCLE;
    else process.env.VERIKUN_NO_ADB_RECYCLE = prev;
  }
});

test('adbRecycleEnabled: the kill switch restores the previous behaviour exactly', () => {
  const prev = process.env.VERIKUN_NO_ADB_RECYCLE;
  process.env.VERIKUN_NO_ADB_RECYCLE = '1';
  try {
    assert.equal(adbRecycleEnabled('android'), false);
  } finally {
    if (prev === undefined) delete process.env.VERIKUN_NO_ADB_RECYCLE;
    else process.env.VERIKUN_NO_ADB_RECYCLE = prev;
  }
});
