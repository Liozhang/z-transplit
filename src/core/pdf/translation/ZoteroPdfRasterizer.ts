/**
 * ZoteroPdfRasterizer — Region rasterization for the OpenDataLoader translation path.
 *
 * Renders a rectangular region of a PDF page to a PNG data URL so the formula
 * extractor can crop formula blocks and send them to the vision model for LaTeX
 * extraction.
 *
 * The implementation reuses the reader's live pdf.js instance (same cross-realm
 * mechanics as the former full-page rasterizer): the render function executes
 * inside the reader content realm where pdf.js + DOMMatrix live, and the resulting
 * data URL crosses back to the privileged realm automatically.
 *
 * Host-coupled by design (Zotero.Reader internals + content-realm eval) — not
 * unit-testable outside a real Zotero runtime; the ported node specs
 * deliberately do not import this module.
 *
 * Ported from leadero's src/core/pdf/translation/ZoteroPdfRasterizer.ts (log
 * prefixes renamed; logic unchanged).
 *
 * @module core/pdf/translation/ZoteroPdfRasterizer
 */

// ─── Reader access (mirrors useReaderTextSelection.ts:81 + splitView.ts:2557) ──

import { safeDebug } from "../../../utils/logger";

/**
 * Find the reader instance for a given attachment. Searches Zotero.Reader._readers
 * for one whose underlying item matches attachmentId.
 */
function findReaderForAttachment(attachmentId: number): any {
  const readers = (Zotero as any).Reader?.getReaders?.() ||
    (Zotero as any).Reader?._readers ||
    [];
  for (const r of readers) {
    try {
      // Reader instances expose the attachment item id via _itemID / itemID / _attachmentId
      const id = r._itemID ?? r.itemID ?? r._attachmentId ?? r.attachmentID;
      if (id === attachmentId) return r;
    } catch (e) {
      safeDebug("[Z-Transplit] ZoteroPdfRasterizer: " + e);
      /* skip */
    }
  }
  return null;
}

/**
 * Get the reader iframe's contentWindow (content realm), unwrapped so we can use
 * its real properties (PDFViewerApplication etc.).
 */
function getReaderIframeWin(reader: any): any {
  const internal = reader?._internalReader ?? reader;
  const primaryView = internal?._primaryView;
  const iframe = primaryView?._iframe ?? primaryView?._iframeWindow;
  const iframeWin = iframe?.contentWindow ?? iframe;
  if (!iframeWin) return null;
  // Unwrap XPCNativeWrapper to access content-realm globals directly.
  return iframeWin.wrappedJSObject || iframeWin;
}

// ─── The render function injected into the reader realm ──
//
// Defined as a string so it can be evaluated inside the reader's contentWindow,
// where pdf.js + DOMMatrix + canvas all exist. It uses the live PDFViewerApplication
// to fetch the page, renders into a fresh canvas, and returns {rgb, width, height}
// as plain structured-cloneable data.
const _RENDER_FN_SOURCE = `
(function(pageNum, targetWidth) {
  const app = window.PDFViewerApplication;
  if (!app || !app.pdfViewer) {
    throw new Error("PDFViewerApplication not ready in reader iframe");
  }
  const pdfDocument = app.pdfViewer.pdfDocument || (app.pdfDocument);
  if (!pdfDocument) {
    throw new Error("reader has no pdfDocument loaded");
  }
  return pdfDocument.getPage(pageNum).then(function(page) {
    const baseVp = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseVp.width;
    const viewport = page.getViewport({ scale: scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function() {
      const imageData = ctx.getImageData(0, 0, w, h).data;
      // Drop alpha: RGBA → RGB
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0, j = 0; i < imageData.length; i += 4, j += 3) {
        rgb[j] = imageData[i];
        rgb[j + 1] = imageData[i + 1];
        rgb[j + 2] = imageData[i + 2];
      }
      return { rgb: rgb, width: w, height: h };
    });
  });
})
`;


