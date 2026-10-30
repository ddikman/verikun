import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AdbRunner, adbTransportLoss, withAdbRecoveryDeadline } from '../src/drivers/adb-runner';
import { DeviceGoneError, DeviceUnresponsiveError, CliError } from '../src/errors';
import { TextResult } from '../src/exec';
const ok = (stdout = ''): TextResult => ({ code: 0, stdout, stderr: '' });
const loss = (stderr = "error: device 'abc' not found"): TextResult => ({ code: 1, stdout: '', stderr });
for (const stderr of ["device 'abc' not found", 'no devices/emulators found', 'device offline', 'error: closed', 'protocol fault', 'failed to get feature set'])
  test(`transport classifier: ${stderr}`, () => assert.equal(adbTransportLoss(loss(stderr)), true));
for (const stderr of ['device unauthorized', 'device is not ready (offline)', 'permission denied', 'Killed', 'INSTALL_FAILED_INVALID_APK'])
  test(`not transport loss: ${stderr}`, () => assert.equal(adbTransportLoss(loss(stderr)), false));
test('transport text alone without a failure status cannot convict a device', () => assert.equal(adbTransportLoss({code: 0, stderr: 'device offline'}), false));
function runner(text: (args: string[]) => TextResult) {
  let now = 0;
  const calls: string[][] = [];
  const r = new AdbRunner('adb', 'abc', {
    text: (_cmd, args) => { calls.push(args.slice(2)); return text(args.slice(2)); },
    binary: () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), now: () => now, sleep: ms => now += ms,
  });
  return {r, calls};
}
test('a read retries once after transport recovery, preserving raw stderr otherwise', () => {
  let commands = 0;
  const {r, calls} = runner(args => args[0] === 'get-state' ? ok('device') : ++commands === 1 ? loss() : ok('screen'));
  assert.equal(r.text(['shell', 'dumpsys', 'window']).stdout, 'screen');
  assert.equal(commands, 2); assert.equal(calls.length, 3);
});
test('an action with device output is never replayed after transport loss', () => {
  const {r, calls} = runner(() => ({ ...loss(), stdout: 'delivered' }));
  assert.throws(() => r.text(['shell', 'input', 'tap', '1', '2']), DeviceGoneError);
  assert.equal(calls.length, 1);
});
test('persistent loss has a bounded recovery window and exits with typed loss', () => {
  const {r, calls} = runner(() => loss('error: closed'));
  assert.throws(() => r.text(['exec-out', 'screencap']), e => e instanceof DeviceGoneError && /error: closed/.test(e.message));
  assert.ok(calls.length <= 22);
});
test('a shell timeout latches only when the 5s echo also fails; later calls fail instantly', () => {
  const {r, calls} = runner(args => {
    if (args.includes('echo')) return loss();
    throw Object.assign(new CliError('timeout', 3), {code: 'ETIMEDOUT'});
  });
  assert.throws(() => r.text(['shell', 'dumpsys', 'window']), DeviceUnresponsiveError);
  const n = calls.length;
  assert.throws(() => r.text(['shell', 'input', 'tap', '1', '2']), DeviceUnresponsiveError);
  assert.equal(calls.length, n);
});
test('a healthy echo preserves the original timeout and never latches', () => {
  const timeout = Object.assign(new CliError('timeout', 3), {code: 'ETIMEDOUT'});
  const {r, calls} = runner(args => { if (args.includes('echo')) return ok('ok'); throw timeout; });
  assert.throws(() => r.text(['shell', 'something']), e => e === timeout);
  assert.throws(() => r.text(['shell', 'something']), e => e === timeout);
  assert.equal(calls.length, 4);
});
test('best effort clock probes cannot latch the breaker', () => {
  const {r, calls} = runner(() => { throw Object.assign(new CliError('timeout', 3), {code: 'ETIMEDOUT'}); });
  assert.throws(() => r.text(['shell', 'date'], {bestEffort: true}));
  assert.throws(() => r.text(['shell', 'date'], {bestEffort: true}));
  assert.equal(calls.length, 2);
});
test('a timeout on the transport retry still confirms and latches the breaker', () => {
  let reads = 0;
  const {r, calls} = runner(args => {
    if (args[0] === 'get-state') return ok('device');
    if (args.includes('echo')) return loss();
    if (++reads === 1) return loss();
    throw Object.assign(new CliError('timeout', 3), {code:'ETIMEDOUT'});
  });
  assert.throws(() => r.text(['shell','dumpsys','window']), DeviceUnresponsiveError);
  const count=calls.length;
  assert.throws(() => r.text(['shell','dumpsys','window']), DeviceUnresponsiveError);
  assert.equal(calls.length,count);
});
test('transport recovery respects the polling window and restores its scope', () => {
  const {r,calls}=runner(()=>loss());
  assert.throws(()=>withAdbRecoveryDeadline(1200,()=>r.text(['shell','dumpsys','window'])),DeviceGoneError);
  assert.equal(calls.length,4,'initial read and three bounded readiness probes');
  const count=calls.length;
  assert.throws(()=>r.text(['shell','dumpsys','window']),DeviceGoneError);
  assert.equal(calls.length-count,21,'next call gets its own recovery budget');
});

test('a successful real recovery probe clears the breaker',()=>{
  let healthy=false;
  const {r}=runner(args=>{
    if(healthy)return args.includes('echo')?ok('ok'):ok('screen');
    if(args.includes('echo'))return loss();
    throw Object.assign(new CliError('timeout',3),{code:'ETIMEDOUT'});
  });
  assert.throws(()=>r.text(['shell','dumpsys','window']),DeviceUnresponsiveError);
  healthy=true;assert.equal(r.probe(),true);
  assert.equal(r.text(['shell','dumpsys','window']).stdout,'screen');
});
