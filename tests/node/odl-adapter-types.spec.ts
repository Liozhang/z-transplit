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
