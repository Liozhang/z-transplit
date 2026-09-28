/**
 * 分屏**双窗格同步引擎**。
 *
 * 这一簇负责"左右两个 reader 的缩放/滚动保持同一视点"：状态归一化
 * （`viewStateToInternal` / `statesDiffer`）、基线采样与阈值判定（`fractionMoved` /
 * `hFractionMoved` / `FRACTION_THRESHOLD` / `SCALE_THRESHOLD`）、同步循环与去抖
 * （`installSync` / `requestSync` / `doSyncCheck` / `primeSyncBaselines`）、以及
 * 事件/定时器的统一回收（`addTrackedListener` / `trackTimeout`）。
 *
 * 对宿主**零反向引用**（纯逻辑叶子）：`splitViewCleanup` 读本件的 `stateMap`，
 * 方向单一，没有环。覆盖它的是 tests/node/split-sync.spec.ts（mock pane +
 * fake win，无 Zotero 运行时）。
 *
 * Ported from leadero's src/core/pdf/splitview/splitViewSync.ts (verbatim;
 * only the [Leadero splitView] debug prefix was renamed).
 *
 * @module core/pdf/splitview/splitViewSync
 */

import type { SplitTabState } from "./types";

/**
 * Convert a content-realm onChangeViewState payload into the internal
 * {pageIndex, scale, top, left} shape.
 *
 * pdf.js reports `pageNumber` (1-indexed); our internal state uses `pageIndex`
 * (0-indexed). `top`/`left` are pixel offsets within the page (the same units
 * pdf.js stores in `PDFViewer._location` and consumes in `_setState`), so they
 * pass through unchanged.
 */
export function viewStateToInternal(viewState: any): {
  pageIndex: number;
  scale: number;
  top: number;
  left: number;
} | null {
  // Zotero's reader fires onChangeViewState with a null payload during tab
  // close / switch / teardown. Without this guard we threw
  // "can't access property 'pageNumber', viewState is null" (repeated in the
  // console during split-view teardown). Returning null lets callers no-op.
  if (!viewState || typeof viewState !== "object") return null;
  return {
    pageIndex: (viewState.pageNumber || 1) - 1,
    scale: viewState.scale ?? 1,
    top: viewState.top ?? 0,
    left: viewState.left ?? 0,
  };
}

/**
 * Return true when `curr` differs from `prev` by more than trivial jitter.
 *
 * `top`/`left` are pixel offsets (per pdf.js _location), so the default
 * threshold of 8px ignores sub-pixel/CSS rounding noise but still catches a
 * real scrollbar drag. A page change always counts as a difference.
 */
/**
 * Scroll-state shape as it actually arrives from the reader: `top`/`left` are
 * `undefined` before the first layout and `null` when a pane reports no
 * scrollable range, which the `?? 0` fallbacks below normalise. Typing them as
 * plain `number` would make every real call site lie.
 */
export interface ScrollStateLike {
  pageIndex: number;
  top?: number | null;
  left?: number | null;
}

export function statesDiffer(
  curr: ScrollStateLike,
  prev: ScrollStateLike | null,
  threshold = 8,
): boolean {
  if (!prev) return true;
  if (curr.pageIndex !== prev.pageIndex) return true;
  if (Math.abs((curr.top ?? 0) - (prev.top ?? 0)) > threshold) return true;
  if (Math.abs((curr.left ?? 0) - (prev.left ?? 0)) > threshold) return true;
  return false;
}

export const stateMap = new Map<string, SplitTabState>();

