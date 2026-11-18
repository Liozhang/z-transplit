/**
 * pageClassification — 逐页判定 PDF 页属于数字页、扫描页还是劣质文本层页。
 *
 * 为什么需要分类：全文翻译只有一条解析路径（OpenDataLoader 启发式引擎），
 * 它对纯图片页零产出，对早期 OCR 产物（带乱码隐藏文本层）会提取出乱码。
 * 路由层按这里的判定把页分给 ODL 或 OCR 侧车；判定错了不会丢内容——扫
 * 描页误判成数字页只是漏翻译，数字页误判成扫描页只是多跑一次识别——
 * 但劣质文本层页漏判会把乱码当正文翻译，是最隐蔽的遗漏来源，所以阈值
 * 取保守方向。
 *
 * 纯模块：不碰 Zotero 全局、不做 IO，可在 Node 单测。
 *
 * @module core/pdf/scan/pageClassification
 */

import type { PdfPageAnalysis } from "../PdfIR";

/** 一页的解析去向。 */
export type PageKind = "digital" | "scanned" | "degraded";

/**
 * 低于该字符数认为没有可用文本层。24 约等于一句图注的长度：纯图页加一
 * 行 "Figure 1" 也会落到扫描侧，由 OCR 重新认一遍——结果等价且不缺内容。
 */
export const MIN_PAGE_TEXT_CHARS = 24;

/**
 * 可读字符比例下限。低于它说明文本层大面积是控制字符、私用区码位或替换
 * 符（ToUnicode 映射损坏的典型特征），认出来也是乱码，必须走 OCR。
 */
export const MIN_SANE_RATIO = 0.9;

/** 乱码特征字符：C0/C1 控制符（制表与换行除外）、私用区码位、替换符。 */
const GARBAGE_CHAR_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\uE000-\uF8FF\uFFFD]/g;

export interface PageTextStats {
  pageNumber: number;
  /** 去除空白后的总字符数（正文块与表格单元格都计入）。 */
  textLength: number;
  /** 参与统计的文本块数量（表格单元格不计入块数）。 */
  blockCount: number;
  /** 1 减去乱码字符占比，范围 0–1；无字符时定义为 1。 */
  saneRatio: number;
}

/**
 * 从一页的解析结果统计文本层特征。表格单元格文本计入字符数：整页只有
 * 一张表的数字页同样有完整文本层，不该被判成扫描页白跑一次 OCR。
 */
export function pageTextStats(
  page: Pick<PdfPageAnalysis, "pageNumber" | "textBlocks" | "tables">,
): PageTextStats {
  let rawLength = 0;
  let whitespace = 0;
  let garbage = 0;
  let blockCount = 0;
  const tally = (text: string | undefined): void => {
    const t = text || "";
    rawLength += t.length;
    const ws = t.match(/\s/g);
    if (ws) whitespace += ws.length;
    const bad = t.match(GARBAGE_CHAR_RE);
    if (bad) garbage += bad.length;
  };
  for (const block of page.textBlocks ?? []) {
    tally(block.text);
    blockCount++;
  }
  for (const table of page.tables ?? []) {
    for (const row of table.rows ?? []) {
      for (const cell of row.cells ?? []) tally(cell.text);
    }
  }
  return {
    pageNumber: page.pageNumber,
    textLength: Math.max(0, rawLength - whitespace),
    blockCount,
    saneRatio: rawLength === 0 ? 1 : 1 - garbage / rawLength,
  };
}

/**
 * 单页判定。规则只有两条，顺序即优先级：
 *   1. 有效字符数不足 → scanned（没有文本层可言）；
 *   2. 可读字符比例过低 → degraded（有文本层但是乱码）；
 *   3. 其余 → digital。
 */
export function classifyPage(stats: PageTextStats): PageKind {
  if (stats.textLength < MIN_PAGE_TEXT_CHARS) return "scanned";
  if (stats.saneRatio < MIN_SANE_RATIO) return "degraded";
  return "digital";
}

/** 该去向是否需要 OCR 侧车识别。 */
export function needsOcr(kind: PageKind): boolean {
  return kind !== "digital";
}

export interface DocumentClassification {
  /** 与入参页序一一对应的去向数组。 */
  kinds: PageKind[];
  counts: Record<PageKind, number>;
  /** 需要 OCR 的 1 基页码，按页序。 */
  ocrPages: number[];
}

/** 整篇分类：页序保持，统计计数，抽出 OCR 页清单。 */
export function classifyPages(
  pages: Array<Pick<PdfPageAnalysis, "pageNumber" | "textBlocks" | "tables">>,
): DocumentClassification {
  const kinds: PageKind[] = [];
  const ocrPages: number[] = [];
  const counts: Record<PageKind, number> = { digital: 0, scanned: 0, degraded: 0 };
  for (const page of pages) {
    const kind = classifyPage(pageTextStats(page));
    kinds.push(kind);
    counts[kind]++;
    if (needsOcr(kind)) ocrPages.push(page.pageNumber);
  }
  return { kinds, counts, ocrPages };
}
