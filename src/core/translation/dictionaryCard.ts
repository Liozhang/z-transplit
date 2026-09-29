/**
 * dictionaryCard — dictionary-style lookup for single-word reader selections.
 *
 * The chain (first layer that yields a card wins; every failure degrades
 * silently to the next):
 *
 *   1. Youdao web dictionary (youdaoDict.ts) — keyless, authoritative
 *      bilingual content, source word → Chinese target. Skipped for
 *      non-Chinese targets.
 *   2. Model engine — the user's OpenAI-compatible endpoint (translate.ai.* /
 *      translate.custom.*), any language pair, structured JSON from a fixed
 *      dictionary prompt with zod validation.
 *   3. MT simple card — the configured translation engine translates the word;
 *      the card carries that translation as its single sense. Works for every
 *      engine and language pair.
 *
 * There is deliberately NO engine-readiness precondition: layer 1 needs no
 * engine at all, so a lookup must not be gated on translate.* credentials.
 * Only when ALL layers fail does the chain throw — with the LAST layer's error
 * (the most actionable one) embedded in a localized message; the pane renders
 * it in its existing error state with a retry button.
 *
 * Abort semantics match the MT engines: a caller signal short-circuits the
 * chain between layers, and a superseded request's result is ignored by the
 * caller (fetches are not necessarily killed — Gecko 115 has no
 * AbortSignal.any on the paths that need one).
 */

import { z } from "zod";
import { getString } from "../../utils/locale";
import { toErrorMessage } from "../../utils/error";
import { createOpenAICompatClient } from "../ai/openaiCompat";
import { getLanguageName } from "../tool/language";
import { getEngineConfig, createTranslator } from "./translationEngines";
import { lookupYoudao } from "./youdaoDict";
import type { DictionaryCardContent } from "./types";

export type {
  DictionaryCardContent,
  DictionaryCardSource,
  DictionaryExample,
  DictionarySense,
} from "./types";

