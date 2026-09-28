/**
 * featureReadiness — engine-aware translation readiness check.
 *
 * Ported from leadero's src/core/config/FeatureReadiness.ts#checkTranslation,
 * minus its AI-provider branch: z-transplit has no model registry, so the
 * "is a model configured?" question disappears and each engine declares its
 * own credential requirements.
 *
 *   - google               → always ready (keyless free endpoint + keyless
 *                            Bing web fallback need no configuration; the
 *                            optional API key only upgrades it)
 *   - bing / deepl         → need translate.<engine>.apiKey
 *   - custom               → needs translate.custom.apiUrl AND
 *                            translate.custom.apiKey
 *   - ai                   → needs translate.ai.apiUrl, plus a prompt template
 *                            that passes validatePromptTemplate (an empty
 *                            template is valid — it means "use the default")
 *   - zotero-pdf-translate → needs the external plugin to be present
 *                            (Zotero.PDFTranslate); a host without the Zotero
 *                            global reports "not ready" instead of throwing
 *
 * Pure: no pref writes, no network, no side effects beyond reading prefs.
 */

import { getPrefDynamic, type PrefValue } from "../../utils/prefs";
import { validatePromptTemplate } from "./promptTemplate";

export interface TranslationReadinessStep {
  prefKey: string;
  /** Fluent message id (no `ztransplit-` prefix) describing the gap. */
  reasonKey: string;
}

export interface TranslationReadiness {
  ready: boolean;
  missing: TranslationReadinessStep[];
}

/** Pref reader injection point (tests; defaults to the real dynamic prefs). */
export type PrefReader = (key: string) => PrefValue | undefined;

function prefValue(getPref: PrefReader, key: string): string {
  const v = getPref(key);
  return v !== undefined && v !== null ? String(v) : "";
}

/**
 * True when the zotero-pdf-translate plugin API is reachable. Must never throw
 * on hosts without the Zotero global (vitest, plain Node).
 */
function hasPDFTranslatePlugin(): boolean {
  if (typeof Zotero === "undefined") return false;
  try {
    return Boolean((Zotero as any)?.PDFTranslate?.api?.translate);
  } catch {
    return false;
  }
}

/**
 * Engine-aware readiness for the translation feature.
 *
 * @param getPref Pref reader; defaults to z-transplit's dynamic prefs.
 */
export function checkTranslationReadiness(
  getPref: PrefReader = getPrefDynamic,
): TranslationReadiness {
  const engine = prefValue(getPref, "translate.engineType") || "google";
  const missing: TranslationReadinessStep[] = [];

  switch (engine) {
    case "google":
      // Default engine: the keyless free endpoint (with keyless Bing web
      // fallback) needs no configuration; the optional API key only upgrades it.
      return { ready: true, missing: [] };
    case "bing":
    case "deepl": {
      const key = `translate.${engine}.apiKey`;
      if (!prefValue(getPref, key)) {
        missing.push({
          prefKey: key,
          reasonKey: "readiness-reason-engine-key",
        });
      }
      return { ready: missing.length === 0, missing };
    }
    case "custom": {
      if (!prefValue(getPref, "translate.custom.apiUrl")) {
        missing.push({
          prefKey: "translate.custom.apiUrl",
          reasonKey: "readiness-reason-engine-url",
        });
      }
      if (!prefValue(getPref, "translate.custom.apiKey")) {
        missing.push({
          prefKey: "translate.custom.apiKey",
          reasonKey: "readiness-reason-engine-key",
        });
      }
      return { ready: missing.length === 0, missing };
    }
    case "ai": {
      // The endpoint is required; the key is not — local gateways (Ollama,
      // LM Studio) usually need none, and openaiCompat sends the Authorization
      // header only when a key is actually configured.
      if (!prefValue(getPref, "translate.ai.apiUrl")) {
        missing.push({
          prefKey: "translate.ai.apiUrl",
          reasonKey: "readiness-reason-engine-url",
        });
      }
      // An invalid template is a configuration gap the user must close: the
      // engine refuses to translate otherwise, so reporting it here turns a
      // silent failure at first use into a pointer to the settings pane.
      const prompt = getPref("translate.ai.prompt");
      if (!validatePromptTemplate(prompt === undefined ? undefined : String(prompt)).ok) {
        missing.push({
          prefKey: "translate.ai.prompt",
          reasonKey: "readiness-reason-ai-prompt",
        });
      }
      return { ready: missing.length === 0, missing };
    }
    case "zotero-pdf-translate":
      if (!hasPDFTranslatePlugin()) {
        missing.push({
          prefKey: "translate.engineType",
          reasonKey: "readiness-reason-engine-plugin",
        });
      }
      return { ready: missing.length === 0, missing };
    default:
      // Unknown engine id — treat it like the custom engine (the dispatcher's
      // fallback) and ask for its credentials, which is the actionable gap.
      if (!prefValue(getPref, "translate.custom.apiUrl")) {
        missing.push({
          prefKey: "translate.custom.apiUrl",
          reasonKey: "readiness-reason-engine-url",
        });
      }
      if (!prefValue(getPref, "translate.custom.apiKey")) {
        missing.push({
          prefKey: "translate.custom.apiKey",
          reasonKey: "readiness-reason-engine-key",
        });
      }
      return { ready: missing.length === 0, missing };
  }
}
