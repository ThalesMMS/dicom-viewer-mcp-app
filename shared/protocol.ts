/**
 * @file Data contract shared by the MCP server (server.ts, server/**) and the
 * viewer UI (src/**). Both sides import these types and constants; changing a
 * shape here changes the wire format.
 *
 * This file must stay free of Node-only and DOM-only imports.
 */

/** Model-visible tool: selects a series and opens the viewer. */
export const VIEW_TOOL_NAME = "view-dicom";
/** App-only tool (hidden from the model): the UI calls it to page pixel data. */
export const SLICES_TOOL_NAME = "get-dicom-slices";
/** ui:// resource holding the static viewer HTML. */
export const VIEWER_RESOURCE_URI = "ui://view-dicom/mcp-app.html";

/** Upper bound for `count` in a single get-dicom-slices call. */
export const MAX_SLICES_PER_REQUEST = 8;

/**
 * Sample layout of a decoded slice:
 * - "uint8" | "uint16" | "int16": one grayscale sample per pixel, little endian.
 * - "rgb8": three interleaved bytes per pixel (R, G, B), already converted
 *   from PALETTE COLOR / YBR / planar layouts by the server.
 */
export type PixelFormat = "uint8" | "uint16" | "int16" | "rgb8";

export interface WindowLevel {
  center: number;
  width: number;
}

/** Named window presets (values in rescaled units, e.g. HU for CT). */
export const WINDOW_PRESETS = {
  "soft-tissue": { center: 40, width: 400 },
  lung: { center: -600, width: 1500 },
  bone: { center: 400, width: 1800 },
  brain: { center: 40, width: 80 },
  liver: { center: 60, width: 160 },
  mediastinum: { center: 50, width: 350 },
} as const satisfies Record<string, WindowLevel>;

export type WindowPresetName = keyof typeof WINDOW_PRESETS;

export const WINDOW_PRESET_NAMES = Object.keys(WINDOW_PRESETS) as [
  WindowPresetName,
  ...WindowPresetName[],
];

/** One entry per series found in the DICOM directory. */
export interface SeriesSummary {
  /** SeriesInstanceUID, or a synthetic stable id when the tag is missing. */
  seriesInstanceUid: string;
  seriesDescription?: string;
  studyDescription?: string;
  modality?: string;
  /** Number of displayable slices (multi-frame files count every frame). */
  sliceCount: number;
  rows: number;
  columns: number;
}

/** Light per-slice metadata, in display order. No pixel data. */
export interface SliceMeta {
  /** Zero-based position in the sorted series. */
  index: number;
  instanceNumber?: number;
  sliceLocation?: number;
  imagePositionPatient?: [number, number, number];
}

export interface SeriesDetail extends SeriesSummary {
  bitsStored: number;
  pixelFormat: PixelFormat;
  /** Photometric interpretation as stored in the file (informational). */
  photometricInterpretation: string;
  /** [row spacing, column spacing] in mm. */
  pixelSpacing?: [number, number];
  sliceThickness?: number;
  /** Six direction cosines (row x,y,z then column x,y,z). */
  imageOrientationPatient?: number[];
  /**
   * Window from the DICOM tags of the first slice, or derived from the pixel
   * range when the file has none. Rescaled units.
   */
  defaultWindow: WindowLevel;
  slices: SliceMeta[];
}

/** A file that was found but could not be displayed. */
export interface SkippedFile {
  filename: string;
  /** Short human-readable reason, e.g. "Unsupported transfer syntax: JPEG 2000". */
  reason: string;
}

/** Arguments of view-dicom. All optional. */
export interface ViewDicomInput {
  /** SeriesInstanceUID to open; defaults to the series with the most slices. */
  seriesInstanceUid?: string;
  windowPreset?: WindowPresetName;
  /** Explicit window; both must be given, and they override windowPreset. */
  windowCenter?: number;
  windowWidth?: number;
}

/** structuredContent of a view-dicom result. Contains no patient identifiers. */
export interface ViewDicomResult {
  series: SeriesSummary[];
  selected: SeriesDetail;
  /** Window the viewer should start with (preset/override, else defaultWindow). */
  window: WindowLevel;
  skipped: SkippedFile[];
}

/** Arguments of get-dicom-slices. */
export interface GetSlicesInput {
  seriesInstanceUid: string;
  /** Zero-based index of the first slice. */
  start: number;
  /** 1..MAX_SLICES_PER_REQUEST; the server clamps to the series length. */
  count: number;
}

/** Pixel data of one slice. */
export interface SlicePixels {
  index: number;
  rows: number;
  columns: number;
  pixelFormat: PixelFormat;
  /**
   * Stored value -> display value: `value * rescaleSlope + rescaleIntercept`.
   * Per slice because it can vary inside a series. Always 1 / 0 for "rgb8".
   */
  rescaleSlope: number;
  rescaleIntercept: number;
  /** True for MONOCHROME1: the UI inverts after windowing. */
  invert: boolean;
  /**
   * Base64 of the zlib-deflated (RFC 1950, i.e. `zlib.deflateSync` /
   * `new DecompressionStream("deflate")`) raw sample bytes, row-major,
   * little endian. For 16-bit formats the values are already masked to
   * BitsStored and sign-extended, so they can be read directly as
   * Uint16Array / Int16Array.
   */
  data: string;
}

/** structuredContent of a get-dicom-slices result. */
export interface GetSlicesResult {
  seriesInstanceUid: string;
  slices: SlicePixels[];
}

/**
 * Optional payload embedded in the HTML when the server runs with
 * `--embed-series` (or DICOM_EMBED=1), for hosts without the MCP Apps bridge
 * (e.g. Open WebUI). When present the UI renders from it and never needs to
 * call a tool. `slices` holds every slice of `view.selected`.
 */
export interface DicomBootstrap {
  view: ViewDicomResult;
  slices: SlicePixels[];
}

export const BOOTSTRAP_GLOBAL = "__DICOM_BOOTSTRAP__";

declare global {
  var __DICOM_BOOTSTRAP__: DicomBootstrap | undefined;
}
