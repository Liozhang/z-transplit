/**
 * bilingualControl — the bilingual reading control block inside the reader
 * translate pane section.
 *
 * Renders a compact bar above the translate pane root: a bilingual toggle,
 * a presentation-mode switch (interleaved / translation-only), progress and
 * a status line. On hosts without the Zotero 10 SDT reading mode it renders
 * a capability disclosure instead of the controls.
 *
 * One live bilingual session per process: starting a session for another item
 * exits the previous one. The session (reading-mode overlay + injected
 * translation blocks) is disposed on pane destroy and on tab close — the
 * pane body is per-item, so destroy() is the natural cleanup hook.
 *
 * @module ui/bilingualControl
 */

import { safeDebug } from "../utils/logger";
import { toErrorMessage } from "../utils/error";
import { getString } from "../utils/locale";
import { getPref, getPrefDynamic } from "../utils/prefs";
import { createAbortController } from "../utils/abort";
import { resolveCurrentReader } from "./translatePane";
import { probeReaderCapabilities } from "../core/capabilities";
import {
  enterBilingualSession,
  exitBilingualSession,
  type BilingualSession,
} from "../core/pdf/sdt/sdtBridge";
import {
  buildInterleave,
  type BilingualMode,
  type InterleaveHandle,
} from "../core/pdf/sdt/interleaveView";
import {
  createAIBatchTranslator,
  createTranslator,
  engineCacheIdentity,
  supportsBatching,
} from "../core/translation/translationEngines";
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

const CLS = "ztransplit-bc";

interface SessionState {
  itemID: number;
  session: BilingualSession;
  handle: InterleaveHandle;
  abort: AbortController;
}

/** The one live session (module scope: the reading-mode overlay is per tab). */
let active: SessionState | null = null;

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

function el(doc: Document, tag: string, cls?: string): HTMLElement {
  const e = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  if (cls) e.className = cls;
  return e;
}

function ensureStyle(doc: Document, body: HTMLElement): HTMLStyleElement {
  // Mounted on the pane body (translatePane's pattern) instead of the chrome
  // document: it leaves with the pane, and destroy() removes it explicitly.
  // One style per body — mountBilingualControl is idempotent per body, so no
  // doc-wide id guard is needed (nor correct with several panes per document).
  const style = el(doc, "style");
  style.className = `${CLS}-style`;
  style.textContent = `
.${CLS}-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin: 2px 0 8px 0; padding: 6px 8px;
  border: var(--material-border-quinary, 1px solid rgba(127,127,127,0.25));
  border-radius: 5px;
  background: var(--material-background, transparent);
}
.${CLS}-ra-btn, .${CLS}-toggle {
  font: inherit; cursor: pointer; padding: 2px 10px;
  border: 1px solid var(--material-border-quinary, rgba(127,127,127,0.35));
  border-radius: 4px; background: var(--material-background, transparent);
  color: var(--zotero-text-color, inherit);
}
.${CLS}-toggle[data-active="true"] {
  background: var(--accent-blue, #4072e5); color: #fff;
  border-color: var(--accent-blue, #4072e5);
}
.${CLS}-mode {
  font: inherit; padding: 1px 4px; max-width: 10em;
  color: var(--zotero-text-color, inherit);
  background: var(--material-background, transparent);
}
.${CLS}-progress { font-size: 0.88em; color: var(--zotero-text-color-secondary, GrayText); }
.${CLS}-status { width: 100%; font-size: 0.88em; color: var(--zotero-text-color-secondary, GrayText); }
.${CLS}-disclosure {
  margin: 2px 0 8px 0; padding: 6px 8px; font-size: 0.88em;
  border-inline-start: 3px solid var(--accent-gold, #cc9200);
  color: var(--zotero-text-color-secondary, GrayText);
}
`;
  body.appendChild(style);
  return style as HTMLStyleElement;
}

async function makeBatchTranslator(
  targetLanguage: string,
): Promise<(texts: string[], signal?: AbortSignal) => Promise<{ translations: string[]; failedIndices: number[] }>> {
  if (supportsBatching()) {
    const handle = await createAIBatchTranslator(targetLanguage);
    return (texts, signal) => handle.translate(texts, signal);
  }
  // Non-batching engines: sequential per-paragraph calls behind the same
  // contract. The queue's own concurrency (2) bounds parallelism.
  const translator = createTranslator(targetLanguage);
  return async (texts, signal) => {
    const translations: string[] = [];
    const failedIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (signal?.aborted) break;
      try {
        translations.push(await translator(texts[i], targetLanguage));
      } catch {
        translations.push(texts[i]);
        failedIndices.push(i);
      }
    }
    return { translations, failedIndices };
  };
}

