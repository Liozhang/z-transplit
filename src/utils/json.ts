import { safeDebug } from "./logger";

/**
 * Parse JSON out of an LLM/engine response. Never throws.
 *
 * Three-step fallback: markdown code block → direct JSON.parse → regex extract
 * of the first {...} object or [...] array. Returns null when every step fails.
 *
 * Reduced port of leadero/src/utils/json.ts (the extra helpers —
 * extractFirstJsonObject / shrinkToValidJson / safeJsonParse — are left behind
 * until a caller needs them).
 */
export function parseJsonFromMarkdown(content: string): any {
  if (!content) return null;
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      safeDebug(`[Z-Transplit] parseJsonFromMarkdown: ${String(e)}`);
      // fall through
    }
  }
  try {
    return JSON.parse(content.trim());
  } catch (e) {
    safeDebug(`[Z-Transplit] parseJsonFromMarkdown: ${String(e)}`);
    const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e2) {
        safeDebug(`[Z-Transplit] parseJsonFromMarkdown: ${String(e2)}`);
        return null;
      }
    }
  }
  return null;
}
