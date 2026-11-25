import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeFrame,
  frameToLittleEndianBytes,
  parseInstance,
  readFrameBytes,
  type DecodedFrame,
  type InstanceInfo,
  type ParseOutcome,
} from "../server/dicom.js";
import { buildDicom, findPixelDataOffset, TS, type SyntheticImage } from "./helpers/dicom-writer.js";
import { makeTempDir, removeDir } from "./helpers/tmp.js";

const dir = makeTempDir();
afterAll(() => removeDir(dir));
let fileCounter = 0;

function parse(image: SyntheticImage): { outcome: ParseOutcome; filePath: string; bytes: Uint8Array } {
  const bytes = buildDicom(image);
  const filePath = path.join(dir, `f${++fileCounter}.dcm`);
  fs.writeFileSync(filePath, bytes);
  const stat = fs.statSync(filePath);
  const outcome = parseInstance(bytes, {
    filename: path.basename(filePath),
    filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }) as ParseOutcome;
  return { outcome, filePath, bytes };
}

function ok(image: SyntheticImage): InstanceInfo {
  const { outcome } = parse(image);
  if (!outcome.ok) throw new Error(`expected ok, got: ${outcome.reason}`);
  return outcome.info;
}

async function frames(info: InstanceInfo): Promise<DecodedFrame[]> {
  const indices = Array.from({ length: info.numberOfFrames }, (_, i) => i);
  const bytes = await readFrameBytes(info, indices);
  return indices.map((i) => decodeFrame(info.layout, bytes.get(i)!));
}

describe("monochrome decoding", () => {
  it("decodes unsigned 16-bit with rescale metadata", async () => {
    const info = ok({ rows: 2, columns: 2, samples: [0, 1000, 4095, 65535], rescaleSlope: 1, rescaleIntercept: -1024 });
    expect(info.layout.pixelFormat).toBe("uint16");
    expect(info.rescaleIntercept).toBe(-1024);
    const [frame] = await frames(info);
    expect(frame.samples).toBeInstanceOf(Uint16Array);
    expect([...frame.samples]).toEqual([0, 1000, 4095, 65535]);
  });

  it("decodes signed 16-bit (two's complement)", async () => {
    const info = ok({
      rows: 1,
      columns: 4,
      pixelRepresentation: 1,
      samples: [-1024, -1, 0, 3071],
      rescaleSlope: 2,
      rescaleIntercept: 5,
    });
    expect(info.layout.pixelFormat).toBe("int16");
    expect(info.rescaleSlope).toBe(2);
    expect(info.rescaleIntercept).toBe(5);
    const [frame] = await frames(info);
    expect(frame.samples).toBeInstanceOf(Int16Array);
    expect([...frame.samples]).toEqual([-1024, -1, 0, 3071]);
  });

  it("masks to BitsStored and sign-extends", async () => {
    // 12 bits stored, high bit 11, garbage in the top nibble.
    const info = ok({
      rows: 1,
      columns: 4,
      bitsStored: 12,
      highBit: 11,
      pixelRepresentation: 1,
      samples: [0xf800, 0xafff, 0x07ff, 0x1001],
    });
    const [frame] = await frames(info);
    // 0x800 -> -2048, 0xfff -> -1, 0x7ff -> 2047, 0x001 -> 1
    expect([...frame.samples]).toEqual([-2048, -1, 2047, 1]);
  });

  it("honors a HighBit that is not BitsStored - 1 (shifted samples)", async () => {
    const info = ok({ rows: 1, columns: 3, bitsStored: 12, highBit: 15, samples: [0x0010, 0xfff0, 0x8000] });
    const [frame] = await frames(info);
    expect([...frame.samples]).toEqual([1, 0xfff, 0x800]);
  });

  it("masks unsigned BitsStored", async () => {
    const info = ok({ rows: 1, columns: 2, bitsStored: 10, samples: [0xfc01, 0x03ff] });
    const [frame] = await frames(info);
    expect([...frame.samples]).toEqual([1, 1023]);
  });

  it("decodes unsigned and signed 8-bit", async () => {
    const unsigned = ok({ rows: 1, columns: 3, bitsAllocated: 8, samples: [0, 128, 255] });
    expect(unsigned.layout.pixelFormat).toBe("uint8");
    const [u] = await frames(unsigned);
    expect(u.samples).toBeInstanceOf(Uint8Array);
    expect([...u.samples]).toEqual([0, 128, 255]);

    const signed = ok({ rows: 1, columns: 4, bitsAllocated: 8, pixelRepresentation: 1, samples: [0x80, 0xff, 0x00, 0x7f] });
    expect(signed.layout.pixelFormat).toBe("int16");
    const [s] = await frames(signed);
    expect([...s.samples]).toEqual([-128, -1, 0, 127]);
  });

  it("flags MONOCHROME1 for inversion", () => {
    const info = ok({ rows: 1, columns: 1, photometric: "MONOCHROME1", samples: [1] });
    expect(info.layout.photometric).toBe("MONOCHROME1");
  });

  it("reads Pixel Data at an odd (unaligned) file offset", async () => {
    const { outcome, bytes } = parse({ rows: 2, columns: 3, oddOffset: true, samples: [1, 2, 300, 4000, 65535, 7] });
    expect(findPixelDataOffset(bytes) % 2).toBe(1);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.info.pixelDataOffset % 2).toBe(1);
    const [frame] = await frames(outcome.info);
    expect([...frame.samples]).toEqual([1, 2, 300, 4000, 65535, 7]);

    // decodeFrame on an odd byteOffset view of a shared buffer.
    const raw = new Uint8Array(13);
    const view = raw.subarray(1, 13);
    new DataView(view.buffer, view.byteOffset).setUint16(0, 0xbeef, true);
    const decoded = decodeFrame(outcome.info.layout, view);
    expect(decoded.samples[0]).toBe(0xbeef);
  });

  it("decodes every frame of a multi-frame file", async () => {
    const info = ok({
      rows: 2,
      columns: 2,
      numberOfFrames: 3,
      samples: [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23],
    });
    expect(info.numberOfFrames).toBe(3);
    const decoded = await frames(info);
    expect(decoded.map((f) => [...f.samples])).toEqual([
      [0, 1, 2, 3],
      [10, 11, 12, 13],
      [20, 21, 22, 23],
    ]);
  });

  it("writes little-endian bytes for 16-bit frames", async () => {
    const info = ok({ rows: 1, columns: 2, pixelRepresentation: 1, samples: [-2, 0x1234] });
    const [frame] = await frames(info);
    expect([...frameToLittleEndianBytes(frame)]).toEqual([0xfe, 0xff, 0x34, 0x12]);
  });
});

