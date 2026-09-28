/**
 * splitview/splitViewFactory — Orchestrates the tab-internal split-view reader.
 *
 * Injects an hbox with two <browser> elements (each loading reader.html) into a
 * reader tab, so two PDFs display side by side. Core mechanism:
 *   1. Zotero_Tabs.add({type:"reader"}) → creates an empty tab container
 *      <elem id=tabID> that we re-purpose.
 *   2. cloneNode(false) the container to strip prior reader listeners, re-attach
 *      the shim methods Zotero's contextPane expects, restyle as a flex row.
 *   3. Two createReaderBrowser() + a 5px resizer <box> into an <hbox>.
 *   4. Each browser loads reader.html; we call its createReader() global with a
 *      cloneInto'd config to start a reader instance per pane.
 *   5. Menu registration: 「翻译并分屏」(OpenDataLoader pipeline, with
 *      re-entrancy guard + cancel item) and 「对比分屏」(manual split), plus the
 *      full translate → import → open flow.
 *
 * Ported from leadero's src/core/pdf/splitview/splitViewFactory.ts. Changes:
 *   - the addonID comes from this repo's package.json config (with a runtime
 *     fallback to `addon.data.config.addonID`);
 *   - the resizer class is `ztransplit-split-resizer`. leadero styled it with a
 *     standalone stylesheet (addon/content/css/leadero-splitview.css), which is
 *     not ported; the rules are injected as a <style> element instead — same
 *     pattern as the reader translate pane (see ensureSplitResizerStyle).
 *   - log/debug prefixes and every "Leadero" user-visible string renamed.
 *   - the re-export block at the bottom keeps the对外 contract used by
 *     tests/node/split-sync.spec.ts (it imports viewStateToInternal /
 *     statesDiffer / doSyncCheck from this module) and by addon.ts.
 *
 * @module core/pdf/splitview/splitViewFactory
 */

import type { SplitTabState, ReaderPaneAdapter, SplitSide } from "./types";
import { getString } from "../../../utils/locale";
import { createReaderBrowser, ReaderPane } from "./readerPaneAdapter";
import { safeDebug } from "../../../utils/logger";
import { toErrorMessage } from "../../../utils/error";
import { createAbortController } from "../../../utils/abort";
import { config } from "../../../../package.json";
import {
  addTrackedListener,
  installSync,
  makeSyncTrigger,
  primeSyncBaselines,
  stateMap,
  trackTimeout,
} from "./splitViewSync";
import { cleanupTabResources, findExistingTranslation, findLatestTranslation } from "./splitViewCleanup";
// 对外契约不变（消费者：addon.ts 的 typeof import / tests/node/split-sync.spec.ts）
export {
  viewStateToInternal,
  statesDiffer,
  doSyncCheck,
} from "./splitViewSync";
// 对外契约不变（消费者：addon.ts 的 typeof import / tests/node/split-sync.spec.ts）
export {
  cleanupTabResources,
  getSplitTabState,
  isSplitViewTab,
} from "./splitViewCleanup";

/** This addon's ID (package.json config), with a runtime fallback. */
function addonID(): string {
  try {
    const fromData = (globalThis as any).addon?.data?.config?.addonID;
    if (fromData) return fromData;
  } catch {
    /* no addon global (node) — fall through to the config import */
  }
  return config.addonID;
}

/** Zotero.debug 受调试输出开关控制；无 Zotero 上下文（node 测试）时静默丢弃。
 *  常规失败（JRE 安装失败等）不该占 console.error 恒刷错误通道。 */
function zoteroDebug(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(msg);
  } catch (e) {
    safeDebug("[Z-Transplit] splitViewFactory: " + e);
    /* best-effort */
  }
}

/**
 * Open a split view showing leftItem and rightItem side by side in a new tab.
 *
 * Caller passes two already-existing Zotero Items (typically PDF attachments).
 * Returns the new tabID, or null if the container couldn't be built.
 */
