import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { downscalePng } from '../src/image';
import { makePng } from './helpers';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('downscalePng: a non-PNG buffer is returned untouched', () => {
  const buf = Buffer.from('this is definitely not a png file');
  const r = downscalePng(buf, 100);
  assert.equal(r.scaled, false);
  assert.equal(r.reason, 'not a PNG');
  assert.equal(r.buf, buf);
});

test('downscalePng: a buffer shorter than the signature is not a PNG', () => {
  assert.equal(downscalePng(Buffer.from([1, 2, 3]), 100).reason, 'not a PNG');
});

test('downscalePng: a non-positive maxEdge is rejected without scaling', () => {
  const r = downscalePng(makePng(10, 10), 0);
  assert.equal(r.scaled, false);
  assert.equal(r.reason, 'no target size');
});

test('downscalePng: an image already within the cap is left as-is and never upscaled', () => {
  const png = makePng(10, 10);
  const r = downscalePng(png, 100);
  assert.equal(r.scaled, false);
  assert.equal(r.reason, 'already within target');
  assert.equal(r.width, 10);
  assert.equal(r.height, 10);
  assert.equal(r.buf, png); // same buffer, untouched
});

test('downscalePng: shrinks an RGB image so the longest edge hits the cap', () => {
  const r = downscalePng(makePng(100, 40, { colorType: 2 }), 10);
  assert.equal(r.scaled, true);
  assert.equal(r.width, 10); // 100 * (10/100)
  assert.equal(r.height, 4); //  40 * (10/100)
  assert.equal(r.origWidth, 100);
  assert.equal(r.origHeight, 40);
  assert.ok(r.buf.subarray(0, 8).equals(PNG_SIG));
  assert.notEqual(r.buf, makePng(100, 40)); // a freshly encoded buffer
});

test('downscalePng: the re-encoded PNG round-trips through the same decoder', () => {
  const first = downscalePng(makePng(100, 40), 10);
  const second = downscalePng(first.buf, 1000);
  // Feeding the output back in: it parses, and is already within the larger cap.
  assert.equal(second.reason, 'already within target');
  assert.equal(second.width, 10);
  assert.equal(second.height, 4);
});

test('downscalePng: handles grayscale (1 channel) and RGBA (4 channels)', () => {
  const gray = downscalePng(makePng(80, 40, { colorType: 0 }), 10);
  assert.equal(gray.scaled, true);
  assert.equal(gray.width, 10);
  assert.equal(gray.height, 5);

  const rgba = downscalePng(makePng(100, 40, { colorType: 6 }), 10);
  assert.equal(rgba.scaled, true);
  assert.equal(rgba.width, 10);
  assert.equal(rgba.height, 4);
});

test('downscalePng: a palette PNG is reported unsupported and left full-size', () => {
  const r = downscalePng(makePng(100, 40, { colorType: 3 }), 10);
  assert.equal(r.scaled, false);
  assert.ok(r.reason?.startsWith('unsupported'));
  assert.equal(r.width, 100);
  assert.equal(r.height, 40);
});

test('downscalePng: a 16-bit PNG is reported unsupported and left full-size', () => {
  const r = downscalePng(makePng(100, 40, { colorType: 2, bitDepth: 16 }), 10);
  assert.equal(r.scaled, false);
  assert.ok(r.reason?.startsWith('unsupported'));
});
