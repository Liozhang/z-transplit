/**
 * splitview/readerPaneAdapter — Wraps one <browser> loading Zotero's reader.html
 * into a ReaderPaneAdapter, so the split-view factory can treat each side
 * uniformly (load PDF, get scroll container, zoom, destroy).
 *
 * The hard parts — createReader config + cloneInto + ftl — live in
 * readerConfig.ts; this file orchestrates browser load → createReader → poll
 * for the internal _reader, and exposes the scroll container the sync engine
 * listens on.
 *
 * Cross-realm access pattern (used throughout):
 *   browser.contentWindow → wrappedJSObject (unwraps XPCNativeWrapper) → content globals
 *
 * Host-coupled by nature (reader.html internals + Components.utils) — not
 * unit-testable in Node; the ported specs use mock panes instead.
 *
 * Ported from leadero's src/core/pdf/splitview/readerPaneAdapter.ts (verbatim;
 * log/debug prefixes renamed).
 *
 * @module core/pdf/splitview/readerPaneAdapter
 */

import type { ReaderPaneAdapter, ReaderPaneAttachOptions } from "./types";
import { buildReaderConfig, cloneIntoConfig } from "./readerConfig";
import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";
import { toErrorMessage } from "../../../utils/error";




/**
 * Create a <browser> pointing at Zotero's reader.html. Each browser is an
 * independent JS compartment that will host one reader instance.
 */
export function createReaderBrowser(win: Window): any {
  const doc = (win as any).document;
  const browser = doc.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("transparent", "true");
  browser.setAttribute("src", "resource://zotero/reader/reader.html");
  browser.style.flex = "1 1 0";
  browser.style.minWidth = "200px";
  browser.style.maxWidth = "none";
  browser.style.overflow = "hidden";
  browser.style.boxSizing = "border-box";
  return browser;
}


export class ReaderPane implements ReaderPaneAdapter {
  readonly item: any;
  browser: any;
  ready = false;
  suppressOnChangeViewState = false;

  private tabID = "";
  private side: "left" | "right" = "left";

  constructor(item: any) {
    this.item = item;
  }

  /**
   * Load reader.html and start a reader instance via the page's createReader
   * global. Await resolves once the internal _reader is available.
   */
  async attach(browser: any, opts: ReaderPaneAttachOptions): Promise<void> {
    this.browser = browser;
    this.tabID = opts.tabID;
    this.side = opts.side;

    await this.waitForBrowserLoad(browser);
    const win: any = browser.contentWindow;
    const wrappedWin = win.wrappedJSObject || win;

    const config = buildReaderConfig(this.item, {
      initialState: opts.initialState,
      onOpenContextMenu: opts.onOpenContextMenu,
      onChangeViewState: opts.onChangeViewState,
    });

    wrappedWin.createReader(cloneIntoConfig(config, win));
    await this.waitForInternalReader();
    this.ready = true;
  }

  /** Wait for the <browser> to finish loading reader.html. */
  private waitForBrowserLoad(browser: any): Promise<void> {
    return new Promise((resolve) => {
      if (browser.contentDocument?.readyState === "complete") {
        resolve();
        return;
      }
      const listener = () => {
        browser.removeEventListener("load", listener, true);
        resolve();
      };
      browser.addEventListener("load", listener, true);
    });
  }