//
// WHY MIRROR scrollTop (not _setState): the page+offset approach went through
// pdf.js _setState → scrollPageIntoView, which (a) runs a SMOOTH-SCROLL
// animation → perceptible lag, and (b) blended a real-time currentPageNumber
// with a debounced _location.top into an impossible state on page boundaries →
// the pane jumped back to page 1. Mirroring scrollTop directly is INSTANT (no
// animation), crosses page boundaries automatically, and needs no page math.
//
// We mirror by FRACTION (scrollTop / scrollable range) so the two panes stay
// aligned even when their total heights differ (different page counts / fonts
// in a source-vs-translated pair). getScrollFraction()/setScrollFraction() do
// the work; both read live bounds, so it stays correct after resizer drags.
//
// FAST PATH: a 'scroll' listener injected INTO each pane's pdf.js content realm
// (Cu.exportFunction) bridges back to chrome and calls requestSync(), which
// rAF-batches the burst into one doSyncCheck per frame.
// SLOW PATH: a ~400ms backstop interval, in case injection failed or an
// event was missed.
//
// Ping-pong prevention: mirrorGuard is set while our own setScrollFraction is
// propagating, so the target pane's resulting scroll event is ignored as a
// "user move". The fraction thresholds in doSyncCheck also ignore sub-pixel
// noise.

export const SYNC_INTERVAL = 400;

// ms — backstop poll only; fast path is event-driven
/** Ignore fraction deltas below this (sub-pixel / rounding noise). */
export const FRACTION_THRESHOLD = 0.002;

/** Ignore scale deltas below this (float noise in pdf.js scale math). */
export const SCALE_THRESHOLD = 0.001;

/** pdf.js named zoom modes — mirrored as MODES, not resolved numbers. */
export const NAMED_ZOOM_MODES = new Set([
  "auto",
  "page-actual",
  "page-fit",
  "page-width",
]);

/**
 * How long to pause scroll mirroring after a zoom change. pdf.js re-renders
 * pages asynchronously after a scale change: scrollHeight grows in steps,
 * scrollTop re-anchors late, and mid-render scroll events carry transient
 * garbage fractions. Mirroring during that window (a) yanks the other pane to
 * a wrong position and (b) its delayed settle events escape the one-tick
 * mirrorGuard and ping-pong back. Pause, let it settle, re-prime baselines.
 */
export const ZOOM_SETTLE_MS = 350;

/**
 * Schedule one doSyncCheck on the next animation frame (16ms debounce). Scroll
 * events fire in bursts; this coalesces them into a single check per frame.
 */
export function requestSync(state: SplitTabState): void {
  if (state.isCleaningUp || state.syncScheduled || state.mirrorGuard) return;
  state.syncScheduled = true;
  const raf =
    (state.win as any).requestAnimationFrame ||
    ((cb: () => void) => (state.win as any).setTimeout(cb, 16));
  state.syncRAFId = raf(() => {
    state.syncScheduled = false;
    state.syncRAFId = null;
    doSyncCheck(state);
  });
}

/**
 * Fraction-based mirror sync. Reads each pane's scroll fraction; if one moved
 * beyond the threshold since last check, mirrors its fraction to the other via
 * setScrollFraction(). mirrorGuard suppresses the echo from our own apply.
 *
 * ZOOM LAYER (runs first): a zoom on either pane changes scrollHeight/scrollTop
 * asynchronously (pdf.js re-renders progressively), so scroll events during a
 * zoom carry transient fractions that must NOT be mirrored. Instead: mirror the
 * new scale to the other pane, pause scroll mirroring for ZOOM_SETTLE_MS, then
 * re-prime both baselines when layout has settled.
 *
 * Exported for unit tests (mock adapters + fake win; see split-sync.spec.ts).
 */