export async function openSplitView(
  win: any,
  leftItem: any,
  rightItem: any,
): Promise<string | null> {
  const Zotero_Tabs = win.Zotero_Tabs || (Zotero as any).Tabs;
  const title = `${leftItem.getField?.("title") || "left"} | ${rightItem.getField?.("title") || "right"}`;
  const { id: tabID } = Zotero_Tabs.add({
    type: "reader",
    title,
    data: { itemID: leftItem.id, isSplitView: true },
    select: true,
  });
  await buildSplitPanes(tabID, win, leftItem, rightItem);
  return tabID;
}

/**
 * Build the split-view DOM inside the tab container and start both readers.
 * Returns true on success (container found + both panes attached).
 * Throws when the container never appears (Zotero tab creation lag).
 */
async function buildSplitPanes(
  tabID: string,
  win: any,
  leftItem: any,
  rightItem: any,
): Promise<boolean> {
  const doc = win.document;
  // Poll up to 2s for Zotero to create the tab container DOM node. A fixed
  // short delay (previously 50ms) fails on slower machines / large libraries,
  // silently returning false and leaving the user with no split view and no
  // error feedback.
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const container = doc.getElementById(tabID);
    if (container) {
      await populateSplitPanes(container, win, leftItem, rightItem, tabID);
      return true;
    }
    await (Zotero as any).Promise.delay(50);
  }
  throw new Error(getString("splitview-error-container-timeout", { tabID }));
}

/**
 * Populate an already-present tab container with the split-view DOM (two
 * reader browsers + resizer) and start both reader instances. Extracted from
 * buildSplitPanes so the poll loop can call it once the container appears.
 */
