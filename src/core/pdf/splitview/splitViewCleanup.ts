/**
 * 分屏**标签资源释放与翻译接管查询**。
 *
 * `findLatestTranslation` 回答"这个标签当前的翻译由谁接管"；`cleanupTabResources` /
 * `getSplitTabState` / `isSplitViewTab` 回答"标签关掉时要把什么还回去"。两者同属一个
 * 变更理由：翻译接管者的生命周期必须与标签资源的释放对齐（漏一个就是内存泄漏）。
 *
 * **`activeTranslationController` 没有搬过来**：它是**可变**的模块级状态，簇内只声明不读，
 * 读写全在宿主（splitViewFactory）。可变模块变量一旦跨文件就只能读（ESM 导入绑定只读，
 * 赋值报 TS2632）——那样要么发明一对访问器，要么别搬。这里选择别搬：为一个没有被移入用途的
 * 变量发明访问器是纯负担。
 *
 * 依赖方向：本件 → `splitViewSync`（读 `stateMap`），单向，无环。
 *
 * Ported from leadero's src/core/pdf/splitview/splitViewCleanup.ts (verbatim;
 * log prefixes renamed). `findLatestTranslation`'s title regex must stay in
 * sync with the title the adapter produces (`Translated (${targetLanguage})`,
 * see opendataloaderSplitAdapter); legacy `译文 (…)` titles stay recognized.
 *
 * @module core/pdf/splitview/splitViewCleanup
 */

import type { SplitTabState } from "./types";
import { safeDebug } from "../../../utils/logger";
import { stateMap } from "./splitViewSync";

