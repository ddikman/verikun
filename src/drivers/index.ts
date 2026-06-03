import { Driver, Platform } from '../types';
import { AdbDriver } from './adb';
import { SimctlDriver } from './simctl';

export { AdbDriver } from './adb';
export { SimctlDriver } from './simctl';

export function getDriver(platform: Platform, device?: string): Driver {
  return platform === 'ios' ? new SimctlDriver(device) : new AdbDriver(device);
}
