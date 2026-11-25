import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheStats,
  clearDicomCaches,
  deriveWindow,
  getDecodedSlices,
  getSeriesDetail,
  loadCatalog,
  DicomDirectoryError,
} from "../server/catalog.js";
import { buildDicom, TS, type SyntheticImage } from "./helpers/dicom-writer.js";
import { makeTempDir, removeDir } from "./helpers/tmp.js";

const AXIAL = [1, 0, 0, 0, 1, 0];
let dirs: string[] = [];

function tempDir(files: Record<string, SyntheticImage | Uint8Array | string>): string {
  const encoded: Record<string, Uint8Array | string> = {};
  for (const [name, value] of Object.entries(files)) {
    encoded[name] = value instanceof Uint8Array || typeof value === "string" ? value : buildDicom(value);
  }
  const dir = makeTempDir(encoded);
  dirs.push(dir);
  return dir;
}

beforeEach(() => clearDicomCaches());
afterEach(() => {
  dirs.forEach(removeDir);
  dirs = [];
});

function slice(series: string, z: number, instanceNumber: number, extra: Partial<SyntheticImage> = {}): SyntheticImage {
  return {
    rows: 2,
    columns: 2,
    samples: [z, z, z, z].map((v) => v + 100),
    seriesInstanceUid: series,
    seriesDescription: `desc ${series}`,
    modality: "CT",
    imagePositionPatient: [0, 0, z],
    imageOrientationPatient: AXIAL,
    instanceNumber,
    ...extra,
  };
}

