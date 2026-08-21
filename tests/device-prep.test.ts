import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors';
import { looksLikeSystemUi, parseLockKind } from '../src/drivers/adb';
import { makeEl } from './helpers';
import { SETTINGS } from '../src/device/settings';
import {
  PREP_SCREEN_TIMEOUT,
  assertPreppable,
  clearPrep,
  isPrepared,
  mergeOriginals,
  newPrepRecord,
  prepDir,
  prepKnobs,
  readPrep,
  writePrep,
} from '../src/device/prep';

// `vk device prep` is the sticky half of device state: it changes settings that OUTLIVE the
// run, on a phone that might be someone's personal one. The two properties that have to hold
// are therefore "it can always be undone" (the snapshot round-trip) and "it never lands
// somewhere it wasn't invited" (the gate). Both are pure, so they live here.

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'vk-prep-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- the knob set ----------------------------------------------------------

const BOTH_SETS = [prepKnobs(true), prepKnobs(false)];

test('every prep knob is a real settings-table key with a value that table accepts', () => {
  // Prep is not allowed its own private vocabulary: each knob must be a row in
  // device/settings.ts, or it would bypass `device caps`, the per-platform gaps and the
  // readback verification that makes a write trustworthy.
  for (const knob of BOTH_SETS.flat()) {
    const spec = SETTINGS[knob.key];
    assert.ok(spec, `prep knob '${knob.key}' is not in the settings table`);
    assert.doesNotThrow(() => spec.parse(knob.value), `prep knob '${knob.key}=${knob.value}' does not parse`);
  }
});

test('every prep knob says which failure it prevents', () => {
  // The list stays short only if each entry has to earn its place. "Sensible default for a
  // phone" is not a reason; "a dump returns a stale screen" is.
  for (const knob of BOTH_SETS.flat()) {
    assert.ok(knob.why && knob.why.length > 10, `prep knob '${knob.key}' does not say why it is in the set`);
  }
});

test('prep knobs are unique within a set', () => {
  for (const set of BOTH_SETS) {
    const keys = set.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length, 'a knob is listed twice');
  }
});

test('both display policies cover the SAME keys', () => {
  // `--revert` restores whatever `original` holds, and `original` is snapshotted per applied
  // knob. If one policy touched a key the other did not, a device prepped one way and then the
  // other would leave that key changed with nothing recording its pre-prep value.
  const keys = BOTH_SETS.map((set) => set.map((k) => k.key).sort().join(','));
  assert.equal(keys[0], keys[1], 'the two prep knob sets do not cover the same keys');
});

test('the default policy turns stay-awake OFF, so the display timeout is not inert', () => {
  // The bug this exists to stop coming back: `stay-awake=on` is `stay_on_while_plugged_in`,
  // which keeps the screen up while CHARGING — and a device on USB adb always is. Leave it on
  // and `screen-timeout` never fires, which is how prep came to mean "never sleeps" (#101).
  const sleepy = prepKnobs(true);
  assert.equal(sleepy.find((k) => k.key === 'stay-awake')?.value, 'off');
  assert.equal(prepKnobs(false).find((k) => k.key === 'stay-awake')?.value, 'on');
});

test('the default display timeout outlasts the stock one, and --no-sleep-when-idle never sleeps', () => {
  // It has to span the gap between two commands of one flow (an agent's turn), which the
  // stock 15-30s does not. `max` is the opt-out, and is what prep used to do unconditionally.
  const ms = Number(SETTINGS['screen-timeout'].parse(PREP_SCREEN_TIMEOUT));
  assert.ok(ms > 30_000, `prep's display timeout (${ms}ms) is no better than the stock default`);
  assert.equal(prepKnobs(true).find((k) => k.key === 'screen-timeout')?.value, PREP_SCREEN_TIMEOUT);
  assert.equal(prepKnobs(false).find((k) => k.key === 'screen-timeout')?.value, 'max');
});

// --- the store -------------------------------------------------------------

