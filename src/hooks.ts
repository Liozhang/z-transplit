import { initLocale } from "./utils/locale";
import { safeDebug } from "./utils/logger";
import { toErrorMessage } from "./utils/error";
import { migratePrefs } from "./utils/prefMigrations";

/**
 * Plugin startup.
 *
 * Order matters: wait for Zotero to finish initializing (the promises are what
 * the bootstrap guarantees are resolvable) → register the Fluent sources →
 * hand over to the UI registration module → register the reader context-menu
 * entry points of the PDF split-view pipeline.
 */
async function onStartup() {
  await Promise.allSettled([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // 偏好结构迁移（src/utils/prefMigrations.ts）：Zotero 已在此前应用完
  // prefs.js 默认值，是执行迁移的正确时机；迁移内部自防御，失败只记录，
  // 绝不阻断后续 UI 注册。
  migratePrefs();

  // Re-entrancy latch: some hosts fire onStartup more than once per process
  // (main-window reload), and re-running the UI registration would double
  // register the menu entries / reader sections.
  if (_globalThis.addon.data.initialized) {
    safeDebug("[Z-Transplit] already initialized, skipping repeated startup");
    return;
  }

  // The UI layer lives in its own module so a failure there can never break the
  // data layer. It registers the reader item-pane section
  // ('ztransplit-translate'), which is capability-gated (translate.enabled +
  // engine readiness) and therefore silently skips registration when the
  // feature is off — see src/modules/registerTranslateUI.ts.
  try {
    const mod = await import("./modules/registerTranslateUI");
    if (typeof mod?.registerTranslateUI === "function") {
      mod.registerTranslateUI();
    } else {
      safeDebug(
        "[Z-Transplit] ./modules/registerTranslateUI exports no registerTranslateUI() — UI not registered",
      );
    }
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerTranslateUI unavailable: ${toErrorMessage(e)}`,
    );
  }

  // The PDF split-view pipeline is reachable ONLY through its reader
  // context-menu entries (「翻译并分屏」 via the OpenDataLoader pipeline and
  // 「对比分屏」 for a manual side-by-side), and nothing else in the addon
  // registers them — so this is the one and only call site. Skipping it leaves
  // the whole translate→split flow (and its bundle code) unreachable at
  // runtime. Registration is unconditional by design: each menu action
  // preflights its own preconditions (engine readiness / Java) and reports a
  // human-readable error instead of silently doing nothing.
  try {
    const mod = await import("./core/pdf/splitview/splitViewFactory");
    mod.registerSplitViewMenu();
    mod.registerOpenDataLoaderMenu();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./core/pdf/splitview/splitViewFactory unavailable: ${toErrorMessage(e)}`,
    );
  }

  // Library item context-menu entries (translate-to-attachment + split).
  try {
    const mod = await import("./modules/registerItemTreeMenu");
    mod.registerItemTreeMenu();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerItemTreeMenu unavailable: ${toErrorMessage(e)}`,
    );
  }

  // Word-cards entry points: the reader-toolbar listener (global, once per
  // plugin lifecycle) plus library toolbar buttons for windows that already
  // exist; windows opened later are covered by onMainWindowLoad. Each button
  // preflights its own anchor and degrades to a log — see
  // src/modules/registerWordCardsUI.ts.
  try {
    const mod = await import("./modules/registerWordCardsUI");
    mod.registerWordCardsUI();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerWordCardsUI unavailable: ${toErrorMessage(e)}`,
    );
  }

  // Fire-and-forget cache maintenance (prune is LRU, size from prefs).
  void (async () => {
    try {
      const { getPrefDynamic } = await import("./utils/prefs");
      const { pruneCache } = await import("./core/translation/translationCache");
      const maxMB = Number(getPrefDynamic("translate.cache.maxSizeMB")) || 200;
      const removed = await pruneCache(maxMB * 1024 * 1024);
      if (removed > 0) {
        safeDebug(`[Z-Transplit] translation cache pruned: ${removed} files`);
      }
    } catch {
      /* best-effort */
    }
  })();

  _globalThis.addon.data.initialized = true;
}

