/**
 * sdt/interleaveView — injects translation blocks into the SDT reading-mode
 * view and switches between its three presentation states.
 *
 * Injection model: for every translatable original block, a sibling
 * `<div class="ztransplit-bi">` is inserted directly after it (original on
 * top, translation below). The originals are NEVER mutated — our blocks are
 * pure siblings, so exit = remove our nodes and nothing else changes. The
 * three states are pure CSS on the container root:
 *
 *   ztransplit-bi-mode-interleave  original + translation both visible
 *   ztransplit-bi-mode-trans-only  originals hidden (translations remain)
 *   (mode-off removes everything — handled by exitInterleave)
 *
 * Styling is mode-aware by design: salience follows the translation's ROLE.
 * The baseline in ensureStyle is structural only; the interleave layer mutes
 * the translation (opacity, smaller size, a neutral hairline anchor, hover
 * restores full ink) because there the original leads and the translation
 * follows. The trans-only layer is the plain baseline — there the translation
 * IS the body text and reads at full ink. Transient states (placeholder,
 * error, read-aloud highlight) keep their own colors in both modes.
 *
 * In trans-only mode a click on a translation block temporarily reveals its
 * original paragraph (data-peek on the original + the CSS overrides in
 * ensureStyle); the peek moves with the next block click and is cleared on
 * mode switches and on dispose.
 *
 * In interleave mode a click on a translation block toggles that paragraph's
 * translation visibility (data-hidden on OUR block): collapsed to a thin bar
 * so the original can be practiced, click the bar to restore. The state only
 * exists in interleave mode — a mode switch to trans-only restores every
 * block, because a hidden block there would blank the paragraph entirely
 * (originals are hidden by the mode itself).
 *
 * Translation supply is the LazyTranslateQueue; the persistent translation
 * cache (translationCache.ts) sits between the queue and the engine.
 *
 * Manual translation (issue #3): selecting text anywhere in the reading view
 * shows a small pill centered below the selection; clicking it translates —
 * or, for an already translated block, retranslates with the cache bypassed —
 * the block the selection sits in. Blocks the session inventory missed
 * (progressive rendering) or skipped on purpose (lists, tables) get their
 * translation slot injected on the spot; reference sections stay excluded,
 * exactly like automatic translation.
 *
 * @module core/pdf/sdt/interleaveView
 */

import { safeDebug } from "../../../utils/logger";
import { getPrefDynamic } from "../../../utils/prefs";
import { getString } from "../../../utils/locale";
import type { BilingualSession, SdtBlock } from "./sdtBridge";
import {
  LazyTranslateQueue,
  type QueueStats,
} from "./lazyQueue";
import {
  cacheAvailable,
  cacheKey,
  getCachedTranslations,
  putCachedTranslation,
} from "../../translation/translationCache";
import type { BatchTranslator } from "../../translation/types";
import { splitSentences } from "../../readAloud/sentenceSplitter";

export type BilingualMode = "interleave" | "transOnly";

/** One read-aloud unit of the translated text. */
export interface TranslatedReadSegment {
  text: string;
  /** Matches ReadAloudSegment.meta — echoed back to highlight hooks. */
  meta: { refPath: string; sentenceIndex: number };
}

export interface InterleaveHandle {
  setMode(mode: BilingualMode): void;
  getMode(): BilingualMode;
  stats(): QueueStats;
  retry(refPath: string): void;
  /** Approximate reading position (topmost visible block), for read-aloud. */
  currentRefPath(): string | null;
  /** Translated text of a block ("" when not yet translated). */
  translationOf(refPath: string): string;
  /** Read-aloud segments over the TRANSLATED text (blocks in document order). */
  translatedReadSegments(): TranslatedReadSegment[];
  /**
   * Highlight sentence `sentenceIndex` of a translated block (-1 clears).
   * Rebuilds OUR block's content — the originals are never touched.
   */
  highlightTranslatedSentence(refPath: string, sentenceIndex: number): void;
  dispose(): Promise<void>;
}

export interface InterleaveOptions {
  targetLanguage: string;
  cacheIdentity?: string;
  batchTranslate: BatchTranslator;
  signal?: AbortSignal;
  onProgress?: (stats: QueueStats) => void;
}

const BI_CLASS = "ztransplit-bi";
const MODE_CLASSES = {
  interleave: "ztransplit-bi-mode-interleave",
  transOnly: "ztransplit-bi-mode-trans-only",
};

