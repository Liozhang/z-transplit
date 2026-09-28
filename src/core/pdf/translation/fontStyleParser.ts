/**
 * fontStyleParser — Recover bold/italic/text-color hints that OpenDataLoader
 * folds into opaque strings.
 *
 * ODL's `ODLTextProperties` carries two style-bearing fields the original
 * Phase 1 renderer discarded:
 *   - `font`: a PostScript-ish name like `TimesNewRomanPS-BoldMT` whose
 *     suffixes encode weight/style (`-Bold`, `-Italic`, `-BoldItalic`,
 *     `-Heavy`, `-Black`, `-Light`, `-Oblique`, …).
 *   - `textColor`: a CSS-ish color string in one of several formats
 *     (`#RRGGBB`, `rgb(r,g,b)`, `r,g,g`, plain names).
 *
 * The original renderer ignored both and drew everything in Helvetica/Noto
 * Regular black. This module parses them into structured flags so the
 * renderer can pick a font variant and a non-default fill color when the
 * corresponding assets are available.
 *
 * Pure functions — safe to unit-test in Node without Zotero/PDF deps.
 *
 * Ported from leadero's src/core/pdf/translation/fontStyleParser.ts (verbatim).
 *
 * @module core/pdf/translation/fontStyleParser
 */

export interface FontStyle {
  bold: boolean;
  italic: boolean;
}

// Style tokens encoded in PostScript / LaTeX font names. We deliberately do NOT
// use a regex with the `/i` flag here, because `/i` also makes character CLASSES
// case-insensitive in JS — that breaks boundary detection on `[-A-Z]` /
// `[^a-z]` constructs (they silently match lowercase too), causing false
// positives like `Blackboard` matching `Black`. Instead we match the token
// case-insensitively via an explicit alternation of lower/upper and verify
// CamelCase boundaries by inspecting neighbouring characters in code.
//
// Token list covers the real font names observed in ODL output:
//   - PostScript: NimbusRomNo9L-Medi, -ReguItal, -Regu-Slant_167
//   - LaTeX/Computer Modern: CMBX10 (Bold eXtended), CMMI10 (Math Italic),
//     CMTI10 (Text Italic), CMSY10 (Symbol)
//   - Standard: TimesNewRomanPS-BoldMT, Arial-ItalicMT
// (The actual token lists are split into STRICT_* and SUFFIX_* below, next to
// the matcher, because they need different boundary rules.)

/**
 * Tokens that must appear as a complete CamelCase/hyphen word (strict
 * boundaries). These long forms are unambiguous.
 */
const STRICT_TOKENS_BOLD = ["bold", "black", "heavy", "semibold", "demibold", "medium"];
const STRICT_TOKENS_ITALIC = ["italic", "oblique", "slant"];
/**
 * Abbreviation/suffix tokens that may follow other word parts in a CamelCase
 * font name (e.g. `NimbusRomNo9L-Medi`, `NimbusRomNo9L-ReguItal`, `CMBX10`,
 * `CMMI10`, `CMTI10`). For these we match case-insensitively and require only
 * that they appear as a suffix or immediately after an uppercase letter /
 * hyphen — i.e. NOT in the middle of a lowercase run (to avoid `ital` matching
 * inside `capitalist`).
 */
const SUFFIX_TOKENS_BOLD = ["medi", "med", "bx"];
const SUFFIX_TOKENS_ITALIC = ["ital", "itali", "mi", "ti", "it"];

/**
 * Does `name` contain `token` as a complete CamelCase/hyphen word?
 *
 * A match is "complete" when the char immediately before is start-of-string,
 * a hyphen, or an uppercase letter, AND the char immediately after is
 * end-of-string, a hyphen, or an uppercase letter. This accepts
 * `Arial-BoldItalicMT` (both Bold and Italic match) but rejects `Blackboard`
 * (Black is followed by lowercase `b`) and `Boldface` (followed by lowercase `f`).
 *
 * The token alternation is lowercased, so matching is case-insensitive without
 * needing the regex `/i` flag (which would corrupt the boundary checks).
 */
