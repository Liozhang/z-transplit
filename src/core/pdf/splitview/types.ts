/**
 * splitview/types — Shared types for the XUL split-view reader module.
 *
 * The split view injects an hbox with two <browser> elements (each loading
 * Zotero's reader.html) into a reader tab, so two PDFs (source + translated)
 * display side by side. These types are the contract between the factory
 * (splitViewFactory.ts) and the per-pane adapter (readerPaneAdapter.ts).
 *
 * Ported from leadero's src/core/pdf/splitview/types.ts (pure types, zero
 * imports; the zotero-split-viewer lineage in the original header is historical
 * context only).
 *
 * @module core/pdf/splitview/types
 */

/** One side of a split view. */
export type SplitSide = "left" | "right";

/**
 * Per-tab state for an open split view. All event listeners and timeouts are
 * tracked so cleanupTabResources() can remove them without leaks (XUL leaks
 * cause callbacks to fire after tab close → crashes).
 */
export interface SplitTabState {
  tabID: string;
  win: Window;
  /** The cloned container <elem id=tabID> that we re-purposed into an hbox. */
  container: any;
  /** The hbox holding leftBrowser + resizer + rightBrowser. */
  mainHbox: any;
  leftBrowser: any;
  rightBrowser: any;
  resizer: any;
  leftAdapter: ReaderPaneAdapter | null;
  rightAdapter: ReaderPaneAdapter | null;

  /** Current split ratio in [0.1, 0.9] — left share of total width. */
  splitRatio: number;

  // ── Scroll sync state ──
  /** True while dragging the resizer / zooming — pauses sync. */
  syncPaused: boolean;

  // Fraction-based scroll mirroring (two-tier):
  //   FAST PATH — a 'scroll' listener injected INTO pdf.js's content realm
  //   (via Cu.exportFunction) on each pane's #viewerContainer. Scroll events
  //   don't cross realms, but a content-side listener can call a chrome
  //   callback, so this fires on every wheel/scrollbar drag in real time and
  //   calls requestSync().
  //   SLOW PATH — a ~400ms backstop interval, in case injection failed or an
  //   event was missed.
  //   doSyncCheck reads each pane's getScrollFraction() (0-1 of scroll range),
  //   and mirrors whichever side moved to the other via setScrollFraction().
  //   Mirroring scrollTop by fraction is INSTANT (no animation), crosses pages
  //   automatically, and needs no page-number bookkeeping — fixing both the lag
  //   (no _setState smooth-scroll) and the cross-page breakage (no blending of
  //   a real-time page with a debounced offset into an impossible state).
  /** Reentrancy guard: our own setScrollFraction is propagating (prevents the
   *  target's scroll event from echoing back as a "user move"). */
  mirrorGuard: boolean;
  /** A doSyncCheck is already scheduled on the next rAF/timer (debounce). */
  syncScheduled: boolean;
  /** Last fraction read from each side, for change detection. */
  lastLeftFraction: number | null;
  lastRightFraction: number | null;
  /** Last horizontal scroll fraction per side (null = pane has no h-range). */
  lastLeftHFraction: number | null;
  lastRightHFraction: number | null;
  /** Last known pdf.js scale per side — drives zoom mirroring. Null = unread. */
  lastLeftScale: number | null;
  lastRightScale: number | null;
  /** Last known pdf.js scale VALUE string per side ("1.5", "page-width", …). */
  lastLeftScaleValue: string | null;
  lastRightScaleValue: string | null;
  /** Tracked slow-path interval id (for cleanup). */
  syncIntervalId: number | null;
  /** rAF id of a scheduled fast-path check (for cleanup). */
  syncRAFId: number | null;
  /** Cleanup functions returned by installScrollTrigger on each pane. */
  leftTriggerCleanup: (() => void) | null;
  rightTriggerCleanup: (() => void) | null;

  // ── Tracked resources for leak-free cleanup ──
  eventListeners: Array<{
    target: any;
    type: string;
    listener: any;
    options?: any;
  }>;
  timeoutIds: number[];

  /** Set true during cleanup so async callbacks bail out early. */
  isCleaningUp: boolean;
}

