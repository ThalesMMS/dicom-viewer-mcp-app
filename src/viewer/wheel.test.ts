import { describe, expect, it } from "vitest";
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  WheelAccumulator,
  normalizeWheelDelta,
  wheelZoomFactor,
} from "./wheel";

describe("normalizeWheelDelta", () => {
  it("converts lines and pages to pixels", () => {
    expect(normalizeWheelDelta(10, DOM_DELTA_PIXEL)).toBe(10);
    expect(normalizeWheelDelta(3, DOM_DELTA_LINE, 800, 33)).toBe(99);
    expect(normalizeWheelDelta(-1, DOM_DELTA_PAGE, 500)).toBe(-500);
    expect(normalizeWheelDelta(Number.NaN, DOM_DELTA_PIXEL)).toBe(0);
  });
});

describe("WheelAccumulator", () => {
  it("moves one slice per mouse notch", () => {
    const acc = new WheelAccumulator({ threshold: 60, maxStepsPerEvent: 1 });
    expect(acc.push(100, 0)).toBe(1);
    expect(acc.push(100, 300)).toBe(1);
    expect(acc.push(-100, 600)).toBe(-1);
  });

  it("accumulates small trackpad deltas", () => {
    const acc = new WheelAccumulator({ threshold: 60 });
    let steps = 0;
    for (let i = 0; i < 30; i++) steps += acc.push(4, i * 16); // 120 px total
    expect(steps).toBe(2);
  });

  it("limits steps per event for large flings", () => {
    const acc = new WheelAccumulator({ threshold: 60, maxStepsPerEvent: 1 });
    let steps = 0;
    for (let i = 0; i < 10; i++) steps += acc.push(1000, i * 16);
    expect(steps).toBe(10);
  });

  it("resets on direction change and after idling", () => {
    const acc = new WheelAccumulator({ threshold: 60, resetAfterMs: 200 });
    expect(acc.push(50, 0)).toBe(0);
    expect(acc.push(-50, 10)).toBe(0); // reversed: starts over at -50
    expect(acc.push(-20, 20)).toBe(-1);
    expect(acc.push(50, 30)).toBe(0);
    expect(acc.push(50, 1000)).toBe(0); // idle: 50 again, not 100
    expect(acc.push(15, 1010)).toBe(1);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on negative delta and clamps", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100000)).toBeCloseTo(1.5);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});
