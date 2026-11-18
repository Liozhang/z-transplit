/**
 * scanDocumentAggregate 测试（src/core/pdf/scan/scanDocumentAggregate.ts）。
 *
 * 聚合是"文档级视图不漏扫描页"的执行者，钉住四类承诺：
 *   1. 收录规则与数字路径一致：正文类块进 filteredText，页眉页脚/图注/
 *      公式不进，标题进 Markdown 带 #，表格只进 Markdown；
 *   2. 混合文档保真：数字页的文本与 Markdown 按页界原样保留，只替换被
 *      识别页的位置——重推导会让数字页丢标题层级；
 *   3. 纯扫描文档：底本空文本时按页序从识别片段构建，页界记账自洽；
 *   4. 跳过页（null）保留底本页面与底本文本；替换整篇时 source 才标
 *      scan-sidecar。
 *
 * 纯函数测试，不碰宿主。
 */
import { describe, it, expect } from "vitest";
import {
  mergeScannedDocument,
  pageAnalysisAggregate,
} from "../../../../../src/core/pdf/scan/scanDocumentAggregate";
import type {
  LayoutRegion,
  LayoutRole,
  PdfDocumentAnalysis,
  PdfPageAnalysis,
  PdfTable,
} from "../../../../../src/core/pdf/PdfIR";

function block(text: string, over: Partial<PdfPageAnalysis["textBlocks"][number]> = {}) {
  return {
    text,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    fontSize: 10,
    fontName: "",
    hasEOL: false,
    ...over,
  };
}

function page(
  pageNumber: number,
  over: Partial<PdfPageAnalysis> = {},
): PdfPageAnalysis {
  return {
    pageNumber,
    width: 595,
    height: 842,
    textBlocks: [],
    regions: [],
    tables: [],
    chartAreas: [],
    formulas: [],
    repeatedElements: [],
    citations: [],
    ...over,
  };
}

/** 带角色区的正文页：region.content[0] 即块本身（与识别页产出一致）。 */
function pageWithRoles(
  pageNumber: number,
  entries: Array<{ role: LayoutRole; text: string; isFormula?: boolean }>,
  tables: PdfTable[] = [],
): PdfPageAnalysis {
  const textBlocks = entries.map((e) =>
    block(e.text, e.isFormula ? { isFormula: true } : {}),
  );
  const regions: LayoutRegion[] = entries.map((e, i) => ({
    role: e.role,
    bbox: textBlocks[i].bbox,
    pageNumber,
    confidence: 0.9,
    content: [textBlocks[i]],
  }));
  return page(pageNumber, { textBlocks, regions, tables });
}

function table(rows: string[][]): PdfTable {
  return {
    pageNumber: 0,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    rows: rows.map((r) => ({
      cells: r.map((text) => ({
        text,
        colspan: 1,
        rowspan: 1,
        bbox: { x: 0, y: 0, width: 10, height: 10 },
      })),
    })),
    confidence: 0.8,
  };
}

function doc(over: Partial<PdfDocumentAnalysis> = {}): PdfDocumentAnalysis {
  return {
    source: "tier2-opendataloader-pdf",
    totalPages: 0,
    pages: [],
    allTables: [],
    allFormulas: [],
    allChartAreas: [],
    allCitations: [],
    filteredText: "",
    filteredMarkdown: "",
    confidence: 0.9,
    processingMs: 0,
    ...over,
  };
}

