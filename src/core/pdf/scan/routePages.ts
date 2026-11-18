/**
 * decideScanRouting — 逐页路由决策（纯函数）。
 *
 * 主管线在 ODL 解析后问一次本函数：哪些选中页走 OCR 侧车，哪些走 ODL
 * 装配。决策只依赖分类结果与用户选定的页码范围——把这两个输入显式
 * 化，路由规则（扫描页与劣质页进 OCR、范围外页完全不进管线、纯扫描件
 * 全量进 OCR）才能被单测钉住，而不是散落在适配器的宿主代码里。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/routePages
 */

import type { PdfDocumentAnalysis } from "../PdfIR";
import { classifyPages, needsOcr } from "./pageClassification";

export interface ScanRoutingDecision {
  /** 选中且需要 OCR 的 1 基页码（升序）。 */
  ocrPages: number[];
  /** 选中且走 ODL 的数字页 1 基页码（升序）。 */
  digitalPages: number[];
  /** 分类计数（数字 / 扫描 / 劣质），供进度与日志。 */
  counts: Record<"digital" | "scanned" | "degraded", number>;
}

/**
 * @param analysis ODL 解析产出（纯扫描件时为探针兜底的占位分析）。
 * @param isPageSelected 该页是否在用户选定范围内；范围外页不进任何管线。
 */
export function decideScanRouting(
  analysis: PdfDocumentAnalysis,
  isPageSelected: (pageNumber: number) => boolean,
): ScanRoutingDecision {
  const classification = classifyPages(analysis.pages);
  const ocrPages: number[] = [];
  const digitalPages: number[] = [];
  classification.kinds.forEach((kind, index) => {
    const pageNumber = index + 1;
    if (!isPageSelected(pageNumber)) return;
    if (needsOcr(kind)) ocrPages.push(pageNumber);
    else digitalPages.push(pageNumber);
  });
  return { ocrPages, digitalPages, counts: classification.counts };
}
