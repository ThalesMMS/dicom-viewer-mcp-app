/**
 * @file React binding for SliceLoader: one loader per series, disposed (and
 * its late responses ignored) when the series or transport changes.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { MAX_SLICES_PER_REQUEST, type SlicePixels } from "../../shared/protocol";
import { decodeSlice } from "../viewer/decode";
import { SliceLoader } from "../viewer/slice-loader";
import type { DecodedSlice } from "../viewer/types";

export type FetchSlices = (seriesInstanceUid: string, start: number, count: number) => Promise<SlicePixels[]>;
export type DicomSliceLoader = SliceLoader<SlicePixels, DecodedSlice>;

/** Decoded-slice memory budget. */
export const SLICE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const BACKGROUND_CONCURRENCY = 2;

const noopSubscribe = () => () => {};
const zero = () => 0;

export function useSliceLoader(
  seriesInstanceUid: string,
  total: number,
  estimatedSliceBytes: number,
  fetchSlices: FetchSlices,
): DicomSliceLoader | null {
  const [entry, setEntry] = useState<{ key: string; loader: DicomSliceLoader } | null>(null);

  useEffect(() => {
    const loader: DicomSliceLoader = new SliceLoader({
      total,
      chunkSize: MAX_SLICES_PER_REQUEST,
      concurrency: BACKGROUND_CONCURRENCY,
      budgetBytes: SLICE_CACHE_BUDGET_BYTES,
      estimatedSliceBytes,
      fetchChunk: (start, count) => fetchSlices(seriesInstanceUid, start, count),
      decode: decodeSlice,
    });
    setEntry({ key: seriesInstanceUid, loader });
    return () => loader.dispose();
  }, [seriesInstanceUid, total, estimatedSliceBytes, fetchSlices]);

  const loader = entry && entry.key === seriesInstanceUid ? entry.loader : null;
  useSyncExternalStore(loader ? loader.subscribe : noopSubscribe, loader ? loader.getVersion : zero);
  return loader;
}
