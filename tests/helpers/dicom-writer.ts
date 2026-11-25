/**
 * Minimal synthetic DICOM Part 10 writer for tests: preamble, "DICM", an
 * Explicit VR Little Endian file meta group, then the data set in the chosen
 * transfer syntax (Explicit LE, Implicit LE, Explicit BE, or Deflated).
 */
import { deflateRawSync } from "node:zlib";

export const TS = {
  implicitLE: "1.2.840.10008.1.2",
  explicitLE: "1.2.840.10008.1.2.1",
  deflatedLE: "1.2.840.10008.1.2.1.99",
  explicitBE: "1.2.840.10008.1.2.2",
  jpeg2000: "1.2.840.10008.1.2.4.90",
  jpegBaseline: "1.2.840.10008.1.2.4.50",
  rle: "1.2.840.10008.1.2.5",
} as const;

export const PATIENT_NAME = "TESTPATIENT^SECRET";
export const PATIENT_ID = "PHI-ID-998877";

export interface Element {
  tag: number; // 0xGGGGEEEE
  vr: string;
  value: Uint8Array | string | number | number[] | Element[][];
}

const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT", "SV", "UV"]);

function encodeValue(el: Element, le: boolean, explicit: boolean): Uint8Array {
  const { vr, value } = el;
  if (vr === "SQ") {
    const items = value as Element[][];
    const parts: Uint8Array[] = [];
    for (const item of items) {
      const body = encodeDataSet(item, le, explicit);
      const header = new Uint8Array(8);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, 0xfffe, le);
      dv.setUint16(2, 0xe000, le);
      dv.setUint32(4, body.length, le);
      parts.push(header, body);
    }
    return concat(parts);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (vr === "US" || vr === "SS") {
    const values = Array.isArray(value) ? (value as number[]) : [value as number];
    const out = new Uint8Array(values.length * 2);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => (vr === "US" ? dv.setUint16(i * 2, v, le) : dv.setInt16(i * 2, v, le)));
    return out;
  }
  if (vr === "UL") {
    const values = Array.isArray(value) ? (value as number[]) : [value as number];
    const out = new Uint8Array(values.length * 4);
    const dv = new DataView(out.buffer);
    values.forEach((v, i) => dv.setUint32(i * 4, v, le));
    return out;
  }
  const text = Array.isArray(value) ? (value as number[]).join("\\") : String(value);
  return new TextEncoder().encode(text);
}

function pad(bytes: Uint8Array, vr: string): Uint8Array {
  if (bytes.length % 2 === 0 || vr === "SQ") return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = vr === "UI" || vr === "OB" || vr === "UN" ? 0 : 0x20;
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const ODD_TAG = 0x00191001;

export interface EncodeOptions {
  /** Leave the odd-length private element ODD_TAG unpadded (forces odd pixel offsets). */
  noPad?: boolean;
  /** Override the length written in the header of a tag. */
  lengthOverride?: Map<number, number>;
}

export function encodeDataSet(elements: Element[], le: boolean, explicit: boolean, opts: EncodeOptions = {}): Uint8Array {
  const sorted = elements.slice().sort((a, b) => a.tag - b.tag);
  const parts: Uint8Array[] = [];
  for (const el of sorted) {
    let value = encodeValue(el, le, explicit);
    if (!(opts.noPad && el.tag === ODD_TAG)) value = pad(value, el.vr);
    const length = opts.lengthOverride?.get(el.tag) ?? value.length;
    const group = el.tag >>> 16;
    const element = el.tag & 0xffff;
    let header: Uint8Array;
    if (!explicit) {
      header = new Uint8Array(8);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, group, le);
      dv.setUint16(2, element, le);
      dv.setUint32(4, length, le);
    } else if (LONG_VRS.has(el.vr)) {
      header = new Uint8Array(12);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, group, le);
      dv.setUint16(2, element, le);
      header[4] = el.vr.charCodeAt(0);
      header[5] = el.vr.charCodeAt(1);
      dv.setUint32(8, length, le);
    } else {
      header = new Uint8Array(8);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, group, le);
      dv.setUint16(2, element, le);
      header[4] = el.vr.charCodeAt(0);
      header[5] = el.vr.charCodeAt(1);
      dv.setUint16(6, length, le);
    }
    parts.push(header, value);
  }
  return concat(parts);
}

export interface SyntheticImage {
  transferSyntax?: string;
  rows: number;
  columns: number;
  bitsAllocated?: number;
  bitsStored?: number;
  highBit?: number;
  pixelRepresentation?: number;
  samplesPerPixel?: number;
  photometric?: string;
  planarConfiguration?: number;
  numberOfFrames?: number;
  /** Raw stored samples (one per sample, frame-major). Encoded per bitsAllocated and byte order. */
  samples?: number[];
  /** Raw pixel bytes, used as-is instead of `samples`. */
  pixelBytes?: Uint8Array;
  sopInstanceUid?: string;
  seriesInstanceUid?: string;
  studyInstanceUid?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  studyDescription?: string;
  modality?: string;
  instanceNumber?: number;
  sliceLocation?: number;
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
  pixelSpacing?: number[];
  sliceThickness?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  windowCenter?: number | number[];
  windowWidth?: number | number[];
  pixelPaddingValue?: number;
  extra?: Element[];
  /** Insert an odd-length private element so Pixel Data starts at an odd offset. */
  oddOffset?: boolean;
  /** Write this value in the Pixel Data length field instead of the real length. */
  pixelLengthOverride?: number;
  /** Cut this many bytes off the end of the file. */
  truncateBy?: number;
}

let counter = 0;

