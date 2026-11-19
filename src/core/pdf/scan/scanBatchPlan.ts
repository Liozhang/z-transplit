/**
 * scanBatchPlan — 扫描管线的分批、断点账目与汇总（纯函数部分）。
 *
 * "不遗漏"在这里落成可执行的对账：每一页必须有且只有一个明确去向——
 * 识别出内容、明确无内容、或带原因的显式跳过。批末对账发现缺口时，
 * 缺口页记为"批失败"而不是悄悄消失；汇总数据直接喂进度行。
 *
 * 覆盖率的角色：版面模型整页漏检时，OCR 仍可能认出零星文字，产出"看
 * 起来正常其实缺半页"的结果——这种页覆盖率会显著低于正常页。低于阈值
 * 的页触发一次提高分辨率的重试；重试后仍低则保留产出并进汇总，绝不
 * 丢弃（宁可标注可疑，不可丢失内容）。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/scanBatchPlan
 */

import type { SidecarPageResult } from "./sidecarProtocol";

/** 一批的页范围。index 从 0 起，pages 为 1 基升序页码。 */
export interface ScanBatch {
  index: number;
  pages: number[];
}

/** 显式跳过一页的原因。汇总按原因计数，用户能看到"为什么这页没译文"。 */
export type ScanSkipReason =
  | "rotated"
  | "cancelled"
  | "sidecar-unavailable"
  | "batch-failed"
  /** 侧车给出了计划外的跳过原因：计入"其它"，原文保留，明细进 detail。 */
  | "other";

/** 一页的最终去向（账目的最小单位）。 */
export type ScanPageOutcome =
  /** resumed = 沿用上次运行的识别结果（未重新调用侧车）。 */
  | { kind: "recognized"; page: SidecarPageResult; suspect: boolean; resumed?: boolean }
  | { kind: "empty"; page: SidecarPageResult }
  | { kind: "skipped"; reason: ScanSkipReason; detail?: string };

/** 覆盖率低于该值的页判"可疑"（可能整页漏检），触发一次重试。 */
export const MIN_PAGE_COVERAGE = 0.2;

/** 重试时的分辨率放大倍数（200dpi → 300dpi）。 */
export const RETRY_DPI_FACTOR = 1.5;

/**
 * 重试用的 dpi：基础值乘放大系数，并钳回侧车的接受范围（72–600）。
 *
 * 钳位必须做在插件侧：侧车对越界 dpi 是静默取边界的，若插件按 900 发起
 * 重试而侧车按 600 执行，同一分辨率会原样重跑一遍，而 manifest 记的
 * attemptDpi 与 result.json 的 dpi 对不上——用户看到"重试跑了但可疑页仍
 * 可疑"，却查不出原因。
 */
export function retryDpiFor(baseDpi: number): number {
  const scaled = Math.round(baseDpi * RETRY_DPI_FACTOR);
  return Math.max(72, Math.min(600, scaled));
}

/** 每批最多重试一次——无限重试会把一批坏页变成无限循环。 */
export const MAX_BATCH_RETRIES = 1;

/** 把选中页切成升序、不重复的批。 */
export function planScanBatches(pages: number[], batchSize: number): ScanBatch[] {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 1))].sort(
    (a, b) => a - b,
  );
  const size = Number.isInteger(batchSize) && batchSize >= 1 ? batchSize : 10;
  const batches: ScanBatch[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    batches.push({ index: batches.length, pages: sorted.slice(i, i + size) });
  }
  return batches;
}

/** 一页的覆盖率评估：suspect 为 true 时应重试。 */
export function evaluateCoverage(page: SidecarPageResult): {
  coverage: number;
  suspect: boolean;
} {
  return { coverage: page.coverage, suspect: page.coverage < MIN_PAGE_COVERAGE };
}