async function populateSplitPanes(
  container: any,
  win: any,
  leftItem: any,
  rightItem: any,
  tabID: string,
): Promise<void> {
  // Clone to strip prior reader listeners, then re-attach shims Zotero's
  // contextPane machinery expects (cloneNode(false) drops custom methods).
  const newContainer = container.cloneNode(false);
  container.parentNode?.replaceChild(newContainer, container);
  (newContainer as any).setContextPaneOpen = function (open: boolean) {
    this.dispatchEvent(
      new win.CustomEvent("tab-context-pane-toggle", { detail: { open } }),
    );
  };
  (newContainer as any).setBottomPlaceholderHeight = function (height: number) {
    this.dispatchEvent(
      new win.CustomEvent("tab-bottom-placeholder-resize", {
        detail: { height },
      }),
    );
  };
  (newContainer as any).onTabSelectionChanged = function (selected: boolean) {
    this.dispatchEvent(
      new win.CustomEvent("tab-selection-change", { detail: { selected } }),
    );
  };
  newContainer.style.display = "flex";
  newContainer.style.flexDirection = "row";
  newContainer.style.height = "100%";
  newContainer.style.overflow = "hidden";

  const mainHbox = win.document.createXULElement("hbox");
  mainHbox.style.cssText =
    "display:flex;flex-direction:row;flex:1 1 100%;width:100%;height:100%;overflow:hidden;";

  const leftBrowser = createReaderBrowser(win);
  const rightBrowser = createReaderBrowser(win);

  // Resizer: 5px fixed flex item between the browsers. Visual styling (width,
  // cursor, hover/drag feedback) comes from the injected document rules in
  // ensureSplitResizerStyle; the element only carries the class hooks.
  ensureSplitResizerStyle(win.document);
  const resizer = win.document.createXULElement("box");
  resizer.className = "ztransplit-split-resizer";

  // Initial 50/50 split. flexGrow = ratio*1000, flexBasis = 0.
  const initialRatio = 0.5;
  leftBrowser.style.flexGrow = String(initialRatio * 1000);
  rightBrowser.style.flexGrow = String((1 - initialRatio) * 1000);
  leftBrowser.style.flexBasis = "0";
  rightBrowser.style.flexBasis = "0";

  mainHbox.appendChild(leftBrowser);
  mainHbox.appendChild(resizer);
  mainHbox.appendChild(rightBrowser);
  newContainer.appendChild(mainHbox);

  const state: SplitTabState = {
    tabID,
    win,
    container: newContainer,
    mainHbox,
    leftBrowser,
    rightBrowser,
    resizer,
    leftAdapter: new ReaderPane(leftItem),
    rightAdapter: new ReaderPane(rightItem),
    splitRatio: initialRatio,
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
  };
  stateMap.set(tabID, state);

  // Auto-cleanup when the user closes the tab (X button / Ctrl+W).
  // Zotero doesn't expose a tab-close event, so we observe the DOM: when the
  // tab container is removed from its parent, call cleanupTabResources.
  const tabObserver = new (win as any).MutationObserver((mutations: any[]) => {
    for (const m of mutations) {
      for (const removed of m.removedNodes || []) {
        if (removed === newContainer || removed.contains?.(newContainer)) {
          tabObserver.disconnect();
          cleanupTabResources(tabID);
          return;
        }
      }
    }
  });
  tabObserver.observe(newContainer.parentNode, { childList: true });
  // Stash on the state so cleanupTabResources can disconnect (avoids
  // double-fire when cleanup is called explicitly, e.g., from tests).
  (state as any)._tabObserver = tabObserver;

  // onChangeViewState is shared by both panes — it nudges requestSync so a
  // page-flip syncs immediately (the injected scroll listener covers within-
  // page scroll; onChangeViewState covers page-flips that may not fire 'scroll').
  const syncTrigger = makeSyncTrigger(state);

  // Start both readers IN PARALLEL. Each <browser> already began loading
  // reader.html (its src was set at creation); attach() waits for that load +
  // createReader + internal _reader to appear. Awaiting them serially wastes an
  // entire reader-init's worth of time, since the two are independent — each
  // createReader runs in its own <browser> JS compartment and doesn't touch
  // Zotero's tab bookkeeping (that was finalized back in openSplitView).
  await Promise.all([
    state.leftAdapter!.attach(leftBrowser, {
      tabID,
      side: "left",
      onChangeViewState: syncTrigger,
    }),
    state.rightAdapter!.attach(rightBrowser, {
      tabID,
      side: "right",
      onChangeViewState: syncTrigger,
    }),
  ]);

  // Install two-tier sync now that both readers are ready: inject content-realm
  // scroll listeners (fast path) + start the backstop poll, and prime baselines
  // so the first check doesn't yank a pane to the other's page.
  installSync(state);

  // Ready gate: the sync engine no-ops while either #viewerContainer is
  // unreachable (getScrollFraction → null → doSyncCheck early-returns). Wait
  // for BOTH containers so openSplitView's promise only resolves once
  // page-sync is actually live — callers (and the integration tests) can
  // rely on it instead of sleeping an arbitrary interval. (Optional method:
  // mock panes in unit tests are container-ready and omit it.) A false
  // return (timeout) must throw — otherwise a dead pane would be reported
  // as a successful split.
  const [leftReady, rightReady] = await Promise.all([
    state.leftAdapter!.waitForScrollContainer?.() ?? Promise.resolve(true),
    state.rightAdapter!.waitForScrollContainer?.() ?? Promise.resolve(true),
  ]);
  if (!leftReady || !rightReady) {
    throw new Error(getString("splitview-error-scroll-timeout"));
  }

  // Wire resizer (sets syncPaused while dragging).
  installResizer(state);
}

/**
 * Register the split-view resizer rules once per document. Injected as a
 * <style> element (same pattern as the reader translate pane) instead of a
 * stylesheet under addon/content — one rule set does not justify the extra
 * chrome registration. The element deliberately stays for the document's
 * lifetime: open split tabs keep working across plugin disable/reload (see
 * stopAllSyncPollers), and removing the rules would strip their resizer.
 */
