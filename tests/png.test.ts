import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodePng } from "../server/png.js";
import { decodePng } from "./helpers/png-decode.js";

describe("crc32", () => {
  it("matches the reference value and zlib.crc32", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc32(bytes)).toBe(0xcbf43926);
    const random = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7919) & 0xff);
    expect(crc32(random)).toBe(zlib.crc32(random) >>> 0);
  });
});

describe("encodePng", () => {
  it("writes a valid grayscale PNG that decodes back to the same pixels", () => {
    const width = 37;
    const height = 23;
    const pixels = Uint8Array.from({ length: width * height }, (_, i) => (i * 13 + (i % width) * 3) & 0xff);
    const png = encodePng(width, height, 1, pixels);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR is the first chunk, 13 bytes long.
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");

    const decoded = decodePng(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.bitDepth).toBe(8);
    expect(decoded.colorType).toBe(0);
    expect(decoded.chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(decoded.chunks.every((c) => c.crcOk)).toBe(true);
    expect(Buffer.from(decoded.pixels).equals(Buffer.from(pixels))).toBe(true);
  });

  it("writes RGB PNGs", () => {
    const width = 16;
    const height = 9;
    const pixels = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 31) & 0xff);
    const decoded = decodePng(encodePng(width, height, 3, pixels));
    expect(decoded.colorType).toBe(2);
    expect(decoded.chunks.every((c) => c.crcOk)).toBe(true);
    expect(Buffer.from(decoded.pixels).equals(Buffer.from(pixels))).toBe(true);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => encodePng(4, 4, 1, new Uint8Array(15))).toThrow(/expected 16/);
  });
});