describe("pageAnalysisAggregate", () => {
  it("正文类块进 filteredText，页眉页脚/图注/公式不进", () => {
    const p = pageWithRoles(1, [
      { role: "heading", text: "标题" },
      { role: "body", text: "正文" },
      { role: "reference-entry", text: "[1] 文献" },
      { role: "footnote", text: "脚注" },
      { role: "sidebar", text: "侧栏" },
      { role: "header", text: "页眉" },
      { role: "footer", text: "页脚" },
      { role: "page-number", text: "12" },
      { role: "caption", text: "图注" },
      { role: "formula", text: "$x$", isFormula: true },
    ]);
    const parts = pageAnalysisAggregate(p);
    expect(parts.textParts).toEqual(["标题", "正文", "[1] 文献", "脚注", "侧栏"]);
    // 标题进 Markdown 带一级标记；公式不进任何一侧
    expect(parts.markdownParts).toEqual(["# 标题", "正文", "[1] 文献", "脚注", "侧栏"]);
  });

  it("表格只进 Markdown，附在本页文本之后", () => {
    const p = pageWithRoles(1, [{ role: "body", text: "见表" }], [table([["甲", "乙"], ["丙", "丁"]])]);
    const parts = pageAnalysisAggregate(p);
    expect(parts.textParts).toEqual(["见表"]);
    expect(parts.markdownParts).toEqual([
      "见表",
      "| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |",
    ]);
  });

  it("空文本块跳过；没有角色区的块按正文收", () => {
    const p = page(1, { textBlocks: [block("  "), block("无区域块")] });
    const parts = pageAnalysisAggregate(p);
    expect(parts.textParts).toEqual(["无区域块"]);
  });
});

