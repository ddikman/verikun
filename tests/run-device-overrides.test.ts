import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, RunState } from '../src/run';

// `vk device set` snapshots each setting's pre-change value into the ACTIVE run, and
// `vk device reset` restores from there. A run ROLLOVER (device change, session change,
// idle timeout) seals that run and starts a fresh one — which used to take the snapshot
// with it, leaving the device modified while `device reset` cheerfully reported
// "nothing to restore". That is the exact failure this feature exists to prevent, so
// the rollover path is pinned here.
//
// Reproduced for real: two Conductor workspaces driving different devices from the same
// working directory ping-ponged the active run, and a phone was left dark + rotated.

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'vk-dev-ovr-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VERIKUN_SESSION;
});

const loadRun = (): RunState =>
  JSON.parse(readFileSync(join(dir, '.verikun', 'run', 'run.json'), 'utf8')) as RunState;

/** Open + close one recorded step for `serial`, as a real command would. */
function step(serial: string, command = 'tap', positionals: string[] = ['@x']): void {
  const rec = Recorder.beginStep(command, positionals, {}, 'android', serial, serial);
  assert.ok(rec, 'expected a recorder (recording must be enabled)');
  rec.finish(0);
}

test('rememberDeviceOverride: keeps the EARLIEST original, not the latest', () => {
  process.env.VERIKUN_SESSION = 's1';
  const rec = Recorder.beginStep('device', ['set', 'dark=on'], {}, 'android', 'DEV1', 'DEV1');
  assert.ok(rec);
  rec.rememberDeviceOverride('dark', 'off');
  rec.rememberDeviceOverride('dark', 'on'); // a second set within the same run
  rec.finish(0);
  // Restoring to 'on' would put back the intermediate value, not what the device had.
  assert.deepEqual(loadRun().deviceOverrides, { dark: 'off' });
});

test('a same-device rollover CARRIES the overrides into the fresh run', () => {
  process.env.VERIKUN_SESSION = 's1';
  const rec = Recorder.beginStep('device', ['set', 'dark=on'], {}, 'android', 'DEV1', 'DEV1');
  assert.ok(rec);
  rec.rememberDeviceOverride('dark', 'off');
  rec.finish(0);

  // Same device, different session — a rollover, but the phone in front of us is the
  // one that was changed, so reset must still be able to undo it.
  process.env.VERIKUN_SESSION = 's2';
  step('DEV1');

  assert.deepEqual(loadRun().deviceOverrides, { dark: 'off' }, 'overrides were dropped on rollover');
});

test('a DIFFERENT-device rollover does not carry overrides onto the wrong device', () => {
  process.env.VERIKUN_SESSION = 's1';
  const rec = Recorder.beginStep('device', ['set', 'dark=on'], {}, 'android', 'DEV1', 'DEV1');
  assert.ok(rec);
  rec.rememberDeviceOverride('dark', 'off');
  rec.finish(0);

  // Now a step for a different device seals DEV1's run. Restoring DEV1's values onto
  // DEV2 would change a device nobody touched — worse than leaving DEV1 modified.
  step('DEV2');

  const state = loadRun();
  assert.equal(state.device, 'DEV2');
  assert.deepEqual(state.deviceOverrides ?? {}, {}, 'DEV1 overrides must not follow onto DEV2');
});

test('deviceOverrides/forget round-trip through the run file', () => {
  process.env.VERIKUN_SESSION = 's1';
  const rec = Recorder.beginStep('device', ['set', 'dark=on'], {}, 'android', 'DEV1', 'DEV1');
  assert.ok(rec);
  rec.rememberDeviceOverride('dark', 'off');
  rec.rememberDeviceOverride('rotation', 'auto');
  rec.finish(0);
  assert.deepEqual(loadRun().deviceOverrides, { dark: 'off', rotation: 'auto' });
  assert.equal(Recorder.hasDeviceOverrides(), true);

  // A later PROCESS reads the snapshot back off disk, restores one, and forgets only
  // that one — the cross-process path `vk device reset` actually takes.
  const reset = Recorder.beginStep('device', ['reset', 'dark'], {}, 'android', 'DEV1', 'DEV1');
  assert.ok(reset);
  assert.deepEqual(reset.deviceOverrides(), { dark: 'off', rotation: 'auto' });
  reset.forgetDeviceOverrides(['dark']);
  reset.finish(0);

  assert.deepEqual(loadRun().deviceOverrides, { rotation: 'auto' });
  assert.equal(Recorder.hasDeviceOverrides(), true);
});

test('hasDeviceOverrides is false with no run at all', () => {
  assert.equal(Recorder.hasDeviceOverrides(), false);
});
