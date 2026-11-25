/**
 * Minimal PNG encoder (8-bit grayscale and 8-bit RGB, non-interlaced) with no
 * native dependencies. Uses `node:zlib` for the IDAT stream and its own CRC-32
 * table (zlib.crc32 only exists from Node 22.2 / 20.15).
 */
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309 / PNG), optionally continuing from a previous value. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Applies a per-row adaptive filter (minimum sum of absolute differences,
 * the heuristic recommended by the PNG spec) and returns the filtered stream.
 */
function filterRows(pixels: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  const zeroRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : zeroRow;
    let bestType = 0;
    let bestScore = Infinity;

    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        let predictor = 0;
        switch (type) {
          case 1: predictor = left; break;
          case 2: predictor = up; break;
          case 3: predictor = (left + up) >>> 1; break;
          case 4: predictor = paeth(left, up, upLeft); break;
        }
        const value = (row[i] - predictor) & 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }

    const offset = y * (stride + 1);
    out[offset] = bestType;
    out.set(best, offset + 1);
  }
  return out;
}

/**
 * Encodes 8-bit samples as a PNG.
 *
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param channels - 1 (grayscale) or 3 (RGB, interleaved).
 * @param pixels - `width * height * channels` bytes, row-major.
 */
export function encodePng(
  width: number,
  height: number,
  channels: 1 | 3,
  pixels: Uint8Array,
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid PNG dimensions ${width}x${height}`);
  }
  const stride = width * channels;
  if (pixels.length !== stride * height) {
    throw new RangeError(
      `PNG pixel buffer has ${pixels.length} bytes; expected ${stride * height}`,
    );
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2; // color type: grayscale / truecolor
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = deflateSync(filterRows(pixels, stride, height, channels));

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
