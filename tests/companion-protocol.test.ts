import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPANION_PROTOCOL,
  dumpCommand,
  isHierarchy,
  isLiveReply,
  parseState,
  pingMatches,
  portForSerial,
} from '../src/companion/protocol';
import { companionEnabled, nullRootAction } from '../src/companion/manager';

const buf = (s: string) => Buffer.from(s, 'utf8');

test('isLiveReply: an empty reply is not a live companion', () => {
  // The one that matters: `adb forward` keeps the host port open whether or not anything
  // is listening on the device end, so a dead companion CONNECTS fine and returns nothing.
  // Reading that as a valid (empty) response is the "absent" lie that skips a guard.
  assert.equal(isLiveReply(Buffer.alloc(0)), false);
  assert.equal(isLiveReply(buf('anything')), true);
});

test('pingMatches: accepts only our companion at our protocol version', () => {
  assert.equal(pingMatches(buf(`verikun-companion ${COMPANION_PROTOCOL}\n`)), true);
  assert.equal(pingMatches(buf(`verikun-companion ${COMPANION_PROTOCOL}`)), true, 'no trailing newline');
});

test('pingMatches: a companion from another verikun version is not talked to', () => {
  // It is still holding the device's UiAutomation connection, so the caller must restart
  // it rather than ignore it — but it must not be treated as usable.
  assert.equal(pingMatches(buf('verikun-companion 999\n')), false);
});

test('pingMatches: rejects an empty reply and anything that is not us', () => {
  assert.equal(pingMatches(Buffer.alloc(0)), false);
  assert.equal(pingMatches(buf('some other service 1\n')), false);
  assert.equal(pingMatches(buf('verikun-companion\n')), false, 'no version');
});

test('isHierarchy: only a real dump counts', () => {
  assert.equal(isHierarchy(buf("<?xml version='1.0'?><hierarchy rotation=\"0\"><node /></hierarchy>")), true);
});

test('isHierarchy: the companion\'s own error replies are not hierarchies', () => {
  // These arrive on the same channel as a dump. Letting one reach the XML parser would
  // yield zero elements — indistinguishable from an empty screen.
  assert.equal(isHierarchy(buf('released — call acquire first')), false);
  assert.equal(isHierarchy(buf('ERROR unknown command: dumpp')), false);
  assert.equal(isHierarchy(Buffer.alloc(0)), false);
});

test('dumpCommand: carries the idle window and the calibrated dimension source', () => {
  assert.equal(dumpCommand(1000, 'app'), 'dump 1000 app');
  assert.equal(dumpCommand(0, 'real'), 'dump 0 real');
});

test('dumpCommand: a negative or fractional idle window is normalised', () => {
  // It is concatenated into a command line the companion parses with Long.parseLong —
  // "-1" or "12.5" would throw on the device instead of failing here.
  assert.equal(dumpCommand(-5, 'app'), 'dump 0 app');
  assert.equal(dumpCommand(12.5, 'app'), 'dump 13 app');
});

test('portForSerial: the same device always resolves to the same port', () => {
  // Two verikun processes driving one device must find the SAME companion: only one
  // UiAutomation may be connected, so a second forward would start a second companion
  // that immediately loses the connection.
  assert.equal(portForSerial('R58R42SGVNR'), portForSerial('R58R42SGVNR'));
});

test('portForSerial: different devices get different ports', () => {
  const serials = ['R58R42SGVNR', 'emulator-5554', 'emulator-5556', '192.168.1.5:5555'];
  const ports = new Set(serials.map((s) => portForSerial(s)));
  assert.equal(ports.size, serials.length, 'a collision would make two devices share one companion');
});

test('portForSerial: stays inside the configured span', () => {
  for (const serial of ['a', 'emulator-5554', 'R58R42SGVNR', '::1:5555', '']) {
    const port = portForSerial(serial, 8299, 200);
    assert.ok(port >= 8299 && port < 8499, `${serial} -> ${port}`);
    assert.equal(Number.isInteger(port), true);
  }
});

// --- state parsing -----------------------------------------------------------

test('parseState: a calibrated, connected companion', () => {
  const s = parseState(Buffer.from(`verikun-companion ${COMPANION_PROTOCOL} ready app held\n`));
  assert.deepEqual(s, { usable: true, dims: 'app', held: true });
});

test('parseState: released and uncalibrated are both first-class', () => {
  const s = parseState(Buffer.from(`verikun-companion ${COMPANION_PROTOCOL} uncalibrated released\n`));
  assert.equal(s.usable, true);
  assert.equal(s.dims, undefined, 'uncalibrated must not look like a dimension source');
  assert.equal(s.held, false);
});

test('parseState: a companion from another protocol version is not usable', () => {
  // It is still holding the device's one UiAutomation connection, so the caller must restart
  // it — but it must never be talked to, since its dump format may differ.
  assert.equal(parseState(Buffer.from('verikun-companion 999 ready app held\n')).usable, false);
});

test('parseState: an empty reply is not a companion', () => {
  // `adb forward` keeps the host port open with nothing behind it — see isLiveReply.
  assert.deepEqual(parseState(Buffer.alloc(0)), { usable: false, held: false });
});