test('a prep record round-trips, and reverting forgets it', () =>
  withHome((home) => {
    assert.equal(isPrepared('SERIAL1', { home }), false);
    const rec = newPrepRecord('SERIAL1', 'android', { animations: 'on', dnd: 'off' }, true, { home });
    writePrep(rec, { home });

    const read = readPrep('SERIAL1', { home });
    assert.deepEqual(read?.original, { animations: 'on', dnd: 'off' });
    assert.equal(read?.sleepWhenIdle, true);
    assert.equal(isPrepared('SERIAL1', { home }), true);

    clearPrep('SERIAL1', { home });
    assert.equal(readPrep('SERIAL1', { home }), null);
  }));

test('two serials that sanitize alike get separate records', () =>
  withHome((home) => {
    // The filename is sanitized, so `192.168.1.5:5555` and `192.168.1.5_5555` would collide
    // onto one file without the hash suffix — and one wireless device would then restore the
    // other's settings. Same guard as the claim store, which is why they share the stem.
    writePrep(newPrepRecord('192.168.1.5:5555', 'android', { dark: 'off' }, true, { home }), { home });
    writePrep(newPrepRecord('192.168.1.5_5555', 'android', { dark: 'on' }, true, { home }), { home });
    assert.equal(readPrep('192.168.1.5:5555', { home })?.original.dark, 'off');
    assert.equal(readPrep('192.168.1.5_5555', { home })?.original.dark, 'on');
  }));

test('an unreadable or non-prep file reads as NOT prepared', () =>
  withHome((home) => {
    // Same tolerant posture as readClaim and the plan cache: a poisoned file must not be able
    // to make a device permanently un-preppable. It reads as "never prepped", which is
    // recoverable by prepping again — the direction every tolerance in this repo leans.
    mkdirSync(prepDir({ home }), { recursive: true });
    writePrep(newPrepRecord('SERIAL2', 'android', { dark: 'off' }, true, { home }), { home });
    const path = join(prepDir({ home }), readdirSync(prepDir({ home }))[0]);

    writeFileSync(path, 'not json at all');
    assert.equal(readPrep('SERIAL2', { home }), null);

    writeFileSync(path, JSON.stringify({ hello: 'world' })); // parses, but is not a record
    assert.equal(readPrep('SERIAL2', { home }), null);
  }));

// --- earliest wins ---------------------------------------------------------

test('mergeOriginals keeps the FIRST value seen for a key', () => {
  // The bug this prevents: prep twice, and the second prep snapshots the value the FIRST prep
  // established. `--revert` would then restore the device to "prepped" — i.e. silently do
  // nothing at all. Same earliest-wins rule as RunState.deviceOverrides.
  const merged = mergeOriginals({ animations: 'on', dnd: 'off' }, { animations: 'off', doze: 'on' });
  assert.equal(merged.animations, 'on', 'the pre-prep value was overwritten');
  assert.equal(merged.dnd, 'off');
  assert.equal(merged.doze, 'on', 'a newly-seen key should still be recorded');
});

test('mergeOriginals ignores undefined without creating the key', () => {
  const merged = mergeOriginals({}, { dark: undefined });
  assert.equal('dark' in merged, false);
});

// --- the explicitness gate -------------------------------------------------

test('a physical device must be named; an emulator or simulator need not be', () => {
  const boom = (e: unknown) => e instanceof CliError && e.exitCode === 2;
  assert.throws(() => assertPreppable('physical', 'ABC123', false, 5), boom);
  assert.doesNotThrow(() => assertPreppable('physical', 'ABC123', true, 5)); // named with --device
  assert.doesNotThrow(() => assertPreppable('emulator', 'emulator-5554', false, 5));
  assert.doesNotThrow(() => assertPreppable('simulator', 'UDID', false, 5));
});

test('the gate names the exact command that would be allowed', () => {
  // A refusal an agent cannot act on is a dead end. The message has to carry the fix.
  try {
    assertPreppable('physical', 'ABC123', false, 5);
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /--device ABC123/);
  }
});

test('with nothing to write there is nothing to gate', () => {
  // This is what makes `vk device prep` on iOS report honestly instead of refusing for no
  // reason: every knob there is a no-op or unsupported, so no setting would be touched.
  assert.doesNotThrow(() => assertPreppable('physical', 'ABC123', false, 0));
});

// --- the screen-lock probe -------------------------------------------------

