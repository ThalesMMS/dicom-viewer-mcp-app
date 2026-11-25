/**
 * DICOM Part 10 metadata extraction and native pixel decoding.
 *
 * PHI policy: this module never reads patient-identifying attributes
 * (group 0010, accession number, institution, dates). Only the technical
 * and descriptive attributes listed in `InstanceInfo` are extracted.
 */
import dicomParser from "dicom-parser";
import type { DataSet, Element } from "dicom-parser";
import fs from "node:fs/promises";
import { endianness } from "node:os";
import { inflateRawSync } from "node:zlib";
import type { PixelFormat } from "../shared/protocol.js";
import {
  DEFLATED_EXPLICIT_VR_LE,
  EXPLICIT_VR_BE,
  isSupportedTransferSyntax,
  transferSyntaxName,
  unsupportedTransferSyntaxReason,
} from "./transfer-syntax.js";

export type Vec3 = [number, number, number];

export interface PaletteLut {
  /** Number of entries (descriptor value 0 means 65536). */
  entries: number;
  /** First stored pixel value mapped (descriptor second value). */
  firstMapped: number;
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
}

/** Everything needed to turn the raw bytes of one frame into samples. */
export interface PixelLayout {
  rows: number;
  columns: number;
  samplesPerPixel: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  /** Upper-cased photometric interpretation. */
  photometric: string;
  planarConfiguration: number;
  littleEndian: boolean;
  pixelFormat: PixelFormat;
  palette?: PaletteLut;
  /** Pixel Padding Value (0028,0120) in stored-value space. */
  paddingValue?: number;
  /** Pixel Padding Range Limit (0028,0121) in stored-value space. */
  paddingRangeLimit?: number;
}

export interface FrameGeometry {
  imagePositionPatient?: Vec3;
  rescaleSlope?: number;
  rescaleIntercept?: number;
}

export interface InstanceInfo {
  filename: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  transferSyntaxUid: string;
  deflated: boolean;
  sopInstanceUid?: string;
  seriesInstanceUid?: string;
  studyInstanceUid?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  studyDescription?: string;
  modality?: string;
  instanceNumber?: number;
  sliceLocation?: number;
  imagePositionPatient?: Vec3;
  imageOrientationPatient?: number[];
  pixelSpacing?: [number, number];
  sliceThickness?: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  windowCenter?: number;
  windowWidth?: number;
  numberOfFrames: number;
  /** Per-frame values from enhanced multi-frame functional groups. */
  frames?: FrameGeometry[];
  layout: PixelLayout;
  /** Offset of the pixel data value in the (inflated, for deflated syntax) byte stream. */
  pixelDataOffset: number;
  /** Bytes of one stored frame. */
  frameBytes: number;
}

export interface FileIdentity {
  filename: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

export type ParseOutcome =
  | { ok: true; info: InstanceInfo }
  | { ok: false; reason: string };

/** Decoded samples of one frame, in the wire `PixelFormat`. */
export interface DecodedFrame {
  format: PixelFormat;
  rows: number;
  columns: number;
  /** uint8/rgb8 -> Uint8Array, uint16 -> Uint16Array, int16 -> Int16Array. */
  samples: Uint8Array | Uint16Array | Int16Array;
}

const DICM_OFFSET = 128;
const DIRECTORY_SOP_CLASS = "1.2.840.10008.1.3.10";
const PIXEL_DATA = "x7fe00010";

/** True when the bytes carry the "DICM" magic at offset 128. */
export function hasDicmMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= DICM_OFFSET + 4 &&
    bytes[DICM_OFFSET] === 0x44 &&
    bytes[DICM_OFFSET + 1] === 0x49 &&
    bytes[DICM_OFFSET + 2] === 0x43 &&
    bytes[DICM_OFFSET + 3] === 0x4d
  );
}

