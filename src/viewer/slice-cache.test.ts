import { describe, expect, it } from "vitest";
import { SliceCache } from "./slice-cache";

const item = (bytes: number) => ({ byteLength: bytes });

describe("SliceCache", () => {
  it("evicts least recently used entries over budget", () => {
    const c = new SliceCache(300);
    c.set(0, item(100));
    c.set(1, item(100));
    c.set(2, item(100));
    c.get(0); // 1 is now the LRU
    c.set(3, item(100));
    expect(c.has(1)).toBe(false);
    expect(c.keys().sort()).toEqual([0, 2, 3]);
    expect(c.byteSize).toBe(300);
  });

  it("never evicts protected entries", () => {
    const c = new SliceCache(250);
    c.setProtected((i) => i <= 2);
    c.set(0, item(100));
    c.set(1, item(100));
    c.set(2, item(100));
    // Over budget, but everything is protected.
    expect(c.size).toBe(3);
    expect(c.byteSize).toBe(300);
    c.set(9, item(100));
    expect(c.has(9)).toBe(false);
    c.setProtected((i) => i === 2);
    expect(c.has(2)).toBe(true);
    expect(c.byteSize).toBeLessThanOrEqual(250);
  });

  it("replaces entries without double counting", () => {
    const c = new SliceCache(1000);
    c.set(5, item(100));
    c.set(5, item(40));
    expect(c.byteSize).toBe(40);
    expect(c.size).toBe(1);
    c.clear();
    expect(c.byteSize).toBe(0);
  });

  it("peek does not change recency", () => {
    const c = new SliceCache(200);
    c.set(0, item(100));
    c.set(1, item(100));
    c.peek(0);
    c.set(2, item(100));
    expect(c.has(0)).toBe(false);
  });
});