test('parseState: something else answering on the port is not usable', () => {
  assert.equal(parseState(Buffer.from('SSH-2.0-OpenSSH_9.0\n')).usable, false);
});

// --- the default ------------------------------------------------------------

test('companionEnabled: on by default, with nothing set', () => {
  delete process.env.VERIKUN_COMPANION;
  assert.equal(companionEnabled(), true);
});

test('companionEnabled: the documented opt-out values all turn it off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' 0 ']) {
    process.env.VERIKUN_COMPANION = v;
    assert.equal(companionEnabled(), false, `VERIKUN_COMPANION=${JSON.stringify(v)}`);
  }
  delete process.env.VERIKUN_COMPANION;
});

test('companionEnabled: an empty or unrecognised value leaves it on', () => {
  // Failing OPEN is the safe direction: the worst case is the fast path, which falls back
  // on its own. Failing closed would silently cost every read ~2.4s over a stray value.
  for (const v of ['', '1', 'true', 'yes', 'please']) {
    process.env.VERIKUN_COMPANION = v;
    assert.equal(companionEnabled(), true, `VERIKUN_COMPANION=${JSON.stringify(v)}`);
  }
  delete process.env.VERIKUN_COMPANION;
});

// --- recovering from a wedged connection ------------------------------------
//
// A null root is normally the DEVICE having no window (mid-launch, force-stopped), and
// standing down for it would release a healthy connection after every `launch --clear`.
// But a long-lived UiAutomation connection can also go stale and return null FOREVER for a
// window that is plainly there — MEASURED on a Pixel 3a as 30s+ of null roots while a stock
// dump read the same screen fine. Duration is the only thing that tells the two apart.

test('nullRootAction: a brief run is the device, not the companion', () => {
  assert.equal(nullRootAction(0, false), 'propagate');
  assert.equal(nullRootAction(2999, false), 'propagate');
});

test('nullRootAction: a long run earns one connection recycle', () => {
  assert.equal(nullRootAction(3000, false), 'recycle');
  assert.equal(nullRootAction(9999, false), 'recycle');
});

test('nullRootAction: only ONE recycle per run of null roots', () => {
  // Re-releasing and re-acquiring on every read would cost ~1s each and thrash the
  // connection the companion exists to hold.
  for (const runMs of [3000, 6000, 60000]) {
    assert.notEqual(nullRootAction(runMs, true), 'recycle', `runMs=${runMs}`);
  }
});

test('nullRootAction: a recycle that did not help falls back to the stock path', () => {
  // The safety net, and the reason this escalation exists at all: the stock dump can read
  // screens a wedged companion cannot, and being slow always beats failing a selector on a
  // screen that is there.
  assert.equal(nullRootAction(6000, true), 'fallback');
});

test('nullRootAction: the fallback is reachable inside a default auto-wait window', () => {
  // REGRESSION: the fallback used to need 2x the wedge interval (6s), but a selector command
  // waits 5s by default. Recycling at ~3s and then waiting for 6s meant the window closed
  // first, so a wedged connection failed the command with "no window" having never tried the
  // stock dump — the one case this escalation is for. A post-recycle null root must escalate
  // on the very next read, whatever the clock says.
  assert.equal(nullRootAction(3000, true), 'fallback', 'immediately after a ~3s recycle');
  assert.equal(nullRootAction(3001, true), 'fallback');
});

test('nullRootAction: never escalates past fallback on a fresh run', () => {
  // A first-ever null root, however long the previous run was, still gets its recycle —
  // `alreadyRecycled` is what gates the escalation, not elapsed time alone.
  assert.equal(nullRootAction(60000, false), 'recycle');
});

// The two halves of the protocol number live in different languages and are compiled by
// different toolchains, so nothing else can notice when they drift. This reads the Java as
// TEXT, the way tests/docs-coverage.test.ts reads cli.ts.
//
// It exists because the drift is SILENT and costs the whole point of a release: an upgraded
// verikun probes the daemon a previous install left running, sees the number it expects,
// reuses it, and never pushes the new jar. MEASURED on a Pixel 3a before the 1 -> 2 bump —
// `vk ui` reported 0 nodes of a permission dialog while the stock path read all 5, exit 0
// and no warning, on a build whose changelog said that was fixed.
test('COMPANION_PROTOCOL matches PROTOCOL_VERSION in the companion source', () => {
  // resolve from cwd, not __dirname: the suite runs from .test-build/tests/, as
  // tests/docs-coverage.test.ts does for the same reason.
  const javaPath = resolve(
    process.cwd(),
    'tools/verikun-companion/src/dev/verikun/companion/CompanionApp.java',
  );
  const java = readFileSync(javaPath, 'utf8');
  const m = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(java);

  assert.ok(m, 'could not find PROTOCOL_VERSION in CompanionApp.java — did it get renamed?');
  assert.equal(
    m![1],
    COMPANION_PROTOCOL,
    'the host and the companion disagree on the protocol number: an upgraded verikun would ' +
      'reuse a stale daemon and never push the new jar',
  );
});