export function doSyncCheck(state: SplitTabState): void {
  if (state.isCleaningUp || state.syncPaused || state.mirrorGuard) return;
  const left = state.leftAdapter;
  const right = state.rightAdapter;
  if (!left || !right) return;

  // ── Zoom mirroring (before any scroll logic) ─────────────────────────────
  const ls = left.getScale?.();
  const rs = right.getScale?.();
  if (ls != null && rs != null) {
    const lv = left.getScaleValue?.() ?? "";
    const rv = right.getScaleValue?.() ?? "";
    const leftZoomed =
      (state.lastLeftScale != null &&
        Math.abs(ls - state.lastLeftScale) > SCALE_THRESHOLD) ||
      (NAMED_ZOOM_MODES.has(lv) && lv !== state.lastLeftScaleValue);
    const rightZoomed =
      (state.lastRightScale != null &&
        Math.abs(rs - state.lastRightScale) > SCALE_THRESHOLD) ||
      (NAMED_ZOOM_MODES.has(rv) && rv !== state.lastRightScaleValue);
    if (leftZoomed || rightZoomed) {
      const srcScale = leftZoomed ? ls : rs;
      const srcValue = leftZoomed ? lv : rv;
      const zoomTarget = leftZoomed ? right : left;
      state.lastLeftScale = srcScale;
      state.lastRightScale = srcScale;
      state.lastLeftScaleValue = srcValue;
      state.lastRightScaleValue = srcValue;
      // Named mode → mirror the MODE so each pane resolves it against its own
      // width; numeric zoom → mirror the resolved number (exact parity).
      if (NAMED_ZOOM_MODES.has(srcValue)) {
        zoomTarget.setScaleValue?.(srcValue);
      } else {
        zoomTarget.setScale?.(srcScale);
      }
      // The target's post-mode resolved scale may differ from srcScale; the
      // settle re-prime records actuals, and syncPaused blocks checks meanwhile.
      pauseSyncForZoomSettle(state);
      return;
    }
    state.lastLeftScale = ls;
    state.lastRightScale = rs;
    state.lastLeftScaleValue = lv;
    state.lastRightScaleValue = rv;
  }

  const lf = left.getScrollFraction();
  const rf = right.getScrollFraction();
  if (lf == null || rf == null) return;

  // Horizontal fractions: null = pane has no h-range (page fits) → skip h.
  const lhf = left.getHScrollFraction?.() ?? null;
  const rhf = right.getHScrollFraction?.() ?? null;

  const leftMoved =
    fractionMoved(lf, state.lastLeftFraction) ||
    hFractionMoved(lhf, state.lastLeftHFraction);
  const rightMoved =
    fractionMoved(rf, state.lastRightFraction) ||
    hFractionMoved(rhf, state.lastRightHFraction);

  // Both moved (or neither beyond threshold) — no clear source; just re-baseline.
  if (leftMoved === rightMoved) {
    state.lastLeftFraction = lf;
    state.lastRightFraction = rf;
    state.lastLeftHFraction = lhf;
    state.lastRightHFraction = rhf;
    return;
  }

  // Mirror the moved side's fractions (vertical + horizontal) to the other.
  const src = leftMoved ? lf : rf;
  const srcH = leftMoved ? lhf : rhf;
  const target = leftMoved ? right : left;
  state.mirrorGuard = true;
  try {
    target.setScrollFraction(src);
    if (srcH != null) target.setHScrollFraction?.(srcH);
  } finally {
    // Clear on the next tick so the target's scroll event (fired synchronously
    // by setting scrollTop) is caught by the guard.
    (state.win as any).setTimeout(() => {
      state.mirrorGuard = false;
    }, 0);
  }
  // Re-baseline BOTH sides to the source fractions: the target is now at `src`
  // (we just set it), so recording `src` for it prevents the next check from
  // treating our own apply as a new move and ping-ponging back.
  state.lastLeftFraction = src;
  state.lastRightFraction = src;
  state.lastLeftHFraction = srcH;
  state.lastRightHFraction = srcH;
}

/**
 * Pause scroll mirroring for ZOOM_SETTLE_MS after a zoom change, then re-prime
 * the fraction baselines from the settled layout. Mirrors the resizer's
 * pause/resume pattern (installResizer).
 */
export function pauseSyncForZoomSettle(state: SplitTabState): void {
  state.syncPaused = true;
  trackTimeout(
    state,
    () => {
      if (state.isCleaningUp) return;
      state.syncPaused = false;
      primeSyncBaselines(state);
    },
    ZOOM_SETTLE_MS,
  );
}

/** Did a fraction change beyond the threshold since the last snapshot? */
export function fractionMoved(curr: number, prev: number | null): boolean {
  if (prev == null) return false; // first read after prime — not a user move
  return Math.abs(curr - prev) > FRACTION_THRESHOLD;
}

