/**
 * translateParagraphs — Stage B of layout-preserving translation.
 *
 * Translates each assembled paragraph text, preserving `{vn}` formula
 * placeholders so Stage C can stitch formulas back in.
 *
 * Two key behaviors from converter.py:
 *   - Pure-formula paragraphs (`{v3}` only, no surrounding text) are skipped —
 *     never sent to the translator (converter.py `re.match(r"^\{v\d+\}$", s)`).
 *   - The translator MUST return `{vn}` tokens verbatim. converter.py relies on
 *     this; the C stage re-parses them with a tolerant regex (converter.py
 *     `\{\s*v([\d\s]+)\}`). We reinforce this in the system prompt.
 *
 * Ported from leadero's src/core/pdf/translation/translateParagraphs.ts. Two
 * z-transplit adaptations:
 *   - The shared type contracts (ParagraphTranslator, BatchTranslator,
 *     BatchTranslateResult, BatchTranslationOptions/Result, ParagraphTranslation)
 *     now live in src/core/translation/types.ts — the engine layer implements
 *     them, this module consumes them; they are re-exported below so
 *     `import type { ParagraphTranslator } from ".../translateParagraphs"`
 *     keeps working for pipeline callers and tests.
 *   - `formulaPreservingPrompt` lives in src/core/translation/prompts.ts as the
 *     single wording shared with the engines; re-exported below.
 *
 * The translator is INJECTED (not imported): implementations wrap
 * createTranslator() from src/core/translation/translationEngines.ts, which
 * resolves the configured engine, its credentials and the formula-preserving
 * prompt. That keeps this module decoupled from engine wiring and testable
 * with a stub.
 *
 * @module core/pdf/translation/translateParagraphs
 */

import { Semaphore } from "../../../utils/Semaphore";
import { safeDebug } from "../../../utils/logger";
import type {
  BatchTranslateResult,
  BatchTranslator,
  BatchTranslationOptions,
  BatchTranslationResult,
  ParagraphTranslator,
  ParagraphTranslation,
} from "../../translation/types";
import { formulaPreservingPrompt } from "../../translation/prompts";
import {
  cacheAvailable,
  cacheKey,
  getCachedTranslations,
  putCachedTranslation,
} from "../../translation/translationCache";

// Re-exported for pipeline callers (the Stage B contract surface).
export type {
  BatchTranslateResult,
  BatchTranslator,
  BatchTranslationOptions,
  BatchTranslationResult,
  ParagraphTranslation,
  ParagraphTranslator,
};
export { formulaPreservingPrompt };

/**
 * Resolve cache keys + cached translations for a set of texts in one pass.
 * Returns keys aligned with the input (null = caching off / unkeyable) and a
 * map of index → cached translation for the hits.
 */
async function lookupCache(
  cacheIdentity: string | undefined,
  sourceLanguage: string | undefined,
  targetLanguage: string,
  texts: string[],
): Promise<{ keys: (string | null)[]; hits: Map<number, string> }> {
  const keys: (string | null)[] = new Array(texts.length).fill(null);
  const hits = new Map<number, string>();
  if (!cacheIdentity || !cacheAvailable()) return { keys, hits };
  try {
    for (let i = 0; i < texts.length; i++) {
      keys[i] = await cacheKey(cacheIdentity, sourceLanguage || "auto", targetLanguage, texts[i]);
    }
    const cached = await getCachedTranslations(keys);
    for (let i = 0; i < texts.length; i++) {
      const key = keys[i];
      const hit = key ? cached.get(key) : undefined;
      if (hit !== undefined) hits.set(i, hit);
    }
  } catch (e) {
    safeDebug("[Z-Transplit] translateParagraphs cache lookup failed: " + e);
  }
  return { keys, hits };
}

/** Fire-and-forget cache store (never throws, never blocks the caller). */
function storeCache(
  cacheIdentity: string | undefined,
  sourceLanguage: string | undefined,
  targetLanguage: string,
  sourceText: string,
  translated: string,
): void {
  if (!cacheIdentity) return;
  void putCachedTranslation(cacheIdentity, sourceLanguage || "auto", targetLanguage, sourceText, translated)
    .catch((e) => safeDebug("[Z-Transplit] translateParagraphs cache store failed: " + e));
}

