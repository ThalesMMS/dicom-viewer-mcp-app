/**
 * @file Byte-budgeted LRU cache of decoded slices. Entries for which the
 * protection predicate returns true (the slices around the current position)
 * are never evicted, even if that temporarily exceeds the budget.
 */

export interface Sized {
  byteLength: number;
}

export class SliceCache<T extends Sized> {
  private readonly map = new Map<number, T>();
  private bytes = 0;
  private isProtected: (index: number) => boolean = () => false;

  constructor(readonly budgetBytes: number) {}

  get(index: number): T | undefined {
    const v = this.map.get(index);
    if (v !== undefined) {
      // Refresh recency.
      this.map.delete(index);
      this.map.set(index, v);
    }
    return v;
  }

  /** Lookup without touching recency. */
  peek(index: number): T | undefined {
    return this.map.get(index);
  }

  has(index: number): boolean {
    return this.map.has(index);
  }

  set(index: number, value: T): void {
    const prev = this.map.get(index);
    if (prev) {
      this.bytes -= prev.byteLength;
      this.map.delete(index);
    }
    this.map.set(index, value);
    this.bytes += value.byteLength;
    this.evict();
  }

  /** Sets which indices must stay resident, then trims to budget. */
  setProtected(predicate: (index: number) => boolean): void {
    this.isProtected = predicate;
    this.evict();
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get byteSize(): number {
    return this.bytes;
  }

  get size(): number {
    return this.map.size;
  }

  keys(): number[] {
    return [...this.map.keys()];
  }

  private evict(): void {
    if (this.bytes <= this.budgetBytes) return;
    // Map iteration order is insertion order == least recently used first.
    for (const [index, value] of this.map) {
      if (this.bytes <= this.budgetBytes) break;
      if (this.isProtected(index)) continue;
      this.map.delete(index);
      this.bytes -= value.byteLength;
    }
  }
}
