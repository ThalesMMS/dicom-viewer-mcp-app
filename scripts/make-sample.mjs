#!/usr/bin/env node
/**
 * Generates a small, SYNTHETIC, obviously fake CT-like DICOM series so the
 * viewer can be tried without downloading (or licensing) any real data.
 *
 *   node scripts/make-sample.mjs [--out <dir>] [--force]
 *
 * Output: 40 slices of 256 x 256, 16-bit signed, Explicit VR Little Endian
 * Part-10 files (CT Image Storage) containing a geometric phantom:
 * an air background, a soft-tissue body ellipse with a fat rim, two "lung"
 * inserts that grow and shrink across the series, a "spine", a "bone" sphere
 * that appears in the lower slices and a small rod on the patient's left side.
 * Patient name is PHANTOM^SYNTHETIC, patient ID is SYNTHETIC.
 *
 * Plain Node.js (>= 20), no dependencies. Existing files are never
 * overwritten unless --force is given.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROWS = 256;
const COLUMNS = 256;
const SLICES = 40;
const PIXEL_SPACING_MM = 1.0;
const SLICE_THICKNESS_MM = 2.5;
const RESCALE_SLOPE = 1;
const RESCALE_INTERCEPT = -1024;

const CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2";
const EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
const IMPLEMENTATION_CLASS_UID = "2.25.232826129913212946805912703890819991630";
const IMPLEMENTATION_VERSION_NAME = "DICOMVIEWER_SAMPLE";

const USAGE = `Usage: node scripts/make-sample.mjs [--out <dir>] [--force]

Writes a synthetic ${SLICES}-slice CT phantom (not patient data) as DICOM files.

  --out <dir>  Output directory (default: ./dicom, relative to the current directory)
  --force      Overwrite existing files with the same names
  --help       Show this message`;

// ---------------------------------------------------------------------------
// DICOM encoding (Explicit VR Little Endian)
// ---------------------------------------------------------------------------

/** VRs that use a 2-byte reserved field and a 4-byte length. */
const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);

/** UID under the 2.25 root (ISO/IEC 9834-8): "2.25." + UUID as a decimal integer. */
function newUid() {
  return `2.25.${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString()}`;
}

/** Decimal String: short, at most 16 characters per value. */
function ds(...values) {
  return values
    .map((v) => {
      const s = String(Number(v.toFixed(6)));
      if (s.length > 16) throw new Error(`DS value too long: ${s}`);
      return s;
    })
    .join("\\");
}

function encodeValue(vr, value) {
  if (Buffer.isBuffer(value)) return value;
  if (vr === "US") {
    const values = [value].flat();
    const buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeUInt16LE(v, i * 2));
    return buf;
  }
  if (vr === "UL") {
    const values = [value].flat();
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => buf.writeUInt32LE(v, i * 4));
    return buf;
  }
  return Buffer.from(String(value), "latin1");
}

/** Encodes one data element; values are padded to an even length. */
function element(group, elem, vr, value) {
  let bytes = encodeValue(vr, value);
  if (bytes.length % 2 !== 0) {
    const pad = vr === "UI" || vr === "OB" ? 0x00 : 0x20;
    bytes = Buffer.concat([bytes, Buffer.from([pad])]);
  }
  let header;
  if (LONG_VRS.has(vr)) {
    header = Buffer.alloc(12);
    header.writeUInt16LE(group, 0);
    header.writeUInt16LE(elem, 2);
    header.write(vr, 4, "latin1");
    header.writeUInt32LE(bytes.length, 8);
  } else {
    if (bytes.length > 0xffff) throw new Error(`Value too long for ${vr}`);
    header = Buffer.alloc(8);
    header.writeUInt16LE(group, 0);
    header.writeUInt16LE(elem, 2);
    header.write(vr, 4, "latin1");
    header.writeUInt16LE(bytes.length, 6);
  }
  return Buffer.concat([header, bytes]);
}

function fileMetaInformation(sopInstanceUid) {
  const body = Buffer.concat([
    element(0x0002, 0x0001, "OB", Buffer.from([0x00, 0x01])),
    element(0x0002, 0x0002, "UI", CT_IMAGE_STORAGE),
    element(0x0002, 0x0003, "UI", sopInstanceUid),
    element(0x0002, 0x0010, "UI", EXPLICIT_VR_LITTLE_ENDIAN),
    element(0x0002, 0x0012, "UI", IMPLEMENTATION_CLASS_UID),
    element(0x0002, 0x0013, "SH", IMPLEMENTATION_VERSION_NAME),
  ]);
  return Buffer.concat([element(0x0002, 0x0000, "UL", body.length), body]);
}

// ---------------------------------------------------------------------------
// Phantom
// ---------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32) so the noise is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inEllipse = (x, y, cx, cy, ax, ay) => ax > 0 && ay > 0 && ((x - cx) / ax) ** 2 + ((y - cy) / ay) ** 2 <= 1;

/**
 * Hounsfield value at patient coordinates (x, y) in mm relative to the image
 * centre (LPS: +x = patient left, +y = posterior) on slice `index`.
 */
