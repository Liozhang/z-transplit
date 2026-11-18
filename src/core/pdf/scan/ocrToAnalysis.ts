/**
 * ocrToAnalysis — 把侧车的单页识别结果翻译成 PdfIR（PdfPageAnalysis）。
 *
 * 这是扫描页进入主管线的唯一入口：产出与 OpenDataLoaderJsonAdapter 同一
 * 套 IR，于是 odlAnalysisToAssembly、translateParagraphs、
 * LayoutPreservingRenderer 全链路零改动复用。切换识别引擎不改这里——
 * 契约是 sidecarProtocol 的 JSON，不是引擎本身。主管线按页取用本模块的
 * 产出（见 mergeScannedAssemblies），不做文档级聚合——那属第二期，随
 * 朗读/文本导出等消费方一起接入。
 *
 * 三处关键换算：
 *   1. 坐标：位图像素框（原点左上、y 向下）→ PDF 用户空间（原点左下、
 *      y 向上），缩放以位图实际尺寸为基准（渲染取整会漂，不信 dpi 乘法）；
 *   2. 字号：OCR 没有字号信息，按行框中位高度乘系数估算——估算只影响
 *      译文排版（渲染器会自行换行与缩字），不影响内容；
 *   3. 样式：版面块的 blockType 映射到 LayoutRole，标题类块直接标粗
 *      （PdfTextBlock.bold），不再伪造字体名去骗 parseFontStyle。
 *
 * 阅读顺序：侧车按阅读顺序输出行，同 blockId 的行拼成一个段落，块按
 * 首次出现排序——OCR 的双栏页面因此不会左右栏交错。
 *
 * 公式：以 blockType 为 "formula" 的行进入管线（文本即 LaTeX，标记
 * isFormula，odlToAssembly 会原样带出，不跑字符密度启发式）；侧车若
 * 另给 formulas 数组，作为冗余来源一并收入（附在文本块之后）。
 *
 * 表格：Phase 1 只登记区域与计数（结构还原与文本抽取属第二期，随文档级
 * 聚合一起接入）；表格区域本身维持"保留原文"的产品决策。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/ocrToAnalysis
 */

import type {
  BBox,
  LayoutRegion,
  LayoutRole,
  PdfChartArea,
  PdfFormula,
  PdfPageAnalysis,
  PdfTable,
  PdfTextBlock,
} from "../PdfIR";
import { pixelBoxToPdfBox } from "./pdfPageProbe";
import type { SidecarPageResult, SidecarTextLine } from "./sidecarProtocol";

/**
 * 行框高度 → 估算字号的换算系数。OCR 检测框紧贴字形（约 0.9–1.2 em），
 * 乘 0.85 得到接近真实字号的估计。只影响排版，不影响内容；实测偏差由
 * 渲染器的换行与缩字兜底。
 */
export const LINE_HEIGHT_TO_FONT_SIZE = 0.85;

/** 估算字号的钳制范围（点）。 */
export const MIN_OCR_FONT_SIZE = 5;
export const MAX_OCR_FONT_SIZE = 200;

/** 版面块类型 → IR 角色。未列出的类型按正文处理。 */
const BLOCK_TYPE_TO_ROLE: Record<string, LayoutRole> = {
  title: "title",
  heading: "heading",
  section: "heading",
  text: "body",
  plain_text: "body",
  body: "body",
  paragraph: "body",
  reference: "reference-entry",
  footnote: "footnote",
  sidebar: "sidebar",
  header: "header",
  footer: "footer",
  caption: "caption",
  figure_caption: "caption",
  table_caption: "caption",
  formula_caption: "caption",
};

/** 公式行的 blockType 约定值（见文件头"公式"一节）。 */
const FORMULA_BLOCK_TYPE = "formula";

export interface SidecarTextGroup {
  blockId: number;
  blockType?: string;
  lines: SidecarTextLine[];
}

/**
 * 按 blockId 把行拼成块，保持首次出现顺序（即阅读顺序）。
 * blockType 取块内第一个带类型的行。
 */
export function groupSidecarLines(lines: SidecarTextLine[]): SidecarTextGroup[] {
  const groups: SidecarTextGroup[] = [];
  const byId = new Map<number, SidecarTextGroup>();
  for (const line of lines) {
    let group = byId.get(line.blockId);
    if (!group) {
      group = { blockId: line.blockId, lines: [] };
      byId.set(line.blockId, group);
      groups.push(group);
    }
    if (!group.blockType && line.blockType) group.blockType = line.blockType;
    group.lines.push(line);
  }
  return groups;
}

/**
 * 拼接一个块内的多行文本。两侧都是拉丁字母数字时补一个空格（英文断行），
 * 其余直接相接（中文断行本无空格；渲染器会重新换行，不断行符）。
 */
export function joinLineTexts(texts: string[]): string {
  let out = "";
  for (const text of texts) {
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    const prev = out[out.length - 1];
    const next = text[0];
    const latinBoundary = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    out += (latinBoundary ? " " : "") + text;
  }
  return out;
}

