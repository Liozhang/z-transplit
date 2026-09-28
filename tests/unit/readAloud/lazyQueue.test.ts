/**
 * LazyTranslateQueue tests — run WITHOUT IntersectionObserver (the fake doc
 * has none), which drives the eager "translate everything immediately" path;
 * that path is the queue's degenerate case and exercises the full pipeline.
 * Viewport behavior itself is gated to the real-machine matrix.
 */

import { describe, expect, it, vi } from "vitest";
import {
  LazyTranslateQueue,
  type LazyQueueHooks,
} from "../../../src/core/pdf/sdt/lazyQueue";

function fakeEl(): any {
  return { setAttribute: vi.fn(), dataset: {} };
}

function fakeDoc(): any {
  return { defaultView: {} }; // no IntersectionObserver → eager path
}

function makeQueue(
  texts: Record<string, string>,
  hooks: Partial<LazyQueueHooks>,
  options?: { concurrency?: number; batchSize?: number; signal?: AbortSignal },
) {
  const entries = new Map(
    Object.entries(texts).map(([refPath, text]) => [
      refPath,
      { text, placeholder: fakeEl() },
    ]),
  );
  const queue = new LazyTranslateQueue(
    fakeDoc(),
    entries,
    {
      translateBatch: async (list) => ({
        translations: list.map((t) => `译(${t})`),
        failedIndices: [],
      }),
      ...hooks,
    },
    options,
  );
  return { queue, entries };
}

describe("LazyTranslateQueue (eager path, no IntersectionObserver)", () => {
  it("translates every entry and reports done via onDone", async () => {
    const onDone = vi.fn();
    const { queue } = makeQueue(
      { "1": "alpha", "2": "beta", "3": "gamma" },
      { onDone },
    );
    queue.start();
    await vi.waitFor(() => {
      expect(queue.stats().done).toBe(3);
    });
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(onDone.mock.calls.map((c) => c[0]).sort()).toEqual(["1", "2", "3"]);
    expect(onDone.mock.calls[0][1]).toMatch(/^译\(/);
  });

  it("serves cache hits without engine calls and stores fresh results", async () => {
    const translateBatch = vi.fn(async (list: string[]) => ({
      translations: list.map((t) => `译(${t})`),
      failedIndices: [],
    }));
    const store = vi.fn();
    const { queue } = makeQueue(
      { "1": "cached text", "2": "fresh text" },
      {
        translateBatch,
        lookup: async (texts) => new Map([["cached text", "命中"]]),
        store,
      },
      { batchSize: 8 },
    );
    queue.start();
    await vi.waitFor(() => expect(queue.stats().done).toBe(2));
    expect(translateBatch).toHaveBeenCalledTimes(1);
    expect(translateBatch.mock.calls[0][0]).toEqual(["fresh text"]);
    expect(store).toHaveBeenCalledWith("fresh text", "译(fresh text)");
  });

  it("routes failed translations to onFailed and supports retry", async () => {
    let failFirst = true;
    const onFailed = vi.fn();
    const onDone = vi.fn();
    const { queue } = makeQueue(
      { "1": "flaky paragraph" },
      {
        onFailed,
        onDone,
        translateBatch: async (list: string[]) =>
          failFirst
            ? { translations: list, failedIndices: [0] }
            : { translations: list.map((t) => `译(${t})`), failedIndices: [] },
      },
    );
    queue.start();
    await vi.waitFor(() => expect(queue.stats().failed).toBe(1));
    expect(onFailed).toHaveBeenCalledWith("1");
    failFirst = false;
    queue.retry("1");
    await vi.waitFor(() => expect(queue.stats().done).toBe(1));
    expect(onDone).toHaveBeenCalled();
  });

  it("marks failed when the whole batch call throws", async () => {
    const onFailed = vi.fn();
    const { queue } = makeQueue(
      { "1": "a", "2": "b" },
      {
        onFailed,
        translateBatch: async () => {
          throw new Error("engine down");
        },
      },
    );
    queue.start();
    await vi.waitFor(() => expect(queue.stats().failed).toBe(2));
  });

  it("respects the abort signal (skips dispatch)", async () => {
    const translateBatch = vi.fn(async () => ({
      translations: [] as string[],
      failedIndices: [],
    }));
    const controller = new AbortController();
    controller.abort();
    const { queue } = makeQueue(
      { "1": "never translated" },
      { translateBatch },
      { signal: controller.signal },
    );
    queue.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(translateBatch).not.toHaveBeenCalled();
    expect(queue.stats().done).toBe(0);
  });

  it("emits progress with sane stats", async () => {
    const onProgress = vi.fn();
    const { queue } = makeQueue(
      { "1": "x", "2": "y" },
      { onProgress },
      { concurrency: 1 },
    );
    queue.start();
    await vi.waitFor(() => expect(queue.stats().done).toBe(2));
    const last = onProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ total: 2, done: 2, failed: 0 });
  });
});