  /**
   * Poll up to 10s for the content-side _reader to appear. createReader() sets
   * _reader quickly once it resolves; the short 15ms poll interval keeps latency
   * low (the old 50ms interval added up to 50ms of dead time per reader).
   *
   * Throws on timeout (instead of returning silently): attach() must fail so
   * openSplitView reports an error rather than faking success with a dead pane.
   */
  private async waitForInternalReader(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (this.getInternalReader()) return;
      await (Zotero as any).Promise.delay(15);
    }
    throw new Error(getString("splitview-error-reader-timeout"));
  }

  /**
   * Poll up to timeoutMs for the pdf.js scroll container to be reachable
   * (internal _reader → _primaryView → _iframe → #viewerContainer). The chain
   * appears some time AFTER _reader itself — pdf.js progressive setup — and
   * until it exists getScrollFraction() returns null and the sync engine
   * silently no-ops. openSplitView awaits this so its returned promise (the
   * de-facto "ready" signal for callers and tests) only resolves once
   * page-sync can actually work.
   */
  async waitForScrollContainer(timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getScrollContainer()) return true;
      await (Zotero as any).Promise.delay(50);
    }
    return this.getScrollContainer() != null;
  }

  /** The content-side reader instance living inside reader.html's own window. */
  private getInternalReader(): any {
    if (!this.browser?.contentWindow) return null;
    const win: any = this.browser.contentWindow;
    const wrappedWin = win.wrappedJSObject || win;
    return wrappedWin._reader || null;
  }

  /** The outer Zotero.Reader wrapper registered in Zotero.Reader._readers. */
  private getOuterReader(): any {
    const readers = (Zotero.Reader as any)._readers || [];
    return readers.find((r: any) => r._iframe === this.browser) || null;
  }

  /**
   * The scroll DOM element the sync engine listens on. Reaches four levels deep:
   * browser → reader.html → internal iframe → pdf.js's #viewerContainer.
   */
  /**
   * Resolve the pdf.js content-realm window and its `#viewerContainer`.
   *
   * Both the scroll container and the scroll listener need the same pair, and
   * both must reach them in the CONTENT realm. On current Gecko (verified on
   * Zotero 10.0.3) the element is reachable through the Xray-wrapped
   * `contentWindow`, while the `wrappedJSObject` sibling returns null for
   * `getElementById` — the reverse of what the older Gecko path assumed.
   * Preferring one unconditionally therefore loses the scroll container (and
   * with it every scroll fraction and the injected listener) on those builds,
   * so try both and keep whichever actually yields the element.
   *
   * Returns null when the reader isn't far enough along yet — pdf.js builds
   * this chain some time after `_reader` itself appears, so callers that poll
   * (waitForScrollContainer) treat null as "not ready yet", not as "no scroll".
   */
  private getContentViewer(): { win: any; el: any } | null {
    const internalReader = this.getInternalReader();
    const primaryView = internalReader?._primaryView;
    const iframe = primaryView?._iframe;
    const iframeWin: any = iframe?.contentWindow;
    if (!iframeWin) return null;
    const candidates: any[] = [iframeWin.wrappedJSObject, iframeWin].filter(
      Boolean,
    );
    for (const candidate of candidates) {
      try {
        const doc = candidate?.document;
        const el =
          (doc?.getElementById?.("viewerContainer") as any) ??
          doc?.scrollingElement ??
          doc?.documentElement ??
          null;
        if (el) return { win: candidate, el };
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  getScrollContainer(): any {
    return this.getContentViewer()?.el ?? null;
  }

  getPosition(): {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
  } | null {
    const el = this.getScrollContainer();
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      clientWidth: el.clientWidth,
    };
  }

  /**
   * Read this pane's scroll position as a 0-1 fraction of its scrollable range.
   * Returns null if the container isn't reachable or has no scroll range.
   */
  getScrollFraction(): number | null {
    const el = this.getScrollContainer();
    if (!el) return null;
    const max = el.scrollHeight - el.clientHeight;
    if (!isFinite(max) || max <= 0) return null;
    return el.scrollTop / max;
  }

  /**
   * Set this pane's scroll position as a fraction of its scrollable range.
   *
   * This is the apply side of fraction-based scroll mirroring (getScrollFraction
   * / setScrollFraction). Unlike applyPreciseState — which goes through pdf.js's
   * _setState → scrollPageIntoView and (a) runs a smooth-scroll ANIMATION that
   * adds perceptible lag, and (b) mis-blends a real-time page number with a
   * debounced top offset into an impossible state — setting scrollTop directly
   * is instantaneous and crosses pages automatically. We clamp to [0,1] and
   * read live bounds at apply time so it stays correct after resizer drags.
   *
   * Returns false if the scroll container isn't reachable (caller ignores).
   */
  setScrollFraction(fraction: number): boolean {
    const el = this.getScrollContainer();
    if (!el) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (!isFinite(max) || max <= 0) return false;
    const target = Math.max(0, Math.min(1, fraction)) * max;
    try {
      el.scrollTop = target;
      return true;
    } catch (e) {
      safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
      return false;
    }
  }

  /**
   * Horizontal counterpart of getScrollFraction: scrollLeft as a 0-1 fraction
   * of the horizontal range. Null when the page fits (no h-scrollbar) — the
   * sync engine then skips h-mirroring instead of forcing scrollLeft to 0.
   */
  getHScrollFraction(): number | null {
    const el = this.getScrollContainer();
    if (!el) return null;
    const max = el.scrollWidth - el.clientWidth;
    if (!isFinite(max) || max <= 0) return null;
    return el.scrollLeft / max;
  }

  /** Horizontal counterpart of setScrollFraction (writes scrollLeft directly). */
  setHScrollFraction(fraction: number): boolean {
    const el = this.getScrollContainer();
    if (!el) return false;
    const max = el.scrollWidth - el.clientWidth;
    if (!isFinite(max) || max <= 0) return false;
    const target = Math.max(0, Math.min(1, fraction)) * max;
    try {
      el.scrollLeft = target;
      return true;
    } catch (e) {
      safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
      return false;
    }
  }

  /**
   * Inject a scroll listener into the pdf.js content realm (#viewerContainer).
   *
   * WHY INJECTION: a scroll listener added from chrome (this code) on a
   * content-realm element does NOT fire — cross-realm event propagation is
   * unreliable in Gecko (this is the failure the old code hit). So we attach
   * the listener on the CONTENT side and bridge back to chrome:
   *   - Cu.exportFunction(onScroll, contentWin) returns a function the content
   *     realm can call that invokes our chrome onScroll;
   *   - we register it with the content element's addEventListener (reached
   *     through the unwrapped content window, so the listener lives in the
   *     content realm where scroll events actually fire).
   *
   * Returns a cleanup fn that removes the listener, or null if the container
   * wasn't reachable / exportFunction unavailable (caller falls back to polling).
   */
  installScrollTrigger(onScroll: () => void): (() => void) | null {
    try {
      const view = this.getContentViewer();
      if (!view) return null;

      const Cu = (Components as any).utils;
      if (!Cu || typeof Cu.exportFunction !== "function") return null;

      const cb = Cu.exportFunction(onScroll, view.win);
      view.el.addEventListener("scroll", cb, { passive: true });

      return () => {
        try {
          view.el.removeEventListener("scroll", cb);
        } catch (e) {
          safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
          /* best-effort */
        }
        try {
          Cu.revoke?.(cb);
        } catch (e) {
          safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
          /* best-effort */
        }
      };
    } catch (e: any) {
      Zotero.debug?.(
        "[Z-Transplit splitView] installScrollTrigger failed: " +
          (toErrorMessage(e)),
      );
      return null;
    }
  }

  /**
   * Current zoom scale as a resolved number (pdf.js keeps currentScale numeric
   * even when currentScaleValue is "auto"/"page-fit"). Null when pdf.js isn't
   * reachable — callers treat that as "no zoom information", not 1.
   */
  getScale(): number | null {
    const pdfViewer = this.getPdfViewer();
    const s = pdfViewer?.currentScale;
    return typeof s === "number" && isFinite(s) && s > 0 ? s : null;
  }

  /**
   * Apply a numeric zoom scale. Setting currentScale (rather than calling the
   * reader's zoomIn/zoomOut) lands on the exact mirrored value in one step;
   * pdf.js clamps to its min/max and re-anchors around the current view.
   */
  setScale(scale: number): boolean {
    const pdfViewer = this.getPdfViewer();
    if (!pdfViewer || !isFinite(scale) || scale <= 0) return false;
    try {
      pdfViewer.currentScale = scale;
      return true;
    } catch (e) {
      safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
      return false;
    }
  }

  /**
   * Raw zoom value: numeric string ("1.5") or named mode ("auto"/"page-actual"/
   * "page-fit"/"page-width"). The sync layer mirrors NAMED modes as-is so each
   * pane resolves them against its own width (a width-derived number inherited
   * from the other pane is wrong whenever the split isn't 50/50).
   */
  getScaleValue(): string | null {
    const v = this.getPdfViewer()?.currentScaleValue;
    return v == null ? null : String(v);
  }

  /** Apply a raw zoom value; pdf.js handles named modes natively. */
  setScaleValue(value: string): boolean {
    const pdfViewer = this.getPdfViewer();
    if (!pdfViewer) return false;
    try {
      pdfViewer.currentScaleValue = value;
      return true;
    } catch (e) {
      safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
      return false;
    }
  }

  zoomIn(): void {
    this.getInternalReader()?.zoomIn?.();
  }
  zoomOut(): void {
    this.getInternalReader()?.zoomOut?.();
  }
  zoomReset(): void {
    this.getInternalReader()?.zoomReset?.();
  }

  /**
   * Read precise view state (pageIndex, scale, top, left) from pdf.js.
   *
   * Page number comes from `pdfViewer.currentPageNumber` (synchronous — updates
   * the instant the visible page changes, including mid-scroll across a page
   * boundary). We deliberately do NOT use `_location.pageNumber`: pdf.js only
   * refreshes `_location` after scroll DEBOUNCES (scroll stops), so reading it
   * during a scroll burst returns the STALE previous page — which is exactly why
   * cross-page sync failed (the change wasn't detected until scrolling halted).
   *
   * `top`/`left` (within-page pixel offset) still come from `_location` when
   * available — that's the only source for the offset, and it updates often
   * enough for smooth within-page sync.
   */
  getPreciseState(): {
    pageIndex: number;
    scale: number;
    top: number;
    left: number;
  } | null {
    const pdfViewer = this.getPdfViewer();
    if (!pdfViewer) return null;
    const location = pdfViewer._location;
    return {
      // currentPageNumber: real-time (1-indexed). Fall back to _location only
      // if it's somehow absent on this reader build.
      pageIndex: (pdfViewer.currentPageNumber || location?.pageNumber || 1) - 1,
      scale: location?.scale ?? pdfViewer.currentScaleValue ?? 1,
      top: location?.top ?? 0,
      left: location?.left ?? 0,
    };
  }

  /**
   * Apply precise view state to this pane (jump to page + offset).
   * Uses _setState which internally calls pdfViewer.scrollPageIntoView.
   *
   * NOTE: pdf.js _setState expects `pageNumber` (1-indexed), while our internal
   * state uses `pageIndex` (0-indexed). We add 1 before passing it in.
   *
   * Scroll sync no longer uses this method — it mirrors scrollTop by fraction
   * (getScrollFraction/setScrollFraction), which is instant and crosses pages
   * without _setState's smooth-scroll animation or page/offset blending bugs.
   * Kept for potential zoom/state restore use.
   */
  async applyPreciseState(state: {
    pageIndex: number;
    scale: number;
    top: number;
    left: number;
  }): Promise<void> {
    const internalReader = this.getInternalReader();
    const primaryView = internalReader?._primaryView;
    if (!primaryView?._setState) return;
    // Clamp pageIndex to valid range and convert to 1-indexed pageNumber
    const pdfViewer = this.getPdfViewer();
    const maxPage = pdfViewer?.pagesCount ?? 999;
    const clamped = {
      pageNumber: Math.max(1, Math.min(maxPage, state.pageIndex + 1)),
      scale: state.scale,
      top: state.top,
      left: state.left,
    };
    // cloneInto: _setState runs in content realm, needs a content-realm object
    const win: any = this.browser?.contentWindow;
    if (!win) return;
    const Cu = (Components as any).utils;
    const cloned = Cu.cloneInto
      ? Cu.cloneInto(clamped, win, { wrapReflectors: true })
      : clamped;
    try {
      await primaryView._setState(cloned);
    } catch (e: any) {
      Zotero.debug?.(
        "[Z-Transplit splitView] applyPreciseState _setState failed: " +
          (toErrorMessage(e)),
      );
    }
  }

  /** Get the pdf.js PDFViewer instance from the reader's iframe. */
  private getPdfViewer(): any {
    const internalReader = this.getInternalReader();
    const primaryView = internalReader?._primaryView;
    const iframe = primaryView?._iframe;
    const iframeWin: any = iframe?.contentWindow;
    if (!iframeWin) return null;
    const wrappedWin = iframeWin.wrappedJSObject || iframeWin;
    return wrappedWin?.PDFViewerApplication?.pdfViewer || null;
  }

  /**
   * Tear down: uninit the internal reader, remove it from Zotero.Reader._readers,
   * and blank the browser to release the content process.
   */
  destroy(): void {
    try {
      const internal = this.getInternalReader();
      internal?.uninit?.();
      const outer = this.getOuterReader();
      if (outer) {
        const readers = (Zotero.Reader as any)._readers;
        const idx = readers?.indexOf(outer);
        if (idx !== undefined && idx >= 0) readers.splice(idx, 1);
      }
    } catch (e) {
      safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
      /* best-effort */
    }
    if (this.browser) {
      try {
        this.browser.setAttribute("src", "about:blank");
      } catch (e) {
        safeDebug("[Z-Transplit] readerPaneAdapter: " + e);
        /* best-effort */
      }
    }
    this.ready = false;
  }
}
