/**
 * bilingualLauncher — shared bilingual session lifecycle.
 *
 * Owns the single live session at module scope so reader-context menus,
 * item-tree menus and the sidebar can all start / stop the same overlay
 * without duplicating state.
 */

import { safeDebug } from "../../../utils/logger";
import { toErrorMessage } from "../../../utils/error";
import { getPrefDynamic } from "../../../utils/prefs";
import { createAbortController } from "../../../utils/abort";
import {
  enterBilingualSession,
  exitBilingualSession,
  type BilingualSession,
} from "./sdtBridge";
import {
  buildInterleave,
  type BilingualMode,
  type InterleaveHandle,
} from "./interleaveView";
import type { QueueStats } from "./lazyQueue";
import {
  createAIBatchTranslator,
  createTranslator,
  supportsBatching,
} from "../../translation/translationEngines";

interface SessionState {
  itemID: number;
  session: BilingualSession;
  handle: InterleaveHandle;
  abort: AbortController;
}

let active: SessionState | null = null;
const listeners = new Set<() => void>();

/**
 * 最近一次引擎级失败的原因（实机 2026-10-12：Google 端点不可达时 67 个块
 * 全部停在「翻译中…」，侧边栏只有「已译 N/M 段」，用户完全看不到失败原因——
 * 每块 10 秒超时 × 批内串行，一批要一分多钟才落为失败）。把原因捕获到这里，
 * 侧边栏的进度行据此拼接失败提示；新会话启动与单条翻译成功时清空。
 */
let lastEngineError: string | null = null;

export function getLastEngineError(): string | null {
  return lastEngineError;
}

function noteEngineError(message: string | null): void {
  lastEngineError = message;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* one misbehaving listener must not break the others */
    }
  }
}

