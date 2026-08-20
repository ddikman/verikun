// The failover classifier and candidate filter. Pure — no device, no server.
//
// The cases that carry the weight are the POLARITY ones, not the table lookups: an
// install failure moves unless it is provably about the FILE, while an exec failure
// stays unless the device is provably gone. Everything else is detail.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyFailure,
  classifyInstallFailure,
  failoverCandidates,
  isUsableState,
} from '../src/device/failover';
import { CliError, NoWindowError, SelectorNotFoundError, AmbiguousSelectorError, probeFailure } from '../src/errors';
import type { DeviceInfo } from '../src/types';

/** The shape AdbDriver.install actually throws: a prefix, then adb's collapsed output. */
const installErr = (adbOutput: string) =>
  new CliError(`Failed to install '/tmp/verikun-server/abc.apk': ${adbOutput}`, 3);

// --- the polarity ------------------------------------------------------------

test('install: a failure nobody has ever seen still moves', () => {
  // THE test for this design. The classifier must not need to recognise a failure to
  // act on it — `install X onto Y` has two operands, and if it is not the file it is
  // the device. This fails the moment someone "tightens" the tables back into an
  // allowlist, which is the regression the whole inversion exists to prevent.
  const v = classifyInstallFailure(installErr('widget frobnicator exploded (code 71)'));
  assert.equal(v.move, true);
  assert.equal(v.kind, 'device-state');
  assert.equal(v.unclassified, true, 'an unrecognised move must be logged as such, or the tables rot');
});

test('install: the verbatim failure from issue #99 moves', () => {
  // Note this passes for the SAME reason as the gibberish above: there is no
  // INSTALL_FAILED_* code anywhere in it. The fast-path string only supplies the
  // wording of `reason`; deleting it would not change the decision.
  const v = classifyInstallFailure(
    installErr(
      "Performing Streamed Install adb: failed to install /var/folders/40/x/T/verikun-server/acc7820f.apk: " +
        "Exception occurred while executing 'install': android.os.ParcelableException: " +
        'java.io.IOException: Requested internal only, but not enough space at ' +
        'android.util.ExceptionUtils.wrap(ExceptionUtils.java:34)',
    ),
  );
  assert.equal(v.move, true);
  assert.equal(v.kind, 'device-state');
  assert.match(v.reason, /out of space/);
});

test('exec: the same unrecognised failure does NOT move — it asks the device', () => {
  // Asserting BOTH arms on one input is the point: the asymmetry is deliberate, and a
  // reader who thinks it is a bug should have to delete this test to "fix" it.
  const e = new CliError('widget frobnicator exploded (code 71)', 3);
  assert.equal(classifyInstallFailure(e).move, true, 'install: not the file ⇒ the device');
  const v = classifyFailure(e);
  assert.equal(v.move, false, 'exec: exit 3 is dominated by transient device noise');
  assert.equal(v.probe, true, 'but do not just shrug — ask the device');
});

// --- the artifact denylist: the only brake --------------------------------

test('install: a build that does not parse never moves', () => {
  for (const code of [
    'INSTALL_PARSE_FAILED_NO_CERTIFICATES',
    'INSTALL_PARSE_FAILED_MANIFEST_MALFORMED',
    'INSTALL_FAILED_INVALID_APK',
    'INSTALL_FAILED_TEST_ONLY',
  ]) {
    const v = classifyInstallFailure(installErr(`Failure [${code}]`));
    assert.equal(v.move, false, `${code} must not burn the pool`);
    assert.equal(v.kind, 'artifact');
  }
});

test("install: the server's own unreadable temp file is a host bug, not a device one", () => {
  const v = classifyInstallFailure(
    installErr('adb: failed to stat /tmp/verikun-server/abc.apk: No such file or directory'),
  );
  assert.equal(v.move, false);
  assert.equal(v.kind, 'artifact');
});

// --- fast paths: they shape the message, never the decision ------------------

test('install: a full device moves and names itself', () => {
  const v = classifyInstallFailure(installErr('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'));
  assert.equal(v.move, true);
  assert.equal(v.kind, 'device-state');
  assert.match(v.reason, /INSTALL_FAILED_INSUFFICIENT_STORAGE/);
  assert.ok(!v.unclassified, 'a recognised failure is not unclassified');
});

test('install: device-relative failures move — another device genuinely takes them', () => {
  for (const code of [
    'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    'INSTALL_FAILED_NO_MATCHING_ABIS',
    'INSTALL_FAILED_OLDER_SDK',
    'INSTALL_FAILED_MISSING_SHARED_LIBRARY',
  ]) {
    const v = classifyInstallFailure(installErr(`Failure [${code}]`));
    assert.equal(v.move, true, code);
    assert.equal(v.kind, 'device-state');
  }
});

test('both arms: an offline device moves as unreachable, with no probe needed', () => {
  const e = new CliError('adb: device offline', 3);
  for (const v of [classifyFailure(e), classifyInstallFailure(e)]) {
    assert.equal(v.move, true);
    assert.equal(v.kind, 'unreachable');
    assert.ok(!v.probe, 'the message already settled it');
  }
});

test('both arms: a preflight refusal moves as unreachable', () => {
  // The real shape AdbDriver.preflight throws, hint and all.
  const e = probeFailure({
    name: 'adb',
    ok: false,
    detail: 'device emulator-5554 is not ready (offline)',
    hint: 'reconnect it (check `verikun devices`)',
  });
  assert.equal(classifyFailure(e).kind, 'unreachable');
  assert.equal(classifyFailure(e).move, true);
});

// --- the never-move cases ----------------------------------------------------

