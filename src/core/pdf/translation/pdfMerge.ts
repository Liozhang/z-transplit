/**
 * pdfMerge — Merge per-page translated PDF byte arrays into one multi-page PDF.
 *
 * The ODL path can produce one single-page PDF per page via
 * LayoutPreservingRenderer. To produce a whole-document translation we merge
 * those per-page results here. Uses pdf-lib's copyPages (the bundle already
 * includes pdf-lib for the renderer).
 *
 * Ported from leadero's src/core/pdf/translation/pdfMerge.ts.
 *
 * @module core/pdf/translation/pdfMerge
 */

import { PDFDocument } from "pdf-lib";

/**
 * Merge an ordered list of single-page PDF byte arrays into one PDF preserving
 * page order. Each entry is assumed to be a complete PDF document (as produced
 * by LayoutPreservingRenderer.renderLayoutPreserving).
 *
 * When `docTitle` is given it becomes the merged document's Title metadata —
 * the white-page counterpart of the overlay path's docTitle, so both render
 * paths produce the same document metadata.
 *
 * Empty input is NOT a zero-page PDF, whatever it looks like: `PDFDocument.create()`
 * reports 0 pages, but the saved bytes load back as ONE blank page (a pdf-lib
 * round-trip quirk). Callers therefore must not rely on "empty in, empty out" —
 * `opendataloaderSplitAdapter` guards with an explicit
 * `pageBytes.length === 0` throw before calling here. A test pins this
 * round-trip so the next person does not "simplify" that guard away on the
 * strength of this comment.
 */
export async function mergePageBytes(
  pageBytesList: Uint8Array[],
  docTitle?: string,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const pb of pageBytesList) {
    if (!pb || pb.length === 0) continue;
    // ignoreEncryption: per-page output is our own creation, never encrypted,
    // but the flag is harmless.
    const src = await PDFDocument.load(pb as any, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  if (docTitle) out.setTitle(docTitle);
  return out.save();
}