/**
 * Horizontal counterpart. Null on either side means "no h-range / unread" —
 * never counts as a move (a zoom-settle prime or a page that fits horizontally
 * legitimately produces nulls).
 */
export function hFractionMoved(
  curr: number | null,
  prev: number | null,
): boolean {
  if (curr == null || prev == null) return false;
  return Math.abs(curr - prev) > FRACTION_THRESHOLD;
}

/** Prime the fraction baselines from the current positions (no spurious sync). */
export function primeSyncBaselines(state: SplitTabState): void {
  state.lastLeftFraction = state.leftAdapter?.getScrollFraction?.() ?? null;
  state.lastRightFraction = state.rightAdapter?.getScrollFraction?.() ?? null;
  state.lastLeftHFraction = state.leftAdapter?.getHScrollFraction?.() ?? null;
  state.lastRightHFraction = state.rightAdapter?.getHScrollFraction?.() ?? null;
  // Re-prime scales too: after a settle (zoom / resize), the current values are
  // the new normal — not a change to mirror again.
  const ls = state.leftAdapter?.getScale?.();
  const rs = state.rightAdapter?.getScale?.();
  if (ls != null) state.lastLeftScale = ls;
  if (rs != null) state.lastRightScale = rs;
  const lv = state.leftAdapter?.getScaleValue?.();
  const rv = state.rightAdapter?.getScaleValue?.();
  if (lv != null) state.lastLeftScaleValue = lv;
  if (rv != null) state.lastRightScaleValue = rv;
}

/**
 * Inject scroll triggers into both panes and start the backstop interval.
 * Call after both readers are ready. Injection failure is non-fatal — the
 * backstop interval still drives sync (just at ~400ms instead of real-time).
 */
export function installSync(state: SplitTabState): void {
  primeSyncBaselines(state);

  // FAST PATH: inject a content-realm scroll listener on each pane. The
  // listener calls requestSync() (via exportFunction) on every scroll.
  if (state.leftAdapter) {
    const cleanup = state.leftAdapter.installScrollTrigger(() =>
      requestSync(state),
    );
    state.leftTriggerCleanup = cleanup;
    if (!cleanup) {
      Zotero.debug?.(
        "[Z-Transplit splitView] left scroll-trigger injection failed — relying on backstop poll",
      );
    }
  }
  if (state.rightAdapter) {
    const cleanup = state.rightAdapter.installScrollTrigger(() =>
      requestSync(state),
    );
    state.rightTriggerCleanup = cleanup;
    if (!cleanup) {
      Zotero.debug?.(
        "[Z-Transplit splitView] right scroll-trigger injection failed — relying on backstop poll",
      );
    }
  }

  // SLOW PATH: backstop poll in case injection failed or an event was missed.
  const id = (state.win as any).setInterval(
    () => doSyncCheck(state),
    SYNC_INTERVAL,
  );
  state.syncIntervalId = id;
  state.timeoutIds.push(id);
}

/**
 * The onChangeViewState handler attached to each pane. It does NOT apply state
 * directly — it just nudges requestSync so a page-flip syncs without waiting
 * for the backstop tick. (onChangeViewState fires on page-flip; the injected
 * scroll listener covers within-page scroll.)
 */
export function makeSyncTrigger(
  state: SplitTabState,
): (viewState: any) => void {
  return (_viewState: any) => {
    // viewState may be null during tab teardown; requestSync/doSyncCheck no-op.
    requestSync(state);
  };
}

export function addTrackedListener(
  state: SplitTabState,
  target: any,
  type: string,
  listener: any,
  options?: any,
): void {
  target.addEventListener(type, listener, options);
  state.eventListeners.push({ target, type, listener, options });
}

export function trackTimeout(
  state: SplitTabState,
  fn: () => void,
  ms: number,
): number {
  const id = (state.win as any).setTimeout(fn, ms);
  state.timeoutIds.push(id);
  return id;
}