export interface ScanReconciliation {
  /** 有明确去向的页（升序）。 */
  covered: number[];
  /** 没有任何去向记录的页——调用方必须把它们记为显式跳过。 */
  missing: number[];
  /** 被记录多次的页（防御性；保留最后一次，进日志）。 */
  duplicates: number[];
}

/**
 * 对账：选中页集合与去向记录必须一一对应。missing 非空意味着侧车某页
 * 既没回报成功也没回报跳过——调用方按 batch-failed 记账，不静默。
 */
export function reconcileScanOutcomes(
  selected: number[],
  outcomes: Map<number, ScanPageOutcome>,
): ScanReconciliation {
  const selectedSet = new Set(selected);
  const covered: number[] = [];
  const duplicates: number[] = [];
  for (const page of outcomes.keys()) {
    if (!selectedSet.has(page)) continue;
    if (covered.includes(page)) duplicates.push(page);
    else covered.push(page);
  }
  covered.sort((a, b) => a - b);
  const coveredSet = new Set(covered);
  const missing = [...selectedSet].filter((p) => !coveredSet.has(p)).sort((a, b) => a - b);
  return { covered, missing, duplicates };
}

export interface ScanSummary {
  /** 选中页总数。 */
  selected: number;
  /** 有识别产出的页（含沿用的）。 */
  recognized: number;
  /** 其中沿用上次运行结果、未重新调用侧车的页。 */
  resumed: number;
  /** 明确无内容的页（空白页或只有不可识别元素）。 */
  empty: number;
  /** 显式跳过的页总数。 */
  skipped: number;
  /** 按原因分的跳过计数。 */
  skipReasons: Record<ScanSkipReason, number>;
  /** 重试后覆盖率仍低于阈值的页（产出保留，仅标注）。 */
  suspect: number;
  /** 触发过重试的批数。 */
  retriedBatches: number;
  /** 识别出的段落 / 公式 / 表格数量（进度汇总用）。 */
  paragraphs: number;
  formulas: number;
  tables: number;
}

/** 空的原因计数表（键固定，便于界面层直接取用）。 */
export function emptySkipReasons(): Record<ScanSkipReason, number> {
  return {
    rotated: 0,
    cancelled: 0,
    "sidecar-unavailable": 0,
    "batch-failed": 0,
    other: 0,
  };
}

/** 汇总：进度行与完成文案的数据来源。 */
export function summarizeScan(
  selected: number[],
  outcomes: Map<number, ScanPageOutcome>,
  retriedBatches: number,
): ScanSummary {
  const skipReasons = emptySkipReasons();
  let recognized = 0;
  let resumed = 0;
  let empty = 0;
  let skipped = 0;
  let suspect = 0;
  let paragraphs = 0;
  let formulas = 0;
  let tables = 0;
  for (const outcome of outcomes.values()) {
    switch (outcome.kind) {
      case "recognized":
        recognized++;
        if (outcome.resumed) resumed++;
        if (outcome.suspect) suspect++;
        paragraphs += outcome.page.lines.length;
        formulas += outcome.page.formulas.length;
        tables += outcome.page.tables.length;
        break;
      case "empty":
        empty++;
        break;
      case "skipped":
        skipped++;
        skipReasons[outcome.reason]++;
        break;
    }
  }
  return {
    selected: selected.length,
    recognized,
    resumed,
    empty,
    skipped,
    skipReasons,
    suspect,
    retriedBatches,
    paragraphs,
    formulas,
    tables,
  };
}

/** 断点清单的一项：一批的状态快照（写盘用，崩溃后续跑有据可查）。
 *  只写不读——跨会话续跑读的是 scanRunState 的每页状态（见该模块），
 *  批清单是同一次运行内的诊断记录。 */
export interface ScanBatchManifest {
  version: 1;
  batch: number;
  pages: number[];
  status: "ok" | "partial" | "failed" | "timeout" | "aborted" | "unconfigured";
  dpi: number;
}

export function serializeManifest(manifest: ScanBatchManifest): string {
  return JSON.stringify(manifest);
}
