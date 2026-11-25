/**
 * @file View geometry: fit-to-viewport with non-square pixels, zooming
 * around an anchor, and scale-bar sizing. All lengths are CSS pixels.
 */
import type { ViewTransform } from "./types";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 40;

export const IDENTITY_TRANSFORM: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

export interface ImageGeometry {
  columns: number;
  rows: number;
  /** [row spacing, column spacing] in mm (DICOM PixelSpacing order). */
  pixelSpacing?: readonly [number, number];
}

/** Vertical stretch so that one row is as tall as `rowSpacing / colSpacing` columns are wide. */
export function pixelAspect(spacing: readonly [number, number] | undefined): number {
  if (!spacing) return 1;
  const [rowSp, colSp] = spacing;
  if (!(rowSp > 0) || !(colSp > 0)) return 1;
  return rowSp / colSp;
}

/** CSS px per image column / row at zoom 1 (fit to viewport). */
export function fitScale(
  viewportWidth: number,
  viewportHeight: number,
  image: ImageGeometry,
): { sx: number; sy: number } {
  const aspect = pixelAspect(image.pixelSpacing);
  if (viewportWidth <= 0 || viewportHeight <= 0 || image.columns <= 0 || image.rows <= 0) {
    return { sx: 1, sy: aspect };
  }
  const s = Math.min(viewportWidth / image.columns, viewportHeight / (image.rows * aspect));
  return { sx: s, sy: s * aspect };
}

export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS px per image column at this zoom. */
  sx: number;
  sy: number;
}

export function drawRect(
  viewportWidth: number,
  viewportHeight: number,
  image: ImageGeometry,
  t: ViewTransform,
): DrawRect {
  const fit = fitScale(viewportWidth, viewportHeight, image);
  const sx = fit.sx * t.zoom;
  const sy = fit.sy * t.zoom;
  const width = image.columns * sx;
  const height = image.rows * sy;
  return {
    x: (viewportWidth - width) / 2 + t.panX,
    y: (viewportHeight - height) / 2 + t.panY,
    width,
    height,
    sx,
    sy,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Multiplies the zoom by `factor`, keeping the image point under the anchor
 * fixed. The anchor is given relative to the viewport centre.
 */
export function zoomAbout(
  t: ViewTransform,
  factor: number,
  anchorX: number,
  anchorY: number,
): ViewTransform {
  const zoom = clampZoom(t.zoom * factor);
  const k = zoom / t.zoom;
  return {
    zoom,
    panX: anchorX - (anchorX - t.panX) * k,
    panY: anchorY - (anchorY - t.panY) * k,
  };
}

export interface ScaleBar {
  /** Physical length in mm. */
  mm: number;
  /** On-screen length in CSS px. */
  px: number;
  label: string;
}

const NICE_STEPS = [1, 2, 5];

/**
 * Picks a 1/2/5 x 10^n mm length whose on-screen size is at most `maxPx`
 * (and preferably at least `minPx`).
 */
export function scaleBar(mmPerPx: number, maxPx: number, minPx = 24): ScaleBar | null {
  if (!(mmPerPx > 0) || !(maxPx > 0)) return null;
  const maxMm = mmPerPx * maxPx;
  let best: number | null = null;
  for (let exp = -2; exp <= 4; exp++) {
    for (const step of NICE_STEPS) {
      const mm = step * 10 ** exp;
      if (mm <= maxMm) best = mm;
    }
  }
  if (best === null) return null;
  const px = best / mmPerPx;
  if (px < minPx) return null;
  const mm = Number(best.toPrecision(3));
  const label = mm >= 10 ? `${mm / 10} cm` : `${mm} mm`;
  return { mm, px, label };
}