/**
 * Render fn for region cropping. Renders the full page to one canvas, then blits
 * the bbox sub-rectangle (PDF user space, y-up) onto a second canvas and returns
 * a PNG data URL. Coordinates are converted from PDF y-up to canvas y-down here.
 *
 * bbox is { x, y, width, height } in PDF points (x=left, y=bottom, y-up), matching
 * the PdfIR BBox + the ODL/odlToAssembly output. The `scale` multiplies PDF points
 * to pixels (e.g. 2 for retina-quality crops fed to a vision model).
 */
const REGION_RENDER_FN_SOURCE = `
(function(pageNum, bx, by, bw, bh, scale) {
  var app = window.PDFViewerApplication;
  if (!app || !app.pdfViewer) {
    throw new Error("PDFViewerApplication not ready in reader iframe");
  }
  var pdfDocument = app.pdfViewer.pdfDocument || app.pdfDocument;
  if (!pdfDocument) throw new Error("reader has no pdfDocument loaded");
  return pdfDocument.getPage(pageNum).then(function(page) {
    var viewport = page.getViewport({ scale: scale });
    var fullW = Math.floor(viewport.width);
    var fullH = Math.floor(viewport.height);
    var full = document.createElement("canvas");
    full.width = fullW; full.height = fullH;
    var fctx = full.getContext("2d");
    fctx.fillStyle = "#ffffff";
    fctx.fillRect(0, 0, fullW, fullH);
    return page.render({ canvasContext: fctx, viewport: viewport }).promise.then(function() {
      // bbox y-up → canvas y-down: top of the box in pixels.
      var sx = Math.max(0, Math.floor(bx * scale));
      var sy = Math.max(0, Math.floor((viewport.height - (by + bh) ) * scale));
      var sw = Math.min(fullW - sx, Math.ceil(bw * scale));
      var sh = Math.min(fullH - sy, Math.ceil(bh * scale));
      if (sw <= 0 || sh <= 0) throw new Error("region crop is empty");
      var crop = document.createElement("canvas");
      crop.width = sw; crop.height = sh;
      var cctx = crop.getContext("2d");
      cctx.fillStyle = "#ffffff";
      cctx.fillRect(0, 0, sw, sh);
      cctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
      return crop.toDataURL("image/png");
    });
  });
})
`;

/** bbox rectangle in PDF user space (points, y-up). */
export interface RegionBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rasterize a sub-region of a PDF page to a PNG data URL, for vision-model OCR
 * (e.g. extracting LaTeX from a formula crop). Reuses the reader's live pdf.js,
 * same as the full-page rasterizer. Requires the PDF open in a reader tab.
 *
 * @param scale pixels-per-point (2 = good balance for vision models; higher = sharper
 *   but larger payload). The base viewport scales PDF points → pixels.
 */
export async function rasterizeRegionToDataURL(args: {
  attachmentId: number;
  pageNum: number; // 1-indexed, like the full-page rasterizer
  bbox: RegionBBox;
  scale?: number;
}): Promise<string> {
  const { attachmentId, pageNum, bbox } = args;
  const scale = args.scale ?? 2;

  const reader = findReaderForAttachment(attachmentId);
  if (!reader) {
    throw new Error(
      `rasterizeRegionToDataURL: no open reader for attachment ${attachmentId}.`,
    );
  }
  const iframeWin = getReaderIframeWin(reader);
  if (!iframeWin) {
    throw new Error("rasterizeRegionToDataURL: reader has no iframe contentWindow");
  }

  const factory = iframeWin.eval(REGION_RENDER_FN_SOURCE);
  if (typeof factory !== "function") {
    throw new Error("rasterizeRegionToDataURL: failed to define render fn");
  }

  const dataUrl: string = await factory.call(
    iframeWin,
    pageNum,
    bbox.x,
    bbox.y,
    bbox.width,
    bbox.height,
    scale,
  );
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new Error("rasterizeRegionToDataURL: reader returned no image data URL");
  }
  return dataUrl;
}
