/**
 * LayoutPreservingRenderer — Stage C of layout-preserving translation.
 *
 * Renders translated text back into the PDF at the original paragraph
 * coordinates, with line-wrapping and dynamic line-height adjustment so the
 * translation fits within the original paragraph's bounding box.
 *
 * ── Phase 1 simplifications (documented for honest scope) ──
 * The Python reference writes raw PDF content-stream operators (BT...ET, Tf/Tm/TJ)
 * via PyMuPDF and re-renders formula glyphs at their captured positions. That
 * full fidelity requires:
 *   (a) injecting content streams into pdf-lib's object tree, and
 *   (b) precise per-glyph width measurement via embedded CJK font metrics.
 *
 * Phase 1 instead uses pdf-lib's high-level `drawText` on
 * a fresh output page sized to match the source. This produces a valid, viewable
 * translated PDF that proves the A→B→C pipeline end-to-end. Gaps vs the reference:
 *   - Formulas ({vn}) are rendered as their plain-text fallback, not re-positioned
 *     glyphs. (Stage A still captures them; Stage C just doesn't re-emit vector math.)
 *   - Line wrapping uses the CJK-aware wrapper at the paragraph x1 boundary,
 *     which approximates converter.py's per-glyph advance loop.
 * These are tracked for Phase 2 — see research doc §6.2 "布局重建".
 *
 * Ported from leadero's src/core/pdf/translation/LayoutPreservingRenderer.ts.
 * Changes: log prefixes + PDF metadata producer/creator are Z-Transplit's own
 * (the old values leaked the source plugin's name into output PDFs).
 *
 * @module core/pdf/translation/LayoutPreservingRenderer
 */

import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";
import * as fontkitNS from "@pdf-lib/fontkit";
// @pdf-lib/fontkit is CJS exporting the fontkit function itself; a bare
// namespace import loses `.create` under esbuild interop (render then always
// fell back to Helvetica and every CJK glyph failed WinAnsi encoding — found
// in the README-shot round on a fresh machine). Resolve the default export.
const fontkit: any = (fontkitNS as any).default ?? fontkitNS;

/**
 * fontkit wrapper that unwraps TrueType Collections (.ttc). fontkit.create on
 * a TTC returns the COLLECTION object, which has no per-font methods — pdf-lib
 * then fails with "font.createSubset is not a function" (Windows 默认中文字体
 * msyh.ttc IS a TTC; found in the README-shot round). Hand pdf-lib the first
 * face instead.
 */
function fontkitCompat(): any {
  const wrapped: any = Object.create(fontkit);
  wrapped.create = (buf: any) => {
    const parsed = fontkit.create(buf);
    return parsed?.fonts?.length ? parsed.fonts[0] : parsed;
  };
  return wrapped;
}
import type { AssemblyResult, Paragraph } from "./translationIR";
import { embedDataUri, compositeFormulas } from "./ImageCompositor";
import { wrapTextMixed, isCJK } from "./TextWrapper";
import { getString } from "../../../utils/locale";
import { safeDebug } from "../../../utils/logger";


// ─── Line-height presets (converter.py LANG_LINEHEIGHT_MAP) ──

const LANG_LINEHEIGHT_MAP: Record<string, number> = {
  "zh-cn": 1.4,
  "zh-tw": 1.4,
  "zh-hans": 1.4,
  "zh-hant": 1.4,
  zh: 1.4,
  ja: 1.1,
  ko: 1.2,
  en: 1.2,
  "en-us": 1.2,
  ar: 1.0,
  ru: 0.8,
  uk: 0.8,
  ta: 0.8,
};

/**
 * Transform a paragraph's bbox from ODL's "displayed" coordinate space (which
 * accounts for `/Rotate`) into the page's UN-rotated coordinate space that
 * pdf-lib draws in. When rotation is 0 this is a no-op.
 *
 * Why this exists: OpenDataLoader reports bboxes in the page's *visual* space
 * (what a reader shows, after applying /Rotate). pdf-lib's `drawText`/
 * `drawRectangle` operate in the page's *raw* space (MediaBox, before /Rotate).
 * For `/Rotate 90/270` these differ, so we must rotate the ODL bbox back into
 * the raw space or every paragraph lands in the wrong place.
 *
 * The four cases (pageW/pageH = UN-rotated MediaBox dimensions):
 *   0°:   identity
 *   90°:  x' = y,          y' = pageW - x       (and swap conceptually)
 *   180°: x' = pageW - x,  y' = pageH - y
 *   270°: x' = pageH - y,  y' = x
 * where (x, y) is a point's bottom-left in ODL space and (x', y') is the raw
 * space coordinate. We transform the four bbox corners and take the min/max.
 *
 * NOTE: the current fixtures are all rotation=0, so this is verified via
 * synthetic unit tests rather than real PDFs.
 */
