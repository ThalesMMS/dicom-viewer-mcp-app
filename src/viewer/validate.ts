/**
 * @file Defensive validation of data received from the host / server / page.
 * Returns normalised copies, or null when the shape is unusable.
 */
import type {
  DicomBootstrap,
  GetSlicesResult,
  PixelFormat,
  SeriesDetail,
  SeriesSummary,
  SkippedFile,
  SliceMeta,
  SlicePixels,
  ViewDicomResult,
  WindowLevel,
} from "../../shared/protocol";

type Obj = Record<string, unknown>;

const PIXEL_FORMATS: readonly PixelFormat[] = ["uint8", "uint16", "int16", "rgb8"];

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numTuple<N extends number>(v: unknown, n: N): number[] | undefined {
  if (!Array.isArray(v) || v.length !== n) return undefined;
  return v.every((x) => num(x) !== undefined) ? (v as number[]) : undefined;
}

export function parseWindow(v: unknown): WindowLevel | null {
  if (!isObj(v)) return null;
  const center = num(v.center);
  const width = num(v.width);
  if (center === undefined || width === undefined) return null;
  return { center, width: Math.max(1, width) };
}

function parseSummary(v: unknown): SeriesSummary | null {
  if (!isObj(v)) return null;
  const seriesInstanceUid = str(v.seriesInstanceUid);
  const sliceCount = num(v.sliceCount);
  const rows = num(v.rows);
  const columns = num(v.columns);
  if (!seriesInstanceUid || sliceCount === undefined || rows === undefined || columns === undefined) {
    return null;
  }
  return {
    seriesInstanceUid,
    seriesDescription: str(v.seriesDescription),
    studyDescription: str(v.studyDescription),
    modality: str(v.modality),
    sliceCount,
    rows,
    columns,
  };
}

function parseSliceMeta(v: unknown, position: number): SliceMeta {
  const o = isObj(v) ? v : {};
  const ipp = numTuple(o.imagePositionPatient, 3);
  return {
    index: num(o.index) ?? position,
    instanceNumber: num(o.instanceNumber),
    sliceLocation: num(o.sliceLocation),
    imagePositionPatient: ipp ? [ipp[0], ipp[1], ipp[2]] : undefined,
  };
}

function parseDetail(v: unknown): SeriesDetail | null {
  const summary = parseSummary(v);
  if (!summary || !isObj(v)) return null;
  const pixelFormat = str(v.pixelFormat) as PixelFormat | undefined;
  if (!pixelFormat || !PIXEL_FORMATS.includes(pixelFormat)) return null;
  const defaultWindow = parseWindow(v.defaultWindow);
  if (!defaultWindow) return null;
  if (!Array.isArray(v.slices)) return null;
  const slices = v.slices.map(parseSliceMeta);
  const spacing = numTuple(v.pixelSpacing, 2);
  const iop = numTuple(v.imageOrientationPatient, 6);
  return {
    ...summary,
    sliceCount: slices.length,
    bitsStored: num(v.bitsStored) ?? 0,
    pixelFormat,
    photometricInterpretation: str(v.photometricInterpretation) ?? "",
    pixelSpacing: spacing && spacing[0] > 0 && spacing[1] > 0 ? [spacing[0], spacing[1]] : undefined,
    sliceThickness: num(v.sliceThickness),
    imageOrientationPatient: iop,
    defaultWindow,
    slices,
  };
}

function parseSkipped(v: unknown): SkippedFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((s) => ({ filename: str(s.filename) ?? "(unknown file)", reason: str(s.reason) ?? "" }));
}

export function parseViewDicomResult(v: unknown): ViewDicomResult | null {
  if (!isObj(v)) return null;
  const selected = parseDetail(v.selected);
  if (!selected) return null;
  const series = Array.isArray(v.series)
    ? v.series.map(parseSummary).filter((s): s is SeriesSummary => s !== null)
    : [];
  if (!series.some((s) => s.seriesInstanceUid === selected.seriesInstanceUid)) {
    series.unshift({
      seriesInstanceUid: selected.seriesInstanceUid,
      seriesDescription: selected.seriesDescription,
      studyDescription: selected.studyDescription,
      modality: selected.modality,
      sliceCount: selected.sliceCount,
      rows: selected.rows,
      columns: selected.columns,
    });
  }
  return {
    series,
    selected,
    window: parseWindow(v.window) ?? selected.defaultWindow,
    skipped: parseSkipped(v.skipped),
  };
}

export function parseSlicePixels(v: unknown): SlicePixels | null {
  if (!isObj(v)) return null;
  const index = num(v.index);
  const rows = num(v.rows);
  const columns = num(v.columns);
  const pixelFormat = str(v.pixelFormat) as PixelFormat | undefined;
  const data = str(v.data);
  if (index === undefined || rows === undefined || columns === undefined || data === undefined) return null;
  if (!pixelFormat || !PIXEL_FORMATS.includes(pixelFormat)) return null;
  return {
    index,
    rows,
    columns,
    pixelFormat,
    rescaleSlope: num(v.rescaleSlope) ?? 1,
    rescaleIntercept: num(v.rescaleIntercept) ?? 0,
    invert: v.invert === true,
    data,
  };
}

export function parseGetSlicesResult(v: unknown): GetSlicesResult | null {
  if (!isObj(v) || !Array.isArray(v.slices)) return null;
  const seriesInstanceUid = str(v.seriesInstanceUid);
  if (!seriesInstanceUid) return null;
  return {
    seriesInstanceUid,
    slices: v.slices.map(parseSlicePixels).filter((s): s is SlicePixels => s !== null),
  };
}

export function parseBootstrap(v: unknown): DicomBootstrap | null {
  if (!isObj(v)) return null;
  const view = parseViewDicomResult(v.view);
  if (!view || !Array.isArray(v.slices)) return null;
  return {
    view,
    slices: v.slices.map(parseSlicePixels).filter((s): s is SlicePixels => s !== null),
  };
}

/** Joins the text blocks of a CallToolResult-like object. */
export function resultText(result: unknown): string {
  if (!isObj(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(isObj)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}