export function getActiveSession(): SessionState | null {
  return active;
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The live session's mode when it runs on this exact item, else null. Menus
 * read this at build time to render their checkmark state. A session started
 * without a known item stores -1 as a sentinel — it matches nothing, so a
 * session whose origin is unknown never checkmarks a menu entry.
 */
export function getActiveBilingualModeForItem(
  itemID: number | undefined | null,
): BilingualMode | null {
  if (itemID === undefined || itemID === null || itemID < 0) return null;
  if (!active || active.itemID !== itemID) return null;
  try {
    return active.handle.getMode();
  } catch {
    return null;
  }
}

/**
 * Wait until the reader exposes the SDT reading-mode entry points.
 *
 * The item-tree flow resolves the reader the moment Zotero registers the tab —
 * which is BEFORE the reader iframe finishes loading, so `_internalReader`
 * (and with it `_setReadingMode` / `_loadSDT`) is still absent. Entering then
 * fails with "SDT mode API not present" and the item-tree path used to swallow
 * that silently: the user saw the plain reader open and nothing else. Poll
 * briefly for the entry points instead; readers that will never have them
 * (Zotero 7) simply wait out the budget once and then fail fast with the
 * normal capability disclosure.
 */
async function waitForReaderSdtEntry(reader: any, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const probe = (reader as any)?._internalReader ?? reader;
    const raw: any = probe?.wrappedJSObject ?? probe;
    if (
      typeof raw?._setReadingMode === "function" &&
      typeof raw?._loadSDT === "function"
    ) {
      return;
    }
    if (Date.now() - start >= timeoutMs) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function startBilingualSession(options: {
  reader: any;
  itemID?: number;
  mode: BilingualMode;
  targetLanguage?: string;
  cacheIdentity?: string;
  signal?: AbortSignal;
  onProgress?: (stats: QueueStats) => void;
}): Promise<InterleaveHandle | null> {
  const {
    reader,
    itemID,
    mode,
    targetLanguage,
    cacheIdentity,
    signal,
    onProgress,
  } = options;

  if (active) {
    if (
      options.itemID !== undefined &&
      active.itemID !== -1 &&
      active.itemID === options.itemID
    ) {
      try {
        active.handle.setMode(options.mode);
        return active.handle;
      } catch {
        /* fall through to restart */
      }
    }
    await stopBilingualSession();
  }

  noteEngineError(null);

  await waitForReaderSdtEntry(reader);

  const session = await enterBilingualSession(reader);
  if (!session) {
    safeDebug("[Z-Transplit] bilingualLauncher: session unavailable");
    return null;
  }

  try {
    const abort = createAbortController();
    const effectiveSignal = signal ? combineSignals(signal, abort) : abort.signal;

    const lang =
      targetLanguage ??
      (getPrefDynamic("translate.targetLanguage") as string | undefined) ??
      "zh-CN";
    const batchTranslate = await makeBatchTranslator(lang);

    const handle = await buildInterleave(session, {
      targetLanguage: lang,
      cacheIdentity,
      batchTranslate,
      signal: effectiveSignal,
      onProgress: (stats) => {
        onProgress?.(stats);
      },
    });

    handle.setMode(mode);

    active = { itemID: itemID ?? -1, session, handle, abort };
    notify();
    return handle;
  } catch (e) {
    await exitBilingualSession(session);
    throw e;
  }
}

/**
 * Resolve the reader for the given itemID from the current tab, then start the
 * bilingual session. Used by entry points that only have an item identity
 * (library item-tree menu) rather than a reader instance.
 */
export async function startBilingualSessionByItemID(options: {
  win: any;
  itemID: number;
  mode: BilingualMode;
  targetLanguage?: string;
  cacheIdentity?: string;
  signal?: AbortSignal;
  onProgress?: (stats: QueueStats) => void;
}): Promise<InterleaveHandle | null> {
  const {
    win,
    itemID,
    mode,
    targetLanguage,
    cacheIdentity,
    signal,
    onProgress,
  } = options;

  const Zotero = win?.Zotero ?? (globalThis as any).Zotero;
  const Reader = Zotero?.Reader;
  const Zotero_Tabs = win?.Zotero_Tabs ?? Zotero?.Tabs;

  let reader: any = null;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const tabID = Zotero_Tabs?.selectedID;
    const candidate = Reader?.getByTabID?.(tabID);
    if (candidate && candidate.itemID === itemID) {
      reader = candidate;
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  if (!reader) {
    safeDebug("[Z-Transplit] bilingualLauncher: reader for item " + itemID + " not found");
    return null;
  }

  return startBilingualSession({
    reader,
    itemID,
    mode,
    targetLanguage,
    cacheIdentity,
    signal,
    onProgress,
  });
}

export async function stopBilingualSession(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;

  try {
    current.abort.abort();
  } catch {
    /* ignore */
  }
  try {
    await current.handle.dispose();
  } catch (e) {
    safeDebug("[Z-Transplit] bilingualLauncher stop: " + e);
    await exitBilingualSession(current.session);
  }
  notify();
}

export async function disposeActiveBilingualSession(): Promise<void> {
  await stopBilingualSession();
}

async function makeBatchTranslator(
  targetLanguage: string,
): Promise<(texts: string[], signal?: AbortSignal) => Promise<{ translations: string[]; failedIndices: number[] }>> {
  if (supportsBatching()) {
    const handle = await createAIBatchTranslator(targetLanguage);
    return async (texts, signal) => {
      const result = await handle.translate(texts, signal);
      // 批量路径的失败只以 failedIndices 返回、从不抛出——引擎原因必须在
      // 这里记录，侧边栏进度行才有东西可显示（真机复现 2026-11-02：AI 批量
      // 429 时 95 段全败，进度行只有「未知错误」，原因在批量函数里被丢弃）。
      // 与逐段分支同一语义：整块成功即清空，有失败记最近一次原因。有失败但
      // 结果没带原因时（旧实现，或原因确实未知）保留上一次，不写成空——
      // 空串会让进度行退回「未知错误」，比留着上一条更没用。
      if (result.failedIndices.length === 0) {
        noteEngineError(null);
      } else if (result.error) {
        noteEngineError(result.error);
      }
      return result;
    };
  }
  const translator = createTranslator(targetLanguage);
  return async (texts, signal) => {
    const out: string[] = [];
    const failed: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (signal?.aborted) break;
      try {
        out.push(await translator(texts[i], targetLanguage));
        noteEngineError(null);
      } catch (e) {
        out.push(texts[i]);
        failed.push(i);
        // 只保留最近一次：状态行只需要一个当前原因，陈旧原因反而误导。
        noteEngineError(toErrorMessage(e));
      }
    }
    return { translations: out, failedIndices: failed };
  };
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}
