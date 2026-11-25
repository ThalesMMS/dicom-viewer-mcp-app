/**
 * @file Window/level lookup tables.
 *
 * Grayscale rendering maps every stored sample through
 * `value * slope + intercept` -> DICOM linear VOI window -> 8 bit -> optional
 * inversion. Because 8/16-bit samples have at most 65536 distinct values, the
 * whole chain is precomputed into one table per (format, slope, intercept,
 * window, invert); rendering then costs one lookup per pixel.
 */
import type { PixelFormat, WindowLevel } from "../../shared/protocol";
import type { GrayPixels } from "./types";

/**
 * DICOM PS3.3 C.11.2.1.2.1 linear window function, output 0..255.
 * Widths below 1 are treated as 1 (a hard threshold at `center - 0.5`).
 */
export function applyWindow(x: number, center: number, width: number): number {
  const w = Math.max(1, width);
  const c = center - 0.5;
  const half = (w - 1) / 2;
  if (x <= c - half) return 0;
  if (x > c + half) return 255;
  if (w === 1) return 255;
  const y = ((x - c) / (w - 1) + 0.5) * 255;
  return Math.round(Math.min(255, Math.max(0, y)));
}

/** Index offset and size of the stored-value domain of a grayscale format. */
export function lutDomain(format: Exclude<PixelFormat, "rgb8">): { offset: number; size: number } {
  switch (format) {
    case "uint8":
      return { offset: 0, size: 256 };
    case "uint16":
      return { offset: 0, size: 65536 };
    case "int16":
      return { offset: 32768, size: 65536 };
  }
}

export interface LutParams {
  format: Exclude<PixelFormat, "rgb8">;
  slope: number;
  intercept: number;
  window: WindowLevel;
  invert: boolean;
}

export interface WindowLut {
  /** Gray level 0..255 for `stored + offset`. */
  gray: Uint8Array;
  offset: number;
}

export function buildWindowLut(p: LutParams): WindowLut {
  const { offset, size } = lutDomain(p.format);
  const gray = new Uint8Array(size);
  const { center, width } = p.window;
  for (let i = 0; i < size; i++) {
    const value = (i - offset) * p.slope + p.intercept;
    const g = applyWindow(value, center, width);
    gray[i] = p.invert ? 255 - g : g;
  }
  return { gray, offset };
}

function lutKey(p: LutParams): string {
  return `${p.format}|${p.slope}|${p.intercept}|${p.window.center}|${p.window.width}|${p.invert ? 1 : 0}`;
}

/** Tiny memo so W/L drags and slice scrolling reuse tables. */
export class LutCache {
  private readonly entries = new Map<string, WindowLut>();
  constructor(private readonly capacity = 6) {}

  get(p: LutParams): WindowLut {
    const key = lutKey(p);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const lut = buildWindowLut(p);
    this.entries.set(key, lut);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return lut;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Writes RGBA pixels (`out.length === 4 * pixels.length`) through a LUT. */
export function applyGrayLut(pixels: GrayPixels, lut: WindowLut, out: Uint8ClampedArray): void {
  const { gray, offset } = lut;
  const n = pixels.length;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = gray[pixels[i] + offset];
    out[j] = g;
    out[j + 1] = g;
    out[j + 2] = g;
    out[j + 3] = 255;
  }
}

/** Copies interleaved RGB bytes into RGBA. */
export function rgbToRgba(rgb: Uint8Array, out: Uint8ClampedArray): void {
  const n = rgb.length / 3;
  for (let i = 0, s = 0, j = 0; i < n; i++, s += 3, j += 4) {
    out[j] = rgb[s];
    out[j + 1] = rgb[s + 1];
    out[j + 2] = rgb[s + 2];
    out[j + 3] = 255;
  }
}

/**
 * W/L drag sensitivity in display units per CSS pixel: dragging ~500 px
 * sweeps the full data range.
 */
export function windowDragRate(dataRange: number): number {
  const range = Number.isFinite(dataRange) && dataRange > 0 ? dataRange : 256;
  return Math.max(range / 500, 0.05);
}

/** Applies a W/L drag delta (horizontal = width, vertical = center). */
export function dragWindow(start: WindowLevel, dx: number, dy: number, rate: number): WindowLevel {
  return {
    width: Math.max(1, start.width + dx * rate),
    center: start.center + dy * rate,
  };
}

export function sameWindow(a: WindowLevel, b: WindowLevel, tolerance = 0.5): boolean {
  return Math.abs(a.center - b.center) <= tolerance && Math.abs(a.width - b.width) <= tolerance;
}
