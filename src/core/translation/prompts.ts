/**
 * Translation prompts + response sanitizing.
 *
 * Extracted from leadero's translateParagraphs.ts / translationEngines.ts so
 * the OpenAI-compatible ("custom") engine, the batch translator and any future
 * model-backed engine share ONE wording of these constraints. Both prompts
 * exist because of the `{vn}` formula placeholder contract: the C-stage renderer
 * re-parses tokens with a tolerant regex that allows spaces but NOT a translated
 * "v", so the prohibition has to be explicit in the prompt.
 */

import type { BatchTranslateResult } from "./types";

/**
 * Build a system prompt that instructs the model to preserve `{vn}` formula
 * placeholders verbatim. converter.py's default translator doesn't add this
 * (it just says "preserve formulas"), but the placeholder syntax is more fragile
 * than prose formulas — models sometimes expand/rewrite `{v3}` as `{v 3}` or
 * translate the "v". The C stage tolerates spaces but NOT a translated "v",
 * so we make the constraint explicit.
 *
 * Verbatim port of leadero/src/core/pdf/translation/translateParagraphs.ts:130.
 */
export function formulaPreservingPrompt(
  targetLangDesc: string,
  sourceLangDesc: string,
): string {
  return (
    `You are a professional translator. Translate the following text from ${sourceLangDesc} to ${targetLangDesc}.\n` +
    `Output ONLY the translated text, no explanations.\n` +
    `CRITICAL: The text contains tokens like {v0}, {v1}, {v2} that mark the position of mathematical formulas. ` +
    `You MUST preserve every such token EXACTLY as-is — same braces, same letter 'v', same number, in the correct ` +
    `position relative to the surrounding translated text. Do not translate, rename, expand, or renumber these tokens. ` +
    `For example, input "The result is {v0} where {v1} denotes..." must keep {v0} and {v1} intact.`
  );
}

/**
 * System prompt for batch JSON translation. Instructs the model to output a
 * JSON object with a "translations" string array, preserving formulas and
 * {vn} tokens.
 *
 * Verbatim port of leadero/src/core/translation/translationEngines.ts:906.
 */
export function batchJsonPrompt(
  targetDesc: string,
  sourceDesc: string,
): string {
  return (
    `You are a professional translator. Translate from ${sourceDesc} to ${targetDesc}.\n\n` +
    `You will receive a JSON object: {"segments": ["text1", "text2", ...]}.\n` +
    `Translate each segment and output a JSON object: {"translations": ["translation1", "translation2", ...]}.\n\n` +
    `CRITICAL RULES:\n` +
    `1. The output array MUST contain EXACTLY the same number of elements as the input, in the same order.\n` +
    `2. Do NOT merge, split, add, skip, or reorder segments.\n` +
    `3. Preserve EVERY formula in $...$ or $$...$$ EXACTLY as-is. Never translate or modify content inside dollar signs.\n` +
    `4. Preserve tokens like {v0}, {v1} verbatim.\n` +
    `5. Output ONLY valid JSON, no markdown, no explanations.`
  );
}

/**
 * Replace empty-string translations with their originals and flag them as
 * failed. Prevents silent content loss when the model returns "" for a
 * non-empty input (e.g., it ran out of output budget mid-array and padded
 * the tail with empty strings).
 *
 * Verbatim port of leadero/src/core/translation/translationEngines.ts:926.
 */
export function sanitizeTranslations(
  translations: string[],
  originals: string[],
): BatchTranslateResult {
  const failedIndices: number[] = [];
  const out = translations.map((t, i) => {
    if (!t && originals[i].trim()) {
      failedIndices.push(i);
      return originals[i];
    }
    return t;
  });
  return { translations: out, failedIndices };
}