describe("transfer syntaxes", () => {
  const samples = [5, 300, 65000, 42];
  for (const [name, ts] of [
    ["Implicit VR LE", TS.implicitLE],
    ["Explicit VR BE", TS.explicitBE],
    ["Deflated Explicit VR LE", TS.deflatedLE],
  ] as const) {
    it(`decodes ${name}`, async () => {
      const info = ok({ transferSyntax: ts, rows: 2, columns: 2, samples, seriesDescription: "TS test", modality: "CT" });
      expect(info.seriesDescription).toBe("TS test");
      expect(info.modality).toBe("CT");
      expect(info.layout.rows).toBe(2);
      const [frame] = await frames(info);
      expect([...frame.samples]).toEqual(samples);
    });
  }

  it("skips compressed syntaxes with a readable reason", () => {
    const j2k = parse({ transferSyntax: TS.jpeg2000, rows: 1, columns: 1, samples: [0] }).outcome;
    expect(j2k).toEqual({ ok: false, reason: "Unsupported transfer syntax: JPEG 2000 Lossless (1.2.840.10008.1.2.4.90)" });
    const rle = parse({ transferSyntax: TS.rle, rows: 1, columns: 1, samples: [0] }).outcome;
    expect(rle.ok).toBe(false);
    if (!rle.ok) expect(rle.reason).toMatch(/RLE Lossless/);
    const unknown = parse({ transferSyntax: "1.2.3.4.5", rows: 1, columns: 1, samples: [0] }).outcome;
    if (!unknown.ok) expect(unknown.reason).toBe("Unsupported transfer syntax: unknown (1.2.3.4.5)");
  });
});

