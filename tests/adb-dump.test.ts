import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dumpWasKilled } from '../src/drivers/adb';

// Was the hierarchy dump SIGKILLed, or did it merely fail? (issue #137)
//
// MEASURED on a Pixel 3a, and the measurement is why the exit code leads: in the
// `adb shell '<cmd>'` form the device shell prints NOTHING when it is killed — both streams
// come back empty and only the status says 137. The old message really did read
// "Failed to capture UI hierarchy after 3 attempts." with nothing after it.

test('dumpWasKilled: exit 137 is a kill even when the device said nothing at all', () => {
  // THE case from the field. A matcher built on the text alone would miss it entirely.
  assert.equal(dumpWasKilled(137, ''), true);
});

test('dumpWasKilled: the shell saying "Killed" counts, for an adb that drops the status', () => {
  // Older adb does not propagate the remote exit status, and issue #137 was reported with the
  // word present — so the text stays a second signal rather than the only one.
  assert.equal(dumpWasKilled(0, 'Killed'), true);
  assert.equal(dumpWasKilled(1, 'Killed'), true);
});

test('dumpWasKilled: an ordinary failed dump is NOT a kill', () => {
  // The polarity that matters: everything here must keep failing fast rather than being
  // polled through a caller's whole budget.
  assert.equal(dumpWasKilled(0, ''), false);
  assert.equal(dumpWasKilled(1, 'ERROR: could not get idle state.'), false);
  assert.equal(dumpWasKilled(1, "adb: device '032AY1UNR2' not found"), false);
  assert.equal(dumpWasKilled(255, 'error: closed'), false);
});

test('dumpWasKilled: "Killed" must be the word, not a fragment of another one', () => {
  // A word boundary, so an app or path that merely contains the letters cannot fake a kill.
  assert.equal(dumpWasKilled(1, 'Unkilled'), false);
  assert.equal(dumpWasKilled(1, 'KilledProcess'), false);
});
