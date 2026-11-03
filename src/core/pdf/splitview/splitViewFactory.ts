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
 *   5. Menu registration: ONE「Z-Transplit」submenu in the reader context
 *      menu (registerReaderContextMenu) — translate+split via the OpenDataLoader
 *      pipeline (with re-entrancy guard + conditional cancel entry), manual
 *      split, and the two bilingual entries; each entry carries a Zotero
 *      checkbox checkmark while its state is live. Plus the full
 *      translate → import → open flow.
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

import {
  MIN_PANE_WIDTH,
  RESIZER_WIDTH,
  type ReaderPaneAdapter,
  type SplitSide,
  type SplitTabState,
} from "./types";
import { getString } from "../../../utils/locale";
import { getPrefDynamic } from "../../../utils/prefs";
import { createReaderBrowser, ReaderPane } from "./readerPaneAdapter";
import { safeDebug } from "../../../utils/logger";
import { toErrorMessage } from "../../../utils/error";
import { alertDialog } from "../../../utils/dialog";
import { createAbortController } from "../../../utils/abort";
import {
  getActiveBilingualModeForItem,
  startBilingualSession,
  stopBilingualSession,
} from "../sdt/bilingualLauncher";
import {
  engineCacheIdentity,
} from "../../translation/translationEngines";
// 结构化的解析错误分类（reason 字段）——isJavaMissingCause 优先读它，
// 避免对本地化/被重包装过的错误文本做正则猜测。纯 TS 类，无宿主依赖。
import { PdfParseError } from "../PdfParseError";
import { classifyJarError } from "../jarErrorKind";
import { config } from "../../../../package.json";
import {
  addTrackedListener,
  installSync,
  makeSyncTrigger,
  primeSyncBaselines,
  stateMap,
  trackTimeout,
} from "./splitViewSync";
import {
  cleanupTabResources,
  findExistingTranslation,
  findLatestTranslation,
  isSplitViewTab,
} from "./splitViewCleanup";
// 对外契约不变（消费者：addon.ts 的 typeof import / tests/node/split-sync.spec.ts）
export {
  viewStateToInternal,
  statesDiffer,
  doSyncCheck,
} from "./splitViewSync";
// 对外契约不变（消费者：addon.ts 的 typeof import / tests/node/split-sync.spec.ts）
export {
  cleanupTabResources,
  findSplitTabForItem,
  getSplitTabState,
  isSplitViewTab,
} from "./splitViewCleanup";
// 仅供测试：分隔条拖拽的监听装配（消费者：
// tests/unit/core/pdf/splitview/splitResizer.dom.test.ts）。
// resolveLeftWidth 已在声明处直接 export，此处不再重复导出。
export { installResizer };

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
  const title = getString("splitview-tab-title", {
    left: leftItem.getField?.("title") || "",
    right: rightItem.getField?.("title") || "",
  });
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

  // Resizer: a fixed-width flex item between the browsers. Visual styling
  // (width, cursor, hover/drag feedback) comes from the injected document rules
  // in ensureSplitResizerStyle; the element only carries the class hooks.
  ensureSplitResizerStyle(win.document);
  const resizer = win.document.createXULElement("box");
  resizer.className = "ztransplit-split-resizer";

  // Initial 50/50 split. With flexBasis 0 the flexGrow value IS the pane's
  // pixel width (see installResizer), so any pair summing to the same total
  // yields a 50/50 layout — 500/500 is the half of the default 1000 baseline.
  leftBrowser.style.flexGrow = "500";
  rightBrowser.style.flexGrow = "500";
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
  width: ${RESIZER_WIDTH}px;
  min-width: ${RESIZER_WIDTH}px;
  max-width: ${RESIZER_WIDTH}px;
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

/** Delay before scroll mirroring resumes after a divider drag ends. */
const RESIZER_RESUME_MS = 100;

/**
 * Clamp the left pane's pixel width for a divider drag.
 *
 * `startLeftWidth` is the measured left-pane width at mousedown, `deltaX` the
 * pointer's horizontal travel since then, and `total` the width both panes
 * share (the hbox width minus the divider itself). The return value doubles as
 * the left pane's flexGrow: with flexBasis 0 the flexGrow number IS the pane's
 * pixel width, and the two panes' flexGrow values always sum to `total`, so the
 * laid-out width equals the returned number exactly.
 *
 * `total` smaller than two minimum panes (an extremely narrow window) would
 * otherwise put the upper bound below the lower one and invert the clamps,
 * collapsing the left pane to zero — hence the Math.max on the upper bound.
 */