function inflater(bytes: Uint8Array, position: number): Uint8Array {
  const inflated = inflateRawSync(bytes.subarray(position));
  const full = new Uint8Array(position + inflated.length);
  full.set(bytes.subarray(0, position), 0);
  full.set(inflated, position);
  return full;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "exception" in error) {
    return errorText((error as { exception: unknown }).exception);
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

function str(ds: DataSet, tag: string): string | undefined {
  const element = ds.elements[tag];
  if (!element || element.length === 0) return undefined;
  const value = ds.string(tag)?.replace(/\0/g, "").trim();
  return value ? value : undefined;
}

function num(ds: DataSet, tag: string): number | undefined {
  const values = nums(ds, tag);
  return values?.[0];
}

/** All values of a DS/IS attribute; undefined if absent or any value is not finite. */
function nums(ds: DataSet, tag: string): number[] | undefined {
  const element = ds.elements[tag];
  if (!element || element.length === 0) return undefined;
  const raw = str(ds, tag);
  if (raw === undefined) return undefined;
  const values = raw.split("\\").map((part) => Number.parseFloat(part.trim()));
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) return undefined;
  return values;
}

function us(ds: DataSet, tag: string): number | undefined {
  const element = ds.elements[tag];
  if (!element || element.length < 2) return undefined;
  return ds.uint16(tag);
}

function vec3(values: number[] | undefined): Vec3 | undefined {
  return values && values.length >= 3 ? [values[0], values[1], values[2]] : undefined;
}

function firstItem(ds: DataSet | undefined, tag: string): DataSet | undefined {
  return ds?.elements[tag]?.items?.[0]?.dataSet;
}

function toSigned16(value: number): number {
  return value >= 0x8000 ? value - 0x10000 : value;
}

// ---------------------------------------------------------------------------
// Layout validation
// ---------------------------------------------------------------------------

function readPalette(ds: DataSet, pixelRepresentation: number): PaletteLut | string {
  if (ds.elements.x00281221 || ds.elements.x00281222 || ds.elements.x00281223) {
    return "PALETTE COLOR with segmented lookup tables is not supported";
  }
  const channels = [
    ["x00281101", "x00281201"],
    ["x00281102", "x00281202"],
    ["x00281103", "x00281203"],
  ] as const;
  const luts: Uint8Array[] = [];
  let entries = 0;
  let firstMapped = 0;
  for (const [descriptorTag, dataTag] of channels) {
    const descriptor = ds.elements[descriptorTag];
    const data = ds.elements[dataTag];
    if (!descriptor || descriptor.length < 6 || !data || data.length === 0) {
      return "PALETTE COLOR image without palette lookup tables (0028,1101-1203)";
    }
    const count = ds.uint16(descriptorTag, 0) ?? 0;
    const first = ds.uint16(descriptorTag, 1) ?? 0;
    const bits = ds.uint16(descriptorTag, 2) ?? 16;
    const n = count === 0 ? 65536 : count;
    entries = n;
    firstMapped = pixelRepresentation === 1 ? toSigned16(first) : first;
    if (data.dataOffset + data.length > ds.byteArray.length) {
      return "PALETTE COLOR lookup table data is truncated";
    }
    const lut = new Uint8Array(n);
    if (data.length >= n * 2) {
      // 16-bit cells. Values are either full 16-bit (scale down) or 8-bit
      // values stored in 16-bit cells (common in the wild).
      const raw = new Uint16Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) {
        raw[i] = ds.byteArrayParser.readUint16(ds.byteArray, data.dataOffset + i * 2);
        if (raw[i] > max) max = raw[i];
      }
      const shift = bits > 8 && max > 255 ? 8 : 0;
      for (let i = 0; i < n; i++) lut[i] = Math.min(255, raw[i] >>> shift);
    } else if (data.length >= n) {
      lut.set(ds.byteArray.subarray(data.dataOffset, data.dataOffset + n));
    } else {
      return `PALETTE COLOR lookup table has ${data.length} bytes for ${n} entries`;
    }
    luts.push(lut);
  }
  return { entries, firstMapped, red: luts[0], green: luts[1], blue: luts[2] };
}