describe("loadCatalog", () => {
  it("groups by series and sorts geometrically, not by InstanceNumber or filename", async () => {
    // InstanceNumber runs opposite to the position along the normal; filenames are shuffled.
    const dir = tempDir({
      "c.dcm": slice("1.2.3.1", 20, 1),
      "a.DCM": slice("1.2.3.1", -10, 4),
      "e.dcm": slice("1.2.3.1", 5, 2),
      "b.dcm": slice("1.2.3.1", 0, 3),
      "d.dcm": slice("1.2.3.2", 0, 1, { seriesNumber: 1 }),
    });
    const catalog = await loadCatalog(dir);
    expect(catalog.fileCount).toBe(5);
    expect(catalog.skipped).toEqual([]);
    expect(catalog.series.map((s) => s.summary.seriesInstanceUid)).toEqual(["1.2.3.2", "1.2.3.1"]);
    const main = catalog.series[1];
    expect(catalog.defaultSeries).toBe(main);
    expect(main.summary).toMatchObject({ sliceCount: 4, rows: 2, columns: 2, modality: "CT", seriesDescription: "desc 1.2.3.1" });
    expect(main.slices.map((s) => s.meta.imagePositionPatient?.[2])).toEqual([-10, 0, 5, 20]);
    expect(main.slices.map((s) => s.meta.instanceNumber)).toEqual([4, 3, 2, 1]);
    expect(main.slices.map((s) => s.meta.index)).toEqual([0, 1, 2, 3]);
  });

  it("sorts along an oblique normal", async () => {
    // Sagittal: row (0,1,0), col (0,0,-1) -> normal (-1,0,0); coordinate = -x.
    const sag = [0, 1, 0, 0, 0, -1];
    const dir = tempDir({
      "1.dcm": slice("s", 0, 1, { imagePositionPatient: [10, 0, 0], imageOrientationPatient: sag }),
      "2.dcm": slice("s", 0, 2, { imagePositionPatient: [-10, 0, 0], imageOrientationPatient: sag }),
      "3.dcm": slice("s", 0, 3, { imagePositionPatient: [0, 0, 0], imageOrientationPatient: sag }),
    });
    const [series] = (await loadCatalog(dir)).series;
    expect(series.slices.map((s) => s.meta.imagePositionPatient?.[0])).toEqual([10, 0, -10]);
  });

  it("falls back to InstanceNumber, then SliceLocation, then filename", async () => {
    const noGeometry = { imagePositionPatient: undefined, imageOrientationPatient: undefined };
    const byInstance = tempDir({
      "a.dcm": slice("x", 0, 3, noGeometry),
      "b.dcm": slice("x", 0, 1, noGeometry),
      "c.dcm": slice("x", 0, 2, noGeometry),
    });
    expect((await loadCatalog(byInstance)).series[0].slices.map((s) => s.instance.filename)).toEqual([
      "b.dcm",
      "c.dcm",
      "a.dcm",
    ]);

    const byLocation = tempDir({
      "a.dcm": slice("y", 0, 0, { ...noGeometry, instanceNumber: undefined, sliceLocation: 9 }),
      "b.dcm": slice("y", 0, 0, { ...noGeometry, instanceNumber: undefined, sliceLocation: -3 }),
    });
    expect((await loadCatalog(byLocation)).series[0].slices.map((s) => s.instance.filename)).toEqual([
      "b.dcm",
      "a.dcm",
    ]);

    const byName = tempDir({
      "b.dcm": slice("z", 0, 0, { ...noGeometry, instanceNumber: undefined }),
      "a.dcm": slice("z", 0, 0, { ...noGeometry, instanceNumber: undefined }),
    });
    expect((await loadCatalog(byName)).series[0].slices.map((s) => s.instance.filename)).toEqual(["a.dcm", "b.dcm"]);
  });

  it("expands multi-frame files into slices in frame order", async () => {
    const dir = tempDir({
      "mf.dcm": { rows: 1, columns: 2, numberOfFrames: 3, samples: [1, 1, 2, 2, 3, 3], seriesInstanceUid: "mf" },
      "single.dcm": { rows: 1, columns: 2, samples: [9, 9], seriesInstanceUid: "other" },
    });
    const catalog = await loadCatalog(dir);
    expect(catalog.defaultSeries?.summary).toMatchObject({ seriesInstanceUid: "mf", sliceCount: 3 });
    const frames = await getDecodedSlices(catalog.defaultSeries!, [0, 1, 2]);
    expect(frames.map((f) => f.samples[0])).toEqual([1, 2, 3]);
  });

  it("reports skipped files with reasons and accepts extensionless DICM files", async () => {
    const dir = tempDir({
      "good": slice("g", 0, 1),
      "j2k.dcm": { ...slice("g", 1, 2), transferSyntax: TS.jpeg2000 },
      "short.dcm": { ...slice("g", 2, 3), samples: [1] },
      "notes.txt": "ignored",
      "README": "not dicom, no extension -> ignored",
      "garbage.dcm": "definitely not DICOM",
    });
    const catalog = await loadCatalog(dir);
    expect(catalog.fileCount).toBe(4);
    expect(catalog.series).toHaveLength(1);
    expect(catalog.series[0].slices[0].instance.filename).toBe("good");
    expect(catalog.skipped.map((s) => s.filename)).toEqual(["garbage.dcm", "j2k.dcm", "short.dcm"]);
    expect(catalog.skipped[1].reason).toBe("Unsupported transfer syntax: JPEG 2000 Lossless (1.2.840.10008.1.2.4.90)");
    expect(catalog.skipped[2].reason).toMatch(/Pixel data truncated/);
  });

  it("assigns a stable synthetic id when SeriesInstanceUID is missing", async () => {
    const image = { rows: 1, columns: 1, samples: [1], seriesInstanceUid: undefined, seriesDescription: "anon" };
    const a = (await loadCatalog(tempDir({ "1.dcm": image }))).series[0].summary.seriesInstanceUid;
    clearDicomCaches();
    const b = (await loadCatalog(tempDir({ "2.dcm": image }))).series[0].summary.seriesInstanceUid;
    expect(a).toMatch(/^synthetic-[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });

  it("caches parsed metadata and picks up changed files", async () => {
    const dir = tempDir({ "1.dcm": slice("c", 0, 1) });
    const first = await loadCatalog(dir);
    expect(await loadCatalog(dir)).toBe(first);
    expect(cacheStats().parsedFiles).toBe(1);

    fs.writeFileSync(path.join(dir, "2.dcm"), buildDicom(slice("c", 1, 2)));
    const second = await loadCatalog(dir);
    expect(second).not.toBe(first);
    expect(second.series[0].summary.sliceCount).toBe(2);

    fs.rmSync(path.join(dir, "1.dcm"));
    const third = await loadCatalog(dir);
    expect(third.series[0].summary.sliceCount).toBe(1);
    expect(cacheStats().parsedFiles).toBe(1);
  });

  it("throws DicomDirectoryError for a missing directory", async () => {
    await expect(loadCatalog(path.join(makeTempDir(), "missing"))).rejects.toBeInstanceOf(DicomDirectoryError);
  });
});

describe("default window", () => {
  it("uses the first value of multi-valued window tags", async () => {
    const dir = tempDir({ "1.dcm": slice("w", 0, 1, { windowCenter: [40, 400], windowWidth: [350, 2000] }) });
    const detail = await getSeriesDetail((await loadCatalog(dir)).series[0]);
    expect(detail.defaultWindow).toEqual({ center: 40, width: 350 });
  });

  it("derives the window from the middle slice when tags are absent or width <= 0", async () => {
    const dir = tempDir({
      "1.dcm": { ...slice("d", 0, 1), samples: [0, 0, 0, 0], windowCenter: 10, windowWidth: 0 },
      "2.dcm": { ...slice("d", 1, 2), samples: [10, 20, 30, 110], rescaleSlope: 1, rescaleIntercept: -1000 },
      "3.dcm": { ...slice("d", 2, 3), samples: [5000, 5000, 5000, 5000] },
    });
    const detail = await getSeriesDetail((await loadCatalog(dir)).series[0]);
    // Middle slice range is -990..-890 (rescaled); window maps it to 0..255.
    expect(detail.defaultWindow).toEqual({ center: -939.5, width: 101 });
  });

  it("ignores Pixel Padding Value when deriving the window", async () => {
    const dir = tempDir({
      "1.dcm": {
        ...slice("p", 0, 1),
        pixelRepresentation: 1,
        samples: [-2000, 0, 100, -2000],
        pixelPaddingValue: -2000,
      },
    });
    const catalog = await loadCatalog(dir);
    const detail = await getSeriesDetail(catalog.series[0]);
    expect(detail.defaultWindow).toEqual({ center: 50.5, width: 101 });

    const entry = catalog.series[0];
    const [frame] = await getDecodedSlices(entry, [0]);
    expect(deriveWindow(frame, entry.slices[0])).toEqual({ center: 50.5, width: 101 });
  });

  it("returns pixel spacing, thickness and orientation", async () => {
    const dir = tempDir({ "1.dcm": slice("m", 0, 1, { pixelSpacing: [0.5, 0.25], sliceThickness: 1.25 }) });
    const detail = await getSeriesDetail((await loadCatalog(dir)).series[0]);
    expect(detail.pixelSpacing).toEqual([0.5, 0.25]);
    expect(detail.sliceThickness).toBe(1.25);
    expect(detail.imageOrientationPatient).toEqual(AXIAL);
    expect(detail.pixelFormat).toBe("uint16");
    expect(detail.photometricInterpretation).toBe("MONOCHROME2");
  });

  it("falls back to ImagerPixelSpacing", async () => {
    const dir = tempDir({
      "1.dcm": slice("i", 0, 1, { extra: [{ tag: 0x00181164, vr: "DS", value: [0.1, 0.2] }] }),
    });
    const detail = await getSeriesDetail((await loadCatalog(dir)).series[0]);
    expect(detail.pixelSpacing).toEqual([0.1, 0.2]);
  });
});