export function applyRotation(
  p: Paragraph,
  rotation: number,
  pageW: number,
  pageH: number,
): Paragraph {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 0) return p;
  // Transform the four corners of the bbox [x0,y0]-[x1,y1].
  const corners: Array<[number, number]> = [
    [p.x0, p.y0],
    [p.x1, p.y0],
    [p.x0, p.y1],
    [p.x1, p.y1],
  ];
  const transformed = corners.map(([x, y]) => {
    switch (rot) {
      case 90:
        return [y, pageW - x] as [number, number];
      case 180:
        return [pageW - x, pageH - y] as [number, number];
      case 270:
        return [pageH - y, x] as [number, number];
      default:
        return [x, y] as [number, number];
    }
  });
  const xs = transformed.map((c) => c[0]);
  const ys = transformed.map((c) => c[1]);
  const newX0 = Math.min(...xs);
  const newX1 = Math.max(...xs);
  const newY0 = Math.min(...ys);
  const newY1 = Math.max(...ys);
  return {
    ...p,
    x0: newX0,
    x1: newX1,
    y0: newY0,
    y1: newY1,
    // Baseline reference y becomes the new bottom edge; x becomes new left.
    y: newY0,
    x: newX0,
  };
}

/**
 * Clamp a paragraph's bbox to the page MediaBox [0,0,pageW,pageH]. ODL can
 * report bboxes extending past the page edge (full-width tables/rows); drawing
 * there lands off-page. Returns a new Paragraph with clamped x0/x1/y0/y1 (and
 * `x`/`y` adjusted consistently). Style fields are preserved.
 */
export function clampParagraph(
  p: Paragraph,
  pageW: number,
  pageH: number,
): Paragraph {
  const x0 = Math.max(0, Math.min(p.x0, pageW));
  const x1 = Math.max(x0, Math.min(p.x1, pageW));
  const y0 = Math.max(0, Math.min(p.y0, pageH));
  const y1 = Math.max(y0, Math.min(p.y1, pageH));
  if (x0 === p.x0 && x1 === p.x1 && y0 === p.y0 && y1 === p.y1) return p;
  return { ...p, x0, x1, y0, y1, x: x0, y: y0 };
}


export interface RenderOptions {
  /** Target language code, used to pick line-height preset (converter.py). */
  targetLanguage: string;
  /** Page dimensions in points (must match the source page). */
  pageWidth: number;
  pageHeight: number;
  /**
   * Optional CJK (or other non-Latin) font bytes — a TTF/OTF buffer for the
   * target script. When provided, the renderer registers fontkit and embeds the
   * font with subsetting, so CJK glyphs actually render. When omitted, falls back
   * to StandardFonts (Helvetica) and un-encodable glyphs become '?'.
   *
   * Production caller loads this once (a system CJK font via
   * src/core/pdf/platform.ts) and passes the same buffer across pages.
   */
  cjkFontBytes?: ArrayBuffer | Uint8Array;
  /**
   * Optional Bold variant of the CJK font. When present, paragraphs whose source
   * font name indicated bold are rendered with this variant; otherwise they
   * degrade to `cjkFontBytes` (regular). All variant buffers are optional.
   */
  boldFontBytes?: ArrayBuffer | Uint8Array;
  /** Optional Italic variant of the CJK font. */
  italicFontBytes?: ArrayBuffer | Uint8Array;
  /** Optional Bold+Italic variant of the CJK font. */
  boldItalicFontBytes?: ArrayBuffer | Uint8Array;
  /**
   * Optional Latin-script font bytes (TTF/OTF) for the Latin runs mixed into a
   * CJK paragraph (digits, English words, punctuation). When provided together
   * with `cjkFontBytes`, the renderer splits each line into CJK and Latin runs
   * and draws each run with its own font (Latin text gets a proper Latin
   * typeface instead of the CJK font's Latin glyphs). When omitted, Latin runs
   * fall back to the CJK font (or Helvetica if no CJK font either).
   */
  latinFontBytes?: ArrayBuffer | Uint8Array;
  /**
   * Original source PDF bytes — when provided, the renderer LOADS the source PDF
   * and overlays the translation on the matching page (drawn over white masks that
   * cover the original text). This preserves ALL original vector content (figures,
   * charts, table grid lines, backgrounds) at full fidelity — no rasterization.
   * When omitted, falls back to the white-page mode (text only, figures lost).
   *
   * `sourcePageIndex` (0-indexed) selects which page of the source to overlay.
   */
  sourcePdfBytes?: ArrayBuffer | Uint8Array;
  sourcePageIndex?: number;
}