/** Runtime validation gate for any card — chain output and stored records. */
export const DictionaryCardContentSchema = z.object({
  word: z.string().min(1),
  phonetic: z.string().optional(),
  senses: z
    .array(
      z.object({
        pos: z.string().optional(),
        meaning: z.string().min(1),
        example: z.string().optional(),
        exampleTranslation: z.string().optional(),
      }),
    )
    .min(1),
  examples: z
    .array(z.object({ text: z.string().min(1), translation: z.string().min(1) }))
    .optional(),
  source: z.enum(["youdao", "model", "mt"]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Word detection
// ─────────────────────────────────────────────────────────────────────────────

/** Single token of letters/marks, optionally joined by hyphens or apostrophes. */
const WORD_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u;

/** Above this length even a single Latin token is a paste, not a lookup. */
const MAX_WORD_CHARS = 64;

/**
 * CJK "words" have no spaces, so length is the only separator between a
 * dictionary entry (大学, 共振, 共鸣) and a sentence fragment. Four chars
 * covers the practical dictionary range for zh/ja/ko entries.
 */
const MAX_CJK_WORD_CHARS = 4;

const CJK_RE =
  /[\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

/**
 * Whether a reader selection is a single word worth a dictionary card.
 * Latin script: one token (hyphenated compounds like "state-of-the-art" and
 * clitics like "don't" count). CJK script: ≤4 chars.
 */
export function isSingleWord(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_WORD_CHARS) return false;
  if (!WORD_RE.test(t)) return false;
  if (CJK_RE.test(t)) return t.length <= MAX_CJK_WORD_CHARS;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look one word up. Resolves with a card from the first productive layer;
 * rejects with a localized "all layers failed" error only when nothing did.
 */
export async function lookupWord(
  word: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<DictionaryCardContent> {
  const normalized = (word || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error(getString("dictionary-error-unavailable", { error: "empty word" }));
  }

  let lastError: unknown = new Error("no layer produced a card");

  // Layer 1 — Youdao (bilingual dictionaries target Chinese only).
  if (isChineseTarget(targetLang)) {
    if (signal?.aborted) throw lastError;
    try {
      const card = await lookupYoudao(normalized, signal);
      // The chain is the single validation point: youdaoDict returns
      // structurally guarded plain objects, this gate accepts them.
      if (card && DictionaryCardContentSchema.safeParse(card).success) {
        return card;
      }
    } catch (e) {
      lastError = e;
    }
  }

  // Layer 2 — model engine (any language pair).
  if (signal?.aborted) throw lastError;
  const model = modelConfig();
  if (model) {
    try {
      return await lookupWithModel(normalized, targetLang, model);
    } catch (e) {
      lastError = e;
    }
  }

  // Layer 3 — MT simple card (works for every configured engine/pair).
  if (signal?.aborted) throw lastError;
  try {
    const translator = createTranslator(targetLang);
    const translated = (await translator(normalized, targetLang))?.trim();
    if (translated) {
      return { word: normalized, senses: [{ meaning: translated }], source: "mt" };
    }
    lastError = new Error("empty translation");
  } catch (e) {
    lastError = e;
  }

  throw new Error(
    getString("dictionary-error-all-failed", { error: toErrorMessage(lastError) }),
  );
}

function isChineseTarget(targetLang: string): boolean {
  return /^zh/i.test((targetLang || "").trim());
}

/** Plain text rendering of a card, for the pane's copy button and stores. */
export function flattenCardText(card: DictionaryCardContent): string {
  const lines: string[] = [];
  lines.push(card.phonetic ? `${card.word} ${card.phonetic}` : card.word);
  for (const sense of card.senses) {
    lines.push(sense.pos ? `${sense.pos} ${sense.meaning}` : sense.meaning);
    if (sense.example) {
      lines.push(
        sense.exampleTranslation
          ? `${sense.example} — ${sense.exampleTranslation}`
          : sense.example,
      );
    }
  }
  for (const ex of card.examples ?? []) {
    lines.push(`${ex.text} — ${ex.translation}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — model engine
// ─────────────────────────────────────────────────────────────────────────────

interface ModelEndpoint {
  apiUrl: string;
  apiKey?: string;
  model?: string;
}

/**
 * The endpoint powering dictionary lookups: the engine the user selected when
 * it is model-backed, otherwise any model endpoint they configured (an MT
 * engine selection does not disable a configured AI endpoint — the dictionary
 * layer simply prefers the best available content source).
 */
function modelConfig(): ModelEndpoint | null {
  const cfg = getEngineConfig();
  if (cfg.engineType === "custom" && cfg.customApiUrl) {
    return { apiUrl: cfg.customApiUrl, apiKey: cfg.customApiKey, model: cfg.customModel };
  }
  if (cfg.engineType === "ai" && cfg.aiApiUrl) {
    return { apiUrl: cfg.aiApiUrl, apiKey: cfg.aiApiKey, model: cfg.aiModel };
  }
  if (cfg.aiApiUrl) return { apiUrl: cfg.aiApiUrl, apiKey: cfg.aiApiKey, model: cfg.aiModel };
  if (cfg.customApiUrl) {
    return { apiUrl: cfg.customApiUrl, apiKey: cfg.customApiKey, model: cfg.customModel };
  }
  return null;
}

/**
 * Output budget for a one-word lookup. The 2048 floor follows the same
 * reasoning-model lesson as translationEngines: a purely length-derived cap
 * can be exhausted by hidden thinking before any visible text (recent commits
 * 9184dfa / 804150b). A word cannot need more than the floor.
 */
const MODEL_LOOKUP_MIN_TOKENS = 2048;

const MODEL_LOOKUP_TIMEOUT_MS = 60000;

/**
 * Model-side card schema: strict on the one thing a card cannot exist without
 * (at least one non-empty meaning), applied after {@link stripNulls} removes
 * the nulls models emit for optional fields.
 */
const ModelCardSchema = z.object({
  word: z.string().optional(),
  phonetic: z.string().optional(),
  senses: z
    .array(
      z.object({
        pos: z.string().optional(),
        meaning: z.string().min(1),
        example: z.string().optional(),
        exampleTranslation: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

/** Deeply drop null-valued object keys so schema optionals see "absent". */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== null) out[key] = stripNulls(val);
    }
    return out;
  }
  return value;
}

const ModelCardPreprocessed = z.preprocess(stripNulls, ModelCardSchema);

function dictionaryPrompt(targetDesc: string): string {
  return [
    "You are a bilingual dictionary. For the word or short phrase given by the user, return ONLY a JSON object of this exact shape:",
    '{"word":"...","phonetic":"...","senses":[{"pos":"n.","meaning":"...","example":"...","exampleTranslation":"..."}]}',
    `Rules: "meaning" and "exampleTranslation" are written in ${targetDesc}; order senses most-common first (1-4 senses); at most one example per sense, taken from real usage; "phonetic" is the IPA of the word's own language or an empty string; omit a field instead of filling it with filler; no markdown fences, no commentary.`,
  ].join("\n");
}

async function lookupWithModel(
  word: string,
  targetLang: string,
  model: ModelEndpoint,
): Promise<DictionaryCardContent> {
  const targetDesc = getLanguageName(targetLang);
  const client = createOpenAICompatClient({
    apiUrl: model.apiUrl,
    apiKey: model.apiKey,
    defaultModel: model.model,
    emptyResultErrorKey: "dictionary-error-unavailable",
  });
  // No caller signal here — matching the MT engines, the pane cancels by
  // ignoring a superseded result, while timeoutMs keeps the request bounded.
  const result = await client.chatJson(
    {
      messages: [
        { role: "system", content: dictionaryPrompt(targetDesc) },
        { role: "user", content: word },
      ],
      maxTokens: MODEL_LOOKUP_MIN_TOKENS,
      temperature: 0.2,
      timeoutMs: MODEL_LOOKUP_TIMEOUT_MS,
    },
    ModelCardPreprocessed,
  );
  return {
    word: result.data.word || word,
    // stripNulls has already dropped runtime nulls; the ?? narrowing only
    // reconciles z.preprocess's inferred type (nullable optionals) with
    // DictionaryCardContent's optional-only fields.
    phonetic: result.data.phonetic ?? undefined,
    senses: result.data.senses.map((s) => ({
      meaning: s.meaning,
      pos: s.pos ?? undefined,
      example: s.example ?? undefined,
      exampleTranslation: s.exampleTranslation ?? undefined,
    })),
    source: "model",
  };
}