describe("mergeScannedDocument", () => {
  /** 三页数字底本：页 2 将被识别页替换。 */
  function digitalBase(): PdfDocumentAnalysis {
    const pages = [
      pageWithRoles(1, [{ role: "body", text: "甲页" }]),
      pageWithRoles(2, [{ role: "body", text: "乙页" }], [table([["旧", "表"]])]),
      pageWithRoles(3, [{ role: "body", text: "丙页" }]),
    ];
    return doc({
      totalPages: 3,
      pages,
      allTables: [pages[1].tables[0]],
      filteredText: "甲页\n\n乙页\n\n丙页",
      filteredPageSpans: [
        { pageNumber: 1, start: 0, end: 2 },
        { pageNumber: 2, start: 4, end: 6 },
        { pageNumber: 3, start: 8, end: 10 },
      ],
      filteredMarkdown: "甲页\n\n| 旧 | 表 |\n| --- | --- |\n\n丙页",
      filteredMarkdownPageSpans: [
        { pageNumber: 1, start: 0, end: 2 },
        { pageNumber: 2, start: 4, end: 27 },
        { pageNumber: 3, start: 29, end: 31 },
      ],
    });
  }

  const ocrPage2 = pageWithRoles(2, [{ role: "body", text: "识别二" }], [table([["新", "表"]])]);

  it("混合文档：数字页原样保留，识别页按页序替换进文本与 Markdown", () => {
    const merged = mergeScannedDocument({
      base: digitalBase(),
      ocrAnalyses: new Map([[2, ocrPage2]]),
    });
    expect(merged.filteredText).toBe("甲页\n\n识别二\n\n丙页");
    expect(merged.filteredMarkdown).toBe(
      "甲页\n\n识别二\n\n| 新 | 表 |\n| --- | --- |\n\n丙页",
    );
    // 页界与拼接严格一致（消费方按页切片的依据）
    expect(merged.filteredPageSpans).toEqual([
      { pageNumber: 1, start: 0, end: 2 },
      { pageNumber: 2, start: 4, end: 7 },
      { pageNumber: 3, start: 9, end: 11 },
    ]);
    expect(merged.filteredText.slice(4, 7)).toBe("识别二");
    expect(merged.filteredMarkdownPageSpans).toBeDefined();
    expect(merged.filteredMarkdownPageSpans!.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
    // 混合文档的 source 保持底本标签
    expect(merged.source).toBe("tier2-opendataloader-pdf");
  });

  it("汇总随页面重算：旧表格消失、新表格进来", () => {
    const merged = mergeScannedDocument({
      base: digitalBase(),
      ocrAnalyses: new Map([[2, ocrPage2]]),
    });
    expect(merged.allTables).toHaveLength(1);
    expect(merged.allTables[0].rows[0].cells.map((c) => c.text)).toEqual(["新", "表"]);
    expect(merged.pages[1].tables[0].rows[0].cells[0].text).toBe("新");
  });

  it("跳过的页（null）保留底本页面与底本文本", () => {
    const base = digitalBase();
    const merged = mergeScannedDocument({ base, ocrAnalyses: new Map([[2, null]]) });
    expect(merged.pages[1]).toBe(base.pages[1]);
    expect(merged.filteredText).toBe(base.filteredText);
    expect(merged.filteredPageSpans).toEqual(base.filteredPageSpans);
  });

  it("纯扫描文档（底本空文本无页界）：按页序从识别片段构建", () => {
    const base = doc({
      totalPages: 2,
      pages: [page(1), page(2)],
      filteredText: "",
      confidence: 0.5,
    });
    const merged = mergeScannedDocument({
      base,
      ocrAnalyses: new Map([
        [1, pageWithRoles(1, [{ role: "heading", text: "扫描标题" }])],
        [2, pageWithRoles(2, [{ role: "body", text: "扫描正文" }])],
      ]),
    });
    expect(merged.filteredText).toBe("扫描标题\n\n扫描正文");
    expect(merged.filteredPageSpans).toEqual([
      { pageNumber: 1, start: 0, end: 4 },
      { pageNumber: 2, start: 6, end: 10 },
    ]);
    expect(merged.filteredMarkdown).toBe("# 扫描标题\n\n扫描正文");
    // 整篇走识别：source 与置信度改按识别路径标
    expect(merged.source).toBe("scan-sidecar");
    expect(merged.confidence).toBe(0.8);
  });

  it("范围外的识别记录不撑数（页码范围收窄的场景）", () => {
    const base = digitalBase();
    const merged = mergeScannedDocument({
      base,
      ocrAnalyses: new Map([[99, pageWithRoles(99, [{ role: "body", text: "越界" }])]]),
    });
    expect(merged.pages).toHaveLength(3);
    expect(merged.filteredText).toBe(base.filteredText);
  });

  it("旧缓存（底本有文本但无页界）：保留底本，识别片段附后且不给页界", () => {
    const base = doc({
      totalPages: 2,
      pages: [pageWithRoles(1, [{ role: "body", text: "数字一" }]), page(2)],
      filteredText: "数字一",
      filteredMarkdown: "数字一",
    });
    const merged = mergeScannedDocument({
      base,
      ocrAnalyses: new Map([[2, pageWithRoles(2, [{ role: "body", text: "识别二" }])]]),
    });
    expect(merged.filteredText).toBe("数字一\n\n识别二");
    expect(merged.filteredPageSpans).toBeUndefined();
  });

  it("底本页界漏掉的页（无正文页）被识别出内容时按页序补入", () => {
    // 页 2 在数字底本里没有正文，因此没有 span；识别后它的文本应插在
    // 页 1 与页 3 之间，而不是附到整篇末尾。
    const base = doc({
      totalPages: 3,
      pages: [pageWithRoles(1, [{ role: "body", text: "甲" }]), page(2), pageWithRoles(3, [{ role: "body", text: "丙" }])],
      filteredText: "甲\n\n丙",
      filteredPageSpans: [
        { pageNumber: 1, start: 0, end: 1 },
        { pageNumber: 3, start: 3, end: 4 },
      ],
      filteredMarkdown: "甲\n\n丙",
      filteredMarkdownPageSpans: [
        { pageNumber: 1, start: 0, end: 1 },
        { pageNumber: 3, start: 3, end: 4 },
      ],
    });
    const merged = mergeScannedDocument({
      base,
      ocrAnalyses: new Map([[2, pageWithRoles(2, [{ role: "body", text: "乙识别" }])]]),
    });
    expect(merged.filteredText).toBe("甲\n\n乙识别\n\n丙");
    expect(merged.filteredPageSpans!.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
  });

  it("不改底本（非突变）", () => {
    const base = digitalBase();
    const before = JSON.stringify(base);
    mergeScannedDocument({ base, ocrAnalyses: new Map([[2, ocrPage2]]) });
    expect(JSON.stringify(base)).toBe(before);
  });
});
