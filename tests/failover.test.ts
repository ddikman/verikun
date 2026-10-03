import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {isUsableState} from '../src/device/pool';
import {laneProbeHealthy} from '../src/cli';
import {DeviceGoneError,DeviceUnresponsiveError,UnsupportedOnPlatformError,NoWindowError,DumpKilledError,CliError} from '../src/errors';

for(const state of ['device','booted','connected','Connected','connected (paired)'])
  test(`pool state ${state} is drivable`,()=>assert.equal(isUsableState(state),true));
for(const state of ['offline','unauthorized','shutdown','disconnected','Disconnected','not connected','unavailable',''])
  test(`pool state ${state} is not drivable`,()=>assert.equal(isUsableState(state),false));
for(const e of [new DeviceGoneError('No window'),new DeviceUnresponsiveError('device'),new UnsupportedOnPlatformError('unsupported')])
  test(`${e.name} never looks like a healthy local lane`,()=>assert.equal(laneProbeHealthy(e),false));
for(const e of [new NoWindowError(),new DumpKilledError(),new CliError('no interesting nodes',1)])
  test(`${e.name} ${e.exitCode} does not convict a local lane`,()=>assert.equal(laneProbeHealthy(e),true));
test('local lane classification uses identity, never a misleading message',()=>{
  assert.equal(laneProbeHealthy(new CliError('No window to read',3)),false);
  assert.equal(laneProbeHealthy(new NoWindowError('device offline')),true);
});
