/**
 * ImageCompositor — embeds images and composites formula screenshots onto
 * a PDF page. Extracted from LayoutPreservingRenderer.ts.
 *
 * Ported from leadero's src/core/pdf/translation/ImageCompositor.ts (log
 * prefixes renamed; no other coupling).
 */

import { PDFDocument, rgb } from "pdf-lib";
import { safeDebug } from "../../../utils/logger";


/**
 * Embed a `data:image/...;base64,...` URI into the pdf document, picking the
 * right embedder by MIME. Returns null on an unparseable/unsupported URI so the
 * caller can count it as dropped without aborting the whole page render.
 *
 * pdf-lib only exposes `embedPng` and `embedJpg`; other formats (gif/webp/svg)
 * are not supported and fall through to null.
 */
export async function embedDataUri(
  pdfDoc: PDFDocument,
  dataUri: string,
): Promise<ReturnType<PDFDocument["embedPng"]> | null> {
  const match = dataUri.match(/^data:image\/([a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  const [, mimeRaw, b64] = match;
  const mime = mimeRaw.toLowerCase();
  // atob is available in both Zotero's chrome realm (window) and Node test env.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (mime === "png") return await pdfDoc.embedPng(bytes);
  if (mime === "jpeg" || mime === "jpg") return await pdfDoc.embedJpg(bytes);
  return null;
}

/**
 * Composite formula screenshots (from `assembly.placedFormulas`) onto the page
 * at their original bboxes. Each placed formula is drawn as a rectangle filled
 * with the page background (white by default) to cover any leftover source
 * text, then the cropped formula image is pasted on top.
 *
 * This is the visual-preserving fix for formulas: instead of dropping `{vn}`
 * tokens (Phase 1) and leaving dangling text like "由公式  可知", the renderer
 * pastes a clean image of the source math at the right coordinates. Works in
 * both overlay and white-page render modes.
 *
 * Stats: counts images rendered vs dropped (bad data URI / unsupported format).
 */
export async function compositeFormulas(
  page: ReturnType<PDFDocument["addPage"]>,
  pdfDoc: PDFDocument,
  assembly: { placedFormulas?: Array<{ dataUri: string; bbox: { x: number; y: number; width: number; height: number } }> },
  rotation: number,
  pageW: number,
  pageH: number,
  stats: { imagesRendered: number; imagesDropped: number },
): Promise<void> {
  const formulas = assembly.placedFormulas;
  if (!formulas || formulas.length === 0) return;
  for (const f of formulas) {
    try {
      const embedded = await embedDataUri(pdfDoc, f.dataUri);
      if (!embedded) {
        stats.imagesDropped++;
        continue;
      }
      // Transform the formula bbox into raw page space (handles /Rotate), then
      // cover the region with a white rectangle and paste the image. Same
      // rotation logic as paragraph bboxes above.
      const b = rotateBBox(f.bbox, rotation, pageW, pageH);
      page.drawRectangle({
        x: b.x - 0.5,
        y: b.y - 0.5,
        width: b.width + 1,
        height: b.height + 1,
        color: rgb(1, 1, 1),
      });
      page.drawImage(embedded, {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
      });
      stats.imagesRendered++;
    } catch (e) {
      safeDebug("[Z-Transplit] ImageCompositor: " + e);
      stats.imagesDropped++;
    }
  }
}

/**
 * Rotate a `PlacedImage`-style bbox from ODL display space into raw page space.
 * Same transform as `applyRotation` but for the simpler `{x,y,width,height}`
 * shape (no baseline fields). rotation=0 is a no-op.
 */
export function rotateBBox(
  b: { x: number; y: number; width: number; height: number },
  rotation: number,
  pageW: number,
  pageH: number,
): { x: number; y: number; width: number; height: number } {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 0) return b;
  const corners: Array<[number, number]> = [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height],
    [b.x + b.width, b.y + b.height],
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
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}
