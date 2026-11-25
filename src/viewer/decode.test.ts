import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { SlicePixels } from "../../shared/protocol";
import { base64ToBytes, decodeSlice, inflate, rescaledRange, toTypedArray } from "./decode";

function wire(bytes: Uint8Array, extra: Partial<SlicePixels>): SlicePixels {
  return {
    index: 0,
    rows: 2,
    columns: 2,
    pixelFormat: "uint8",
    rescaleSlope: 1,
    rescaleIntercept: 0,
    invert: false,
    data: Buffer.from(deflateSync(bytes)).toString("base64"),
    ...extra,
  };
}

describe("base64ToBytes", () => {
  it("decodes standard base64", () => {
    expect([...base64ToBytes("AAEC/w==")]).toEqual([0, 1, 2, 255]);
    expect([...base64ToBytes("")]).toEqual([]);
    expect([...base64ToBytes("AAEC\n/w==")]).toEqual([0, 1, 2, 255]);
  });

  it("round-trips random bytes", () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37 + 11) & 255);
    expect([...base64ToBytes(Buffer.from(bytes).toString("base64"))]).toEqual([...bytes]);
  });
});

describe("inflate", () => {
  it("inflates zlib data", async () => {
    const src = new Uint8Array([5, 4, 3, 2, 1, 0, 0, 0, 0]);
    const out = await inflate(base64ToBytes(Buffer.from(deflateSync(src)).toString("base64")));
    expect([...out]).toEqual([...src]);
  });
});

describe("toTypedArray", () => {
  it("reads little-endian int16 from a misaligned view", () => {
    const backing = new Uint8Array(5);
    backing.set([0x00, 0x80, 0xff, 0xff], 1); // -32768, -1 at offset 1
    const view = backing.subarray(1, 5);
    const arr = toTypedArray(view, "int16", 2);
    expect(arr).toBeInstanceOf(Int16Array);
    expect([...arr]).toEqual([-32768, -1]);
  });

  it("rejects short data", () => {
    expect(() => toTypedArray(new Uint8Array(3), "uint16", 2)).toThrow(/too short/);
  });

  it("trims extra bytes for 8-bit formats", () => {
    expect(toTypedArray(new Uint8Array([1, 2, 3, 4, 5]), "uint8", 4).length).toBe(4);
  });
});

describe("decodeSlice", () => {
  it("decodes uint16 with rescale range", async () => {
    const values = new Uint16Array([0, 1000, 2000, 4095]);
    const s = await decodeSlice(
      wire(new Uint8Array(values.buffer), { pixelFormat: "uint16", rescaleIntercept: -1024, index: 7 }),
    );
    expect(s.index).toBe(7);
    expect(s.pixels).toBeInstanceOf(Uint16Array);
    expect([...s.pixels]).toEqual([0, 1000, 2000, 4095]);
    expect(rescaledRange(s)).toEqual({ min: -1024, max: 3071 });
    expect(s.byteLength).toBe(8);
  });

  it("decodes signed int16", async () => {
    const values = new Int16Array([-1000, -1, 0, 3000]);
    const s = await decodeSlice(wire(new Uint8Array(values.buffer), { pixelFormat: "int16", invert: true }));
    expect([...s.pixels]).toEqual([-1000, -1, 0, 3000]);
    expect(s.minStored).toBe(-1000);
    expect(s.invert).toBe(true);
  });

  it("decodes rgb8 and forces identity rescale", async () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const s = await decodeSlice(wire(rgb, { pixelFormat: "rgb8", rescaleSlope: 3, invert: true }));
    expect(s.pixels.length).toBe(12);
    expect(s.rescaleSlope).toBe(1);
    expect(s.invert).toBe(false);
  });

  it("fails on truncated payloads", async () => {
    await expect(decodeSlice(wire(new Uint8Array([1, 2]), {}))).rejects.toThrow(/too short/);
  });
});