export interface RenderResult {
  /** Bytes of the translated PDF (single page). */
  bytes: Uint8Array;
  /** Diagnostics: how many paragraphs rendered, how many formulas dropped. */
  stats: {
    paragraphsRendered: number;
    formulasDropped: number;
    overflowed: number;
    /** Raster images composited back onto the page (ODL path only). */
    imagesRendered: number;
    imagesDropped: number;
  };
}

/**
 * Render translated paragraphs into a fresh single-page PDF at original coords.
 *
 * Coordinate translation: converter.py works in PDF user space (y up). pdf-lib's
 * `drawText` also uses y-up from the page's bottom-left, so coordinates pass
 * through directly — EXCEPT pdf-lib's y is the text *baseline*, while
 * `Paragraph.y` is the top-of-glyph region captured by the assembler. We shift
 * down by one line so the first line sits where the source paragraph began.
 *
 * @param assembly Stage A output (paragraphs + formulas).
 * @param translated Stage B output (translated texts, aligned with assembly.paragraphs).
 */
export async function renderLayoutPreserving(
  assembly: AssemblyResult,
  translated: string[],
  options: RenderOptions,
): Promise<RenderResult> {
  const { targetLanguage, pageWidth, pageHeight } = options;
  const lineHeight = LANG_LINEHEIGHT_MAP[targetLanguage.toLowerCase()] ?? 1.1;

  // Document creation: when sourcePdfBytes is provided, LOAD the original PDF so
  // the translated page overlays the source — preserving all vector content
  // (figures, charts, table lines, backgrounds) at full fidelity. Otherwise fall
  // back to creating a fresh white-page document (text + composited images only).
  const overlayMode = !!options.sourcePdfBytes;
  const pdfDoc = overlayMode
    ? await PDFDocument.load(options.sourcePdfBytes as any)
    : await PDFDocument.create();

  // Font selection: prefer the injected CJK font (covers full glyph range).
  // Bold/Italic variants are embedded when provided and degrade to regular
  // when absent. Fall back to Standard Helvetica when no CJK font is provided.
  const { fonts, useCJK } = await buildFontSet(
    pdfDoc,
    options.cjkFontBytes,
    {
      bold: options.boldFontBytes,
      italic: options.italicFontBytes,
      boldItalic: options.boldItalicFontBytes,
      latin: options.latinFontBytes,
    },
  );

  // In overlay mode, pick the matching source page; otherwise create a fresh page.
  let page: ReturnType<PDFDocument["addPage"]>;
  if (overlayMode) {
    const pages = pdfDoc.getPages();
    const idx = Math.min(options.sourcePageIndex ?? 0, pages.length - 1);
    page = pages[idx];
  } else {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
  }
  const stats = {
    paragraphsRendered: 0,
    formulasDropped: 0,
    overflowed: 0,
    imagesRendered: 0,
    imagesDropped: 0,
  };

  for (
    let i = 0;
    i < assembly.paragraphs.length && i < translated.length;
    i++
  ) {
    const rawP = assembly.paragraphs[i];
    // Clamp to page bounds (ODL can report off-page bboxes). Same guard as the
    // overlay path.
    const p = clampParagraph(rawP, pageWidth, pageHeight);
    let text = translated[i];
    if (!text) continue;

    // Strip {vn} formula placeholders. When a placedFormula image is available
    // for this paragraph (see compositeFormulas below), the formula is rendered
    // visually; the text token is dropped either way so it doesn't draw raw.
    const stripped = stripFormulaPlaceholders(text);
    if (stripped.dropped > 0) stats.formulasDropped += stripped.dropped;
    text = stripped.text;
    if (!text.trim()) continue;

    // In overlay mode, cover the original text so it doesn't bleed through.
    // Use the paragraph's recovered background color when known (colored
    // callouts / code blocks), else opaque white.
    if (overlayMode) {
      const bg =
        p.backgroundColor != null
          ? rgb(p.backgroundColor.r, p.backgroundColor.g, p.backgroundColor.b)
          : rgb(1, 1, 1);
      page.drawRectangle({
        x: p.x0 - 1,
        // pdf-lib's rectangle `y` is its BOTTOM edge, in the SAME y-up
        // coordinate space as ODL's bbox (origin bottom-left, y up). No flip.
        // BUG HISTORY: the original code used `pageHeight - p.y1 - 1`, which is
        // correct ONLY if the coordinate origin were top-left (like canvas).
        // pdf-lib uses bottom-left origin, same as PDF — so p.y0 (the bbox's
        // lower edge) IS the rectangle's bottom edge directly.
        y: p.y0 - 1,
        width: (p.x1 - p.x0) + 2,
        height: (p.y1 - p.y0) + 2,
        color: bg,
      });
    }

    renderParagraph(page, fonts, p, text, lineHeight, useCJK, stats);
    stats.paragraphsRendered++;
  }

  // Composite raster images back onto the page (white-page mode only). In overlay
  // mode the original images are already in the source PDF — skip to avoid
  // double-drawing and wasted embed work.
  if (!overlayMode && assembly.images && assembly.images.length > 0) {
    for (const img of assembly.images) {
      try {
        const embedded = await embedDataUri(pdfDoc, img.dataUri);
        if (!embedded) {
          stats.imagesDropped++;
          continue;
        }
        page.drawImage(embedded, {
          x: img.bbox.x,
          y: img.bbox.y,
          width: img.bbox.width,
          height: img.bbox.height,
        });
        stats.imagesRendered++;
      } catch (e) {
        safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
        // Bad data URI / unsupported format — degrade gracefully, keep going.
        stats.imagesDropped++;
      }
    }
  }

  // Paste formula screenshots back at their original bboxes. Works in BOTH
  // overlay and white-page modes — the image covers the (corrupted/removed)
  // formula text region with a clean visual of the source math.
  const singleRotation = overlayMode ? page.getRotation().angle : 0;
  await compositeFormulas(
    page,
    pdfDoc,
    assembly,
    singleRotation,
    page.getWidth(),
    page.getHeight(),
    stats,
  );

  const bytes = await pdfDoc.save();
  return { bytes, stats };
}


