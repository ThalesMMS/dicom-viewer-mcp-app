/**
 * @file Client-side types shared by the viewer modules.
 */
import type { PixelFormat } from "../../shared/protocol";

export type GrayPixels = Uint8Array | Uint16Array | Int16Array;

/** A slice after base64 + inflate decoding, ready for rendering. */
export interface DecodedSlice {
  index: number;
  rows: number;
  columns: number;
  pixelFormat: PixelFormat;
  rescaleSlope: number;
  rescaleIntercept: number;
  invert: boolean;
  /**
   * Grayscale: one sample per pixel. "rgb8": 3 interleaved bytes per pixel.
   */
  pixels: GrayPixels;
  /** Smallest / largest stored sample (grayscale only; 0 / 255 for rgb8). */
  minStored: number;
  maxStored: number;
  /** Memory footprint, used by the cache budget. */
  byteLength: number;
}

/** Pan/zoom state. `zoom` multiplies the fit-to-viewport scale. */
export interface ViewTransform {
  zoom: number;
  /** CSS pixels, relative to the centred position. */
  panX: number;
  panY: number;
}

export type ToolMode = "window" | "pan" | "zoom";
