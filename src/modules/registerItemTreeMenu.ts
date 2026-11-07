/**
 * registerItemTreeMenu — library item context-menu entries for the PDF
 * translation flows.
 *
 * Four entries (all checkbox-typed: a checkmark marks the live state — an
 * active bilingual session or an open split tab on the selected PDF):
 *   - 「翻译全文（生成译文附件）」— runs the pipeline with outcome "attachment"
 *     (auto-opens the result);
 *   - 「翻译并分屏对照」— the existing split-view flow from the library;
 *   - 「上下对照双语阅读」/「仅译文双语阅读」— the shared bilingual launcher
 *     (same lifecycle as the reader context menu and the sidebar).
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
 * Load-bearing constraint: the injected menu and separator must be APPENDED
 * to the popup, never inserted before its existing children. The host builds
 * that menu with positional childNodes indexes (labels, oncommand, hidden),
 * so any top-insertion corrupts every native entry's text and visibility —
 * see injectIntoWindow.
 *
 * Icons (added 2026-11): each entry carries a functional 16px stroke icon
 * (addon/content/icons/menu-*.svg, currentColor) applied exactly the way
 * Zotero's MenuManager does it — `menuitem-iconic` + `zotero-custom-menu-item`
 * classes and the `--custom-menu-icon-light/dark` CSS custom properties,
 * consumed by Zotero's built-in stylesheet. Gecko renders the checkbox
 * checkmark in the SAME icon slot, so the three stateful entries swap to
 * menu-check.svg while active and back to their functional icon while idle
 * (see onShowing) — the checkbox `checked` attribute stays untouched as the
 * no-CSS fallback path.
 *
 * Loaded dynamically by src/hooks.ts (onMainWindowLoad / onStartup), tracked
 * and revoked by onShutdown.
 *
 * @module modules/registerItemTreeMenu
 */

import { getString } from "../utils/locale";
import { safeDebug } from "../utils/logger";
import { toErrorMessage } from "../utils/error";
import { alertDialog, promptDialog } from "../utils/dialog";
import {
  ProgressReporter,
  type ProgressFraction,
} from "../utils/progressWindow";
import { parsePageRangeSpec } from "../core/pdf/translation/pageRange";
import {
  translateAndSplitWithOpenDataLoader,
} from "../core/pdf/translation/opendataloaderSplitAdapter";
import {
  friendlyOdlError,
  isJavaMissingCause,
  handleMissingJava,
} from "../core/pdf/splitview/splitViewFactory";
import {
  findExistingTranslation,
  findTranslationByRelation,
  findSplitTabForItem,
} from "../core/pdf/splitview/splitViewCleanup";
import {
  isPdfAttachment,
  translationTitleMatcher,
} from "../core/pdf/translation/translatedAttachment";
import {
  getActiveBilingualModeForItem,
  startBilingualSessionByItemID,
} from "../core/pdf/sdt/bilingualLauncher";

const MENU_ID = "ztransplit-itemmenu";
const SEP_ID = "ztransplit-itemmenu-sep";

// 16px stroke icons, one per entry; menu-check.svg replaces a stateful
// entry's functional icon while it is active (icon slot == checkmark slot).
const ICON_BASE = "chrome://ztransplit/content/icons/";
const ICON_TRANSLATE_DOC = ICON_BASE + "menu-translate-doc.svg";
const ICON_TRANSLATE_PAGES = ICON_BASE + "menu-translate-pages.svg";
const ICON_SPLIT_COLUMNS = ICON_BASE + "menu-split-columns.svg";
const ICON_SPLIT_ROWS = ICON_BASE + "menu-split-rows.svg";
const ICON_TRANS_ONLY = ICON_BASE + "menu-trans-only.svg";
const ICON_CHECK = ICON_BASE + "menu-check.svg";

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
      if (item.isAttachment?.() && isPdfAttachment(item)) {
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
        if (att && isPdfAttachment(att)) {
          seen.add(id);
          out.push(att);
        }
      }
    } catch (e) {
      safeDebug(
        `[Z-Transplit] resolveAllSourcePdfAttachments scan error: ${e}`,
      );
      /* not an item we understand — keep scanning */
    }
  }
  return out;
}

/**
 * One source PDF per selected item, in selection order.
 *
 * The split entry used to feed resolveAllSourcePdfAttachments() into the
 * per-source loop, so an item holding BOTH an original and its translation
 * resolved two sources and opened TWO split views stacked on top of each
 * other — the exact repro in issue #4 ("open an item containing two PDF
 * attachments, launch split-screen comparison"). Only the topmost one
 * answered the mouse, which read as "the divider jumps and behaves
 * erratically".
 *
 * So the split path resolves at most one source per item: the item itself
 * when it is a PDF (the user picked a file), otherwise the single best child
 * attachment — a non-translated PDF preferred, newest first — so the original
 * becomes the left pane and the latest translation the right one. Which
 * translation that is stays runPipeline's job (findExistingTranslation).
 */