async function startSession(
  state: ControlState,
  itemID?: number,
): Promise<void> {
  safeDebug("[Z-Transplit] bilingualControl: startSession itemID=" + itemID);
  let reader = resolveCurrentReader(state.doc, itemID);
  // Reader↔tab association can lag the click (seen once in the 7.0.15 E2E:
  // a reader was open but resolution returned null for ~a second, and the
  // panel told the user to open a PDF that was already open). Retry briefly
  // before disclosing a failure.
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

  state.setStatus(getString("bilingual-sdt-loading"));
  const session = await enterBilingualSession(reader);
  safeDebug("[Z-Transplit] bilingualControl: session=" + !!session);
  if (!session) {
    // Null ≠ "unpack failed": the SDT session simply could not be established.
    state.setStatus(getString("bilingual-sdt-missing"));
    return;
  }

  // Everything after the reading-mode enter must roll the mode back on
  // failure — a half-built session would strand the reader in reading mode
  // with the toggle showing "off", and the next click would enter all over
  // again instead of restarting cleanly.
  try {
    // A session started while another was live (item switched) — dispose it.
    if (active) await stopSession(state);

    const abort = createAbortController();
    const targetLanguage = targetLanguageFor();
    const batchTranslate = await makeBatchTranslator(targetLanguage);

    let cacheIdentity: string | undefined;
    try {
      cacheIdentity = engineCacheIdentity();
    } catch {
      cacheIdentity = undefined;
    }

    const defaultMode = (getPref("reader.bilingual.defaultMode") as string) || "interleave";
    const handle = await buildInterleave(session, {
      targetLanguage,
      cacheIdentity,
      batchTranslate,
      signal: abort.signal,
      onProgress: (stats) => {
        state.setProgress(getString("bilingual-progress", {
          done: stats.done,
          total: stats.total,
        }));
        // Translations arriving is what unlocks 朗读译文 — nothing else runs
        // between queue ticks (found in the 10.0.3 E2E: the button stayed
        // disabled forever, so clicks on it never fired).
        state.refreshReadAloudButtons();
      },
    });
    if (defaultMode === "transOnly") handle.setMode("transOnly");
    // Sync the dropdown with the ACTUAL mode — the program never writes it
    // anywhere else, so a default of transOnly would otherwise show a stale
    // selection (the dropdown's own change listener is the only other writer).
    if (state.modeSelect) state.modeSelect.value = handle.getMode();

    active = { itemID: itemID ?? -1, session, handle, abort };
    state.setActive(true);
  } catch (e) {
    // exitBilingualSession swallows its own errors — best-effort rollback.
    await exitBilingualSession(session);
    throw e;
  }
}

async function stopSession(state?: ControlState): Promise<void> {
  const session = active;
  active = null;
  // Leaving / switching a session must also stop playback — the voice would
  // otherwise keep reading a session that no longer exists (and, for the
  // original source, keep playing with the controls already gone).
  stopReadAloudUI(state);
  if (!session) return;
  try {
    session.abort.abort();
  } catch {
    /* ignore */
  }
  try {
    await session.handle.dispose();
  } catch (e) {
    safeDebug("[Z-Transplit] bilingualControl stop: " + e);
    await exitBilingualSession(session.session);
  }
}

// ── read-aloud wiring ───────────────────────────────────────────────────────

