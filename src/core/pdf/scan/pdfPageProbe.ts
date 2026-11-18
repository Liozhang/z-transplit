/**
 * pdfPageProbe — 用阅读器的 pdf.js 实例逐页探测文本层长度与页面尺寸。
 *
 * 只服务一个场景：OpenDataLoader 对整篇零产出（纯扫描件今天直接抛
 * "无文本"死路）时，需要知道一共有多少页、每页多大，才能为全部页建立
 * "待 OCR"的占位装配。混合文档不需要它——那种情况下每页特征直接从
 * ODL 产出统计（见 pageClassification）。
 *
 * 探针打开的是用户可能已经开着的阅读器：只关自己新开的那一个。
 *
 * Host-coupled by design（Zotero.Reader 内部结构 + 内容域 eval），不可在
 * Node 单测；纯变换 pixelBoxToPdfBox 单独导出，由单测覆盖。
 *
 * @module core/pdf/scan/pdfPageProbe
 */

import { safeDebug } from "../../../utils/logger";
import { getReaderIframeWin, openTransientReader } from "./readerAccess";
import type { PdfDocumentAnalysis } from "../PdfIR";

/** 一页的探针结果。尺寸为 PDF 点（pdf.js viewport scale 1 即 1:1）。 */
export interface PdfPageProbeEntry {
  pageNumber: number;
  /** 该页文本层字符总数（提取失败按 0 计）。 */
  textLength: number;
  widthPt: number;
  heightPt: number;
}

/** 像素边界框（原点左上，y 向下）。 */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 把位图像素框换算成 PDF 用户空间边界框（原点左下，y 向上，单位点）。
 *
 * 侧车按 dpi 渲染位图并回报 renderSizePx 与 pageSizePt；渲染尺寸与页面
 * 尺寸可能因取整略有偏差，所以缩放以位图实际尺寸为基准，而不是相信
 * dpi 乘法——公式一样简单，但对取整鲁棒。
 */
export function pixelBoxToPdfBox(
  box: PixelBox,
  renderSizePx: { width: number; height: number },
  pageSizePt: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const sx = pageSizePt.width / Math.max(1, renderSizePx.width);
  const sy = pageSizePt.height / Math.max(1, renderSizePx.height);
  const x0 = Math.min(box.x0, box.x1) * sx;
  const x1 = Math.max(box.x0, box.x1) * sx;
  // y 翻转：位图自上而下，PDF 自下而上。
  const topPt = Math.min(box.y0, box.y1) * sy;
  const bottomPt = Math.max(box.y0, box.y1) * sy;
  return {
    x: x0,
    y: pageSizePt.height - bottomPt,
    width: x1 - x0,
    height: bottomPt - topPt,
  };
}

/**
 * 用探针结果构造一份"每页空文本"的文档分析。纯扫描件走这条路：
 * OpenDataLoader 对整篇零产出（今天直接抛"无文本"死路），探针给出页数
 * 与页尺寸后，全部页标记 scanned 交给 OCR，管线不再死在路上。
 *
 * source 仍标 tier2：这份分析只是"ODL 无产出"的占位，真正的识别产出在
 * 扫描管线里按页替换进装配数组。
 */
export function emptyAnalysisFromProbe(
  entries: PdfPageProbeEntry[],
): PdfDocumentAnalysis {
  return {
    source: "tier2-opendataloader-pdf",
    totalPages: entries.length,
    pages: entries.map((e) => ({
      pageNumber: e.pageNumber,
      width: e.widthPt > 0 ? e.widthPt : 612,
      height: e.heightPt > 0 ? e.heightPt : 792,
      textBlocks: [],
      regions: [],
      tables: [],
      chartAreas: [],
      formulas: [],
      repeatedElements: [],
      citations: [],
    })),
    allTables: [],
    allFormulas: [],
    allChartAreas: [],
    allCitations: [],
    filteredText: "",
    filteredMarkdown: "",
    confidence: 0.5,
    processingMs: 0,
  };
}

// 在阅读器内容域执行的逐页探测函数。定义为字符串，与
// ZoteroPdfRasterizer 的注入方式一致：在 pdf.js 与 DOMMatrix 所在的域里
// 跑，结果以结构化可克隆数据回传。
const PROBE_FN_SOURCE = `
(async function() {
  const app = window.PDFViewerApplication;
  if (!app || !app.pdfViewer) {
    throw new Error("PDFViewerApplication not ready in reader iframe");
  }
  const pdfDocument = app.pdfViewer.pdfDocument || app.pdfDocument;
  if (!pdfDocument) {
    throw new Error("reader has no pdfDocument loaded");
  }
  const out = [];
  const n = pdfDocument.numPages;
  for (let p = 1; p <= n; p++) {
    const page = await pdfDocument.getPage(p);
    let textLength = 0;
    try {
      const tc = await page.getTextContent();
      for (const item of tc.items) {
        if (item && typeof item.str === "string") textLength += item.str.length;
      }
    } catch (e) {
      // Per-page extraction failure counts as 0: a zero-length page is routed
      // to the OCR pipeline, so nothing is lost.
    }
    const vp = page.getViewport({ scale: 1 });
    out.push({
      pageNumber: p,
      textLength: textLength,
      widthPt: vp.width,
      heightPt: vp.height
    });
  }
  return out;
})
`;

/**
 * 逐页探测。返回的数组按页序，长度等于 PDF 页数。
 *
 * 阅读器打不开（例如附件正在被其它进程独占）时返回 null——调用方按
 * "无法判定"处理，不能把 null 当成"没有页"。
 */
export async function probePdfPages(
  attachmentId: number,
): Promise<PdfPageProbeEntry[] | null> {
  const opened = await openTransientReader(attachmentId);
  if (!opened) {
    safeDebug(
      "[Z-Transplit] pdfPageProbe: no reader available for attachment " + attachmentId,
    );
    return null;
  }
  const { reader, openedNew } = opened;
  try {
    const iframeWin = getReaderIframeWin(reader);
    if (!iframeWin) return null;
    const probe = iframeWin.eval(PROBE_FN_SOURCE);
    if (typeof probe !== "function") {
      throw new Error("pdfPageProbe: failed to define probe fn");
    }
    const entries = (await probe.call(iframeWin)) as PdfPageProbeEntry[];
    if (!Array.isArray(entries)) {
      throw new Error("pdfPageProbe: reader returned non-array");
    }
    return entries;
  } finally {
    // 只关自己新开的那一个；用户自己的标签页不能动。
    if (openedNew) {
      try { reader?.close?.(); } catch (e) { safeDebug("[Z-Transplit] pdfPageProbe: " + e); }
    }
  }
}
