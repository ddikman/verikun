import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inflateSync } from 'node:zlib';
import { pngFromRaw, downscalePng, type RawImage } from '../src/image';
import { capturePng } from '../src/capture';
import type { Driver } from '../src/types';
import { makePng } from './helpers';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An RGBA image whose every pixel encodes its own coordinates, so a resample that
 *  transposes or shifts the buffer produces visibly wrong values rather than a
 *  plausible-looking blur. */
function rawImage(width: number, height: number, ch = 4): RawImage {
  const pixels = Buffer.alloc(width * height * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      for (let c = 0; c < ch; c++) pixels[o + c] = (x * 7 + y * 13 + c * 29) % 256;
    }
  }
  return { width, height, ch, pixels };
}

/** Decode a PNG this module produced back to its IHDR + unfiltered pixel rows.
 *  Every row uses filter type 0 (applyNoneFilter), so dropping the leading filter
 *  byte per row is a complete inverse. */
function decode(png: Buffer): { width: number; height: number; colorType: number; rows: Buffer[] } {
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'expected a PNG signature');
  let off = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    if (type === 'IHDR') {
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      bitDepth = png[start + 8];
      colorType = png[start + 9];
    } else if (type === 'IDAT') idat.push(png.subarray(start, start + len));
    else if (type === 'IEND') break;
    off = start + len + 4;
  }
  assert.equal(bitDepth, 8);
  const ch = colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
  const flat = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * ch;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    assert.equal(flat[y * stride], 0, 'expected filter type 0 on every row');
    rows.push(flat.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, colorType, rows };
}

test('pngFromRaw: encodes at full size when maxEdge is null', () => {
  const img = rawImage(8, 5);
  const r = pngFromRaw(img, null);
  assert.equal(r.scaled, false);
  assert.deepEqual([r.width, r.height], [8, 5]);
  const png = decode(r.buf);
  assert.deepEqual([png.width, png.height], [8, 5]);
  // Pixels must survive the round trip byte-for-byte — this is the channel-order guard.
  assert.ok(Buffer.concat(png.rows).equals(img.pixels));
});

test('pngFromRaw: downscales to the cap and reports both sizes', () => {
  const r = pngFromRaw(rawImage(200, 100), 50);
  assert.equal(r.scaled, true);
  assert.deepEqual([r.width, r.height], [50, 25]);
  assert.deepEqual([r.origWidth, r.origHeight], [200, 100]);
  assert.deepEqual([decode(r.buf).width, decode(r.buf).height], [50, 25]);
});

test('pngFromRaw: never upscales an image already within the cap', () => {
  const r = pngFromRaw(rawImage(10, 10), 700);
  assert.equal(r.scaled, false);
  assert.equal(r.reason, 'already within target');
  assert.deepEqual([r.width, r.height], [10, 10]);
});

test('pngFromRaw: a non-positive cap encodes full size rather than producing nothing', () => {
  const r = pngFromRaw(rawImage(10, 10), 0);
  assert.equal(r.scaled, false);
  assert.equal(r.reason, 'no target size');
  assert.deepEqual([decode(r.buf).width, decode(r.buf).height], [10, 10]);
});

test('pngFromRaw: channel count picks the matching PNG color type', () => {
  // 1 -> gray(0), 2 -> gray+alpha(4), 3 -> RGB(2), 4 -> RGBA(6)
  for (const [ch, colorType] of [[1, 0], [2, 4], [3, 2], [4, 6]] as const) {
    const r = pngFromRaw(rawImage(4, 4, ch), null);
    assert.equal(decode(r.buf).colorType, colorType, `ch=${ch}`);
  }
});

/** A Driver stub exposing only what capturePng touches. */
function fakeDriver(over: Partial<Driver>): Driver {
  return over as Driver;
}

test('capturePng: prefers the raw path when the driver offers one', () => {
  let pngCalls = 0;
  const res = capturePng(
    fakeDriver({
      screenshotRaw: () => rawImage(200, 100),
      screenshot: () => { pngCalls++; return makePng(200, 100); },
    }),
    50,
  );
  assert.equal(pngCalls, 0, 'the PNG path must not be touched when raw succeeded');
  assert.equal(res.scaled, true);
  assert.deepEqual([res.width, res.height], [50, 25]);
});

test('capturePng: falls back to the PNG path when the driver has no raw capture', () => {
  const res = capturePng(fakeDriver({ screenshot: () => makePng(200, 100) }), 50);
  assert.equal(res.scaled, true);
  assert.deepEqual([res.width, res.height], [50, 25]);
});

test('capturePng: a raw capture the driver could not make sense of falls back, it does not throw', () => {
  const png = makePng(200, 100);
  const res = capturePng(fakeDriver({ screenshotRaw: () => null, screenshot: () => png }), 50);
  assert.equal(res.scaled, true);
  assert.deepEqual([res.width, res.height], [50, 25]);
});

test('capturePng: full size over the fallback path returns the device PNG untouched', () => {
  const png = makePng(200, 100);
  const res = capturePng(fakeDriver({ screenshot: () => png }), null);
  assert.equal(res.scaled, false);
  assert.equal(res.buf, png, 'a full-size fallback must not re-encode the capture');
});

test('capturePng: raw and PNG paths agree on the final image', () => {
  // The property that makes the raw path safe to prefer: same input pixels in,
  // same PNG out, whichever route they took. Verified byte-for-byte on-device too.
  const img = rawImage(120, 60);
  const viaRaw = pngFromRaw(img, 30);
  const viaPng = downscalePng(pngFromRaw(img, null).buf, 30);
  assert.ok(viaRaw.buf.equals(viaPng.buf));
});
