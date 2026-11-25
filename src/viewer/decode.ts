/**
 * @file Decoding of `SlicePixels` payloads: base64 -> zlib inflate -> typed
 * array. Works in browsers and in Node (both provide `atob`,
 * `DecompressionStream` and `Response`).
 */
import type { PixelFormat, SlicePixels } from "../../shared/protocol";
import type { DecodedSlice, GrayPixels } from "./types";

type FromBase64 = (input: string) => Uint8Array<ArrayBuffer>;

/** Decodes standard base64 (whitespace tolerated) into bytes. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[\s]/g, "");
  const native = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64;
  if (typeof native === "function") {
    return native(clean);
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Inflates zlib (RFC 1950) data with the platform DecompressionStream. */
export async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export function bytesPerSample(format: PixelFormat): number {
  switch (format) {
    case "uint8":
      return 1;
    case "uint16":
    case "int16":
      return 2;
    case "rgb8":
      return 3;
  }
}

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Interprets little-endian sample bytes as the typed array for `format`.
 * The result never aliases a misaligned buffer: 16-bit data is copied into a
 * fresh buffer when needed (and byte-swapped on big-endian hosts).
 */
export function toTypedArray(bytes: Uint8Array, format: PixelFormat, pixelCount: number): GrayPixels {
  const expected = pixelCount * bytesPerSample(format);
  if (bytes.byteLength < expected) {
    throw new Error(`Pixel data too short: expected ${expected} bytes, got ${bytes.byteLength}`);
  }
  if (format === "uint8" || format === "rgb8") {
    return bytes.byteLength === expected ? bytes : bytes.slice(0, expected);
  }
  const Ctor = format === "uint16" ? Uint16Array : Int16Array;
  if (!LITTLE_ENDIAN_HOST) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, expected);
    const out = new Ctor(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      out[i] = format === "uint16" ? view.getUint16(i * 2, true) : view.getInt16(i * 2, true);
    }
    return out;
  }
  if (bytes.byteOffset % 2 === 0 && bytes.buffer instanceof ArrayBuffer) {
    return new Ctor(bytes.buffer, bytes.byteOffset, pixelCount);
  }
  // Misaligned or shared: copy into an aligned buffer.
  return new Ctor(bytes.slice(0, expected).buffer);
}

export function sampleRange(pixels: GrayPixels, format: PixelFormat): { min: number; max: number } {
  if (format === "rgb8" || pixels.length === 0) return { min: 0, max: 255 };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Full decode of one wire slice. */
export async function decodeSlice(slice: SlicePixels): Promise<DecodedSlice> {
  const pixelCount = slice.rows * slice.columns;
  if (!Number.isInteger(pixelCount) || pixelCount <= 0) {
    throw new Error(`Invalid slice dimensions ${slice.columns}x${slice.rows}`);
  }
  const raw = await inflate(base64ToBytes(slice.data));
  const pixels = toTypedArray(raw, slice.pixelFormat, pixelCount);
  const { min, max } = sampleRange(pixels, slice.pixelFormat);
  const isRgb = slice.pixelFormat === "rgb8";
  return {
    index: slice.index,
    rows: slice.rows,
    columns: slice.columns,
    pixelFormat: slice.pixelFormat,
    rescaleSlope: isRgb || !Number.isFinite(slice.rescaleSlope) || slice.rescaleSlope === 0 ? 1 : slice.rescaleSlope,
    rescaleIntercept: isRgb || !Number.isFinite(slice.rescaleIntercept) ? 0 : slice.rescaleIntercept,
    invert: !isRgb && slice.invert === true,
    pixels,
    minStored: min,
    maxStored: max,
    byteLength: pixels.byteLength,
  };
}

/** Range of rescaled (display) values of a grayscale slice. */
export function rescaledRange(slice: DecodedSlice): { min: number; max: number } {
  const a = slice.minStored * slice.rescaleSlope + slice.rescaleIntercept;
  const b = slice.maxStored * slice.rescaleSlope + slice.rescaleIntercept;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