/**
 * Translate a list of paragraph texts, preserving `{vn}` formula placeholders.
 *
 * @param texts Paragraph texts (possibly containing `{vn}`).
 * @param translate Injected translator.
 * @param targetLanguage e.g. "zh-CN".
 * @param sourceLanguage Optional source language hint.
 * @param concurrency Max parallel translation requests (converter.py uses a
 *   ThreadPoolExecutor). Defaults to 4.
 * @param options Optional overrides — `cacheIdentity` enables the persistent
 *   paragraph cache for this call.
 * @returns Translated texts aligned 1:1 with input; plus per-paragraph status.
 */
export async function translateParagraphs(
  texts: string[],
  translate: ParagraphTranslator,
  targetLanguage: string,
  sourceLanguage?: string,
  concurrency = 4,
  options?: { cacheIdentity?: string },
): Promise<{ results: string[]; status: ParagraphTranslation[] }> {
  const results: string[] = new Array(texts.length).fill("");
  const status: ParagraphTranslation[] = new Array(texts.length);

  // Identify which paragraphs need translation (skip pure-formula + empty).
  const pureFormulaRe = /^\{v\d+\}$/;
  const tasks: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (!t || t.length === 0 || pureFormulaRe.test(t)) {
      results[i] = t; // passthrough
      status[i] = { translated: t, skippedFormula: pureFormulaRe.test(t), failed: false };
    } else {
      tasks.push({ index: i, text: t });
    }
  }

  // Persistent cache: satisfy hits up front so only misses reach the engine.
  const { hits } = await lookupCache(
    options?.cacheIdentity,
    sourceLanguage,
    targetLanguage,
    tasks.map((t) => t.text),
  );
  if (hits.size > 0) {
    for (const [taskPos, cached] of hits) {
      const { index } = tasks[taskPos];
      results[index] = cached;
      status[index] = { translated: cached, skippedFormula: false, failed: false };
    }
    const remaining = tasks.filter((_, pos) => !hits.has(pos));
    tasks.length = 0;
    tasks.push(...remaining);
  }

  // Bounded-concurrency translation pool (converter.py: ThreadPoolExecutor.map)
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const current = cursor++;
      const { index, text } = tasks[current];
      // One retry with a short backoff before falling back to the original
      // text. This absorbs transient network/rate-limit errors (the audit
      // showed a real "9/9 paragraphs failed" case caused by an API blip)
      // without the complexity of a full exponential-backoff retry policy.
      let out: string | null = null;
      for (let attempt = 0; attempt < 2 && out === null; attempt++) {
        try {
          out = await translate(text, targetLanguage, sourceLanguage);
        } catch (e) {
          safeDebug("[Z-Transplit] translateParagraphs: " + e);
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      if (out !== null) {
        results[index] = out;
        status[index] = { translated: out, skippedFormula: false, failed: false };
        storeCache(options?.cacheIdentity, sourceLanguage, targetLanguage, text, out);
      } else {
        // Fallback: keep original on failure (better than dropping the paragraph).
        results[index] = text;
        status[index] = { translated: text, skippedFormula: false, failed: true };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);

  return { results, status };
}


/**
 * Conservative expansion factor (output chars / input chars) per target
 * language. Used only for chunk-size estimation — the actual output length is
 * whatever the model produces, bounded by maxOutputTokens. CJK targets are
 * shorter than English source; Latin targets expand. Defaults to 1.5
 * (conservative) for unlisted languages.
 */
/** 语言（BCP-47 主子标签）→ 保守膨胀因子（输出字符 / 输入字符）。 */
const EXPANSION_FACTORS: Readonly<Record<string, number>> = {
  zh: 0.8, ja: 0.8, ko: 0.8,
  en: 1.6,
  de: 1.3,
  fr: 1.2, es: 1.2, it: 1.2, pt: 1.2,
  ar: 1.4,
  ru: 1.3, uk: 1.3,
};

export function expansionFactorForTarget(targetLanguage: string): number {
  const lang = (targetLanguage || "").split("-")[0].toLowerCase();
  return EXPANSION_FACTORS[lang] ?? 1.5;
}

/** A flattened translatable paragraph with its position in the page grid. */
interface FlatTask {
  pageIdx: number;
  paraIdx: number;
  text: string;
}

/**
 * Greedy, ORDER-PRESERVING bin-packer. Groups paragraphs into chunks whose
 * combined estimated output (and input) stays within the dual token budget.
 *
 * Unlike PaperAnalyzer.splitIntoChunks (which sorts by priority), this MUST
 * preserve document order — translation quality depends on contextual
 * continuity, and the scatter-back relies on positional alignment.
 *
 * A single paragraph whose estimated output exceeds `outputBudgetChars` gets
 * its own chunk (it can't be skipped — every paragraph must be translated or
 * preserved). Such oversized paragraphs may get truncated by maxTokens, which
 * is the best achievable outcome.
 */
export function planTranslationChunks(
  tasks: FlatTask[],
  inputBudgetChars: number,
  outputBudgetChars: number,
  expansionFactor: number,
): FlatTask[][] {
  const chunks: FlatTask[][] = [];
  let current: FlatTask[] = [];
  let curInput = 0;
  let curOutput = 0;

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      curInput = 0;
      curOutput = 0;
    }
  };

  for (const task of tasks) {
    const inChars = task.text.length;
    // Per-item JSON overhead: 2 quotes + comma + escaping margin in the
    // {"translations":["...","..."]} envelope. Without this, many short
    // paragraphs pack too densely and the real JSON output exceeds
    // maxOutputTokens → truncation → count mismatch → retry storm.
    const estOutChars = Math.ceil(inChars * expansionFactor) + 6;

    // Single paragraph exceeds output budget → its own chunk (can't skip it).
    if (estOutChars > outputBudgetChars) {
      flush();
      chunks.push([task]);
      continue;
    }

    // Adding would overflow either budget → start a new chunk.
    if (
      curOutput + estOutChars > outputBudgetChars ||
      curInput + inChars > inputBudgetChars
    ) {
      flush();
    }

    current.push(task);
    curInput += inChars;
    curOutput += estOutChars;
  }
  flush();
  return chunks;
}