/**
 * Overlay-mode batch renderer: LOADS the source PDF once, overlays translated
 * text on every page (white masks over original text + translated text drawn on
 * top), preserving ALL original vector content (figures, charts, table lines)
 * at full fidelity. Saves once → returns the complete document.
 *
 * This is the high-fidelity path: no rasterization, text stays selectable,
 * output size ≈ source size. Use this when sourcePdfBytes is available;
 * fall back to per-page renderLayoutPreserving (white-page mode) otherwise.
 *
 * @param assemblies Per-page geometry + texts (from odlAnalysisToAssembly).
 * @param translatedSets Per-page translated text arrays, aligned with assemblies.
 */
export async function renderOverlayTranslated(
  sourcePdfBytes: ArrayBuffer | Uint8Array,
  assemblies: AssemblyResult[],
  translatedSets: string[][],
  options: {
    targetLanguage: string;
    cjkFontBytes?: ArrayBuffer | Uint8Array;
    boldFontBytes?: ArrayBuffer | Uint8Array;
    italicFontBytes?: ArrayBuffer | Uint8Array;
    boldItalicFontBytes?: ArrayBuffer | Uint8Array;
    /** Latin font for the Latin runs in mixed CJK+Latin paragraphs. */
    latinFontBytes?: ArrayBuffer | Uint8Array;
    /** Title written into the output PDF's Info dict. Defaults to a marker string. */
    docTitle?: string;
  },
): Promise<{ bytes: Uint8Array; stats: RenderResult["stats"] }> {
  const lineHeight =
    LANG_LINEHEIGHT_MAP[options.targetLanguage.toLowerCase()] ?? 1.1;

  // Normalize to a clean Uint8Array (handles ArrayBuffer, byteOffset views,
  // and cross-realm typed arrays that confuse pdf-lib's type checks).
  const cleanBytes =
    sourcePdfBytes instanceof Uint8Array
      ? sourcePdfBytes.byteOffset === 0 &&
        sourcePdfBytes.byteLength === sourcePdfBytes.buffer.byteLength
        ? sourcePdfBytes
        : sourcePdfBytes.slice()
      : new Uint8Array(sourcePdfBytes);
  const pdfDoc = await PDFDocument.load(cleanBytes);

  const { fonts, useCJK } = await buildFontSet(
    pdfDoc,
    options.cjkFontBytes,
    {
      bold: options.boldFontBytes,
      italic: options.italicFontBytes,
      boldItalic: options.boldItalicFontBytes,
      latin: options.latinFontBytes,
    },
  );

  const pages = pdfDoc.getPages();
  const stats = {
    paragraphsRendered: 0,
    formulasDropped: 0,
    overflowed: 0,
    imagesRendered: 0,
    imagesDropped: 0,
  };

  for (let i = 0; i < assemblies.length && i < pages.length; i++) {
    const assembly = assemblies[i];
    const translated = translatedSets[i] ?? [];
    const page = pages[i];
    // Read the page's /Rotate. Overlay drawing uses pdf-lib's RAW coordinate
    // space (MediaBox, pre-rotation), but OpenDataLoader reports bboxes in the
    // DISPLAY space (post-rotation). For rotation≠0 these differ and a correct
    // transform requires a real rotated-PDF fixture to verify — which we don't
    // have. Rather than emit an UNVERIFIED transform that could place text
    // off-page (the integration test proved the naive formula is wrong), we
    // refuse rotated pages with a clear error so users aren't silently given a
    // broken translation. Rotation 0 is the common case and works as-is.
    const rotation = page.getRotation().angle;
    if (rotation !== 0) {
      throw new Error(getString("render-error-rotated-page", { angle: rotation }));
    }
    const pageW = page.getWidth();
    const pageH = page.getHeight();

    for (
      let j = 0;
      j < assembly.paragraphs.length && j < translated.length;
      j++
    ) {
      const rawP = assembly.paragraphs[j];
      const p = applyRotation(rawP, rotation, pageW, pageH);
      let text = translated[j];
      if (!text) continue;
      const stripped = stripFormulaPlaceholders(text);
      if (stripped.dropped > 0) stats.formulasDropped += stripped.dropped;
      text = stripped.text;
      if (!text.trim()) continue;

      // Clamp the paragraph bbox to the page MediaBox. ODL occasionally reports
      // a bbox that extends past the page edge (observed x=635 on a 612-wide
      // page in b.json). Drawing the mask/text there would land off-page.
      const cp = clampParagraph(p, pageW, pageH);

      // Cover the original text so it doesn't bleed through. Use the
      // paragraph's recovered background color when known, else opaque white.
      const bg =
        cp.backgroundColor != null
          ? rgb(cp.backgroundColor.r, cp.backgroundColor.g, cp.backgroundColor.b)
          : rgb(1, 1, 1);
      page.drawRectangle({
        x: cp.x0 - 1,
        // pdf-lib rectangle `y` = bottom edge, same y-up space as ODL bbox. No flip.
        y: cp.y0 - 1,
        width: cp.x1 - cp.x0 + 2,
        height: cp.y1 - cp.y0 + 2,
        color: bg,
      });
      renderParagraph(page, fonts, cp, text, lineHeight, useCJK, stats);
      stats.paragraphsRendered++;
    }

    // Paste formula screenshots back at their original bboxes on this page.
    await compositeFormulas(page, pdfDoc, assembly, rotation, pageW, pageH, stats);
  }

  // Set a recognizable title so users can distinguish the translated PDF from
  // the source in file properties. Overlay mode inherits the source's other
  // metadata (author/subject) via PDFDocument.load; we only override the title.
  try {
    pdfDoc.setTitle(options.docTitle ?? "Z-Transplit translated PDF");
    pdfDoc.setProducer("Z-Transplit PDF translation");
    pdfDoc.setCreator("Z-Transplit");
  } catch (e) {
    safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
    // best-effort — some PDFs have locked/encrypted Info dicts
  }

  const bytes = await pdfDoc.save();
  return { bytes, stats };
}


