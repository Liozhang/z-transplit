/**
 * bilingualControl — the bilingual reading control block inside the reader
 * translate pane section.
 *
 * Renders a compact bar below the translate pane: a bilingual toggle,
 * presentation-mode buttons (上下对照 interleave / 仅译文 translation-only),
 * progress and a status line. The mode buttons are always clickable — with a
 * live session they switch the presentation; without one they start a session
 * directly in that mode, and the choice is remembered as the start-up
 * default. On hosts without the Zotero 10 SDT reading mode it renders a
 * capability disclosure instead of the controls.
 *
 * Session lifecycle is owned by `src/core/pdf/sdt/bilingualLauncher` so the
 * reader context menu and the item-tree menu can start the same overlay
 * without duplicating state. This module only wires the launcher to the
 * sidebar DOM and reacts to external session changes via `onSessionChange`.
 *
 * @module ui/bilingualControl
 */

import { safeDebug } from "../utils/logger";
import { toErrorMessage } from "../utils/error";
import { getString } from "../utils/locale";
import { getPref, getPrefDynamic, setPref } from "../utils/prefs";
import { createAbortController } from "../utils/abort";
import { resolveCurrentReader } from "./translatePane";
import { probeReaderCapabilities } from "../core/capabilities";
import { getReaderKind, type ReaderKind } from "../core/readerKind";
import {
  startBilingualSession,
  stopBilingualSession,
  getActiveSession,
  getLastEngineError,
  onSessionChange,
} from "../core/pdf/sdt/bilingualLauncher";
import {
  ReadAloudController,
  type ReadAloudSegment,
} from "../core/readAloud/readAloudController";
import {
  pdfReadAloudSupported,
  currentPageNumber,
  buildPdfSegments,
  highlightSegment,
  clearSegmentHighlight,
  followSegment,
} from "../core/readAloud/pdfReaderTts";
import {
  engineCacheIdentity,
} from "../core/translation/translationEngines";

const CLS = "ztransplit-bc";

interface ControlState {
  doc: Document;
  toggle: HTMLButtonElement;
  modeButtons: {
    interleave: HTMLButtonElement;
    transOnly: HTMLButtonElement;
  } | null;
  progressLabel: HTMLElement;
  status: HTMLElement;
  controlsBox: HTMLElement;
  readAloudBox: HTMLElement | null;
  readAloudButtons: {
    original: HTMLButtonElement;
    translation: HTMLButtonElement;
    pause: HTMLButtonElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    stop: HTMLButtonElement;
  } | null;
  setStatus(msg: string): void;
  setProgress(msg: string): void;
  setActive(activeNow: boolean): void;
  setMode(mode: "interleave" | "transOnly"): void;
  setReadAloudPlaying(playing: boolean): void;
  refreshReadAloudButtons(): void;
}

export interface BilingualControlHandle {
  destroy(): void;
}

/** Reader toolbar button state. */
let readerToolbarHandler: ((event: any) => void) | null = null;

const mounted = new WeakMap<HTMLElement, { destroy(): void }>();

/** The one read-aloud playback (module scope: one voice at a time). */
let raController: ReadAloudController | null = null;
let raSource: "original" | "translation" | null = null;
/**
 * Monotonic token guarding the async start flow: bumped on every teardown so
 * a segment build that was in flight when the user stopped / switched sources
 * lands late and must not spawn a controller nobody asked for.
 */
let raGeneration = 0;

function targetLanguageFor(): string {
  const pref = getPrefDynamic("translate.targetLanguage") as string | undefined;
  let locale = "";
  try {
    locale = String((Zotero as any)?.locale || "");
  } catch {
    locale = "";
  }
  return pref || locale || "zh-CN";
}

/** The persisted start-up mode — anything unparsable falls back to interleave. */
function storedDefaultMode(): "interleave" | "transOnly" {
  return (getPref("reader.bilingual.defaultMode") as string) === "transOnly"
    ? "transOnly"
    : "interleave";
}

function el(doc: Document, tag: string, cls?: string): HTMLElement {
  const e = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  if (cls) e.className = cls;
  return e;
}

function svg(doc: Document, markup: string): SVGElement {
  const el = doc.createRange().createContextualFragment(markup).querySelector("svg");
  if (!el) throw new Error("svg markup did not contain an <svg> element");
  return el as unknown as SVGElement;
}

