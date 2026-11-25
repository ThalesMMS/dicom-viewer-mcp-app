import { describe, expect, it } from "vitest";
import { MAX_ZOOM, drawRect, fitScale, pixelAspect, scaleBar, zoomAbout } from "./geometry";

describe("fitScale", () => {
  it("fits square pixels to the limiting dimension", () => {
    expect(fitScale(400, 200, { columns: 100, rows: 100 })).toEqual({ sx: 2, sy: 2 });
  });

  it("respects non-square pixel spacing", () => {
    // rows twice as tall as columns are wide: physical 100 x 200
    expect(pixelAspect([2, 1])).toBe(2);
    const f = fitScale(400, 400, { columns: 100, rows: 100, pixelSpacing: [2, 1] });
    expect(f).toEqual({ sx: 2, sy: 4 });
  });
});

describe("zoomAbout", () => {
  const image = { columns: 100, rows: 100 };

  it("keeps the anchored image point fixed", () => {
    const t0 = { zoom: 1, panX: 10, panY: -5 };
    const anchor = { x: 50, y: -30 }; // relative to viewport centre
    const r0 = drawRect(300, 300, image, t0);
    const u = (150 + anchor.x - r0.x) / r0.sx;
    const v = (150 + anchor.y - r0.y) / r0.sy;
    const t1 = zoomAbout(t0, 2.5, anchor.x, anchor.y);
    const r1 = drawRect(300, 300, image, t1);
    expect((150 + anchor.x - r1.x) / r1.sx).toBeCloseTo(u);
    expect((150 + anchor.y - r1.y) / r1.sy).toBeCloseTo(v);
  });

  it("scales pan when zooming about the centre", () => {
    expect(zoomAbout({ zoom: 1, panX: 10, panY: 20 }, 2, 0, 0)).toEqual({ zoom: 2, panX: 20, panY: 40 });
  });

  it("clamps zoom and adjusts pan consistently", () => {
    const t = zoomAbout({ zoom: MAX_ZOOM, panX: 0, panY: 0 }, 2, 100, 100);
    expect(t).toEqual({ zoom: MAX_ZOOM, panX: 0, panY: 0 });
  });
});

describe("scaleBar", () => {
  it("picks a 1/2/5 length that fits", () => {
    const bar = scaleBar(0.5, 100); // max 50 mm
    expect(bar).toEqual({ mm: 50, px: 100, label: "5 cm" });
    expect(scaleBar(0.5, 90)?.mm).toBe(20);
    expect(scaleBar(0.05, 100)?.label).toBe("5 mm");
  });

  it("returns null without spacing", () => {
    expect(scaleBar(0, 100)).toBeNull();
    expect(scaleBar(Number.NaN, 100)).toBeNull();
  });
});
