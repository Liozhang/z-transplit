/**
 * Translation pipeline types.
 *
 * Home of the type contracts the PDF translation pipeline (src/core/pdf/**)
 * imports. They live OUTSIDE the PDF tree on purpose: the engine layer
 * (translationEngines.ts) and any UI/host caller implement them, while the
 * pipeline only consumes them — so a change to an engine never drags the
 * renderer into its dependency graph.
 *
 * Ported from leadero's src/core/pdf/translation/translateParagraphs.ts
 * (types only; the orchestration functions stay with the pipeline).
 */

/** Result of translating a single paragraph. */
export interface ParagraphTranslation {
  translated: string;
  /** True if this paragraph was a pure-formula placeholder and left untranslated. */
  skippedFormula: boolean;
  /** True if translation failed and the original text was kept as fallback. */
  failed: boolean;
}

/**
 * A translator function — injected rather than imported, so the pipeline stays
 * decoupled from the bridge wiring order and is testable with a stub.
 *
 * Implementations wrap createTranslator() from
 * src/core/translation/translationEngines.ts, which resolves the configured
 * engine, its credentials and (for the OpenAI-compatible engine) the
 * formula-preserving prompt.
 */
export type ParagraphTranslator = (
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
) => Promise<string>;

/**
 * Result of a single batch translation call.
 */
export interface BatchTranslateResult {
  /** Translated texts, aligned 1:1 with the input. Always === input.length. */
  translations: string[];
  /** Indices that failed and kept original text (empty if all succeeded). */
  failedIndices: number[];
}

/**
 * A batch translator — translates multiple paragraphs in one model call.
 *
 * Implementations pack the input into one prompt, call the model, and split
 * the response back into exactly `texts.length` strings. MUST always return
 * exactly `texts.length` translations (never throw — fall back to per-paragraph
 * or original text internally). This guarantee is what lets the orchestrator
 * scatter results back positionally without a length assertion.
 */
export type BatchTranslator = (
  texts: string[],
  signal?: AbortSignal,
) => Promise<BatchTranslateResult>;

/** Per-page text arrays to translate. */
export interface BatchTranslationOptions {
  targetLanguage: string;
  /** Source language hint for the cache key (default "auto"). */
  sourceLanguage?: string;
  /** Max input chars per chunk (derived from the model's context window). */
  inputBudgetChars: number;
  /** Max estimated output chars per chunk (derived from maxOutputTokens). */
  outputBudgetChars: number;
  /** Chunk-level concurrency (default 4). */
  concurrency?: number;
  /** Cooperative cancel signal — checked before each chunk dispatch. */
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /**
   * Persistent-cache identity of the engine configuration (engine|model|
   * credentials|endpoint). When set, paragraph translations are looked up in /
   * written to the persistent translation cache (translationCache.ts). Omit to
   * bypass the cache entirely.
   */
  cacheIdentity?: string;
}

export interface BatchTranslationResult {
  /** Per-page translated arrays, aligned 1:1 with the input pageTexts. */
  translatedSets: string[][];
  /** Total paragraphs that failed and kept original text. */
  failedCount: number;
}

/**
 * Handle returned by createAIBatchTranslator — carries the batch translator
 * plus the token-budget parameters the orchestrator needs for chunking.
 */
export interface BatchTranslatorHandle {
  translate: BatchTranslator;
  /** Max input chars per chunk (from contextWindow − system − output reserve). */
  inputBudgetChars: number;
  /** Max estimated output chars per chunk (from maxOutputTokens). */
  outputBudgetChars: number;
}
