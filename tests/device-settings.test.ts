import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CliError, UnsupportedOnPlatformError } from '../src/errors';
import {
  SETTINGS,
  SETTING_KEYS,
  SettingKey,
  canonicalFontScale,
  checkMinApi,
  checkSupport,
  contentSizeToFontScale,
  downloadLimitFromSetting,
  fontScaleToContentSize,
  isSettingKey,
  parseDeviceAssignments,
  rotationToUserRotation,
  userRotationToRotation,
} from '../src/device/settings';

// The capability table is the single source of truth behind `vk device set`: it gates
// argument validation, the driver switch, `device caps`, and the `vk ai` plan validator.
// Everything in it is pure, so this is where the real coverage for the feature lives —
// the drivers themselves are device-verified only.

const isCli2 = (e: unknown) => e instanceof CliError && e.exitCode === 2;

// --- parseDeviceAssignments -----------------------------------------------

test('parseDeviceAssignments: a single assignment', () => {
  assert.deepEqual(parseDeviceAssignments(['dark=on']), [{ key: 'dark', value: 'on' }]);
});

test('parseDeviceAssignments: several settings in one call', () => {
  assert.deepEqual(parseDeviceAssignments(['dark=on', 'font-scale=1.3', 'rotation=landscape']), [
    { key: 'dark', value: 'on' },
    { key: 'font-scale', value: '1.3' },
    { key: 'rotation', value: 'landscape' },
  ]);
});

test('parseDeviceAssignments: keys and boolean-ish values are canonicalized', () => {
  // The `vk ai` compiler model and a human shell user reach for different spellings;
  // both must land on the same canonical value, or a snapshot won't compare equal.
  assert.deepEqual(parseDeviceAssignments(['DARK=TRUE']), [{ key: 'dark', value: 'on' }]);
  assert.deepEqual(parseDeviceAssignments(['dark=yes']), [{ key: 'dark', value: 'on' }]);
  assert.deepEqual(parseDeviceAssignments(['dark=0']), [{ key: 'dark', value: 'off' }]);
  assert.deepEqual(parseDeviceAssignments(['airplane=disable']), [{ key: 'airplane', value: 'off' }]);
});

test('parseDeviceAssignments: no assignments is a usage error naming the keys', () => {
  assert.throws(() => parseDeviceAssignments([]), (e: unknown) => {
    return isCli2(e) && (e as CliError).message.includes('font-scale');
  });
});

test('parseDeviceAssignments: a bare key without = is rejected', () => {
  for (const bad of ['dark', '=on', 'dark on']) {
    assert.throws(() => parseDeviceAssignments([bad]), isCli2, `expected '${bad}' to be a usage error`);
  }
});

test('parseDeviceAssignments: an unknown key lists the valid ones', () => {
  assert.throws(() => parseDeviceAssignments(['bogus=1']), (e: unknown) => {
    return isCli2(e) && (e as CliError).message.includes('airplane');
  });
});

test('parseDeviceAssignments: a bad value is rejected per-key', () => {
  assert.throws(() => parseDeviceAssignments(['dark=maybe']), isCli2);
  assert.throws(() => parseDeviceAssignments(['rotation=sideways']), isCli2);
  assert.throws(() => parseDeviceAssignments(['font-scale=huge']), isCli2);
});

test('parseDeviceAssignments: the same key twice is rejected', () => {
  // Last-wins would silently snapshot the intermediate value as the "original".
  assert.throws(() => parseDeviceAssignments(['dark=on', 'dark=off']), isCli2);
});

// --- value domains --------------------------------------------------------

test('font-scale: out-of-range values are refused, not clamped', () => {
  // A stray font-scale=100 would leave the device barely usable through its own UI,
  // so it is far likelier to be a typo than an intent.
  for (const bad of ['0.1', '10', '100', '-1']) {
    assert.throws(() => parseDeviceAssignments([`font-scale=${bad}`]), isCli2, `expected ${bad} rejected`);
  }
});

test("font-scale: 'default' and trailing zeros canonicalize", () => {
  assert.deepEqual(parseDeviceAssignments(['font-scale=default']), [{ key: 'font-scale', value: '1' }]);
  assert.deepEqual(parseDeviceAssignments(['font-scale=1.30']), [{ key: 'font-scale', value: '1.3' }]);
});

