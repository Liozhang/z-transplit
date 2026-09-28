/**
 * AI-engine prompt template: language-configured rendering + validation.
 *
 * The "ai" engine (see translationEngines.ts) does not hard-code its prompt:
 * the user owns the template, and the plugin owns the *contract* — which
 * placeholders exist, what they mean, and what makes a template unusable.
 * This module is that contract in one place:
 *
 *   validatePromptTemplate(raw)  → { ok: true, template } | { ok: false, reason }
 *   renderPrompt(template, vars) → the prompt actually sent to the model
 *   resolvePromptTemplate(raw)   → the effective template ("" = built-in default)
 *
 * Placeholders use DOUBLE braces on purpose. The translation pipeline already
 * puts single-brace tokens in the prompt text — `{v0}`, `{v1}` mark formula
 * positions (see prompts.ts#formulaPreservingPrompt) — so `{text}`-style
 * placeholders would be indistinguishable from prompt content. `{{text}}`,
 * `{{sourceLang}}` and `{{targetLang}}` cannot collide with anything a
 * legitimate prompt contains, and an unknown `{{name}}` is a typo the user
 * wants to hear about rather than a token we silently pass through.
 *
 * Three placeholders are mandatory and that is the whole language
 * configuration story: the engine resolves a locale code (zh-CN, en-US…) to a
 * human-readable name through src/core/tool/language.ts and substitutes it
 * here. Sending the model "zh-CN" instead of "Simplified Chinese" measurably
 * degrades translation quality on weaker models, so the language pair is part
 * of the template contract, not of the message body.
 *
 * Validation is deliberately hand-rolled rather than a zod schema: each rule
 * has to map to its own localized message (the settings pane shows the exact
 * reason inline), and zod's single-issue errors would force either one
 * combined message or a rewrite of its error tree. zod stays where it belongs
 * in this codebase — validating model output.
 */

/** Placeholders a template may contain, in reporting order. */
export const AI_PROMPT_PLACEHOLDERS = [
  "text",
  "sourceLang",
  "targetLang",
] as const;

export type AIPromptPlaceholder = (typeof AI_PROMPT_PLACEHOLDERS)[number];

/**
 * Built-in template, used whenever the preference is empty.
 *
 * Same wording as formulaPreservingPrompt (src/core/translation/prompts.ts):
 * the PDF pipeline replaces formulas with `{vn}` tokens before translating, so
 * the prompt has to forbid the model from touching them. Keeping one wording
 * means switching engines does not silently drop the formula contract.
 */
export const DEFAULT_AI_PROMPT = `You are a professional translator. Translate the following text from {{sourceLang}} to {{targetLang}}.
Text to translate:
{{text}}
Output ONLY the translated text, no explanations.
CRITICAL: The text contains tokens like {v0}, {v1}, {v2} that mark the position of mathematical formulas. You MUST preserve every such token EXACTLY as-is — same braces, same letter 'v', same number, in the correct position relative to the surrounding translated text. Do not translate, rename, expand, or renumber these tokens.`;

/** Length bounds for a user template (chars, after trimming). */
export const AI_PROMPT_MAX_LENGTH = 4000;

/** `{{ name }}` with optional surrounding whitespace inside the braces. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Why a template is unusable. Maps to `translation-error-ai-prompt-<reason>`. */
export type PromptRejectionReason =
  | "too-long"
  | "unknown-placeholder"
  | "missing-text"
  | "duplicate-text"
  | "missing-source-lang"
  | "missing-target-lang"
  | "unbalanced-braces";

export type PromptTemplateCheck =
  | { ok: true; template: string }
  | { ok: false; reason: PromptRejectionReason };

export interface PromptVariables {
  /** The text to translate. */
  text: string;
  /** Source language name, or "auto-detect" when unknown. */
  sourceLang: string;
  /** Target language name. */
  targetLang: string;
}

/**
 * Validate a raw template and return the template to use.
 *
 * An empty (or whitespace-only) value is valid and resolves to
 * {@link DEFAULT_AI_PROMPT} — that is how "restore the default template" is
 * expressed in the settings pane, so it must not be an error.
 *
 * There is deliberately no minimum length: the placeholder rules imply one
 * ({{sourceLang}}{{targetLang}}{{text}} is already 36 characters), so a
 * "too short" rule could only ever fire alongside "missing placeholder" and
 * would just report the less actionable message first.
 *
 * Rules are checked in the order they are documented above; the first
 * rejection wins so the user sees one actionable message at a time.
 */
export function validatePromptTemplate(
  raw?: string | null,
): PromptTemplateCheck {
  const template = (raw ?? "").trim();
  if (!template) return { ok: true, template: DEFAULT_AI_PROMPT };

  if (template.length > AI_PROMPT_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }

  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) names.push(m[1]);
  // A typo is reported before a missing placeholder: `{{txt}}` is both, and
  // "unknown placeholder" is the fix the user can act on.
  const unknown = names.find((n) => !isPlaceholder(n));
  if (unknown) return { ok: false, reason: "unknown-placeholder" };

  // Unbalanced braces come next, before "missing": a half-typed `{{text}` also
  // loses its `{{text}}` occurrence, and "you left a brace hanging" is the fix
  // the user can act on, while "missing {{text}}" would send them looking in
  // the wrong place.
  const residual = template.replace(PLACEHOLDER_RE, "");
  if (residual.includes("{{") || residual.includes("}}")) {
    return { ok: false, reason: "unbalanced-braces" };
  }

  const count = (name: string) => names.filter((n) => n === name).length;
  if (count("text") === 0) return { ok: false, reason: "missing-text" };
  // Repeating {{text}} would send the source text more than once per call.
  if (count("text") > 1) return { ok: false, reason: "duplicate-text" };
  if (count("sourceLang") === 0) {
    return { ok: false, reason: "missing-source-lang" };
  }
  if (count("targetLang") === 0) {
    return { ok: false, reason: "missing-target-lang" };
  }

  return { ok: true, template };
}

/**
 * Effective template for a raw preference value: the user's template, or the
 * built-in default. Never throws — an invalid non-empty template falls back to
 * the default so callers that only need *a* prompt still get one (the engine
 * validates separately and refuses to translate on an invalid template).
 */
export function resolvePromptTemplate(raw?: string | null): string {
  const check = validatePromptTemplate(raw);
  return check.ok ? check.template : DEFAULT_AI_PROMPT;
}

/**
 * Substitute the placeholders. Unknown `{{name}}` pairs are left verbatim
 * rather than blanked, so a template that slipped through unvalidated still
 * shows the user what it asked for.
 */
export function renderPrompt(template: string, vars: PromptVariables): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (name === "text") return vars.text;
    if (name === "sourceLang") return vars.sourceLang;
    if (name === "targetLang") return vars.targetLang;
    return match;
  });
}

function isPlaceholder(name: string): name is AIPromptPlaceholder {
  return (AI_PROMPT_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * Short, stable fingerprint of a template for cache keys. The persistent
 * translation cache (translationCache.ts) addresses entries by engine
 * configuration; editing the prompt changes the output, so the template has to
 * be part of that identity — without storing the template itself.
 */
export function promptFingerprint(prompt: string): string {
  // djb2: small, dependency-free, good enough to distinguish user edits.
  let hash = 5381;
  for (let i = 0; i < prompt.length; i++) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) | 0;
  }
  return `${(hash >>> 0).toString(36)}:${prompt.length}`;
}
