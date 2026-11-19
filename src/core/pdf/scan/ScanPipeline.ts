/**
 * ScanPipeline — 扫描页识别管线的编排：分批调侧车、可疑页重试、断点
 * 落盘、逐页对账。
 *
 * 设计约束（对应"精准、不遗漏、大型 PDF 可用"三条需求）：
 *   - 分批：每批一次侧车调用，批末写断点清单。一批失败只损失一批，
 *     已完成的批有记录可查；与管线的"翻译指定页 + 按页合并"拼成产品级
 *     续跑。
 *   - 对账：每一页必须有且只有一个去向（识别出 / 明确无内容 / 带原因
 *     跳过）。对账出的缺口记为 batch-failed——用户看得到"这页没译"，
 *     而不是静默消失。
 *   - 可疑页重试：覆盖率低于阈值的页（可能整页漏检）整批提高分辨率
 *     重试一次；重试后仍低则保留产出并进汇总标注，绝不丢弃。
 *   - 取消：每批开工前查 signal；取消后剩余页记 cancelled，由调用方
 *     的统一取消闸口收尾（本模块不抛取消异常，避免与适配器的
 *     TranslationCancelledError 形成循环依赖）。
 *
 * 进度约定与主管线一致：可度量阶段带 { done, total } 走单行 fraction，
 * 阶段行用 note；批次粒度（10 页/批）天然满足"每 10 项报一次"的节流。
 *
 * Host-coupled：默认走真实侧车与 IOUtils；测试整体注入 runBatch /
 * runDir / writeManifestFile 后不碰宿主。
 *
 * @module core/pdf/scan/ScanPipeline
 */

import { safeDebug } from "../../../utils/logger";
import { getString } from "../../../utils/locale";
import type { ProgressFraction } from "../../translation/types";
import type { PdfPageAnalysis } from "../PdfIR";
import { sidecarPageToAnalysis } from "./ocrToAnalysis";
import { loadScanSidecarConfig, runSidecarBatch } from "./ScanSidecarClient";
import {
  evaluateCoverage,
  planScanBatches,
  reconcileScanOutcomes,
  serializeManifest,
  summarizeScan,
  MAX_BATCH_RETRIES,
  retryDpiFor,
  type ScanPageOutcome,
  type ScanReconciliation,
  type ScanSkipReason,
  type ScanSummary,
} from "./scanBatchPlan";
import type { SidecarBatchRun, SidecarPageResult } from "./sidecarProtocol";
import { createWorkDir, joinWorkPath } from "./workDir";

/** 缺省每批页数（偏好缺失或非法时）。 */
const DEFAULT_BATCH_SIZE = 10;
/** 缺省识别分辨率。 */
const DEFAULT_DPI = 200;

export interface ScanPipelineOptions {
  pdfPath: string;
  /** 选中页中需要 OCR 的 1 基页码。 */
  pages: number[];
  onProgress?: (msg: string, fraction?: ProgressFraction) => void;
  signal?: AbortSignal;
  /** 测试注入：替代真实侧车调用。 */
  runBatch?: (pages: number[], dpi: number) => Promise<SidecarBatchRun>;
  /** 测试注入：断点目录（缺省临时目录）。 */
  runDir?: string;
  /** 测试注入：断点清单写入（缺省 IOUtils.write）。 */
  writeManifestFile?: (dir: string, name: string, content: string) => Promise<void>;
  dpi?: number;
  batchSize?: number;
  /**
   * 上次运行已识别的页（跨会话续跑）。这些页不再调用侧车，按"沿用"记账；
   * 不参与重试（要重新认它们，请清除识别状态后重跑）。
   */
  resumed?: Map<number, SidecarPageResult>;
  /** 新识别出的页落盘回调（续跑状态的写入方，由调用方注入）。失败只记日志。 */
  persistPage?: (page: SidecarPageResult) => Promise<void>;
}

export interface ScanPipelineResult {
  /** 每页的 IR；跳过的页为 null（渲染端跳过空译文集，保留原文）。 */
  analyses: Map<number, PdfPageAnalysis | null>;
  /** 每页去向（对账与汇总的原始记录）。 */
  outcomes: Map<number, ScanPageOutcome>;
  summary: ScanSummary;
  reconciliation: ScanReconciliation;
  /** 是否因取消而提前收手（调用方按统一取消闸口处理）。 */
  cancelled: boolean;
}

/** 从去向记录导出每页 IR：识别出与明确无内容的页转换，跳过的页为 null。 */
export function analysesFromOutcomes(
  outcomes: Map<number, ScanPageOutcome>,
  pages: number[],
): Map<number, PdfPageAnalysis | null> {
  const analyses = new Map<number, PdfPageAnalysis | null>();
  for (const p of pages) {
    const outcome = outcomes.get(p);
    if (outcome && (outcome.kind === "recognized" || outcome.kind === "empty")) {
      analyses.set(p, sidecarPageToAnalysis(outcome.page));
    } else {
      analyses.set(p, null);
    }
  }
  return analyses;
}

