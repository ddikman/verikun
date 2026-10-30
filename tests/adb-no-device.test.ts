import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AdbDriver } from '../src/drivers/adb';
import { NoUsableDeviceError } from '../src/errors';
import type { DeviceInfo } from '../src/types';

/** The driver with `adb devices -l` answered from a fixture, so no adb is needed. */
class ListedAdb extends AdbDriver {
  constructor(private readonly listed: DeviceInfo[]) {
    super();
  }
  override listDevices(): DeviceInfo[] {
    return this.listed;
  }
}

test('AdbDriver: nothing attached is a NoUsableDeviceError (exit 3), so a leaking adb can be named', () => {
  assert.throws(
    () => new ListedAdb([]).resolvedSerial(),
    (e: unknown) => e instanceof NoUsableDeviceError && e.exitCode === 3 && /No Android devices/.test(e.message),
  );
});

test('AdbDriver: only offline/unauthorized devices is a NoUsableDeviceError too', () => {
  const offline: DeviceInfo = { serial: 'R58R42SGVNR', state: 'offline', platform: 'android', kind: 'physical' };
  assert.throws(
    () => new ListedAdb([offline]).resolvedSerial(),
    (e: unknown) => e instanceof NoUsableDeviceError && /R58R42SGVNR=offline/.test(e.message),
  );
});
