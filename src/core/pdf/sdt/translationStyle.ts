/**
 * sdt/translationStyle — derive the translation block's inline style from the
 * computed style of the original paragraph it sits under.
 *
 * Why: the bilingual view injects our own blocks next to the document's own
 * paragraphs. Without this module every translation reads at one size and one
 * weight, so a heading's translation looks like body text and a caption's
 * translation looks like a heading. Reading the neighbour's computed style and
 * deriving from it keeps the document's own typographic hierarchy visible in
 * the translation, which is what "the translation belongs to this paragraph"
 * means visually.
 *
 * What is inherited, and what deliberately is not:
 *
 *   - font-size      the original's size times TRANSLATION_SIZE_RATIO, capped
 *                    at TRANSLATION_SIZE_CAP_PX. The ratio keeps the
 *                    translation subordinate to the original (it is the second
 *                    voice, never the first); the cap stops a display-size
 *                    title from producing an equally display-size translation.
 *   - font-weight    as-is. A bold heading's translation is bold.
 *   - font-style     as-is. An italic passage's translation is italic.
 *   - color          only when it stays readable. The interleave layer already
 *                    mutes the translation with opacity, so a light-grey
 *                    original (captions, footnotes, de-emphasised asides)
 *                    would compound into illegible ink. A colour whose contrast
 *                    against white is below WCAG AA for normal text is dropped
 *                    and the block keeps its inherited ink instead. Fully
 *                    transparent colours are dropped for the same reason.
 *   - font-family    NEVER. The original's family is whatever the PDF embedded
 *                    — a subset serif, a symbol face, a font whose glyphs cover
 *                    Latin only. Handing that to a Chinese translation produces
 *                    tofu. Our blocks keep the reading view's own family.
 *
 * Only the pure part lives here (parsing, the ratio, the contrast rule), so it
 * is unit-testable with no DOM. The DOM side reads getComputedStyle through
 * the element's own window — the blocks live in the SDT iframe, whose realm is
 * not the bundle's — and caches the derived declarations per refPath, because
 * a block is rebuilt more than once per session (read-aloud highlighting
 * rewrites its content, mode switches re-render) and the computed style of a
 * rendered paragraph does not change in between.
 *
 * @module core/pdf/sdt/translationStyle
 */

/** Translation size as a fraction of the original paragraph's size. */
export const TRANSLATION_SIZE_RATIO = 0.92;

/**
 * Upper bound for the derived size, in pixels. A 64px display title would
 * otherwise produce a 59px translation, which reads as a second title rather
 * than as the translation of one.
 */
export const TRANSLATION_SIZE_CAP_PX = 24;

/** WCAG AA contrast ratio for normal text, the floor for an inherited colour. */
export const MIN_CONTRAST_AGAINST_WHITE = 4.5;

/** The computed values this module reads off the original paragraph. */
export interface OriginalComputedStyle {
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
}

/** The inline declarations derived from them (absent = leave CSS default). */
export interface DerivedTranslationStyle {
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
}

/**
 * Parse a CSS length in pixels ("16px", "16.5px") to a number. Anything else
 * — "1em", "larger", "", a unit we do not model — returns null, and the caller
 * then leaves the size alone rather than guessing.
 */
export function parsePx(value: string | undefined): number | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Round to one decimal, so "15.520000000000001px" never reaches the DOM. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The derived font-size declaration for an original of `originalPx` pixels,
 * or null when the original's size is not a usable pixel length.
 */
export function deriveTranslationFontSize(originalPx: number): string | null {
  if (!Number.isFinite(originalPx) || originalPx <= 0) return null;
  const scaled = originalPx * TRANSLATION_SIZE_RATIO;
  return round1(Math.min(scaled, TRANSLATION_SIZE_CAP_PX)) + "px";
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1; a fully transparent colour is never inherited. */
  a: number;
}