/**
 * A set of font variants for one family. The renderer picks among them per
 * paragraph based on the recovered `bold`/`italic` hints. When a variant is
 * missing (Bold/Italic assets not installed), it gracefully degrades to
 * `regular` — the output stays valid, just without the weight/style emphasis.
 */
export interface FontSet {
  regular: PDFFont;
  bold?: PDFFont;
  italic?: PDFFont;
  boldItalic?: PDFFont;
  /**
   * Latin-script font for the Latin runs in a CJK paragraph (digits, English
   * words). When present, lines are split into CJK/Latin runs and each run is
   * drawn with its own font. When absent, Latin runs use the CJK `regular`.
   */
  latin?: PDFFont;
}

/** Pick the variant matching the paragraph's style hints, else `regular`. */
function pickFont(fonts: FontSet, p: Paragraph): PDFFont {
  if (p.bold && p.italic && fonts.boldItalic) return fonts.boldItalic;
  if (p.bold && fonts.bold) return fonts.bold;
  if (p.italic && fonts.italic) return fonts.italic;
  return fonts.regular;
}

/**
 * Embed the regular CJK font plus any provided variants into `pdfDoc`,
 * returning a FontSet. Variants that fail to embed (corrupt buffer, missing
 * fontkit glyph coverage) are silently dropped — the renderer then falls back
 * to regular for that style. This is the graceful-degradation contract: bold
 * is a nice-to-have, not a render-blocker.
 *
 * When `cjkFontBytes` is absent, every variant degrades to Standard Helvetica.
 */