/** 行框高度（点）的中位数——对个别带升降部的高行鲁棒。 */
function medianLineHeightPt(group: SidecarTextGroup, sy: number): number {
  const heights = group.lines
    .map((l) => Math.max(0, l.bbox.y1 - l.bbox.y0) * sy)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return 0;
  const mid = Math.floor(heights.length / 2);
  return heights.length % 2 === 1 ? heights[mid] : (heights[mid - 1] + heights[mid]) / 2;
}

/** 一组行的并集框（像素）→ PDF 点边界框。 */
function groupBBox(
  group: SidecarTextGroup,
  page: SidecarPageResult,
): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const line of group.lines) {
    x0 = Math.min(x0, line.bbox.x0);
    y0 = Math.min(y0, line.bbox.y0);
    x1 = Math.max(x1, line.bbox.x1);
    y1 = Math.max(y1, line.bbox.y1);
  }
  return pixelBoxToPdfBox({ x0, y0, x1, y1 }, page.renderSizePx, page.pageSizePt);
}

function clampFontSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return MIN_OCR_FONT_SIZE;
  return Math.min(MAX_OCR_FONT_SIZE, Math.max(MIN_OCR_FONT_SIZE, size));
}

/** 把侧车一页结果转成 PdfPageAnalysis。 */
export function sidecarPageToAnalysis(page: SidecarPageResult): PdfPageAnalysis {
  const sy = page.pageSizePt.height / Math.max(1, page.renderSizePx.height);
  const textBlocks: PdfTextBlock[] = [];
  const regions: LayoutRegion[] = [];

  const pushBlock = (
    text: string,
    bbox: BBox,
    role: LayoutRole,
    fontSize: number,
    extra: { bold?: boolean; isFormula?: boolean } = {},
  ): PdfTextBlock => {
    const block: PdfTextBlock = {
      text,
      bbox,
      fontSize,
      // OCR 不产出字体名；留空让下游走默认字体（加粗等样式走显式标记）。
      fontName: "",
      hasEOL: false,
      ...(extra.bold ? { bold: true } : {}),
      ...(extra.isFormula ? { isFormula: true } : {}),
    };
    textBlocks.push(block);
    regions.push({
      role,
      bbox,
      pageNumber: page.pageNumber,
      confidence: 0.85,
      content: [block],
    });
    return block;
  };

  // 1) 文本块（含公式行）：按阅读顺序。
  for (const group of groupSidecarLines(page.lines)) {
    const bbox = groupBBox(group, page);
    const type = (group.blockType || "").toLowerCase();
    const isFormula = type === FORMULA_BLOCK_TYPE;
    const role = isFormula ? "formula" : BLOCK_TYPE_TO_ROLE[type] ?? "body";
    const size = clampFontSize(medianLineHeightPt(group, sy) * LINE_HEIGHT_TO_FONT_SIZE);
    pushBlock(joinLineTexts(group.lines.map((l) => l.text)), bbox, role, size, {
      bold: role === "title" || role === "heading",
      ...(isFormula ? { isFormula: true } : {}),
    });
  }

  // 2) 侧车另给的 formulas 数组（冗余来源）：公式文本块附在文本块之后，
  //    顺序损失可接受——每段各自按绝对坐标落位，顺序只影响翻译批次上下文。
  const formulas: PdfFormula[] = [];
  for (const f of page.formulas) {
    const bbox = pixelBoxToPdfBox(f.bbox, page.renderSizePx, page.pageSizePt);
    const latex = f.latex.trim();
    if (!latex) continue;
    pushBlock(latex, bbox, "formula", clampFontSize(bbox.height * LINE_HEIGHT_TO_FONT_SIZE), {
      isFormula: true,
    });
    formulas.push({
      pageNumber: page.pageNumber,
      bbox,
      textRepresentation: latex,
      isDisplay: f.isDisplay,
      confidence: 0.9,
    });
  }

  // 3) 表格：只计数与抽文本（结构还原属第二期）。
  const tables: PdfTable[] = [];
  for (const t of page.tables) {
    const bbox = pixelBoxToPdfBox(t.bbox, page.renderSizePx, page.pageSizePt);
    tables.push({
      pageNumber: page.pageNumber,
      bbox,
      rows: [],
      confidence: 0.8,
    });
  }

  // 4) 图区：叠加模式下源页自带的图就在底版上，这里只登记区域供账目。
  const chartAreas: PdfChartArea[] = [];
  for (const f of page.figures) {
    chartAreas.push({
      pageNumber: page.pageNumber,
      bbox: pixelBoxToPdfBox(f.bbox, page.renderSizePx, page.pageSizePt),
      detectedType: "unknown",
      hasAxes: false,
      hasLegend: false,
      confidence: 0.6,
    });
  }

  return {
    pageNumber: page.pageNumber,
    width: page.pageSizePt.width,
    height: page.pageSizePt.height,
    textBlocks,
    regions,
    tables,
    chartAreas,
    formulas,
    repeatedElements: [],
    citations: [],
  };
}