/** Title convention: the adapter produces `Translated (lang)`; legacy `译文 (…)` still matches. */
const TRANSLATION_TITLE_RE = /^(译文|Translated)\s*\(/i;

/**
 * Find the best right-pane PDF under `parentItemID`, preferring previously
 * translated attachments (titled `Translated (...)`, or legacy `译文 (...)`).
 * Falls back to the newest PDF sibling when no translation exists.
 */
export function findLatestTranslation(
  parentItemID: number,
  excludeItemID: number,
): any {
  const parent = (Zotero as any).Items.get(parentItemID);
  const attachmentIDs = parent?.getAttachments?.() || [];
  const candidates: any[] = [];
  for (const id of attachmentIDs) {
    if (id === excludeItemID) continue;
    const att = (Zotero as any).Items.get(id);
    if (att && att.attachmentContentType === "application/pdf") {
      candidates.push(att);
    }
  }
  const translations = candidates.filter((c) =>
    TRANSLATION_TITLE_RE.test(c?.getField?.("title") || ""),
  );
  const pool = translations.length > 0 ? translations : candidates;
  pool.sort((a, b) => {
    const da = a?.dateAdded || "";
    const db = b?.dateAdded || "";
    return db < da ? -1 : db > da ? 1 : 0;
  });
  return pool[0] || null;
}

/**
 * Follow the source attachment's dc:relation links (written by
 * translatedAttachment on import) and return the newest linked item that is
 * actually a translated PDF. Fallback for TOP-LEVEL source attachments, which
 * have no parent item whose children findLatestTranslation could scan. Old
 * translations created before the link existed are not found (forward fix).
 */
export function findTranslationByRelation(sourceItem: any): any | null {
  try {
    const relations = sourceItem?.getRelations?.() || {};
    const raw = relations["dc:relation"];
    const uris: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    // Zotero.URI URI↔item helpers are not covered by zotero-types — local cast.
    const URI = (globalThis as any).Zotero?.URI;
    const candidates: any[] = [];
    for (const uri of uris) {
      const id = URI?.URItoItemID?.(uri);
      const att = id ? (Zotero as any).Items.get(id) : null;
      if (
        att &&
        att.id !== sourceItem?.id &&
        att.attachmentContentType === "application/pdf" &&
        TRANSLATION_TITLE_RE.test(att?.getField?.("title") || "")
      ) {
        candidates.push(att);
      }
    }
    candidates.sort((a, b) => {
      const da = a?.dateAdded || "";
      const db = b?.dateAdded || "";
      return db < da ? -1 : db > da ? 1 : 0;
    });
    return candidates[0] || null;
  } catch (e) {
    safeDebug("[Z-Transplit] splitViewCleanup: " + e);
    return null;
  }
}

/**
 * Existing-translation lookup for the reuse entries (item tree + reader
 * menu): the parent-sibling scan first, then the dc:relation fallback for
 * top-level sources.
 */
export function findExistingTranslation(sourceItem: any): any | null {
  if (!sourceItem) return null;
  const parentID = sourceItem.parentItemID;
  if (parentID != null) {
    const sibling = findLatestTranslation(parentID, sourceItem.id);
    if (sibling) return sibling;
  }
  return findTranslationByRelation(sourceItem);
}

/**
 * Tear down a split-view tab: stop sync, remove all tracked listeners/timeouts,
 * destroy both reader panes, clear state. Safe to call multiple times.
 */
export function cleanupTabResources(tabID: string): void {
  const state = stateMap.get(tabID);
  if (!state) return;
  // Disconnect the tab-close observer first so it doesn't re-enter after
  // we've started tearing down readers.
  try {
    (state as any)._tabObserver?.disconnect();
  } catch (e) {
    safeDebug("[Z-Transplit] splitViewFactory: " + e);
    /* ignore */
  }
  state.isCleaningUp = true;

  // Stop the sync poller first (also covered by timeoutIds below, but clear it
  // explicitly so a final tick can't fire after we start destroying readers).
  if (state.syncIntervalId != null) {
    try {
      (state.win as any).clearInterval(state.syncIntervalId);
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
  }
  // Cancel any pending rAF-batched sync check (fast path).
  if (state.syncRAFId != null) {
    try {
      const caf = (state.win as any).cancelAnimationFrame;
      if (typeof caf === "function") caf(state.syncRAFId);
      else (state.win as any).clearTimeout(state.syncRAFId);
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
    state.syncRAFId = null;
  }
  // Tear down the injected content-realm scroll listeners (fast path). Must
  // happen before the readers are destroyed (the listener references the
  // content element).
  try {
    state.leftTriggerCleanup?.();
  } catch (e) {
    safeDebug("[Z-Transplit] splitViewFactory: " + e);
    /* best-effort */
  }
  try {
    state.rightTriggerCleanup?.();
  } catch (e) {
    safeDebug("[Z-Transplit] splitViewFactory: " + e);
    /* best-effort */
  }
  state.leftTriggerCleanup = null;
  state.rightTriggerCleanup = null;

  for (const { target, type, listener, options } of state.eventListeners) {
    try {
      target.removeEventListener(type, listener, options);
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
  }
  for (const id of state.timeoutIds) {
    try {
      (state.win as any).clearTimeout(id);
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
  }

  state.leftAdapter?.destroy();
  state.rightAdapter?.destroy();
  stateMap.delete(tabID);
}

/** Get the state for a tab (for testing / sync wiring). */
export function getSplitTabState(tabID: string): SplitTabState | undefined {
  return stateMap.get(tabID);
}

/** True if tabID is an open split view. */
export function isSplitViewTab(tabID: string): boolean {
  return stateMap.has(tabID);
}

/**
 * Stop every sync poller without tearing down the tabs themselves. Plugin
 * shutdown previously had no split-view cleanup — the 400ms sync interval
 * survived disable/reload as long as the user kept the tab open. Deliberately
 * does NOT destroy readers or remove listeners: the tab stays alive, and a
 * later real tab-close still runs cleanupTabResources for the full teardown.
 */
export function stopAllSyncPollers(): void {
  for (const state of stateMap.values()) {
    // Make any in-flight tick a no-op (doSyncCheck early-returns on this).
    state.isCleaningUp = true;
    if (state.syncIntervalId != null) {
      try {
        (state.win as any).clearInterval(state.syncIntervalId);
      } catch (e) {
        safeDebug("[Z-Transplit] splitViewCleanup: " + e);
        /* best-effort */
      }
      state.syncIntervalId = null;
    }
    if (state.syncRAFId != null) {
      try {
        const caf = (state.win as any).cancelAnimationFrame;
        if (typeof caf === "function") caf(state.syncRAFId);
        else (state.win as any).clearTimeout(state.syncRAFId);
      } catch (e) {
        safeDebug("[Z-Transplit] splitViewCleanup: " + e);
        /* best-effort */
      }
      state.syncRAFId = null;
    }
    for (const id of state.timeoutIds) {
      try {
        (state.win as any).clearTimeout(id);
      } catch (e) {
        safeDebug("[Z-Transplit] splitViewCleanup: " + e);
        /* best-effort */
      }
    }
    state.timeoutIds.length = 0;
  }
}