function stopReadAloudUI(state?: ControlState): void {
  // Bump first: any in-flight start bails on its next await tick. Re-entrant
  // (controller.stop() fires onEnded → back here) — by then every handle is
  // already cleared, so the nested call is a no-op.
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
  // One audible flow at a time — raSource is set for the whole flow, including
  // the async build window before raController exists (a long PDF builds
  // segments for seconds). Same source again = stop; different = switch.
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
  if (source === "translation" && !active) return;

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
      // Superseded while building (stop, source switch, session teardown).
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
    const handle = active?.handle;
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
      // Start at the topmost visible block (currentRefPath's documented
      // purpose) instead of always from the document head.
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

interface ControlState {
  doc: Document;
  toggle: HTMLButtonElement;
  modeSelect: HTMLSelectElement | null;
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
  setReadAloudPlaying(playing: boolean): void;
  /** Re-evaluate the 朗读译文 enabled state (session live + text ready). */
  refreshReadAloudButtons(): void;
}

export interface BilingualControlHandle {
  destroy(): void;
}

/**
 * Mount the bilingual control block into a section body (idempotent per body).
 * Callers (registerTranslateUI.onRender) invoke this next to mountTranslatePane.
 */
export function mountBilingualControl(options: {
  doc: Document;
  body: HTMLElement;
  itemID?: number;
}): BilingualControlHandle {
  const { doc, body } = options;
  const existing = mounted.get(body);
  if (existing) return existing;

  const styleEl = ensureStyle(doc, body);

  const root = el(doc, "div", `${CLS}-root`);

  const controlsBox = el(doc, "div", `${CLS}-bar`);
  const toggle = el(doc, "button", `${CLS}-toggle ${CLS}-main`) as HTMLButtonElement;
  toggle.type = "button";
  toggle.textContent = getString("bilingual-enable");

  let modeSelect: HTMLSelectElement | null = null;
  const progressLabel = el(doc, "span", `${CLS}-progress`);
  const status = el(doc, "span", `${CLS}-status`);

  const state: ControlState = {
    doc,
    toggle,
    modeSelect: null,
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
      toggle.textContent = getString(
        activeNow ? "bilingual-exit" : "bilingual-enable",
      );
      if (modeSelect) {
        modeSelect.disabled = !activeNow;
        // Leaving a session resets the dropdown so no mode leaks into the
        // next one (startSession writes the actual mode right after).
        if (!activeNow) modeSelect.value = "interleave";
      }
      state.refreshReadAloudButtons();
      if (activeNow) {
        // Entering: drop the "preparing structure" loading notice — progress
        // now comes from the queue's onProgress.
        state.setStatus("");
      } else {
        state.setProgress("");
        state.setStatus("");
      }
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
    return !!active && active.handle.translatedReadSegments().length > 0;
  }

  /** 朗读译文 is enabled only while a session has translated text ready. */
  function refreshTranslationButton(): void {
    const b = state.readAloudButtons;
    if (!b) return;
    b.translation.disabled = !active || !sourceHasTranslation();
  }

  toggle.addEventListener("click", () => {
    void (async () => {
      try {
        if (active) {
          await stopSession(state);
          state.setActive(false);
          return;
        }
        toggle.disabled = true;
        try {
          await startSession(state, options.itemID);
        } finally {
          toggle.disabled = false;
        }
      } catch (e) {
        safeDebug("[Z-Transplit] bilingualControl toggle: " + e);
        // setActive first — it clears the status line, and the error must be
        // the thing the user ends up reading.
        state.setActive(false);
        state.setStatus(getString("bilingual-sdt-unpack-failed", {
          error: toErrorMessage(e),
        }));
      }
    })();
  });

  controlsBox.appendChild(toggle);

  // Mode selector (shown while active; populated from the same three states
  // the view supports minus "off", which is the toggle itself).
  const selectWrap = el(doc, "select", `${CLS}-mode`) as HTMLSelectElement;
  const mkOption = (value: string, key: string): void => {
    const opt = doc.createElement("option");
    opt.value = value;
    opt.textContent = getString(key);
    selectWrap.appendChild(opt);
  };
  mkOption("interleave", "bilingual-mode-interleave");
  mkOption("transOnly", "bilingual-mode-trans-only");
  selectWrap.disabled = true;
  selectWrap.addEventListener("change", () => {
    if (!active) return;
    active.handle.setMode(selectWrap.value as BilingualMode);
  });
  modeSelect = selectWrap;
  state.modeSelect = selectWrap;
  controlsBox.appendChild(selectWrap);
  controlsBox.appendChild(progressLabel);

  // ── read-aloud row ──────────────────────────────────────────────────────
  let readAloudButtons: ControlState["readAloudButtons"] = null;
  try {
    const raBox = el(doc, "div", `${CLS}-bar`);
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

  const handle: BilingualControlHandle = {
    destroy() {
      mounted.delete(body);
      // Stop playback and tear the session down even when this pane did not
      // start them — the module state is process-wide, and once the buttons
      // are gone nothing could stop a still-playing voice. The UI update in
      // stopReadAloudUI may already target detached buttons — harmless.
      void stopSession(state);
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
  await stopSession();
}
