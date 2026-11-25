/**
 * @file Paged slice loading: fetches the chunk holding the current slice
 * first, then prefetches outward with limited concurrency, decodes into a
 * byte-budgeted cache and exposes a subscribe/version API suitable for
 * React's useSyncExternalStore.
 *
 * Framework-free and transport-agnostic: `fetchChunk` and `decode` are
 * injected, so the same class serves the MCP bridge, the embedded bootstrap
 * payload and unit tests.
 */
import { chunkOrder, chunkStartFor, prefetchWindow } from "./prefetch";
import { SliceCache, type Sized } from "./slice-cache";

export type SliceStatus = "ready" | "loading" | "error" | "pending";

export interface SliceLoaderOptions<W extends { index: number }, T extends Sized> {
  total: number;
  /** Slices per request (MAX_SLICES_PER_REQUEST). */
  chunkSize: number;
  /** Concurrent background requests; the current chunk may use one extra. */
  concurrency: number;
  budgetBytes: number;
  /** Expected decoded size of one slice, used to size the prefetch window. */
  estimatedSliceBytes: number;
  fetchChunk: (start: number, count: number) => Promise<W[]>;
  decode: (wire: W) => Promise<T>;
}

export interface LoaderProgress {
  cached: number;
  total: number;
  /** Slices in the prefetch window (what "complete" means for the UI). */
  target: number;
  loading: boolean;
  failedChunks: number;
}

export class SliceLoader<W extends { index: number }, T extends Sized> {
  private readonly cache: SliceCache<T>;
  private readonly inflight = new Set<number>();
  private readonly failed = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private readonly maxWindow: number;
  private focus = 0;
  private started = false;
  private disposed = false;
  private version = 0;

  constructor(private readonly opts: SliceLoaderOptions<W, T>) {
    this.cache = new SliceCache<T>(opts.budgetBytes);
    const perSlice = Math.max(1, opts.estimatedSliceBytes);
    this.maxWindow = Math.max(
      Math.min(opts.total, opts.chunkSize * 2),
      Math.min(opts.total, Math.floor((opts.budgetBytes * 0.8) / perSlice)),
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  get total(): number {
    return this.opts.total;
  }

  /** Moves the loading focus; the chunk holding `index` is requested first. */
  setFocus(index: number): void {
    if (this.disposed || this.opts.total <= 0) return;
    const clamped = Math.max(0, Math.min(this.opts.total - 1, Math.round(index)));
    if (this.started && clamped === this.focus) return;
    this.started = true;
    this.focus = clamped;
    const { lo, hi } = this.window();
    this.cache.setProtected((i) => i >= lo && i <= hi);
    this.pump();
  }

  get(index: number): T | undefined {
    return this.cache.get(index);
  }

  /** Cached slice without refreshing its LRU position. */
  peek(index: number): T | undefined {
    return this.cache.peek(index);
  }

  /** Closest cached slice to `index` within `maxDistance`, if any. */
  nearest(index: number, maxDistance: number): T | undefined {
    for (let d = 0; d <= maxDistance; d++) {
      const a = this.cache.peek(index - d) ?? this.cache.peek(index + d);
      if (a) return a;
    }
    return undefined;
  }

  status(index: number): SliceStatus {
    if (this.cache.has(index)) return "ready";
    const chunk = chunkStartFor(index, this.opts.chunkSize);
    if (this.inflight.has(chunk)) return "loading";
    if (this.failed.has(chunk)) return "error";
    return "pending";
  }

  errorMessage(index: number): string | undefined {
    return this.failed.get(chunkStartFor(index, this.opts.chunkSize));
  }

  /** Clears failures and requests again. */
  retry(): void {
    if (this.disposed) return;
    this.failed.clear();
    this.bump();
    this.pump();
  }

  progress(): LoaderProgress {
    const { lo, hi } = this.window();
    return {
      cached: this.cache.size,
      total: this.opts.total,
      target: Math.max(0, hi - lo + 1),
      loading: this.inflight.size > 0,
      failedChunks: this.failed.size,
    };
  }

  /** Number of cached slices inside the current prefetch window. */
  cachedInWindow(): number {
    const { lo, hi } = this.window();
    let n = 0;
    for (const k of this.cache.keys()) if (k >= lo && k <= hi) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cache.clear();
  }

  private window(): { lo: number; hi: number } {
    return prefetchWindow(this.focus, this.opts.total, this.maxWindow);
  }

  private bump(): void {
    if (this.disposed) return;
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  private pump(): void {
    if (this.disposed || !this.started) return;
    const { chunkSize, concurrency, total } = this.opts;
    const { lo, hi } = this.window();
    const order = chunkOrder(this.focus, lo, hi, chunkSize);
    for (let k = 0; k < order.length; k++) {
      const limit = k === 0 ? concurrency + 1 : concurrency;
      if (this.inflight.size >= limit) {
        if (k === 0) continue;
        break;
      }
      const start = order[k];
      if (this.inflight.has(start) || this.failed.has(start)) continue;
      // Only slices inside the window: they are protected from eviction, so
      // a fetched slice can never be evicted and re-requested in a loop.
      const from = Math.max(start, lo);
      const end = Math.min(start + chunkSize, total, hi + 1);
      let first = -1;
      let last = -1;
      for (let i = from; i < end; i++) {
        if (!this.cache.has(i)) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) continue;
      void this.load(start, first, last - first + 1);
    }
  }

  private async load(chunk: number, from: number, count: number): Promise<void> {
    this.inflight.add(chunk);
    this.bump();
    try {
      const wire = await this.opts.fetchChunk(from, count);
      if (this.disposed) return;
      const received = new Set<number>();
      for (const w of wire) {
        if (!Number.isInteger(w.index) || w.index < 0 || w.index >= this.opts.total) continue;
        const decoded = await this.opts.decode(w);
        if (this.disposed) return;
        this.cache.set(w.index, decoded);
        received.add(w.index);
        this.bump();
      }
      const missing: number[] = [];
      for (let i = from; i < from + count; i++) if (!received.has(i)) missing.push(i);
      if (missing.length > 0) {
        throw new Error(
          `No pixel data returned for slice${missing.length > 1 ? "s" : ""} ${missing
            .slice(0, 3)
            .map((i) => i + 1)
            .join(", ")}${missing.length > 3 ? "…" : ""}`,
        );
      }
    } catch (err) {
      if (this.disposed) return;
      this.failed.set(chunk, err instanceof Error ? err.message : String(err));
    } finally {
      this.inflight.delete(chunk);
      if (!this.disposed) {
        this.bump();
        this.pump();
      }
    }
  }
}
