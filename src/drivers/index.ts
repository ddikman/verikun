import { Driver, Platform } from '../types';
import { AdbDriver } from './adb';
import { IdbDriver } from './ios';

export { AdbDriver, probeAdb } from './adb';
export { IdbDriver, probeXcrun, probeIdb, probeIdbCompanion } from './ios';

export function getDriver(platform: Platform, device?: string): Driver {
  return platform === 'ios' ? new IdbDriver(device) : new AdbDriver(device);
}
