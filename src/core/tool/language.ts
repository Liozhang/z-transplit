/**
 * Language name lookup.
 *
 * Ported from leadero's src/core/tool/builtin/handlers/language/language.ts.
 * Used to build human-readable source/target language descriptions for the
 * translation prompts (see src/core/translation/prompts.ts) — sending the model
 * "zh-CN" instead of "Simplified Chinese" measurably degrades translation
 * quality on weaker models.
 *
 * Returns the input code unchanged if no friendly name is known — callers
 * rely on this fallback behaviour (the locale key `language-<code>` may still
 * be resolved downstream via getString).
 */

const LANGUAGE_NAMES: Record<string, string> = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  "en-US": "English",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "fr-FR": "French",
  "de-DE": "German",
  "es-ES": "Spanish",
  "ru-RU": "Russian",
};

/** Friendly name for a BCP-47 locale code, or the code itself when unknown. */
export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] || code;
}

/** The raw mapping, exposed for callers that need to enumerate or extend it. */
export const LANGUAGE_NAME_MAP: Readonly<Record<string, string>> =
  LANGUAGE_NAMES;
