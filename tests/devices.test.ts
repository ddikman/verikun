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