// 样式约定：模板串内（CSS 文本）只用英文注释——no-hardcoded-cjk 门禁会扫
// 描字符串字面量，中文说明写在模板外。
// 颜色语义：品牌红 #b5343a 只用于开关的「会话激活」按压态；当前模式的
// 高亮用中性填充加底部指示条（inset 阴影），不与开关争用同一颜色。
// hidden 规则：.ra-btn 等的 display:inline-flex 来源优先级高于 UA 样式表对
// [hidden] 的 display:none，实测（2026-10-12 实机）未播放时暂停/上一句/
// 下一句/停止会全部常显，末尾的 [hidden] 规则恢复该属性语义。
function ensureStyle(doc: Document, body: HTMLElement): HTMLStyleElement {
  const style = el(doc, "style");
  style.className = `${CLS}-style`;
  style.textContent = `
.${CLS}-root {
  display: flex; flex-direction: column; gap: 8px;
  min-width: 15.5em;
  font: inherit; color: var(--zotero-text-color, inherit);
}
.${CLS}-divider {
  height: 1px; width: 100%;
  background: var(--material-border-quinary, rgba(127,127,127,0.25));
  margin: 2px 0;
}
.${CLS}-title {
  font-size: 0.88em; font-weight: 600; opacity: 0.78;
}
.${CLS}-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  min-width: 15.5em;
  margin: 0; padding: 6px 8px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 5px;
  background: var(--material-background, transparent);
}
.${CLS}-toggle, .${CLS}-mode-btn, .${CLS}-ra-btn {
  font: inherit; cursor: pointer; padding: 2px 10px;
  border: 1px solid var(--material-border-quinary, rgba(127,127,127,0.35));
  border-radius: 4px; background: var(--material-background, transparent);
  color: var(--zotero-text-color, inherit);
  display: inline-flex; align-items: center; gap: 4px;
}
.${CLS}-toggle:hover, .${CLS}-mode-btn:hover:enabled, .${CLS}-ra-btn:hover:enabled {
  background: var(--fill-quinary, rgba(127,127,127,0.18));
}
.${CLS}-toggle[data-active="false"] {
  background: var(--material-background, transparent);
  color: var(--zotero-text-color, inherit);
  border-color: var(--material-border-quinary, rgba(127,127,127,0.35));
}
.${CLS}-toggle[data-active="true"] {
  background: #b5343a; color: #ffffff; border-color: #b5343a;
}
.${CLS}-mode-btn[data-active="true"] {
  background: var(--fill-quarternary, rgba(127,127,127,0.28));
  color: var(--zotero-text-color, inherit);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 currentColor;
}
.${CLS}-segmented {
  display: inline-flex;
  border: 1px solid var(--material-border-quinary, rgba(127,127,127,0.35));
  border-radius: 4px;
  overflow: hidden;
}
.${CLS}-segmented .${CLS}-mode-btn {
  border: none;
  border-radius: 0;
  border-inline-end: 1px solid var(--material-border-quinary, rgba(127,127,127,0.35));
}
.${CLS}-segmented .${CLS}-mode-btn:last-child {
  border-inline-end: none;
}
.${CLS}-mode-btn svg, .${CLS}-toggle svg {
  width: 14px; height: 14px; display: block;
}
.${CLS}-ra-btn:disabled, .${CLS}-toggle:disabled, .${CLS}-mode-btn:disabled {
  opacity: 0.55; cursor: default;
}
/* display:inline-flex above outranks the UA [hidden] rule — restore it. */
.${CLS}-ra-btn[hidden], .${CLS}-toggle[hidden], .${CLS}-mode-btn[hidden] {
  display: none;
}
.${CLS}-progress { font-size: 0.88em; color: var(--zotero-text-color-secondary, GrayText); }
.${CLS}-status { width: 100%; font-size: 0.88em; color: var(--zotero-text-color-secondary, GrayText); }
.${CLS}-ra-box {
  padding: 6px 8px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 5px;
  background: var(--fill-quinary, rgba(127,127,127,0.08));
}
.${CLS}-disclosure {
  margin: 2px 0 8px 0; padding: 6px 8px; font-size: 0.88em;
  border-inline-start: 3px solid var(--accent-gold, #cc9200);
  color: var(--zotero-text-color-secondary, GrayText);
}
`;
  body.appendChild(style);
  return style as HTMLStyleElement;
}

