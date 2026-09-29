/**
 * removalRects + maskOriginalText — 原文删除器的区域构建与渲染选项测试。
 *
 * buildRemovalRects 必须镜像渲染端的段落跳过逻辑：
 *   - 缺失译文 / 空译文 / 公式占位剥除后为空的段落不产生删除区域；
 *   - 退化（宽或高非正）的边界框不产生删除区域；
 *   - 页码 = assemblies 数组下标 + 1。
 *
 * renderOverlayTranslated 的 maskOriginalText: false 分支
 * （原文已由删除器移除时跳过白色遮罩）必须仍然产出合法 PDF。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";
import type { PdfDocumentAnalysis } from "../../src/core/pdf/PdfIR";
import {
  renderOverlayTranslated,
  stripFormulaPlaceholders,
} from "../../src/core/pdf/translation/LayoutPreservingRenderer";
import {
  buildRemovalRects,
  serializeRemovalRects,
} from "../../src/core/pdf/translation/removalRects";

function paragraph(overrides: Partial<{ x0: number; y0: number; x1: number; y1: number }> = {}) {
  return {
    x0: 50, y0: 700, x1: 300, y1: 715,
    x: 50, y: 700, size: 12, brk: undefined as any,
    ...overrides,
  };
}

function assemblyWith(texts: string[], paragraphs: any[]) {
  return {
    texts,
    paragraphs,
    formulas: [],
    globalLines: [],
  } as any;
}

describe("buildRemovalRects", () => {
  it("collects rects for translated paragraphs with 1-based page numbers", () => {
    const assemblies = [
      assemblyWith(["你好", "世界"], [paragraph(), paragraph({ y0: 600, y1: 615 })]),
      assemblyWith(["第二页"], [paragraph({ x0: 60, x1: 310 })]),
    ];
    const rects = buildRemovalRects(assemblies, [["你好", "世界"], ["第二页"]]);
    expect(rects).toEqual([
      { page: 1, x0: 50, y0: 700, x1: 300, y1: 715 },
      { page: 1, x0: 50, y0: 600, x1: 300, y1: 615 },
      { page: 2, x0: 60, y0: 700, x1: 310, y1: 715 },
    ]);
  });

  it("skips paragraphs whose translation is missing or empty (renderer keeps the original)", () => {
    const assemblies = [
      assemblyWith(["有译文", "没译文", "  "], [paragraph(), paragraph({ y0: 600, y1: 615 }), paragraph({ y0: 500, y1: 515 })]),
    ];
    // 第二段缺失（translated 数组更短）、第三段纯空白
    const rects = buildRemovalRects(assemblies, [["有译文"]]);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ page: 1, y0: 700, y1: 715 });
  });

  it("skips paragraphs whose translation is only formula placeholders", () => {
    // 与渲染端一致的判定：占位符剥除后为空的译文不渲染 → 也不删
    expect(stripFormulaPlaceholders("{v1} {v2}").text.trim()).toBe("");
    const assemblies = [
      assemblyWith(["{v1}{v2}", "正常译文"], [paragraph(), paragraph({ y0: 600, y1: 615 })]),
    ];
    const rects = buildRemovalRects(assemblies, [["{v1}{v2}", "正常译文"]]);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ y0: 600, y1: 615 });
  });

  it("skips degenerate bboxes (zero or negative width/height)", () => {
    const assemblies = [
      assemblyWith(["退化", "正常"], [
        paragraph({ x1: 50 }), // 宽为 0
        paragraph({ y0: 600, y1: 615 }),
      ]),
    ];
    const rects = buildRemovalRects(assemblies, [["退化", "正常"]]);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ y0: 600, y1: 615 });
  });

  it("produces an empty list when nothing is translated", () => {
    const assemblies = [assemblyWith(["a", "b"], [paragraph(), paragraph({ y0: 600, y1: 615 })])];
    expect(buildRemovalRects(assemblies, [])).toEqual([]);
    expect(buildRemovalRects(assemblies, [[], []])).toEqual([]);
  });
});

describe("serializeRemovalRects", () => {
  it("emits the remover CLI's rects-file format (1-based pages, comment header)", () => {
    const text = serializeRemovalRects([
      { page: 1, x0: 50.126, y0: 700, x1: 300, y1: 715 },
      { page: 2, x0: 60, y0: 600.005, x1: 310, y1: 615 },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# page x0 y0 x1 y1");
    expect(lines[1]).toBe("1 50.13 700 300 715");
    expect(lines[2]).toBe("2 60 600.01 310 615");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("renderOverlayTranslated maskOriginalText option", () => {
  const SOURCE_PDF = path.join(__dirname, "..", "zotero", "fixtures", "a.pdf");
  const CJK_FONT = path.join(__dirname, "..", "zotero", "fixtures", "NotoSansSC.ttf");

  it("renders a valid PDF without masks when the original text was already removed", async () => {
    if (!fs.existsSync(SOURCE_PDF)) return; // fixture 缺失时跳过
    const sourceBytes = fs.readFileSync(SOURCE_PDF);
    const cjkBytes = fs.existsSync(CJK_FONT) ? fs.readFileSync(CJK_FONT) : undefined;

    const analysis: PdfDocumentAnalysis = {
      source: "tier2-opendataloader-pdf",
      totalPages: 1,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            {
              text: "Hello",
              bbox: { x: 50, y: 700, width: 200, height: 15 },
              fontSize: 12,
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
        },
      ],
      allTables: [],
      allFormulas: [],
      allChartAreas: [],
      allCitations: [],
      filteredText: "",
      filteredMarkdown: "",
      confidence: 0.9,
      processingMs: 0,
    };
    const { assemblies } = odlAnalysisToAssembly(analysis);
    const baseOptions = {
      targetLanguage: "zh-CN",
      ...(cjkBytes ? { cjkFontBytes: cjkBytes } : {}),
    };

    const masked = await renderOverlayTranslated(
      sourceBytes,
      assemblies,
      [["你好"]],
      baseOptions,
    );
    const unmasked = await renderOverlayTranslated(
      sourceBytes,
      assemblies,
      [["你好"]],
      { ...baseOptions, maskOriginalText: false },
    );

    // 两种模式都产出合法 PDF；无遮罩分支缺少白色矩形，字节必然不同
    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(unmasked.bytes);
    expect(reloaded.getPageCount()).toBe(1);
    expect(unmasked.stats.paragraphsRendered).toBe(1);
    expect(Buffer.from(unmasked.bytes).equals(Buffer.from(masked.bytes))).toBe(false);
  });
});