/**
 * Translate ALL pages' paragraphs in cross-page, token-budgeted batches.
 *
 * This is the LLM-native replacement for the per-page per-paragraph loop.
 * It flattens every page into one global task list (breaking the page-boundary
 * isolation that hurt cross-paragraph coherence), chunks by token budget, and
 * dispatches each chunk as a single model call via the injected `batchTranslate`.
 *
 * Empty and pure-formula (`{vn}`) paragraphs are passed through untranslated
 * — they never enter a batch. Results are scattered back to per-page arrays
 * positionally, preserving the `translatedSets[i][j] ⟷ pageTexts[i][j]`
 * contract the renderer depends on.
 */
export async function translateAllPagesBatched(
  pageTexts: string[][],
  batchTranslate: BatchTranslator,
  options: BatchTranslationOptions,
): Promise<BatchTranslationResult> {
  const onProgress = options.onProgress ?? (() => {});
  const concurrency = options.concurrency ?? 4;
  const expansionFactor = expansionFactorForTarget(options.targetLanguage);

  const pureFormulaRe = /^\{v\d+\}$/;
  const tasks: FlatTask[] = [];
  for (let p = 0; p < pageTexts.length; p++) {
    for (let j = 0; j < pageTexts[p].length; j++) {
      const trimmed = (pageTexts[p][j] || "").trim();
      if (!trimmed || pureFormulaRe.test(trimmed)) continue;
      tasks.push({ pageIdx: p, paraIdx: j, text: pageTexts[p][j] });
    }
  }

  // All paragraphs were passthrough — return originals unchanged.
  if (tasks.length === 0) {
    return {
      translatedSets: pageTexts.map((page) => page.slice()),
      failedCount: 0,
    };
  }

  // Persistent cache: keys align with `tasks`; hits drop out of the chunk plan
  // entirely (both quota and latency win). Duplicate paragraphs share a key.
  const { keys, hits } = await lookupCache(
    options.cacheIdentity,
    options.sourceLanguage,
    options.targetLanguage,
    tasks.map((t) => t.text),
  );
  const cachedByKey = new Map<string, string>();
  const uncachedTasks: (FlatTask & { cacheKey?: string | null })[] = [];
  const positionCacheKeys = new Map<string, string>(); // `${p}:${j}` → cache key
  for (let i = 0; i < tasks.length; i++) {
    const key = keys[i];
    if (key) positionCacheKeys.set(`${tasks[i].pageIdx}:${tasks[i].paraIdx}`, key);
    const hit = hits.get(i);
    if (hit !== undefined && key) {
      cachedByKey.set(key, hit);
    } else {
      uncachedTasks.push({ ...tasks[i], cacheKey: key });
    }
  }

  const translatable = uncachedTasks;

  const chunks: (FlatTask & { cacheKey?: string | null })[][] =
    planTranslationChunks(
      translatable,
      options.inputBudgetChars,
      options.outputBudgetChars,
      expansionFactor,
    );

  onProgress(
    `正在批量翻译（${translatable.length} 段${tasks.length !== translatable.length ? `，缓存命中 ${tasks.length - translatable.length} 段` : ""}，分 ${chunks.length} 块）…`,
  );

  const translated = new Map<string, string>(); // `${pageIdx}:${paraIdx}` → text
  const failedKeys = new Set<string>();
  let completed = 0;

  const signal = options.signal;
  const sem = new Semaphore(Math.min(concurrency, Math.max(chunks.length, 1)));
  await Promise.all(
    chunks.map(async (chunk) => {
      // Cooperative cancel: skip chunks not yet started.
      if (signal?.aborted) return;

      const release = await sem.acquire();
      // Re-check after waiting for the semaphore — may have queued a while.
      if (signal?.aborted) {
        release();
        return;
      }
      try {
        const inputTexts = chunk.map((t) => t.text);
        const result = await batchTranslate(inputTexts, signal);
        for (let i = 0; i < chunk.length; i++) {
          const key = `${chunk[i].pageIdx}:${chunk[i].paraIdx}`;
          translated.set(key, result.translations[i]);
          if (result.failedIndices.includes(i)) {
            failedKeys.add(key);
          } else if (chunk[i].cacheKey) {
            // Only cache successes — a failed paragraph kept its original text.
            storeCache(
              options.cacheIdentity,
              options.sourceLanguage,
              options.targetLanguage,
              chunk[i].text,
              result.translations[i],
            );
          }
        }
      } catch (e) {
        safeDebug("[Z-Transplit] translateParagraphs: " + e);
        // Defensive: batchTranslate contract says "never throws" (except on
        // cancel), but if a bug escapes, preserve original text rather than
        // rejecting Promise.all and orphaning other in-flight chunks.
        // Cancelled chunks keep original text without being counted as failed.
        const cancelled = signal?.aborted;
        for (const t of chunk) {
          const key = `${t.pageIdx}:${t.paraIdx}`;
          translated.set(key, t.text);
          if (!cancelled) failedKeys.add(key);
        }
      } finally {
        release();
        completed++;
        onProgress(`批量翻译进度：${completed}/${chunks.length} 块`);
      }
    }),
  );

  const translatedSets: string[][] = pageTexts.map((page, p) =>
    page.map((origText, j) => {
      const key = `${p}:${j}`;
      // Cache hit (whole-paragraph, keyed by content) first, then a live batch
      // result, then the original. `||` (not `??`) so an empty-string
      // translation from the model doesn't overwrite a non-empty original —
      // data-loss guard flagged by review.
      const cached = positionCacheKeys.has(key)
        ? cachedByKey.get(positionCacheKeys.get(key) as string)
        : undefined;
      return translated.get(key) || cached || origText;
    }),
  );

  return { translatedSets, failedCount: failedKeys.size };
}
