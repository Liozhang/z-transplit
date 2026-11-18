/**
 * pageClassification 测试（src/core/pdf/scan/pageClassification.ts）。
 *
 * 分类决定一页走 OpenDataLoader 还是 OCR 侧车。两类误判代价不对称：
 * 数字页误判成扫描页只是多跑一次识别；劣质文本层页漏判会把乱码当正文
 * 翻译——最隐蔽的遗漏来源。本文件锁住三种去向的判定边界、表格文本计入
 * 字符数的规则（整页表格是数字页）、以及乱码特征的覆盖（控制符/私用区/
 * 替换符）。
 */
import { describe, it, expect } from "vitest";
import {
  classifyPage,
  classifyPages,
  needsOcr,
  pageTextStats,
  MIN_PAGE_TEXT_CHARS,
  MIN_SANE_RATIO,
  type PageTextStats,
} from "../../../../../src/core/pdf/scan/pageClassification";
import type { PdfPageAnalysis, PdfTextBlock } from "../../../../../src/core/pdf/PdfIR";

function block(text: string, pageNumber = 1): PdfTextBlock {
  return {
    text,
    bbox: { x: 0, y: 0, width: 100, height: 12 },
    fontSize: 10,
    fontName: "Times",
    hasEOL: false,
  };
}

function page(over: Partial<PdfPageAnalysis>): PdfPageAnalysis {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
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

function stats(over: Partial<PageTextStats>): PageTextStats {
  return { pageNumber: 1, textLength: 500, blockCount: 4, saneRatio: 1, ...over };
}

describe("pageTextStats", () => {
  it("统计正文块字符数时去掉空白", () => {
    const s = pageTextStats(page({ textBlocks: [block("  hello \n world  ")] }));
    expect(s.textLength).toBe("helloworld".length);
    expect(s.blockCount).toBe(1);
  });

  it("表格单元格文本计入字符数——整页只有一张表的页不是扫描页", () => {
    const s = pageTextStats(
      page({
        textBlocks: [],
        tables: [
          {
            pageNumber: 1,
            bbox: { x: 0, y: 0, width: 400, height: 200 },
            rows: [
              { cells: [{ text: "Method", colspan: 1, rowspan: 1, bbox: { x: 0, y: 0, width: 50, height: 12 } }] },
              { cells: [{ text: "Result", colspan: 1, rowspan: 1, bbox: { x: 0, y: 0, width: 50, height: 12 } }] },
            ],
            confidence: 1,
          },
        ],
      }),
    );
    expect(s.textLength).toBe("MethodResult".length);
  });

  it("空页的 saneRatio 定义为 1（无字符可判）", () => {
    const s = pageTextStats(page({}));
    expect(s.textLength).toBe(0);
    expect(s.saneRatio).toBe(1);
  });

  it("控制符、私用区码位与替换符都计入乱码比例", () => {
    // 10 个字符里 5 个是私用区码位 → 0.5。
    const s = pageTextStats(page({ textBlocks: [block("abcde\uE000\uE001\uE002\uE003\uE004")] }));
    expect(s.saneRatio).toBeCloseTo(0.5, 5);
  });

  it("常规标点与 CJK 不算乱码", () => {
    const s = pageTextStats(page({ textBlocks: [block("Hello, 世界！\u2014\u201C引用\u201D")] }));
    expect(s.saneRatio).toBe(1);
  });
});

describe("classifyPage", () => {
  it("有效字符不足 → scanned", () => {
    expect(classifyPage(stats({ textLength: MIN_PAGE_TEXT_CHARS - 1 }))).toBe("scanned");
  });

  it("达到字符下限且文本干净 → digital", () => {
    expect(classifyPage(stats({ textLength: MIN_PAGE_TEXT_CHARS }))).toBe("digital");
  });

  it("文本层大面积为乱码 → degraded（哪怕字符数很多）", () => {
    expect(classifyPage(stats({ textLength: 5000, saneRatio: MIN_SANE_RATIO - 0.01 }))).toBe("degraded");
  });

  it("刚好达到可读比例下限 → digital（保守方向：不轻易送 OCR）", () => {
    expect(classifyPage(stats({ saneRatio: MIN_SANE_RATIO }))).toBe("digital");
  });

  it("零字符页即使 saneRatio 为 1 也是 scanned（字符数规则优先）", () => {
    expect(classifyPage(stats({ textLength: 0, saneRatio: 1 }))).toBe("scanned");
  });
});

describe("needsOcr", () => {
  it("只有 digital 不需要 OCR", () => {
    expect(needsOcr("digital")).toBe(false);
    expect(needsOcr("scanned")).toBe(true);
    expect(needsOcr("degraded")).toBe(true);
  });
});

describe("classifyPages", () => {
  it("页序保持、计数正确、抽出 OCR 页清单", () => {
    const pages = [
      page({ pageNumber: 1, textBlocks: [block("A full page of real body text ".repeat(5))] }),
      page({ pageNumber: 2 }),
      page({ pageNumber: 3, textBlocks: [block("\uE000".repeat(80))] }),
      page({ pageNumber: 4, textBlocks: [block("Another real paragraph with plenty of words in it.")] }),
    ];
    const result = classifyPages(pages);
    expect(result.kinds).toEqual(["digital", "scanned", "degraded", "digital"]);
    expect(result.counts).toEqual({ digital: 2, scanned: 1, degraded: 1 });
    expect(result.ocrPages).toEqual([2, 3]);
  });
});