function containsStyleToken(
  name: string,
  strictTokens: string[],
  suffixTokens: string[],
): boolean {
  const lower = name.toLowerCase();

  // 1) Strict tokens: full-word match with non-lowercase boundaries on BOTH
  //    sides. Rejects `Blackboard` (Black + b) and `Boldface` (Bold + f),
  //    accepts `Bold`, `BoldMT`, `Arial-BoldItalicMT`.
  for (const tok of strictTokens) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(tok, from);
      if (idx < 0) break;
      const leftChar = idx > 0 ? name[idx - 1] : "";
      const leftOk =
        leftChar === "" || leftChar === "-" || !(leftChar >= "a" && leftChar <= "z");
      const rightIdx = idx + tok.length;
      const rightChar = rightIdx < name.length ? name[rightIdx] : "";
      const rightOk =
        rightChar === "" || rightChar === "-" || !(rightChar >= "a" && rightChar <= "z");
      if (leftOk && rightOk) return true;
      from = idx + 1;
    }
  }

  // 2) Suffix tokens: the char IMMEDIATELY before must be uppercase, hyphen,
  //    digit, or start-of-string. This lets `Ital` match in `ReguItal` (prev
  //    char `u` is lowercase → FAIL) — so instead we ALSO accept when the
  //    suffix is at the END of the string or followed by digits/end. To handle
  //    `ReguItal`, treat the whole thing case-insensitively and match the
  //    suffix anywhere it's preceded by a non-lowercase OR is itself preceded
  //    by a lowercase letter that is part of a CamelCase seam. Practically:
  //    accept the suffix if it appears and the following char is not a
  //    lowercase letter (right boundary only). This is more permissive but the
  //    suffix list is short and specific enough to avoid false positives.
  for (const tok of suffixTokens) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(tok, from);
      if (idx < 0) break;
      const rightIdx = idx + tok.length;
      const rightChar = rightIdx < name.length ? name[rightIdx] : "";
      // Right boundary: must NOT be followed by a lowercase letter (so `it`
      // inside `with` won't match, but `It` in `CMTI10` → `it` followed by
      // `1` → OK; `Ital` in `ReguItal` at end → OK).
      const rightOk =
        rightChar === "" || rightChar === "-" || !(rightChar >= "a" && rightChar <= "z");
      // Left boundary for very short tokens (2-char like `mi`,`it`,`bx`):
      // require the preceding char to be uppercase, hyphen, digit, or start,
      // to avoid matching `mi` inside `family`. For 3+ char suffixes (`medi`,
      // `ital`) the left boundary can be anything since the token is specific.
      const leftChar = idx > 0 ? name[idx - 1] : "";
      const isShort = tok.length <= 2;
      const leftOk = isShort
        ? (leftChar === "" || leftChar === "-" || (leftChar >= "A" && leftChar <= "Z") || (leftChar >= "0" && leftChar <= "9"))
        : true;
      if (leftOk && rightOk) return true;
      from = idx + 1;
    }
  }
  return false;
}

/**
 * Parse a PostScript-ish font name into bold/italic flags.
 *
 * Handles the common concatenated form `*-BoldItalic*` where two style tokens
 * sit directly adjacent (no hyphen, no CamelCase seam between them).
 *
 * @example parseFontStyle("TimesNewRomanPS-BoldMT") → { bold: true, italic: false }
 * @example parseFontStyle("Arial-ItalicMT")         → { bold: false, italic: true }
 * @example parseFontStyle("Arial-BoldItalicMT")     → { bold: true, italic: true }
 * @example parseFontStyle("Helvetica")              → { bold: false, italic: false }
 */
export function parseFontStyle(fontName: string | undefined | null): FontStyle {
  if (!fontName) return { bold: false, italic: false };
  const bold = containsStyleToken(fontName, STRICT_TOKENS_BOLD, SUFFIX_TOKENS_BOLD);
  const italic = containsStyleToken(fontName, STRICT_TOKENS_ITALIC, SUFFIX_TOKENS_ITALIC);
  // Catch concatenated `BoldItalic` / `ItalicBold` where the second token's
  // left neighbour is the first token's trailing lowercase letter, which
  // strict matching would reject as a non-boundary.
  const lower = fontName.toLowerCase();
  const hasConcat =
    /bolditalic/.test(lower) || /italicbold/.test(lower);
  return {
    bold: bold || hasConcat,
    italic: italic || hasConcat,
  };
}

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

