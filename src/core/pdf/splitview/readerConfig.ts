/**
 * splitview/readerConfig — Construct the config object passed to reader.html's
 * internal `createReader()` global, plus the Fluent localization it requires.
 *
 * The reader.html page exposes a `createReader(config)` global (NOT a Zotero
 * xpcom API); we reach it via the browser's contentWindow.wrappedJSObject and
 * pass a cloneInto'd config so the content realm can read it without Xray
 * wrappers.
 *
 * Host-coupled by nature (Zotero.API / Zotero.File / Components.utils) — not
 * unit-testable in Node.
 *
 * Ported from leadero's src/core/pdf/splitview/readerConfig.ts (verbatim;
 * log prefixes renamed, zotero-split-viewer lineage note kept as history).
 *
 * @module core/pdf/splitview/readerConfig
 */

/**
 * Build the Fluent (.ftl) file *contents* array the Zotero 8/9 reader iterates
 * in `options.ftl`. Locales are reversed so the primary locale overrides its
 * fallbacks. Missing files are skipped; on any failure we return [] (still
 * iterable, so createReader won't crash with "options.ftl is undefined").
 */
import { safeDebug } from "../../../utils/logger";

export function buildReaderFtl(): string[] {
  try {
    // 只探测 Zotero 实际生效的 UI 语言 + en-US 兜底，而非完整的 Gecko 协商
    // 链（appLocalesAsBCP47 可能含 en-NZ/en-CA/en-AU 这类区域变体；Zotero
    // 并不为每个语言发布 branding 包，逐个硬探测会持续刷 "Missing resource
    // in locale …: branding/brand.ftl" 告警）。
    const locales = ["en-US", String((Zotero as any).locale || "")].filter(
      (l, i, arr) => l && arr.indexOf(l) === i,
    );
    const ftlURLs: string[] = [];
    for (const locale of locales) {
      ftlURLs.push(
        `resource://app/localization/${locale}/branding/brand.ftl`,
        `resource://app/localization/${locale}/zotero.ftl`,
        `resource://app/localization/${locale}/reader.ftl`,
      );
    }
    const ftl: string[] = [];
    for (const url of ftlURLs) {
      try {
        ftl.push((Zotero as any).File.getContentsFromURL(url));
      } catch (e) {
        safeDebug("[Z-Transplit] readerConfig: " + e);
        /* locale file missing — skip */
      }
    }
    return ftl;
  } catch (e) {
    safeDebug("[Z-Transplit] readerConfig: " + e);
    return [];
  }
}

export interface ReaderConfigOptions {
  /** Saved view state to restore (page/scale/scroll), or undefined. */
  initialState?: any;
  onOpenContextMenu?: (params: { x: number; y: number }) => void;
  /** Called when reader's view state changes (scroll/page change). */
  onChangeViewState?: (state: any) => void;
}

/**
 * Build the config object for createReader(). The attachment is loaded via the
 * `zotero://attachment/` protocol — reader.html's pdf.js resolves it back to
 * Zotero for the file stream (no explicit getFilePathAsync needed).
 *
 * `readOnly: true` + empty annotations → a clean view, no annotation editing.
 * This suits the translated-PDF pane; the source pane could later allow edits.
 */
export function buildReaderConfig(item: any, opts: ReaderConfigOptions = {}): Record<string, any> {
  return {
    type: "pdf",
    data: {
      url: `zotero://attachment/${(Zotero as any).API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`,
    },
    annotations: [],
    readOnly: true,
    // Zotero 8/9 reader iterates options.ftl to localize UI; missing → blank pane.
    ftl: buildReaderFtl(),
    primaryViewState: opts.initialState || undefined,
    onOpenContextMenu: (params: { x: number; y: number }) => {
      opts.onOpenContextMenu?.(params);
    },
    // view-state callback: reader calls this on page change (debounced). It fires
    // from inside the content realm, so it crosses realms safely (no cross-realm
    // scroll-event issues). NOTE: it fires on page-flip but NOT reliably on
    // within-page scrollbar drag — so split-view sync is driven by a polling
    // loop (installSync in splitViewFactory), and this callback just nudges
    // that loop to run an immediate check on a page change.
    onChangeViewState: (state: any) => {
      opts.onChangeViewState?.(state);
    },
    onOpenLink: (url: string) => (Zotero as any).launchURL(url),
  };
}

/**
 * Clone a config object from the privileged realm into the reader content realm
 * so createReader() can iterate/call it. wrapReflectors lets returned DOM
 * reflectors come back; cloneFunctions makes the callbacks callable from content.
 */
export function cloneIntoConfig(config: Record<string, any>, contentWin: any): any {
  const Cu = (Components as any).utils;
  // Cu.cloneInto exists in Gecko; if absent (very old), fall back to the raw
  // object — createReader may still work for plain data, though callbacks won't.
  if (Cu && typeof Cu.cloneInto === "function") {
    return Cu.cloneInto(config, contentWin, {
      wrapReflectors: true,
      cloneFunctions: true,
    });
  }
  return config;
}