const SPLIT_RESIZER_STYLE_ID = "ztransplit-splitview-style";

function ensureSplitResizerStyle(doc: any): void {
  try {
    if (doc.getElementById(SPLIT_RESIZER_STYLE_ID)) return;
    const style = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "style",
    ) as any;
    style.id = SPLIT_RESIZER_STYLE_ID;
    style.textContent = `
.ztransplit-split-resizer {
  width: 5px;
  min-width: 5px;
  max-width: 5px;
  cursor: col-resize;
  background: var(--fill-quinary, rgba(127, 127, 127, 0.12));
  transition: background-color 150ms ease;
}
.ztransplit-split-resizer:hover {
  background: var(--fill-quarternary, rgba(127, 127, 127, 0.28));
}
.ztransplit-split-resizer.dragging {
  background: var(--accent-blue, #4072e5);
}
`;
    doc.documentElement.appendChild(style);
  } catch (e) {
    // A missing style must not keep the split view from opening — the resizer
    // still works as a plain flex item, just without the visual affordances.
    safeDebug("[Z-Transplit] splitViewFactory: inject resizer style: " + e);
  }
}

/** Wire the 5px resizer box to drag-adjust the split ratio. */
function installResizer(state: SplitTabState): void {
  let dragging = false;

  const onMouseDown = (e: any) => {
    dragging = true;
    state.resizer.classList.add("dragging");
    e.preventDefault();
  };
  const onMouseMove = (e: any) => {
    if (!dragging) return;
    const rect = state.mainHbox.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.min(0.9, Math.max(0.1, ratio)); // clamp [0.1, 0.9]
    state.splitRatio = ratio;
    state.leftBrowser.style.flexGrow = String(ratio * 1000);
    state.rightBrowser.style.flexGrow = String((1 - ratio) * 1000);
    state.syncPaused = true; // pause sync while dragging
  };
  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    state.resizer.classList.remove("dragging");
    // Resume sync after a short delay, re-priming the scroll baselines so the
    // pause-time delta (and any pdf.js reflow from the width change) doesn't
    // surge through and yank a pane.
    trackTimeout(
      state,
      () => {
        state.syncPaused = false;
        primeSyncBaselines(state);
      },
      200,
    );
  };

  addTrackedListener(state, state.resizer, "mousedown", onMouseDown);
  // move/up on the window so dragging beyond the resizer still tracks.
  addTrackedListener(state, state.win, "mousemove", onMouseMove);
  addTrackedListener(state, state.win, "mouseup", onMouseUp);
}

/**
 * Register a "对比分屏" (Split View) item in the reader's blank-area context
 * menu.
 *
 * On click: takes the current reader's PDF as the LEFT pane, then looks for
 * another PDF attachment under the same parent item to use as the RIGHT pane
 * (prefers previous translations, then newest by dateAdded). If none found,
 * falls back to the same PDF on both sides.
 *
 * Must be called once per plugin lifecycle (registerEventListener is global).
 */
/**
 * Handler kept at module scope so unregisterSplitViewMenu() can revoke it by
 * reference via Reader.unregisterEventListener.
 */
let _splitViewMenuHandler: ((event: any) => void) | null = null;