async function onMainWindowLoad(window: any) {
  safeDebug(
    `[Z-Transplit] main window loaded: ${window?.location?.href ?? "(unknown)"}`,
  );
  try {
    const mod = await import("./modules/registerItemTreeMenu");
    mod.registerItemTreeMenuForWindow(window);
  } catch {
    /* best-effort */
  }
  // This window's word-cards library toolbar button.
  try {
    const mod = await import("./modules/registerWordCardsUI");
    mod.registerWordCardsUIForWindow(window);
  } catch {
    /* best-effort */
  }
}

async function onMainWindowUnload(window: any) {
  safeDebug("[Z-Transplit] main window unloaded");
  // Revoke this window's injected item-tree menu; without this a closed main
  // window leaked its tracked entry (and its injected popup nodes) until full
  // plugin shutdown.
  try {
    const mod = await import("./modules/registerItemTreeMenu");
    mod.unregisterItemTreeMenuForWindow(window);
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerItemTreeMenu unavailable on window unload: ${toErrorMessage(e)}`,
    );
  }
  // Revoke this window's word-cards library toolbar button.
  try {
    const mod = await import("./modules/registerWordCardsUI");
    mod.unregisterWordCardsUIForWindow(window);
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerWordCardsUI unavailable on window unload: ${toErrorMessage(e)}`,
    );
  }
}

async function onShutdown() {
  _globalThis.addon.data.alive = false;
  // Revoke the item-pane section. Zotero also auto-removes sections carrying
  // our pluginID, but doing it explicitly keeps a dev "Reload Plugins" in the
  // same process from stacking registrations (the latch in onStartup is
  // per-process and a reload builds a fresh addon.data).
  try {
    const mod = await import("./modules/registerTranslateUI");
    if (typeof mod?.unregisterTranslateUI === "function") {
      mod.unregisterTranslateUI();
    }
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerTranslateUI unavailable on shutdown: ${toErrorMessage(e)}`,
    );
  }
  // Mirror the startup registration: revoke both reader context-menu listeners
  // (「翻译并分屏」/「对比分屏」) so a plugin reload in the same process cannot
  // stack duplicate menu items.
  try {
    const mod = await import("./core/pdf/splitview/splitViewFactory");
    mod.unregisterSplitViewMenu();
    mod.unregisterOpenDataLoaderMenu();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./core/pdf/splitview/splitViewFactory unavailable on shutdown: ${toErrorMessage(e)}`,
    );
  }
  // Revoke the library item context-menu injections.
  try {
    const mod = await import("./modules/registerItemTreeMenu");
    mod.unregisterItemTreeMenu();
  } catch {
    /* best-effort */
  }
  // Revoke the word-cards entry buttons and close an open word-cards tab.
  try {
    const mod = await import("./modules/registerWordCardsUI");
    mod.unregisterWordCardsUI();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./modules/registerWordCardsUI unavailable on shutdown: ${toErrorMessage(e)}`,
    );
  }
  // Stop the split-view sync pollers; a live 400ms interval would otherwise
  // survive disable/reload for as long as the user keeps a split tab open.
  try {
    const mod = await import("./core/pdf/splitview/splitViewCleanup");
    mod.stopAllSyncPollers();
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./core/pdf/splitview/splitViewCleanup unavailable on shutdown: ${toErrorMessage(e)}`,
    );
  }
  // Tear down any active bilingual-control session (timers/DOM in the reader).
  try {
    const mod = await import("./ui/bilingualControl");
    if (typeof mod?.disposeActiveBilingualSession === "function") {
      await mod.disposeActiveBilingualSession();
    }
  } catch (e) {
    safeDebug(
      `[Z-Transplit] ./ui/bilingualControl unavailable on shutdown: ${toErrorMessage(e)}`,
    );
  }
  safeDebug("[Z-Transplit] shutdown");
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
