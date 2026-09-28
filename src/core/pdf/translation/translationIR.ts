/**
 * translationIR — Intermediate Representation for layout-preserving PDF translation.
 *
 * These types are the contract between the three pipeline stages (A: assemble, B: translate,
 * C: render), mirroring the parallel-array model in converter.py where `sstk[i]`
 * (text), `pstk[i]` (geometry), and the translated `news[i]` all align by index `i`.
 *
 * Coordinate system: PDF user space (origin at bottom-left, y up) — same as
 * RawTextItem.transform and the pdf.js viewport. converter.py operates in the
 * same space, so no flipping is needed for text items.
 *
 * Ported from leadero's src/core/pdf/translation/translationIR.ts (pure types).
 *
 * @module core/pdf/translation/translationIR
 */


/**
 * Geometry of one assembled paragraph. Fields map 1:1 to converter.py's
 * Paragraph. `brk` is the line-break guard consumed by the C-stage wrap logic
 * (converter.py — wrap only happens when `brk && x+adv > x1+0.1*size`).
 */
export interface Paragraph {
  /** Initial vertical position of the paragraph (baseline region). */
  y: number;
  /** Initial horizontal position of the paragraph (first char left edge). */
  x: number;
  /** Left boundary — translated text wraps within [x0, x1]. */
  x0: number;
  /** Right boundary. */
  x1: number;
  /** Paragraph bbox LOWER edge (bottom), in PDF user space y-up. Same as `y`. */
  y0: number;
  /** Paragraph bbox UPPER edge (top), in PDF user space y-up. */
  y1: number;
  /** Font size. */
  size: number;
  /**
   * True when the source paragraph contained a line break (detected when a
   * later character's right edge retreats behind the previous char's left
   * edge — converter.py). Gates C-stage wrapping.
   */
  brk: boolean;
  // ─── Style hints (optional, all default to legacy behaviour when absent) ──
  // Added to recover source styling lost in the original Phase 1 renderer.
  // ALL optional → existing call sites are unaffected.
  /** Text color in 0–1 RGB, parsed from ODL `textColor`. Absent = black. */
  color?: { r: number; g: number; b: number };
  /** True when source font name indicates bold (e.g. `*-Bold*`, `*Heavy*`). */
  bold?: boolean;
  /** True when source font name indicates italic (e.g. `*-Italic*`, `*Oblique*`). */
  italic?: boolean;
  /** Original font size before any clamping; used so tables can recover cell size. */
  sourceFontSize?: number;
  /**
   * Page background fill color at this paragraph's bbox (0–1 RGB). When known,
   * the white cover-up mask uses this instead of opaque white so colored
   * callouts / code blocks / striped table rows aren't punched through.
   * Sampling requires the rasterizer; absent keeps legacy white mask.
   */
  backgroundColor?: { r: number; g: number; b: number };
}


/**
 * Minimal view of a character as needed by the assembler. pdfminer's LTChar
 * exposes x0/x1/y0/y1/size/matrix/fontname/get_text(); pdf.js's RawTextItem
 * lacks per-character geometry (it gives str + transform + width), so the
 * assembler adapter decomposes RawTextItem into these.
 *
 * Note on `cid`: converter.py's render_char attaches the font's CID. pdf.js
 * does not expose CID, so Phase 1 leaves this as the Unicode code point —
 * sufficient for the vflag font-name heuristic; precise glyph fallback is
 * Phase 2.
 */
export interface LtCharLike {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  size: number;
  /** Transform matrix [a,b,c,d,e,f] — used to detect vertical fonts (a==0 && d==0). */
  matrix: number[];
  fontname: string;
  /** The character's text (may be a multi-byte glyph). */
  text: string;
  /** Unicode code point (Phase 1 proxy for CID; see file header note). */
  cid: number;
}

/** Minimal view of a vector line (pdfminer LTLine). */
export interface LtLineLike {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  linewidth: number;
}


/**
 * One formula group, referenced from paragraph text via the `{vn}` placeholder.
 * Index `n` in `{vn}` is the position in AssemblyResult.formulas.
 */
export interface FormulaGroup {
  /** Characters composing the formula (for re-rendering at original positions). */
  chars: LtCharLike[];
  /** Vector lines belonging to the formula. */
  lines: LtLineLike[];
  /** Vertical offset correction (baseline alignment with adjacent text). */
  fix: number;
  /** Precomputed formula width (converter.py). */
  width: number;
}


/**
 * One raster image to be placed back onto the rendered page, at its original
 * coordinates. Source: OpenDataLoader JSON `image`/`chart` elements whose
 * `data` field carries a base64 data URI (only present when the jar is run
 * with `--image-output embedded`).
 *
 * NOTE: with `--image-output embedded` (which the translate adapter forces),
 * the ODL jar emits `image` elements with bbox + base64 data for every
 * embedded raster figure. Vector charts are captured as text structure, not
 * images, and are not recoverable as raster. The renderer treats a
 * missing/empty `images` as "no images to place" (e.g. a text-only page).
 */
export interface PlacedImage {
  /** Placement rectangle in PDF user space (origin bottom-left, y up, points). */
  bbox: { x: number; y: number; width: number; height: number };
  /** base64 data URI, e.g. `data:image/png;base64,iVBOR...`. */
  dataUri: string;
}

/**
 * Output of paragraph assembly (converter.py A stage). The six parallel
 * structures mirror converter.py's sstk/pstk/var/varl/varf/vlen/lstk.
 *
 * Contract: `paragraphs[i]` and `texts[i]` describe the same paragraph.
 * `texts[i]` may contain `{vn}` placeholders indexing into `formulas`.
 *
 * `images` is an optional addition (used by the OpenDataLoader adapter path):
 * the original converter.py pipeline never populates it. When present,
 * the C-stage renderer composites each image onto the page at `bbox`.
 */
export interface AssemblyResult {
  /** Paragraph texts, possibly containing `{vn}` formula placeholders. */
  texts: string[];
  /** Paragraph geometries, aligned with `texts` by index. */
  paragraphs: Paragraph[];
  /** Formula groups, indexed by the `n` in `{vn}`. */
  formulas: FormulaGroup[];
  /** Global (non-formula) lines for re-rendering. */
  globalLines: LtLineLike[];
  /** Optional raster images to composite onto the page (ODL path only). */
  images?: PlacedImage[];
  /**
   * Formula region screenshots to composite back at their original bboxes
   * (ODL path only). When present, the renderer covers the original (corrupted)
   * formula text with a mask and pastes the cropped image on top — preserving
   * the formula visually instead of dropping it or rendering raw LaTeX.
   */
  placedFormulas?: PlacedImage[];
}
