/**
 * @file Prefetch planning: which chunk of slices to request next.
 * Chunks are aligned to multiples of the request size so that repeated
 * requests line up with what is already cached.
 */

export function chunkStartFor(index: number, chunkSize: number): number {
  return Math.floor(index / chunkSize) * chunkSize;
}

/**
 * Inclusive range of slice indices worth keeping around `focus`, at most
 * `maxSlices` wide, shifted inwards at the series ends.
 */
export function prefetchWindow(
  focus: number,
  total: number,
  maxSlices: number,
): { lo: number; hi: number } {
  if (total <= 0) return { lo: 0, hi: -1 };
  const span = Math.max(1, Math.min(total, Math.floor(maxSlices)));
  let lo = focus - Math.floor((span - 1) / 2);
  lo = Math.max(0, Math.min(lo, total - span));
  return { lo, hi: lo + span - 1 };
}

/**
 * Chunk starts intersecting [lo, hi], ordered outward from the chunk that
 * contains `focus` (forward first, then backward, alternating).
 */
export function chunkOrder(
  focus: number,
  lo: number,
  hi: number,
  chunkSize: number,
): number[] {
  if (hi < lo) return [];
  const first = chunkStartFor(Math.min(Math.max(focus, lo), hi), chunkSize);
  const minChunk = chunkStartFor(lo, chunkSize);
  const maxChunk = chunkStartFor(hi, chunkSize);
  const order = [first];
  for (let k = 1; ; k++) {
    const fwd = first + k * chunkSize;
    const back = first - k * chunkSize;
    const fwdOk = fwd <= maxChunk;
    const backOk = back >= minChunk;
    if (!fwdOk && !backOk) break;
    if (fwdOk) order.push(fwd);
    if (backOk) order.push(back);
  }
  return order;
}
