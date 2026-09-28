/**
 * formulaExtractor — Convert a formula region crop (PNG data URL) to LaTeX via
 * the configured vision-capable model.
 *
 * Motivation: OpenDataLoader's pure heuristic engine does not detect formulas —
 * it folds formula characters (Σ ∫ √ α β …) into ordinary paragraph text, which
 * the translation model then corrupts. To avoid that pollution, the translate
 * pipeline crops each formula-bearing paragraph's bbox to an image and asks the
 * vision model for its LaTeX representation. The LaTeX is spliced back into the
 * paragraph text (wrapped in $...$), where translateParagraphs' formula-preserving
 * prompt keeps it verbatim through translation.
 *
 * Ported from leadero's src/core/pdf/translation/formulaExtractor.ts. leadero
 * resolved the vision channel through its AI provider registry
 * (`AIProviderRegistry.getProviderForFeature("vision")`); z-transplit has no
 * provider registry, so this module talks to the SAME user-configured
 * OpenAI-compatible endpoint the "custom" translation engine uses
 * (translate.custom.apiUrl / apiKey / model), with an `image_url` content part.
 * No new prefs, no second credential set.
 *
 * The request is a plain fetch (not openaiCompat.chat): the shared client's
 * message type is text-only, and vision needs a multimodal content array. The
 * URL normalization + Bearer logic mirrors openaiCompat exactly.
 *
 * @module core/pdf/translation/formulaExtractor
 */

import { normalizeChatCompletionsUrl } from "../../ai/openaiCompat";
import { getPrefDynamic } from "../../../utils/prefs";
import { safeDebug } from "../../../utils/logger";
import { abortSignalTimeout } from "../../../utils/abort";

const FORMULA_TO_LATEX_PROMPT = `You are an OCR engine specialized in mathematical formulas. Look at the formula in the image and convert it to LaTeX.

Rules:
- Output ONLY the LaTeX code, nothing else. No explanations, no markdown fences.
- Wrap inline math in single dollar signs: $...$
- Wrap display/block math in double dollar signs: $$...$$
- Preserve subscripts (_), superscripts (^), fractions (\\frac), sums (\\sum), integrals (\\int), Greek letters (\\alpha, \\beta, ...), and all operators exactly.
- If the image contains no formula or is unreadable, output the single word: NONE`;

/** Credentials for the vision call — the custom engine's endpoint. */
function visionConfig(): { apiUrl: string; apiKey?: string; model?: string } | null {
  const apiUrl = String(getPrefDynamic("translate.custom.apiUrl") || "");
  if (!apiUrl) return null;
  return {
    apiUrl,
    apiKey: getPrefDynamic("translate.custom.apiKey")
      ? String(getPrefDynamic("translate.custom.apiKey"))
      : undefined,
    model: getPrefDynamic("translate.custom.model")
      ? String(getPrefDynamic("translate.custom.model"))
      : undefined,
  };
}

/**
 * Check whether a vision-capable model is available (for pre-flight gating/UX).
 * True when the OpenAI-compatible endpoint is configured — the same endpoint
 * serves formula OCR. Never throws on hosts without the Zotero global.
 */
export function isFormulaVisionAvailable(): boolean {
  try {
    return visionConfig() !== null;
  } catch (e) {
    safeDebug("[Z-Transplit] formulaExtractor: " + e);
    return false;
  }
}

/**
 * Convert a formula image (PNG data URL) to a LaTeX string via the vision model.
 *
 * @param imageDataUrl `data:image/png;base64,...` crop of the formula region.
 * @returns LaTeX wrapped in `$...$` / `$$...$$`, or the original passthrough
 *   sentinel "NONE" if the model saw no formula. On endpoint/parse failure, the
 *   thrown error is caught by the caller and the paragraph keeps its original
 *   text (or falls back to the screenshot paste).
 */
export async function extractFormulaLatex(
  imageDataUrl: string,
): Promise<string> {
  const cfg = visionConfig();
  if (!cfg) {
    throw new Error(
      "公式视觉提取不可用：未配置 OpenAI 兼容端点（translate.custom.apiUrl）。",
    );
  }

  const url = normalizeChatCompletionsUrl(cfg.apiUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      // Empty model pref = let the server pick its default — omit the field
      // instead of sending an empty model id (same contract as openaiCompat).
      ...(cfg.model ? { model: cfg.model } : {}),
      // Multimodal content array — the OpenAI vision wire format.
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: FORMULA_TO_LATEX_PROMPT },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 1024,
    }),
    signal: abortSignalTimeout(60_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Vision model HTTP ${resp.status}: ${text || resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  const latex = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!latex) {
    throw new Error("视觉模型返回空结果");
  }
  // The model occasionally wraps output in markdown fences despite the rule;
  // strip them so downstream rendering draws clean LaTeX.
  return latex.replace(/^```[a-zA-Z]*\n?|\n?```$/g, "").trim();
}
