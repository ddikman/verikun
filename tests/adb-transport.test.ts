import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { adbTransport, severanceRisk } from '../src/drivers/adb';

// `vk device set airplane=on` cuts the device's radios. Over a WIRELESS adb link that
// also cuts the channel carrying the next command, and nothing can turn it back on
// remotely — recovery means physically plugging in USB. So the transport classifier is
// what stands between a test author and an unreachable phone; it is worth pinning down.

test('adbTransport: USB serials are vendor strings', () => {
  assert.equal(adbTransport('R58R42SGVNR'), 'usb'); // the Samsung this was built against
  assert.equal(adbTransport('1A2B3C4D'), 'usb');
  assert.equal(adbTransport('ZY223KJPQR'), 'usb');
});

test('adbTransport: emulators are reached over a host-local console port', () => {
  // Not through the guest's network stack — so cutting the guest's wifi cannot sever
  // adb, and the guard must not fire and block a legitimate emulator run.
  assert.equal(adbTransport('emulator-5554'), 'emulator');
  assert.equal(adbTransport('emulator-5556'), 'emulator');
});

test('adbTransport: host:port is wireless', () => {
  assert.equal(adbTransport('192.168.1.5:5555'), 'tcp');
  assert.equal(adbTransport('10.0.0.2:37000'), 'tcp');
  assert.equal(adbTransport('myphone.local:5555'), 'tcp');
});

test('adbTransport: Android 11+ wireless-debugging mDNS names are wireless', () => {
  assert.equal(adbTransport('adb-R58R42SGVNR-XxYyZz._adb-tls-connect._tcp'), 'tcp');
  assert.equal(adbTransport('adb-AAAA-BBBB._adb-tls-pairing._tcp'), 'tcp');
  assert.equal(adbTransport('adb-AAAA-BBBB._adb-tls-connect._tcp.'), 'tcp'); // trailing dot
});

test('adbTransport: an unrecognized shape falls back to usb, deliberately', () => {
  // USB serials are the open-ended set (any vendor string) while TCP serials have
  // exactly two forms. This guard is a foot-gun net, not a security boundary, so the
  // failure to avoid is misreading a real USB serial as wireless and blocking a run.
  assert.equal(adbTransport(''), 'usb');
  assert.equal(adbTransport('something-odd'), 'usb');
  assert.equal(adbTransport('  R58R42SGVNR  '), 'usb'); // trimmed
});

test('severanceRisk: only cutting the radios over a wireless link is a risk', () => {
  assert.equal(severanceRisk('tcp', 'airplane', 'on'), true);
});

test('severanceRisk: turning airplane mode back OFF restores the link, never cuts it', () => {
  assert.equal(severanceRisk('tcp', 'airplane', 'off'), false);
});

test('severanceRisk: cosmetic settings never sever the link', () => {
  for (const key of ['dark', 'font-scale', 'rotation', 'stay-awake'] as const) {
    assert.equal(severanceRisk('tcp', key, 'on'), false, `${key} should not be a severance risk`);
  }
});

test('severanceRisk: USB and emulator transports are never at risk', () => {
  assert.equal(severanceRisk('usb', 'airplane', 'on'), false);
  assert.equal(severanceRisk('emulator', 'airplane', 'on'), false);
});