test('both arms: NoWindowError never moves and never probes', () => {
  // Matched by IDENTITY, not message text. A device mid-`launch --clear` would fail a
  // probe, so probing here would rotate the pool every time an app is starting.
  const e = new NoWindowError('No window to read: the app has not drawn yet');
  for (const v of [classifyFailure(e), classifyInstallFailure(e)]) {
    assert.equal(v.move, false);
    assert.equal(v.kind, 'transient');
    assert.ok(!v.probe, 'probing a mid-launch device would upgrade a blip into a move');
  }
});

test('both arms: a missing toolchain never moves and never probes', () => {
  // With adb gone EVERY probe fails, so probing would wrongly upgrade this into a move
  // to a device we equally cannot drive.
  const e = new CliError("'adb' was not found on PATH. Is it installed and on your PATH?", 3);
  for (const v of [classifyFailure(e), classifyInstallFailure(e)]) {
    assert.equal(v.move, false);
    assert.equal(v.kind, 'toolchain');
    assert.ok(!v.probe);
  }
});

test('both arms: exit 1 and exit 2 never move — the app or the caller is at fault', () => {
  const cases: Array<[unknown, string]> = [
    [new SelectorNotFoundError('no match for text:Login'), 'app'],
    [new CliError('assertion failed', 1), 'app'],
    [new AmbiguousSelectorError('2 matches', []), 'usage'],
    [new CliError('Every attached device is in use', 2), 'usage'],
  ];
  for (const [e, kind] of cases) {
    for (const v of [classifyFailure(e), classifyInstallFailure(e)]) {
      assert.equal(v.move, false, kind);
      assert.equal(v.kind, kind);
    }
  }
});

// --- candidate selection -----------------------------------------------------

const dev = (serial: string, state = 'device', name?: string): DeviceInfo => ({
  serial,
  state,
  platform: 'android',
  ...(name ? { name } : {}),
});

test('candidates: drops the bound device, the quarantined ones, and unbooted AVDs', () => {
  const devices = [
    dev('emulator-5554'), // bound
    dev('emulator-5556'), // quarantined
    dev('', 'shutdown', 'Pixel_6_API_34'), // startable, but has no adb address
    dev('032AY1UNR2'),
  ];
  const got = failoverCandidates(devices, { exclude: ['emulator-5554', 'emulator-5556'] });
  assert.deepEqual(
    got.map((d) => d.serial),
    ['032AY1UNR2'],
  );
});

test('candidates: preserve listing order — the device that worked last is tried first', () => {
  const devices = [dev('a'), dev('b'), dev('c')];
  assert.deepEqual(
    failoverCandidates(devices, { exclude: [] }).map((d) => d.serial),
    ['a', 'b', 'c'],
  );
});

test('candidates: an offline or unauthorized device is never a candidate', () => {
  const devices = [dev('a', 'offline'), dev('b', 'unauthorized'), dev('c', 'booted')];
  assert.deepEqual(
    failoverCandidates(devices, { exclude: [] }).map((d) => d.serial),
    ['c'],
    'iOS spells it "booted"; neither platform spells a broken device "usable"',
  );
});

test('candidates: an allowlist matches on name OR serial, and excludes everything else', () => {
  // An operator writes an AVD name for an emulator and a raw serial for a phone;
  // being forced to know which is which is a papercut with teeth.
  const devices = [dev('emulator-5556', 'device', 'Pixel_6_API_34'), dev('032AY1UNR2'), dev('emulator-5558', 'device', 'Other_AVD')];
  const got = failoverCandidates(devices, { exclude: [], allow: ['Pixel_6_API_34', '032AY1UNR2'] });
  assert.deepEqual(
    got.map((d) => d.serial),
    ['emulator-5556', '032AY1UNR2'],
  );
});

test('candidates: an empty allowlist means "no restriction", not "nothing allowed"', () => {
  // The bare-flag / default case. Getting this backwards would silently disable
  // failover for everyone who did not pass a list.
  const devices = [dev('a'), dev('b')];
  assert.equal(failoverCandidates(devices, { exclude: [], allow: [] }).length, 2);
});


test('isUsableState: `connected` is matched loosely, but never as a substring', () => {
  // devicectl's State column is free text, so the physical-iPhone arm has to be loose.
  assert.equal(isUsableState('device'), true); // adb
  assert.equal(isUsableState('booted'), true); // simctl
  assert.equal(isUsableState('connected'), true); // devicectl
  assert.equal(isUsableState('available (connected)'), true);
  // An unanchored /connected/i matches these too — which would pool, and fail over ONTO,
  // a phone that is not there.
  assert.equal(isUsableState('disconnected'), false);
  assert.equal(isUsableState('not connected'), false);
  assert.equal(isUsableState('offline'), false);
  assert.equal(isUsableState('unauthorized'), false);
  assert.equal(isUsableState('shutdown'), false);
});

test('failoverCandidates: without an allowlist, a physical device is a last resort', () => {
  // Failover is ON by default on an unpinned server. A wedged emulator must not make it
  // start driving the developer's phone — the same judgement `--devices all` makes.
  const attached = [
    { serial: 'emulator-5556', state: 'device', platform: 'android' as const, kind: 'emulator' as const },
    { serial: 'R58R42SGVNR', state: 'device', platform: 'android' as const, kind: 'physical' as const },
  ];
  assert.deepEqual(
    failoverCandidates(attached, { exclude: [] }).map((d) => d.serial),
    ['emulator-5556'],
  );
  // …but it IS reachable when nothing virtual remains, and when the operator named it.
  assert.deepEqual(
    failoverCandidates(attached, { exclude: ['emulator-5556'] }).map((d) => d.serial),
    ['R58R42SGVNR'],
  );
  assert.deepEqual(
    failoverCandidates(attached, { exclude: [], allow: ['R58R42SGVNR'] }).map((d) => d.serial),
    ['R58R42SGVNR'],
  );
});
