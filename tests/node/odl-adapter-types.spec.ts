/**
 * Unit test: verify OpenDataLoaderJsonAdapter maps ODL formula/citation/chart
 * types. Migrated from leadero's tests/zotero/odl-adapter-types-unit.test.ts (a
 * file-level script with process.exit that no runner loaded — pure logic,
 * belongs under vitest per the tests/ runner-split convention).
 *
 * Ported from leadero's tests/node/odl-adapter-types.spec.ts (import paths are
 * unchanged — the port mirrors leadero's src/ layout).
 */
import { describe, expect, it } from "vitest";

import { adaptOpenDataLoaderJson } from "../../src/core/pdf/OpenDataLoaderJsonAdapter";

const syntheticRoot = {
  "file name": "test.pdf",
  "number of pages": 1,
  author: null,
  title: null,
  "creation date": null,
  "modification date": null,
  kids: [
    {
      type: "formula",
      id: 1,
      "page number": 1,
      "bounding box": [100, 500, 200, 550],
      latex: "E = mc^2",
      text: "E = mc^2",
      isDisplay: true,
    },
    {
      type: "formula",
      id: 2,
      "page number": 1,
      "bounding box": [100, 400, 150, 420],
      text: "x_{n+1}",
      isDisplay: false,
    },
    {
      type: "chart",
      id: 3,
      "page number": 1,
      "bounding box": [300, 300, 500, 450],
      chartType: "bar",
    },
    {
      type: "chart",
      id: 4,
      "page number": 1,
      "bounding box": [300, 100, 500, 250],
      chartType: "pie",
    },
    {
      type: "citation",
      id: 5,
      "page number": 1,
      "bounding box": [400, 50, 500, 70],
      font: "CMR10",
      "font size": 10,
      "text color": "[0.0]",
      content: "(Smith et al., 2020)",
      doi: "10.1234/example",
    },
    {
      type: "heading",
      id: 6,
      "page number": 1,
      "bounding box": [72, 700, 300, 720],
      "heading level": 1,
      font: "CMR17",
      "font size": 17,
      "text color": "[0.0]",
      content: "Results",
    },
    {
      type: "paragraph",
      id: 7,
      "page number": 1,
      "bounding box": [72, 650, 400, 690],
      font: "CMR12",
      "font size": 12,
      "text color": "[0.0]",
      content: "We found that...",
    },
  ],
};

const result = adaptOpenDataLoaderJson(syntheticRoot as any);

describe("ODL adapter type mapping (formulas)", () => {
  it("collects both formulas", () => {
    expect(result.allFormulas).toHaveLength(2);
  });
  it("preserves latex text, display flag, and bbox", () => {
    expect(result.allFormulas[0]?.textRepresentation).toBe("E = mc^2");
    expect(result.allFormulas[0]?.isDisplay).toBe(true);
    expect(result.allFormulas[1]?.isDisplay).toBe(false);
    expect(result.allFormulas[0]?.bbox.x).toBe(100);
    expect(result.allFormulas[0]?.bbox.y).toBe(500);
  });
});

describe("ODL adapter type mapping (charts)", () => {
  it("collects both charts with detected types", () => {
    expect(result.allChartAreas).toHaveLength(2);
    expect(result.allChartAreas[0]?.detectedType).toBe("bar-chart");
    expect(result.allChartAreas[1]?.detectedType).toBe("pie-chart");
  });
  it("marks bar with axes and pie with legend", () => {
    expect(result.allChartAreas[0]?.hasAxes).toBe(true);
    expect(result.allChartAreas[1]?.hasLegend).toBe(true);
  });
});

describe("ODL adapter type mapping (citations)", () => {
  it("collects text, doi, and unknown style", () => {
    expect(result.allCitations).toHaveLength(1);
    expect(result.allCitations[0]?.text).toBe("(Smith et al., 2020)");
    expect(result.allCitations[0]?.doi).toBe("10.1234/example");
    expect(result.allCitations[0]?.style).toBe("unknown");
  });
});

describe("ODL adapter basic structure", () => {
  it("reports page count, text blocks, and markdown", () => {
    expect(result.totalPages).toBe(1);
    // heading + paragraph only — citations are collected separately into
    // allCitations, not textBlocks (the orphan script's original `=== 3`
    // expectation was never executed and never held).
    expect(result.pages[0]?.textBlocks).toHaveLength(2);
    expect(result.pages[0]?.textBlocks.map((b) => b.text)).toEqual([
      "Results",
      "We found that...",
    ]);
    expect(result.filteredMarkdown).toContain("# Results");
  });

  // 回归钉死（真实机构建 9/9 skip）：filteredTextParts.push 曾被整段删掉，
  // filteredText 从此恒为空串 → 对所有 PDF 抛 no-text → 全链路瘫痪，而旧断言
  // 只看 textBlocks/filteredMarkdown，回归照样全绿。
  it("aggregates filteredText and keeps page-span accounting consistent", () => {
    expect(result.filteredText).toBe("Results\n\nWe found that...");
    // filteredPageSpans 是可选项（旧缓存降级路径）——先钉死它存在，再断言内容。
    const spans = result.filteredPageSpans;
    expect(spans).toBeDefined();
    expect(spans!).toHaveLength(1);
    expect(spans![0]).toEqual({ pageNumber: 1, start: 0, end: result.filteredText.length });
  });
});