export function resolveLeftWidth(
  startLeftWidth: number,
  deltaX: number,
  total: number,
  minPane: number = MIN_PANE_WIDTH,
): number {
  const upper = Math.max(minPane, total - minPane);
  return Math.min(upper, Math.max(minPane, startLeftWidth + deltaX));
}

/**
 * Wire the divider box so dragging it resizes the two panes.
 *
 * The pointer's horizontal travel is measured from `screenX`, never `clientX`.
 * Once the pointer leaves the divider and moves over a pane, the mouse events
 * that reach this chrome window are retargeted out of the reader's content
 * document, and their `clientX` belongs to THAT document's coordinate space
 * (measured on a real machine: values jumping between 20 and 340 while the
 * pointer actually travelled 640→880 in chrome coordinates, an error of 600+
 * pixels). `screenX` is a screen coordinate and stays exact across the process
 * boundary (measured: 638, 663, 688 … 888, one value per pointer step).
 *
 * Using the travel since mousedown rather than an absolute position also makes
 * the result independent of the window's position, the display scaling, and
 * where inside the divider the pointer happened to grab it.
 */
function installResizer(state: SplitTabState): void {
  let dragging = false;
  let startScreenX = 0;
  let startLeftWidth = 0;

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    state.resizer.classList.remove("dragging");
    // Resume sync shortly after drag end, re-priming baselines so the width-
    // change reflow delta doesn't surge through and yank a pane.
    trackTimeout(
      state,
      () => {
        if (state.isCleaningUp) return;
        state.syncPaused = false;
        primeSyncBaselines(state);
      },
      RESIZER_RESUME_MS,
    );
  };

  const onMouseDown = (e: any) => {
    if (e.button !== 0) return;
    dragging = true;
    startScreenX = e.screenX;
    startLeftWidth = state.leftBrowser.getBoundingClientRect().width;
    state.resizer.classList.add("dragging");
    // Pause sync for the whole drag: a pane resize reflows the viewer and the
    // resulting scroll events must not be mirrored.
    state.syncPaused = true;
  };

  const onMouseMove = (e: any) => {
    if (!dragging) return;
    // A missed mouseup (pointer released outside the window) would otherwise
    // leave `dragging` true forever, resizing the panes on every later move
    // even with no button held.
    if (!e.buttons) {
      endDrag();
      return;
    }
    const total =
      state.mainHbox.getBoundingClientRect().width - RESIZER_WIDTH;
    const left = resolveLeftWidth(
      startLeftWidth,
      e.screenX - startScreenX,
      total,
    );
    state.leftBrowser.style.flexGrow = String(left);
    state.rightBrowser.style.flexGrow = String(total - left);
  };

  addTrackedListener(state, state.resizer, "mousedown", onMouseDown);
  // move/up on the window so dragging beyond the resizer still tracks.
  addTrackedListener(state, state.win, "mousemove", onMouseMove);
  addTrackedListener(state, state.win, "mouseup", endDrag);
}

/**
 * Handler kept at module scope so unregisterReaderContextMenu() can revoke it
 * by reference via Reader.unregisterEventListener.
 */
let _readerContextMenuHandler: ((event: any) => void) | null = null;

/**
 * Register ONE「Z-Transplit」submenu in the reader's blank-area context menu,
 * holding every reader-level entry so they cannot get mixed up with other
 * plugins' flat items:
 *   - 取消进行中的翻译 (only while a translation is in flight);
 *   - 翻译并分屏打开 / 分屏对照（不翻译） — the split-view flows;
 *   - 上下对照双语阅读 / 仅译文双语阅读 — the bilingual overlay flows.
 *
 * The submenu is a single appended item carrying a `groups` array: the host
 * renderer (chrome reader.js _openContextMenu, verified identical on Zotero
 * 7.0.15 and 10) turns `groups` into a nested menu with a menuseparator
 * between groups. Every entry carries `checked`, which the host renders as a
 * native checkbox checkmark; the menu is rebuilt on EVERY right-click, so
 * state read at build time is always fresh (the conditional cancel entry has
 * relied on this all along).
 *
 * Field restrictions, verified against Zotero 10.0.6's installed omni.ja
 * (resource/reader/reader.js ← upstream src/index.zotero.js): the createReader
 * wrapper hard-rejects TOP-LEVEL `icon`/`slider` only — "Icons and sliders are
 * unsupported in native context menus", and the throw kills the whole popup —
 * the check is not recursive into `groups`, and `checked`/`groups` are both
 * consumed by the host renderer. So: no icon/slider anywhere, checkmarks and
 * the submenu itself are safe on both host versions.
 *
 * Must be called once per plugin lifecycle (registerEventListener is global).
 */
