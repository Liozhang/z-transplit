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
 * Translation supply is the LazyTranslateQueue; the persistent translation
 * cache (translationCache.ts) sits between the queue and the engine.
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
.${BI_CLASS} {
  margin: 0.35em 0 0.8em 0;
  padding: 0.55em 0.8em;
  border-inline-start: 3px solid var(--ztransplit-accent, #1f9e8d);
  background: var(--ztransplit-bi-bg, rgba(31, 158, 141, 0.08));
  border-radius: 4px;
  font-size: 0.95em;
  line-height: 1.65;
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

  const makeBlockEl = (block: SdtBlock): HTMLElement => {
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
    { concurrency, signal: options.signal },
  );
  queue.start();

  return {
    setMode(mode: BilingualMode) {
      session.container.classList.remove(MODE_CLASSES.interleave, MODE_CLASSES.transOnly);
      session.container.classList.add(
        mode === "transOnly" ? MODE_CLASSES.transOnly : MODE_CLASSES.interleave,
      );
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
      for (const block of session.blocks) {
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
      for (const el of injected.values()) {
        try {
          el.remove();
        } catch {
          /* element may already be gone with the view */
        }
      }
      injected.clear();
      translations.clear();
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