test('font-scale: every spelling of the same number canonicalizes identically', () => {
  // Load-bearing: the driver writes a value and then VERIFIES it by string-comparing
  // the readback. If 'default', '1.0' and the driver's own default disagreed on the
  // spelling, a perfectly good write would be reported as refused (exit 3).
  const spellings = ['default', '1', '1.0', '1.00'];
  const values = spellings.map((s) => parseDeviceAssignments([`font-scale=${s}`])[0].value);
  assert.deepEqual(new Set(values), new Set([canonicalFontScale(1.0)]));
});

test('rotation: a bare integer is rejected in favour of a name', () => {
  // `rotation=2` tells a report reader nothing, and the integer mapping is Android's.
  for (const bad of ['0', '1', '2', '3', '90', '270']) {
    assert.throws(() => parseDeviceAssignments([`rotation=${bad}`]), isCli2, `expected ${bad} rejected`);
  }
});

test('rotation: auto is a real value so a snapshot can restore auto-rotate', () => {
  assert.deepEqual(parseDeviceAssignments(['rotation=auto']), [{ key: 'rotation', value: 'auto' }]);
});

test('rotationToUserRotation: names map to Android user_rotation, auto has none', () => {
  assert.equal(rotationToUserRotation('portrait'), 0);
  assert.equal(rotationToUserRotation('landscape'), 1);
  assert.equal(rotationToUserRotation('portrait-reverse'), 2);
  assert.equal(rotationToUserRotation('landscape-reverse'), 3);
  assert.throws(() => rotationToUserRotation('auto'), isCli2);
});

test('userRotationToRotation: inverse for readback, unknown -> null', () => {
  for (const name of ['portrait', 'landscape', 'portrait-reverse', 'landscape-reverse']) {
    assert.equal(userRotationToRotation(String(rotationToUserRotation(name))), name);
  }
  assert.equal(userRotationToRotation('9'), null);
});

// --- font scale <-> iOS Dynamic Type --------------------------------------

test('fontScaleToContentSize: 1.0 is large, the default on BOTH platforms', () => {
  // The pivot that makes the two domains line up — if this drifts, an unchanged
  // font-scale would silently resize the simulator.
  assert.equal(fontScaleToContentSize(1.0), 'large');
});

test('fontScaleToContentSize: picks the nearest category', () => {
  assert.equal(fontScaleToContentSize(1.24), 'extra-extra-large');
  assert.equal(fontScaleToContentSize(0.82), 'extra-small');
  assert.match(fontScaleToContentSize(2.0), /^accessibility-/);
});

test('fontScaleToContentSize: clamps at both ends rather than throwing', () => {
  // parse() already range-checked, so an extreme here just means the end of the scale.
  assert.equal(fontScaleToContentSize(0.01), 'extra-small');
  assert.equal(fontScaleToContentSize(99), 'accessibility-extra-extra-extra-large');
});

test('contentSizeToFontScale: round-trips every category', () => {
  for (const scale of [0.82, 0.88, 0.94, 1.0, 1.12, 1.24, 1.35, 1.65, 1.94, 2.35, 2.76, 3.12]) {
    assert.equal(contentSizeToFontScale(fontScaleToContentSize(scale)), scale);
  }
});

test("contentSizeToFontScale: simctl's 'unknown'/'unsupported' answers are null", () => {
  assert.equal(contentSizeToFontScale('unknown'), null);
  assert.equal(contentSizeToFontScale('unsupported'), null);
  assert.equal(contentSizeToFontScale(''), null);
});

// --- the support matrix ---------------------------------------------------

test('isSettingKey: only the table keys', () => {
  for (const k of SETTING_KEYS) assert.equal(isSettingKey(k), true);
  assert.equal(isSettingKey('wifi'), false);
  assert.equal(isSettingKey(''), false);
});

