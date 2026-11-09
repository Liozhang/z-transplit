/**
 * textFold — the one fold every containment check in the addon shares.
 *
 * "Fold" means the lossy form two strings are reduced to before they are
 * compared for containment: case-folded, ligatures expanded, apostrophes
 * unified, whitespace collapsed. PDF text extraction is why this is not just
 * `toLowerCase()`: extracted text carries presentation-form ligatures (ﬁ, ﬃ —
 * the same artifact LayoutPreservingRenderer defends against before drawing)
 * and a line break wherever the source PDF wrapped a line.
 *
 * The fold is for containment checks only — NEVER for index math. Slicing
 * always happens on the original string.
 *
 * Migrated verbatim from
 * src/core/wordcards/sentenceContext.ts#normalizeForMatch (behavior pinned by
 * tests/unit/core/wordcards/sentenceContext.test.ts) so the glossary matcher
 * and the sentence extractor share ONE definition instead of two.
 */

/** Ligature expansions so "ﬁx" still matches "fix". */
const LIGATURES: Record<string, string> = {
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬀ": "ff",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};

/**
 * Match form: lowercase, ligatures expanded, apostrophes unified, whitespace
 * collapsed, trimmed. Used for containment checks, never for index math.
 */
export function foldForMatch(text: string): string {
  let out = "";
  for (const ch of text || "") {
    const expansion = LIGATURES[ch];
    out += expansion !== undefined ? expansion.toLowerCase() : ch.toLowerCase();
  }
  return out.replace(/['’]/g, "'").replace(/\s+/g, " ").trim();
}