/** Inject the <style> rules into the SDT document (once per session). */
function ensureStyle(doc: Document): void {
  if (doc.getElementById("ztransplit-bi-style")) return;
  const style = doc.createElement("style");
  style.id = "ztransplit-bi-style";
  style.textContent = `
/* Two-layer styling. The baseline is structural only and serves BOTH modes;
 * each mode layer decides how loud the translation is. Interleave: the
 * original leads, so the translation follows in muted ink (opacity), one
 * size smaller, with a neutral hairline as a scanning anchor — hovering
 * restores full ink, so salience follows attention. Trans-only: the
 * translation IS the body text (originals are hidden), so it reads at full
 * ink and inherited size with no decoration. */
.${BI_CLASS} {
  margin: 0.25em 0 1em 0;
  padding: 0;
  font-size: 1em;
  line-height: 1.75;
  color: var(--ztransplit-bi-text, inherit);
  white-space: pre-wrap;
  min-height: 1.2em;
}
.${BI_CLASS} .ztransplit-bi-placeholder {
  opacity: 0.55;
  animation: ztransplit-bi-pulse 1.4s ease-in-out infinite;
}
.${BI_CLASS} .ztransplit-bi-error {
  color: var(--ztransplit-bi-error, #b3261e);
}
.${BI_CLASS} .ztransplit-bi-retry {
  margin-inline-start: 0.6em;
  cursor: pointer;
  text-decoration: underline;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  padding: 0;
}
.${BI_CLASS} .ztransplit-sent {
  border-radius: 2px;
}
.${BI_CLASS} .ztransplit-sent-active {
  background: rgba(245, 158, 11, 0.34);
}
@keyframes ztransplit-bi-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 0.25; }
}
/* Translation-only mode: hide the originals, keep ours. The injected blocks
 * carry data-ref-path too, so the hider must exclude them explicitly —
 * with equal !important the hider's higher specificity would otherwise win
 * and leave a BLANK page (found in the README screenshot round: trans-only
 * rendered nothing at all). */
#sdt-content.ztransplit-bi-mode-trans-only > [data-ref-path]:not(.${BI_CLASS}) {
  display: none !important;
}
.ztransplit-bi-mode-trans-only .${BI_CLASS} {
  display: block !important;
}
/* Translation-only peek: clicking a translation block reveals the original
 * paragraph right above it until the next click or mode switch. The
 * [data-peek] attribute adds one attribute-selector beat over the hider, so
 * with both rules !important the peek wins. data-peek is a transient view
 * state on official elements — cleared on every mode switch, on dispose, and
 * never written to anything but the display. */
#sdt-content.ztransplit-bi-mode-trans-only > [data-ref-path]:not(.${BI_CLASS})[data-peek] {
  display: block !important;
}
#sdt-content.ztransplit-bi-mode-trans-only > [data-ref-path][data-peek] {
  background: var(--ztransplit-bi-bg, rgba(31, 158, 141, 0.08));
  border-inline-start: 3px solid var(--ztransplit-accent, #1f9e8d);
  border-radius: 4px;
}
.ztransplit-bi-mode-trans-only .${BI_CLASS} {
  cursor: pointer;
}
/* Interleave mode layer: muted ink, one size smaller, a neutral hairline on
 * the leading edge as a scanning anchor (thin, gray, no area — felt only
 * while scrolling). Hover restores full ink plus a barely-there background:
 * quiet at rest, solid once attended. */
.ztransplit-bi-mode-interleave .${BI_CLASS} {
  padding-inline-start: 0.75em;
  border-inline-start: 2px solid rgba(127, 127, 127, 0.5);
  opacity: 0.74;
  font-size: 0.92em;
  cursor: pointer;
}
.ztransplit-bi-mode-interleave .${BI_CLASS}:hover {
  opacity: 1;
  background: rgba(127, 127, 127, 0.08);
}
/* Paragraph show/hide (interleave mode): clicking a translation block
 * collapses it to a thin neutral bar — practice the original, click the bar
 * to restore. Children stay in the DOM (read-aloud highlighting rebuilds
 * content) and are merely invisible; mode switches clear the state (in
 * trans-only a hidden block would blank the paragraph entirely). Declared
 * AFTER the interleave layer: equal specificity, so source order lets the
 * bar's own opacity win over the muted layer's. */
.${BI_CLASS}[data-hidden] {
  min-height: 0;
  height: 8px;
  padding: 0;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.45);
  opacity: 0.9;
  border-radius: 4px;
}
.${BI_CLASS}[data-hidden] > * {
  visibility: hidden;
}
/* Manual-translation trigger: a small pill centered below the active
 * selection. It lives in the SDT document body (outside #sdt-content) and is
 * positioned fixed — the selection rect is iframe-viewport-relative, fixed
 * matches. */
.ztransplit-bi-trigger {
  position: fixed;
  z-index: 9999;
  margin: 0;
  padding: 2px 12px;
  border: 1px solid var(--ztransplit-accent, #1f9e8d);
  border-radius: 12px;
  background: var(--ztransplit-accent, #1f9e8d);
  color: #fff;
  font: inherit;
  font-size: 0.8em;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
`;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/**
 * Build the interleave view inside a live bilingual session.
 *
 * Immediately injects placeholder blocks for every session block, starts the
 * lazy queue, and returns the handle used by the control UI to switch modes,
 * retry failures and read progress.
 */
export async function buildInterleave(
  session: BilingualSession,
  options: InterleaveOptions,
): Promise<InterleaveHandle> {
  const doc = session.doc;
  ensureStyle(doc);
  session.container.classList.add(MODE_CLASSES.interleave);

  const injected = new Map<string, HTMLElement>(); // refPath → our block
  const texts = new Map<string, string>();
  const translations = new Map<string, string>();
  /** Blocks adopted into the session after start (manual translation). */
  const manualBlocks: SdtBlock[] = [];

  const makeBlockEl = (block: Pick<SdtBlock, "refPath">): HTMLElement => {
    const el = doc.createElement("div");
    el.className = BI_CLASS;
    el.dataset.refPath = block.refPath;
    const ph = doc.createElement("span");
    ph.className = "ztransplit-bi-placeholder";
    ph.textContent = getString("bilingual-placeholder");
    el.appendChild(ph);
    return el;
  };

  for (const block of session.blocks) {
    const el = makeBlockEl(block);
    block.el.after(el);
    injected.set(block.refPath, el);
    texts.set(block.refPath, block.text);
  }
  safeDebug(
    "[Z-Transplit] interleaveView: injected " + injected.size +
      " blocks (session.blocks=" + session.blocks.length + ")",
  );

  // ── translation-only peek ───────────────────────────────────────────────
  // Click a translation block in 仅译文 mode → the original paragraph right
  // above it is temporarily revealed (data-peek + the CSS overrides above);
  // click the block again to dismiss, click another block to move the peek.
  // Interleave mode stays click-free so text selection and annotation
  // gestures behave natively there.
  const originals = new Map<string, HTMLElement>();
  for (const block of session.blocks) originals.set(block.refPath, block.el);
  let peeked: Element | null = null;
  const clearPeek = (): void => {
    if (!peeked) return;
    try {
      peeked.removeAttribute("data-peek");
    } catch {
      /* element already gone with the view */
    }
    peeked = null;
  };
  /**
   * Toggle one paragraph's translation between shown and collapsed (上下对照
   * mode). The bar keeps a hint title so the way back stays discoverable.
   * Pure display state on OUR block — mode switches and dispose remove it
   * with the rest of the view.
   */
  const toggleBlockHidden = (el: HTMLElement): void => {
    try {
      if (el.hasAttribute("data-hidden")) {
        el.removeAttribute("data-hidden");
        el.removeAttribute("title");
      } else {
        el.setAttribute("data-hidden", "");
        el.setAttribute("title", getString("bilingual-show-hint"));
      }
    } catch {
      /* display state only — a failure here must not break the click */
    }
  };
  const onContainerClick = (ev: Event): void => {
    const transOnly = session.container.classList.contains(MODE_CLASSES.transOnly);
    if (
      !transOnly &&
      !session.container.classList.contains(MODE_CLASSES.interleave)
    ) {
      return;
    }
    // A drag-selection that ends on the block still fires click — not a
    // toggle gesture (both modes). getSelection is reached through the
    // content realm's own window (the blocks live in the SDT iframe document).
    try {
      const sel = doc.defaultView?.getSelection?.() ?? null;
      if (sel && !sel.isCollapsed) return;
    } catch {
      /* no selection API — treat as a plain click */
    }
    // Duck-typed on purpose: the event target is a content-realm element, so
    // an `instanceof Element` against the chrome realm would always be false.
    const target = ev.target as {
      closest?: (selector: string) => Element | null;
    } | null;
    const bi = target?.closest?.("." + BI_CLASS);
    if (!bi || !session.container.contains(bi)) {
      // Click outside our blocks: a bare-container click dismisses the peek;
      // anything else (above all, the peeked original itself) is left alone
      // so selecting a word in the revealed paragraph does not dismiss it.
      if (transOnly && target === session.container) clearPeek();
      return;
    }
    // The block's retry button keeps its click for itself (both modes).
    if (target?.closest?.(".ztransplit-bi-retry")) return;
    if (!transOnly) {
      toggleBlockHidden(bi as HTMLElement);
      return;
    }
    const refPath = (bi as HTMLElement).dataset?.refPath;
    const original = refPath ? originals.get(refPath) : undefined;
    if (!original) {
      clearPeek();
      return;
    }
    if (peeked === original) {
      clearPeek();
      return;
    }
    clearPeek();
    peeked = original;
    try {
      original.setAttribute("data-peek", "");
      original.scrollIntoView?.({ block: "nearest" });
    } catch {
      /* display state only — a failure here must not break the click */
    }
  };
  session.container.addEventListener("click", onContainerClick);

  // ── manual translation trigger (issue #3) ───────────────────────────────
  // A non-collapsed selection shows a "translate this paragraph" pill near
  // the selection; clicking it translates — or retranslates (cache bypassed)
  // — the block the selection sits in. This is the only path content the
  // session inventory missed ever gets translated: blocks the SDT view
  // rendered late and containers (lists, tables) that collectBlocks skips
  // never received a slot otherwise. Reference sections stay excluded, same
  // as automatic translation.
  interface ManualTarget {
    refPath: string;
    original: HTMLElement;
    text: string;
  }

  const resolveSelectionTarget = (): ManualTarget | null => {
    try {
      const sel = doc.defaultView?.getSelection?.() ?? null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      // Resolve from the START of the selection: "translate this paragraph"
      // means the paragraph where it begins, even for multi-block selections.
      const start = range.startContainer;
      const startEl =
        start.nodeType === 3
          ? (start.parentElement as Element | null)
          : (start as Element);
      // Duck-typed closest: the node is a content-realm object and the
      // chrome-realm instanceof would lie (same reason as onContainerClick).
      const el = startEl?.closest?.("[data-ref-path]") as HTMLElement | null;
      if (!el || !session.container.contains(el)) return null;
      // The reference section is excluded from automatic translation on
      // purpose (collectBlocks): a stray selection in the bibliography must
      // not send the whole section's text to the engine either.
      if (el.classList?.contains("sdt-reference")) return null;
      const refPath = el.dataset?.refPath;
      if (!refPath) return null;
      // Blocks already in the session use their collected text; anything
      // else (containers, late renders) is read off the element now.
      const known = texts.has(refPath);
      const text = known
        ? (texts.get(refPath) as string)
        : (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return {
        refPath,
        original: originals.get(refPath) ?? el,
        text,
      };
    } catch {
      return null;
    }
  };

  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "ztransplit-bi-trigger";
  trigger.textContent = getString("bilingual-translate-selection");
  trigger.style.display = "none";
  (doc.body ?? doc.documentElement)?.appendChild(trigger);

  const positionTrigger = (target: ManualTarget | null): void => {
    if (!target) {
      trigger.style.display = "none";
      return;
    }
    trigger.style.display = "block";
    try {
      const view = doc.defaultView;
      const rect = view
        ?.getSelection?.()
        ?.getRangeAt(0)
        .getBoundingClientRect();
      if (rect) {
        // Center-bottom of the selection: horizontally centered on the
        // selection rect, hugging its bottom edge — where the eye already
        // is when the selection ends. offsetWidth forces layout after the
        // display flip above; jsdom (no layout) falls back to 120.
        const viewWidth = Number(view?.innerWidth) || 800;
        const width = trigger.offsetWidth || 120;
        const center = rect.left + (Number(rect.width) || 0) / 2;
        trigger.style.left =
          Math.max(8, Math.min(center - width / 2, viewWidth - width - 8)) +
          "px";
        trigger.style.top = Math.max(8, rect.bottom + 6) + "px";
      }
    } catch {
      /* no geometry — the pill lands at its last position */
    }
  };

  const onDocMouseUp = (): void => {
    positionTrigger(resolveSelectionTarget());
  };
  const onDocMouseDown = (ev: Event): void => {
    // Pressing the trigger itself must not dismiss it before its click.
    const t = ev.target as { closest?: (s: string) => Element | null } | null;
    if (t?.closest?.(".ztransplit-bi-trigger")) return;
    trigger.style.display = "none";
  };
  doc.addEventListener("mouseup", onDocMouseUp);
  doc.addEventListener("mousedown", onDocMouseDown);

  const ensureManualBlock = (target: ManualTarget): void => {
    if (injected.has(target.refPath)) return;
    const el = makeBlockEl(target);
    target.original.after(el);
    injected.set(target.refPath, el);
    texts.set(target.refPath, target.text);
    originals.set(target.refPath, target.original);
    manualBlocks.push({
      refPath: target.refPath,
      el: target.original,
      text: target.text,
    });
    queue.watch(target.refPath, { text: target.text, placeholder: el });
  };

  const onTriggerClick = (): void => {
    trigger.style.display = "none";
    const target = resolveSelectionTarget();
    if (!target) return;
    ensureManualBlock(target);
    // Done blocks retranslate with the cache bypassed (a plain re-run would
    // return the very translation the user asked to redo); failed blocks and
    // fresh blocks just run — force() covers both, retry() covers neither
    // for unknown refs.
    queue.force(target.refPath, {
      bypassCache: translations.has(target.refPath),
    });
    try {
      injected.get(target.refPath)?.scrollIntoView?.({ block: "nearest" });
    } catch {
      /* display state only — a failure here must not break the click */
    }
  };
  trigger.addEventListener("click", onTriggerClick);

  // ── cache hooks ────────────────────────────────────────────────────────
  const cacheOn = !!options.cacheIdentity && cacheAvailable();
  const lookup = cacheOn
    ? async (list: string[]): Promise<Map<string, string>> => {
        const keys = await Promise.all(
          list.map((t) =>
            cacheKey(options.cacheIdentity as string, "auto", options.targetLanguage, t),
          ),
        );
        const cached = await getCachedTranslations(keys);
        const out = new Map<string, string>();
        list.forEach((text, i) => {
          const key = keys[i];
          const hit = key ? cached.get(key) : undefined;
          if (hit !== undefined) out.set(text, hit);
        });
        return out;
      }
    : undefined;
  const store = cacheOn
    ? (text: string, translated: string): void => {
        void putCachedTranslation(
          options.cacheIdentity as string,
          "auto",
          options.targetLanguage,
          text,
          translated,
        );
      }
    : undefined;

  // ── rendering callbacks ────────────────────────────────────────────────
  const renderDone = (refPath: string, translated: string): void => {
    translations.set(refPath, translated);
    const el = injected.get(refPath);
    if (!el) return;
    el.textContent = translated;
  };
  const renderError = (refPath: string): void => {
    const el = injected.get(refPath);
    if (!el) return;
    el.textContent = "";
    const span = doc.createElement("span");
    span.className = "ztransplit-bi-error";
    span.textContent = getString("bilingual-block-failed");
    const retry = doc.createElement("button");
    retry.className = "ztransplit-bi-retry";
    retry.type = "button";
    retry.textContent = getString("bilingual-retry");
    retry.addEventListener("click", () => queue.retry(refPath));
    el.appendChild(span);
    el.appendChild(retry);
  };
  const renderLoading = (refPath: string): void => {
    const el = injected.get(refPath);
    if (!el) return;
    if (el.querySelector(".ztransplit-bi-placeholder")) return;
    el.textContent = "";
    const ph = doc.createElement("span");
    ph.className = "ztransplit-bi-placeholder";
    ph.textContent = getString("bilingual-placeholder");
    el.appendChild(ph);
  };

  const concurrency = Math.max(
    1,
    Number(getPrefDynamic("reader.bilingual.concurrency")) || 2,
  );

  const queue = new LazyTranslateQueue(
    doc,
    new Map(
      Array.from(injected.entries()).map(([refPath, placeholder]) => {
        const block = session.blocks.find((b) => b.refPath === refPath) as SdtBlock;
        return [refPath, { text: block.text, placeholder }];
      }),
    ),
    {
      translateBatch: async (list, signal) => {
        const result = await options.batchTranslate(list, signal);
        return {
          translations: result.translations,
          failedIndices: result.failedIndices,
        };
      },
      lookup,
      store,
      onLoading: renderLoading,
      onDone: renderDone,
      onFailed: renderError,
      onProgress: (stats) => options.onProgress?.(stats),
    },
    {
      concurrency,
      signal: options.signal,
      // The poll timer MUST live on a chrome window — a chrome closure
      // registered on the SDT iframe's content window crashes xul.dll within
      // about a minute (see lazyQueue timerWindow). Node/tests have no Zotero
      // global and fall back to the content view or the no-timer path.
      timerWindow: (globalThis as any).Zotero?.getMainWindow?.() ?? null,
    },
  );
  queue.start();

  return {
    setMode(mode: BilingualMode) {
      session.container.classList.remove(MODE_CLASSES.interleave, MODE_CLASSES.transOnly);
      session.container.classList.add(
        mode === "transOnly" ? MODE_CLASSES.transOnly : MODE_CLASSES.interleave,
      );
      // The peek's display override is trans-only-only, so any mode switch
      // invalidates it; the pointer affordance and hint follow the mode.
      clearPeek();
      for (const el of injected.values()) {
        try {
          if (mode === "transOnly") {
            // 段落显隐只属于上下对照：仅译文模式下原文本来就藏，译文再藏
            // 会让段落整个消失，所以切换即全部恢复显示。
            el.removeAttribute("data-hidden");
            el.setAttribute("title", getString("bilingual-peek-hint"));
          } else {
            el.removeAttribute("title");
          }
        } catch {
          /* element already gone with the view */
        }
      }
    },
    getMode() {
      return session.container.classList.contains(MODE_CLASSES.transOnly)
        ? "transOnly"
        : "interleave";
    },
    stats: () => queue.stats(),
    retry: (refPath: string) => queue.retry(refPath),
    currentRefPath: () => queue.currentRefPath(),
    translationOf: (refPath: string) => translations.get(refPath) || "",
    translatedReadSegments: () => {
      const out: TranslatedReadSegment[] = [];
      // Manual blocks join document order at the end — they were injected
      // after the session inventory was frozen, and reading them at all is
      // a bonus; exact interleaving by document position is not worth the
      // re-sort here.
      for (const block of [...session.blocks, ...manualBlocks]) {
        const text = translations.get(block.refPath);
        if (!text) continue;
        splitSentences(text).forEach((sentence, sentenceIndex) => {
          out.push({
            text: sentence.text,
            meta: { refPath: block.refPath, sentenceIndex },
          });
        });
      }
      return out;
    },
    highlightTranslatedSentence(refPath: string, sentenceIndex: number) {
      const el = injected.get(refPath);
      const text = translations.get(refPath);
      if (!el || text === undefined) return;
      el.textContent = "";
      if (sentenceIndex < 0) {
        el.textContent = text;
        return;
      }
      const spans = splitSentences(text);
      spans.forEach((sentence, i) => {
        if (i === sentenceIndex) {
          const span = doc.createElement("span");
          span.className = "ztransplit-sent ztransplit-sent-active";
          span.textContent = sentence.text;
          el.appendChild(span);
        } else {
          el.appendChild(doc.createTextNode(sentence.text));
        }
      });
      try {
        el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      } catch {
        /* smooth scrolling unsupported — fine */
      }
    },
    async dispose() {
      queue.stop();
      session.container.removeEventListener("click", onContainerClick);
      doc.removeEventListener("mouseup", onDocMouseUp);
      doc.removeEventListener("mousedown", onDocMouseDown);
      try {
        trigger.remove();
      } catch {
        /* already gone with the view */
      }
      // data-peek is the one transient state we ever put on official
      // elements — strip it so exit leaves the view exactly as found.
      clearPeek();
      for (const el of injected.values()) {
        try {
          el.remove();
        } catch {
          /* element may already be gone with the view */
        }
      }
      injected.clear();
      translations.clear();
      manualBlocks.length = 0;
      session.container.classList.remove(MODE_CLASSES.interleave, MODE_CLASSES.transOnly);
      const style = doc.getElementById("ztransplit-bi-style");
      style?.remove();
      await session.exit();
    },
  };
}

/** Best-effort debug logging helper re-export for consistency. */
export function logInterleave(msg: string): void {
  safeDebug("[Z-Transplit] interleaveView: " + msg);
}
