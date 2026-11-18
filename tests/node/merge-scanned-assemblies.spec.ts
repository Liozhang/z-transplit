/**
 * merge-scanned-assemblies.spec — 两路解析产出合并的契约测试。
 *
 * 合并是扫描页进入主管线的最后一道闸：assemblies[i] 与 translatedSets[i]
 * 按位置对应，批量翻译按位置散回、渲染器逐页叠加——顺序即契约。本文件
 * 钉住：只替换被 OCR 接管的页、跳过页不替换（保留原文）、公式块按页过滤
 * 不加倍、页码越界安全跳过、数字页分毫不动。
 */
import { describe, it, expect } from "vitest";
import { mergeScannedAssemblies } from "../../src/core/pdf/scan/mergeScannedAssemblies";
import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";
import { sidecarPageToAnalysis } from "../../src/core/pdf/scan/ocrToAnalysis";
import type { PdfPageAnalysis } from "../../src/core/pdf/PdfIR";
import type { SidecarPageResult } from "../../src/core/pdf/scan/sidecarProtocol";

function digitalAnalysis(): ReturnType<typeof odlAnalysisToAssembly> {
  // 三页数字文档：每页一段正文。
  const analysis = {
    source: "tier2-opendataloader-pdf" as const,
    totalPages: 3,
    pages: [1, 2, 3].map((n) => ({
      pageNumber: n,
      width: 612,
      height: 792,
      textBlocks: [
        {
          text: `digital page ${n}`,
          bbox: { x: 50, y: 700, width: 300, height: 14 },
          fontSize: 10,
          fontName: "Helvetica",
          hasEOL: false,
        },
      ],
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
    confidence: 0.9,
    processingMs: 0,
  };
  return odlAnalysisToAssembly(analysis);
}

function ocrPage(pageNumber: number): PdfPageAnalysis {
  const sidecar: SidecarPageResult = {
    pageNumber,
    pageSizePt: { width: 595.28, height: 841.89 },
    renderSizePx: { width: 1654, height: 2339 },
    dpi: 200,
    rotation: 0,
    lines: [
      { bbox: { x0: 100, y0: 100, x1: 1400, y1: 130 }, text: `ocr page ${pageNumber}`, blockId: 0, blockType: "text" },
      { bbox: { x0: 100, y0: 200, x1: 800, y1: 240 }, text: "$a+b$", blockId: 1, blockType: "formula" },
    ],
    formulas: [],
    tables: [],
    figures: [],
    coverage: 0.5,
  };
  return sidecarPageToAnalysis(sidecar);
}

describe("mergeScannedAssemblies", () => {
  it("只替换被 OCR 接管的页，数字页分毫不动", () => {
    const base = digitalAnalysis();
    const merged = mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: base.formulaBlocks,
      ocrAnalyses: new Map([[2, ocrPage(2)]]),
    });
    expect(merged.replacedPages).toEqual([2]);
    expect(merged.assemblies[0].texts).toEqual(["digital page 1"]);
    expect(merged.assemblies[2].texts).toEqual(["digital page 3"]);
    // 第 2 页换成 OCR 产出：一段正文 + 一个公式块
    expect(merged.assemblies[1].texts).toEqual(["ocr page 2", "$a+b$"]);
  });

  it("原装配数组不被就地修改（调用方的 base 保持干净）", () => {
    const base = digitalAnalysis();
    const before = base.assemblies[1].texts;
    mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: base.formulaBlocks,
      ocrAnalyses: new Map([[2, ocrPage(2)]]),
    });
    expect(base.assemblies[1].texts).toBe(before);
    expect(base.assemblies[1].texts).toEqual(["digital page 2"]);
  });

  it("跳过页（null）不替换：空装配保留，渲染端整页跳过", () => {
    const base = digitalAnalysis();
    const merged = mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: base.formulaBlocks,
      ocrAnalyses: new Map([
        [2, null],
        [3, ocrPage(3)],
      ]),
    });
    expect(merged.replacedPages).toEqual([3]);
    // 第 2 页仍是 ODL 的空装配（该页本来就无文本块）
    expect(merged.assemblies[1].texts).toEqual(["digital page 2"]);
  });

  it("被 OCR 接管的页，其 ODL 公式块一律剔除", () => {
    const base = digitalAnalysis();
    const injected = [
      { pageNumber: 2, paragraphIndex: 0, bbox: { x: 0, y: 0, width: 10, height: 10 }, originalText: "β ≥ α" },
    ];
    const merged = mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: injected,
      ocrAnalyses: new Map([[2, ocrPage(2)]]),
    });
    // 注入的 ODL 公式块没了；OCR 原产公式块（带 LaTeX）进来
    expect(merged.formulaBlocks).toHaveLength(1);
    expect(merged.formulaBlocks[0].latex).toBe("$a+b$");
    expect(merged.formulaBlocks[0].pageNumber).toBe(2);
  });

  it("页码越界安全跳过，不写坏数组", () => {
    const base = digitalAnalysis();
    const merged = mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: base.formulaBlocks,
      ocrAnalyses: new Map([
        [99, ocrPage(99)],
        [0, ocrPage(0)],
      ]),
    });
    expect(merged.replacedPages).toEqual([]);
    expect(merged.assemblies).toHaveLength(3);
  });

  it("页尺寸同步替换（白页兜底模式用）", () => {
    const base = digitalAnalysis();
    const merged = mergeScannedAssemblies({
      assemblies: base.assemblies,
      pageSizes: base.pageSizes,
      formulaBlocks: base.formulaBlocks,
      ocrAnalyses: new Map([[1, ocrPage(1)]]),
    });
    expect(merged.pageSizes[0]).toEqual({ width: 595.28, height: 841.89 });
    expect(merged.pageSizes[1]).toEqual({ width: 612, height: 792 });
  });
});