function phantomHu(x, y, index) {
  const t = index / (SLICES - 1); // 0 (top) .. 1 (bottom)
  if (!inEllipse(x, y, 0, 0, 110, 80)) return -1000; // air
  if (!inEllipse(x, y, 0, 0, 103, 73)) return -100; // fat rim

  // Spine: cortical ring with a softer core, constant through the series.
  const spineR = Math.hypot(x, y - 55);
  if (spineR <= 6) return 250;
  if (spineR <= 13) return 700;

  // Lungs: grow from the top, peak around a third of the way, gone by 75 %.
  const lungScale = t < 0.75 ? 0.25 + 0.75 * Math.sin((Math.PI * t) / 0.75) : 0;
  if (inEllipse(x, y, -48, -5, 32 * lungScale, 45 * lungScale)) return -850;
  if (inEllipse(x, y, 48, -5, 30 * lungScale, 45 * lungScale)) return -850;

  // "Bone" sphere of radius 22 mm centred on slice 30.
  const dz = (index - 30) * SLICE_THICKNESS_MM;
  const sphereR = Math.sqrt(Math.max(0, 22 ** 2 - dz ** 2));
  if (Math.hypot(x, y + 15) <= sphereR) return 1000;

  // Orientation rod on the patient's left (+x), shown on the image's right.
  if (Math.hypot(x - 88, y) <= 4) return 300;

  return 40; // soft tissue
}

function slicePixels(index) {
  const random = mulberry32(0x5eed + index);
  const buf = Buffer.alloc(ROWS * COLUMNS * 2);
  for (let row = 0; row < ROWS; row++) {
    const y = (row - (ROWS - 1) / 2) * PIXEL_SPACING_MM;
    for (let col = 0; col < COLUMNS; col++) {
      const x = (col - (COLUMNS - 1) / 2) * PIXEL_SPACING_MM;
      const noise = (random() + random() - 1) * 12; // triangular, +/- 12 HU
      const hu = phantomHu(x, y, index) + noise;
      const stored = Math.round((hu - RESCALE_INTERCEPT) / RESCALE_SLOPE);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, stored)), (row * COLUMNS + col) * 2);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function sliceFile(index, uids) {
  const sopInstanceUid = newUid();
  const z = -index * SLICE_THICKNESS_MM;
  const origin = [-((COLUMNS - 1) / 2) * PIXEL_SPACING_MM, -((ROWS - 1) / 2) * PIXEL_SPACING_MM, z];

  // Elements must be in ascending tag order.
  const dataset = Buffer.concat([
    element(0x0008, 0x0005, "CS", "ISO_IR 100"),
    element(0x0008, 0x0008, "CS", "DERIVED\\SECONDARY\\AXIAL"),
    element(0x0008, 0x0016, "UI", CT_IMAGE_STORAGE),
    element(0x0008, 0x0018, "UI", sopInstanceUid),
    element(0x0008, 0x0060, "CS", "CT"),
    element(0x0008, 0x0070, "LO", "SYNTHETIC"),
    element(0x0008, 0x1030, "LO", "SYNTHETIC PHANTOM"),
    element(0x0008, 0x103e, "LO", "Synthetic CT phantom - not patient data"),
    element(0x0010, 0x0010, "PN", "PHANTOM^SYNTHETIC"),
    element(0x0010, 0x0020, "LO", "SYNTHETIC"),
    element(0x0018, 0x0050, "DS", ds(SLICE_THICKNESS_MM)),
    element(0x0018, 0x5100, "CS", "HFS"),
    element(0x0020, 0x000d, "UI", uids.study),
    element(0x0020, 0x000e, "UI", uids.series),
    element(0x0020, 0x0010, "SH", "SYNTH"),
    element(0x0020, 0x0011, "IS", "1"),
    element(0x0020, 0x0013, "IS", String(index + 1)),
    element(0x0020, 0x0032, "DS", ds(...origin)),
    element(0x0020, 0x0037, "DS", ds(1, 0, 0, 0, 1, 0)),
    element(0x0020, 0x0052, "UI", uids.frameOfReference),
    element(0x0020, 0x1041, "DS", ds(z)),
    element(0x0020, 0x4000, "LT", "SYNTHETIC PHANTOM GENERATED BY scripts/make-sample.mjs - NOT PATIENT DATA"),
    element(0x0028, 0x0002, "US", 1),
    element(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", ROWS),
    element(0x0028, 0x0011, "US", COLUMNS),
    element(0x0028, 0x0030, "DS", ds(PIXEL_SPACING_MM, PIXEL_SPACING_MM)),
    element(0x0028, 0x0100, "US", 16),
    element(0x0028, 0x0101, "US", 16),
    element(0x0028, 0x0102, "US", 15),
    element(0x0028, 0x0103, "US", 1),
    element(0x0028, 0x1050, "DS", ds(40)),
    element(0x0028, 0x1051, "DS", ds(400)),
    element(0x0028, 0x1052, "DS", ds(RESCALE_INTERCEPT)),
    element(0x0028, 0x1053, "DS", ds(RESCALE_SLOPE)),
    element(0x0028, 0x1054, "LO", "HU"),
    element(0x7fe0, 0x0010, "OW", slicePixels(index)),
  ]);

  const preamble = Buffer.alloc(128);
  return Buffer.concat([preamble, Buffer.from("DICM", "latin1"), fileMetaInformation(sopInstanceUid), dataset]);
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        out: { type: "string", default: "dicom" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const outDir = resolve(args.out);
  const fileNames = Array.from({ length: SLICES }, (_, i) => `synthetic-ct-${String(i + 1).padStart(3, "0")}.dcm`);
  const existing = fileNames.filter((name) => existsSync(join(outDir, name)));
  if (existing.length > 0 && !args.force) {
    console.error(
      `Refusing to overwrite ${existing.length} existing file(s) in ${outDir} (e.g. ${existing[0]}).\n` +
        "Re-run with --force to replace them, or choose another directory with --out <dir>.",
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const uids = { study: newUid(), series: newUid(), frameOfReference: newUid() };
  fileNames.forEach((name, index) => writeFileSync(join(outDir, name), sliceFile(index, uids)));

  console.log(`Wrote ${SLICES} synthetic CT slices (${COLUMNS}x${ROWS}, not patient data) to ${outDir}`);
  console.log(`SeriesInstanceUID: ${uids.series}`);
}

main();
