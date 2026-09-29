/**
 * removalRects — 把"将被译文替换的段落"汇编成原文删除器的区域清单。
 *
 * 删除清单必须镜像渲染端的跳过逻辑（LayoutPreservingRenderer 的段落循环）：
 *   - `translatedSets[i][j]` 缺失的段落不删（渲染端跳过，原文保留）；
 *   - 公式占位符剥除后为空的译文不删（渲染端跳过）；
 *   - 退化（宽高非正）的边界框不删。
 *
 * 坐标即 PDF 用户空间（原点左下、单位 pt），与 OpenDataLoader 输出的
 * boundingBox 同一坐标系，无需换算；页码 = assemblies 数组下标 + 1。
 * Host 无关 — 纯函数，可在 Node 单元测试。
 */

import type { AssemblyResult } from "./translationIR";
import { stripFormulaPlaceholders } from "./LayoutPreservingRenderer";

export interface RemovalRect {
  /** 1-based page index (matches the remover CLI's rects file). */
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function buildRemovalRects(
  assemblies: AssemblyResult[],
  translatedSets: string[][],
): RemovalRect[] {
  const rects: RemovalRect[] = [];
  for (let i = 0; i < assemblies.length; i++) {
    const assembly = assemblies[i];
    const translated = translatedSets[i] ?? [];
    const page = i + 1;
    for (let j = 0; j < assembly.paragraphs.length && j < translated.length; j++) {
      const text = translated[j];
      if (!text) continue;
      const stripped = stripFormulaPlaceholders(text);
      if (!stripped.text.trim()) continue;
      const p = assembly.paragraphs[j];
      if (!(p.x1 > p.x0 && p.y1 > p.y0)) continue;
      rects.push({ page, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 });
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
