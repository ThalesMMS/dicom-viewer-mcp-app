/**
 * @file Patient orientation markers from ImageOrientationPatient.
 *
 * DICOM patient coordinates are LPS: +x = patient Left, +y = Posterior,
 * +z = Head. The row cosine points along increasing column index (towards the
 * right edge of the displayed image); the column cosine points along
 * increasing row index (towards the bottom edge).
 */

export interface OrientationMarkers {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

const POSITIVE = ["L", "P", "H"] as const;
const NEGATIVE = ["R", "A", "F"] as const;

/**
 * Label for a direction vector: the axes whose component is at least
 * `threshold`, ordered by magnitude (e.g. "L", "LP", "HPL" for oblique).
 */
export function directionLabel(v: readonly number[], threshold = 0.25): string {
  const axes = [0, 1, 2]
    .map((axis) => ({ axis, value: v[axis] ?? 0 }))
    .filter((a) => Math.abs(a.value) >= threshold)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return axes.map((a) => (a.value > 0 ? POSITIVE[a.axis] : NEGATIVE[a.axis])).join("");
}

/** Returns null when the orientation is missing or degenerate. */
export function orientationMarkers(iop: readonly number[] | undefined): OrientationMarkers | null {
  if (!iop || iop.length < 6 || !iop.slice(0, 6).every((n) => Number.isFinite(n))) return null;
  const row = normalize(iop.slice(0, 3));
  const col = normalize(iop.slice(3, 6));
  if (!row || !col) return null;
  const right = directionLabel(row);
  const bottom = directionLabel(col);
  if (!right || !bottom) return null;
  return {
    right,
    left: directionLabel(row.map((n) => -n)),
    bottom,
    top: directionLabel(col.map((n) => -n)),
  };
}

function normalize(v: number[]): number[] | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-6)) return null;
  return v.map((n) => n / len);
}
