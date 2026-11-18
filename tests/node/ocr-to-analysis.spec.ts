/**
 * ocr-to-analysis.spec — OCR 侧车结果 → PdfIR 适配器测试。
 *
 * 适配器是扫描页进入主管线的唯一入口，产出必须与 OpenDataLoader 的 IR 同
 * 构，否则 odlAnalysisToAssembly / translateParagraphs / 渲染器全链路都
 * 要对 OCR 开特例。本文件钉住三件容易错的事：
 *   1. 坐标：像素框（左上原点、y 向下）→ PDF 用户空间（左下原点、y 向上），
 *      且缩放以位图实际尺寸为基准（不信 dpi 乘法）；
 *   2. 阅读顺序：同 blockId 拼段、块按首次出现排序——双栏页不交错；
 *   3. 公式：blockType 为 formula 的行标记 isFormula 原样带出，侧车另给的
 *      formulas 数组作为冗余来源收入，且不重复计数。
 *
 * 文档级聚合（filteredText/Markdown）属第二期，本文件只钉单页换算。
 *
 * 纯函数测试：构造合成 SidecarPageResult，不跑任何模型。
 */
import { describe, it, expect } from "vitest";
import {
  groupSidecarLines,
  joinLineTexts,
  sidecarPageToAnalysis,
  LINE_HEIGHT_TO_FONT_SIZE,
  MIN_OCR_FONT_SIZE,
} from "../../src/core/pdf/scan/ocrToAnalysis";
import type {
  SidecarPageResult,
  SidecarTextLine,
} from "../../src/core/pdf/scan/sidecarProtocol";

// A4 @200dpi：595.28 × 841.89 pt ↔ 1654 × 2339 px（位图取整后的实际尺寸）
const PAGE_PT = { width: 595.28, height: 841.89 };
const RENDER_PX = { width: 1654, height: 2339 };

function line(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  text: string,
  blockId: number,
  blockType?: string,
): SidecarTextLine {
  return { bbox: { x0, y0, x1, y1 }, text, blockId, ...(blockType ? { blockType } : {}) };
}

function page(over: Partial<SidecarPageResult> = {}): SidecarPageResult {
  return {
    pageNumber: 1,
    pageSizePt: PAGE_PT,
    renderSizePx: RENDER_PX,
    dpi: 200,
    rotation: 0,
    lines: [],
    formulas: [],
    tables: [],
    figures: [],
    coverage: 0.5,
    ...over,
  };
}

/** 一页典型内容：标题、两段正文（各两行）、一个行内公式行。 */
function typicalPage(over: Partial<SidecarPageResult> = {}): SidecarPageResult {
  return page({
    lines: [
      // 标题（块 0，大字）
      line(200, 100, 1400, 160, "Deep Learning for PDFs", 0, "title"),
      // 正文第一段（块 1，两行）
      line(200, 200, 1400, 228, "We present a pipeline that recognizes", 1, "text"),
      line(200, 228, 1380, 256, "scanned documents end to end.", 1, "text"),
      // 行内公式行（块 2）
      line(200, 300, 900, 328, "$E = mc^2$", 2, "formula"),
      // 正文第二段（块 3）
      line(200, 400, 1400, 428, "Experiments confirm the approach.", 3, "text"),
    ],
    ...over,
  });
}

describe("groupSidecarLines", () => {
  it("同 blockId 拼成一块，块按首次出现排序（阅读顺序）", () => {
    const groups = groupSidecarLines([
      line(0, 0, 10, 10, "b1-line2", 1),
      line(0, 0, 10, 10, "b0-line1", 0),
      line(0, 0, 10, 10, "b1-line1", 1),
      line(0, 0, 10, 10, "b2-line1", 2),
    ]);
    expect(groups.map((g) => g.blockId)).toEqual([1, 0, 2]);
    expect(groups[0].lines.map((l) => l.text)).toEqual(["b1-line2", "b1-line1"]);
  });

  it("blockType 取块内第一个带类型的行", () => {
    const groups = groupSidecarLines([
      line(0, 0, 10, 10, "a", 0),
      line(0, 0, 10, 10, "b", 0, "title"),
    ]);
    expect(groups[0].blockType).toBe("title");
  });
});

describe("joinLineTexts", () => {
  it("英文断行补空格", () => {
    expect(joinLineTexts(["hello", "world"])).toBe("hello world");
  });

  it("中文断行不补空格", () => {
    expect(joinLineTexts(["第一行", "第二行"])).toBe("第一行第二行");
  });

  it("中英交界不补空格（渲染器自行换行）", () => {
    expect(joinLineTexts(["方法", "method"])).toBe("方法method");
  });
});