async function startSession(
  state: ControlState,
  itemID?: number,
  requestedMode?: "interleave" | "transOnly",
): Promise<void> {
  safeDebug("[Z-Transplit] bilingualControl: startSession itemID=" + itemID);
  state.setStatus(getString("bilingual-sdt-loading"));
  let reader = resolveCurrentReader(state.doc, itemID);
  for (let attempt = 0; !reader && attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1200));
    reader = resolveCurrentReader(state.doc, itemID);
  }
  safeDebug("[Z-Transplit] bilingualControl: reader resolved=" + !!reader);
  if (!reader) {
    state.setStatus(getString("pane-translate-no-reader"));
    return;
  }
  const caps = probeReaderCapabilities(reader);
  if (!caps.sdtModeAvailable) {
    state.setStatus(getString("bilingual-sdt-unavailable"));
    return;
  }

  const targetLanguage = targetLanguageFor();
  let cacheIdentity: string | undefined;
  try {
    cacheIdentity = engineCacheIdentity();
  } catch {
    cacheIdentity = undefined;
  }

  const handle = await startBilingualSession({
    reader,
    itemID,
    mode: requestedMode ?? storedDefaultMode(),
    targetLanguage,
    cacheIdentity,
    onProgress: (stats) => {
      // 失败段存在时说明引擎层面出了问题（网络不可达 / 密钥错误 / 限流），
      // 只报「已译 N/M 段」会让用户面对一排「翻译中…」或灰字「翻译失败」
      // 却无从判断原因（实机 2026-10-12：Google 端点不可达时整批静默）。
      // 状态行升级为失败计数 + 最近一次引擎原因，失败段本身仍可点击重试。
      if (stats.failed > 0) {
        const reason =
          getLastEngineError() || getString("translation-error-unknown");
        state.setProgress(getString("bilingual-progress-failed", {
          done: stats.done,
          total: stats.total,
          failed: stats.failed,
          error: reason,
        }));
      } else {
        state.setProgress(getString("bilingual-progress", {
          done: stats.done,
          total: stats.total,
        }));
      }
      state.refreshReadAloudButtons();
    },
  });

  if (!handle) {
    state.setStatus(getString("bilingual-sdt-missing"));
    return;
  }

  if (requestedMode) {
    setPref("reader.bilingual.defaultMode", requestedMode);
  }
}

async function stopSession(state?: ControlState): Promise<void> {
  stopReadAloudUI(state);
  await stopBilingualSession();
}

// ── read-aloud wiring ───────────────────────────────────────────────────────

function stopReadAloudUI(state?: ControlState): void {
  raGeneration++;
  const c = raController;
  raController = null;
  raSource = null;
  c?.stop();
  state?.setReadAloudPlaying(false);
  clearSegmentHighlight();
}

