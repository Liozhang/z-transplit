/**
 * odlToAssembly — Adapt an OpenDataLoader `PdfDocumentAnalysis` into the
 * parallel-array `AssemblyResult` shape that `LayoutPreservingRenderer` and
 * `translateParagraphs` consume.
 *
 * Why this exists: OpenDataLoader's JSON output already
 * carries per-paragraph `bbox + fontSize + text` in the SAME coordinate
 * space the renderer expects (PDF user space, origin bottom-left, y up,
 * points) — so the assembler can be skipped entirely and the renderer handed a
 * pre-sliced `AssemblyResult` derived directly from ODL's text blocks.
 *
 * Coordinate mapping (no flip/scale needed — verified against
 * `OpenDataLoaderJsonAdapter.toBBox` and `LayoutPreservingRenderer`):
 *   ODL bbox  {x, y, width, height}  (x=left, y=bottom)
 *   → Paragraph.x0 = x
 *     Paragraph.x1 = x + width
 *     Paragraph.y0 = y            (paragraph bbox lower edge)
 *     Paragraph.y1 = y + height   (paragraph bbox upper edge)
 *     Paragraph.y  = y            (matches the assembler setting
 *                                  p.y = child.y0, i.e. the baseline region)
 *     Paragraph.size = textBlock.fontSize
 *     Paragraph.x = x, brk = false (required by type; renderer ignores both)
 *
 * Images: when the jar is run with `--image-output embedded`, every embedded
 * raster image is emitted as an `image` element with bbox + base64 data URI.
 * The translate adapter forces this mode, so figures ARE recovered and mapped
 * onto `AssemblyResult.images` for the renderer to composite back. (Vector
 * charts are still captured as text structure, not images — those are not
 * recoverable as raster.) When no images are present, `images` is absent and
 * the renderer produces text-only output.
 *
 * Ported from leadero's src/core/pdf/translation/odlToAssembly.ts. The only
 * import change is `../PdfIR`, which was ported alongside (same path).
 *
 * @module core/pdf/translation/odlToAssembly
 */

import type { PdfDocumentAnalysis, PdfPageAnalysis } from "../PdfIR";
import type {
  AssemblyResult,
  Paragraph,
  PlacedImage,
} from "./translationIR";
import { parseFontStyle, parseTextColor } from "./fontStyleParser";

/** Per-page page geometry, returned alongside the per-page assemblies. */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * A paragraph flagged as formula-bearing, for vision-model LaTeX extraction.
 * `paragraphIndex` is the position within the page's `assembly.paragraphs` /
 * `assembly.texts` (so the adapter can splice the LaTeX back in). `bbox` is the
 * crop rectangle in PDF user space (y-up), and `pageNumber` is 1-indexed for
 * the rasterizer.
 */
export interface FormulaBlock {
  pageNumber: number;
  paragraphIndex: number;
  bbox: { x: number; y: number; width: number; height: number };
  originalText: string;
}

export interface OdlAssemblyOutput {
  /** One `AssemblyResult` per page, in page order. */
  assemblies: AssemblyResult[];
  /** Matching per-page geometry, same length as `assemblies`. */
  pageSizes: PageSize[];
  /** Formula-bearing paragraphs across all pages (for VLM LaTeX extraction). */
  formulaBlocks: FormulaBlock[];
}

/**
 * Convert a full ODL `PdfDocumentAnalysis` into per-page `AssemblyResult`s.
 *
 * Empty/whitespace text blocks are skipped (they produce no renderable
 * paragraph and would waste a translation call). Degenerate font sizes
 * (<=0, which ODL sometimes emits for spacing runs) are clamped to 1 so the
 * renderer's `Math.max(size, height)` doesn't collapse.
 *
 * Pure function — safe to unit-test in Node without JVM/Zotero.
 */
export function odlAnalysisToAssembly(
  analysis: PdfDocumentAnalysis,
): OdlAssemblyOutput {
  const assemblies: AssemblyResult[] = [];
  const pageSizes: PageSize[] = [];
  const formulaBlocks: FormulaBlock[] = [];

  analysis.pages.forEach((page, idx) => {
    const built = pageToAssembly(page, idx + 1);
    assemblies.push(built.assembly);
    pageSizes.push(built.pageSize);
    formulaBlocks.push(...built.formulaBlocks);
  });

  return { assemblies, pageSizes, formulaBlocks };
}

