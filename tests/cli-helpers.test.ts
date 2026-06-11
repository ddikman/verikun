import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseDuration,
  waitWindowMs,
  parsePoint,
  evalAssert,
  tokenizeLine,
  withBatchGlobals,
  healNote,
  waitNote,
  chooseLogOpts,
} from '../src/cli';
import { parseSelector } from '../src/ui/selector';
import { CliError } from '../src/errors';
import { makeEl } from './helpers';

// --- parseDuration --------------------------------------------------------

test('parseDuration: a bare number is milliseconds; s/ms suffixes scale', () => {
  assert.equal(parseDuration('5000', 'wait'), 5000);
  assert.equal(parseDuration('5s', 'wait'), 5000);
  assert.equal(parseDuration('800ms', 'wait'), 800);
  assert.equal(parseDuration('1.5s', 'wait'), 1500);
  assert.equal(parseDuration('0', 'wait'), 0);
  assert.equal(parseDuration(' 250 ', 'wait'), 250); // trimmed
});

test('parseDuration: garbage and negatives throw CliError(2)', () => {
  for (const bad of ['abc', '-5', '5sec', '']) {
    assert.throws(() => parseDuration(bad, 'wait'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  }
});

// --- waitWindowMs ---------------------------------------------------------

test('waitWindowMs: defaults to 5s when no wait flags are present', () => {
  assert.equal(waitWindowMs({}), 5000);
});

test('waitWindowMs: --no-wait and --wait 0 disable waiting', () => {
  assert.equal(waitWindowMs({ 'no-wait': true }), 0);
  assert.equal(waitWindowMs({ wait: '0' }), 0);
});

test('waitWindowMs: an explicit --wait duration overrides the default', () => {
  assert.equal(waitWindowMs({ wait: '5s' }), 5000);
  assert.equal(waitWindowMs({ wait: '800ms' }), 800);
  assert.equal(waitWindowMs({ wait: '3000' }), 3000);
});

test('waitWindowMs: a bare --wait (boolean) keeps the default window', () => {
  assert.equal(waitWindowMs({ wait: true }), 5000);
});

// --- parsePoint -----------------------------------------------------------

test('parsePoint: parses "x,y", tolerates spaces, and allows negatives', () => {
  assert.deepEqual(parsePoint('10,20'), { x: 10, y: 20 });
  assert.deepEqual(parsePoint(' 10 , 20 '), { x: 10, y: 20 });
  assert.deepEqual(parsePoint('-5,-6'), { x: -5, y: -6 });
});

test('parsePoint: malformed coordinates throw CliError(2)', () => {
  for (const bad of ['x', '10,', '1,2,3', '']) {
    assert.throws(() => parsePoint(bad), (e: unknown) => e instanceof CliError && e.exitCode === 2);
  }
});

// --- evalAssert -----------------------------------------------------------

const greeting = makeEl({ idShort: 'greeting', id: 'com.app:id/greeting', text: 'Welcome Home' });

test('evalAssert: plain presence passes when the selector matches', () => {
  const r = evalAssert([greeting], parseSelector('@greeting'), {});
  assert.equal(r.pass, true);
  assert.match(r.reason, /found 1/);
});

test('evalAssert: a missing selector fails as "not found"', () => {
  const r = evalAssert([greeting], parseSelector('@missing'), {});
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'not found');
});

test('evalAssert: --gone passes only when the element is absent', () => {
  assert.equal(evalAssert([greeting], parseSelector('@missing'), { gone: true }).pass, true);
  const present = evalAssert([greeting], parseSelector('@greeting'), { gone: true });
  assert.equal(present.pass, false);
  assert.match(present.reason, /still present/);
});

test('evalAssert: --text requires an exact (case-insensitive) text match', () => {
  assert.equal(evalAssert([greeting], parseSelector('@greeting'), { text: 'Welcome Home' }).pass, true);
  const wrong = evalAssert([greeting], parseSelector('@greeting'), { text: 'Goodbye' });
  assert.equal(wrong.pass, false);
  assert.match(wrong.reason, /text !=/);
});

test('evalAssert: --text with --contains matches a substring', () => {
  assert.equal(evalAssert([greeting], parseSelector('@greeting'), { text: 'home', contains: true }).pass, true);
});

// --- tokenizeLine ---------------------------------------------------------

test('tokenizeLine: splits on whitespace', () => {
  assert.deepEqual(tokenizeLine('tap @login'), ['tap', '@login']);
  assert.deepEqual(tokenizeLine('a\tb'), ['a', 'b']);
});

test('tokenizeLine: double quotes group a value containing spaces', () => {
  assert.deepEqual(tokenizeLine('text @field "hello world"'), ['text', '@field', 'hello world']);
});

test('tokenizeLine: single quotes are literal (a double quote inside survives)', () => {
  assert.deepEqual(tokenizeLine(`text @f 'a"b'`), ['text', '@f', 'a"b']);
});

test('tokenizeLine: inside double quotes, \\" and \\\\ are escapes', () => {
  assert.deepEqual(tokenizeLine('"a\\"b"'), ['a"b']);
  assert.deepEqual(tokenizeLine('"a\\\\b"'), ['a\\b']);
});

test('tokenizeLine: a backslash outside quotes escapes the next character', () => {
  assert.deepEqual(tokenizeLine('a\\ b'), ['a b']);
});

test('tokenizeLine: empty quotes still produce an empty token', () => {
  assert.deepEqual(tokenizeLine('text @f ""'), ['text', '@f', '']);
});

test('tokenizeLine: an unterminated quote throws CliError(2)', () => {
  assert.throws(() => tokenizeLine('"abc'), (e: unknown) => e instanceof CliError && e.exitCode === 2);
});

// --- withBatchGlobals -----------------------------------------------------

test('withBatchGlobals: batch globals fill gaps; non-globals do not propagate', () => {
  const merged = withBatchGlobals({}, { device: 'X', json: true, wait: '5s' });
  assert.equal(merged.device, 'X');
  assert.equal(merged.json, true);
  assert.equal(merged.wait, undefined); // 'wait' is not a batch global
});

test('withBatchGlobals: a per-line flag overrides the batch global', () => {
  assert.equal(withBatchGlobals({ device: 'Y' }, { device: 'X' }).device, 'Y');
});

// --- healNote / waitNote --------------------------------------------------

test('healNote: empty for exact/none, annotated otherwise', () => {
  assert.equal(healNote(null), '');
  assert.equal(healNote('exact'), '');
  assert.equal(healNote('partial'), ' (healed: partial match)');
  assert.equal(healNote('normalized'), ' (healed: normalized match)');
});

test('waitNote: silent under 100ms, otherwise reports seconds to one decimal', () => {
  assert.equal(waitNote(0), '');
  assert.equal(waitNote(99), '');
  assert.equal(waitNote(100), ' (waited 0.1s)');
  assert.equal(waitNote(1234), ' (waited 1.2s)');
  assert.equal(waitNote(5000), ' (waited 5.0s)');
});

// --- chooseLogOpts --------------------------------------------------------

test('chooseLogOpts: with no flags and no run, falls back to the driver default (last-N)', () => {
  assert.deepEqual(chooseLogOpts({}, {}), { appId: undefined });
});

test('chooseLogOpts: in a run, defaults to the session window (since)', () => {
  assert.deepEqual(chooseLogOpts({}, { sessionSince: '06-11 12:00:00.000' }), {
    since: '06-11 12:00:00.000',
    appId: undefined,
  });
});

test('chooseLogOpts: an explicit -n/--lines overrides the session window', () => {
  assert.deepEqual(chooseLogOpts({ lines: '50' }, { sessionSince: '06-11 12:00:00.000' }), {
    lines: 50,
    appId: undefined,
  });
});

test('chooseLogOpts: --full overrides the session window with a large line count', () => {
  const r = chooseLogOpts({ full: true }, { sessionSince: '06-11 12:00:00.000' });
  assert.equal(r.since, undefined);
  assert.ok(typeof r.lines === 'number' && r.lines > 1000);
});

test('chooseLogOpts: --since beats -n, --full, and the session window', () => {
  assert.deepEqual(
    chooseLogOpts({ since: '06-11 09:00:00.000', lines: '50', full: true }, { sessionSince: '06-11 12:00:00.000', appId: 'com.app' }),
    { since: '06-11 09:00:00.000', appId: 'com.app' },
  );
});

test('chooseLogOpts: the package positional is carried through as appId', () => {
  assert.deepEqual(chooseLogOpts({}, { appId: 'com.app' }), { appId: 'com.app' });
});
