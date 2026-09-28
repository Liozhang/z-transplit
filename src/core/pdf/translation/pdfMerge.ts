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
 * Empty input → an empty (zero-page) PDF, so callers don't need a special case.
 */
export async function mergePageBytes(pageBytesList: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const pb of pageBytesList) {
    if (!pb || pb.length === 0) continue;
    // ignoreEncryption: per-page output is our own creation, never encrypted,
    // but the flag is harmless.
    const src = await PDFDocument.load(pb as any, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  return out.save();
}