describe("sidecarPageToAnalysis", () => {
  it("坐标按位图实际尺寸换算并翻转 y", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    const title = analysis.textBlocks[0];
    // 标题块像素框 x 200–1400, y 100–160 → 点：x ≈ 71.95–503.7，y 顶 ≈ 786.8
    const sx = PAGE_PT.width / RENDER_PX.width;
    const sy = PAGE_PT.height / RENDER_PX.height;
    expect(title.bbox.x).toBeCloseTo(200 * sx, 1);
    expect(title.bbox.width).toBeCloseTo(1200 * sx, 1);
    expect(title.bbox.y).toBeCloseTo(PAGE_PT.height - 160 * sy, 1);
    expect(title.bbox.height).toBeCloseTo(60 * sy, 1);
  });

  it("字号按行框中位高度估算并钳制", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    const title = analysis.textBlocks[0];
    // 标题行高 60px → 21.6pt × 0.85 ≈ 18.4
    const expected = Math.max(
      MIN_OCR_FONT_SIZE,
      (60 / RENDER_PX.height) * PAGE_PT.height * LINE_HEIGHT_TO_FONT_SIZE,
    );
    expect(title.fontSize).toBeCloseTo(expected, 1);
    // 正文行高 28px → ≈ 8.6pt
    const body = analysis.textBlocks[1];
    expect(body.fontSize).toBeCloseTo((28 / RENDER_PX.height) * PAGE_PT.height * LINE_HEIGHT_TO_FONT_SIZE, 1);
  });

  it("标题块标记加粗，正文不加粗", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    expect(analysis.textBlocks[0].bold).toBe(true);
    expect(analysis.textBlocks[1].bold).toBeUndefined();
  });

  it("块内多行文本按断行规则拼接，段落框取并集", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    const body = analysis.textBlocks[1];
    expect(body.text).toBe("We present a pipeline that recognizes scanned documents end to end.");
    // 并集：x 200–1400，y 200–256
    const sy = PAGE_PT.height / RENDER_PX.height;
    expect(body.bbox.y).toBeCloseTo(PAGE_PT.height - 256 * sy, 1);
    expect(body.bbox.height).toBeCloseTo(56 * sy, 1);
  });

  it("公式行标记 isFormula，文本即 LaTeX，区域角色为 formula", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    const formula = analysis.textBlocks.find((b) => b.isFormula);
    expect(formula).toBeDefined();
    expect(formula!.text).toBe("$E = mc^2$");
    expect(analysis.regions.find((r) => r.role === "formula")).toBeDefined();
    // 公式只从 lines 来时不进 PdfFormula 列表（那是由 formulas 数组填充的）
    expect(analysis.formulas).toHaveLength(0);
  });

  it("侧车另给的 formulas 数组作为冗余来源：补文本块与 PdfFormula", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        formulas: [
          { bbox: { x0: 200, y0: 500, x1: 900, y1: 560 }, latex: "$$\\int_0^1 x dx$$", isDisplay: true },
          // 空 LaTeX 的条目直接跳过，不产空段落
          { bbox: { x0: 200, y0: 600, x1: 900, y1: 660 }, latex: "   ", isDisplay: false },
        ],
      }),
    );
    const formulaBlocks = analysis.textBlocks.filter((b) => b.isFormula);
    expect(formulaBlocks).toHaveLength(2); // 行内公式 + 一个数组公式
    expect(formulaBlocks[1].text).toBe("$$\\int_0^1 x dx$$");
    expect(analysis.formulas).toHaveLength(1);
    expect(analysis.formulas[0].textRepresentation).toBe("$$\\int_0^1 x dx$$");
    expect(analysis.formulas[0].isDisplay).toBe(true);
  });

  it("表格与图区登记边界框（无 HTML 时只计数，结构留空）", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        tables: [{ bbox: { x0: 100, y0: 700, x1: 1500, y1: 1200 } }],
        figures: [{ bbox: { x0: 100, y0: 1400, x1: 800, y1: 1800 } }],
      }),
    );
    expect(analysis.tables).toHaveLength(1);
    expect(analysis.tables[0].rows).toEqual([]);
    expect(analysis.chartAreas).toHaveLength(1);
    expect(analysis.chartAreas[0].detectedType).toBe("unknown");
  });

  it("表格 HTML 还原成行/单元格（含 colspan/rowspan 与文本）", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        tables: [
          {
            bbox: { x0: 100, y0: 700, x1: 1500, y1: 1200 },
            html:
              "<table><tr><td>甲</td><td>乙</td></tr>" +
              "<tr><td>丙</td><td>丁</td></tr></table>",
          },
        ],
      }),
    );
    const table = analysis.tables[0];
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells.map((c) => c.text)).toEqual(["甲", "乙"]);
    expect(table.rows[1].cells.map((c) => c.text)).toEqual(["丙", "丁"]);
    for (const row of table.rows) {
      for (const cell of row.cells) {
        expect(cell.colspan).toBe(1);
        expect(cell.rowspan).toBe(1);
      }
    }
  });

  it("单元格近似框：网格均分，首行贴表格顶边、末行贴底边", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        tables: [
          {
            bbox: { x0: 0, y0: 0, x1: 1654, y1: 2339 }, // 整页
            html: "<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>",
          },
        ],
      }),
    );
    const table = analysis.tables[0];
    const [tl, tr] = table.rows[0].cells;
    const [bl, br] = table.rows[1].cells;
    // 表格框即整页（左下原点：x/y 是左/下缘，宽高向右上展开）
    expect(table.bbox.x).toBeCloseTo(0, 5);
    expect(table.bbox.y).toBeCloseTo(0, 5);
    expect(table.bbox.width).toBeCloseTo(PAGE_PT.width, 5);
    expect(table.bbox.height).toBeCloseTo(PAGE_PT.height, 5);
    const halfW = PAGE_PT.width / 2;
    const halfH = PAGE_PT.height / 2;
    // 左上格：左半、上半（y 是下缘，落在半高处）
    expect(tl.bbox.x).toBeCloseTo(0, 5);
    expect(tl.bbox.width).toBeCloseTo(halfW, 5);
    expect(tl.bbox.y).toBeCloseTo(halfH, 5);
    expect(tl.bbox.height).toBeCloseTo(halfH, 5);
    // 右上格：右半、上半
    expect(tr.bbox.x).toBeCloseTo(halfW, 5);
    expect(tr.bbox.width).toBeCloseTo(halfW, 5);
    expect(tr.bbox.y).toBeCloseTo(halfH, 5);
    // 左下格：左半、下半（下缘贴表格底边）
    expect(bl.bbox.x).toBeCloseTo(0, 5);
    expect(bl.bbox.y).toBeCloseTo(0, 5);
    expect(bl.bbox.height).toBeCloseTo(halfH, 5);
    // 右下格：右半、下半
    expect(br.bbox.x).toBeCloseTo(halfW, 5);
    expect(br.bbox.y).toBeCloseTo(0, 5);
  });

  it("rowspan 单元格的框纵向跨两行", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        tables: [
          {
            bbox: { x0: 0, y0: 0, x1: 1654, y1: 2339 },
            html:
              "<table><tr><td rowspan=2>侧</td><td>上</td></tr>" +
              "<tr><td>下</td></tr></table>",
          },
        ],
      }),
    );
    const rows = analysis.tables[0].rows;
    const side = rows[0].cells[0];
    expect(side.rowspan).toBe(2);
    expect(side.bbox.y).toBeCloseTo(0, 5); // 下缘贴表格底边
    expect(side.bbox.height).toBeCloseTo(PAGE_PT.height, 5); // 贯穿整个表格高度
    // 第二行只剩一格，列起点被 rowspan 挤到第 1 列
    expect(rows[1].cells).toHaveLength(1);
    expect(rows[1].cells[0].text).toBe("下");
  });

  it("表格 HTML 无法解析：退回只登记区域，不抛", () => {
    const analysis = sidecarPageToAnalysis(
      typicalPage({
        tables: [{ bbox: { x0: 100, y0: 700, x1: 1500, y1: 1200 }, html: "<div>坏</div>" }],
      }),
    );
    expect(analysis.tables).toHaveLength(1);
    expect(analysis.tables[0].rows).toEqual([]);
  });

  it("页面尺寸取侧车回报的页尺寸（点）", () => {
    const analysis = sidecarPageToAnalysis(typicalPage());
    expect(analysis.width).toBeCloseTo(PAGE_PT.width, 5);
    expect(analysis.height).toBeCloseTo(PAGE_PT.height, 5);
    expect(analysis.pageNumber).toBe(1);
  });

  it("空页（无任何元素）产出空段落而不是报错", () => {
    const analysis = sidecarPageToAnalysis(page({ noContent: true }));
    expect(analysis.textBlocks).toEqual([]);
    expect(analysis.formulas).toEqual([]);
  });
});