async function buildFontSet(
  pdfDoc: PDFDocument,
  cjkFontBytes?: ArrayBuffer | Uint8Array,
  variants?: {
    bold?: ArrayBuffer | Uint8Array;
    italic?: ArrayBuffer | Uint8Array;
    boldItalic?: ArrayBuffer | Uint8Array;
    latin?: ArrayBuffer | Uint8Array;
  },
): Promise<{ fonts: FontSet; useCJK: boolean }> {
  if (!cjkFontBytes) {
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    return { fonts: { regular }, useCJK: false };
  }
  pdfDoc.registerFontkit(fontkitCompat());
  let regular: PDFFont;
  let useCJK = true;
  try {
    regular = await pdfDoc.embedFont(cjkFontBytes as any, { subset: true });
  } catch (e) {
    safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
    regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    useCJK = false;
  }
  const tryEmbed = async (
    buf?: ArrayBuffer | Uint8Array,
  ): Promise<PDFFont | undefined> => {
    if (!buf) return undefined;
    try {
      return await pdfDoc.embedFont(buf as any, { subset: true });
    } catch (e) {
      safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
      return undefined; // variant unusable → degrade to regular downstream
    }
  };
  const [bold, italic, boldItalic, latin] = await Promise.all([
    tryEmbed(variants?.bold),
    tryEmbed(variants?.italic),
    tryEmbed(variants?.boldItalic),
    tryEmbed(variants?.latin),
  ]);
  return {
    fonts: {
      regular,
      ...(bold ? { bold } : {}),
      ...(italic ? { italic } : {}),
      ...(boldItalic ? { boldItalic } : {}),
      ...(latin ? { latin } : {}),
    },
    useCJK,
  };
}

/**
 * Render one paragraph, adapting font size AND line height to fit the original
 * paragraph's bounding box. converter.py only shrank line height; the
 * TS renderer now also shrinks the font size (down to 40% of source) before
 * giving up, which is what stops translated text from vertically overflowing
 * into the next paragraph / table row.
 */