function pageToAssembly(
  page: PdfPageAnalysis,
  pageNumber: number,
): {
  assembly: AssemblyResult;
  pageSize: PageSize;
  formulaBlocks: FormulaBlock[];
} {
  const paragraphs: Paragraph[] = [];
  const texts: string[] = [];
  const formulaBlocks: FormulaBlock[] = [];

  let paragraphIndex = 0;
  for (const block of page.textBlocks) {
    const text = (block.text || "").trim();
    // Skip spacing-only / empty runs — they would render nothing and waste a
    // translation request. ODL marks these with hasEOL but we re-check text.
    if (!text) continue;

    const { x, y, width, height } = block.bbox;
    // Clamp degenerate font sizes. The previous clamp (`>0 ? :1`) mapped ODL's
    // spacing runs (fontSize=0) to 1pt, producing invisible text and wasting a
    // translation call. A 1pt glyph is unreadable anyway; fall back to a
    // legible 10pt so even malformed inputs render something usable.
    const size = block.fontSize > 4 ? block.fontSize : 10;
    // Guard against zero-area boxes (would make wrap width collapse to the
    // renderer's `Math.max(10, x1 - x0)` floor — harmless, but keep it real).
    const w = width > 0 ? width : 1;

    // Detect element-level rotated text (vertical sidebar / margin note).
    // ODL reports these as a bbox whose WIDTH ≈ one font size (because the
    // rotated text's visual width is a single glyph) and whose HEIGHT is many
    // times the font size (because the whole rotated line stack becomes the
    // vertical extent). The renderer only supports horizontal text, so drawing
    // into such a narrow box produces a tall column of one-char-per-line that
    // overflows into the body text. We skip these — leaving the original
    // rotated text untouched is far better than a garbled translation column.
    // Verified precise on real fixtures: a.json's sidebar (w=5.455≈fontSize
    // 5.455, h=605.6) is caught; b.json's 174 short paragraphs (single chars /
    // short titles where h≈fontSize, not h>5×fontSize) are NOT caught.
    const isRotated =
      Math.abs(w - size) < 2 && height > size * 5 && text.length > 20;
    if (isRotated) continue;

    // Formula detection: ODL folds formula characters into ordinary text. Flag
    // dense-formula paragraphs so the adapter can crop + VLM-extract LaTeX.
    if (isFormulaParagraph(text)) {
      formulaBlocks.push({
        pageNumber,
        paragraphIndex,
        bbox: { x, y, width: w, height: Math.max(height, size) },
        originalText: text,
      });
    }

    // Recover source styling that ODL folds into the font name + textColor.
    // Both are optional; when absent the renderer keeps legacy behaviour.
    const style = parseFontStyle(block.fontName);
    const color = parseTextColor(block.textColor);

    paragraphs.push({
      x0: x,
      x1: x + w,
      y0: y,
      y1: y + Math.max(height, size),
      y: y,
      size,
      x: x,
      brk: false,
      sourceFontSize: block.fontSize,
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(color ? { color } : {}),
    });
    texts.push(text);
    paragraphIndex++;
  }

  // Tables: SKIP entirely (keep the source table as-is).
  //
  // Previously each non-empty cell was added as a translatable paragraph and
  // the renderer drew a white mask over the cell + translated text. The result
  // was poor: grid lines were broken by the masks, merged cells misaligned,
  // and short data values (often untranslated anyway) rendered out of context.
  // In overlay mode (the default), the source PDF's table is already present
  // in the loaded document, so NOT masking/translating cells leaves the
  // original table fully intact — readers see the source table in the
  // translated PDF and the body text translated around it. This matches the
  // user's confirmed preference.
  //
  // (In white-page fallback mode the table will be absent because it was never
  // added to `paragraphs`; that mode already loses vector content, so this is
  // an acceptable, consistent trade-off.)
  //
  // The loop below is intentionally a no-op; it's kept as a documented marker
  // of where table handling would go if cell-level translation is ever wanted
  // again.
  for (const _table of page.tables) {
    // intentionally skipped
  }

  const images = extractImages(page);

  return {
    assembly: {
      texts,
      paragraphs,
      formulas: [],
      globalLines: [],
      // Empty by default — the orchestrator fills this with formula region
      // screenshots (rasterized from the reader) for the renderer to paste
      // back at the original bboxes. Initialized here so the renderer can
      // always read `assembly.placedFormulas` without a null-check.
      placedFormulas: [],
      // Only attach `images` when non-empty, so the legacy path (which
      // never sets it) and the common ODL path (no raster images) both
      // produce the same shape the renderer already understands.
      ...(images.length > 0 ? { images } : {}),
    },
    pageSize: {
      width: page.width > 0 ? page.width : 612,
      height: page.height > 0 ? page.height : 792,
    },
    formulaBlocks,
  };
}


/**
 * Characters/sequences that strongly indicate a formula. ODL folds formulas into
 * ordinary text, so a paragraph dense with these is treated as formula-bearing
 * and sent to the vision model for LaTeX extraction rather than translation.
 */
const FORMULA_CHAR_RE =
  /[∑∫√≈≤≥±×÷∂∇∞→←↔∀∃∝∝∠⊙⊕⊗≤≥≠αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]|[\\][a-zA-Z]{2,}/g;

/**
 * Heuristic: treat a paragraph as formula-bearing when it has at least
 * `threshold` formula-character matches. Threshold of 2 balances recall (catch
 * short inline-math runs like "β = 0.05") against false positives (a stray
 * single Greek letter in running text doesn't trigger it). Verified against the
 * real b.json fixture: statistical prose mentioning β once per paragraph stays
 * below the threshold, while genuine inline math (α + β ≥ 2 chars) is caught.
 * Exported for unit testing.
 */
export function isFormulaParagraph(text: string, threshold = 2): boolean {
  const matches = text.match(FORMULA_CHAR_RE);
  return !!matches && matches.length >= threshold;
}

/**
 * Collect raster images that should be composited back onto the page.
 * In the common heuristic-engine case this returns `[]` (charts are vector).
 */
function extractImages(page: PdfPageAnalysis): PlacedImage[] {
  const out: PlacedImage[] = [];
  for (const area of page.chartAreas) {
    if (!area.imageDataUri) continue;
    out.push({
      bbox: {
        x: area.bbox.x,
        y: area.bbox.y,
        width: area.bbox.width,
        height: area.bbox.height,
      },
      dataUri: area.imageDataUri,
    });
  }
  return out;
}
