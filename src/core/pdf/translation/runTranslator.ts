/**
 * pdf/translation/runTranslator — the engine-backed paragraph translator,
 * resolved ONCE per translation run.
 *
 * Why this exists as its own module: the PDF pipeline translates a document one
 * paragraph at a time, and the engine configuration lives in the preferences.
 * Resolving it inside the per-paragraph callback meant every paragraph re-read
 * the prefs, so a user who switched engines in the settings while a 56-page
 * document was translating got a document whose first paragraphs came from one
 * provider and whose later paragraphs came from another — one PDF, two
 * translators, and a cache identity that changed halfway through. Resolving
 * here, once, pins the whole run to the engine it started with.
 *
 * The returned translator deliberately ignores the per-call language arguments
 * and re-passes the run's own: `translateParagraphs` hands every paragraph the
 * same target language anyway, and a per-call override would reintroduce the
 * per-paragraph decision this module exists to remove.
 *
 * @module pdf/translation/runTranslator
 */

import { createTranslator } from "../../translation/translationEngines";
import type { ParagraphTranslator } from "./translateParagraphs";

/**
 * Build the paragraph translator for one translation run. Calls
 * createTranslator exactly once — the engine, its credentials, the prompt
 * template, the glossary and the custom headers are all read at this point and
 * stay fixed for the rest of the run.
 */
export function makeRunTranslator(
  targetLanguage: string,
  sourceLanguage?: string,
): ParagraphTranslator {
  const translate = createTranslator(targetLanguage, sourceLanguage);
  return async (text) => translate(text, targetLanguage, sourceLanguage);
}
