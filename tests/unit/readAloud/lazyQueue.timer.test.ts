/**
 * LazyTranslateQueue timer ownership (timerWindow) + dead-view guard.
 *
 * The geometry poll MUST run on the chrome (main) window: a chrome closure
 * registered on the SDT iframe's content window crashes xul.dll on Zotero
 * 10.0.6 within about a minute (real-machine QA 2026-10-22, exception
 * 0x80000003). These tests pin:
 *   - timerWindow wins over the content view when both expose setInterval;
 *   - the content view remains the fallback when no timerWindow is passed;
 *   - a poll over fully disconnected placeholders stops the queue (tab closed
 *     / reading mode torn down) instead of spinning on dead nodes forever;
 *   - connected placeholders keep polling.
 */

import { describe, expect, it, vi } from "vitest";
import {
  LazyTranslateQueue,
  type LazyQueueHooks,
} from "../../../src/core/pdf/sdt/lazyQueue";

function makeEl(connected: boolean): any {
  return {
    setAttribute: vi.fn(),
    dataset: {},
    isConnected: connected,
    getBoundingClientRect: () => ({ top: -99999, bottom: -99998 }),
  };
}

function fakeHooks(): LazyQueueHooks {
  return {
    translateBatch: async (list) => ({
      translations: list.map((t) => `译(${t})`),
      failedIndices: [],
    }),
  };
}

function makeQueue(
  entries: Map<string, { text: string; placeholder: any }>,
  options: Record<string, any>,
  doc?: any,
) {
  return new LazyTranslateQueue(
    doc ?? { defaultView: {} },
    entries,
    fakeHooks(),
    options,
  );
}

describe("LazyTranslateQueue poll timer ownership", () => {
  it("prefers timerWindow over the content view for setInterval", () => {
    const contentSetInterval = vi.fn(() => 1);
    const chromeSetInterval = vi.fn(() => 42);
    const queue = makeQueue(new Map([["1", { text: "a", placeholder: makeEl(true) }]]), {
      timerWindow: { setInterval: chromeSetInterval, clearInterval: vi.fn() },
    }, {
      defaultView: { setInterval: contentSetInterval, clearInterval: vi.fn() },
    });
    queue.start();
    expect(chromeSetInterval).toHaveBeenCalledTimes(1);
    expect(contentSetInterval).not.toHaveBeenCalled();
  });

  it("falls back to the content view when no timerWindow is given", () => {
    const contentSetInterval = vi.fn(() => 7);
    const queue = makeQueue(new Map([["1", { text: "a", placeholder: makeEl(true) }]]), {}, {
      defaultView: { setInterval: contentSetInterval, clearInterval: vi.fn() },
    });
    queue.start();
    expect(contentSetInterval).toHaveBeenCalledTimes(1);
  });

  it("stops the poll when every placeholder has disconnected", () => {
    const clearInterval = vi.fn();
    const setInterval = vi.fn((_poll: () => void) => 42);
    const queue = makeQueue(new Map([["1", { text: "a", placeholder: makeEl(false) }]]), {
      timerWindow: { setInterval, clearInterval },
    });
    queue.start();
    const poll = setInterval.mock.calls[0][0];
    poll();
    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(queue.stats().total).toBe(1);
  });

  it("keeps polling while placeholders remain connected", () => {
    const clearInterval = vi.fn();
    const setInterval = vi.fn((_fn: () => void) => 42);
    const queue = makeQueue(new Map([["1", { text: "a", placeholder: makeEl(true) }]]), {
      timerWindow: { setInterval, clearInterval },
    });
    queue.start();
    const poll = setInterval.mock.calls[0][0];
    poll();
    poll();
    expect(clearInterval).not.toHaveBeenCalled();
  });

  it("clears the interval on timerWindow in stop()", () => {
    const clearInterval = vi.fn();
    const setInterval = vi.fn((_poll: () => void) => 42);
    const queue = makeQueue(new Map([["1", { text: "a", placeholder: makeEl(true) }]]), {
      timerWindow: { setInterval, clearInterval },
    });
    queue.start();
    queue.stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