export function registerReaderContextMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.registerEventListener !== "function") return;
  const pluginID = addonID();

  try {
    _readerContextMenuHandler = (event: any) => {
      const { reader, append } = event;
      if (!append || !reader) return;

      // Group 1: conditional cancel — only shown while a translation is in
      // progress (empty groups are filtered out below; a rendered empty group
      // would leave a stray leading separator).
      const cancelGroup: any[] = [];
      if (activeTranslationController) {
        cancelGroup.push({
          label: getString("splitview-menu-cancel"),
          onCommand: () => {
            activeTranslationController?.abort();
          },
        });
      }

      // Group 2: split entries. Checkmark source is the tab the user
      // right-clicked in (`reader.tabID`; undefined for reader windows, where
      // no checkmark is correct — split views only ever open as tabs). Both
      // entries checkmark together: 「分屏对照（不翻译）」 also lands the latest
      // translation on the right pane when one exists (handleSplitFromReader),
      // so the two flows can produce the same view and cannot be told apart —
      // the checkmark means "this tab IS a split comparison", not which entry
      // produced it.
      const inSplitTab = isSplitViewTab(reader?.tabID);
      const splitGroup = [
        {
          label: getString("splitview-menu-translate"),
          checked: inSplitTab,
          onCommand: () => runTranslateAndSplitFromReader(reader),
        },
        {
          label: getString("splitview-menu-compare"),
          checked: inSplitTab,
          onCommand: () => runCompareSplitFromReader(reader),
        },
      ];

      // Group 3: bilingual entries — exactly one checkmarks while the single
      // live session runs on THIS reader's item (getActiveBilingualModeForItem
      // returns null for unknown-item sessions and for sessions on other
      // items, so neither entry checkmarks then).
      const liveMode = getActiveBilingualModeForItem(
        getCurrentReaderItemID(reader),
      );
      const bilingualGroup = [
        {
          label: getString("splitview-menu-interleave"),
          checked: liveMode === "interleave",
          onCommand: async () => {
            await launchBilingualFromReader(reader, "interleave");
          },
        },
        {
          label: getString("splitview-menu-trans-only"),
          checked: liveMode === "transOnly",
          onCommand: async () => {
            await launchBilingualFromReader(reader, "transOnly");
          },
        },
      ];

      const groups = [cancelGroup, splitGroup, bilingualGroup].filter(
        (group) => group.length > 0,
      );
      append({
        label: getString("splitview-menu-root"),
        groups,
      });
    };
    Reader.registerEventListener(
      "createViewContextMenu",
      _readerContextMenuHandler,
      pluginID,
    );
  } catch (e) {
    safeDebug("[Z-Transplit splitView] menu registration error: " + e);
  }
}

/** Revoke the reader context-menu submenu (plugin shutdown / disable). Best-effort. */
export function unregisterReaderContextMenu(): void {
  const Reader = (Zotero as any).Reader;
  if (!Reader || typeof Reader.unregisterEventListener !== "function") return;
  if (_readerContextMenuHandler) {
    try {
      Reader.unregisterEventListener(
        "createViewContextMenu",
        _readerContextMenuHandler,
      );
    } catch (e) {
      safeDebug("[Z-Transplit splitView] menu unregister error: " + e);
    }
    _readerContextMenuHandler = null;
  }
}

/**
 * 「分屏对照（不翻译）」 flow: takes the current reader's PDF as the LEFT pane,
 * then looks for another PDF attachment under the same parent item to use as
 * the RIGHT pane (prefers previous translations, then newest by dateAdded).
 * Falls back to the same PDF on both sides when no sibling exists.
 */
