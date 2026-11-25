/**
 * Least-recently-used cache bounded by a total "cost" (bytes for pixel data).
 * Relies on Map preserving insertion order: the first key is the oldest.
 */
export class ByteBudgetLru<K, V> {
  private readonly entries = new Map<K, { value: V; cost: number }>();
  private total = 0;

  constructor(
    private readonly budget: number,
    private readonly costOf: (value: V) => number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get totalCost(): number {
    return this.total;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const cost = Math.max(0, this.costOf(value));
    const existing = this.entries.get(key);
    if (existing) {
      this.total -= existing.cost;
      this.entries.delete(key);
    }
    // Items larger than the whole budget are not cached at all.
    if (cost > this.budget) return;
    this.entries.set(key, { value, cost });
    this.total += cost;
    while (this.total > this.budget) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.total -= evicted.cost;
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight; keeps order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
