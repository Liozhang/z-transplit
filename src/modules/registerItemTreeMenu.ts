/**
 * registerItemTreeMenu — library item context-menu entries for the PDF
 * translation flows.
 *
 * Two entry points:
 *   - 「翻译全文（生成译文附件）」— runs the pipeline with outcome "attachment"
 *     (auto-opens the result);
 *   - 「翻译并分屏对照」— the existing split-view flow from the library.
 *
 * Host API reality (verified against Zotero 7.0.15 and 10.x source):
 *   - Zotero 10 has Zotero.MenuManager.registerMenu but NOT
 *     ItemTreeManager.registerMenuItem;
 *   - Zotero 7.0.15 has NEITHER — plugins inject into the `zotero-itemmenu`
 *     popup directly (zotero-pdf2zh's approach).
 * So this module uses ONE code path — DOM injection into `zotero-itemmenu`
 * with a popupshowing visibility gate — which works identically on both. When
 * MenuManager becomes detectable we could migrate, but the injected path is
 * not version-fragile: the popup id exists in both 7 and 10.
 *
 * Loaded dynamically by src/hooks.ts (onMainWindowLoad / onStartup), tracked
 * and revoked by onShutdown.
 *
 * @module modules/registerItemTreeMenu
 */

import { getString } from "../utils/locale";
import { safeDebug } from "../utils/logger";
import { toErrorMessage } from "../utils/error";
import { alertDialog } from "../utils/dialog";
import {
  translateAndSplitWithOpenDataLoader,
} from "../core/pdf/translation/opendataloaderSplitAdapter";
import {
  friendlyOdlError,
  isJavaMissingError,
  handleMissingJava,
} from "../core/pdf/splitview/splitViewFactory";
import {
  findExistingTranslation,
  findTranslationByRelation,
} from "../core/pdf/splitview/splitViewCleanup";

const MENU_ID = "ztransplit-itemmenu";
const SEP_ID = "ztransplit-itemmenu-sep";

interface TrackedWindow {
  win: any;
  popup: any;
  menu: any;
  separator: any;
  onShowing: EventListener;
}

const tracked: TrackedWindow[] = [];
let registered = false;

/**
 * All PDF attachments in the selection, in selection order: the item itself
 * when it is a PDF, otherwise every PDF among its child attachments.
 */
function resolveAllSourcePdfAttachments(items: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<number>();
  for (const item of items || []) {
    if (!item) continue;
    try {
      if (item.isAttachment?.() && item.attachmentContentType === "application/pdf") {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
        continue;
      }
      const attIDs: number[] = item.getAttachments?.() || [];
      for (const id of attIDs) {
        if (seen.has(id)) continue;
        const att = (globalThis as any).Zotero?.Items?.get?.(id);
        if (att?.attachmentContentType === "application/pdf") {
          seen.add(id);
          out.push(att);
        }
      }
    } catch {
      /* not an item we understand — keep scanning */
    }
  }
  return out;
}

/** Pick the first PDF attachment from the current selection. */
function resolveSourcePdfAttachment(items: any[]): any | null {
  return resolveAllSourcePdfAttachments(items)[0] || null;
}

function selectionHasPdf(items: any[]): boolean {
  return resolveSourcePdfAttachment(items) != null;
}

/**
 * True when a translation attachment already sits under the source's parent
 * (title convention: the adapter produces `Translated (lang)`; legacy
 * `译文 (…)` still counts), or when the source carries a dc:relation link to
 * one (the only path for top-level sources). Used to skip duplicate
 * translations.
 */
