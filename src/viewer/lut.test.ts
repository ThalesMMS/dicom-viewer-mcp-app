import { describe, expect, it } from "vitest";
import {
  LutCache,
  applyGrayLut,
  applyWindow,
  buildWindowLut,
  dragWindow,
  lutDomain,
  rgbToRgba,
  windowDragRate,
} from "./lut";

describe("applyWindow (DICOM linear)", () => {
  it("clips below and above the window", () => {
    expect(applyWindow(-1000, 40, 400)).toBe(0);
    expect(applyWindow(1000, 40, 400)).toBe(255);
  });

  it("maps the center to mid gray", () => {
    const v = applyWindow(40, 40, 400);
    expect(v).toBeGreaterThanOrEqual(127);
    expect(v).toBeLessThanOrEqual(128);
  });

  it("is monotonic inside the window", () => {
    let prev = -1;
    for (let x = -200; x <= 280; x += 5) {
      const v = applyWindow(x, 40, 400);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("follows the standard edge formula", () => {
    // c=0.5,w=2: x <= -0.5 -> 0 ; x > 0.5 -> 255 ; between linear.
    expect(applyWindow(-0.5, 0.5, 2)).toBe(0);
    expect(applyWindow(0.6, 0.5, 2)).toBe(255);
  });

  it("treats width <= 1 as a threshold", () => {
    expect(applyWindow(9, 10, 1)).toBe(0);
    expect(applyWindow(10, 10, 1)).toBe(255);
    expect(applyWindow(10, 10, 0)).toBe(255);
  });
});

describe("buildWindowLut", () => {
  it("has the right domain per format", () => {
    expect(lutDomain("uint8")).toEqual({ offset: 0, size: 256 });
    expect(lutDomain("uint16")).toEqual({ offset: 0, size: 65536 });
    expect(lutDomain("int16")).toEqual({ offset: 32768, size: 65536 });
  });

  it("applies slope/intercept before windowing (CT style)", () => {
    // stored 1024 with intercept -1024 => 0 HU
    const lut = buildWindowLut({
      format: "uint16",
      slope: 1,
      intercept: -1024,
      window: { center: 0, width: 100 },
      invert: false,
    });
    const g = lut.gray[1024 + lut.offset];
    // ((0 - (0 - 0.5)) / 99 + 0.5) * 255 = 128.79
    expect(g).toBe(129);
    expect(lut.gray[0]).toBe(0);
    expect(lut.gray[2000]).toBe(255);
  });

  it("handles signed int16 samples", () => {
    const lut = buildWindowLut({
      format: "int16",
      slope: 1,
      intercept: 0,
      window: { center: -600, width: 1500 },
      invert: false,
    });
    expect(lut.gray[-2000 + lut.offset]).toBe(0);
    expect(lut.gray[500 + lut.offset]).toBe(255);
    const mid = lut.gray[-600 + lut.offset];
    expect(mid).toBeGreaterThan(120);
    expect(mid).toBeLessThan(135);
    const pixels = new Int16Array([-32768, -600, 32767]);
    const out = new Uint8ClampedArray(12);
    applyGrayLut(pixels, lut, out);
    expect([out[0], out[4], out[8]]).toEqual([0, mid, 255]);
    expect(out[3]).toBe(255);
  });

  it("inverts after windowing (MONOCHROME1)", () => {
    const params = { format: "uint8" as const, slope: 2, intercept: 10, window: { center: 128, width: 256 } };
    const normal = buildWindowLut({ ...params, invert: false });
    const inverted = buildWindowLut({ ...params, invert: true });
    for (let i = 0; i < 256; i++) expect(inverted.gray[i]).toBe(255 - normal.gray[i]);
  });

  it("handles negative slopes", () => {
    const lut = buildWindowLut({
      format: "uint8",
      slope: -1,
      intercept: 255,
      window: { center: 127.5, width: 256 },
      invert: false,
    });
    expect(lut.gray[0]).toBe(255);
    expect(lut.gray[255]).toBe(0);
  });
});

describe("LutCache", () => {
  it("reuses tables and bounds its size", () => {
    const cache = new LutCache(2);
    const p = { format: "uint8" as const, slope: 1, intercept: 0, invert: false };
    const a = cache.get({ ...p, window: { center: 1, width: 10 } });
    expect(cache.get({ ...p, window: { center: 1, width: 10 } })).toBe(a);
    cache.get({ ...p, window: { center: 2, width: 10 } });
    cache.get({ ...p, window: { center: 3, width: 10 } });
    expect(cache.size).toBe(2);
    expect(cache.get({ ...p, window: { center: 1, width: 10 } })).not.toBe(a);
  });
});

describe("rgb and drag helpers", () => {
  it("expands RGB to RGBA", () => {
    const out = new Uint8ClampedArray(8);
    rgbToRgba(new Uint8Array([1, 2, 3, 4, 5, 6]), out);
    expect([...out]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("scales drag sensitivity with the data range", () => {
    expect(windowDragRate(4000)).toBeCloseTo(8);
    expect(windowDragRate(255)).toBeCloseTo(0.51);
    expect(windowDragRate(0)).toBeGreaterThan(0);
    expect(windowDragRate(Number.NaN)).toBeGreaterThan(0);
  });

  it("drags width horizontally and center vertically, never below width 1", () => {
    expect(dragWindow({ center: 40, width: 400 }, 10, -5, 2)).toEqual({ center: 30, width: 420 });
    expect(dragWindow({ center: 40, width: 10 }, -100, 0, 1).width).toBe(1);
  });
});
