/**
 * formulaShield — 把公式从翻译请求里摘出来，译文回来后放回去。
 *
 * Why this exists: the formula-preserving prompt only reaches model-backed
 * engines ("ai" and "custom") because they accept a system prompt at all.
 * Traditional MT APIs (Google, Bing, DeepL, youdao, the Zotero bridge) take a
 * bare `q: text` body — there is no prompt to protect anything. Google is the
 * factory default, so on a stock install every formula in the document is sent
 * to an engine that will cheerfully rewrite `Σ` into a Latin letter and `²`
 * into a plain `2`.
 *
 * The fix has to sit outside the engine: replace each formula with an opaque
 * token before the request, put the original back after. That is what this
 * module does, and it works for every engine because it never asks the engine
 * to cooperate.
 *
 * Token choice: `⟦F0⟧` (U+27E6/U+27E7 mathematical white square brackets).
 * A token that looks like natural language gets translated or dropped; one that
 * looks like a stray symbol is far more likely to survive verbatim. Engines do
 * still mangle them sometimes, so `restoreFormulas` degrades instead of losing
 * content — see below.
 *
 * @module core/pdf/translation/formulaShield
 */

export interface FormulaSlot {
  /** Index embedded in the placeholder token. */
  id: number;
  /** The formula's original text, without the surrounding `$`. */
  latex: string;
}

export interface ShieldResult {
  /** Text with every formula replaced by a placeholder token. */
  shielded: string;
  /** What to restore, in order. Empty when there was nothing to shield. */
  slots: FormulaSlot[];
}

export interface RestoreResult {
  /** Text with placeholders swapped back for their formulas. */
  text: string;
  /** How many placeholders were successfully swapped back. */
  restored: number;
  /** Formulas whose placeholder was mangled or dropped by the engine. */
  lost: string[];
}

/**
 * Match `$...$` and `$$...$$`. The double-dollar form is tried first so a
 * display formula isn't split into two empty inline matches.
 */
const FORMULA_DOLLAR_RE = /\$\$([^$]*)\$\$|\$([^$]*)\$/g;

/** Placeholder as this module emits it. */
const PLACEHOLDER_RE = /⟦F(\d+)⟧/g;

/** Tolerant form: engines sometimes insert whitespace between the glyphs. */
const PLACEHOLDER_LOOSE_RE = /⟦\s*F\s*(\d+)\s*⟧/g;

/** Residue we can attribute to a placeholder with certainty. */
const PLACEHOLDER_RESIDUE_RE = /⟦[^⟧]*⟧?/g;

/**
 * Replace every `$...$` span with a placeholder token.
 *
 * Empty formulas (`$$`) are left in place — an empty token would be invisible
 * to `restoreFormulas` and the original text is shorter anyway.
 */
export function shieldFormulas(text: string): ShieldResult {
  if (!text) return { shielded: text, slots: [] };
  const slots: FormulaSlot[] = [];
  const shielded = text.replace(
    FORMULA_DOLLAR_RE,
    (match, double: string | undefined, single: string | undefined) => {
      const latex = (double ?? single ?? "").trim();
      if (!latex) return match;
      slots.push({ id: slots.length, latex });
      return `⟦F${slots.length - 1}⟧`;
    },
  );
  return { shielded, slots };
}

/**
 * Swap placeholders back for their formulas.
 *
 * Degradation, in order:
 *   1. Exact match — the common case.
 *   2. Whitespace-tolerant match — engines that pad the glyphs.
 *   3. Placeholder gone entirely — the formula is appended to the end of the
 *      paragraph. Its position is wrong, but the content survives, and a
 *      misplaced formula beats a silently vanished one.
 *   4. Residue with a mathematical bracket still attached is stripped, since we
 *      can attribute it to a placeholder with certainty. A placeholder mangled
 *      into plain `[F0]` is left alone — the risk of eating legitimate square
 *      brackets from the body text outweighs the cosmetic gain.
 */
export function restoreFormulas(text: string, slots: FormulaSlot[]): RestoreResult {
  if (slots.length === 0 || !text) return { text, restored: 0, lost: [] };

  const found = new Set<number>();
  let restored = 0;
  const swapped = text.replace(PLACEHOLDER_LOOSE_RE, (match, id: string) => {
    const n = Number(id);
    const slot = slots.find((s) => s.id === n);
    if (!slot) return match;
    found.add(n);
    restored++;
    return `$${slot.latex}$`;
  });

  const lost = slots.filter((s) => !found.has(s.id));
  if (lost.length === 0) {
    return { text: stripPlaceholderResidue(swapped), restored, lost: [] };
  }

  const tail = lost.map((s) => `$${s.latex}$`).join(" ");
  return {
    text: stripPlaceholderResidue(`${swapped} ${tail}`.trim()),
    restored,
    lost: lost.map((s) => s.latex),
  };
}

function stripPlaceholderResidue(text: string): string {
  return text.replace(PLACEHOLDER_RESIDUE_RE, "");
}

/** Whether a text contains any placeholder token (used by tests and diagnostics). */
export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(text);
}
