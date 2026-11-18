/**
 * mergeScannedAssemblies — 把扫描管线的每页产出按页序合并进 ODL 的装配
 * 数组（纯函数）。
 *
 * 主管线的两条解析路径在这里汇合：数字页用 ODL 装配，扫描/劣质页用 OCR
 * 装配。合并规则只有三条：
 *   1. 按页码下标替换——assemblies[i] 与 translatedSets[i] 按位置对应，
 *      这是批量翻译按位置散回、渲染器逐页叠加的前提，顺序即契约；
 *   2. 公式块按来源过滤再加和——被 OCR 接管的页，其 ODL 公式块（空页
 *      本来也不会有）一律剔除，OCR 的原产公式块（带 LaTeX）追加；
 *   3. 跳过的页（值为 null）不替换——空装配让渲染端整页跳过，源页原样
 *      保留。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/mergeScannedAssemblies
 */

import type { PdfPageAnalysis } from "../PdfIR";
import type { FormulaBlock, PageSize } from "../translation/odlToAssembly";
import { pageAnalysisToAssembly } from "../translation/odlToAssembly";
import type { AssemblyResult } from "../translation/translationIR";

export interface MergeScannedInput {
  assemblies: AssemblyResult[];
  pageSizes: PageSize[];
  formulaBlocks: FormulaBlock[];
  /** 1 基页码 → 该页的 OCR 分析；null 表示该页被跳过（保留原文）。 */
  ocrAnalyses: Map<number, PdfPageAnalysis | null>;
}

export interface MergeScannedResult {
  assemblies: AssemblyResult[];
  pageSizes: PageSize[];
  formulaBlocks: FormulaBlock[];
  /** 实际被 OCR 产出替换的页码（升序）——进度汇总与日志用。 */
  replacedPages: number[];
}

export function mergeScannedAssemblies(
  input: MergeScannedInput,
): MergeScannedResult {
  const assemblies = [...input.assemblies];
  const pageSizes = [...input.pageSizes];
  // 被 OCR 接管的页，其 ODL 公式块一律剔除（空页本来也不会有，显式过滤
  // 是为了契约清晰：一页的公式块只允许有一个来源）。
  const ocrPages = new Set(input.ocrAnalyses.keys());
  const formulaBlocks = input.formulaBlocks.filter((f) => !ocrPages.has(f.pageNumber));
  const replacedPages: number[] = [];

  for (const [pageNumber, analysis] of input.ocrAnalyses) {
    // 页码越界（探针与 ODL 页数不一致的防御）：跳过，不让它写坏数组。
    const index = pageNumber - 1;
    if (index < 0 || index >= assemblies.length) continue;
    if (!analysis) continue; // 跳过页：保留占位（空）装配
    const built = pageAnalysisToAssembly(analysis, pageNumber);
    assemblies[index] = built.assembly;
    pageSizes[index] = built.pageSize;
    formulaBlocks.push(...built.formulaBlocks);
    replacedPages.push(pageNumber);
  }
  replacedPages.sort((a, b) => a - b);

  return { assemblies, pageSizes, formulaBlocks, replacedPages };
}