const NAMED_COLORS: Record<string, RGBColor> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 1, g: 1, b: 1 },
  red: { r: 1, g: 0, b: 0 },
  green: { r: 0, g: 0.502, b: 0 },
  blue: { r: 0, g: 0, b: 1 },
  yellow: { r: 1, g: 1, b: 0 },
  cyan: { r: 0, g: 1, b: 1 },
  magenta: { r: 1, g: 0, b: 1 },
  gray: { r: 0.502, g: 0.502, b: 0.502 },
  grey: { r: 0.502, g: 0.502, b: 0.502 },
};

/**
 * Parse a color string (ODL `textColor` or similar) into 0–1 RGB.
 *
 * Accepts:
 *   - `#RGB`, `#RRGGBB`, `#RRRGGGBBB`, `#RRGGGGBBBB` hex
 *   - `rgb(r,g,b)` / `rgba(r,g,b,a)` with r,g,b in 0–255 or 0–100% or 0–1
 *   - bare `r,g,b` / `r g b` triples (same numeric ranges)
 *   - CSS named colors (red, blue, …)
 *
 * Returns `null` for empty/unknown input so callers fall back to the default
 * (black) without erroring.
 *
 * @example parseTextColor("#FF0000")        → { r:1, g:0, b:0 }
 * @example parseTextColor("rgb(0,0,255)")   → { r:0, g:0, b:1 }
 * @example parseTextColor("0.8,0.2,0.1")    → { r:0.8, g:0.2, b:0.1 }
 * @example parseTextColor("blue")           → { r:0, g:0, b:1 }
 * @example parseTextColor("")               → null
 */
export function parseTextColor(
  colorStr: string | undefined | null,
): RGBColor | null {
  if (!colorStr) return null;
  const s = colorStr.trim().toLowerCase();
  if (!s) return null;

  // Named color
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];

  // Bracketed array form — the format OpenDataLoader actually emits for
  // `text color`. Empirically observed values: `[0.7]` (gray),
  // `[0.0]` (black), `[0.0, 0.0, 1.0]` (blue), `[0.7, 0.0, 0.0]` (dark red).
  // Components are floats in 0–1. One component = grayscale, three = RGB.
  const bracketMatch = s.match(/^\[\s*([\d.,\s]+)\s*\]$/);
  if (bracketMatch) {
    const parts = bracketMatch[1]
      .split(/[,\s]+/)
      .filter((p) => p.length > 0)
      .map((p) => parseFloat(p));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 1) {
      const v = parts[0];
      return { r: v, g: v, b: v };
    }
    if (parts.length >= 3) {
      return { r: parts[0], g: parts[1], b: parts[2] };
    }
    return null;
  }

  // Hex: #RGB / #RRGGBB / #RRRGGGBBB / #RRGGGGBBBB
  const hexMatch = s.match(/^#([0-9a-f]+)$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    let r: number, g: number, b: number;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else if (hex.length === 9 || hex.length === 12) {
      // #RRRRGGGGBBBB (16-bit) or #RRRGGGBBB — normalize per channel width
      const cw = hex.length / 3;
      const ch = (i: number) => parseInt(hex.slice(i * cw, (i + 1) * cw), 16);
      const max = Math.pow(16, cw) - 1;
      r = ch(0);
      g = ch(1);
      b = ch(2);
      return { r: r / max, g: g / max, b: b / max };
    } else {
      return null;
    }
    return { r: r / 255, g: g / 255, b: b / 255 };
  }

  // rgb()/rgba() functional notation
  const fnMatch = s.match(/^rgba?\(\s*([^)]+)\s*\)$/i);
  // Bare triples may include `%` (e.g. `100%,0%,0%`), so allow it in the
  // pre-check; the per-component parser handles the `%` suffix.
  const tripleSource = fnMatch ? fnMatch[1] : /^[\d.,\s%]+$/.test(s) ? s : null;
  if (tripleSource) {
    const parts = tripleSource.split(/[,\s]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return null;
    const [rStr, gStr, bStr] = parts;
    const parseComp = (v: string): number => {
      if (v.endsWith("%")) return parseFloat(v) / 100;
      const n = parseFloat(v);
      // Heuristic: any value > 1 is on a 0–255 scale; 0–1 stays as-is.
      return n > 1 ? n / 255 : n;
    };
    const r = parseComp(rStr);
    const g = parseComp(gStr);
    const b = parseComp(bStr);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }

  return null;
}