export function registerSplitViewMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.registerEventListener !== "function") return;
  const pluginID = addonID();

  try {
    _splitViewMenuHandler = (event: any) => {
      const { reader, append } = event;
      if (!append) return;

      append({
        label: getString("splitview-menu-compare"),
        // 禁止加 icon/slider：Zotero 10 的 createReader 包装器对非 internal 菜单
        // 硬校验（命中即抛 "Icons and sliders are unsupported in native context
        // menus"），会让整个 view 右键菜单不渲染。宿主弹层也只消费
        // label/disabled/checked/onCommand，icon 本来就被忽略。
        onCommand: async () => {
          try {
            const currentItemID = getCurrentReaderItemID(reader);
            if (!currentItemID) {
              throw new Error("reader has no itemID");
            }
            await handleSplitFromReader({ itemID: currentItemID });
          } catch (e) {
            safeDebug("[Z-Transplit splitView] open failed: " + e);
            try {
              Components.classes["@mozilla.org/prompt-service;1"]
                .getService(Components.interfaces.nsIPromptService)
                .alert(null, "Split View", getString("splitview-error-open", { detail: String(e) }));
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* best-effort */
            }
          }
        },
      });
    };
    Reader.registerEventListener(
      "createViewContextMenu",
      _splitViewMenuHandler,
      pluginID,
    );
  } catch (e) {
    safeDebug("[Z-Transplit splitView] menu registration error: " + e);
  }
}

/**
 * Resolve the current reader's attachment + a sibling PDF attachment, then
 * openSplitView. LEFT = current reader's PDF; RIGHT = another PDF under the
 * same parent item (prefers previous translations, then newest by dateAdded).
 * Falls back to the same PDF on both sides when no sibling exists.
 */
async function handleSplitFromReader(opts: { itemID: number }): Promise<void> {
  const leftItemID: number = opts.itemID;
  if (!leftItemID) throw new Error("reader has no itemID");
  const leftItem = (Zotero as any).Items.get(leftItemID);
  if (!leftItem) throw new Error("left attachment not found");

  const parentItemID = leftItem.parentItemID;
  let rightItem: any = null;
  if (parentItemID) {
    rightItem = findLatestTranslation(parentItemID, leftItemID);
  }
  if (!rightItem) {
    rightItem = leftItem;
  }

  const win = (Zotero as any).getMainWindow();
  const tabID = await openSplitView(win, leftItem, rightItem);
  if (!tabID) {
    throw new Error(getString("splitview-error-tab-create"));
  }
}

/**
 * Resolve the current reader's attachment itemID from the main window.
 *
 * Uses the codebase-standard pattern:
 *   `Reader.getByTabID(Zotero_Tabs.selectedID).itemID`
 *
 * Falls back to the captured reader object only when the window API is
 * genuinely unavailable (e.g. the call is made before Zotero_Tabs is exposed
 * to the chrome realm). The stale-reader symptom (context-menu handler
 * captures a reader whose `.itemID` is undefined) is fixed by reading the
 * *current* tab's reader instance rather than the possibly-stale closure
 * reference.
 */
function getCurrentReaderItemID(reader: any): number | undefined {
  try {
    const win = (Zotero as any).getMainWindow();
    const Zotero_Tabs = win.Zotero_Tabs || (Zotero as any).Tabs;
    const tabID = Zotero_Tabs?.selectedID;
    if (tabID) {
      const currentReader = (Zotero as any).Reader?.getByTabID?.(tabID);
      if (currentReader?.itemID) return currentReader.itemID;
    }
  } catch (e) {
    safeDebug("[Z-Transplit splitView] getCurrentReaderItemID failed: " + e);
  }
  // Last resort: the reader object passed by the context-menu handler may
  // still carry the right itemID in cases where the window API is
  // unavailable (e.g. certain overlay / dialog contexts).
  // Log when this fires so we can detect silent fallback to a stale reader.
  if (!reader?.itemID) {
    safeDebug(
      "[Z-Transplit splitView] getCurrentReaderItemID: window API path failed, fallback reader.itemID is also undefined",
    );
  } else {
    safeDebug(
      "[Z-Transplit splitView] getCurrentReaderItemID: window API path failed, falling back to reader.itemID = " +
        reader.itemID,
    );
  }
  return reader?.itemID;
}