function buildLayout(ds: DataSet, littleEndian: boolean): PixelLayout | string {
  const rows = us(ds, "x00280010") ?? 0;
  const columns = us(ds, "x00280011") ?? 0;
  if (rows === 0 || columns === 0) return "Missing or zero Rows/Columns (0028,0010/0011)";

  const samplesPerPixel = us(ds, "x00280002") ?? 1;
  const bitsAllocated = us(ds, "x00280100");
  if (bitsAllocated === undefined) return "Missing Bits Allocated (0028,0100)";
  const bitsStored = us(ds, "x00280101") ?? bitsAllocated;
  const highBit = us(ds, "x00280102") ?? bitsStored - 1;
  const pixelRepresentation = us(ds, "x00280103") ?? 0;
  const planarConfiguration = us(ds, "x00280006") ?? 0;
  let photometric = (str(ds, "x00280004") ?? "").toUpperCase();
  if (!photometric) photometric = samplesPerPixel === 3 ? "RGB" : "MONOCHROME2";

  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    return `Bits Allocated ${bitsAllocated} is not supported (expected 8 or 16)`;
  }
  if (bitsStored < 1 || bitsStored > bitsAllocated) {
    return `Invalid Bits Stored ${bitsStored} for Bits Allocated ${bitsAllocated}`;
  }
  if (highBit < bitsStored - 1 || highBit >= bitsAllocated) {
    return `Invalid High Bit ${highBit} (Bits Stored ${bitsStored}, Bits Allocated ${bitsAllocated})`;
  }

  const base = {
    rows,
    columns,
    samplesPerPixel,
    bitsAllocated,
    bitsStored,
    highBit,
    pixelRepresentation,
    photometric,
    planarConfiguration,
    littleEndian,
  };

  if (samplesPerPixel === 1) {
    if (photometric === "MONOCHROME1" || photometric === "MONOCHROME2") {
      let pixelFormat: PixelFormat;
      if (bitsAllocated === 8) pixelFormat = pixelRepresentation === 1 ? "int16" : "uint8";
      else pixelFormat = pixelRepresentation === 1 ? "int16" : "uint16";

      let paddingValue = us(ds, "x00280120");
      let paddingRangeLimit = us(ds, "x00280121");
      if (pixelRepresentation === 1) {
        if (paddingValue !== undefined) paddingValue = toSigned16(paddingValue);
        if (paddingRangeLimit !== undefined) paddingRangeLimit = toSigned16(paddingRangeLimit);
      }
      return { ...base, pixelFormat, paddingValue, paddingRangeLimit };
    }
    if (photometric === "PALETTE COLOR") {
      const palette = readPalette(ds, pixelRepresentation);
      if (typeof palette === "string") return palette;
      return { ...base, pixelFormat: "rgb8", palette };
    }
    return `Photometric interpretation ${photometric} is not supported for 1 sample per pixel`;
  }

  if (samplesPerPixel === 3) {
    if (bitsAllocated !== 8) {
      return `Color images with Bits Allocated ${bitsAllocated} are not supported (expected 8)`;
    }
    if (photometric !== "RGB" && photometric !== "YBR_FULL") {
      return `Color photometric interpretation ${photometric} is not supported (expected RGB or YBR_FULL)`;
    }
    if (planarConfiguration !== 0 && planarConfiguration !== 1) {
      return `Invalid Planar Configuration ${planarConfiguration}`;
    }
    return { ...base, pixelFormat: "rgb8" };
  }

  return `Samples per Pixel ${samplesPerPixel} is not supported (expected 1 or 3)`;
}

