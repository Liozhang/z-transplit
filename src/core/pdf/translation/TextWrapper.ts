/**
 * TextWrapper — CJK-aware line wrapping for the layout-preserving PDF renderer.
 *
 * Pure text-processing functions extracted from LayoutPreservingRenderer.ts.
 * No pdf-lib dependency — only font width measurement through a callback so
 * this module stays testable as a standalone unit.
 *
 * Ported from leadero's src/core/pdf/translation/TextWrapper.ts (verbatim,
 * zero imports — covered by tests/unit/core/pdf/textWrapper.test.ts).
 */


/**
 * Characters that must NOT begin a line (CJK 禁則 — 避頭點).
 * Placing these at line-start is typographically wrong in CJK and also looks
 * broken to readers. We push them back to the previous line when wrapping.
 */
export const NO_LINE_START = new Set([
  "，", "。", "、", "；", "：", "）", "】", "》", "」", "』", "’", "”",
  "！", "？", "·", "…", "—",
  ",", ".", ";", ":", ")", "]", "}", "!", "?",
]);

/**
 * Characters that must NOT end a line (CJK 禁則 — 避腳點).
 */
export const NO_LINE_END = new Set([
  "（", "【", "《", "「", "『", "“", "‘",
  "(", "[", "{", "\"", "'",
]);

/**
 * Is `ch` a CJK ideograph or CJK punctuation? Used to decide whether
 * char-level wrapping is allowed (CJK has no inter-word spaces, so the only
 * valid break points are between any two characters).
 */
export function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  // CJK Unified Ideographs, CJK Ext A, CJK Compatibility, Hiragana, Katakana,
  // CJK Symbols & Punctuation, Hangul Syllables.
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef) // Full-width ASCII / Halfwidth
  );
}

/**
 * Heuristic: does `s` look like a URL / long token that should NOT be split
 * across lines character-by-character? True for strings containing `://`, long
 * `/`-separated paths, or long runs of ASCII without spaces.
 */
export function looksLikeUrlOrToken(s: string): boolean {
  if (s.includes("://")) return true;
  // Long path-like token: contains `/` and is mostly ASCII letters/digits/punct.
  if (s.includes("/") && s.length > 12) {
    const ascii = [...s].filter((c) => c.charCodeAt(0) < 128).length;
    if (ascii / s.length > 0.8) return true;
  }
  return false;
}


/**
 * Mixed CJK/Latin line wrapper — the fix for the Phase 1 bug where CJK text
 * (no inter-word spaces) was treated as a single "word" and drawn as one
 * overflow line that bled across neighboring columns.
 *
 * Strategy (mirrors converter.py's per-glyph advance loop at finer granularity
 * than the old word-only wrap):
 *   - Walk the string left-to-right, accumulating characters into the current
 *     line until adding the next char would exceed `maxWidth`.
 *   - At Latin/digit runs, prefer breaking at the space boundary (so English
 *     words stay intact when possible).
 *   - At CJK chars, allow breaking between any two characters (CJK standard).
 *   - Apply 禁則 (kinsoku): never start a line with a closing punctuation,
 *     never end a line with an opening punctuation. Push the offending char.
 *
 * This keeps English behaviour identical to the old word-wrap while making
 * Chinese/Japanese/Korean actually wrap instead of overflowing.
 */
export function wrapTextMixed(
  text: string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): string[] {
  if (text.length === 0) return [text];
  // Fast path: whole text fits on one line.
  if (measureWidth(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let line = "";

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const candidate = line + ch;
    const fits = measureWidth(candidate) <= maxWidth;

    if (fits) {
      line = candidate;
      i++;
      continue;
    }

    // `ch` doesn't fit on the current line. Decide where to break.
    // Case A: current line is empty (single char already too wide) — force-emit
    // the char so we make progress and don't infinite-loop.
    if (line.length === 0) {
      lines.push(ch);
      i++;
      line = "";
      continue;
    }

    // Case B: break before `ch`. But first check kinsoku: if `ch` is a
    // no-line-start punctuation, it must stay with the previous line.
    if (NO_LINE_START.has(ch)) {
      // Push `ch` onto current line (even though it overflows slightly — a
      // single punctuation glyph overhang is far better than starting a line
      // with ，or 。).
      line += ch;
      lines.push(line);
      i++;
      line = "";
      continue;
    }

    // Case C: kinsoku on the line tail — if the last char of `line` is an
    // opening bracket, it shouldn't end the line; pull it to the next line.
    // Guard `line.length > 1`: when the line is a single opener, removing it
    // leaves an empty prefix and the next iteration would re-trigger Case C
    // forever (the opener alone can't advance `i`). Letting a single opener
    // fall through to Case E forces progress and avoids the infinite loop.
    if (line.length > 1 && NO_LINE_END.has(line[line.length - 1])) {
      const opener = line[line.length - 1];
      lines.push(line.slice(0, -1));
      line = opener;
      continue;
    }

    // Case D: normal break. If we're in the middle of a Latin word and there's
    // a recent space, break at the space to avoid splitting English words.
    const lastSpace = line.lastIndexOf(" ");
    if (lastSpace > 0 && !isCJK(ch) && !isCJK(line[line.length - 1])) {
      lines.push(line.slice(0, lastSpace));
      line = line.slice(lastSpace + 1);
      // don't advance i — re-process ch against the trimmed line
      continue;
    }

    // Case D2: the current line is a single long unbroken token (no spaces) —
    // typically a URL, DOI, or long identifier. Don't fall through to Case E
    // (which would split it character-by-character into `h-t-t-p-s-:-/`). Push
    // the whole token onto its own line even though it overflows maxWidth — a
    // single over-wide line is far more readable than a shattered URL. We then
    // start fresh with `ch`.
    if (lastSpace <= 0 && line.length > 8 && looksLikeUrlOrToken(line)) {
      lines.push(line);
      line = "";
      continue;
    }

    // Case E: generic break before ch.
    lines.push(line);
    line = "";
    // don't advance i — ch starts the next line
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