/** Options passed to a pane adapter's attach(). */
export interface ReaderPaneAttachOptions {
  tabID: string;
  side: SplitSide;
  /** Optional saved view state (page index/scale/scroll) to restore. */
  initialState?: any;
  /** Called when the reader raises its context menu. */
  onOpenContextMenu?: (params: { x: number; y: number }) => void;
  /** Called when the reader's view state changes (scroll/page change). */
  onChangeViewState?: (state: any) => void;
}

/**
 * Interface a pane adapter implements. The factory only talks to panes through
 * this interface, so it doesn't know each side is a reader.html instance.
 */
export interface ReaderPaneAdapter {
  readonly item: any;
  /** The underlying <browser> element. */
  browser: any;
  /** True once createReader has finished and _reader is available. */
  ready: boolean;
  /**
   * When true, the pane's onChangeViewState callback will ignore view-state
   * changes. Used to suppress ping-pong when applyPreciseState is driving the
   * other pane programmatically.
   */
  suppressOnChangeViewState?: boolean;

  attach(browser: any, opts: ReaderPaneAttachOptions): Promise<void>;
  /** The single scroll DOM element sync listens on (pdf.js #viewerContainer). */
  getScrollContainer(): any;
  /**
   * Poll until getScrollContainer() is reachable (pdf.js progressive setup
   * finishes well after _reader exists); resolves false on timeout. Awaiting
   * this is what openSplitView uses as its sync-ready gate. Optional so
   * mock-pane unit tests can omit it (mocks are container-ready by design).
   */
  waitForScrollContainer?(timeoutMs?: number): Promise<boolean>;
  /** Cheap per-tick scroll snapshot. */
  getPosition(): {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
  } | null;
  /** Read precise view state (pageIndex, scale, top, left) from pdf.js. */
  getPreciseState(): {
    pageIndex: number;
    scale: number;
    top: number;
    left: number;
  } | null;
  /** Apply precise view state to this pane (jump to page + offset). */
  applyPreciseState(state: {
    pageIndex: number;
    scale: number;
    top: number;
    left: number;
  }): Promise<void>;
  /**
   * Read this pane's scroll position as a 0-1 fraction of its scrollable range.
   * Used for fraction-based mirror sync (instant, crosses pages automatically,
   * no _setState smooth-scroll animation). Returns null if not scrollable.
   */
  getScrollFraction(): number | null;
  /**
   * Set this pane's scroll position from a 0-1 fraction. Instant (writes
   * scrollTop directly, no animation). Returns false if not applicable.
   */
  setScrollFraction(fraction: number): boolean;
  /**
   * Horizontal counterpart of getScrollFraction: scrollLeft as a 0-1 fraction
   * of the horizontal scroll range. Null when the page fits horizontally
   * (no h-scrollbar) — callers skip h-mirroring in that case.
   */
  getHScrollFraction(): number | null;
  /**
   * Horizontal counterpart of setScrollFraction. Writes scrollLeft directly.
   * Returns false when the pane has no horizontal range.
   */
  setHScrollFraction(fraction: number): boolean;
  /**
   * Inject a 'scroll' listener into this pane's pdf.js content realm
   * (#viewerContainer). Scroll events don't cross realms, so we attach the
   * listener on the content side and have it call back into chrome via a
   * Cu.exportFunction'd callback. Returns a cleanup fn that removes the
   * listener, or null if the container wasn't reachable.
   */
  installScrollTrigger(onScroll: () => void): (() => void) | null;
  /** Current pdf.js zoom scale (resolved number, never "auto"/"page-fit"). Null if unreachable. */
  getScale(): number | null;
  /** Set pdf.js zoom scale numerically. pdf.js clamps and re-anchors the view. */
  setScale(scale: number): boolean;
  /**
   * Raw pdf.js zoom value: a numeric string ("1.5") or a named mode
   * ("auto"/"page-actual"/"page-fit"/"page-width"). Mirroring a named mode lets
   * each pane resolve it against its own width instead of inheriting the other
   * pane's width-derived number.
   */
  getScaleValue(): string | null;
  /** Set the raw zoom value; named modes are applied natively by pdf.js. */
  setScaleValue(value: string): boolean;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  destroy(): void;
}
