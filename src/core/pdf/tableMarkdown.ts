/**
 * tableMarkdown — 把 PdfTable 渲染成 Markdown 表格行。
 *
 * 数字页（OpenDataLoader JSON）与识别页（OCR 侧车）的表格都要进文档级
 * filteredMarkdown，两边必须同一套渲染，否则同一份文档里两种表格长相。
 * 实现原在 OpenDataLoaderJsonAdapter 内，随文档级聚合接入提取到此共享。
 *
 * 跨度处理与版面引擎的局限一致：HTML/JSON 不记录单元格在网格里的列起点
 * （PdfTableCell 只有跨度没有列号），跨行单元格无法补占位，行内单元格数
 * 因此可能少于表头列数。这是两边共有的近似，不做猜测性填充。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/tableMarkdown
 */

import type { PdfTable } from "./PdfIR";

/** 空表（无行）渲染为空串——调用方按"无内容"跳过。 */
export function tableToMarkdown(table: PdfTable): string {
  if (table.rows.length === 0) return "";
  const cols = table.rows[0].cells.length;
  const lines: string[] = [];
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const line = row.cells.map((c) => `| ${c.text.trim()} `).join("") + "|";
    lines.push(line);
    if (i === 0) {
      lines.push("|" + " --- |".repeat(cols));
    }
  }
  return lines.join("\n");
}