function startReadAloud(
  state: ControlState,
  source: "original" | "translation",
  itemID?: number,
): void {
  safeDebug("[Z-Transplit] bilingualControl: readAloud source=" + source);
  const running = raSource;
  if (running) {
    stopReadAloudUI(state);
    if (running === source) return;
  }
  const reader = resolveCurrentReader(state.doc);
  if (!reader) {
    state.setStatus(getString("pane-translate-no-reader"));
    return;
  }
  if (!pdfReadAloudSupported(reader) && source === "original") {
    state.setStatus(getString("readaloud-unsupported"));
    return;
  }
  if (source === "translation" && !getActiveSession()) return;

  const rate = Number(getPref("readAloud.rate")) || 1;
  const voicePref = String(getPref("readAloud.voice") || "");
  const lang = source === "translation" ? targetLanguageFor() : undefined;

  const onState = (): void => {
    state.setReadAloudPlaying(!!raController);
  };
  raSource = source;
  const gen = raGeneration;

  if (source === "original") {
    const start = currentPageNumber(reader);
    state.setStatus(getString("bilingual-sdt-loading"));
    void (async () => {
      let segments: ReadAloudSegment[];
      try {
        segments = (await buildPdfSegments(reader, start)).segments;
      } catch (e) {
        safeDebug("[Z-Transplit] bilingualControl readAloud build: " + e);
        if (gen !== raGeneration) return;
        raSource = null;
        state.setStatus(getString("readaloud-start-failed", { error: toErrorMessage(e) }));
        return;
      }
      if (gen !== raGeneration) return;
      if (segments.length === 0) {
        state.setStatus(getString("readaloud-no-content"));
        raSource = null;
        return;
      }
      state.setStatus("");
      raController = new ReadAloudController({
        getWin: () =>
          (globalThis as any).Zotero?.getMainWindow?.() ?? state.doc.defaultView,
        rate,
        ...(voicePref ? { voiceName: voicePref } : {}),
        onState,
        onSentenceStart: (index, segment) => {
          highlightSegment(segment);
          followSegment(reader, segment);
        },
        onSentenceEnd: () => clearSegmentHighlight(),
        onEnded: () => stopReadAloudUI(state),
      });
      raController.play(segments as ReadAloudSegment[]);
      onState();
    })();
  } else {
    const handle = getActiveSession()?.handle;
    if (!handle) {
      raSource = null;
      return;
    }
    try {
      const all = handle.translatedReadSegments();
      if (all.length === 0) {
        state.setStatus(getString("readaloud-no-content"));
        raSource = null;
        return;
      }
      const ref = handle.currentRefPath();
      const at = ref ? all.findIndex((s) => s.meta?.refPath === ref) : -1;
      const segments = at > 0 ? all.slice(at) : all;
      state.setStatus("");
      raController = new ReadAloudController({
        getWin: () =>
          (globalThis as any).Zotero?.getMainWindow?.() ?? state.doc.defaultView,
        rate,
        ...(voicePref ? { voiceName: voicePref } : {}),
        ...(lang ? { lang: lang.split("-")[0] } : {}),
        onState,
        onSentenceStart: (index, segment) => {
          const meta = segment.meta as { refPath: string; sentenceIndex: number };
          handle.highlightTranslatedSentence(meta.refPath, meta.sentenceIndex);
        },
        onSentenceEnd: (index, segment) => {
          const meta = segment.meta as { refPath: string; sentenceIndex: number };
          handle.highlightTranslatedSentence(meta.refPath, -1);
        },
        onEnded: () => stopReadAloudUI(state),
      });
      raController.play(segments as ReadAloudSegment[]);
      onState();
    } catch (e) {
      raSource = null;
      state.setStatus(getString("readaloud-start-failed", { error: toErrorMessage(e) }));
    }
  }
}

// ── reader toolbar button ───────────────────────────────────────────────────

const TOOLBAR_BUTTON_CLASS = "ztransplit-bc-toolbar";
const TOOLBAR_STYLE_ID = "ztransplit-bc-toolbar-style";

const TOOLBAR_CSS = `
.${TOOLBAR_BUTTON_CLASS} {
  width: 20px; height: 20px; padding: 2px; cursor: pointer;
  color: var(--zotero-text-color, inherit);
}
.${TOOLBAR_BUTTON_CLASS}:hover { background: rgba(127,127,127,0.2); }
.${TOOLBAR_BUTTON_CLASS}:focus-visible {
  outline: 2px solid var(--color-focus-border, #4072e5); outline-offset: -2px;
}
.${TOOLBAR_BUTTON_CLASS} svg { width: 16px; height: 16px; display: block; }
`;

function buildReaderToolbarButton(doc: Document): HTMLElement {
  const head = doc.head ?? doc.documentElement;
  if (head && !doc.getElementById(TOOLBAR_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = TOOLBAR_STYLE_ID;
    style.textContent = TOOLBAR_CSS;
    head.appendChild(style);
  }

  const button = doc.createElement("div");
  button.className = TOOLBAR_BUTTON_CLASS;
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("title", getString("bilingual-toolbar-tooltip"));
  button.setAttribute("aria-label", getString("bilingual-toolbar-tooltip"));
  button.innerHTML = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M3 5h14"/>',
    '<path d="M3 10h14"/>',
    '<path d="M7 13l-3 2 3 2"/>',
    '<path d="M13 13l3 2-3 2"/>',
    "</g></svg>",
  ].join("");

  const toggle = () => {
    const win =
      (globalThis as any)?.Zotero?.getMainWindow?.() ??
      (doc.defaultView as any)?.Zotero?.getMainWindow?.();
    const Zotero = win?.Zotero ?? (globalThis as any).Zotero;
    const Reader = Zotero?.Reader;
    const Zotero_Tabs = win?.Zotero_Tabs ?? Zotero?.Tabs;
    const tabID = Zotero_Tabs?.selectedID;
    const reader = Reader?.getByTabID?.(tabID);
    const itemID = reader?.itemID;

    if (getActiveSession() && itemID === getActiveSession()?.itemID) {
      stopReadAloudUI();
      void stopBilingualSession();
    } else if (reader) {
      const lang =
        (getPrefDynamic("translate.targetLanguage") as string | undefined) ??
        "zh-CN";
      let cacheIdentity: string | undefined;
      try {
        cacheIdentity = engineCacheIdentity();
      } catch {
        cacheIdentity = undefined;
      }
      void startBilingualSession({
        reader,
        itemID: itemID ?? -1,
        mode: storedDefaultMode(),
        targetLanguage: lang,
        cacheIdentity,
      });
    }
  };
  button.addEventListener("click", toggle);
  button.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return button;
}

