/**
 * pdfReaderTts — pdf.js adapter for reading the ORIGINAL PDF aloud on the
 * regular (non-SDT) reading view.
 *
 * Uses only the public surface of pdf.js's viewer application:
 *   - `PDFViewerApplication.pdfViewer.currentPageNumber` (read + write; the
 *     write scrolls, which is the read-aloud page follow),
 *   - `page.getTextContent()` for the page's text (sentence source),
 *   - the rendered `textLayer` spans for best-effort sentence highlight
 *     (TransLift's same strategy: text match first, graceful absence).
 *
 * Works on Zotero 7 and 10 alike — the base PDF view is present in both; on 10
 * the official read-aloud remains available for the same job.
 *
 * @module core/readAloud/pdfReaderTts
 */

import { safeDebug } from "../../utils/logger";
import { splitSentences, type SentenceSpan } from "./sentenceSplitter";
import type { ReadAloudSegment } from "./readAloudController";

/** Resolve the pdf.js viewer application for a reader instance. */
function viewerApp(reader: any): any {
  try {
    const internal = reader?._internalReader ?? reader;
    const primaryView = internal?._primaryView;
    // The viewer iframe is content realm: PDFViewerApplication is a window
    // global hidden behind the Xray — read through wrappedJSObject
    // (7.0.15 verification: direct access returns undefined).
    const iframeWin = primaryView?._iframeWindow;
    const raw = iframeWin?.wrappedJSObject ?? iframeWin;
    return raw?.PDFViewerApplication ?? null;
  } catch {
    return null;
  }
}

export function pdfReadAloudSupported(reader: any): boolean {
  try {
    const app = viewerApp(reader);
    return !!app?.pdfViewer;
  } catch {
    return false;
  }
}

export function currentPageNumber(reader: any): number {
  try {
    return Number(viewerApp(reader)?.pdfViewer?.currentPageNumber) || 1;
  } catch {
    return 1;
  }
}

interface PageText {
  pageNumber: number;
  text: string;
  /** Character-offset map back into textLayer span indices (best-effort). */
  spans: { el: any; start: number; end: number }[];
}

/**
 * Extract a page's text via getTextContent. Whitespace is normalized the same
 * way on both the text source and the textLayer spans so sentence offsets map
 * across.
 */
async function extractPageText(reader: any, pageNumber: number): Promise<PageText | null> {
  try {
    const app = viewerApp(reader);
    const pdfViewer = app?.pdfViewer;
    if (!pdfViewer) {
      safeDebug("[Z-Transplit] pdfReaderTts: no pdfViewer");
      return null;
    }
    // pdf.js: getPage lives on the PDFDocumentProxy, not the viewer
    // (verified on 7.0.15: pdfViewer.getPage is not a function).
    const pdfDocument = pdfViewer.pdfDocument || app.pdfDocument;
    if (!pdfDocument?.getPage) {
      safeDebug("[Z-Transplit] pdfReaderTts: no pdfDocument.getPage");
      return null;
    }
    const page = await pdfDocument.getPage(pageNumber);
    if (!page) return null;
    // PDFPageProxy is a content-realm object; through the Xray its prototype
    // methods are not callable from chrome (verified on 7.0.15:
    // "page.getTextContent is not a function") — unwrap first.
    const rawPage: any = page.wrappedJSObject ?? page;
    const rawContent = await rawPage.getTextContent();
    // items is a content-realm array of plain objects — read via the raw view.
    const rawItems: any[] =
      (rawContent?.items?.wrappedJSObject as any[]) ?? rawContent?.items ?? [];
    const content = { items: rawItems };
    const raw = (content.items as any[])
      .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
      .join("");
    const text = raw.replace(/\s+/g, " ").trim();
    // Best-effort span map (only when the page is rendered). getPageView is
    // 0-BASED (pdf.js API) while pageNumber is 1-based — off by one and the
    // span list comes back empty (found in the 7.0.15 E2E: "0 spans").
    const pageView = pdfViewer.getPageView(pageNumber - 1);
    // Where the spans live differs per pdf.js generation: modern builds keep
    // them on the TextLayerRenderTask (textLayer.textDivs), but the Zotero 7
    // viewer leaves the task arrays empty even with the layer rendered — so
    // read the DOM layer directly first (document order = reading order).
    let divs: any[] = [];
    const layerEl: any =
      pageView?.div?.querySelector?.(":scope > .textLayer") ??
      pageView?.div?.querySelector?.(".textLayer") ??
      null;
    if (layerEl?.children?.length) {
      divs = (Array.from(layerEl.children) as any[]).filter(
        (n: any) => String(n.localName) === "span",
      );
    }
    const taskDivs: any[] = pageView?.textLayer?.textDivs || [];
    if (divs.length === 0) divs = taskDivs;
    const spans: PageText["spans"] = [];
    let cursor = 0;
    const normalizedPage = text;
    for (const div of divs) {
      const rawSpan = String(div.textContent || "");
      const normalizedSpan = rawSpan.replace(/\s+/g, " ").trim();
      if (!normalizedSpan) continue;
      const found = normalizedPage.indexOf(normalizedSpan, cursor);
      const start = found >= 0 ? found : cursor;
      const end = start + normalizedSpan.length;
      spans.push({ el: div, start, end });
      cursor = Math.max(cursor, start);
    }
    safeDebug(
      `[Z-Transplit] pdfReaderTts: page ${pageNumber} text=${normalizedPage.length} chars,` +
        ` ${spans.length} spans (dom=${divs.length}, task=${taskDivs.length},` +
        ` layer=${layerEl ? (layerEl.children?.length ?? -1) : "none"})`,
    );
    return { pageNumber, text: normalizedPage, spans };
  } catch (e) {
    safeDebug("[Z-Transplit] pdfReaderTts extractPageText: " + e);
    return null;
  }
}

