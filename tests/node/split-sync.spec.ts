 
/**
 * split-sync.spec — Unit tests for the split-view sync helpers.
 *
 * Covers:
 *   - viewStateToInternal (pageNumber → pageIndex, default fallbacks)
 *   - statesDiffer (page + offset change detection)
 *   - doSyncCheck (zoom mirroring + fraction-based scroll mirroring)
 *
 * These are pure functions exposed by splitViewFactory's re-export block
 * (splitViewFactory.ts re-exports them from splitViewSync — the contract
 * tests/node/split-sync.spec.ts and addon.ts consume).
 *
 * Ported from leadero's tests/node/split-sync.spec.ts (import paths unchanged
 * — the port mirrors leadero's src/ layout and keeps the re-export).
 *
 * Run: npm run test:unit -- split-sync
 */

import { describe, it, expect } from "vitest";
import { viewStateToInternal, statesDiffer, doSyncCheck } from "../../src/core/pdf/splitview/splitViewFactory";
import type { SplitTabState, ReaderPaneAdapter } from "../../src/core/pdf/splitview/types";

describe("viewStateToInternal", () => {
  it("converts 1-indexed pageNumber to 0-indexed pageIndex", () => {
    expect(viewStateToInternal({ pageNumber: 1, scale: 1, top: 0, left: 0 })).toEqual({
      pageIndex: 0,
      scale: 1,
      top: 0,
      left: 0,
    });
    expect(viewStateToInternal({ pageNumber: 5, scale: 1.5, top: 0.3, left: 0.1 })).toEqual({
      pageIndex: 4,
      scale: 1.5,
      top: 0.3,
      left: 0.1,
    });
  });

  it("defaults pageNumber to 1 when absent (so pageIndex falls back to 0)", () => {
    expect(viewStateToInternal({ scale: 1, top: 0, left: 0 })).toEqual({
      pageIndex: 0,
      scale: 1,
      top: 0,
      left: 0,
    });
  });

  it("defaults scale/top/left to 1/0/0 when absent", () => {
    expect(viewStateToInternal({ pageNumber: 3 })).toEqual({
      pageIndex: 2,
      scale: 1,
      top: 0,
      left: 0,
    });
  });

  it("handles completely empty input", () => {
    expect(viewStateToInternal({})).toEqual({
      pageIndex: 0,
      scale: 1,
      top: 0,
      left: 0,
    });
  });

  it("handles null/undefined fields gracefully", () => {
    expect(viewStateToInternal({ pageNumber: null, scale: undefined, top: null, left: undefined })).toEqual({
      pageIndex: 0,
      scale: 1,
      top: 0,
      left: 0,
    });
  });
});

describe("statesDiffer", () => {
  const base = { pageIndex: 2, top: 0.5, left: 0.2 };

  it("returns true when prev is null (first read)", () => {
    expect(statesDiffer(base, null)).toBe(true);
  });

  it("returns false when states are identical", () => {
    expect(statesDiffer(base, base)).toBe(false);
  });

  it("returns true on pageIndex change", () => {
    expect(statesDiffer({ ...base, pageIndex: 3 }, base)).toBe(true);
  });

  it("returns true when top delta exceeds threshold", () => {
    expect(statesDiffer({ ...base, top: 0.6 }, base, 0.05)).toBe(true);
  });

  it("returns false when top delta is within threshold", () => {
    expect(statesDiffer({ ...base, top: 0.51 }, base, 0.05)).toBe(false);
  });

  it("returns true when left delta exceeds threshold", () => {
    expect(statesDiffer({ ...base, left: 0.4 }, base, 0.1)).toBe(true);
  });

  it("returns false when left delta is within threshold", () => {
    expect(statesDiffer({ ...base, left: 0.21 }, base, 0.1)).toBe(false);
  });

  it("treats undefined/null top/left as 0", () => {
    const curr = { pageIndex: 0, top: undefined, left: null };
    const prev = { pageIndex: 0, top: 0, left: 0 };
    expect(statesDiffer(curr, prev, 0.01)).toBe(false);
  });
});

// ─── doSyncCheck: zoom mirroring + scroll mirror interplay ────────────────