export function registerBilingualReaderToolbar(): void {
  const Reader = (globalThis as any)?.Zotero?.Reader;
  if (!Reader || typeof Reader.registerEventListener !== "function") return;
  const pluginID = addonID();

  readerToolbarHandler = (event: any) => {
    try {
      const { doc, append } = event;
      if (!doc || typeof append !== "function") return;
      // The bilingual session and read-aloud behind this button are PDF-only
      // (SDT reading mode + PDF text layer). Zotero fires renderToolbar on
      // every reader kind — EPUB and snapshot included — so the kind decides
      // whether the button exists at all rather than letting it error later.
      const kind = getReaderKind(event?.reader);
      if (kind !== "pdf") {
        safeDebug(
          "[Z-Transplit] bilingualControl: toolbar button skipped (reader kind: " +
            kind +
            ")",
        );
        return;
      }
      append(buildReaderToolbarButton(doc));
    } catch (e) {
      safeDebug("[Z-Transplit] bilingualControl: reader toolbar button build failed: " + e);
    }
  };
  Reader.registerEventListener("renderToolbar", readerToolbarHandler, pluginID);
}

export function unregisterBilingualReaderToolbar(): void {
  const Reader = (globalThis as any)?.Zotero?.Reader;
  if (!Reader || typeof Reader.unregisterEventListener !== "function") return;
  if (readerToolbarHandler) {
    try {
      Reader.unregisterEventListener("renderToolbar", readerToolbarHandler);
    } catch (e) {
      safeDebug("[Z-Transplit] bilingualControl: unregister toolbar failed: " + e);
    }
    readerToolbarHandler = null;
  }
}

function addonID(): string {
  try {
    const fromData = (globalThis as any)?.addon?.data?.config?.addonID;
    if (fromData) return fromData;
  } catch {
    /* no addon global (node) — fall through to the config import */
  }
  return (globalThis as any).addon?.data?.config?.addonID ?? "ztransplit@zotero.org";
}

// ── mount / destroy ─────────────────────────────────────────────────────────

