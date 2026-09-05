// The context every command handler takes: the driver it drives, the flags it was
// invoked with, and the recorder when the command is part of a test run. Lives apart
// from cli.ts so a command module can import it without importing the dispatcher.

import type { Flags } from '../args';
import type { Recorder } from '../run';
import type { Driver, Platform } from '../types';

export interface Ctx {
  driver: Driver;
  platform: Platform;
  device?: string;
  positionals: string[];
  flags: Flags;
  /** Present when the command is being recorded into a test run. */
  record?: Recorder;
}