/** Build a minimal SplitTabState with mock panes + fake win. */
function makeSyncState(overrides: Partial<SplitTabState> = {}): SplitTabState {
  const timers: Array<() => void> = [];
  const win = {
    setTimeout: (fn: () => void, _ms?: number) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    runTimers: () => {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
  } as any;

  const state: SplitTabState = {
    tabID: "t",
    win,
    container: null,
    mainHbox: null,
    leftBrowser: null,
    rightBrowser: null,
    resizer: null,
    leftAdapter: null,
    rightAdapter: null,
    splitRatio: 0.5,
    syncPaused: false,
    mirrorGuard: false,
    syncScheduled: false,
    lastLeftFraction: null,
    lastRightFraction: null,
    lastLeftHFraction: null,
    lastRightHFraction: null,
    lastLeftScale: null,
    lastRightScale: null,
    lastLeftScaleValue: null,
    lastRightScaleValue: null,
    syncIntervalId: null,
    syncRAFId: null,
    leftTriggerCleanup: null,
    rightTriggerCleanup: null,
    eventListeners: [],
    timeoutIds: [],
    isCleaningUp: false,
    ...overrides,
  };
  return state;
}

function mockPane(
  fraction: number,
  scale: number,
  opts: { hFraction?: number | null; scaleValue?: string } = {},
): ReaderPaneAdapter & {
  setScaleCalls: number[];
  setFractionCalls: number[];
  setScaleValueCalls: string[];
  setHFractionCalls: number[];
} {
  const calls = {
    setScaleCalls: [] as number[],
    setFractionCalls: [] as number[],
    setScaleValueCalls: [] as string[],
    setHFractionCalls: [] as number[],
  };
  const hFraction =
    opts.hFraction !== undefined ? opts.hFraction : null; // default: no h-range
  const scaleValue = opts.scaleValue ?? String(scale);
  return {
    item: null,
    browser: null,
    ready: true,
    attach: async () => {},
    getScrollContainer: () => null,
    getPosition: () => null,
    getPreciseState: () => null,
    applyPreciseState: async () => {},
    getScrollFraction: () => fraction,
    setScrollFraction: (f: number) => {
      calls.setFractionCalls.push(f);
      return true;
    },
    getHScrollFraction: () => hFraction,
    setHScrollFraction: (f: number) => {
      calls.setHFractionCalls.push(f);
      return true;
    },
    installScrollTrigger: () => null,
    getScale: () => scale,
    setScale: (s: number) => {
      calls.setScaleCalls.push(s);
      return true;
    },
    getScaleValue: () => scaleValue,
    setScaleValue: (v: string) => {
      calls.setScaleValueCalls.push(v);
      return true;
    },
    zoomIn: () => {},
    zoomOut: () => {},
    zoomReset: () => {},
    destroy: () => {},
    ...calls,
  } as any;
}

describe("doSyncCheck — zoom mirroring", () => {
  it("mirrors a left-pane zoom to the right pane and pauses scroll sync", () => {
    const left = mockPane(0.5, 1.5); // user zoomed left 1.0 → 1.5
    const right = mockPane(0.5, 1.0);
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    // Zoom mirrored exactly once, to the pane that did NOT zoom.
    expect(right.setScaleCalls).toEqual([1.5]);
    expect(left.setScaleCalls).toEqual([]);
    // Scroll mirroring suppressed during zoom churn — no fraction apply.
    expect(right.setFractionCalls).toEqual([]);
    expect(left.setFractionCalls).toEqual([]);
    expect(state.syncPaused).toBe(true);
  });

  it("mirrors a right-pane zoom to the left pane", () => {
    const left = mockPane(0.3, 1.0);
    const right = mockPane(0.3, 0.75); // user zoomed out right 1.0 → 0.75
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.3,
      lastRightFraction: 0.3,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    expect(left.setScaleCalls).toEqual([0.75]);
    expect(right.setScaleCalls).toEqual([]);
    expect(state.syncPaused).toBe(true);
  });

  it("resumes scroll sync and re-primes baselines after the settle window", () => {
    const left = mockPane(0.42, 1.5);
    const right = mockPane(0.42, 1.5); // setScale already applied by the engine
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.42,
      lastRightFraction: 0.42,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state); // zoom detected → paused
    expect(state.syncPaused).toBe(true);

    // Fire the settle timeout (trackTimeout went through win.setTimeout).
    (state.win as any).runTimers();

    expect(state.syncPaused).toBe(false);
    // Scales re-primed to the settled values — a subsequent check with no
    // further change must NOT re-trigger zoom mirroring.
    right.setScaleCalls.length = 0;
    doSyncCheck(state);
    expect(right.setScaleCalls).toEqual([]);
    expect(state.syncPaused).toBe(false);
  });

  it("still mirrors scroll when scales are stable (regression)", () => {
    const left = mockPane(0.6, 1.0); // user scrolled left
    const right = mockPane(0.2, 1.0);
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.2,
      lastRightFraction: 0.2,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    expect(right.setFractionCalls).toEqual([0.6]);
    expect(right.setScaleCalls).toEqual([]); // no zoom involved
  });

  it("ignores scale churn below the threshold (float noise)", () => {
    const left = mockPane(0.5, 1.0000005);
    const right = mockPane(0.5, 1.0);
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    expect(right.setScaleCalls).toEqual([]);
    expect(state.syncPaused).toBe(false);
  });

  it("mirrors a named zoom mode as a MODE (each pane resolves its own width)", () => {
    // Numeric scales identical (no numeric delta) — only the MODE changed.
    const left = mockPane(0.5, 1.2, { scaleValue: "page-width" });
    const right = mockPane(0.5, 1.2, { scaleValue: "1.2" });
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftScale: 1.2,
      lastRightScale: 1.2,
      lastLeftScaleValue: "1.2",
      lastRightScaleValue: "1.2",
    });

    doSyncCheck(state);

    // Mode mirrored via setScaleValue — NOT via the resolved number.
    expect(right.setScaleValueCalls).toEqual(["page-width"]);
    expect(right.setScaleCalls).toEqual([]);
    expect(state.syncPaused).toBe(true);
  });

  it("numeric zoom still mirrors via setScale (not setScaleValue)", () => {
    const left = mockPane(0.5, 1.8); // user zoomed 1.0 → 1.8, value "1.8"
    const right = mockPane(0.5, 1.0);
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
      lastLeftScaleValue: "1.0",
      lastRightScaleValue: "1.0",
    });

    doSyncCheck(state);

    expect(right.setScaleCalls).toEqual([1.8]);
    expect(right.setScaleValueCalls).toEqual([]);
  });
});