function renderParagraph(
  page: ReturnType<PDFDocument["addPage"]>,
  fonts: FontSet,
  p: Paragraph,
  text: string,
  defaultLineHeight: number,
  useCJK: boolean,
  stats: { overflowed: number },
): void {
  const font = pickFont(fonts, p);
  let size = p.size;
  const maxWidth = Math.max(10, p.x1 - p.x0); // wrap width = paragraph right - left boundary
  const height = Math.max(size, p.y1 - p.y0); // original paragraph height
  // Lower shrink floor (40% of source / 4pt) — gives the renderer more room
  // to absorb long translations before resorting to clipping.
  const minSize = Math.max(4, p.size * 0.4);

  // Normalize ligatures (ﬁﬂ…) to their plain forms BEFORE sanitizing, so they
  // don't get replaced with '?' even when a CJK font is present (CJK fonts
  // often lack the presentation-form ligature code points).
  const normalized = text.replace(/[\uFB00-\uFB06]/g, (m) => {
    const map: Record<string, string> = {
      "\uFB00": "ff",
      "\uFB01": "fi",
      "\uFB02": "fl",
      "\uFB03": "ffi",
      "\uFB04": "ffl",
      "\uFB05": "st",
      "\uFB06": "st",
    };
    return map[m] ?? m;
  });

  // Sanitize glyphs the font can't encode. With the embedded CJK font this is a
  // near-no-op (it covers the full CJK + Latin range); with StandardFonts fallback
  // it replaces un-encodable code points with '?' so width measurement / drawing
  // don't throw.
  const safe = useCJK ? normalized : sanitizeForFont(normalized, font);

  // Wrap with the CJK-aware algorithm. If the text still produces more lines
  // than the source paragraph can hold, shrink the font size and re-wrap until
  // it fits (or we hit the size floor). This is the fix for vertical overflow.
  let lh = defaultLineHeight;
  let lines = wrapForRender(safe, maxWidth, font, size);
  while (
    lines.length * size * lh > height &&
    size > minSize
  ) {
    size -= 0.5;
    lines = wrapForRender(safe, maxWidth, font, size);
  }
  // Then shrink line height as a second lever (converter.py behaviour).
  while (lines.length * size * lh > height && lh >= 1) {
    lh -= 0.05;
  }
  if (lines.length * size * lh > height) {
    stats.overflowed++; // still doesn't fit after both levers — render anyway
  }

  // Resolve fill color: prefer the paragraph's recovered text color, else black.
  const fillColor =
    p.color != null ? rgb(p.color.r, p.color.g, p.color.b) : rgb(0, 0, 0);

  // Baseline positioning. pdf-lib's drawText `y` is the text BASELINE, measured
  // in the SAME coordinate space as ODL's bbox (PDF user space: y-up, origin at
  // the page's BOTTOM-left). There is NO `pageHeight - y` flip — pdf-lib and
  // PDF use identical axes. This was verified empirically: drawText({y: 69.5})
  // emits `... 69.5 Tm` unchanged.
  //
  // The FIRST line's baseline sits at `p.y1 - size` so the glyph's top (ascender
  // ≈ baseline + size) aligns with the paragraph's TOP edge (p.y1). This matches
  // how the source text occupies its box: the first line starts at the top and
  // subsequent lines DESCEND toward the bottom (p.y0), each by `size * lh`.
  // (For a single-line paragraph y1 - size ≈ y0, which is why the earlier
  // `p.y0` formula also worked for the page-number case but broke for multi-line.)
  //
  // BUG HISTORY: every prior version subtracted from `page.getHeight()` (first
  // `pageHeight - p.y - size`, then `pageHeight - p.y1 - size`). Both assumed
  // pdf-lib used a top-left origin (like HTML canvas) and "flipped" y. That's
  // wrong — pdf-lib is y-up from the bottom — so the flip mirrored text across
  // the page midline. A later `p.y0` fix worked for single-line paragraphs but
  // caused multi-line text to descend BELOW the paragraph box. The correct
  // anchor is the TOP edge (y1 - size) with lines descending toward y0.
  let baselineY = p.y1 - size;
  // HARD CLIP: only render lines whose baseline stays above p.y0 (the
  // paragraph's bottom edge). Without this, an over-long translation keeps
  // descending and paints over the next paragraph's region — empirically 6
  // baselines bled into the neighbor in the overflow audit. We keep the top
  // lines (most important content) and drop the overflowing tail. At least the
  // first line is always rendered so a paragraph is never left blank.
  let linesClipped = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li > 0 && baselineY <= p.y0) {
      linesClipped = lines.length - li;
      break;
    }
    if (line.length === 0) {
      baselineY -= size * lh;
      continue;
    }
    try {
      // Mixed-font rendering: when a Latin font is available, split the line
      // into CJK and Latin runs and draw each with its own font (Latin text gets
      // a proper Latin typeface instead of the CJK font's Latin glyphs). Falls
      // back to a single-font drawText when no Latin font is set.
      if (fonts.latin) {
        drawLineMixed(page, line, p.x0, baselineY, size, font, fonts.latin, fillColor);
      } else {
        page.drawText(line, {
          x: p.x0,
          y: baselineY,
          size,
          font,
          color: fillColor,
        });
      }
    } catch (e) {
      safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
      // Glyph missing in StandardFonts (e.g. CJK) — skip silently; Phase 2 font embedding fixes this.
    }
    baselineY -= size * lh;
  }
  if (linesClipped > 0) stats.overflowed++;
}

