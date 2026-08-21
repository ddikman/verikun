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
  confineToCwd,
  assertSafeAppId,
  stateFromFlags,
  terminalFailure,
  retryAfterDeviceMove,
  laneArgv,
  laneEnv,
  lastJsonObject,
  lanesFromFlags,
  laneResult,
} from '../src/cli';
import { resolve } from 'node:path';
import { parseSelector } from '../src/ui/selector';
import { CliError } from '../src/errors';
import { makeEl } from './helpers';

// --- confineToCwd (host-write path confinement) ---------------------------

test('confineToCwd: keeps --out inside cwd, rejects traversal/absolute escapes', () => {
  const cwd = resolve(process.cwd());
  assert.equal(confineToCwd('shot.png'), resolve(cwd, 'shot.png'));
  assert.equal(confineToCwd('sub/dir/shot.png'), resolve(cwd, 'sub/dir/shot.png'));
  for (const bad of ['../escape.png', '../../etc/x.png', '/etc/x.png']) {
    assert.throws(
      () => confineToCwd(bad),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  }
});

// --- assertSafeAppId (device-shell injection gate) ------------------------

test('assertSafeAppId: accepts real package/bundle ids, rejects shell metacharacters', () => {
  for (const ok of ['com.android.camera', 'com.rype.go', 'my-app_1.2']) {
    assert.equal(assertSafeAppId(ok), ok);
  }
  for (const bad of ['com.x; rm -rf /', 'a b', 'a|b', 'a$(x)', 'a`x`', 'a&&b', 'a\nb', '']) {
    assert.throws(
      () => assertSafeAppId(bad),
      (e: unknown) => e instanceof CliError && e.exitCode === 2,
    );
  }
});

// --- parseDuration --------------------------------------------------------

test('parseDuration: a bare number is milliseconds; s/ms/m suffixes scale', () => {
  assert.equal(parseDuration('5000', 'wait'), 5000);
  assert.equal(parseDuration('5s', 'wait'), 5000);
  assert.equal(parseDuration('800ms', 'wait'), 800);
  assert.equal(parseDuration('1.5s', 'wait'), 1500);
  assert.equal(parseDuration('15m', 'wait'), 900000); // minutes
  assert.equal(parseDuration('2m', 'wait'), 120000);
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

test('evalAssert: --text matches content-desc too (Flutter puts everything there)', () => {
  // Same class of bug as the structuralHash one: a text-only comparison is blind on any
  // app that maps its labels to contentDescription. The SELECTOR layer already falls back
  // to desc, so text-only here made `assert desc:X --text Y` contradict `text:Y`.
  const els = [makeEl({ idShort: 'title', text: '', desc: 'Welcome back' })];
  const sel = parseSelector('@title');
  assert.equal(evalAssert(els, sel, { text: 'Welcome back' }).pass, true);
  assert.equal(evalAssert(els, sel, { text: 'Welcome', contains: true }).pass, true);
  assert.equal(evalAssert(els, sel, { text: 'Goodbye' }).pass, false);
});

test('evalAssert: --text still matches plain text, and still reports what it saw', () => {
  const els = [makeEl({ idShort: 'title', text: 'Home', desc: '' })];
  const sel = parseSelector('@title');
  assert.equal(evalAssert(els, sel, { text: 'Home' }).pass, true);
  const miss = evalAssert(els, sel, { text: 'Away' });
  assert.equal(miss.pass, false);
  assert.match(miss.reason, /Home/); // the observed value is still in the failure message
});

// --- stateFromFlags (the tri-state trap) ----------------------------------
// These modifiers are tri-state: "must be" / "must not be" / "don't care". flagBool()
// returns FALSE for an absent flag, so passing it straight through — which is what the
// original --enabled wiring did — would silently mean "must be disabled, unselected,
// unchecked and unfocused" on every selector of every command.

test('stateFromFlags: an absent flag is undefined, never false', () => {
  const state = stateFromFlags({});
  assert.equal(state.enabled, undefined);
  assert.equal(state.selected, undefined);
  assert.equal(state.checked, undefined);
  assert.equal(state.focused, undefined);
});

test('stateFromFlags: --x is true and --not-x is false', () => {
  assert.equal(stateFromFlags({ selected: true }).selected, true);
  assert.equal(stateFromFlags({ 'not-selected': true }).selected, false);
  assert.equal(stateFromFlags({ checked: true }).checked, true);
  assert.equal(stateFromFlags({ 'not-focused': true }).focused, false);
});

test('stateFromFlags: reads the plan-emitted string form too', () => {
  // A `vk ai` leaf arrives as {"name":"selected","value":"true"} and bypasses argv
  // parsing entirely, so the string must mean the same as the boolean.
  assert.equal(stateFromFlags({ selected: 'true' }).selected, true);
});

test('stateFromFlags: a contradiction is a usage error, not a silent winner', () => {
  assert.throws(
    () => stateFromFlags({ selected: true, 'not-selected': true }),
    (e: unknown) => e instanceof CliError && e.exitCode === 2,
  );
});

// --- terminalFailure --------------------------------------------------------
//
// The single record of why a `vk ai` run died. Both the archived failure step and
// the `[ai] …` console line are built from it, so the report and the console can
// never disagree — and a failure the engine produced outside any command is no
// longer invisible to the report (issue #41).

const AI_OPTS = { maxCostUsd: 2, timeoutMs: 300_000 };

test('terminalFailure: a passing run has no failure to record', () => {
  assert.equal(terminalFailure({ ok: true }, AI_OPTS), null);
});

test('terminalFailure: a control-node failure carries the engine where + reason', () => {
  const reason = "repeat stopped after 4 iteration(s) without 'id:target' ever appearing";
  assert.deepEqual(terminalFailure({ ok: false, failure: { where: 'steps[24]', reason } }, AI_OPTS), {
    where: 'steps[24]',
    reason,
    kind: 'fail',
  });
});

test('terminalFailure: an environment abort is its own kind (it maps to exit 3, not 1)', () => {
  const t = terminalFailure({ ok: false, abortedForEnv: true, failure: { where: 'steps[2]', reason: 'adb gone' } }, AI_OPTS);
  assert.equal(t?.kind, 'env');
  assert.equal(t?.reason, 'adb gone');
});

test('terminalFailure: budget and timeout aborts get a reason the engine never supplies', () => {
  // runPlan returns these as a bare flag with NO failure object, which is exactly
  // how an aborted run used to reach the archive with nothing to say about itself.
  const budget = terminalFailure({ ok: false, abortedForBudget: true }, AI_OPTS);
  assert.equal(budget?.kind, 'budget');
  assert.match(budget?.reason ?? '', /cost ceiling \$2/);

  const timeout = terminalFailure({ ok: false, abortedForTimeout: true }, AI_OPTS);
  assert.equal(timeout?.kind, 'timeout');
  assert.match(timeout?.reason ?? '', /run timeout \(300s\)/);
  assert.equal(timeout?.where, 'run', 'an abort is not attributable to one node');
});

test('terminalFailure: a non-ok result with no detail at all still records something', () => {
  const t = terminalFailure({ ok: false }, AI_OPTS);
  assert.equal(t?.kind, 'fail');
  assert.equal(t?.where, 'run');
});

// --- retryAfterDeviceMove (the --server connect probe's one retry) ----------

test('retryAfterDeviceMove: a read that works is not re-run', async () => {
  let calls = 0;
  const got = await retryAfterDeviceMove(
    () => {
      calls++;
      return 'ok';
    },
    () => true,
  );
  assert.equal(got, 'ok');
  assert.equal(calls, 1, 'a healthy read must never be doubled');
});

test('retryAfterDeviceMove: a failure with NO device move propagates on the first try', async () => {
  // The fail-fast property of the connect probe. Retrying every failure would double the
  // wait on a device that is simply broken, for no chance of a different answer.
  let calls = 0;
  await assert.rejects(
    retryAfterDeviceMove(
      () => {
        calls++;
        throw new CliError('device is wedged', 3);
      },
      () => false,
    ),
    (e: unknown) => e instanceof CliError && e.exitCode === 3,
  );
  assert.equal(calls, 1);
});

test('retryAfterDeviceMove: a failure AFTER a device move re-asks the new device once', async () => {
  let calls = 0;
  const got = await retryAfterDeviceMove(
    () => {
      calls++;
      if (calls === 1) throw new CliError("device 'emulator-5554' not found", 3);
      return 'the new device answered';
    },
    () => true,
  );
  assert.equal(got, 'the new device answered');
  assert.equal(calls, 2);
});

test('retryAfterDeviceMove: it re-asks exactly ONCE, never in a loop', async () => {
  let calls = 0;
  await assert.rejects(
    retryAfterDeviceMove(
      () => {
        calls++;
        throw new CliError('still broken', 3);
      },
      () => true,
    ),
  );
  assert.equal(calls, 2, 'a pool that keeps moving must not spin the connect probe');
});

// --- suite lanes ------------------------------------------------------------

test('laneArgv: the lane supplies the device; the suite\'s own flags never leak', () => {
  const argv = laneArgv('tests/01-login.md', { id: 'l1', device: 'emulator-5554' }, {
    devices: 'emulator-5554,emulator-5556',
    concurrency: '2',
    retries: '1',
    name: 'nightly',
    app: 'com.example',
    'max-suite-cost-usd': '5',
    json: true,
    model: 'sonnet',
    'max-cost-usd': '0.5',
  });
  assert.deepEqual(argv, [
    'ai', 'tests/01-login.md', '--json',
    '--device=emulator-5554',
    '--model=sonnet',
    '--max-cost-usd=0.5',
  ]);
});

test('laneArgv: --device from the suite is dropped, not merged', () => {
  // Forwarding it would point every lane at one device — the exact bug being fixed.
  const argv = laneArgv('t.md', { id: 'l2', device: 'emulator-5556' }, { device: 'emulator-5554' });
  assert.ok(argv.includes('--device=emulator-5556'));
  assert.ok(!argv.includes('--device=emulator-5554'));
});

test('laneArgv: a server lane carries --server and the reset app', () => {
  const argv = laneArgv('t.md', { id: 'l1', server: 'http://host:8391' }, { 'auth-key': 'k' }, { resetApp: 'com.example' });
  assert.deepEqual(argv, ['ai', 't.md', '--json', '--server=http://host:8391', '--reset-app=com.example', '--auth-key=k']);
});

test('laneArgv: values are inline, so a value starting with "-" survives the round trip', () => {
  // The separated form would re-parse as a boolean plus a stray positional (args.ts).
  const argv = laneArgv('t.md', { id: 'l1' }, { 'cost-override': 'in=3,out=15', recompile: true });
  assert.ok(argv.includes('--cost-override=in=3,out=15'));
  assert.ok(argv.includes('--recompile'), 'a boolean flag re-emits bare');
});

test('laneEnv: a lane child gets its own run dir and leaves claims to the parent', () => {
  const env = laneEnv({ id: 'l3', device: 'emulator-5554' }, { PATH: '/bin' } as NodeJS.ProcessEnv);
  assert.equal(env.VERIKUN_LANE, 'l3');
  assert.equal(env.VERIKUN_NO_CLAIM, '1');
  assert.equal(env.PATH, '/bin');
});

test('laneEnv: an inherited VERIKUN_SERVER cannot hijack a local lane', () => {
  const local = laneEnv({ id: 'l1', device: 'emulator-5554' }, { VERIKUN_SERVER: 'http://host:8391' } as NodeJS.ProcessEnv);
  assert.equal(local.VERIKUN_SERVER, undefined);
  // …and a remote lane keeps it (the flag wins anyway, but the env must not contradict).
  const remote = laneEnv({ id: 'l1', server: 'http://a:8391' }, { VERIKUN_SERVER: 'http://b:8391' } as NodeJS.ProcessEnv);
  assert.equal(remote.VERIKUN_SERVER, 'http://b:8391');
});

test('laneEnv: an inherited VERIKUN_DEVICE cannot override a server lane\'s lease', () => {
  const remote = laneEnv({ id: 'l1', server: 'http://a:8391' }, { VERIKUN_DEVICE: 'emulator-5554' } as NodeJS.ProcessEnv);
  assert.equal(remote.VERIKUN_DEVICE, undefined);
});

test('lastJsonObject: reads the pretty-printed result even after stray output', () => {
  const stdout = 'a stray line\n' + JSON.stringify({ ok: true, device: 'emulator-5554' }, null, 2) + '\n';
  assert.deepEqual(lastJsonObject(stdout), { ok: true, device: 'emulator-5554' });
});

test('lastJsonObject: nested objects parse whole, and the LAST document wins', () => {
  assert.deepEqual(lastJsonObject('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.deepEqual(lastJsonObject('{"first":1}\n{"second":2}'), { second: 2 });
});

test('lastJsonObject: unparseable output is null, never a throw or a hang', () => {
  assert.equal(lastJsonObject(''), null);
  assert.equal(lastJsonObject('no json here'), null);
  assert.equal(lastJsonObject('{not json}'), null);
  assert.equal(lastJsonObject('[1,2]'), null, 'an array is not a result object');
});

test('lanesFromFlags: comma-separated devices and servers become one pool', () => {
  assert.equal(lanesFromFlags({}), undefined, 'no pool flags = today\'s serial suite');
  assert.deepEqual(lanesFromFlags({ devices: 'emulator-5554, emulator-5556' }), [
    { id: 'd1', label: 'emulator-5554', device: 'emulator-5554' },
    { id: 'd2', label: 'emulator-5556', device: 'emulator-5556' },
  ]);
  assert.deepEqual(lanesFromFlags({ servers: 'http://a:8391,http://b:8391' }), [
    { id: 'd1', label: 'a:8391', server: 'http://a:8391' },
    { id: 'd2', label: 'b:8391', server: 'http://b:8391' },
  ]);
});

test('lanesFromFlags: duplicates and blanks are dropped, ids stay short', () => {
  // The id becomes a directory name AND a run-id suffix, so a 40-char UDID would make
  // both unreadable — the label carries the serial instead.
  const lanes = lanesFromFlags({ devices: '00008120-001A2B3C4D5E6F00,,00008120-001A2B3C4D5E6F00, other' })!;
  assert.deepEqual(lanes.map((l) => l.id), ['d1', 'd2']);
  assert.equal(lanes[0].label, '00008120-001A2B3C4D5E6F00');
});

test('laneResult: the EXIT CODE is the verdict, the JSON only adds detail', () => {
  const green = laneResult(0, { ok: true, costUsd: 0.02, cost: 'est $0.02', runDir: '/r/1', device: 'emu-1' }, '', { id: 'd1' });
  assert.equal(green.ok, true);
  assert.equal(green.costUsd, 0.02);
  assert.equal(green.device, 'emu-1');
  assert.equal(green.failure, undefined);
  // A stale success document cannot turn a failed process green.
  assert.equal(laneResult(1, { ok: true }, 'assert failed', { id: 'd1' }).ok, false);
});

test('laneResult: exit 3 and a failed spawn both read as an environment problem', () => {
  assert.equal(laneResult(3, { ok: false, abortedForEnv: true }, '', { id: 'd1' }).abortedForEnv, true);
  // 127: the child never started. Same class of problem — the suite should probe the
  // lane, not blame the app.
  const missing = laneResult(127, null, "'node' was not found on PATH", { id: 'd1' });
  assert.equal(missing.abortedForEnv, true);
  assert.match(missing.failure?.reason ?? '', /not found on PATH/);
});

test('laneResult: a thrown child (mapError shape) still becomes a failed row', () => {
  const r = laneResult(2, { error: "suite: 'x' is not a directory", exitCode: 2 }, '', { id: 'd1' });
  assert.equal(r.ok, false);
  assert.equal(r.abortedForEnv, undefined, 'a usage error is not the environment');
  assert.equal(r.failure?.reason, "suite: 'x' is not a directory");
});

test('laneResult: unparseable output falls back to the child\'s last stderr line', () => {
  const r = laneResult(1, null, 'Fatal: something went sideways', { id: 'd1', device: 'emu-1' });
  assert.equal(r.ok, false);
  assert.equal(r.failure?.reason, 'Fatal: something went sideways');
  assert.equal(r.device, 'emu-1', 'the lane still attributes the row');
  assert.equal(r.state, null, 'state is read from the archived run, not the wire');
});

test('laneResult: budget and timeout aborts survive the process boundary', () => {
  const budget = laneResult(1, { ok: false, abortedForBudget: true }, '', { id: 'd1' });
  assert.equal(budget.abortedForBudget, true);
  const timeout = laneResult(1, { ok: false, abortedForTimeout: true }, '', { id: 'd1' });
  assert.equal(timeout.abortedForTimeout, true);
});
