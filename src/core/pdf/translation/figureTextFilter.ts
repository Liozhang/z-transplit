/**
 * figureTextFilter — 图片区域文字的整体排除。
 *
 * 矢量图（matplotlib/TikZ 等嵌入 PDF）在页面内容流中以表单对象（Form
 * XObject）引用，删除器检查模式（--inspect）报告这些含文字表单的边界框。
 * 落在边界框内的解析段落（坐标刻度、图例、示意图标注）整体排除：
 * 不翻译、不画遮罩、不删原文、不叠印译文——图内保持原样。
 *
 * 图注（"Figure 1. …"）位于页面层、在表单边界框之外，不受影响，照常翻译。
 * 纯光栅图片不会产生文字段落，无需处理。
 *
 * 护栏：面积达到整页 85% 的表单视为页级包装（少数出版商工具把整页内容
 * 包进一个表单），不作为图片区域——否则整页正文会被误排除。
 *
 * 本模块为纯函数，Host 无关，可进 Node 单测。
 */

import type { PdfPageAnalysis } from "../PdfIR";

/** 含文字表单对象的边界框：PDF 用户坐标系（原点左下），页码从 1 开始。 */
export interface FigureRegion {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 页级包装判定：表单边界框面积占页面面积的比例达到该值时不算图片区域。 */
const WRAPPER_AREA_FRACTION = 0.85;

/**
 * 解析删除器 --inspect 的输出（每行 `page x0 y0 x1 y1`，# 注释与空行容忍，
 * 兼容 CRLF）。无法解析的行跳过，不抛错——过滤是尽力而为的增强。
 */
export function parseFigureRegionLines(text: string): FigureRegion[] {
  const regions: FigureRegion[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const page = Number(parts[0]);
    const x0 = Number(parts[1]);
    const y0 = Number(parts[2]);
    const x1 = Number(parts[3]);
    const y1 = Number(parts[4]);
    if (![page, x0, y0, x1, y1].every((v) => Number.isFinite(v))) continue;
    if (page < 1) continue;
    regions.push({
      page,
      x0: Math.min(x0, x1),
      y0: Math.min(y0, y1),
      x1: Math.max(x0, x1),
      y1: Math.max(y0, y1),
    });
  }
  return regions;
}

/**
 * 从各页 textBlocks 中移除落在图片区域内的段落（原地修改），返回移除数。
 *
 * 判定用段落几何中心：轴刻度这类骑在边界上的小块，中心在内即排除，
 * 中心在外则保留（图注整段在表单框外，中心判定天然安全）。
 */
export function excludeFigureTextBlocks(
  pages: Array<
    Pick<PdfPageAnalysis, "pageNumber" | "width" | "height" | "textBlocks">
  >,
  regions: FigureRegion[],
): number {
  if (regions.length === 0) return 0;
  let removed = 0;
  for (const page of pages) {
    const pageArea = page.width * page.height;
    const pageRegions = regions.filter(
      (r) =>
        r.page === page.pageNumber &&
        (r.x1 - r.x0) * (r.y1 - r.y0) < pageArea * WRAPPER_AREA_FRACTION,
    );
    if (pageRegions.length === 0 || page.textBlocks.length === 0) continue;
    const kept = page.textBlocks.filter((b) => {
      const cx = b.bbox.x + b.bbox.width / 2;
      const cy = b.bbox.y + b.bbox.height / 2;
      const inside = pageRegions.some(
        (r) =>
          cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1,
      );
      if (inside) removed++;
      return !inside;
    });
    page.textBlocks = kept;
  }
  return removed;
}
