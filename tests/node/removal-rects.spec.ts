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
import { sourcePdfBytes, cjkFontBytes } from "./helpers/sourceFixture";
import {
  renderOverlayTranslated,
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
    // 与渲染端的遮罩对齐：裁剪后向外扩 1 磅。此前删除端不扩张，删除成功的
    // PDF 上留下一圈 1 磅宽的字形残边。
    expect(rects).toEqual([
      { page: 1, x0: 49, y0: 699, x1: 301, y1: 716 },
      { page: 1, x0: 49, y0: 599, x1: 301, y1: 616 },
      { page: 2, x0: 59, y0: 699, x1: 311, y1: 716 },
    ]);
  });

  it("skips paragraphs whose translation is missing or empty (renderer keeps the original)", () => {
    const assemblies = [
      assemblyWith(["有译文", "没译文", "  "], [paragraph(), paragraph({ y0: 600, y1: 615 }), paragraph({ y0: 500, y1: 515 })]),
    ];
    // 第二段缺失（translated 数组更短）、第三段纯空白
    const rects = buildRemovalRects(assemblies, [["有译文"]]);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ page: 1, y0: 699, y1: 716 });
  });

  it("removes pure-formula paragraphs — they render as readable math now", () => {
    // 旧行为：`{vn}` 占位符剥除后为空 → 不渲染也不删。新行为：`$...$` 段经
    // latexToPlain 变成可读数学符号后照常渲染，遮罩盖住了原文，所以也要删。
    const assemblies = [
      assemblyWith(["$E = mc^2$", "正常译文"], [paragraph(), paragraph({ y0: 600, y1: 615 })]),
    ];
    const rects = buildRemovalRects(assemblies, [["$E = mc^2$", "正常译文"]]);
    expect(rects).toHaveLength(2);
  });

  it("removes a formula region covered by a screenshot even when its text is empty", () => {
    // LaTeX 提取失败时译文被清空，渲染端于是跳过文字、只贴截图。截图只盖住
    // 画面，内容流里的公式字符照样能被搜索和复制——这一区必须进删除清单。
    const assemblies = [
      {
        ...assemblyWith(["", "正常译文"], [paragraph(), paragraph({ y0: 600, y1: 615 })]),
        placedFormulas: [
          { bbox: { x: 50, y: 700, width: 250, height: 15 }, dataUri: "data:image/png;base64,AA==" },
        ],
      },
    ];
    const rects = buildRemovalRects(assemblies, [["", "正常译文"]]);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ page: 1, x0: 49, y0: 699, x1: 301, y1: 716 });
  });

  it("clamps off-page boxes to the MediaBox before expanding", () => {
    // OpenDataLoader 会给出越界框（实例：612 宽页面上的 x=635）。此前原样写进
    // 区域文件，删除器按一个页面外的框去删，什么都删不到。
    const assemblies = [
      assemblyWith(["越界"], [paragraph({ x1: 635 })]),
    ];
    const rects = buildRemovalRects(assemblies, [["越界"]], [{ width: 612, height: 792 }]);
    expect(rects).toEqual([{ page: 1, x0: 49, y0: 699, x1: 613, y1: 716 }]);
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
    expect(rects[0]).toMatchObject({ y0: 599, y1: 616 });
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
  // 同 odl-to-assembly.spec：夹具解析见 helpers/sourceFixture。这条用例是唯一
  // 覆盖 `maskOriginalText: false`（删除器成功路径）的测试，此前从未真正跑过。
  const sourceBytes = sourcePdfBytes();
  const cjkBytes = cjkFontBytes();

  it("renders a valid PDF without masks when the original text was already removed", async () => {

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