describe("color", () => {
  it("passes RGB planar configuration 0 through", async () => {
    const info = ok({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      samplesPerPixel: 3,
      photometric: "RGB",
      planarConfiguration: 0,
      samples: [255, 0, 0, 0, 128, 255],
    });
    expect(info.layout.pixelFormat).toBe("rgb8");
    expect(info.rescaleSlope).toBe(1);
    const [frame] = await frames(info);
    expect([...frame.samples]).toEqual([255, 0, 0, 0, 128, 255]);
  });

  it("interleaves RGB planar configuration 1", async () => {
    const info = ok({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      samplesPerPixel: 3,
      photometric: "RGB",
      planarConfiguration: 1,
      // RR GG BB
      samples: [255, 0, 0, 128, 0, 255],
    });
    const [frame] = await frames(info);
    expect([...frame.samples]).toEqual([255, 0, 0, 0, 128, 255]);
  });

  it("converts YBR_FULL to RGB", async () => {
    const info = ok({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      samplesPerPixel: 3,
      photometric: "YBR_FULL",
      samples: [128, 128, 128, 76, 85, 255], // gray, ~pure red
    });
    const [frame] = await frames(info);
    expect([...frame.samples.subarray(0, 3)]).toEqual([128, 128, 128]);
    const [r, g, b] = frame.samples.subarray(3, 6);
    expect(r).toBeGreaterThan(250);
    expect(g).toBeLessThan(5);
    expect(b).toBeLessThan(5);
  });

  it("maps PALETTE COLOR through the lookup tables", async () => {
    const lut = (values: number[]) => {
      const bytes = new Uint8Array(values.length * 2);
      const dv = new DataView(bytes.buffer);
      values.forEach((v, i) => dv.setUint16(i * 2, v, true));
      return bytes;
    };
    const info = ok({
      rows: 1,
      columns: 3,
      bitsAllocated: 8,
      photometric: "PALETTE COLOR",
      samples: [10, 11, 12],
      extra: [
        { tag: 0x00281101, vr: "US", value: [3, 10, 16] },
        { tag: 0x00281102, vr: "US", value: [3, 10, 16] },
        { tag: 0x00281103, vr: "US", value: [3, 10, 16] },
        { tag: 0x00281201, vr: "OW", value: lut([0xffff, 0, 0]) },
        { tag: 0x00281202, vr: "OW", value: lut([0, 0xffff, 0]) },
        { tag: 0x00281203, vr: "OW", value: lut([0, 0, 0x8000]) },
      ],
    });
    expect(info.layout.pixelFormat).toBe("rgb8");
    const [frame] = await frames(info);
    expect([...frame.samples]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 128]);
  });
});

describe("skipped files", () => {
  it("reports Pixel Data shorter than rows*columns*frames", () => {
    const { outcome } = parse({ rows: 4, columns: 4, samples: [1, 2, 3, 4] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/^Pixel data truncated: expected 32 bytes .* found 8$/);
  });

  it("reports a file cut short inside Pixel Data", () => {
    const { outcome } = parse({ rows: 4, columns: 4, samples: new Array(16).fill(7), truncateBy: 10 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/^Pixel data truncated: expected 32 bytes .* found 22$/);
  });

  it("reports multi-frame data missing frames", () => {
    const { outcome } = parse({ rows: 2, columns: 2, numberOfFrames: 3, samples: new Array(8).fill(1) });
    if (outcome.ok) throw new Error("expected skip");
    expect(outcome.reason).toMatch(/expected 24 bytes for 3 frame/);
  });

  it("reports non-DICOM content and unsupported layouts", () => {
    const filePath = path.join(dir, "junk.dcm");
    const junk = new Uint8Array(300).fill(1);
    const outcome = parseInstance(junk, { filename: "junk.dcm", filePath, size: 300, mtimeMs: 0 });
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/Not a DICOM Part 10 file/) });

    const noRows = parse({ rows: 0, columns: 2, samples: [] }).outcome;
    if (noRows.ok) throw new Error("expected skip");
    expect(noRows.reason).toMatch(/Rows\/Columns/);

    const bits32 = parse({ rows: 1, columns: 1, bitsAllocated: 32, pixelBytes: new Uint8Array(4) }).outcome;
    if (bits32.ok) throw new Error("expected skip");
    expect(bits32.reason).toMatch(/Bits Allocated 32/);
  });
});