function hasExistingTranslation(sourceItem: any): boolean {
  try {
    const parentID = sourceItem?.parentItemID;
    if (parentID != null) {
      const parent = (globalThis as any).Zotero?.Items?.get?.(parentID);
      const attIDs: number[] = parent?.getAttachments?.() || [];
      const re = /^(译文|Translated)\s*\(/i;
      if (attIDs.some((id) => re.test(
        (globalThis as any).Zotero?.Items?.get?.(id)?.getField?.("title") || "",
      ))) {
        return true;
      }
    }
    return findTranslationByRelation(sourceItem) != null;
  } catch {
    return false;
  }
}

/**
 * Open an attachment in the host window; on failure (missing ZoteroPane API or
 * viewAttachment throwing) tell the user instead of failing silently.
 * Returns true when the attachment was opened.
 */
function openAttachmentOrAlert(win: any, attachmentId: number): boolean {
  try {
    const pane = win?.ZoteroPane;
    if (typeof pane?.viewAttachment === "function") {
      pane.viewAttachment(attachmentId);
      return true;
    }
  } catch (e) {
    safeDebug("[Z-Transplit] itemTreeMenu viewAttachment: " + e);
  }
  alertDialog(getString("app-title"), getString("itemtree-open-failed"), win);
  return false;
}

/**
 * Run the pipeline for every selected PDF, serially. Single selection keeps
 * the exact previous behavior; multi selection labels each progress window
 * with its ordinal and keeps going when one item fails.
 */
async function runPipelines(
  win: any,
  sources: any[],
  outcome: "attachment" | "split",
): Promise<void> {
  if (sources.length === 0) return;
  if (sources.length === 1) {
    await runPipeline(win, sources[0], outcome);
    return;
  }
  for (let i = 0; i < sources.length; i++) {
    try {
      await runPipeline(win, sources[i], outcome, `${i + 1}/${sources.length}`);
    } catch (e) {
      // runPipeline handles its own errors; this guard just guarantees one
      // failure can't stop the remaining items.
      safeDebug(`[Z-Transplit] itemTreeMenu batch item failed: ${e}`);
    }
  }
}

/**
 * Run the pipeline for one source PDF. Shared by both menu items — they differ
 * only in outcome ("attachment" vs "split") and dedup behavior.
 */
async function runPipeline(
  win: any,
  sourceItem: any,
  outcome: "attachment" | "split",
  label?: string,
): Promise<void> {
  const Zotero = (globalThis as any).Zotero;
  const progress = new Zotero.ProgressWindow({ window: win });
  progress.changeHeadline(
    (label ? `${label} ` : "") +
      getString(
        outcome === "attachment"
          ? "itemtree-progress-attachment"
          : "odl-progress-translating",
      ),
  );
  progress.addDescription(sourceItem.getField?.("title") || "");
  progress.show();

  try {
    // Split flow: reuse an existing translation exactly like the reader
    // context-menu entry does, instead of re-translating the document.
    if (outcome === "split") {
      const existing = findExistingTranslation(sourceItem);
      if (existing) {
        progress.addDescription(getString("itemtree-split-reuse"));
        const { openSplitView } = await import("../core/pdf/splitview/splitViewFactory");
        await openSplitView(win, sourceItem, existing);
        progress.startCloseTimer?.(8000);
        return;
      }
    }
    // Attachment flow: open the existing translation instead of re-running;
    // when it can't be resolved (e.g. the dedup hit was a non-PDF) fall
    // through to a fresh translation rather than returning silently.
    if (outcome === "attachment" && hasExistingTranslation(sourceItem)) {
      const existing = findExistingTranslation(sourceItem);
      if (existing && openAttachmentOrAlert(win, existing.id)) {
        progress.addDescription(getString("itemtree-dedup-open"));
        progress.startCloseTimer?.(4000);
        return;
      }
    }

    await translateAndSplitWithOpenDataLoader({
      sourceItem,
      // The split outcome opens the side-by-side reader through the same
      // factory the pre-existing ODL menu uses; without it the pipeline
      // aborts with "分屏打开器不可用" (found in the README-shot round —
      // the menu item produced an attachment-like flow and no split view).
      openSplitView: (async (win2: any, item: any, att: any) => {
        const { openSplitView } = await import("../core/pdf/splitview/splitViewFactory");
        return openSplitView(win2, item, att);
      }) as any,
      onProgress: (msg: string) => {
        try {
          progress.addDescription(msg);
          progress.show();
        } catch {
          /* progress window closed */
        }
      },
      outcome,
      openAttachment: (attachmentId: number) => {
        openAttachmentOrAlert(win, attachmentId);
      },
    });
    progress.startCloseTimer?.(8000);
  } catch (e: any) {
    // 10 s, matching the reader entry point — 2 s was too short to read the
    // "✗" line (the modal dialog below is the real carrier, this is backup).
    progress.startCloseTimer?.(10000);
    const raw = toErrorMessage(e);
    if (isJavaMissingError(raw)) {
      await handleMissingJava();
      return;
    }
    const friendly = friendlyOdlError(raw);
    safeDebug(`[Z-Transplit] itemTreeMenu pipeline failed: ${raw}`);
    try {
      progress.addDescription("✗ " + friendly);
    } catch {
      /* progress window already closed */
    }
    alertDialog(getString("app-title"), friendly, win);
  }
}

function injectIntoWindow(win: any): boolean {
  try {
    const doc = win.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup || doc.getElementById(MENU_ID)) return false;

    const menu = doc.createXULElement("menu");
    menu.id = MENU_ID;
    // Label via getString (our Localization instance) — deliberately NOT
    // data-l10n-id: the menu is JS-injected, and a DOM overlay id that the
    // checker cannot statically resolve is worse than a static label set at
    // creation time (initLocale has already run by then).
    menu.setAttribute("label", getString("itemtree-menu"));

    const menupopup = doc.createXULElement("menupopup");
    menu.appendChild(menupopup);

    const mkItem = (id: string, l10nKey: string, handler: () => void): any => {
      const mi = doc.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", getString(l10nKey));
      mi.addEventListener("command", handler);
      return mi;
    };

    // Visibility gate: only show the submenu when the selection contains a PDF.
    const onShowing = ((event: Event) => {
      try {
        if (event.target !== popup) return; // nested popups also fire here
        const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
        const items: any[] = zp?.itemsView?.getSelectedItems?.() || [];
        const show = selectionHasPdf(items);
        menu.setAttribute("hidden", show ? "false" : "true");
        // The leading separator must follow the menu — otherwise an orphan
        // divider stays visible whenever the submenu hides.
        separator.setAttribute("hidden", show ? "false" : "true");
        // Re-assert the label on EVERY showing: on Zotero 10 the item menu's
        // labels are (re)written around popupshowing, and our injected menu
        // was observed displaying a native label ("在文献库中显示", found in
        // the live-install test on a real library) — re-set wins the race.
        menu.setAttribute("label", getString("itemtree-menu"));
      } catch (e) {
        safeDebug("[Z-Transplit] itemTreeMenu onShowing: " + e);
      }
    }) as EventListener;

    const translateAttachment = mkItem(
      "ztransplit-itemmenu-attachment",
      "itemtree-translate-attachment",
      () => {
        const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
        const items: any[] = zp?.itemsView?.getSelectedItems?.() || [];
        void runPipelines(win, resolveAllSourcePdfAttachments(items), "attachment");
      },
    );
    const translateSplit = mkItem(
      "ztransplit-itemmenu-split",
      "itemtree-translate-split",
      () => {
        const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
        const items: any[] = zp?.itemsView?.getSelectedItems?.() || [];
        void runPipelines(win, resolveAllSourcePdfAttachments(items), "split");
      },
    );

    menupopup.appendChild(translateAttachment);
    menupopup.appendChild(translateSplit);

    const separator = doc.createXULElement("menuseparator");
    separator.id = SEP_ID;

    const firstChild = popup.firstElementChild;
    popup.insertBefore(separator, firstChild);
    popup.insertBefore(menu, separator);

    popup.addEventListener("popupshowing", onShowing);

    tracked.push({ win, popup, menu, separator, onShowing });
    return true;
  } catch (e) {
    safeDebug("[Z-Transplit] registerItemTreeMenu inject failed: " + e);
    return false;
  }
}