/** Revoke the split-view reader context-menu listener (plugin shutdown / disable). Best-effort. */
export function unregisterSplitViewMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.unregisterEventListener !== "function") return;
  if (_splitViewMenuHandler) {
    try {
      Reader.unregisterEventListener(
        "createViewContextMenu",
        _splitViewMenuHandler,
      );
    } catch (e) {
      safeDebug("[Z-Transplit splitView] menu unregister error: " + e);
    }
    _splitViewMenuHandler = null;
  }
}

/**
 * Convert raw OpenDataLoader translation error messages to user-friendly Chinese.
 */
export function friendlyOdlError(msg: string): string {
  const m = msg.toLowerCase();
  if (
    m.includes("java") ||
    m.includes("jvm") ||
    m.includes("需要安装 java") ||
    m.includes("需要安裝 java")
  )
    return getString("odl-error-java-missing");
  if (m.includes("jar") || m.includes("opendataloader-pdf-cli"))
    return getString("odl-error-jar-missing");
  // XPCOM nsIFile / nsIError file-path failures — replace the raw
  // `Component returned failure code: 0x... [nsIFile.initWithPath]` string
  // that otherwise leaks through to the user.
  if (/nsifile\.|ns_error_file/i.test(msg)) {
    return getString("odl-error-file-path");
  }
  if (
    m.includes("网络") ||
    m.includes("網路") ||
    m.includes("network") ||
    m.includes("timeout") ||
    m.includes("连接") ||
    m.includes("連線")
  )
    return getString("odl-error-network", { detail: msg.slice(0, 100) });
  // Match the localized engine-guard text too: the engine emits FTL strings,
  // so matching only the older Chinese wording would miss on en/zh-TW.
  if (
    m.includes("翻译未配置") ||
    m.includes("翻譯未設定") ||
    m.includes("未配置") ||
    m.includes("not configured") ||
    m.includes("no ai provider")
  )
    return getString("odl-error-not-configured");
  if (m.includes("解析未返回") || m.includes("未提取到任何文本"))
    return getString("odl-error-parse-empty", { detail: msg });
  if (msg.length > 200) return msg.slice(0, 200) + "…";
  return msg;
}

/**
 * Whether an error message indicates a missing/failed Java runtime (vs other
 * ODL failures like missing jar, network, or unconfigured translation engine).
 */
export function isJavaMissingError(msg: string): boolean {
  const m = (msg || "").toLowerCase();
  return (
    m.includes("java") ||
    m.includes("jvm") ||
    m.includes("需要安装 java") ||
    m.includes("java runtime not found")
  );
}

/**
 * Guide the user through downloading a bundled JRE when Java is missing.
 *
 * Flow: confirm dialog (下载安装 / 手动打开下载页 / 取消) → if download chosen,
 * run JavaRuntimeManager.downloadJRE with a ProgressWindow showing download +
 * extract progress → on success tell the user to retry the menu item. Returns
 * true if a JRE is now available (so the caller can hint at retry).
 */
