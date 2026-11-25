import { describe, expect, it } from "vitest";
import { directionLabel, orientationMarkers } from "./orientation";

describe("orientationMarkers", () => {
  it("labels a standard axial slice", () => {
    expect(orientationMarkers([1, 0, 0, 0, 1, 0])).toEqual({ left: "R", right: "L", top: "A", bottom: "P" });
  });

  it("labels a standard coronal slice", () => {
    expect(orientationMarkers([1, 0, 0, 0, 0, -1])).toEqual({ left: "R", right: "L", top: "H", bottom: "F" });
  });

  it("labels a standard sagittal slice", () => {
    expect(orientationMarkers([0, 1, 0, 0, 0, -1])).toEqual({ left: "A", right: "P", top: "H", bottom: "F" });
  });

  it("combines letters for oblique planes, strongest first", () => {
    const c = Math.SQRT1_2;
    const m = orientationMarkers([c, c, 0, 0, 0, -1]);
    expect(m?.right).toMatch(/^(LP|PL)$/);
    expect(m?.left).toMatch(/^(RA|AR)$/);
    expect(directionLabel([0.9, -0.4, 0.1])).toBe("LA");
  });

  it("ignores tiny tilts", () => {
    expect(orientationMarkers([0.999, 0.04, 0, -0.04, 0.999, 0])).toEqual({
      left: "R",
      right: "L",
      top: "A",
      bottom: "P",
    });
  });

  it("returns null for missing or degenerate input", () => {
    expect(orientationMarkers(undefined)).toBeNull();
    expect(orientationMarkers([1, 0, 0])).toBeNull();
    expect(orientationMarkers([0, 0, 0, 0, 1, 0])).toBeNull();
    expect(orientationMarkers([1, 0, 0, 0, Number.NaN, 0])).toBeNull();
  });
});