/**
 * Draw a single line split into CJK and Latin runs, each with its own font.
 *
 * The line is walked left-to-right; maximal runs of CJK characters (per
 * `isCJK`) use `cjkFont`, maximal runs of non-CJK characters use `latinFont`.
 * Each run is drawn at an x offset accumulated by the previous run's measured
 * width, so the segments concatenate seamlessly on the same baseline.
 *
 * This is render-only — line wrapping (`wrapTextMixed`) still measures with a
 * single base font, which is close enough for wrapping decisions; only the
 * final paint splits by script for correct per-font glyphs.
 */
function drawLineMixed(
  page: ReturnType<PDFDocument["addPage"]>,
  line: string,
  x: number,
  y: number,
  size: number,
  cjkFont: PDFFont,
  latinFont: PDFFont,
  color: ReturnType<typeof rgb>,
): void {
  let cursorX = x;
  let i = 0;
  while (i < line.length) {
    const cjkRun = isCJK(line[i]);
    let j = i + 1;
    while (j < line.length && isCJK(line[j]) === cjkRun) j++;
    const seg = line.slice(i, j);
    const font = cjkRun ? cjkFont : latinFont;
    try {
      page.drawText(seg, { x: cursorX, y, size, font, color });
    } catch (e) {
      safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
      /* glyph missing in this font — skip segment silently */
    }
    cursorX += font.widthOfTextAtSize(seg, size);
    i = j;
  }
}

/** Single-line fast path + multi-line CJK-aware wrap. */
function wrapForRender(
  safe: string,
  maxWidth: number,
  font: PDFFont,
  size: number,
): string[] {
  if (safe.length === 0) return [safe];
  return font.widthOfTextAtSize(safe, size) > maxWidth
    ? wrapTextMixed(safe, maxWidth, (t: string) => font.widthOfTextAtSize(t, size))
    : [safe];
}


/**
 * Replace glyphs the font cannot encode with '?'. pdf-lib's StandardFonts throw
 * on WinAnsi-incompatible code points (ligatures ﬁﬂ, CJK, emoji) during BOTH
 * width measurement and drawing, which would abort the whole render. We probe
 * per character with `font.encodeText` (cheap) and swap failures for '?'.
 *
 * Phase 2 removes this by embedding a CJK font (Noto) that covers these ranges.
 */
function sanitizeForFont(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch (e) {
      safeDebug("[Z-Transplit] LayoutPreservingRenderer: " + e);
      out += "?";
    }
  }
  // Collapse runs of '?' and trim — avoids ugly streaks from fully-CJK paragraphs
  return out.replace(/\?{2,}/g, "…").trim();
}

/**
 * Tolerant formula-placeholder stripper. converter.py uses the same regex on the
 * consume side — `\{\s*v[\d\s]+\}`, case-insensitive — so
 * even if the translator mangled spacing, we still recognize and drop the token.
 * Phase 1 drops formulas entirely (no vector re-render); Phase 2 will emit them.
 */
function stripFormulaPlaceholders(text: string): {
  text: string;
  dropped: number;
} {
  const re = /\{\s*v[\d\s]+\}/gi;
  const matches = text.match(re);
  return {
    text: text.replace(re, "").trim(),
    dropped: matches ? matches.length : 0,
  };
}
