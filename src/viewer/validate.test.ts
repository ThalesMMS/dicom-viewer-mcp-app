import { describe, expect, it } from "vitest";
import { buildModelContextText, matchPreset } from "./format";
import { parseBootstrap, parseGetSlicesResult, parseViewDicomResult, resultText } from "./validate";

const selected = {
  seriesInstanceUid: "1.2.3",
  seriesDescription: "Axial",
  modality: "CT",
  sliceCount: 2,
  rows: 4,
  columns: 4,
  bitsStored: 12,
  pixelFormat: "int16",
  photometricInterpretation: "MONOCHROME2",
  pixelSpacing: [0.7, 0.7],
  defaultWindow: { center: 40, width: 400 },
  slices: [
    { index: 0, instanceNumber: 1, sliceLocation: -10 },
    { index: 1, instanceNumber: 2, sliceLocation: -8.75 },
  ],
};

describe("parseViewDicomResult", () => {
  it("accepts a valid result", () => {
    const r = parseViewDicomResult({ series: [selected], selected, window: { center: 1, width: 2 }, skipped: [] });
    expect(r?.selected.pixelSpacing).toEqual([0.7, 0.7]);
    expect(r?.window).toEqual({ center: 1, width: 2 });
  });

  it("fills defaults and tolerates missing optional parts", () => {
    const r = parseViewDicomResult({ selected });
    expect(r?.series).toHaveLength(1);
    expect(r?.window).toEqual(selected.defaultWindow);
    expect(r?.skipped).toEqual([]);
  });

  it("rejects malformed shapes", () => {
    expect(parseViewDicomResult(null)).toBeNull();
    expect(parseViewDicomResult({ selected: { ...selected, pixelFormat: "float" } })).toBeNull();
    expect(parseViewDicomResult({ selected: { ...selected, slices: "x" } })).toBeNull();
    expect(parseViewDicomResult({ selected: { ...selected, defaultWindow: {} } })).toBeNull();
  });

  it("drops invalid optional geometry", () => {
    const r = parseViewDicomResult({ selected: { ...selected, pixelSpacing: [0, 1], imageOrientationPatient: [1, 0] } });
    expect(r?.selected.pixelSpacing).toBeUndefined();
    expect(r?.selected.imageOrientationPatient).toBeUndefined();
  });
});

describe("other parsers", () => {
  it("parses slices results and filters bad entries", () => {
    const r = parseGetSlicesResult({
      seriesInstanceUid: "1.2.3",
      slices: [{ index: 0, rows: 1, columns: 1, pixelFormat: "uint8", data: "AA==" }, { index: 1 }],
    });
    expect(r?.slices).toHaveLength(1);
    expect(r?.slices[0].rescaleSlope).toBe(1);
    expect(parseGetSlicesResult({ slices: [] })).toBeNull();
  });

  it("parses bootstrap payloads", () => {
    expect(parseBootstrap({ view: { selected }, slices: [] })?.view.selected.seriesInstanceUid).toBe("1.2.3");
    expect(parseBootstrap({ view: {} })).toBeNull();
  });

  it("extracts text content", () => {
    expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe(
      "a\nb",
    );
    expect(resultText(undefined)).toBe("");
  });
});

describe("model context text", () => {
  it("summarises the current view", () => {
    const view = parseViewDicomResult({ selected })!;
    const text = buildModelContextText({
      series: view.selected,
      seriesCount: 3,
      sliceIndex: 1,
      window: { center: -600, width: 1500 },
      inverted: false,
    });
    expect(text).toContain('"Axial · CT"');
    expect(text).toContain("slice 2 of 2");
    expect(text).toContain("instance number 2");
    expect(text).toContain("slice location -8.75 mm");
    expect(text).toContain("(lung)");
    expect(text).toContain("one of 3 series");
  });

  it("matches presets", () => {
    expect(matchPreset({ center: 40, width: 400 }, { center: 40, width: 400 })).toBe("default");
    expect(matchPreset({ center: 400, width: 1800 }, { center: 40, width: 80 })).toBe("bone");
    expect(matchPreset({ center: 1, width: 2 }, { center: 40, width: 80 })).toBe("custom");
  });
});