/** 偏好读取失败（无宿主）时退回缺省值——管线永不因配置读取而崩。 */
function resolveBatchSize(explicit?: number): number {
  if (explicit && explicit >= 1) return Math.trunc(explicit);
  try {
    return loadScanSidecarConfig().batchSize;
  } catch {
    return DEFAULT_BATCH_SIZE;
  }
}

function resolveDpi(explicit?: number): number {
  if (explicit && explicit >= 72) return Math.trunc(explicit);
  try {
    return loadScanSidecarConfig().dpi;
  } catch {
    return DEFAULT_DPI;
  }
}

/** 断点清单的缺省写入：IOUtils + UTF-8。 */
async function defaultWriteManifest(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return;
  await IOUtils.write(joinWorkPath(dir, name), new TextEncoder().encode(content));
}

/**
 * 跑扫描识别。任何单一失败都归类为页级去向，不向上抛；唯一的提前出口
 * 是调用方取消（结果里 cancelled = true，剩余页记 cancelled）。
 */
export async function runScanPipeline(
  opts: ScanPipelineOptions,
): Promise<ScanPipelineResult> {
  const onProgress = opts.onProgress || (() => {});
  const batchSize = resolveBatchSize(opts.batchSize);
  const dpi = resolveDpi(opts.dpi);
  const runDir = opts.runDir ?? createWorkDir("ztransplit-scan-run-");
  const writeManifest = opts.writeManifestFile ?? defaultWriteManifest;
  const runBatch =
    opts.runBatch ??
    ((pages: number[], d: number) =>
      runSidecarBatch({ pdfPath: opts.pdfPath, pages, dpi: d, signal: opts.signal }));

  const outcomes = new Map<number, ScanPageOutcome>();
  let retriedBatches = 0;
  const retriedBatchIndexes = new Set<number>();
  let cancelled = false;
  let sidecarUnavailable = false;

  onProgress(getString("scan-progress-start", { pages: String(opts.pages.length) }));

  // 续跑：上次已识别的页直接记账，不进批次、不调侧车、不参与重试。
  const resumedPages = opts.resumed ?? new Map<number, SidecarPageResult>();
  const selected = new Set(opts.pages);
  for (const [pageNumber, page] of resumedPages) {
    if (!selected.has(pageNumber)) continue;
    outcomes.set(pageNumber, {
      kind: "recognized",
      page,
      suspect: evaluateCoverage(page).suspect,
      resumed: true,
    });
  }
  if (outcomes.size > 0) {
    onProgress(
      getString("scan-progress-resumed", { pages: String(outcomes.size) }),
    );
  }
  const pendingPages = opts.pages.filter((p) => !outcomes.has(p));
  const batches = planScanBatches(pendingPages, batchSize);

  const record = (pageNumber: number, page: SidecarPageResult): boolean => {
    if (page.rotation !== 0 || page.skipReason === "rotated") {
      outcomes.set(pageNumber, { kind: "skipped", reason: "rotated" });
      return false;
    }
    // 侧车给了计划外的跳过原因：记"其它"并留明细——绝不能落进
    // recognized（那会让汇总虚高、用户看不到这页为什么没内容）。
    if (page.skipReason) {
      outcomes.set(pageNumber, {
        kind: "skipped",
        reason: "other",
        detail: page.skipReason,
      });
      safeDebug(
        `[Z-Transplit] ScanPipeline: page ${pageNumber} skipped by sidecar: ${page.skipReason}`,
      );
      return false;
    }
    if (page.noContent) {
      outcomes.set(pageNumber, { kind: "empty", page });
      return false;
    }
    const { suspect } = evaluateCoverage(page);
    outcomes.set(pageNumber, { kind: "recognized", page, suspect });
    return suspect;
  };

  // 新识别的页落盘（续跑状态）。持久化是优化不是正确性前提：写失败只
  // 记日志，本次运行不受影响。
  const persist = async (pageNumber: number): Promise<void> => {
    if (!opts.persistPage) return;
    const outcome = outcomes.get(pageNumber);
    if (!outcome || outcome.kind !== "recognized" || outcome.resumed) return;
    try {
      await opts.persistPage(outcome.page);
    } catch (e) {
      safeDebug("[Z-Transplit] ScanPipeline: persist failed: " + e);
    }
  };

  for (const batch of batches) {
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const attemptDpi = dpi;
    const run = await runBatch(batch.pages, attemptDpi);
    await writeManifest(
      runDir,
      `batch-${String(batch.index).padStart(4, "0")}.json`,
      serializeManifest({
        version: 1,
        batch: batch.index,
        pages: batch.pages,
        status: run.status,
        dpi: attemptDpi,
      }),
    );

    if (run.status === "unconfigured") {
      // 侧车没配：整批记不可用并收手——后面每批都会是同样结果，逐批跑
      // 只是浪费时间去发现同一件事。
      sidecarUnavailable = true;
      for (const p of batch.pages) {
        if (!outcomes.has(p)) outcomes.set(p, { kind: "skipped", reason: "sidecar-unavailable" });
      }
      break;
    }

    // 取消可能在侧车进程内部发生（signal 已中止，runProcess 直接回报
    // aborted）。此时必须收手并置 cancelled——否则最后一批被取消时循环
    // 自然结束，cancelled 保持 false，调用方的统一取消闸口不触发，半成品
    // 会继续走完翻译。
    if (run.status === "aborted") {
      cancelled = true;
      break;
    }

    const suspects: number[] = [];
    for (const p of batch.pages) {
      const page = run.pages.get(p);
      if (!page) continue; // 缺口留给对账
      if (record(p, page)) suspects.push(p);
    }
    // 本批成果逐页落盘（取消/失败前的批次都已持久化，续跑才接得上）。
    for (const p of batch.pages) await persist(p);

    // 取消信号在批内到达：本批已拿到的成果照常入账，但不再重试、不再开
    // 新批。与上面的 aborted 分支合并处理"取消"这一意图，区别只在成果
    // 是否已落盘（被杀的批 pages 为空，入账自然是空的）。
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }

    // 可疑页整批重试一次（更高分辨率）。只替换可疑页的产出——已认可
    // 的页不被重试结果覆盖。每批最多一次（见 scanBatchPlan.MAX_BATCH_RETRIES）。
    if (
      suspects.length > 0 &&
      !retriedBatchIndexes.has(batch.index) &&
      retriedBatchIndexes.size < MAX_BATCH_RETRIES * batches.length
    ) {
      const retryDpi = retryDpiFor(dpi);
      onProgress(
        getString("scan-progress-retry", {
          batch: String(batch.index + 1),
          pages: String(suspects.length),
        }),
      );
      retriedBatchIndexes.add(batch.index);
      retriedBatches++;
      const retry = await runBatch(batch.pages, retryDpi);
      await writeManifest(
        runDir,
        `batch-${String(batch.index).padStart(4, "0")}-retry.json`,
        serializeManifest({
          version: 1,
          batch: batch.index,
          pages: batch.pages,
          status: retry.status,
          dpi: retryDpi,
        }),
      );
      for (const p of suspects) {
        const page = retry.pages.get(p);
        if (page) record(p, page);
      }
      // 取消落在重试调用上：与首轮同样收手并置位（最后一批的重试被取消
      // 时，循环同样会自然结束，不置位就会漏掉取消契约）。
      if (retry.status === "aborted" || opts.signal?.aborted) {
        cancelled = true;
        break;
      }
    }

    onProgress(
      getString("scan-progress-batch", {
        done: String(batch.index + 1),
        total: String(batches.length),
      }),
      { done: batch.index + 1, total: batches.length },
    );
  }

  // 对账后的缺口必须显式化：取消 → cancelled；侧车未配 → 不可用；其余
  // （进程崩了、JSON 缺页）→ batch-failed。用户看得到原因，内容不静默丢失。
  const fallbackReason: ScanSkipReason = cancelled
    ? "cancelled"
    : sidecarUnavailable
      ? "sidecar-unavailable"
      : "batch-failed";
  for (const p of opts.pages) {
    if (!outcomes.has(p)) outcomes.set(p, { kind: "skipped", reason: fallbackReason });
  }

  const reconciliation = reconcileScanOutcomes(opts.pages, outcomes);
  if (reconciliation.duplicates.length > 0) {
    safeDebug(
      "[Z-Transplit] ScanPipeline: duplicate page outcomes: " +
        reconciliation.duplicates.join(","),
    );
  }

  const analyses = analysesFromOutcomes(outcomes, opts.pages);

  const summary = summarizeScan(opts.pages, outcomes, retriedBatches);
  onProgress(
    getString("scan-progress-summary", {
      recognized: String(summary.recognized),
      empty: String(summary.empty),
      skipped: String(summary.skipped),
    }) +
      (summary.resumed > 0
        ? getString("scan-progress-summary-resumed", { resumed: String(summary.resumed) })
        : "") +
      (summary.suspect > 0
        ? getString("scan-progress-summary-suspect", { suspect: String(summary.suspect) })
        : ""),
  );

  return { analyses, outcomes, summary, reconciliation, cancelled };
}