export function mountBilingualControl(options: {
  doc: Document;
  body: HTMLElement;
  itemID?: number;
  /**
   * Reader kind of the item the block is mounted for. The bilingual session
   * and read-aloud are PDF-only (SDT reading mode + PDF text layer), so any
   * other kind mounts NOTHING and gets a no-op handle — a snapshot item keeps
   * the translate pane's selection translation without this block's dead
   * controls. Defaults to "pdf" for callers that have no kind at hand.
   */
  readerKind?: ReaderKind;
}): BilingualControlHandle {
  const { doc, body } = options;
  const kind = options.readerKind ?? "pdf";
  const existing = mounted.get(body);
  if (existing) return existing;
  if (kind !== "pdf") {
    // Fail closed and loudly-in-the-log: a bilingual block on a non-PDF reader
    // could only ever error when used. The no-op is NOT remembered in
    // `mounted`, so a body that later renders a PDF item still gets a real
    // block (in production a body never changes kind — readers are bound to
    // one attachment per tab — this only keeps the map honest).
    safeDebug(
      "[Z-Transplit] bilingualControl: block not mounted (reader kind: " +
        kind +
        ")",
    );
    return { destroy() {} };
  }

  const styleEl = ensureStyle(doc, body);

  const root = el(doc, "div", `${CLS}-root`);

  const divider = el(doc, "div", `${CLS}-divider`);
  root.appendChild(divider);

  const title = el(doc, "div", `${CLS}-title`);
  title.textContent = getString("bilingual-section-title");
  root.appendChild(title);

  const controlsBox = el(doc, "div", `${CLS}-bar`);
  const toggle = el(doc, "button", `${CLS}-toggle`) as HTMLButtonElement;
  toggle.type = "button";
  // 文案固定（不随会话状态切换），开启与否由 aria-pressed + data-active 表达；
  // 品牌红仅用于按压（会话激活）态。
  toggle.textContent = getString("bilingual-enable");
  toggle.dataset.active = "false";
  toggle.setAttribute("aria-pressed", "false");
  toggle.title = getString("bilingual-toolbar-tooltip");

  let modeButtons: ControlState["modeButtons"] = null;
  const progressLabel = el(doc, "span", `${CLS}-progress`);
  const status = el(doc, "span", `${CLS}-status`);

  const state: ControlState = {
    doc,
    toggle,
    modeButtons: null,
    progressLabel,
    status,
    controlsBox,
    readAloudBox: null,
    readAloudButtons: null,
    setStatus(msg) {
      status.textContent = msg;
    },
    setProgress(msg) {
      progressLabel.textContent = msg;
    },
    setActive(activeNow) {
      toggle.dataset.active = String(activeNow);
      toggle.setAttribute("aria-pressed", String(activeNow));
      // When no session is active, clear the mode highlight so the bar does not
      // imply a mode is selected; the buttons remain clickable and each click
      // starts a session directly in that mode.
      if (!activeNow && modeButtons) {
        modeButtons.interleave.dataset.active = "false";
        modeButtons.transOnly.dataset.active = "false";
      }
      state.refreshReadAloudButtons();
      if (activeNow) {
        state.setStatus("");
      } else {
        state.setProgress("");
        state.setStatus("");
      }
    },
    setMode(mode) {
      if (!modeButtons) return;
      modeButtons.interleave.dataset.active = String(mode === "interleave");
      modeButtons.transOnly.dataset.active = String(mode === "transOnly");
    },
    setReadAloudPlaying(playing) {
      const b = state.readAloudButtons;
      if (!b) return;
      b.pause.textContent = getString(
        raController?.getState().paused ? "readaloud-resume" : "readaloud-pause",
      );
      b.pause.hidden = !playing;
      b.prev.hidden = !playing;
      b.next.hidden = !playing;
      b.stop.hidden = !playing;
      state.refreshReadAloudButtons();
    },
    refreshReadAloudButtons() {
      refreshTranslationButton();
    },
  };

  function sourceHasTranslation(): boolean {
    const session = getActiveSession();
    return !!session && session.handle.translatedReadSegments().length > 0;
  }

  function refreshTranslationButton(): void {
    const b = state.readAloudButtons;
    if (!b) return;
    b.translation.disabled = !getActiveSession() || !sourceHasTranslation();
  }

  let starting = false;
  const setStarting = (v: boolean): void => {
    starting = v;
    toggle.disabled = v;
    if (modeButtons) {
      modeButtons.interleave.disabled = v;
      modeButtons.transOnly.disabled = v;
    }
  };

  const beginSession = async (requestedMode?: "interleave" | "transOnly"): Promise<void> => {
    if (starting) return;
    setStarting(true);
    try {
      await startSession(state, options.itemID, requestedMode);
    } catch (e) {
      safeDebug("[Z-Transplit] bilingualControl toggle: " + e);
      state.setActive(false);
      state.setStatus(getString("bilingual-sdt-unpack-failed", {
        error: toErrorMessage(e),
      }));
    } finally {
      setStarting(false);
    }
  };

  toggle.addEventListener("click", () => {
    void (async () => {
      if (getActiveSession()) {
        await stopSession(state);
        return;
      }
      await beginSession();
    })();
  });

  controlsBox.appendChild(toggle);

  const segmented = el(doc, "span", `${CLS}-segmented`);

  const mkModeBtn = (mode: "interleave" | "transOnly", key: string, iconMarkup: string): HTMLButtonElement => {
    const b = el(doc, "button", `${CLS}-mode-btn`) as HTMLButtonElement;
    b.type = "button";
    b.textContent = getString(key);
    b.dataset.mode = mode;
    const icon = svg(doc, iconMarkup);
    if (icon) {
      icon.setAttribute("aria-hidden", "true");
      b.insertBefore(icon, b.firstChild);
    }
    b.addEventListener("click", () => {
      if (getActiveSession()) {
        try {
          getActiveSession()!.handle.setMode(mode);
          const actual = getActiveSession()!.handle.getMode();
          state.setMode(actual);
          setPref("reader.bilingual.defaultMode", actual);
        } catch (e) {
          safeDebug("[Z-Transplit] bilingualControl setMode: " + e);
        }
        return;
      }
      void beginSession(mode);
    });
    return b;
  };

  const interleaveBtn = mkModeBtn(
    "interleave",
    "bilingual-mode-interleave",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 5h14"/><path d="M3 10h14"/>' +
    '<path d="M10 7v6"/><path d="M7 10l-3 2 3 2"/>' +
    '<path d="M13 10l3 2-3 2"/>' +
    "</g></svg>",
  );
  const transOnlyBtn = mkModeBtn(
    "transOnly",
    "bilingual-mode-trans-only",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 5h14"/>' +
    '<path d="M10 7v8"/>' +
    '<path d="M7 15l3 2 3-2"/>' +
    "</g></svg>",
  );
  segmented.appendChild(interleaveBtn);
  segmented.appendChild(transOnlyBtn);
  modeButtons = { interleave: interleaveBtn, transOnly: transOnlyBtn };
  state.modeButtons = modeButtons;

  controlsBox.appendChild(segmented);
  controlsBox.appendChild(progressLabel);

  let readAloudButtons: ControlState["readAloudButtons"] = null;
  try {
    const raBox = el(doc, "div", `${CLS}-ra-box`);
    const mkBtn = (key: string): HTMLButtonElement => {
      const b = el(doc, "button", `${CLS}-ra-btn`) as HTMLButtonElement;
      b.type = "button";
      b.textContent = getString(key);
      return b;
    };
    const originalBtn = mkBtn("readaloud-original");
    const translationBtn = mkBtn("readaloud-translation");
    const pauseBtn = mkBtn("readaloud-pause");
    const prevBtn = mkBtn("readaloud-prev");
    const nextBtn = mkBtn("readaloud-next");
    const stopBtn = mkBtn("readaloud-stop");
    pauseBtn.hidden = true;
    prevBtn.hidden = true;
    nextBtn.hidden = true;
    stopBtn.hidden = true;
    translationBtn.disabled = true;

    originalBtn.addEventListener("click", () =>
      startReadAloud(state, "original", options.itemID),
    );
    translationBtn.addEventListener("click", () =>
      startReadAloud(state, "translation", options.itemID),
    );
    pauseBtn.addEventListener("click", () => {
      if (!raController) return;
      if (raController.getState().paused) raController.resume();
      else raController.pause();
      state.setReadAloudPlaying(true);
    });
    prevBtn.addEventListener("click", () => raController?.prev());
    nextBtn.addEventListener("click", () => raController?.next());
    stopBtn.addEventListener("click", () => stopReadAloudUI(state));

    raBox.appendChild(originalBtn);
    raBox.appendChild(translationBtn);
    raBox.appendChild(pauseBtn);
    raBox.appendChild(prevBtn);
    raBox.appendChild(nextBtn);
    raBox.appendChild(stopBtn);

    readAloudButtons = { original: originalBtn, translation: translationBtn, pause: pauseBtn, prev: prevBtn, next: nextBtn, stop: stopBtn };
    state.readAloudBox = raBox;
    state.readAloudButtons = readAloudButtons;
    root.appendChild(raBox);
  } catch (e) {
    safeDebug("[Z-Transplit] bilingualControl read-aloud row: " + e);
  }

  root.appendChild(controlsBox);
  root.appendChild(status);
  body.appendChild(root);

  const unsubscribe = onSessionChange(() => {
    const session = getActiveSession();
    if (session) {
      state.setActive(true);
      state.setMode(session.handle.getMode());
    } else {
      state.setActive(false);
    }
    state.refreshReadAloudButtons();
  });

  const handle: BilingualControlHandle = {
    destroy() {
      mounted.delete(body);
      unsubscribe();
      stopReadAloudUI(state);
      void stopBilingualSession();
      try {
        root.remove();
      } catch {
        /* body may already be gone */
      }
      try {
        styleEl.remove();
      } catch {
        /* idempotent */
      }
    },
  };
  mounted.set(body, handle);
  return handle;
}

/** Exit a live session without touching any pane DOM (shutdown hook). */
export async function disposeActiveBilingualSession(): Promise<void> {
  stopReadAloudUI();
  await stopBilingualSession();
}
