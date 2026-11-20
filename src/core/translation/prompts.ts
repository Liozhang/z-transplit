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
import { renderPrompt } from "./promptTemplate";

/**
 * Build a system prompt that instructs the model to preserve `{vn}` formula
 * placeholders verbatim. converter.py's default translator doesn't add this
 * (it just says "preserve formulas"), but the placeholder syntax is more fragile
 * than prose formulas — models sometimes expand/rewrite `{v3}` as `{v 3}` or
/**
 * System prompt for single-paragraph translation.
 *
 * The formula rule here is a SECOND line of defence, not the primary one. The
 * pipeline strips `$...$` spans out of the request before it reaches any engine
 * (see formulaShield) and puts them back afterwards, so by the time this prompt
 * is in play there is normally no formula left in the text. It stays because it
 * costs nothing and covers the paths that bypass the shield.
 *
 * An earlier version of this prompt promised to preserve `{v0}`-style tokens.
 * Nothing in the pipeline has generated those for a long time — the assembly
 * layer's formula list was hardwired empty — so the promise was unkeepable and
 * the tokens, when they did appear in a test, came back mangled. The clause is
 * gone rather than reworded.
 *
 * Ported from leadero/src/core/translation/translationEngines.ts:906, plus one
 * clause added for the OCR path: OCR formulas arrive as `$...$` / `$$...$$`
 * LaTeX, and a translator that rewrites math inside dollar signs corrupts the
 * one thing the pipeline promised to preserve.
 */
export function formulaPreservingPrompt(
  targetLangDesc: string,
  sourceLangDesc: string,
): string {
  return (
    `You are a professional translator. Translate the following text from ${sourceLangDesc} to ${targetLangDesc}.\n` +
    `Output ONLY the translated text, no explanations.\n` +
    `CRITICAL: the text may contain LaTeX math wrapped in $...$ or $$...$$ (for example $E=mc^2$). ` +
    `Preserve every such expression EXACTLY as-is — never translate, reorder or modify anything ` +
    `inside the dollar signs, and keep the dollar signs themselves in place.`
  );
}

/**
 * System prompt for batch JSON translation. Instructs the model to output a
 * JSON object with a "translations" string array, preserving formulas.
 *
 * Ported from leadero/src/core/translation/translationEngines.ts:906.
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
    `4. Output ONLY valid JSON, no markdown, no explanations.`
  );
}

/**
 * Batch prompt for the "ai" engine: carries the user's own template into the
 * batch envelope. The template is single-text ({'{{text}}'} is one passage),
 * which is why the ai engine used to be excluded from batching entirely; here
 * the template is rendered once with a symbolic text role and applied to every
 * segment, so a custom prompt still governs each paragraph's translation.
 * {vn} / $…$ protection carries over verbatim through the rendered template,
 * and the structural rules (count/order/JSON-only) stay non-negotiable.
 */
export function batchJsonPromptFromTemplate(
  template: string,
  targetDesc: string,
  sourceDesc: string,
): string {
  const perSegment = renderPrompt(template, {
    text: "the value of the JSON array element being translated",
    sourceLang: sourceDesc,
    targetLang: targetDesc,
  });
  return (
    `You are a professional translator working on a list of text segments.\n\n` +
    `You will receive a JSON object: {"segments": ["text1", "text2", ...]}.\n` +
    `Translate each segment and output a JSON object: {"translations": ["translation1", "translation2", ...]}.\n\n` +
    `For EACH segment, apply this instruction — the segment takes the role of the text below:\n` +
    `${perSegment}\n\n` +
    `CRITICAL RULES:\n` +
    `1. The output array MUST contain EXACTLY the same number of elements as the input, in the same order.\n` +
    `2. Do NOT merge, split, add, skip, or reorder segments.\n` +
    `3. Output ONLY valid JSON, no markdown, no explanations.`
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