test('support matrix: the verified per-platform truth', () => {
  // Probed on a Samsung SM-A415F (Android 12) and a booted iPhone 17 Pro sim (iOS 26.5);
  // the prep knobs additionally on a Pixel 3a (API 32) and a Redmi 25028RN03Y (API 35).
  assert.equal(SETTINGS.airplane.support.ios, 'unsupported'); // a simulator has no radio
  assert.equal(SETTINGS.rotation.support.ios, 'unsupported'); // neither simctl nor idb rotates
  assert.equal(SETTINGS.animations.support.ios, 'unsupported'); // nothing disables UIKit animation
  assert.equal(SETTINGS.dnd.support.ios, 'unsupported'); // Focus is not scriptable
  assert.equal(SETTINGS['stay-awake'].support.ios, 'noop'); // simulators never sleep
  assert.equal(SETTINGS['screen-timeout'].support.ios, 'noop'); // ditto
  assert.equal(SETTINGS.doze.support.ios, 'noop'); // no Doze equivalent
  assert.equal(SETTINGS.dark.support.ios, 'supported'); // simctl ui appearance
  assert.equal(SETTINGS['font-scale'].support.ios, 'supported'); // simctl ui content_size
  assert.equal(SETTINGS['download-limit'].support.ios, 'unsupported'); // nothing shapes a simulator's network
  for (const k of SETTING_KEYS) assert.equal(SETTINGS[k].support.android, 'supported');
});

// --- download-limit ----------------------------------------------------------

test('download-limit: rates canonicalize to the bytes-per-second string the device stores', () => {
  // kbps/mbps are BITS per second, as network speeds are quoted; the device stores bytes.
  const parse = SETTINGS['download-limit'].parse;
  assert.equal(parse('256kbps'), '32000');
  assert.equal(parse('2mbps'), '250000');
  assert.equal(parse('1.5mbps'), '187500');
  assert.equal(parse(' 2MBPS '), '250000');
  assert.equal(parse('125000'), '125000'); // a bare number is bytes/s — what `device get` returns
  assert.equal(parse('8kbps'), '1000'); // the floor itself is allowed
});

test("download-limit: 'off' and its aliases mean no limit", () => {
  const parse = SETTINGS['download-limit'].parse;
  for (const raw of ['off', 'OFF', 'none', 'unlimited', 'default']) assert.equal(parse(raw), 'off', raw);
});

test('download-limit: a bare number below the floor names the kilobit spelling', () => {
  // `256` meant as 256kbps would otherwise cap the device at 2 kbit/s.
  assert.throws(
    () => SETTINGS['download-limit'].parse('256'),
    (e: unknown) => isCli2(e) && (e as CliError).message.includes('256kbps'),
  );
  assert.throws(() => SETTINGS['download-limit'].parse('7kbps'), isCli2);
});

test('download-limit: out-of-range and malformed values are usage errors', () => {
  const parse = SETTINGS['download-limit'].parse;
  assert.equal(parse('2147483647'), '2147483647'); // the kernel's signed 32-bit ceiling
  for (const bad of ['2147483648', '17180mbps', '0', '-1', '1e6', 'fast', '2 mbps', '2MB/s', '100kB', '']) {
    assert.throws(() => parse(bad), isCli2, `expected '${bad}' rejected`);
  }
});

test('download-limit: a parsed value re-parses to itself and survives the readback', () => {
  // The two properties restore depends on: parse is idempotent, and the driver's readback of a
  // written value compares equal to it (or every good write would be reported as refused).
  const parse = SETTINGS['download-limit'].parse;
  for (const raw of ['256kbps', '2mbps', '1.5mbps', '125000', 'off']) {
    assert.equal(parse(parse(raw)), parse(raw), `${raw} does not round-trip through parse`);
    assert.equal(downloadLimitFromSetting(parse(raw) === 'off' ? null : parse(raw)), parse(raw), `${raw} does not survive readback`);
  }
});

test('downloadLimitFromSetting: unset and negatives are off, garbage is unknown', () => {
  assert.equal(downloadLimitFromSetting(null), 'off'); // never set — and every pre-13 device
  assert.equal(downloadLimitFromSetting(''), 'off');
  assert.equal(downloadLimitFromSetting('null'), 'off');
  assert.equal(downloadLimitFromSetting('-1'), 'off'); // what "No limit" in Developer options writes
  assert.equal(downloadLimitFromSetting('-5'), 'off');
  assert.equal(downloadLimitFromSetting(' 125000\n'), '125000');
  // 0 is a real limit on Android (it limits any value >= 0), so it restores as itself.
  assert.equal(downloadLimitFromSetting('0'), '0');
  assert.equal(downloadLimitFromSetting('abc'), null);
  assert.equal(downloadLimitFromSetting('1.5'), null);
});

// --- checkMinApi (the device half of the fail-early gate) --------------------

