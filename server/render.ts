/**
 * Server-side rendering of a decoded slice to an 8-bit PNG (the key image
 * attached to view-dicom results so the model can see the exam).
 */
import type { WindowLevel } from "../shared/protocol.js";
import type { DecodedFrame } from "./dicom.js";
import { encodePng } from "./png.js";

/**
 * DICOM linear VOI function (PS3.3 C.11.2.1.2.1) to the 0..255 range.
 * Requires width >= 1 (the caller guarantees it).
 */
export function linearWindow(x: number, center: number, width: number): number {
  const c = center - 0.5;
  const w = width - 1;
  const half = w / 2;
  if (x <= c - half) return 0;
  if (x > c + half) return 255;
  const y = ((x - c) / w + 0.5) * 255;
  return y <= 0 ? 0 : y >= 255 ? 255 : Math.round(y);
}

export interface RenderOptions {
  window: WindowLevel;
  rescaleSlope: number;
  rescaleIntercept: number;
  /** MONOCHROME1: invert after windowing. */
  invert: boolean;
}

/**
 * Applies modality rescale, the VOI window and (for MONOCHROME1) inversion.
 * Returns 1 byte per pixel for grayscale, 3 for rgb8 (window applied per channel).
 */
export function renderWindowed(frame: DecodedFrame, options: RenderOptions): Uint8Array {
  const center = options.window.center;
  const width = Math.max(1, options.window.width);
  const { samples } = frame;

  if (frame.format === "rgb8") {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = linearWindow(v, center, width);
    const out = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = lut[samples[i]];
    return out;
  }

  const out = new Uint8Array(samples.length);
  const { rescaleSlope: slope, rescaleIntercept: intercept, invert } = options;
  for (let i = 0; i < samples.length; i++) {
    const value = linearWindow(samples[i] * slope + intercept, center, width);
    out[i] = invert ? 255 - value : value;
  }
  return out;
}

/**
 * Area-averaging resampler for 8-bit images (box filter when shrinking,
 * nearest neighbour when a dimension grows).
 */
export function resample(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  if (outWidth === width && outHeight === height) return pixels;
  const out = new Uint8Array(outWidth * outHeight * channels);
  const sx = width / outWidth;
  const sy = height / outHeight;
  const sums = new Float64Array(channels);

  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = Math.min(height - 1, Math.floor(oy * sy));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((oy + 1) * sy)));
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = Math.min(width - 1, Math.floor(ox * sx));
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((ox + 1) * sx)));
      sums.fill(0);
      for (let y = y0; y < y1; y++) {
        let index = (y * width + x0) * channels;
        for (let x = x0; x < x1; x++) {
          for (let c = 0; c < channels; c++) sums[c] += pixels[index + c];
          index += channels;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const target = (oy * outWidth + ox) * channels;
      for (let c = 0; c < channels; c++) out[target + c] = Math.round(sums[c] / count);
    }
  }
  return out;
}

/**
 * Output size whose longest side is at most `maxSide`, correcting for
 * non-square pixels when the pixel spacing is known.
 */
export function keyImageSize(
  rows: number,
  columns: number,
  pixelSpacing: [number, number] | undefined,
  maxSide: number,
): { width: number; height: number } {
  let width = columns;
  let height = rows;
  if (pixelSpacing && pixelSpacing[0] > 0 && pixelSpacing[1] > 0 && pixelSpacing[0] !== pixelSpacing[1]) {
    // pixelSpacing = [row spacing (vertical), column spacing (horizontal)].
    const aspect = (columns * pixelSpacing[1]) / (rows * pixelSpacing[0]);
    if (aspect >= 1) {
      width = columns;
      height = Math.max(1, Math.round(columns / aspect));
    } else {
      height = rows;
      width = Math.max(1, Math.round(rows * aspect));
    }
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface KeyImage {
  png: Buffer;
  width: number;
  height: number;
}

export function renderKeyImage(
  frame: DecodedFrame,
  options: RenderOptions & { pixelSpacing?: [number, number]; maxSide?: number },
): KeyImage {
  const channels = frame.format === "rgb8" ? 3 : 1;
  const windowed = renderWindowed(frame, options);
  const { width, height } = keyImageSize(frame.rows, frame.columns, options.pixelSpacing, options.maxSide ?? 512);
  const scaled = resample(windowed, frame.columns, frame.rows, channels, width, height);
  return { png: encodePng(width, height, channels, scaled), width, height };
}