export async function handleMissingJava(): Promise<boolean> {
  const Services = (globalThis as any).Services;
  const win = (Zotero as any).getMainWindow();
  // Services.prompt.confirm gives OK/Cancel. We overload: OK = download, and
  // offer the manual download URL in the body for Cancel users.
  const body = getString("java-dialog-body");
  const wantInstall = Services.prompt.confirm(win, getString("java-dialog-title"), body);
  if (!wantInstall) {
    // User chose Cancel — open the manual download page for them.
    try {
      (Zotero as any).launchURL?.("https://adoptium.net");
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
    return false;
  }

  // Download + extract with progress.
  const progress = new (Zotero as any).ProgressWindow();
  progress.changeHeadline(getString("java-progress-install"));
  progress.addDescription(getString("java-progress-download-prepare"));
  progress.show();
  try {
    const { downloadJRE } = await import("../JavaRuntimeManager");
    await downloadJRE(17, (p) => {
      try {
        progress.addDescription(`${p.message || p.phase} (${p.percent}%)`);
      } catch (e) {
        safeDebug("[Z-Transplit] splitViewFactory: " + e);
        /* best-effort */
      }
    });
    progress.addDescription(getString("java-progress-retry"));
    progress.startCloseTimer?.(8000);
    return true;
  } catch (e: any) {
    zoteroDebug("[Z-Transplit odl] JRE install failed: " + e);
    const failMsg = getString("java-install-failed", { detail: toErrorMessage(e) });
    progress.addDescription("✗ " + failMsg);
    progress.startCloseTimer?.(15000);
    try {
      (Zotero as any).launchURL?.("https://adoptium.net");
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
    return false;
  }
}

/**
 * Handler kept at module scope so unregisterOpenDataLoaderMenu() can revoke it
 * by reference via Reader.unregisterEventListener.
 */
let _openDataLoaderMenuHandler: ((event: any) => void) | null = null;

/**
 * Currently active translation AbortController, or null when no translation
 * is in progress. The "取消正在进行的翻译" context-menu item calls .abort()
 * on this for cooperative cancellation. Deliberately stays in THIS module (the
 * host of the read/write) rather than being shared across files.
 */
let activeTranslationController: AbortController | null = null;

/**
 * Register a "翻译并分屏" (Translate & Split) item in the reader's context
 * menu. This is the DEFAULT translation path (no ORT dependency, no Python —
 * only needs Java + a configured translation engine). Registration is
 * unconditional; no preference gate controls visibility.
 */
export function registerOpenDataLoaderMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.registerEventListener !== "function") return;
  const pluginID = addonID();

  try {
    _openDataLoaderMenuHandler = (event: any) => {
      const { reader, append } = event;
      if (!append) return;

      // Conditional cancel item — only shown when a translation is in progress.
      if (activeTranslationController) {
        append({
          label: getString("splitview-menu-cancel"),
          onCommand: () => {
            activeTranslationController?.abort();
          },
        });
      }

      append({
        label: getString("splitview-menu-translate"),
        // 同 registerSplitViewMenu：非 internal 菜单禁用 icon/slider（Zotero 10 硬校验）。
        onCommand: async () => {
          // Defensive guard: if a translation is already in flight, don't start
          // another. The user should see "取消正在进行的翻译" above this item
          // in the context menu, but if this fires anyway the debug log will
          // tell us the menu entry-point assumption is wrong.
          if (activeTranslationController) {
            safeDebug(
              "[Z-Transplit splitView] translation already in progress, ignoring duplicate request",
            );
            return;
          }
          const sourceItemID: number | undefined =
            getCurrentReaderItemID(reader);
          if (!sourceItemID) {
            safeDebug(
              "[Z-Transplit splitView] cannot resolve source itemID from reader",
            );
            return;
          }
          const sourceItem = (Zotero as any).Items.get(sourceItemID);
          if (!sourceItem) return;

          // Reuse an existing translation if one is already reachable from
          // this item — parent siblings, or the dc:relation link written at
          // import (the only path for top-level sources). Avoids redundant
          // re-translation.
          const existing = findExistingTranslation(sourceItem);
          if (existing) {
            const win = (Zotero as any).getMainWindow?.() || null;
            try {
              await openSplitView(win, sourceItem, existing);
            } catch (e) {
              // openSplitView 带超时，复用译文路径同样可能抛错——按本文件惯例
              // debug + nsIPromptService 提示。
              safeDebug(
                "[Z-Transplit splitView] reuse-translation open failed: " + e,
              );
              try {
                Components.classes["@mozilla.org/prompt-service;1"]
                  .getService(Components.interfaces.nsIPromptService)
                  .alert(null, "Split View", getString("splitview-error-open", { detail: String(e) }));
              } catch (e) {
                safeDebug("[Z-Transplit] splitViewFactory: " + e);
                /* best-effort */
              }
              return;
            }
            try {
              const p = new (Zotero as any).ProgressWindow();
              p.changeHeadline("Z-Transplit");
              p.addDescription(
                getString("splitview-progress-reused", { attachmentId: existing.id }),
              );
              p.show();
              p.startCloseTimer?.(3000);
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* best-effort */
            }
            return;
          }

          let progress: any = null;
          try {
            progress = new (Zotero as any).ProgressWindow();
            progress.changeHeadline(getString("odl-progress-translating"));
            progress.addDescription(getString("odl-progress-preparing"));
            progress.show();

            const { translateAndSplitWithOpenDataLoader } =
              await import("../translation/opendataloaderSplitAdapter");
            const controller = createAbortController();
            activeTranslationController = controller;
            const result = await translateAndSplitWithOpenDataLoader({
              sourceItem,
              onProgress: (msg: string) => {
                try {
                  progress.addDescription(msg);
                } catch (e) {
                  safeDebug("[Z-Transplit] splitViewFactory: " + e);
                  /* best-effort */
                }
              },
              openSplitView,
              signal: controller.signal,
            });

            try {
              // Only claim "opened side by side" when a split tab actually
              // came up — splitTabID is null when openSplitView failed after
              // the translation was saved (the adapter then reports that
              // itself in its progress description).
              if (result.splitTabID) {
                progress.addDescription(
                  getString("odl-progress-done-split", {
                    attachmentId: result.translatedAttachmentId,
                  }),
                );
              }
              progress.startCloseTimer?.(4000);
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* ignore */
            }
          } catch (e: any) {
            zoteroDebug("[Z-Transplit odl] failed: " + e);
            // User cancellation — not an error, just stop gracefully. Detected
            // by error NAME: the message is localized, so text equality can't
            // discriminate.
            if (e?.name === "ZTransplitCancelled") {
              try {
                progress?.addDescription(getString("odl-progress-cancelled"));
                progress?.startCloseTimer?.(3000);
              } catch (e) {
                safeDebug("[Z-Transplit] splitViewFactory: " + e);
                /* ignore */
              }
              return;
            }
            const rawMsg = toErrorMessage(e);
            // Close the in-flight translation progress so it doesn't linger
            // behind the install dialog.
            try {
              progress?.startCloseTimer?.(1000);
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* ignore */
            }
            // Special-case missing Java: offer to download a bundled JRE
            // instead of a dead-end blocking alert.
            if (isJavaMissingError(rawMsg)) {
              await handleMissingJava();
              return;
            }
            const friendly = friendlyOdlError(rawMsg);
            try {
              progress?.addDescription("✗ " + friendly);
              progress?.startCloseTimer?.(10000);
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* ignore */
            }
            try {
              Components.classes["@mozilla.org/prompt-service;1"]
                .getService(Components.interfaces.nsIPromptService)
                .alert(null, getString("odl-error-dialog-title"), friendly);
            } catch (e) {
              safeDebug("[Z-Transplit] splitViewFactory: " + e);
              /* progress window already shows the error; this dialog is best-effort */
            }
          } finally {
            activeTranslationController = null;
          }
        },
      });
    };
    Reader.registerEventListener(
      "createViewContextMenu",
      _openDataLoaderMenuHandler,
      pluginID,
    );
  } catch (e) {
    zoteroDebug("[Z-Transplit odl] menu registration error: " + e);
  }
}

/** Revoke the OpenDataLoader reader context-menu listener (plugin shutdown / disable). Best-effort. */
export function unregisterOpenDataLoaderMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.unregisterEventListener !== "function") return;
  if (_openDataLoaderMenuHandler) {
    try {
      Reader.unregisterEventListener(
        "createViewContextMenu",
        _openDataLoaderMenuHandler,
      );
    } catch (e) {
      zoteroDebug("[Z-Transplit odl] menu unregister error: " + e);
    }
    _openDataLoaderMenuHandler = null;
  }
}

/** Re-exported for the factory's callers (sync wiring + pane types). */
export type { ReaderPaneAdapter, SplitSide };
