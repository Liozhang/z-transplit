/**
 * routePages 测试（src/core/pdf/scan/routePages.ts）。
 *
 * 路由决定哪页走 OCR、哪页走 ODL，是扫描件支持里错误代价最高的一步：
 * 数字页误入 OCR 只是浪费一次识别，扫描页漏进 OCR 则整页不翻译，而"范围
 * 外的扫描页"必须原样保留。本文件钉住四类文档形态下的分流结果：混合文
 * 档、纯扫描件（探针兜底分析）、页码范围收窄、以及劣质文本层页。
 */
import { describe, it, expect } from "vitest";
import { decideScanRouting } from "../../../../../src/core/pdf/scan/routePages";
import { emptyAnalysisFromProbe } from "../../../../../src/core/pdf/scan/pdfPageProbe";
import type { PdfDocumentAnalysis, PdfPageAnalysis } from "../../../../../src/core/pdf/PdfIR";

function page(
  pageNumber: number,
  kind: "digital" | "scanned" | "degraded",
): PdfPageAnalysis {
  const text =
    kind === "digital"
      ? "A full paragraph of real body text that is clearly readable."
      : kind === "scanned"
        ? ""
        : "\uE000\uE001\uE002 garbage hidden text layer \uE003\uE004\uE005";
  return {
    pageNumber,
    width: 612,
    height: 792,
    textBlocks: text
      ? [
          {
            text,
            bbox: { x: 50, y: 700, width: 400, height: 14 },
            fontSize: 10,
            fontName: "Helvetica",
            hasEOL: false,
          },
        ]
      : [],
    regions: [],
    tables: [],
    chartAreas: [],
    formulas: [],
    repeatedElements: [],
    citations: [],
  };
}

function analysis(pages: PdfPageAnalysis[]): PdfDocumentAnalysis {
  return {
    source: "tier2-opendataloader-pdf",
    totalPages: pages.length,
    pages,
    allTables: [],
    allFormulas: [],
    allChartAreas: [],
    allCitations: [],
    filteredText: "",
    filteredMarkdown: "",
    confidence: 0.9,
    processingMs: 0,
  };
}

const all = (): boolean => true;

describe("decideScanRouting", () => {
  it("混合文档：扫描页与劣质页进 OCR，数字页走 ODL", () => {
    const routing = decideScanRouting(
      analysis([page(1, "digital"), page(2, "scanned"), page(3, "degraded"), page(4, "digital")]),
      all,
    );
    expect(routing.ocrPages).toEqual([2, 3]);
    expect(routing.digitalPages).toEqual([1, 4]);
    expect(routing.counts).toEqual({ digital: 2, scanned: 1, degraded: 1 });
  });

  it("纯扫描件（探针兜底的空分析）：全部页进 OCR", () => {
    const probe = emptyAnalysisFromProbe([
      { pageNumber: 1, textLength: 0, widthPt: 612, heightPt: 792 },
      { pageNumber: 2, textLength: 0, widthPt: 612, heightPt: 792 },
      { pageNumber: 3, textLength: 0, widthPt: 612, heightPt: 792 },
    ]);
    const routing = decideScanRouting(probe, all);
    expect(routing.ocrPages).toEqual([1, 2, 3]);
    expect(routing.digitalPages).toEqual([]);
    expect(routing.counts.scanned).toBe(3);
  });

  it("纯数字文档：OCR 页清单为空，不启动侧车", () => {
    const routing = decideScanRouting(analysis([page(1, "digital"), page(2, "digital")]), all);
    expect(routing.ocrPages).toEqual([]);
    expect(routing.digitalPages).toEqual([1, 2]);
  });

  it("页码范围收窄：范围外的扫描页完全不进 OCR（保持原文）", () => {
    const selected = (n: number): boolean => n === 2;
    const routing = decideScanRouting(
      analysis([page(1, "scanned"), page(2, "digital"), page(3, "scanned")]),
      selected,
    );
    expect(routing.ocrPages).toEqual([]);
    expect(routing.digitalPages).toEqual([2]);
    // 分类仍然统计全部页——计数供"有扫描页但不在范围"的日志判断
    expect(routing.counts.scanned).toBe(2);
  });

  it("劣质文本层页（乱码隐藏层）与扫描页同等对待", () => {
    const routing = decideScanRouting(analysis([page(1, "degraded")]), all);
    expect(routing.ocrPages).toEqual([1]);
    expect(routing.counts.degraded).toBe(1);
  });

  it("页码即数组下标加一：第三页是扫描页时 OCR 清单是 [3] 而非 [2]", () => {
    const routing = decideScanRouting(
      analysis([page(1, "digital"), page(2, "digital"), page(3, "scanned")]),
      all,
    );
    expect(routing.ocrPages).toEqual([3]);
  });
});