// 页界记账的切片自洽：文档级聚合（scanDocumentAggregate）按页界把数字页的
// 聚合原样保留、只替换识别页，因此"按 span 切回去必须一字不差"是读取路径的
// 前提。这里用真实适配器的产出验证纯文本与 Markdown 两侧，并覆盖两类曾把
// 记账带偏的形态：首段为空串（无行表格）、表格只进 Markdown（两侧收集点
// 不同）。
describe("ODL adapter page-span slicing self-consistency", () => {
  /** 三页：第 1 页只有一张无行表格（Markdown 侧首段为空串），第 2 页标题+段落，第 3 页列表。 */
  const multiPageRoot = {
    "file name": "multi.pdf",
    "number of pages": 3,
    author: null,
    title: null,
    "creation date": null,
    "modification date": null,
    kids: [
      {
        type: "table",
        id: 1,
        "page number": 1,
        "bounding box": [72, 700, 400, 760],
        rows: [], // 无行表格：tableToMarkdown 返回空串
      },
      {
        type: "heading",
        id: 2,
        "page number": 2,
        "bounding box": [72, 700, 300, 720],
        "heading level": 2,
        font: "CMR14",
        "font size": 14,
        "text color": "[0.0]",
        content: "第二章",
      },
      {
        type: "paragraph",
        id: 3,
        "page number": 2,
        "bounding box": [72, 650, 400, 690],
        font: "CMR12",
        "font size": 12,
        "text color": "[0.0]",
        content: "第二页正文。",
      },
      {
        type: "table",
        id: 4,
        "page number": 2,
        "bounding box": [72, 500, 400, 560],
        rows: [
          {
            cells: [
              {
                "bounding box": [72, 530, 200, 560],
                "column span": 1,
                "row span": 1,
                kids: [{ type: "paragraph", content: "甲", font: "CMR10", "font size": 10, "text color": "[0.0]" }],
              },
              {
                "bounding box": [200, 530, 400, 560],
                "column span": 1,
                "row span": 1,
                kids: [{ type: "paragraph", content: "乙", font: "CMR10", "font size": 10, "text color": "[0.0]" }],
              },
            ],
          },
        ],
      },
      {
        type: "list",
        id: 5,
        "page number": 3,
        "bounding box": [72, 650, 400, 760],
        "list items": [
          {
            type: "paragraph",
            content: "第一项",
            font: "CMR12",
            "font size": 12,
            "text color": "[0.0]",
            "bounding box": [72, 700, 400, 730],
          },
          {
            type: "paragraph",
            content: "第二项",
            font: "CMR12",
            "font size": 12,
            "text color": "[0.0]",
            "bounding box": [72, 660, 400, 690],
          },
        ],
      },
    ],
  };

  const multi = adaptOpenDataLoaderJson(multiPageRoot as any);

  /** 按页界切片再拼回，必须与原文严格相等（一个字符都不许多或少）。 */
  function sliceBack(
    text: string,
    spans: Array<{ pageNumber: number; start: number; end: number }> | undefined,
  ): string {
    expect(spans).toBeDefined();
    return spans!.map((s) => text.slice(s.start, s.end)).join("\n\n");
  }

  it("纯文本侧：按 filteredPageSpans 切片拼回等于原文", () => {
    expect(sliceBack(multi.filteredText, multi.filteredPageSpans)).toBe(
      multi.filteredText,
    );
    // 第 1 页只有无行表格 → 不进纯文本，因此纯文本从第 2 页开始
    expect(multi.filteredPageSpans!.map((s) => s.pageNumber)).toEqual([2, 3]);
    expect(multi.filteredText).toBe("第二章\n\n第二页正文。\n\n第一项\n\n第二项");
  });

  it("Markdown 侧：按 filteredMarkdownPageSpans 切片拼回等于原文", () => {
    expect(sliceBack(multi.filteredMarkdown, multi.filteredMarkdownPageSpans)).toBe(
      multi.filteredMarkdown,
    );
  });

  it("首段为空串时后续页界不错位（累计长度判首段的老缺陷）", () => {
    // 无行表格让 Markdown 侧的第一个收录片段是空串：若按"累计长度为 0"判断
    // 首段，第 2 页及其后每一段的起点都会少算 2 个字符。
    const mdSpans = multi.filteredMarkdownPageSpans!;
    expect(mdSpans.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
    // 第 1 页是空串（起点 0、长度 0）；第 2 页从 2 开始（跳过一个分隔符）
    expect(mdSpans[0]).toEqual({ pageNumber: 1, start: 0, end: 0 });
    expect(mdSpans[1].start).toBe(2);
    expect(multi.filteredMarkdown.slice(mdSpans[1].start, mdSpans[1].end)).toBe(
      "## 第二章\n\n第二页正文。\n\n| 甲 | 乙 |\n| --- | --- |",
    );
    // 末段结尾与整串结尾严格对齐
    expect(mdSpans[mdSpans.length - 1].end).toBe(multi.filteredMarkdown.length);
  });

  it("表格只进 Markdown：同页两侧的 span 不同（收集点差异被各自记账）", () => {
    const textSpans = new Map(multi.filteredPageSpans!.map((s) => [s.pageNumber, s]));
    const mdSpans = new Map(multi.filteredMarkdownPageSpans!.map((s) => [s.pageNumber, s]));
    expect(textSpans.get(2)!.end - textSpans.get(2)!.start).toBeLessThan(
      mdSpans.get(2)!.end - mdSpans.get(2)!.start,
    );
    expect(multi.filteredMarkdown).toContain("| 甲 | 乙 |");
    expect(multi.filteredText).not.toContain("甲");
  });
});
