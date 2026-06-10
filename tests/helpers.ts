// Shared fixtures for the unit tests. This file lives in tests/ (plural) and has
// no `.test.` infix, so `node --test` does not treat it as a test file — it is
// only imported by the real test files.

import { deflateSync } from 'node:zlib';
import { Bounds, Element } from '../src/types';

/**
 * Build a normalized Element with sensible defaults, overriding only the fields a
 * test cares about. `center` defaults to the middle of `bounds` (matching what the
 * parser computes) unless explicitly supplied.
 */
export function makeEl(overrides: Partial<Element> = {}): Element {
  const bounds: Bounds = overrides.bounds ?? { x1: 0, y1: 0, x2: 100, y2: 50 };
  const base: Element = {
    index: 0,
    class: 'android.widget.TextView',
    type: 'TextView',
    id: '',
    idShort: '',
    text: '',
    desc: '',
    bounds,
    center: { x: Math.floor((bounds.x1 + bounds.x2) / 2), y: Math.floor((bounds.y1 + bounds.y2) / 2) },
    depth: 0,
    clickable: false,
    longClickable: false,
    checkable: false,
    checked: false,
    focusable: false,
    focused: false,
    scrollable: false,
    enabled: true,
    selected: false,
    password: false,
  };
  const el = { ...base, ...overrides };
  el.bounds = bounds;
  el.center = overrides.center ?? base.center;
  return el;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // downscalePng never validates chunk CRCs (it skips them), so zeros are fine.
  const crc = Buffer.alloc(4);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

const channelsFor = (colorType: number): number =>
  colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 3;

/**
 * Synthesize a minimal but real PNG: signature + IHDR + a single deflated IDAT
 * (None-filtered gradient scanlines) + IEND. Enough for downscalePng to parse,
 * inflate, unfilter, and re-encode. For unsupported color/bit configurations the
 * pixel bytes are irrelevant — downscalePng rejects them before decoding.
 */
export function makePng(
  width: number,
  height: number,
  opts: { colorType?: number; bitDepth?: number } = {},
): Buffer {
  const colorType = opts.colorType ?? 2; // 2 = RGB
  const bitDepth = opts.bitDepth ?? 8;
  const ch = channelsFor(colorType);
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stride = width * ch * bytesPerSample;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rawWithFilter = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawWithFilter[y * (stride + 1)] = 0; // None filter
    for (let x = 0; x < stride; x++) {
      rawWithFilter[y * (stride + 1) + 1 + x] = (x + y) & 0xff;
    }
  }

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rawWithFilter)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
