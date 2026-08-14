import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatDeviceTable } from '../src/cli';
import type { DeviceInfo } from '../src/types';

// --- formatDeviceTable (vk devices aligned/headed output) ------------------

test('formatDeviceTable: header first, columns aligned across platforms even with empty cells', () => {
  const devices: DeviceInfo[] = [
    { platform: 'android', serial: 'AND1', state: 'device', model: 'Pixel', product: 'p1' },
    { platform: 'ios', serial: 'IOS-LONG-UDID', state: 'available (paired)', model: "David's iPad", product: 'iPad13,1', note: 'physical — via idb' },
    // Row with no model/product (the `unavailable` iPhone case) must still line up.
    { platform: 'ios', serial: 'IOS-2', state: 'unavailable', note: 'physical — via idb' },
  ];
  const lines = formatDeviceTable(devices);

  // One header line + one line per device.
  assert.equal(lines.length, devices.length + 1);

  // Header carries every column name, PLATFORM first.
  const header = lines[0];
  assert.ok(header.startsWith('PLATFORM'));
  for (const name of ['PLATFORM', 'SERIAL', 'STATE', 'MODEL', 'PRODUCT', 'NOTE']) {
    assert.ok(header.includes(name), `header missing ${name}`);
  }

  // Alignment: each column's left edge (from the single-word header) is the same
  // offset in every data row. Empty cells are padded blanks, not dropped, so a row
  // missing model/product still has its later columns at the header offsets.
  const offset = (name: string) => header.indexOf(name);
  devices.forEach((d, i) => {
    const line = lines[i + 1];
    assert.ok(line.startsWith(d.platform, offset('PLATFORM')), `platform misaligned row ${i}`);
    assert.ok(line.startsWith(d.serial, offset('SERIAL')), `serial misaligned row ${i}`);
    assert.ok(line.startsWith(d.state, offset('STATE')), `state misaligned row ${i}`);
    if (d.model) assert.ok(line.startsWith(d.model, offset('MODEL')), `model misaligned row ${i}`);
    if (d.product) assert.ok(line.startsWith(d.product, offset('PRODUCT')), `product misaligned row ${i}`);
    if (d.note) assert.ok(line.startsWith(d.note, offset('NOTE')), `note misaligned row ${i}`);
  });

  // No trailing whitespace on any line.
  for (const line of lines) assert.equal(line, line.trimEnd());

  // No `(...)` / `[...]` decorations around product/note — the header labels them now.
  assert.ok(lines.some((l) => l.includes('iPad13,1')));
  assert.ok(!lines.some((l) => l.includes('(iPad13,1)')));
  assert.ok(!lines.some((l) => l.includes('[physical')));
});

test('formatDeviceTable: optional columns with no values are dropped', () => {
  // Android-only, no notes -> NOTE column omitted; product present -> PRODUCT kept.
  const devices: DeviceInfo[] = [
    { platform: 'android', serial: 'AND1', state: 'device', model: 'Pixel', product: 'p1' },
    { platform: 'android', serial: 'AND2', state: 'offline', model: 'Nexus', product: 'p2' },
  ];
  const lines = formatDeviceTable(devices);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('PRODUCT'));
  assert.ok(!lines[0].includes('NOTE'), 'empty NOTE column should be dropped');
});

test('formatDeviceTable: empty list returns just the header (required columns only)', () => {
  const lines = formatDeviceTable([]);
  assert.equal(lines.length, 1);
  // With no devices, every optional column is dropped, leaving the required three.
  assert.equal(lines[0], 'PLATFORM  SERIAL  STATE');
});

// --- USED BY (device claims) ----------------------------------------------
//
// The column reports which job is already driving each device. It is OPTIONAL for two
// reasons that both matter: a host where nothing is ever claimed sees the table it always
// saw, and `VERIKUN_NO_CLAIM=1` (which stops `cmdDevices` populating `claim` at all)
// renders byte-identically to the pre-claims output.

const claimed = (by: string, mine = false) => ({
  by,
  mine,
  serial: 'X',
  platform: 'android' as const,
  cwd: '/work/x',
  pid: 1,
  host: 'h',
  processScoped: false,
  since: '2026-08-13T12:00:00.000Z',
  heartbeat: '2026-08-13T12:00:00.000Z',
  version: '0.22.0',
});

test('formatDeviceTable: USED BY appears only when some device is claimed', () => {
  const free: DeviceInfo[] = [
    { platform: 'android', serial: 'AND1', state: 'device', model: 'Pixel' },
    { platform: 'android', serial: 'AND2', state: 'device', model: 'Nexus' },
  ];
  assert.ok(!formatDeviceTable(free)[0].includes('USED BY'), 'no claims -> no column');

  const withClaim: DeviceInfo[] = [
    { ...free[0], claim: claimed('this job', true) },
    free[1],
  ];
  const lines = formatDeviceTable(withClaim);
  assert.ok(lines[0].includes('USED BY'));
  assert.ok(lines[1].includes('this job'));
  // The unclaimed device keeps an empty cell rather than sliding NOTE into its place.
  assert.ok(!lines[2].includes('this job'));
});

test('formatDeviceTable: USED BY sits before NOTE and stays aligned across both', () => {
  const devices: DeviceInfo[] = [
    { platform: 'android', serial: 'AND1', state: 'device', claim: claimed("workspace 'brussels' · 2m ago") },
    { platform: 'ios', serial: 'IOS1', state: 'booted', note: 'physical — via idb' },
  ];
  const header = formatDeviceTable(devices)[0];
  assert.ok(header.indexOf('USED BY') < header.indexOf('NOTE'), 'USED BY must precede NOTE');

  const rows = formatDeviceTable(devices).slice(1);
  assert.ok(rows[0].startsWith("workspace 'brussels' · 2m ago", header.indexOf('USED BY')));
  assert.ok(rows[1].startsWith('physical — via idb', header.indexOf('NOTE')));
  for (const line of formatDeviceTable(devices)) assert.equal(line, line.trimEnd());
});