function readFrameGeometry(ds: DataSet, frames: number): FrameGeometry[] | undefined {
  const perFrame = ds.elements.x52009230?.items;
  if (!perFrame || perFrame.length === 0) return undefined;
  const out: FrameGeometry[] = [];
  for (let i = 0; i < frames; i++) {
    const item = perFrame[i]?.dataSet;
    const position = firstItem(item, "x00209113");
    const transform = firstItem(item, "x00289145");
    out.push({
      imagePositionPatient: position ? vec3(nums(position, "x00200032")) : undefined,
      rescaleSlope: transform ? num(transform, "x00281053") : undefined,
      rescaleIntercept: transform ? num(transform, "x00281052") : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

/**
 * Parses a DICOM Part 10 file.
 *
 * @param bytes - Whole file, or a head of it when `partial` is set.
 * @param file - Identity of the file on disk.
 * @param partial - When true, `bytes` is only the first part of the file;
 *   parsing stops at Pixel Data and returns `"need-full-file"` if the head is
 *   too short or the syntax requires the whole stream (deflate).
 */
export function parseInstance(
  bytes: Uint8Array,
  file: FileIdentity,
  partial = false,
): ParseOutcome | "need-full-file" {
  if (!hasDicmMagic(bytes)) {
    return { ok: false, reason: "Not a DICOM Part 10 file (no DICM signature at offset 128)" };
  }

  let meta: DataSet;
  try {
    meta = dicomParser.readPart10Header(bytes);
  } catch (error) {
    if (partial) return "need-full-file";
    return { ok: false, reason: `Unreadable DICOM file meta header: ${errorText(error)}` };
  }
  const transferSyntaxUid = str(meta, "x00020010");
  if (!transferSyntaxUid) {
    return { ok: false, reason: "Missing Transfer Syntax UID (0002,0010) in file meta header" };
  }
  if (str(meta, "x00020002") === DIRECTORY_SOP_CLASS) {
    return { ok: false, reason: "DICOMDIR media index file (not an image)" };
  }
  if (!isSupportedTransferSyntax(transferSyntaxUid)) {
    return { ok: false, reason: unsupportedTransferSyntaxReason(transferSyntaxUid) };
  }
  const deflated = transferSyntaxUid === DEFLATED_EXPLICIT_VR_LE;
  if (partial && deflated) return "need-full-file";
  const littleEndian = transferSyntaxUid !== EXPLICIT_VR_BE;

  let ds: DataSet;
  try {
    ds = dicomParser.parseDicom(bytes, {
      untilTag: partial ? PIXEL_DATA : undefined,
      inflater,
    });
  } catch (error) {
    const partialSet = (error as { dataSet?: DataSet } | undefined)?.dataSet;
    if (partial) return "need-full-file";
    if (partialSet?.elements[PIXEL_DATA]) {
      // Typically a file cut short inside Pixel Data; the length check below
      // turns that into a precise reason.
      ds = partialSet;
    } else {
      return {
        ok: false,
        reason: `Could not parse ${transferSyntaxName(transferSyntaxUid)} data set: ${errorText(error)}`,
      };
    }
  }

  const pixel: Element | undefined = ds.elements[PIXEL_DATA];
  if (!pixel) {
    if (partial) return "need-full-file";
    return { ok: false, reason: "No Pixel Data (7FE0,0010); not an image object" };
  }
  if (pixel.hadUndefinedLength || pixel.encapsulatedPixelData || pixel.length === 0xffffffff) {
    return {
      ok: false,
      reason: `Encapsulated Pixel Data under native transfer syntax ${transferSyntaxName(transferSyntaxUid)}`,
    };
  }

  const layout = buildLayout(ds, littleEndian);
  if (typeof layout === "string") return { ok: false, reason: layout };

  const numberOfFrames = Math.max(1, Math.trunc(num(ds, "x00280008") ?? 1));
  const frameBytes =
    layout.rows * layout.columns * layout.samplesPerPixel * (layout.bitsAllocated / 8);
  const expected = frameBytes * numberOfFrames;
  const streamLength = partial ? file.size : ds.byteArray.length;
  const available = Math.min(pixel.length, Math.max(0, streamLength - pixel.dataOffset));
  if (available < expected) {
    return {
      ok: false,
      reason:
        `Pixel data truncated: expected ${expected} bytes for ${numberOfFrames} frame(s) of ` +
        `${layout.rows}x${layout.columns}x${layout.samplesPerPixel} at ${layout.bitsAllocated} bits, ` +
        `found ${available}`,
    };
  }

  // Enhanced multi-frame: shared functional groups fill in missing top-level values.
  const shared = firstItem(ds, "x52009229");
  const measures = firstItem(shared, "x00289110");
  const orientationGroup = firstItem(shared, "x00209116");
  const transform = firstItem(shared, "x00289145");
  const voi = firstItem(shared, "x00289132");
  const firstFrame = ds.elements.x52009230?.items?.[0]?.dataSet;
  const firstFrameVoi = firstItem(firstFrame, "x00289132");
  const firstFrameOrientation = firstItem(firstFrame, "x00209116");
  const firstFrameMeasures = firstItem(firstFrame, "x00289110");

  const spacing =
    nums(ds, "x00280030") ??
    (measures && nums(measures, "x00280030")) ??
    (firstFrameMeasures && nums(firstFrameMeasures, "x00280030")) ??
    nums(ds, "x00181164");
  const orientation =
    nums(ds, "x00200037") ??
    (orientationGroup && nums(orientationGroup, "x00200037")) ??
    (firstFrameOrientation && nums(firstFrameOrientation, "x00200037"));
  const frames = numberOfFrames > 1 ? readFrameGeometry(ds, numberOfFrames) : undefined;

  let rescaleSlope = num(ds, "x00281053") ?? (transform && num(transform, "x00281053"));
  let rescaleIntercept = num(ds, "x00281052") ?? (transform && num(transform, "x00281052"));
  if (layout.pixelFormat === "rgb8") {
    rescaleSlope = 1;
    rescaleIntercept = 0;
  }
  if (rescaleSlope === undefined || rescaleSlope === 0) rescaleSlope = 1;
  if (rescaleIntercept === undefined) rescaleIntercept = 0;

  const voiSource = ds.elements.x00281050 ? ds : (voi ?? firstFrameVoi);

  const info: InstanceInfo = {
    filename: file.filename,
    filePath: file.filePath,
    size: file.size,
    mtimeMs: file.mtimeMs,
    transferSyntaxUid,
    deflated,
    sopInstanceUid: str(ds, "x00080018"),
    seriesInstanceUid: str(ds, "x0020000e"),
    studyInstanceUid: str(ds, "x0020000d"),
    seriesNumber: num(ds, "x00200011"),
    seriesDescription: str(ds, "x0008103e"),
    studyDescription: str(ds, "x00081030"),
    modality: str(ds, "x00080060"),
    instanceNumber: num(ds, "x00200013"),
    sliceLocation: num(ds, "x00201041"),
    imagePositionPatient: vec3(nums(ds, "x00200032")) ?? frames?.[0]?.imagePositionPatient,
    imageOrientationPatient: orientation && orientation.length >= 6 ? orientation.slice(0, 6) : undefined,
    pixelSpacing: spacing && spacing.length >= 2 ? [spacing[0], spacing[1]] : undefined,
    sliceThickness:
      num(ds, "x00180050") ??
      (measures && num(measures, "x00180050")) ??
      (firstFrameMeasures && num(firstFrameMeasures, "x00180050")),
    rescaleSlope,
    rescaleIntercept,
    windowCenter: voiSource ? num(voiSource, "x00281050") : undefined,
    windowWidth: voiSource ? num(voiSource, "x00281051") : undefined,
    numberOfFrames,
    frames,
    layout,
    pixelDataOffset: pixel.dataOffset,
    frameBytes,
  };
  return { ok: true, info };
}

// ---------------------------------------------------------------------------
// Pixel I/O and decoding
// ---------------------------------------------------------------------------

/**
 * Reads the stored bytes of the given frames of an instance. Native
 * syntaxes use positional reads; deflated files are re-read and inflated.
 */
export async function readFrameBytes(
  info: InstanceInfo,
  frameIndices: readonly number[],
): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for (const frame of frameIndices) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= info.numberOfFrames) {
      throw new RangeError(`Frame ${frame} is out of range for ${info.filename}`);
    }
  }

  const stat = await fs.stat(info.filePath);
  if (stat.size !== info.size || stat.mtimeMs !== info.mtimeMs) {
    throw new Error(`${info.filename} changed on disk; call view-dicom again to rescan`);
  }

  if (info.deflated) {
    const file = await fs.readFile(info.filePath);
    const ds = dicomParser.parseDicom(file, { inflater });
    const pixel = ds.elements[PIXEL_DATA];
    if (!pixel) throw new Error(`${info.filename}: Pixel Data not found on re-read`);
    for (const frame of frameIndices) {
      const start = pixel.dataOffset + frame * info.frameBytes;
      out.set(frame, ds.byteArray.slice(start, start + info.frameBytes));
    }
    return out;
  }

  const handle = await fs.open(info.filePath, "r");
  try {
    for (const frame of frameIndices) {
      const buffer = new Uint8Array(info.frameBytes);
      const position = info.pixelDataOffset + frame * info.frameBytes;
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled < buffer.length) {
        throw new Error(`${info.filename}: unexpected end of file while reading frame ${frame}`);
      }
      out.set(frame, buffer);
    }
  } finally {
    await handle.close();
  }
  return out;
}