test('parseLockKind reads CredentialType across both observed casings', () => {
  // Measured: API 32 prints `Pin`, API 35 prints `PIN`. A case-sensitive match would report
  // one of two real devices as unlocked.
  assert.equal(parseLockKind('  User 0\n    Quality: 196608\n    CredentialType: Pin\n'), 'pin');
  assert.equal(parseLockKind('  User 0\n    Quality: 0\n    CredentialType: PIN\n'), 'pin');
  assert.equal(parseLockKind('CredentialType: None'), 'none');
  assert.equal(parseLockKind('CredentialType: Pattern'), 'pattern');
  assert.equal(parseLockKind('CredentialType: Password'), 'password');
});

test('parseLockKind: API 29 omits CredentialType entirely and must read as unknown', () => {
  // Verbatim from a Motorola on API 29 — no CredentialType line exists at that level. Reading
  // `SID` as a substitute would be a guess (only the credential-PRESENT case was ever
  // observed), and guessing `none` here is the one answer that could let a locked phone
  // through. The read-time guard uses `dumpsys trust` instead, which does work on API 29.
  const api29 = 'Current lock settings service state:\nSP Enabled = false\n    User 0\n' +
    '        SP Handle = 46820d46306cd90d\n        SID = 1fc43bc3354180e9\n';
  assert.equal(parseLockKind(api29), 'unknown');
});

test('parseLockKind never invents `none` from a read it did not understand', () => {
  // The asymmetry that matters: `none` is what licenses verikun to walk past a keyguard, so
  // a failed or unrecognized read has to withhold that permission, not grant it.
  assert.equal(parseLockKind(''), 'unknown');
  assert.equal(parseLockKind('Can\'t find service: lock_settings'), 'unknown');
  assert.equal(parseLockKind('CredentialType: SomethingNew'), 'unknown');
});

test('parseLockKind ignores Quality, which disagrees with itself across releases', () => {
  // Quality read 196608 on API 32 and 0 on API 35 for two devices that BOTH had a PIN. A
  // parser that fell back to it would call the API 35 phone unlocked.
  assert.equal(parseLockKind('Quality: 0\nCredentialType: PIN'), 'pin');
  assert.equal(parseLockKind('Quality: 196608\n'), 'unknown');
});

// --- the keyguard discriminator --------------------------------------------

const ids = (...v: string[]) => v.map((id) => makeEl({ id }));

test('looksLikeSystemUi: a bare lock screen is all SystemUI', () => {
  assert.equal(
    looksLikeSystemUi(ids('com.android.systemui:id/backdrop', 'com.android.systemui:id/scrim_behind')),
    true,
  );
});

test('looksLikeSystemUi: `android:` framework ids do NOT disqualify a lock screen', () => {
  // The regression this pins. A lock screen carrying a notification inflates FRAMEWORK
  // layouts inside SystemUI's rows, so treating `android:` as "this is an app" made the check
  // pass on a bare keyguard and fail the moment a notification appeared on it — measured on a
  // locked Pixel 3a (API 32), where it let a full lock-screen hierarchy through as a success.
  assert.equal(
    looksLikeSystemUi(
      ids(
        'com.android.systemui:id/backdrop',
        'android:id/status_bar_latest_event_content',
        'android:id/icon',
      ),
    ),
    true,
  );
});

test('looksLikeSystemUi: one app id is proof we are looking at the app', () => {
  assert.equal(
    looksLikeSystemUi(ids('com.android.systemui:id/status_bar_container', 'com.example.app:id/login')),
    false,
  );
});

test('looksLikeSystemUi: no SystemUI id at all is not a keyguard', () => {
  // A Flutter app has no package-qualified ids beyond the framework's own content root, so
  // this must not read as "all system" merely because nothing contradicted it.
  assert.equal(looksLikeSystemUi(ids('android:id/content')), false);
  assert.equal(looksLikeSystemUi([]), false);
  assert.equal(looksLikeSystemUi(ids('', '')), false);
});

test('looksLikeSystemUi: unqualified ids are skipped, not counted', () => {
  // Flutter semantics identifiers (`vk_device`) carry no package prefix and say nothing
  // either way — they must not be mistaken for an app id and suppress the check.
  assert.equal(looksLikeSystemUi(ids('com.android.systemui:id/backdrop', 'vk_device')), true);
});
