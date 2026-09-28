/**
 * promptTemplate — AI prompt template validation + rendering tests.
 *
 * The contract under test is the one the "ai" engine and the settings pane both
 * rely on (the pane mirrors these rules in addon/content/preferences.js, and
 * preferencesPane.dom.test.ts pins the two implementations together):
 *
 *   - an empty template is valid and means "use the built-in default"
 *   - {{text}} / {{sourceLang}} / {{targetLang}} are the only placeholders,
 *     all three required, {{text}} exactly once
 *   - single-brace tokens ({v0}, {v1}) are prompt CONTENT, not placeholders —
 *     that distinction is the whole reason the template uses double braces
 *   - every rejection maps to its own reason, reported in a fixed order
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_AI_PROMPT,
  AI_PROMPT_MAX_LENGTH,
  AI_PROMPT_PLACEHOLDERS,
  promptFingerprint,
  renderPrompt,
  resolvePromptTemplate,
  validatePromptTemplate,
  type PromptRejectionReason,
} from "../../../../src/core/translation/promptTemplate";

/** A minimal valid template, used as the base for mutated cases. */
const VALID =
  "Translate from {{sourceLang}} to {{targetLang}}: {{text}}";

describe("validatePromptTemplate — accepted templates", () => {
  it("empty / whitespace-only resolves to the built-in default", () => {
    // This is how "restore the default template" is expressed in prefs.
    expect(validatePromptTemplate("")).toEqual({
      ok: true,
      template: DEFAULT_AI_PROMPT,
    });
    expect(validatePromptTemplate("   \n\t ")).toEqual({
      ok: true,
      template: DEFAULT_AI_PROMPT,
    });
    expect(validatePromptTemplate(undefined).ok).toBe(true);
    expect(validatePromptTemplate(null).ok).toBe(true);
  });

  it("the built-in default passes its own validation", () => {
    const check = validatePromptTemplate(DEFAULT_AI_PROMPT);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.template).toBe(DEFAULT_AI_PROMPT);
  });

  it("accepts a minimal template with all three placeholders", () => {
    expect(validatePromptTemplate(VALID)).toEqual({ ok: true, template: VALID });
  });

  it("accepts extra whitespace inside placeholder braces", () => {
    expect(
      validatePromptTemplate("from {{ sourceLang }} to {{targetLang }}: {{ text}}")
        .ok,
    ).toBe(true);
  });

  it("accepts formula markers ({v0}) without flagging unbalanced braces", () => {
    // The PDF pipeline substitutes formulas with {vn} tokens before
    // translating, so the prompt must be allowed to mention them literally.
    const prompt = `Translate to {{targetLang}} from {{sourceLang}}: {{text}} Keep {v0} and {v1} as-is.`;
    expect(validatePromptTemplate(prompt).ok).toBe(true);
  });

  it("trims the stored template", () => {
    const check = validatePromptTemplate(`\n  ${VALID}  \n`);
    expect(check.ok && check.template).toBe(VALID);
  });

  it("placeholders may appear in any order and repeat the language pair", () => {
    const prompt =
      "{{targetLang}} from {{sourceLang}}. Text: {{text}} (again {{sourceLang}})";
    expect(validatePromptTemplate(prompt).ok).toBe(true);
  });
});

describe("validatePromptTemplate — rejections (one reason each, in order)", () => {
  const cases: Array<[string, string, PromptRejectionReason]> = [
    [
      "longer than the maximum",
      `{{text}}${"y".repeat(AI_PROMPT_MAX_LENGTH)}`,
      "too-long",
    ],
    [
      "a typo'd placeholder is reported before the missing one",
      "from {{sourceLang}} to {{targetLang}}: {{txt}}",
      "unknown-placeholder",
    ],
    [
      "a half-typed placeholder leaves braces unbalanced",
      "from {{sourceLang}} to {{targetLang}}: {{text}",
      "unbalanced-braces",
    ],
    ["missing {{text}}", "from {{sourceLang}} to {{targetLang}}", "missing-text"],
    [
      "{{text}} twice would send the source text twice",
      "{{text}} from {{sourceLang}} to {{targetLang}}: {{text}}",
      "duplicate-text",
    ],
    [
      "missing {{sourceLang}}",
      "to {{targetLang}}: {{text}}",
      "missing-source-lang",
    ],
    [
      "missing {{targetLang}}",
      "from {{sourceLang}}: {{text}}",
      "missing-target-lang",
    ],
  ];

  it.each(cases)("%s", (_label, raw, reason) => {
    const check = validatePromptTemplate(raw);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe(reason);
  });

  it("no minimum-length rule: the placeholders already imply one", () => {
    // {{sourceLang}}{{targetLang}}{{text}} is 36 chars, so a template that
    // passes the placeholder rules can never be "too short" — a minimum would
    // only fire alongside "missing placeholder" and report the weaker message.
    const shortest = "{{sourceLang}}{{targetLang}}{{text}}";
    expect(shortest.length).toBeGreaterThan(20);
    expect(validatePromptTemplate(shortest).ok).toBe(true);
  });

  it("every rejection reason maps to a distinct Fluent key", () => {
    // The engine reports `translation-error-ai-prompt-<reason>` (ztransplit.ftl)
    // and the pane reports `preferences-ztransplit-ai-prompt-error-<reason>`.
    const reasons = cases.map(([, , reason]) => reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("the placeholder list is the documented contract", () => {
    expect([...AI_PROMPT_PLACEHOLDERS]).toEqual([
      "text",
      "sourceLang",
      "targetLang",
    ]);
  });
});

describe("renderPrompt", () => {
  it("substitutes the text and both language names", () => {
    const out = renderPrompt(VALID, {
      text: "hello world",
      sourceLang: "English",
      targetLang: "Simplified Chinese",
    });
    expect(out).toBe("Translate from English to Simplified Chinese: hello world");
  });

  it("substitutes the language pair the engine resolves (auto-detect sentinel)", () => {
    const out = renderPrompt(VALID, {
      text: "x",
      sourceLang: "auto-detect",
      targetLang: "Japanese",
    });
    expect(out).toContain("from auto-detect to Japanese");
  });

  it("leaves unknown placeholders verbatim rather than blanking them", () => {
    const out = renderPrompt("{{text}} {{mystery}}", {
      text: "x",
      sourceLang: "a",
      targetLang: "b",
    });
    expect(out).toBe("x {{mystery}}");
  });

  it("leaves single-brace formula tokens alone", () => {
    const out = renderPrompt("{{targetLang}}: {{text}} keep {v0}", {
      text: "x",
      sourceLang: "a",
      targetLang: "b",
    });
    expect(out).toBe("b: x keep {v0}");
  });
});

describe("resolvePromptTemplate / promptFingerprint", () => {
  it("invalid non-empty templates fall back to the default (never throws)", () => {
    expect(resolvePromptTemplate("{{nope}}")).toBe(DEFAULT_AI_PROMPT);
    expect(resolvePromptTemplate(VALID)).toBe(VALID);
    expect(resolvePromptTemplate("")).toBe(DEFAULT_AI_PROMPT);
  });

  it("fingerprint is stable for equal templates and differs across edits", () => {
    expect(promptFingerprint(VALID)).toBe(promptFingerprint(VALID));
    expect(promptFingerprint(VALID)).not.toBe(promptFingerprint(`${VALID} `));
    // The default template is reachable through two representations ("" and the
    // literal text); both must fingerprint the same so the cache still hits.
    expect(promptFingerprint(resolvePromptTemplate(""))).toBe(
      promptFingerprint(DEFAULT_AI_PROMPT),
    );
  });
});
