/**
 * @file Wheel handling helpers: deltaMode normalisation, slice-step
 * accumulation (so a trackpad gesture does not skip dozens of slices) and
 * wheel zoom factors.
 */

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

/** Converts a wheel delta to CSS pixels. */
export function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  pageSize = 800,
  lineHeight = 33,
): number {
  if (!Number.isFinite(delta)) return 0;
  if (deltaMode === DOM_DELTA_LINE) return delta * lineHeight;
  if (deltaMode === DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
}

export interface WheelAccumulatorOptions {
  /** Pixels of scrolling per slice step. */
  threshold?: number;
  /** Upper bound of steps a single event can produce. */
  maxStepsPerEvent?: number;
  /** Idle time after which the partial accumulation is discarded. */
  resetAfterMs?: number;
}

export class WheelAccumulator {
  private acc = 0;
  private lastTime = -Infinity;
  private readonly threshold: number;
  private readonly maxSteps: number;
  private readonly resetAfterMs: number;

  constructor(options: WheelAccumulatorOptions = {}) {
    this.threshold = options.threshold ?? 60;
    this.maxSteps = options.maxStepsPerEvent ?? 1;
    this.resetAfterMs = options.resetAfterMs ?? 250;
  }

  /** Feeds a pixel delta; returns the signed number of slices to move. */
  push(deltaPx: number, timeMs: number): number {
    if (timeMs - this.lastTime > this.resetAfterMs) this.acc = 0;
    this.lastTime = timeMs;
    if (deltaPx === 0) return 0;
    // Direction change: start over so reversing feels immediate.
    if (this.acc !== 0 && Math.sign(deltaPx) !== Math.sign(this.acc)) this.acc = 0;
    this.acc += deltaPx;
    let steps = Math.trunc(this.acc / this.threshold);
    if (steps === 0) return 0;
    if (Math.abs(steps) > this.maxSteps) {
      steps = Math.sign(steps) * this.maxSteps;
      this.acc = 0;
    } else {
      this.acc -= steps * this.threshold;
    }
    return steps;
  }

  reset(): void {
    this.acc = 0;
    this.lastTime = -Infinity;
  }
}

/** Multiplicative zoom for a pixel wheel delta (scroll up = zoom in). */
export function wheelZoomFactor(deltaPx: number): number {
  const f = Math.exp(-deltaPx * 0.002);
  return Math.min(1.5, Math.max(1 / 1.5, f));
}