async function runCompareSplitFromReader(reader: any): Promise<void> {
  try {
    const currentItemID = getCurrentReaderItemID(reader);
    if (!currentItemID) {
      throw new Error("reader has no itemID");
    }
    await handleSplitFromReader({ itemID: currentItemID });
  } catch (e) {
    safeDebug("[Z-Transplit splitView] open failed: " + e);
    alertDialog(
      getString("splitview-error-dialog-title"),
      getString("splitview-error-open", { detail: String(e) }),
    );
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

/**
 * Java launch-failure signatures shared by isJavaMissingError and
 * friendlyOdlError. Deliberately NOT a bare "java" substring: an API error
 * mentioning java anywhere (model names, URLs, java.lang.* stack traces from a
 * RUNNING JVM — see backendSelector's M-25 note) must not route the user to
 * the "install Java?" dialog. Mirrors the launch-failure patterns
 * backendSelector already classifies on, plus the wording PdfParseError and
 * JavaRuntimeManager emit, and the shells those errors get wrapped in on the
 * way out (err-java-unavailable's "Java 不可用/unavailable：…", checkHealth's
 * "java -version failed" fallback, err-java-too-old's "需要 Java 11+").
 */
const JAVA_MISSING_RE = new RegExp(
  [
    "java[^\\n]{0,80}(?:is not recognized|not found|command not found|no such file|无法找到|找不到)",
    "(?:is not recognized|not found|command not found|no such file|无法找到|找不到)[^\\n]{0,80}java",
    "requires\\s+java\\s+1[17]",
    "install\\s+java",
    "需要安装\\s*java",
    "需要安裝\\s*java",
    // 版本过旧文案（err-java-too-old，zh-CN）："…但 OpenDataLoader 需要 Java 11+…"
    // 只说"需要"，没有"安装"两个字——上面的模式全部漏掉它。
    "需要\\s*java\\s*1[17]",
    // 健康预检外壳（err-java-unavailable）："Java 不可用：…" / "Java unavailable: …"
    "java[^\\n]{0,40}(?:不可用|無法使用|unavailable)",
    // checkHealth 探测失败时返回的兜底错误串 "java -version failed"
    "java\\s+-version\\s+failed",
    "jvm[^\\n]{0,40}not\\s+found",
  ].join("|"),
  "i",
);

/**
 * Convert raw OpenDataLoader translation error messages to user-friendly Chinese.
 */
export function friendlyOdlError(msg: string): string {
  // HTTP status first: 401/403 (bad key) and 429 (quota/rate) have dedicated
  // copy; other HTTP failures keep the code plus a short response excerpt.
  // Before this, all HTTP errors fell through to the raw `HTTP 401: …` text.
  const http = /\bHTTP\s+(\d{3})\b/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 403) {
      return getString("odl-error-http-auth", { code });
    }
    if (code === 429) {
      return getString("odl-error-http-rate", { code });
    }
    return getString("odl-error-http-other", {
      code,
      detail: msg.slice(0, 100),
    });
  }
  if (JAVA_MISSING_RE.test(msg)) {
    return getString("odl-error-java-missing");
  }
  const m = msg.toLowerCase();
  // Component errors, by signature — the old blanket `includes("jar")` rule
  // rewrote every java.lang.* stack trace that merely mentioned a jar into
  // 「解析组件缺失，请重新安装插件」, and its reinstall advice could not fix
  // the packed-XPI case it was most often shown for. See classifyJarError.
  const jarKind = classifyJarError(msg);
  if (jarKind === "download-failed") {
    return getString("odl-error-jar-download-failed");
  }
  if (jarKind === "missing") {
    return getString("odl-error-jar-missing");
  }
  if (jarKind === "unreadable") {
    return getString("odl-error-jar-unreadable");
  }
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
    // "timed out" — backendSelector already matches both spellings; fetch/XHR
    // errors usually carry the two-word form.
    m.includes("timed out") ||
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
 * Signature-based — see JAVA_MISSING_RE.
 */
export function isJavaMissingError(msg: string): boolean {
  return JAVA_MISSING_RE.test(msg || "");
}

/**
 * Whether a THROWN VALUE warrants offering the bundled-JRE install dialog.
 *
 * Prefers the structured PdfParseError.reason: the pipeline throws
 * PdfParseError("java-missing") from the health preflight and from the runtime
 * classifier, and that class pins the message to a fixed English hint while
 * dropping the localized detail — so `reason` survives re-wrapping that
 * message matching does not, and it can never be confused by a message that
 * merely mentions java. The signature regex stays as the fallback for throws
 * that never became PdfParseError (host exceptions, adapter-level Errors).
 */
export function isJavaMissingCause(e: unknown): boolean {
  if (e instanceof PdfParseError) return e.reason === "java-missing";
  return isJavaMissingError(toErrorMessage(e));
}

/**
 * Guide the user through downloading a bundled JRE when Java is missing.
 *
 * Flow: confirm dialog (下载安装 / 手动打开下载页 / 取消) → if download chosen,
 * run the shared progress-window install (installManagedJavaWithProgress).
 * Returns true if a JRE is now available (so the caller can hint at retry).
 */
export async function handleMissingJava(): Promise<boolean> {
  const Services = (globalThis as any).Services;
  const win = (Zotero as any).getMainWindow();
  // Three explicit choices via confirmEx: download+install / open the manual
  // download page / do nothing. The previous OK/Cancel pair overloaded Cancel
  // as "open the browser anyway" while the dialog text promised a manual
  // visit — behavior now matches the text, and there is a real opt-out.
  const P = Services?.prompt;
  if (typeof P?.confirmEx !== "function") return false;
  const stringButtons =
    P.BUTTON_POS_0 * P.BUTTON_TITLE_IS_STRING |
    P.BUTTON_POS_1 * P.BUTTON_TITLE_IS_STRING |
    P.BUTTON_POS_2 * P.BUTTON_TITLE_IS_STRING;
  const choice = P.confirmEx(
    win,
    getString("java-dialog-title"),
    getString("java-dialog-body"),
    stringButtons,
    getString("java-dialog-button-download"),
    getString("java-dialog-button-openpage"),
    getString("java-dialog-button-cancel"),
    null,
    {},
  );
  if (choice === 1) {
    try {
      (Zotero as any).launchURL?.("https://adoptium.net");
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
    return false;
  }
  if (choice !== 0) return false; // Cancel — no side effects at all
  return installManagedJavaWithProgress();
}

/**
 * Concurrent install requests share one in-flight run — downloadJRE()
 * deduplicates the install itself, but without this latch a second click
 * would also stack a second ProgressWindow on top of the first.
 */
let javaInstallUiInFlight: Promise<boolean> | null = null;

/**
 * Download + extract the managed JRE with a ProgressWindow — no confirm
 * dialog. This is the programmatically callable half of handleMissingJava:
 * the settings pane's 「安装 / 修复」 button reaches it through
 * Zotero.ZTransplit.java.install, and the dialog flow funnels here too.
 *
 * Failure keeps its message visible in the progress window and opens the
 * manual download page, so even a caller that ignores the return value leaves
 * the user an actionable next step.
 */
export function installManagedJavaWithProgress(): Promise<boolean> {
  if (javaInstallUiInFlight) return javaInstallUiInFlight;
  javaInstallUiInFlight = runManagedJavaInstall().finally(() => {
    javaInstallUiInFlight = null;
  });
  return javaInstallUiInFlight;
}

async function runManagedJavaInstall(): Promise<boolean> {
  const progress = new (Zotero as any).ProgressWindow({
    window: (Zotero as any).getMainWindow?.() || null,
  });
  progress.changeHeadline(getString("java-progress-install"));
  progress.addDescription(getString("java-progress-download-prepare"));
  progress.show();
  try {
    const { downloadJRE } = await import("../JavaRuntimeManager");
    // ProgressWindow.addDescription appends a row per call, and the download
    // fires a progress event per network chunk (hundreds for ~40 MB) — report
    // phase changes and whole 10-percent steps only.
    let lastDownloadStep = -1;
    await downloadJRE(17, (p) => {
      try {
        if (p.phase === "downloading") {
          const step = Math.floor((p.percent || 0) / 10) * 10;
          if (step === lastDownloadStep) return;
          lastDownloadStep = step;
        }
        progress.addDescription(p.message || `${p.phase} (${p.percent}%)`);
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
 * Currently active translation AbortController, or null when no translation
 * is in progress. The「取消正在进行的翻译」submenu entry calls .abort() on this
 * for cooperative cancellation. Deliberately stays in THIS module (the host of
 * the read/write) rather than being shared across files.
 */
let activeTranslationController: AbortController | null = null;

/**
 * 「翻译并分屏打开」 flow — the DEFAULT translation path (no ORT dependency, no
 * Python — only needs Java + a configured translation engine). Reached from
 * the reader context-menu submenu; unconditional, no preference gate.
 */
async function runTranslateAndSplitFromReader(reader: any): Promise<void> {
  // Defensive guard: if a translation is already in flight, don't start
  // another. The user should see "取消正在进行的翻译" above this entry
  // in the submenu, but if this fires anyway say so — a silently
  // ignored click reads as "the plugin is broken".
  if (activeTranslationController) {
    safeDebug(
      "[Z-Transplit splitView] translation already in progress, ignoring duplicate request",
    );
    try {
      const busy = new (Zotero as any).ProgressWindow();
      busy.changeHeadline(getString("app-title"));
      busy.addDescription(getString("splitview-error-in-flight"));
      busy.show();
      busy.startCloseTimer?.(4000);
    } catch (e) {
      safeDebug("[Z-Transplit] splitViewFactory: " + e);
      /* best-effort */
    }
    return;
  }
  const sourceItemID: number | undefined = getCurrentReaderItemID(reader);
  if (!sourceItemID) {
    safeDebug(
      "[Z-Transplit splitView] cannot resolve source itemID from reader",
    );
    alertDialog(
      getString("splitview-error-dialog-title"),
      getString("splitview-error-no-item"),
    );
    return;
  }
  const sourceItem = (Zotero as any).Items.get(sourceItemID);
  if (!sourceItem) {
    alertDialog(
      getString("splitview-error-dialog-title"),
      getString("splitview-error-no-item"),
    );
    return;
  }

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
      // debug + 统一对话框提示。
      safeDebug(
        "[Z-Transplit splitView] reuse-translation open failed: " + e,
      );
      alertDialog(
        getString("splitview-error-dialog-title"),
        getString("splitview-error-open", { detail: String(e) }),
      );
      return;
    }
    try {
      const p = new (Zotero as any).ProgressWindow({ window: win });
      p.changeHeadline(getString("app-title"));
      p.addDescription(
        getString("splitview-progress-reused", {
          title: existing.getField?.("title") || String(existing.id),
        }),
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
    progress = new (Zotero as any).ProgressWindow({
      window: (Zotero as any).getMainWindow?.() || null,
    });
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
          // show() is a no-op while the window is up, but re-opens it
          // (and flushes queued descriptions) after the user closed it —
          // completion and error lines must not be lost silently.
          progress.show();
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
            title:
              (Zotero as any).Items.get(result.translatedAttachmentId)
                ?.getField?.("title") ||
              String(result.translatedAttachmentId),
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
    // instead of a dead-end blocking alert. Structured reason first
    // (isJavaMissingCause) — matching the message text alone misclassifies
    // the localized preflight shell and JVM crash output.
    if (isJavaMissingCause(e)) {
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
    alertDialog(getString("odl-error-dialog-title"), friendly);
  } finally {
    activeTranslationController = null;
  }
}

let _bilingualMenuBusy = false;

async function launchBilingualFromReader(reader: any, mode: "interleave" | "transOnly"): Promise<void> {
  if (_bilingualMenuBusy) return;
  _bilingualMenuBusy = true;
  try {
    // Resolve via the selected tab like every other reader entry: a stale
    // closure reader (or an Xray-hidden itemID) reads as undefined and the
    // flow would bail with a misleading "no reader" alert.
    const itemID = getCurrentReaderItemID(reader);
    if (!itemID) {
      alertDialog(
        getString("app-title"),
        getString("itemtree-launch-no-reader"),
      );
      return;
    }

    const win = (Zotero as any).getMainWindow?.() || null;
    let progress: any = null;
    try {
      progress = new (Zotero as any).ProgressWindow({ window: win });
      progress.changeHeadline(getString("app-title"));
      progress.addDescription(getString("itemtree-launch-progress"));
      progress.show();

      const lang =
        (getPrefDynamic("translate.targetLanguage") as string | undefined) ??
        "zh-CN";
      let cacheIdentity: string | undefined;
      try {
        cacheIdentity = engineCacheIdentity();
      } catch {
        cacheIdentity = undefined;
      }

      const handle = await startBilingualSession({
        reader,
        itemID,
        mode,
        targetLanguage: lang,
        cacheIdentity,
        onProgress: (stats) => {
          try {
            progress.addDescription(
              getString("bilingual-progress", {
                done: stats.done,
                total: stats.total,
              }),
            );
            progress.show();
          } catch {
            /* progress window closed */
          }
        },
      });

      if (!handle) {
        progress.addDescription(getString("bilingual-sdt-missing"));
        progress.startCloseTimer?.(6000);
        return;
      }

      progress.addDescription(getString("itemtree-launch-done"));
      progress.startCloseTimer?.(3000);
    } catch (e: any) {
      safeDebug("[Z-Transplit] bilingual reader menu launch failed: " + e);
      try {
        progress?.addDescription("✗ " + toErrorMessage(e));
        progress?.startCloseTimer?.(8000);
      } catch {
        /* best-effort */
      }
      await stopBilingualSession();
    }
  } finally {
    _bilingualMenuBusy = false;
  }
}

/** Re-exported for the factory's callers (sync wiring + pane types). */
export type { ReaderPaneAdapter, SplitSide };