/**
 * Parse the colour forms getComputedStyle actually returns: rgb(), rgba(),
 * and the transparent keyword. Named colours and modern space-separated
 * syntaxes return null — the caller then keeps its inherited colour, which is
 * always safe.
 */
export function parseColor(value: string | undefined): Rgba | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [r, g, b] = nums;
  const a = parts.length > 3 ? Number(parts[3]) : 1;
  return {
    r: clamp255(r),
    g: clamp255(g),
    b: clamp255(b),
    a: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1,
  };
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, n));
}

/** Relative luminance per WCAG 2.x (sRGB channels, 0–1). */
function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio of a colour against white (1 = invisible, 21 = black). */
export function contrastRatioAgainstWhite(color: Rgba): number {
  // White's luminance is 1 by definition, so the WCAG ratio collapses to
  // (1 + 0.05) / (L + 0.05). A fully transparent colour has no ink at all and
  // reads as the page's own background, which the ratio cannot express — the
  // caller screens alpha separately.
  const l = relativeLuminance(color);
  return 1.05 / (l + 0.05);
}

/**
 * Whether an original's colour may be handed to the translation: opaque enough
 * and dark enough to stay readable under the interleave layer's muted opacity.
 */
export function isReadableColor(value: string | undefined): boolean {
  const c = parseColor(value);
  if (!c) return false;
  if (c.a < 1) return false;
  return contrastRatioAgainstWhite(c) >= MIN_CONTRAST_AGAINST_WHITE;
}

/**
 * Derive the inline declarations for a translation block from the computed
 * style of its original paragraph. Every dimension is independent: an
 * unreadable colour does not cost the translation its size, and an
 * unparseable size does not cost it its colour.
 *
 * Values that equal the CSS baseline are skipped rather than written: an
 * inline declaration beats every stylesheet rule, so pinning "normal" on every
 * block would only take options away from the style layer for no visual gain.
 */
export function deriveTranslationStyle(
  computed: OriginalComputedStyle,
): DerivedTranslationStyle {
  const out: DerivedTranslationStyle = {};
  const px = parsePx(computed.fontSize);
  const size = px === null ? null : deriveTranslationFontSize(px);
  if (size) out.fontSize = size;
  const weight = String(computed.fontWeight ?? "").trim();
  if (weight && weight !== "normal" && weight !== "400") {
    out.fontWeight = weight;
  }
  const style = String(computed.fontStyle ?? "").trim();
  if (style && style !== "normal") out.fontStyle = style;
  if (isReadableColor(computed.color)) out.color = String(computed.color).trim();
  return out;
}

/** Apply derived declarations to an element (never clears what it omits). */
export function applyDerivedStyle(
  el: HTMLElement,
  derived: DerivedTranslationStyle,
): void {
  if (derived.fontSize) el.style.fontSize = derived.fontSize;
  if (derived.fontWeight) el.style.fontWeight = derived.fontWeight;
  if (derived.fontStyle) el.style.fontStyle = derived.fontStyle;
  if (derived.color) el.style.color = derived.color;
}

/**
 * Read the original paragraph's computed style and derive the translation
 * block's style from it. Defensive by contract: a host without
 * getComputedStyle, an element outside a rendered window, or a style value we
 * do not model all leave the block on its CSS baseline instead of throwing —
 * the bilingual view must survive a reading view we failed to introspect.
 */
export function adoptOriginalStyle(
  translationEl: HTMLElement,
  originalEl: HTMLElement,
): DerivedTranslationStyle {
  let derived: DerivedTranslationStyle = {};
  try {
    const view =
      (originalEl.ownerDocument as Document | null)?.defaultView ?? null;
    const computed = view?.getComputedStyle?.(originalEl);
    if (computed) {
      derived = deriveTranslationStyle({
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        fontStyle: computed.fontStyle,
        color: computed.color,
      });
    }
  } catch {
    derived = {};
  }
  applyDerivedStyle(translationEl, derived);
  return derived;
}
