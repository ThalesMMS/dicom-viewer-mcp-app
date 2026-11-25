/**
 * @file Canvas renderer: windowed slice -> offscreen image-sized canvas ->
 * visible device-pixel canvas with pan/zoom. The offscreen remap only runs
 * when the slice, window or inversion changes; pan/zoom just redraws.
 */
import type { WindowLevel } from "../../shared/protocol";
import { drawRect, type ImageGeometry } from "./geometry";
import { LutCache, applyGrayLut, rgbToRgba } from "./lut";
import type { DecodedSlice, ViewTransform } from "./types";

export interface RenderInput {
  slice: DecodedSlice | undefined;
  window: WindowLevel;
  /** User inversion toggle, XORed with the slice's MONOCHROME1 flag. */
  invert: boolean;
  transform: ViewTransform;
  pixelSpacing?: readonly [number, number];
  cssWidth: number;
  cssHeight: number;
}

export interface RenderResult {
  /** True when one image pixel covers more than one device pixel. */
  magnified: boolean;
}

export class SliceRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D | null;
  private imageData: ImageData | null = null;
  private lastSlice: DecodedSlice | undefined;
  private lastKey = "";
  private readonly luts = new LutCache();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.offscreen = document.createElement("canvas");
    this.offCtx = this.offscreen.getContext("2d", { willReadFrequently: false });
  }

  render(input: RenderInput): RenderResult {
    const { ctx } = this;
    const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    const pw = Math.max(1, Math.round(input.cssWidth * dpr));
    const ph = Math.max(1, Math.round(input.cssHeight * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    if (!ctx) return { magnified: false };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, pw, ph);
    const slice = input.slice;
    if (!slice || !this.remap(slice, input.window, input.invert)) return { magnified: false };

    const geom: ImageGeometry = {
      columns: slice.columns,
      rows: slice.rows,
      pixelSpacing: input.pixelSpacing,
    };
    const r = drawRect(input.cssWidth, input.cssHeight, geom, input.transform);
    const magnified = Math.min(r.sx, r.sy) * dpr > 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = !magnified;
    if (!magnified) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.offscreen, r.x, r.y, r.width, r.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { magnified };
  }

  /** Updates the offscreen canvas if needed; false if nothing can be drawn. */
  private remap(slice: DecodedSlice, win: WindowLevel, userInvert: boolean): boolean {
    const offCtx = this.offCtx;
    if (!offCtx) return false;
    const isRgb = slice.pixelFormat === "rgb8";
    const invert = userInvert !== slice.invert;
    const key = isRgb ? "rgb" : `${win.center}|${win.width}|${invert ? 1 : 0}`;
    if (slice === this.lastSlice && key === this.lastKey) return true;

    if (
      !this.imageData ||
      this.imageData.width !== slice.columns ||
      this.imageData.height !== slice.rows
    ) {
      this.imageData = new ImageData(slice.columns, slice.rows);
      this.offscreen.width = slice.columns;
      this.offscreen.height = slice.rows;
    }
    const out = this.imageData.data;
    if (slice.pixelFormat === "rgb8") {
      rgbToRgba(slice.pixels as Uint8Array, out);
    } else {
      const lut = this.luts.get({
        format: slice.pixelFormat,
        slope: slice.rescaleSlope,
        intercept: slice.rescaleIntercept,
        window: win,
        invert,
      });
      applyGrayLut(slice.pixels, lut, out);
    }
    offCtx.putImageData(this.imageData, 0, 0);
    this.lastSlice = slice;
    this.lastKey = key;
    return true;
  }
}