describe("doSyncCheck — horizontal scroll mirroring", () => {
  it("a horizontal-only move mirrors the h-fraction to the other pane", () => {
    const left = mockPane(0.5, 1.0, { hFraction: 0.8 }); // user panned left→right
    const right = mockPane(0.5, 1.0, { hFraction: 0.2 });
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftHFraction: 0.2,
      lastRightHFraction: 0.2,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    expect(right.setHFractionCalls).toEqual([0.8]);
    expect(right.setFractionCalls).toEqual([0.5]); // v re-applied (no-op value)
  });

  it("skips the h-apply when the source pane has no horizontal range", () => {
    const left = mockPane(0.6, 1.0); // hFraction defaults to null (fits)
    const right = mockPane(0.2, 1.0, { hFraction: 0.4 });
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.2,
      lastRightFraction: 0.2,
      lastLeftHFraction: null,
      lastRightHFraction: 0.4,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state); // vertical user scroll on the left

    expect(right.setFractionCalls).toEqual([0.6]);
    expect(right.setHFractionCalls).toEqual([]); // source h is null → untouched
  });

  it("h-null transitions never count as a move", () => {
    const left = mockPane(0.5, 1.0); // null h-range before AND after
    const right = mockPane(0.5, 1.0);
    const state = makeSyncState({
      leftAdapter: left,
      rightAdapter: right,
      lastLeftFraction: 0.5,
      lastRightFraction: 0.5,
      lastLeftHFraction: 0.9, // previously had a range (e.g. before re-layout)
      lastRightHFraction: null,
      lastLeftScale: 1.0,
      lastRightScale: 1.0,
    });

    doSyncCheck(state);

    // 0.9 → null is NOT a move: nothing mirrored, just re-baselined.
    expect(right.setFractionCalls).toEqual([]);
    expect(right.setHFractionCalls).toEqual([]);
  });
});