function encodeSamples(samples: number[], bits: number, le: boolean): Uint8Array {
  if (bits === 8) return Uint8Array.from(samples, (v) => v & 0xff);
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  samples.forEach((v, i) => dv.setUint16(i * 2, v & 0xffff, le));
  return out;
}

/** Builds a complete Part 10 file. */
export function buildDicom(image: SyntheticImage): Uint8Array {
  const ts = image.transferSyntax ?? TS.explicitLE;
  const le = ts !== TS.explicitBE;
  const explicit = ts !== TS.implicitLE;
  const bits = image.bitsAllocated ?? 16;
  const sop = image.sopInstanceUid ?? `1.2.826.0.1.3680043.99.${process.pid}.${++counter}`;

  const pixel =
    image.pixelBytes ?? encodeSamples(image.samples ?? [], bits, le);

  const ds: Element[] = [
    { tag: 0x00080016, vr: "UI", value: "1.2.840.10008.5.1.4.1.1.7" },
    { tag: 0x00080018, vr: "UI", value: sop },
    { tag: 0x00100010, vr: "PN", value: PATIENT_NAME },
    { tag: 0x00100020, vr: "LO", value: PATIENT_ID },
    { tag: 0x00100030, vr: "DA", value: "19700101" },
    { tag: 0x00280002, vr: "US", value: image.samplesPerPixel ?? 1 },
    { tag: 0x00280004, vr: "CS", value: image.photometric ?? "MONOCHROME2" },
    { tag: 0x00280010, vr: "US", value: image.rows },
    { tag: 0x00280011, vr: "US", value: image.columns },
    { tag: 0x00280100, vr: "US", value: bits },
    { tag: 0x00280101, vr: "US", value: image.bitsStored ?? bits },
    { tag: 0x00280102, vr: "US", value: image.highBit ?? (image.bitsStored ?? bits) - 1 },
    { tag: 0x00280103, vr: "US", value: image.pixelRepresentation ?? 0 },
    { tag: 0x7fe00010, vr: bits === 8 ? "OB" : "OW", value: pixel },
  ];
  const opt = (tag: number, vr: string, value: Element["value"] | undefined) => {
    if (value !== undefined) ds.push({ tag, vr, value });
  };
  opt(0x00080060, "CS", image.modality);
  opt(0x00081030, "LO", image.studyDescription);
  opt(0x0008103e, "LO", image.seriesDescription);
  opt(0x0020000d, "UI", image.studyInstanceUid);
  opt(0x0020000e, "UI", image.seriesInstanceUid);
  opt(0x00200011, "IS", image.seriesNumber);
  opt(0x00200013, "IS", image.instanceNumber);
  opt(0x00200032, "DS", image.imagePositionPatient);
  opt(0x00200037, "DS", image.imageOrientationPatient);
  opt(0x00201041, "DS", image.sliceLocation);
  opt(0x00280006, "US", image.planarConfiguration);
  opt(0x00280008, "IS", image.numberOfFrames);
  opt(0x00280030, "DS", image.pixelSpacing);
  opt(0x00180050, "DS", image.sliceThickness);
  opt(0x00281050, "DS", image.windowCenter);
  opt(0x00281051, "DS", image.windowWidth);
  opt(0x00281052, "DS", image.rescaleIntercept);
  opt(0x00281053, "DS", image.rescaleSlope);
  if (image.pixelPaddingValue !== undefined) {
    ds.push({
      tag: 0x00280120,
      vr: (image.pixelRepresentation ?? 0) === 1 ? "SS" : "US",
      value: image.pixelPaddingValue,
    });
  }
  if (image.oddOffset) ds.push({ tag: ODD_TAG, vr: "OB", value: Uint8Array.of(1, 2, 3) });
  ds.push(...(image.extra ?? []));

  const lengthOverride = new Map<number, number>();
  if (image.pixelLengthOverride !== undefined) lengthOverride.set(0x7fe00010, image.pixelLengthOverride);
  let body = encodeDataSet(ds, le, explicit, { noPad: image.oddOffset, lengthOverride });
  if (ts === TS.deflatedLE) body = new Uint8Array(deflateRawSync(body));

  const metaElements: Element[] = [
    { tag: 0x00020001, vr: "OB", value: Uint8Array.of(0, 1) },
    { tag: 0x00020002, vr: "UI", value: "1.2.840.10008.5.1.4.1.1.7" },
    { tag: 0x00020003, vr: "UI", value: sop },
    { tag: 0x00020010, vr: "UI", value: ts },
    { tag: 0x00020012, vr: "UI", value: "1.2.826.0.1.3680043.99.1" },
  ];
  const metaBody = encodeDataSet(metaElements, true, true);
  const groupLength = encodeDataSet([{ tag: 0x00020000, vr: "UL", value: metaBody.length }], true, true);

  const preamble = new Uint8Array(132);
  preamble.set([0x44, 0x49, 0x43, 0x4d], 128);
  const file = concat([preamble, groupLength, metaBody, body]);
  return image.truncateBy ? file.subarray(0, file.length - image.truncateBy) : file;
}

/** Locates the Pixel Data value offset in an Explicit VR LE file built by buildDicom. */
export function findPixelDataOffset(file: Uint8Array): number {
  for (let i = 132; i + 12 <= file.length; i++) {
    if (file[i] === 0xe0 && file[i + 1] === 0x7f && file[i + 2] === 0x10 && file[i + 3] === 0x00) {
      if (file[i + 4] === 0x4f && (file[i + 5] === 0x57 || file[i + 5] === 0x42)) return i + 12;
    }
  }
  return -1;
}
