import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { policeRates, rateMatches, routeInterface } from '../src/drivers/adb';

// `download-limit` is verified by EFFECT: the stored setting reads back even when the kernel
// refused to police it, so the driver reads the tc filter Android attached to the interface
// carrying traffic. These are the pure halves of that probe.

// Verbatim from a Pixel 10 (Android 17) with `ingress_rate_limit_bytes_per_second` = 32000.
const PIXEL_TC = `filter protocol all pref 1 matchall chain 0
filter protocol all pref 1 matchall chain 0 handle 0x1
  not_in_hw
\taction order 1:  police 0x3 rate 256Kbit burst 128Kb mtu 2Kb action pipe/continue overhead 0b
\tref 1 bind 1

\taction order 2: bpf prog_netd_schedact_ingress_account:[*fsobj] id 27 tag a598e5d513906405 default-action drop
\tindex 3 ref 1 bind 1
`;

test('policeRates: reads the limiter Android attached, in bytes per second', () => {
  assert.deepEqual(policeRates(PIXEL_TC), [32000]);
});

test('policeRates: every unit tc prints, back to bytes', () => {
  assert.deepEqual(policeRates('police 0x1 rate 8Mbit burst 128Kb'), [1000000]);
  assert.deepEqual(policeRates('police 0x2 rate 2Mbit burst 128Kb'), [250000]);
  assert.deepEqual(policeRates('police 0x2 rate 800Kbit burst 128Kb'), [100000]);
  assert.deepEqual(policeRates('police 0x2 rate 98760bit burst 128Kb'), [12345]); // not a round number
  assert.deepEqual(policeRates('police 0x2 rate 1Gbit burst 128Kb'), [125000000]);
  assert.deepEqual(policeRates('police 0x2 rate 256Kibit burst 128Kb'), [32768]); // tc -iec
});

test('policeRates: no limiter, or a rate that is not a police action, is nothing', () => {
  assert.deepEqual(policeRates(''), []);
  // Another qdisc's rate is not Android's limiter.
  assert.deepEqual(policeRates('class htb 1:1 root rate 1Mbit ceil 1Mbit burst 1600b'), []);
});

test('policeRates: several limiters are all reported', () => {
  assert.deepEqual(policeRates('police 0x1 rate 8Mbit burst 128Kb\npolice 0x2 rate 256Kbit burst 128Kb'), [1000000, 32000]);
});

test('rateMatches: what tc rounds still matches, a different limit does not', () => {
  assert.equal(rateMatches(32000, 32000), true);
  // 1234567 bit/s prints as `1234Kbit` — 0.05% low, still the limit we set.
  assert.equal(rateMatches(policeRates('police 0x1 rate 1234Kbit')[0], Math.round(1234567 / 8)), true);
  assert.equal(rateMatches(100000, 125000), false);
  assert.equal(rateMatches(0, 1000), false);
});

test('routeInterface: the interface a lookup leaves on', () => {
  assert.equal(routeInterface('8.8.8.8 via 192.168.68.1 dev wlan0 table 1047 src 192.168.68.103 uid 2000 \n    cache '), 'wlan0');
  assert.equal(
    routeInterface('2001:4860:4860::8888 from :: via fe80::1 dev rmnet_data1 table 1023 proto ra src 2a00::1 metric 1024 pref medium'),
    'rmnet_data1',
  );
});

test('routeInterface: a 464xlat tunnel maps to the base interface Android limits', () => {
  assert.equal(routeInterface('8.8.8.8 dev v4-rmnet_data0 table 1012 src 192.0.0.4 uid 2000'), 'rmnet_data0');
});

test('routeInterface: no route, and no name unsafe for the device shell', () => {
  assert.equal(routeInterface('RTNETLINK answers: Network is unreachable'), null);
  assert.equal(routeInterface(''), null);
  assert.equal(routeInterface('8.8.8.8 dev wlan0;reboot table 1'), null);
  assert.equal(routeInterface('8.8.8.8 dev $(id) table 1'), null);
});