/** Active highlight cleanup. */
let activeHighlights: any[] = [];
const HIGHLIGHT_STYLE_ID = "ztransplit-readaloud-style";

function ensureHighlightStyle(doc: Document): void {
  if (doc.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
.ztransplit-readaloud-hl {
  background: rgba(245, 158, 11, 0.34) !important;
  color: inherit !important;
  border-radius: 2px;
}
`;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

function clearHighlights(): void {
  for (const el of activeHighlights) {
    try {
      el.classList.remove("ztransplit-readaloud-hl");
    } catch {
      /* detached */
    }
  }
  activeHighlights = [];
}

function highlightSpans(spans: { el: any }[]): void {
  clearHighlights();
  const doc = spans[0]?.el?.ownerDocument;
  if (!doc) return;
  ensureHighlightStyle(doc);
  for (const span of spans) {
    try {
      span.el.classList.add("ztransplit-readaloud-hl");
      activeHighlights.push(span.el);
    } catch {
      /* detached */
    }
  }
}

/**
 * Build the read-aloud segment list starting at `startPage` through the end of
 * the document, with sentence-level highlight hooks bound to the text layer.
 */
export async function buildPdfSegments(
  reader: any,
  startPage: number,
): Promise<{ segments: ReadAloudSegment[]; total: number }> {
  const app = viewerApp(reader);
  const pagesCount = Number(app?.pdfViewer?.pagesCount) || 0;
  safeDebug("[Z-Transplit] pdfReaderTts: buildPdfSegments from page, total=" + pagesCount);
  if (!pagesCount) return { segments: [], total: 0 };

  const segments: ReadAloudSegment[] = [];
  for (let p = startPage; p <= pagesCount; p++) {
    const page = await extractPageText(reader, p);
    if (!page?.text) continue;
    const sentences: SentenceSpan[] = splitSentences(page.text);
    for (const sentence of sentences) {
      const inRange = page.spans.filter((s) => s.start < sentence.end && s.end > sentence.start);
      segments.push({
        text: sentence.text,
        meta: {
          kind: "pdf-original",
          pageNumber: p,
          spans: inRange,
        },
      });
    }
  }
  return { segments, total: pagesCount };
}

/** Highlight the text-layer spans of one segment (best-effort). */
export function highlightSegment(segment: ReadAloudSegment): void {
  try {
    const meta = segment.meta as { pageNumber?: number; spans?: { el: any }[] };
    highlightSpans(meta?.spans || []);
  } catch {
    /* highlight is cosmetic */
  }
}

export function clearSegmentHighlight(): void {
  clearHighlights();
}

/** Navigate the reader to a segment's page (read-aloud follow). */
export function followSegment(reader: any, segment: ReadAloudSegment): void {
  try {
    const pageNumber = (segment.meta as any)?.pageNumber;
    const pdfViewer = viewerApp(reader)?.pdfViewer;
    if (pageNumber && pdfViewer && pdfViewer.currentPageNumber !== pageNumber) {
      pdfViewer.currentPageNumber = pageNumber;
    }
  } catch (e) {
    safeDebug("[Z-Transplit] pdfReaderTts follow: " + e);
  }
}