test('checkMinApi: download-limit below Android 13 is unsupported, exit 3, naming the way out', () => {
  assert.throws(
    () => checkMinApi('download-limit', 'android', 32),
    (e: unknown) =>
      // UnsupportedOnPlatformError, not a bare exit 3: a `vk server` must not strike the phone for it.
      e instanceof UnsupportedOnPlatformError &&
      e.exitCode === 3 &&
      /Android 13 \(API 33\)/.test(e.message) &&
      /API 32/.test(e.message) &&
      /router or hotspot/.test(e.message),
  );
});

test('checkMinApi: Android 13 and newer, an unknown level, iOS and floorless keys all pass', () => {
  checkMinApi('download-limit', 'android', 33);
  checkMinApi('download-limit', 'android', 37);
  // The device would not say: the write's own verification decides, never a failed probe.
  checkMinApi('download-limit', 'android', null);
  checkMinApi('download-limit', 'ios', 10); // iOS is refused by checkSupport, not here
  for (const k of SETTING_KEYS.filter((k) => !SETTINGS[k].minAndroid)) checkMinApi(k, 'android', 21);
});

// --- screen-timeout --------------------------------------------------------

test('screen-timeout: durations canonicalize to the millisecond string the device stores', () => {
  // Canonical form is ms, NOT the pretty duration: the readback is ms, and a snapshot has to
  // round-trip through setDeviceSetting unchanged or restore compares unequal and "fails".
  const parse = SETTINGS['screen-timeout'].parse;
  assert.equal(parse('30s'), '30000');
  assert.equal(parse('10m'), '600000');
  assert.equal(parse('1800000'), '1800000'); // a bare number is ms — what `device get` returns
  assert.equal(parse('5000ms'), '5000'); // an explicit ms unit is accepted too
  assert.equal(parse('max'), '2147483647'); // Android's signed-32-bit ceiling
  assert.equal(parse('never'), parse('max'));
});

test('screen-timeout: a value that would blank the screen mid-tap is refused', () => {
  const parse = SETTINGS['screen-timeout'].parse;
  assert.throws(() => parse('10'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  assert.throws(() => parse('0'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  assert.throws(() => parse('9999999999'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  assert.throws(() => parse('soon'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

test('screen-timeout: a parsed value re-parses to itself', () => {
  // The property restore depends on. `parse(parse(x)) === parse(x)` for every accepted form.
  const parse = SETTINGS['screen-timeout'].parse;
  for (const raw of ['30s', '10m', 'max', '1800000']) {
    assert.equal(parse(parse(raw)), parse(raw), `${raw} does not round-trip`);
  }
});

test('support matrix: every gap is self-documenting', () => {
  // The rule that keeps a future setting from being added as a silent dead end:
  // refusing without saying what to do instead is the failure this guards.
  for (const key of SETTING_KEYS) {
    const spec = SETTINGS[key];
    for (const platform of ['android', 'ios'] as const) {
      if (spec.support[platform] === 'unsupported') {
        assert.ok(spec.manual[platform], `${key}/${platform} is unsupported but names no manual equivalent`);
      }
      if (spec.support[platform] === 'noop') {
        assert.ok(spec.note[platform], `${key}/${platform} is a no-op but does not say why`);
      }
    }
  }
});

test('support matrix: every spec parses its own advertised values', () => {
  // `values` is printed by `device caps` and quoted in usage errors, so a drift
  // between the blurb and the parser would send users down a dead end.
  for (const key of SETTING_KEYS) {
    const spec = SETTINGS[key];
    assert.ok(spec.values.length > 0, `${key} advertises no values`);
    assert.equal(spec.key, key, `${key} disagrees with its own key field`);
  }
});

// --- checkSupport (the fail-early gate) -----------------------------------

test('checkSupport: an unsupported key exits 3 and names the manual equivalent', () => {
  assert.throws(
    () => checkSupport('rotation', 'ios'),
    (e: unknown) =>
      e instanceof CliError && e.exitCode === 3 && /Simulator window|Cmd\+Left/.test(e.message),
  );
});

test('checkSupport: supported and no-op keys pass, reporting which they are', () => {
  assert.equal(checkSupport('dark', 'ios'), 'supported');
  assert.equal(checkSupport('stay-awake', 'ios'), 'noop');
  for (const k of SETTING_KEYS) assert.equal(checkSupport(k as SettingKey, 'android'), 'supported');
});
