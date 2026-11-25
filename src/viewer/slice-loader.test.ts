import { describe, expect, it } from "vitest";
import { chunkOrder, prefetchWindow } from "./prefetch";
import { SliceLoader } from "./slice-loader";

interface Wire {
  index: number;
}
interface Item {
  index: number;
  byteLength: number;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await tick();
}

function makeLoader(total: number, opts: { budget?: number; fail?: (start: number) => boolean } = {}) {
  const calls: Array<[number, number]> = [];
  const pending: Array<() => void> = [];
  let manual = false;
  const loader = new SliceLoader<Wire, Item>({
    total,
    chunkSize: 8,
    concurrency: 2,
    budgetBytes: opts.budget ?? 1e9,
    estimatedSliceBytes: 100,
    fetchChunk: (start, count) => {
      calls.push([start, count]);
      const run = () =>
        opts.fail?.(start)
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(Array.from({ length: count }, (_, i) => ({ index: start + i })));
      if (!manual) return run();
      return new Promise<Wire[]>((resolve, reject) => pending.push(() => run().then(resolve, reject)));
    },
    decode: async (w) => ({ index: w.index, byteLength: 100 }),
  });
  return {
    loader,
    calls,
    pending,
    setManual: () => {
      manual = true;
    },
  };
}

describe("prefetch planning", () => {
  it("centres the window and shifts it at the ends", () => {
    expect(prefetchWindow(50, 100, 21)).toEqual({ lo: 40, hi: 60 });
    expect(prefetchWindow(2, 100, 21)).toEqual({ lo: 0, hi: 20 });
    expect(prefetchWindow(99, 100, 21)).toEqual({ lo: 79, hi: 99 });
    expect(prefetchWindow(3, 5, 100)).toEqual({ lo: 0, hi: 4 });
  });

  it("orders chunks outward from the focus chunk", () => {
    expect(chunkOrder(20, 0, 47, 8)).toEqual([16, 24, 8, 32, 0, 40]);
    expect(chunkOrder(0, 0, 30, 8)).toEqual([0, 8, 16, 24]);
  });
});

describe("SliceLoader", () => {
  it("loads the focus chunk first, then prefetches outward", async () => {
    const { loader, calls } = makeLoader(40);
    loader.setFocus(20);
    await settle();
    expect(calls[0]).toEqual([16, 8]);
    expect(calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([0, 8, 16, 24, 32]);
    expect(loader.status(20)).toBe("ready");
    expect(loader.progress().cached).toBe(40);
  });

  it("limits concurrency", async () => {
    const { loader, calls, pending, setManual } = makeLoader(64);
    setManual();
    loader.setFocus(0);
    // focus chunk + 2 background? focus counts toward the limit: at most 3 in flight.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(loader.status(0)).toBe("loading");
    pending.shift()?.();
    await settle();
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("only requests missing slices within the window", async () => {
    const { loader, calls } = makeLoader(100, { budget: 2000 }); // ~16 slices window
    loader.setFocus(50);
    await settle();
    const requested = new Set<number>();
    for (const [s, n] of calls) for (let i = s; i < s + n; i++) requested.add(i);
    expect(requested.has(50)).toBe(true);
    expect(requested.has(0)).toBe(false);
    expect(requested.has(99)).toBe(false);
  });

  it("evicts far slices but keeps the window when the focus moves", async () => {
    const { loader } = makeLoader(100, { budget: 2000 });
    loader.setFocus(0);
    await settle();
    loader.setFocus(90);
    await settle();
    expect(loader.status(90)).toBe("ready");
    expect(loader.status(0)).toBe("pending");
  });

  it("reports failures and retries", async () => {
    let failing = true;
    const { loader } = makeLoader(16, { fail: () => failing });
    loader.setFocus(3);
    await settle();
    expect(loader.status(3)).toBe("error");
    expect(loader.errorMessage(3)).toBe("boom");
    failing = false;
    loader.retry();
    await settle();
    expect(loader.status(3)).toBe("ready");
  });

  it("ignores responses after dispose", async () => {
    const { loader, pending, setManual } = makeLoader(16);
    setManual();
    let notified = 0;
    loader.subscribe(() => notified++);
    loader.setFocus(0);
    const before = notified;
    loader.dispose();
    pending.forEach((p) => p());
    await settle();
    expect(notified).toBe(before);
    expect(loader.get(0)).toBeUndefined();
  });
});
