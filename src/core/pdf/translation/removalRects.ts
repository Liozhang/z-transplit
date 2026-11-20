/**
 * removalRects — 把"将被译文替换的段落"汇编成原文删除器的区域清单。
 *
 * 删除清单必须镜像渲染端的跳过逻辑（LayoutPreservingRenderer 的段落循环）：
 *   - `translatedSets[i][j]` 缺失的段落不删（渲染端跳过，原文保留）；
 *   - 公式区是例外：LaTeX 提取失败时译文被清空（渲染端跳过文字），但该区域
 *     的原文仍必须删——截图只盖住画面，内容流里的公式字符照样能被搜索和
 *     复制。产物 PDF 上看起来干净，底层文本层却留着原文；
 *   - 退化（宽高非正）的边界框不删。
 *
 * 几何与渲染端对齐，两条都是这次补上的：
 *   - 先按 MediaBox 裁剪。OpenDataLoader 会给出越界框（实例：612 宽页面上的
 *     x=635），此前原样写进区域文件；
 *   - 再向外扩 1 磅。渲染端的遮罩早就是裁剪后扩 1 磅，删除端两者皆无，于是
 *     删除成功的 PDF 上留下一圈 1 磅宽的字形残边。
 *
 * 坐标即 PDF 用户空间（原点左下、单位 pt），与 OpenDataLoader 输出的
 * boundingBox 同一坐标系，无需换算；页码 = assemblies 数组下标 + 1。
 * Host 无关 — 纯函数，可在 Node 单元测试。
 */

import type { AssemblyResult } from "./translationIR";
import { clampParagraph } from "./LayoutPreservingRenderer";

export interface RemovalRect {
  /** 1-based page index (matches the remover CLI's rects file). */
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 页面尺寸，用于把越界框裁回纸面。缺省时跳过裁剪。 */
export interface RemovalPageSize {
  width: number;
  height: number;
}

/** 段落框与截图区域是否相交（用于识别"这段被截图盖住了"）。 */
function intersectsPlacedFormula(
  p: { x0: number; y0: number; x1: number; y1: number },
  placed: readonly { bbox: { x: number; y: number; width: number; height: number } }[],
): boolean {
  return placed.some(
    (f) =>
      p.x0 < f.bbox.x + f.bbox.width &&
      f.bbox.x < p.x1 &&
      p.y0 < f.bbox.y + f.bbox.height &&
      f.bbox.y < p.y1,
  );
}

export function buildRemovalRects(
  assemblies: AssemblyResult[],
  translatedSets: string[][],
  pageSizes?: RemovalPageSize[],
): RemovalRect[] {
  const rects: RemovalRect[] = [];
  for (let i = 0; i < assemblies.length; i++) {
    const assembly = assemblies[i];
    const translated = translatedSets[i] ?? [];
    const page = i + 1;
    const size = pageSizes?.[i];
    for (let j = 0; j < assembly.paragraphs.length && j < translated.length; j++) {
      const p = assembly.paragraphs[j];
      if (!(p.x1 > p.x0 && p.y1 > p.y0)) continue;
      const text = translated[j];
      const coveredByScreenshot = intersectsPlacedFormula(
        p,
        assembly.placedFormulas ?? [],
      );
      // 空译文通常意味着该页没被选中或该段没被翻译，都不删。唯一的例外是被
      // 截图盖住的公式区——它的原文必须从内容流里去掉。
      if (!text && !coveredByScreenshot) continue;
      if (text && !text.trim()) continue;

      const cp = size ? clampParagraph(p, size.width, size.height) : p;
      if (!(cp.x1 > cp.x0 && cp.y1 > cp.y0)) continue;
      rects.push({
        page,
        x0: cp.x0 - 1,
        y0: cp.y0 - 1,
        x1: cp.x1 + 1,
        y1: cp.y1 + 1,
      });
    }
  }
  return rects;
}

/**
 * 序列化为删除器 CLI 的区域文件内容。
 * 每行 `页码 x0 y0 x1 y1`（页码 1 起，# 开头为注释）。
 */
export function serializeRemovalRects(rects: RemovalRect[]): string {
  const lines = ["# page x0 y0 x1 y1"];
  for (const r of rects) {
    lines.push(
      `${r.page} ${fmt(r.x0)} ${fmt(r.y0)} ${fmt(r.x1)} ${fmt(r.y1)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function fmt(n: number): string {
  // 两位小数足够（0.01pt 精度），避免浮点尾巴撑大区域文件
  return (Math.round(n * 100) / 100).toString();
}
