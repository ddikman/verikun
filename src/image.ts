// Hand-rolled, dependency-free PNG downscaler.
//
// A device screenshot is ~1080×2400; an agent reading that image pays for its
// pixel area in tokens. Downscaling to a smaller longest edge keeps UI text
// legible while cutting that cost markedly. We do it in pure Node — decode the
// PNG, box-average the pixels, re-encode — using only `node:zlib` (a builtin),
// honoring the project's zero-runtime-dependency rule.
//
// Scope: 8-bit, non-interlaced PNGs in grayscale / RGB / gray+alpha / RGBA
// (color types 0/2/4/6) — what `screencap` and `simctl` emit. Anything else
// (palette, 16-bit, interlaced) is left untouched and reported via `reason`,
// so a screenshot is never corrupted, only (sometimes) not shrunk.

import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ScaleResult {
  /** The PNG to write — downscaled when `scaled`, otherwise the original input. */
  buf: Buffer;
  /** Final dimensions (== original when not scaled; 0 when the input wasn't a parseable PNG). */
  width: number;
  height: number;
  scaled: boolean;
  origWidth: number;
  origHeight: number;
  /** Why scaling was skipped (already small / unsupported format / not a PNG). */
  reason?: string;
}

/** Channel count for a supported PNG color type, or 0 if unsupported (e.g. palette). */
function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // RGB
    case 4: return 2; // gray + alpha
    case 6: return 4; // RGBA
    default: return 0; // 3 = palette, etc. — unsupported
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverse PNG per-scanline filtering into packed pixels (height*width*channels bytes). */
function unfilter(data: Buffer, width: number, height: number, ch: number): Buffer {
  const stride = width * ch;
  const raw = Buffer.alloc(height * stride);
  let pos = 0;
  let prev = Buffer.alloc(stride); // row above the first row is all zeros
  for (let y = 0; y < height; y++) {
    const ft = data[pos++];
    const cur = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const filt = data[pos++];
      const a = x >= ch ? cur[x - ch] : 0; // left
      const b = prev[x]; // above
      const c = x >= ch ? prev[x - ch] : 0; // above-left
      let val: number;
      switch (ft) {
        case 1: val = filt + a; break; // Sub
        case 2: val = filt + b; break; // Up
        case 3: val = filt + ((a + b) >> 1); break; // Average
        case 4: val = filt + paeth(a, b, c); break; // Paeth
        default: val = filt; break; // None (0) / unknown
      }
      cur[x] = val & 0xff;
    }
    prev = cur;
  }
  return raw;
}

/** Box-average downscale of packed pixels from (sw,sh) to (tw,th). */
function boxDownscale(src: Buffer, sw: number, sh: number, tw: number, th: number, ch: number): Buffer {
  const dst = Buffer.alloc(tw * th * ch);
  const acc = new Array(ch);
  for (let dy = 0; dy < th; dy++) {
    const sy0 = Math.floor((dy * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / th));
    for (let dx = 0; dx < tw; dx++) {
      const sx0 = Math.floor((dx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / tw));
      acc.fill(0);
      for (let sy = sy0; sy < sy1; sy++) {
        let p = (sy * sw + sx0) * ch;
        for (let sx = sx0; sx < sx1; sx++) {
          for (let k = 0; k < ch; k++) acc[k] += src[p + k];
          p += ch;
        }
      }
      const count = (sy1 - sy0) * (sx1 - sx0);
      const d = (dy * tw + dx) * ch;
      for (let k = 0; k < ch; k++) dst[d + k] = Math.round(acc[k] / count);
    }
  }
  return dst;
}

/** Prepend a None (0) filter byte to each scanline, ready for deflate. */
function applyNoneFilter(raw: Buffer, w: number, h: number, ch: number): Buffer {
  const stride = w * ch;
  const out = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    out[y * (stride + 1)] = 0;
    raw.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return out;
}

// CRC-32 (IEEE) for chunk integrity. node:zlib.crc32 only exists on newer Node,
// and the project targets Node ≥ 18, so we keep our own tiny table.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPng(w: number, h: number, bitDepth: number, colorType: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  // compression, filter, interlace methods are all 0 (the only standard values)
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Downscale a PNG so its longest edge is at most `maxEdge` px (never upscales).
 * Returns the original buffer unchanged when it is already small enough or is in
 * an unsupported PNG form; `reason` explains which.
 */
export function downscalePng(input: Buffer, maxEdge: number): ScaleResult {
  const asis = (width: number, height: number, reason: string): ScaleResult => ({
    buf: input, width, height, scaled: false, origWidth: width, origHeight: height, reason,
  });

  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIG)) return asis(0, 0, 'not a PNG');
  if (!(maxEdge >= 1)) return asis(0, 0, 'no target size');

  // Walk chunks for IHDR + concatenated IDAT.
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let haveIhdr = false;
  const idat: Buffer[] = [];
  let off = 8;
  while (off + 8 <= input.length) {
    const len = input.readUInt32BE(off);
    const type = input.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    if (start + len > input.length) break; // truncated
    if (type === 'IHDR' && len >= 13) {
      width = input.readUInt32BE(start);
      height = input.readUInt32BE(start + 4);
      bitDepth = input[start + 8];
      colorType = input[start + 9];
      interlace = input[start + 12];
      haveIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(input.subarray(start, start + len));
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4; // +4 skips the chunk CRC
  }

  if (!haveIhdr || width < 1 || height < 1) return asis(width, height, 'no IHDR');
  const ch = channelsFor(colorType);
  if (bitDepth !== 8 || interlace !== 0 || ch === 0) {
    return asis(width, height, 'unsupported PNG format (need 8-bit, non-interlaced, non-palette)');
  }
  if (Math.max(width, height) <= maxEdge) return asis(width, height, 'already within target');

  let raw: Buffer;
  try {
    const inflated = inflateSync(Buffer.concat(idat));
    if (inflated.length < height * (1 + width * ch)) return asis(width, height, 'short pixel data');
    raw = unfilter(inflated, width, height, ch);
  } catch {
    return asis(width, height, 'could not decode pixel data');
  }

  const scale = maxEdge / Math.max(width, height);
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const small = boxDownscale(raw, width, height, tw, th, ch);
  const idatOut = deflateSync(applyNoneFilter(small, tw, th, ch));
  return {
    buf: buildPng(tw, th, bitDepth, colorType, idatOut),
    width: tw, height: th, scaled: true, origWidth: width, origHeight: height,
  };
}