/**
 * Register the library item context-menu entries for every open main window.
 * Idempotent per window; called from hooks.onStartup and onMainWindowLoad.
 */
export function registerItemTreeMenu(): void {
  if (registered) return;
  try {
    const Zotero = (globalThis as any).Zotero;
    const wins: any[] = Zotero?.getMainWindows?.() || [];
    let any = false;
    for (const win of wins) any = injectIntoWindow(win) || any;
    if (any) registered = true;
    safeDebug(`[Z-Transplit] itemTreeMenu registered (windows: ${wins.length})`);
  } catch (e) {
    safeDebug("[Z-Transplit] registerItemTreeMenu failed: " + e);
  }
}

/** Register for one newly opened main window (hooks.onMainWindowLoad). */
export function registerItemTreeMenuForWindow(win: any): void {
  if (!win || tracked.some((t) => t.win === win)) return;
  injectIntoWindow(win);
}

/**
 * Revoke one window's injected menu (main-window unload). Removes the tracked
 * entry and its injected nodes/listener; no-op when the window isn't tracked.
 */
export function unregisterItemTreeMenuForWindow(win: any): void {
  const idx = tracked.findIndex((t) => t.win === win);
  if (idx === -1) return;
  const t = tracked[idx];
  tracked.splice(idx, 1);
  try {
    t.popup.removeEventListener("popupshowing", t.onShowing);
    t.menu.remove();
    t.separator.remove();
  } catch (e) {
    safeDebug("[Z-Transplit] unregisterItemTreeMenuForWindow: " + e);
  }
}

/** Revoke all injected menus (plugin shutdown). */
export function unregisterItemTreeMenu(): void {
  while (tracked.length > 0) {
    unregisterItemTreeMenuForWindow(tracked[0].win);
  }
  registered = false;
}