function ybrFullToRgb(y: number, cb: number, cr: number, out: Uint8Array, offset: number): void {
  const b = cb - 128;
  const r = cr - 128;
  out[offset] = clamp8(y + 1.402 * r);
  out[offset + 1] = clamp8(y - 0.344136 * b - 0.714136 * r);
  out[offset + 2] = clamp8(y + 1.772 * b);
}

function clamp8(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
}

/**
 * Decodes the stored bytes of one frame. Works on any byte offset (uses a
 * DataView, never an aligned typed-array view over the input).
 */
export function decodeFrame(layout: PixelLayout, raw: Uint8Array): DecodedFrame {
  const { rows, columns, samplesPerPixel, bitsAllocated } = layout;
  const pixels = rows * columns;
  const needed = pixels * samplesPerPixel * (bitsAllocated / 8);
  if (raw.length < needed) {
    throw new RangeError(`Frame has ${raw.length} bytes; expected ${needed}`);
  }

  if (samplesPerPixel === 3) {
    const out = new Uint8Array(pixels * 3);
    if (layout.planarConfiguration === 1) {
      for (let i = 0; i < pixels; i++) {
        out[i * 3] = raw[i];
        out[i * 3 + 1] = raw[pixels + i];
        out[i * 3 + 2] = raw[2 * pixels + i];
      }
    } else {
      out.set(raw.subarray(0, pixels * 3));
    }
    if (layout.photometric === "YBR_FULL") {
      for (let i = 0; i < pixels * 3; i += 3) ybrFullToRgb(out[i], out[i + 1], out[i + 2], out, i);
    }
    return { format: "rgb8", rows, columns, samples: out };
  }

  const view = new DataView(raw.buffer, raw.byteOffset, needed);
  const shift = layout.highBit + 1 - layout.bitsStored;
  const mask = layout.bitsStored >= 32 ? 0xffffffff : 2 ** layout.bitsStored - 1;
  const signBit = 2 ** (layout.bitsStored - 1);
  const range = 2 ** layout.bitsStored;
  const signed = layout.pixelRepresentation === 1;
  const sixteen = bitsAllocated === 16;
  const le = layout.littleEndian;

  const read = (i: number): number => {
    let value = sixteen ? view.getUint16(i * 2, le) : view.getUint8(i);
    value = (value >>> shift) & mask;
    if (signed && value >= signBit) value -= range;
    return value;
  };

  if (layout.palette) {
    const { palette } = layout;
    const out = new Uint8Array(pixels * 3);
    const last = palette.entries - 1;
    for (let i = 0; i < pixels; i++) {
      let index = read(i) - palette.firstMapped;
      if (index < 0) index = 0;
      else if (index > last) index = last;
      out[i * 3] = palette.red[index];
      out[i * 3 + 1] = palette.green[index];
      out[i * 3 + 2] = palette.blue[index];
    }
    return { format: "rgb8", rows, columns, samples: out };
  }

  let samples: Uint8Array | Uint16Array | Int16Array;
  switch (layout.pixelFormat) {
    case "uint8":
      samples = new Uint8Array(pixels);
      break;
    case "uint16":
      samples = new Uint16Array(pixels);
      break;
    case "int16":
      samples = new Int16Array(pixels);
      break;
    default:
      throw new Error(`Unexpected pixel format ${layout.pixelFormat} for monochrome data`);
  }
  for (let i = 0; i < pixels; i++) samples[i] = read(i);
  return { format: layout.pixelFormat, rows, columns, samples };
}

const HOST_IS_LE = endianness() === "LE";

/** Little-endian bytes of a decoded frame, as documented on `SlicePixels.data`. */
export function frameToLittleEndianBytes(frame: DecodedFrame): Uint8Array {
  const { samples } = frame;
  if (samples instanceof Uint8Array) return samples;
  if (HOST_IS_LE) return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  const signed = samples instanceof Int16Array;
  for (let i = 0; i < samples.length; i++) {
    if (signed) view.setInt16(i * 2, samples[i], true);
    else view.setUint16(i * 2, samples[i], true);
  }
  return out;
}

/** True when a stored value is pixel padding per (0028,0120)/(0028,0121). */
export function isPadding(layout: PixelLayout, stored: number): boolean {
  const { paddingValue, paddingRangeLimit } = layout;
  if (paddingValue === undefined) return false;
  if (paddingRangeLimit === undefined) return stored === paddingValue;
  const lo = Math.min(paddingValue, paddingRangeLimit);
  const hi = Math.max(paddingValue, paddingRangeLimit);
  return stored >= lo && stored <= hi;
}
