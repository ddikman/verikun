import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveEmulatorBinary, parseAvdList, parseEmuAvdName } from '../src/drivers/adb';
import { CliError } from '../src/errors';

// --- resolveEmulatorBinary --------------------------------------------------
//
// Guards the precedence chain, which is the thing most likely to silently regress
// on someone else's machine: the SDK installer does NOT put `emulator` on PATH,
// and ANDROID_HOME is routinely unset (it is on this repo's dev machine), so the
// conventional-root fallback is a load-bearing step, not a courtesy.

const HOME = '/Users/dev';
/** Build an `exists` predicate that only knows about the given paths. */
const only = (...paths: string[]) => (p: string) => paths.includes(p);
const nothing = () => false;

test('resolveEmulatorBinary: VERIKUN_EMULATOR wins over everything else', () => {
  const got = resolveEmulatorBinary({
    env: { VERIKUN_EMULATOR: '/custom/emulator', ANDROID_HOME: '/sdk' },
    exists: only('/custom/emulator', 'emulator', '/sdk/emulator/emulator'),
    platform: 'darwin',
    home: HOME,
  });
  assert.equal(got, '/custom/emulator');
});

test('resolveEmulatorBinary: a broken VERIKUN_EMULATOR throws instead of falling through', () => {
  assert.throws(
    () =>
      resolveEmulatorBinary({
        env: { VERIKUN_EMULATOR: '/gone/emulator', ANDROID_HOME: '/sdk' },
        exists: only('emulator', '/sdk/emulator/emulator'),
        platform: 'darwin',
        home: HOME,
      }),
    (e: unknown) => e instanceof CliError && e.exitCode === 3 && /VERIKUN_EMULATOR/.test(e.message),
  );
});

test('resolveEmulatorBinary: PATH beats $ANDROID_HOME', () => {
  const got = resolveEmulatorBinary({
    env: { ANDROID_HOME: '/sdk' },
    exists: only('emulator', '/sdk/emulator/emulator'),
    platform: 'darwin',
    home: HOME,
  });
  assert.equal(got, 'emulator');
});

test('resolveEmulatorBinary: $ANDROID_HOME beats $ANDROID_SDK_ROOT', () => {
  const got = resolveEmulatorBinary({
    env: { ANDROID_HOME: '/home-sdk', ANDROID_SDK_ROOT: '/root-sdk' },
    exists: only('/home-sdk/emulator/emulator', '/root-sdk/emulator/emulator'),
    platform: 'darwin',
    home: HOME,
  });
  assert.equal(got, '/home-sdk/emulator/emulator');
});

test('resolveEmulatorBinary: falls back to the emulator dir beside an absolute $ADB', () => {
  // join() normalizes the `..` away, so the candidate probed (and returned) is the
  // clean sibling path — an SDK layout of platform-tools/adb + emulator/emulator.
  const got = resolveEmulatorBinary({
    env: { ADB: '/opt/android/platform-tools/adb' },
    exists: only('/opt/android/emulator/emulator'),
    platform: 'linux',
    home: HOME,
  });
  assert.equal(got, '/opt/android/emulator/emulator');
});

test('resolveEmulatorBinary: a bare $ADB (on PATH) contributes no sibling candidate', () => {
  const got = resolveEmulatorBinary({
    env: { ADB: 'adb' },
    exists: nothing,
    platform: 'linux',
    home: HOME,
  });
  assert.equal(got, null);
});

test('resolveEmulatorBinary: darwin reaches ~/Library/Android/sdk with no env set at all', () => {
  const got = resolveEmulatorBinary({
    env: {},
    exists: only(`${HOME}/Library/Android/sdk/emulator/emulator`),
    platform: 'darwin',
    home: HOME,
  });
  assert.equal(got, `${HOME}/Library/Android/sdk/emulator/emulator`);
});

test('resolveEmulatorBinary: linux reaches ~/Android/Sdk', () => {
  const got = resolveEmulatorBinary({
    env: {},
    exists: only(`${HOME}/Android/Sdk/emulator/emulator`),
    platform: 'linux',
    home: HOME,
  });
  assert.equal(got, `${HOME}/Android/Sdk/emulator/emulator`);
});

test('resolveEmulatorBinary: win32 looks for emulator.exe under %LOCALAPPDATA%', () => {
  const got = resolveEmulatorBinary({
    env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    exists: (p) => p.endsWith('emulator.exe'),
    platform: 'win32',
    home: 'C:\\Users\\dev',
  });
  assert.ok(got?.endsWith('emulator.exe'), `expected an .exe, got ${got}`);
});

test('resolveEmulatorBinary: nothing found returns null (callers decide how loud to be)', () => {
  assert.equal(
    resolveEmulatorBinary({ env: {}, exists: nothing, platform: 'darwin', home: HOME }),
    null,
  );
});

// --- parseAvdList -----------------------------------------------------------

test('parseAvdList: keeps AVD names and drops interleaved tool chatter', () => {
  const out = [
    'INFO    | Storing crashdata in: /tmp/avd/emu-crash.db',
    'Pixel_6_API_34',
    'Warning: Quick Boot is not supported',
    'Nexus_5X_API_29',
    '',
  ].join('\n');
  assert.deepEqual(parseAvdList(out), ['Pixel_6_API_34', 'Nexus_5X_API_29']);
});

test('parseAvdList: empty output means no AVDs', () => {
  assert.deepEqual(parseAvdList(''), []);
  assert.deepEqual(parseAvdList('\n  \n'), []);
});

// --- parseEmuAvdName --------------------------------------------------------

test('parseEmuAvdName: takes the name, not the trailing OK status line', () => {
  assert.equal(parseEmuAvdName('Pixel_6_API_34\nOK\n'), 'Pixel_6_API_34');
});

test('parseEmuAvdName: an error response yields no name', () => {
  assert.equal(parseEmuAvdName('KO: unknown command\n'), '');
  assert.equal(parseEmuAvdName(''), '');
});