export function resolveSplitSources(items: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<number>();
  const isTranslation = translationTitleMatcher();
  for (const item of items || []) {
    if (!item) continue;
    try {
      if (item.isAttachment?.() && isPdfAttachment(item)) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
        continue;
      }
      const candidates: any[] = (item.getAttachments?.() || [])
        .map((id: number) => (globalThis as any).Zotero?.Items?.get?.(id))
        .filter(
          (att: any) => att && isPdfAttachment(att) && !seen.has(att.id),
        );
      if (!candidates.length) continue;
      // Prefer the original: a translation is the right pane's job, not the
      // left one. Fall back to every candidate when the item holds nothing
      // but translations.
      const originals = candidates.filter(
        (c) => !isTranslation(c.getField?.("title") || ""),
      );
      const pool = originals.length ? originals : candidates;
      pool.sort((a, b) => {
        const da = a?.dateAdded || "";
        const db = b?.dateAdded || "";
        return db < da ? -1 : db > da ? 1 : 0;
      });
      seen.add(pool[0].id);
      out.push(pool[0]);
    } catch (e) {
      safeDebug(`[Z-Transplit] resolveSplitSources scan error: ${e}`);
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
      const matchesTranslation = translationTitleMatcher();
      if (attIDs.some((id) => matchesTranslation(
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
  pages?: number[],
): Promise<void> {
  const progress = new ProgressReporter({
    window: win,
    headline:
      (label ? `${label} ` : "") +
      getString(
        outcome === "attachment"
          ? "itemtree-progress-attachment"
          : "odl-progress-translating",
      ),
  });
  progress.note(sourceItem.getField?.("title") || "");

  try {
    // Split flow: reuse an existing translation exactly like the reader
    // context-menu entry does, instead of re-translating the document.
    if (outcome === "split") {
      const existing = findExistingTranslation(sourceItem);
      if (existing) {
        progress.note(getString("itemtree-split-reuse"));
        const { openSplitView } = await import("../core/pdf/splitview/splitViewFactory");
        await openSplitView(win, sourceItem, existing);
        progress.settle(null, 8000);
        return;
      }
    }
    // Attachment flow: open the existing translation instead of re-running;
    // when it can't be resolved (e.g. the dedup hit was a non-PDF) fall
    // through to a fresh translation rather than returning silently.
    // 页码范围是明确的重新翻译意图，不做查重——用户就是要补译若干页。
    if (outcome === "attachment" && !pages && hasExistingTranslation(sourceItem)) {
      const existing = findExistingTranslation(sourceItem);
      if (existing && openAttachmentOrAlert(win, existing.id)) {
        progress.note(getString("itemtree-dedup-open"));
        progress.settle(null, 4000);
        return;
      }
    }

    await translateAndSplitWithOpenDataLoader({
      sourceItem,
      ...(pages ? { pages } : {}),
      // The split outcome opens the side-by-side reader through the same
      // factory the pre-existing ODL menu uses; without it the pipeline
      // aborts with "分屏打开器不可用" (found in the README-shot round —
      // the menu item produced an attachment-like flow and no split view).
      openSplitView: (async (win2: any, item: any, att: any) => {
        const { openSplitView } = await import("../core/pdf/splitview/splitViewFactory");
        return openSplitView(win2, item, att);
      }) as any,
      onProgress: (msg: string, fraction?: ProgressFraction) => {
        // 批量翻译阶段带分数：走单一进度行；其余阶段是文字行。
        if (fraction) {
          progress.fraction(fraction.done, fraction.total, msg);
        } else {
          progress.note(msg);
        }
      },
      outcome,
      openAttachment: (attachmentId: number) => {
        openAttachmentOrAlert(win, attachmentId);
      },
    });
    progress.settle(null, 8000);
  } catch (e: any) {
    // 10 s, matching the reader entry point — 2 s was too short to read the
    // "✗" line (the modal dialog below is the real carrier, this is backup).
    progress.dismiss(10000);
    const raw = toErrorMessage(e);
    // Structured reason first (isJavaMissingCause) — the preflight error's
    // message is a pinned English hint with the localized detail dropped, and
    // shell-wrapped/JVM-crash texts defeat signature matching.
    if (isJavaMissingCause(e)) {
      await handleMissingJava();
      return;
    }
    const friendly = friendlyOdlError(raw);
    safeDebug(`[Z-Transplit] itemTreeMenu pipeline failed: ${raw}`);
    progress.fail("✗ " + friendly, 10000);
    alertDialog(getString("app-title"), friendly, win);
  }
}

/**
 * Apply a menu icon exactly the way Zotero's MenuManager does
 * (menuManager.js `_initMenu`): the classes feed Zotero's built-in stylesheet
 * and the custom properties carry the image URL. Both properties get the same
 * URL — our icons use currentColor, so one asset serves light and dark mode
 * (MenuManager's own darkIcon fallback). Idempotent and cheap: onShowing
 * re-asserts icons on every popupshowing, so any host-side class/property
 * rewrite self-heals.
 */
function setMenuIcon(mi: any, url: string): void {
  try {
    mi.classList.add("zotero-custom-menu-item", "menuitem-iconic");
    mi.style.setProperty("--custom-menu-icon-light", `url(${url})`);
    mi.style.setProperty("--custom-menu-icon-dark", `url(${url})`);
  } catch (e) {
    safeDebug("[Z-Transplit] setMenuIcon: " + e);
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

    const mkItem = (
      id: string,
      l10nKey: string,
      handler: () => void,
      icon?: string,
    ): any => {
      const mi = doc.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", getString(l10nKey));
      // Checkbox type + per-showing `checked` writes (see onShowing) give the
      // entries Zotero's native checkmark while their state is live. XUL
      // auto-toggles the visual state on click, but the menu closes on click
      // and the next popupshowing re-asserts the truth, so it self-corrects.
      // With an icon applied the checkmark is hidden (same slot) — the
      // checked attribute remains as the no-CSS fallback and for a11y state.
      mi.setAttribute("type", "checkbox");
      mi.setAttribute("checked", "false");
      if (icon) setMenuIcon(mi, icon);
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
        // The divider's visibility must track the submenu's — otherwise an
        // orphan divider stays visible whenever the submenu hides.
        separator.setAttribute("hidden", show ? "false" : "true");
        // Re-assert the label on EVERY showing. The native-label corruption
        // this guards against ("在文献库中显示" observed on this menu in the
        // live-install test) came from top-insertion shifting the host's
        // positional childNodes writes onto us — fixed by appending — but the
        // re-set is free insurance against future host-side rewrites.
        menu.setAttribute("label", getString("itemtree-menu"));

        // Checkmark state, recomputed on every showing so it can never go
        // stale: the bilingual entries checkmark only while the single live
        // session runs on the selected PDF, the split entry while any split
        // tab shows it. 「翻译全文」 produces an attachment, not a live state —
        // never checkmarked. resolveSourcePdfAttachment already returns the
        // FIRST attachment — do not index it again.
        const source = resolveSourcePdfAttachment(items);
        const liveMode = getActiveBilingualModeForItem(source?.id);
        const splitOpen = source
          ? findSplitTabForItem(source.id) != null
          : false;
        translateAttachment.setAttribute("checked", "false");
        translateSplit.setAttribute("checked", splitOpen ? "true" : "false");
        interleaveItem.setAttribute(
          "checked",
          liveMode === "interleave" ? "true" : "false",
        );
        transOnlyItem.setAttribute(
          "checked",
          liveMode === "transOnly" ? "true" : "false",
        );

        // Icon slot = checkmark slot in Gecko, so active stateful entries
        // carry ICON_CHECK instead of their functional icon; idle ones
        // re-assert the functional icon. Fixed-icon entries re-assert too —
        // idempotent writes that self-heal any host-side rewrite.
        setMenuIcon(translateAttachment, ICON_TRANSLATE_DOC);
        setMenuIcon(translatePages, ICON_TRANSLATE_PAGES);
        setMenuIcon(
          translateSplit,
          splitOpen ? ICON_CHECK : ICON_SPLIT_COLUMNS,
        );
        setMenuIcon(
          interleaveItem,
          liveMode === "interleave" ? ICON_CHECK : ICON_SPLIT_ROWS,
        );
        setMenuIcon(
          transOnlyItem,
          liveMode === "transOnly" ? ICON_CHECK : ICON_TRANS_ONLY,
        );
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
      ICON_TRANSLATE_DOC,
    );
    // 翻译指定页：只取第一个选中的 PDF（多选时各文档页数不同，同一份
    // 范围含义不明）。取消对话框或范围不合法都不启动管线。
    const translatePages = mkItem(
      "ztransplit-itemmenu-pages",
      "itemtree-translate-pages",
      () => {
        const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
        const items: any[] = zp?.itemsView?.getSelectedItems?.() || [];
        const source = resolveSourcePdfAttachment(items);
        if (!source) return;
        const raw = promptDialog(
          getString("itemtree-pages-prompt-title"),
          getString("itemtree-pages-prompt-text"),
          "",
          win,
        );
        if (raw == null) return; // 用户取消
        const pages = parsePageRangeSpec(raw);
        if (!pages || pages.length === 0) {
          alertDialog(
            getString("app-title"),
            getString("itemtree-pages-invalid"),
            win,
          );
          return;
        }
        void runPipeline(win, source, "attachment", undefined, pages);
      },
      ICON_TRANSLATE_PAGES,
    );
    const translateSplit = mkItem(
      "ztransplit-itemmenu-split",
      "itemtree-translate-split",
      () => {
        const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
        const items: any[] = zp?.itemsView?.getSelectedItems?.() || [];
        void runPipelines(win, resolveSplitSources(items), "split");
      },
      ICON_SPLIT_COLUMNS,
    );
    // Bilingual launch with visible feedback: the reader-menu path shows a
    // progress window, and this path used to run SILENTLY — a reader that
    // wasn't ready, an SDT view that failed to build or an engine error all
    // left nothing but the freshly opened plain reader (the user-facing
    // symptom of issue "双语菜单只是打开了阅读器"). Mirror the reader path:
    // progress while preparing, done/failed lines, and a disclosure message
    // when the document-structure session can't be established at all.
    const runBilingual = async (mode: "interleave" | "transOnly"): Promise<void> => {
      const zp = win.ZoteroPane || win.wrappedJSObject?.ZoteroPane;
      const progress = new ProgressReporter({
        window: win,
        headline: getString("app-title"),
      });
      progress.note(getString("itemtree-launch-progress"));
      try {
        const source = resolveSourcePdfAttachment(
          zp?.itemsView?.getSelectedItems?.() || [],
        );
        if (!source) {
          progress.settle(null, 2000);
          return;
        }
        const handle = await startBilingualSessionByItemID({
          win,
          itemID: source.id,
          mode,
          onProgress: (stats) => {
            // 与阅读器入口同一套路：单一进度行就地改写，终态后不再回弹。
            progress.fraction(
              stats.done,
              stats.total,
              getString("bilingual-progress", {
                done: stats.done,
                total: stats.total,
              }),
            );
          },
        });
        if (!handle) {
          progress.settle(getString("bilingual-sdt-missing"), 8000);
          return;
        }
        progress.settle(getString("itemtree-launch-done"), 3000);
      } catch (e) {
        safeDebug(`[Z-Transplit] itemTreeMenu bilingual (${mode}) failed: ${e}`);
        progress.fail("✗ " + toErrorMessage(e), 8000);
      }
    };
    const interleaveItem = mkItem(
      "ztransplit-itemmenu-interleave",
      "itemtree-interleave",
      async () => {
        const source = resolveSourcePdfAttachment(
          (win.ZoteroPane || win.wrappedJSObject?.ZoteroPane)?.itemsView
            ?.getSelectedItems?.() || [],
        );
        if (!source) return;
        openAttachmentOrAlert(win, source.id);
        await runBilingual("interleave");
      },
      ICON_SPLIT_ROWS,
    );
    const transOnlyItem = mkItem(
      "ztransplit-itemmenu-trans-only",
      "itemtree-trans-only",
      async () => {
        const source = resolveSourcePdfAttachment(
          (win.ZoteroPane || win.wrappedJSObject?.ZoteroPane)?.itemsView
            ?.getSelectedItems?.() || [],
        );
        if (!source) return;
        openAttachmentOrAlert(win, source.id);
        await runBilingual("transOnly");
      },
      ICON_TRANS_ONLY,
    );

    menupopup.appendChild(translateAttachment);
    menupopup.appendChild(translatePages);
    menupopup.appendChild(translateSplit);
    menupopup.appendChild(interleaveItem);
    menupopup.appendChild(transOnlyItem);

    const separator = doc.createXULElement("menuseparator");
    separator.id = SEP_ID;

    // Append at the END of the popup, separator first. The host's
    // buildItemContextMenu addresses its native entries POSITIONALLY —
    // menu.childNodes[i] for i in 0..28, verified identical on Zotero
    // 7.0.15 and 10 master — to write labels, rewrite oncommand, toggle
    // data-l10n-id, and run its hide/show loop. A node inserted before
    // them shifts every index by one: native entries swap or lose labels
    // and vanish from the menu, and childNodes[0] — this menu — gets
    // 「在文献库中显示」 written onto it (observed live before the fix).
    // Appended nodes sit past the last positional index and are never
    // touched by the host.
    popup.appendChild(separator);
    popup.appendChild(menu);

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
