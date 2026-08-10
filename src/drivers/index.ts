import { Driver, Platform } from '../types';
import { AdbDriver } from './adb';
import { IdbDriver } from './ios';

export { AdbDriver, probeAdb, listAdbDevices } from './adb';
export { IdbDriver, probeXcrun, probeIdb, probeIdbCompanion, listSimulators, listPhysicalDevices } from './ios';

export function getDriver(platform: Platform, device?: string): Driver {
  return platform === 'ios' ? new IdbDriver(device) : new AdbDriver(device);
}
