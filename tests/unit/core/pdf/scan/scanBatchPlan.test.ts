/**
 * scanBatchPlan 测试（src/core/pdf/scan/scanBatchPlan.ts）。
 *
 * 对账层是"不遗漏"承诺的执行者：每一页必须有且只有一个去向，缺口必须
 * 显式化。本文件锁住：批划分（升序去重、尾批不满）、覆盖率可疑判定与
 * 阈值边界、对账的缺口与重复检出、汇总计数（含跳过原因分布）、断点
 * 清单的序列化与容错解析。
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCoverage,
  emptySkipReasons,
  planScanBatches,
  parseManifest,
  reconcileScanOutcomes,
  serializeManifest,
  summarizeScan,
  MIN_PAGE_COVERAGE,
  type ScanPageOutcome,
} from "../../../../../src/core/pdf/scan/scanBatchPlan";
import type { SidecarPageResult } from "../../../../../src/core/pdf/scan/sidecarProtocol";

function page(pageNumber: number, coverage: number, over: Partial<SidecarPageResult> = {}): SidecarPageResult {
  return {
    pageNumber,
    pageSizePt: { width: 595, height: 842 },
    renderSizePx: { width: 1654, height: 2339 },
    dpi: 200,
    rotation: 0,
    lines: [{ bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, text: "t", blockId: 0 }],
    formulas: [],
    tables: [],
    figures: [],
    coverage,
    ...over,
  };
}

function recognized(pageNumber: number, coverage = 0.5, suspect = false): ScanPageOutcome {
  return { kind: "recognized", page: page(pageNumber, coverage), suspect };
}

describe("planScanBatches", () => {
  it("按批大小切分，尾批可以不满", () => {
    const batches = planScanBatches([1, 2, 3, 4, 5], 2);
    expect(batches.map((b) => b.pages)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it("输入乱序、重复、非法都归一：升序去重", () => {
    const batches = planScanBatches([5, 1, 5, 0, -2, 3, 1.5, 2], 3);
    expect(batches.map((b) => b.pages)).toEqual([[1, 2, 3], [5]]);
  });

  it("非法批大小退回 10", () => {
    const batches = planScanBatches([1, 2, 3], 0);
    expect(batches).toHaveLength(1);
    expect(batches[0].pages).toEqual([1, 2, 3]);
  });

  it("空输入返回空批次表", () => {
    expect(planScanBatches([], 10)).toEqual([]);
  });
});

describe("evaluateCoverage", () => {
  it("低于阈值判可疑", () => {
    expect(evaluateCoverage(page(1, MIN_PAGE_COVERAGE - 0.01)).suspect).toBe(true);
  });

  it("达到阈值不可疑（保守方向：不乱重试）", () => {
    expect(evaluateCoverage(page(1, MIN_PAGE_COVERAGE)).suspect).toBe(false);
  });

  it("coverage 原样透出", () => {
    expect(evaluateCoverage(page(1, 0.73)).coverage).toBeCloseTo(0.73, 5);
  });
});

describe("reconcileScanOutcomes", () => {
  it("一一对应时无缺口无重复", () => {
    const outcomes = new Map<number, ScanPageOutcome>([
      [1, recognized(1)],
      [2, { kind: "skipped", reason: "rotated" }],
    ]);
    const r = reconcileScanOutcomes([1, 2], outcomes);
    expect(r.missing).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.covered).toEqual([1, 2]);
  });

  it("缺页进 missing（调用方必须显式记账，不许静默）", () => {
    const outcomes = new Map<number, ScanPageOutcome>([[1, recognized(1)]]);
    const r = reconcileScanOutcomes([1, 2, 3], outcomes);
    expect(r.missing).toEqual([2, 3]);
  });

  it("范围外的记录不计入 covered（不撑数）", () => {
    const outcomes = new Map<number, ScanPageOutcome>([
      [1, recognized(1)],
      [99, recognized(99)],
    ]);
    const r = reconcileScanOutcomes([1], outcomes);
    expect(r.covered).toEqual([1]);
    expect(r.missing).toEqual([]);
  });
});

describe("summarizeScan", () => {
  it("按去向类型计数，段落/公式/表格只算识别出的页", () => {
    const outcomes = new Map<number, ScanPageOutcome>([
      [1, recognized(1)],
      [2, { kind: "empty", page: page(2, 0) }],
      [3, { kind: "skipped", reason: "rotated" }],
      [4, { kind: "skipped", reason: "batch-failed" }],
      [5, { kind: "recognized", page: page(5, 0.1), suspect: true }],
    ]);
    const s = summarizeScan([1, 2, 3, 4, 5], outcomes, 2);
    expect(s.selected).toBe(5);
    expect(s.recognized).toBe(2);
    expect(s.empty).toBe(1);
    expect(s.skipped).toBe(2);
    expect(s.skipReasons).toEqual({
      rotated: 1,
      cancelled: 0,
      "sidecar-unavailable": 0,
      "batch-failed": 1,
      other: 0,
    });
    expect(s.suspect).toBe(1);
    expect(s.retriedBatches).toBe(2);
    expect(s.paragraphs).toBe(2); // 两页各一行
    expect(s.formulas).toBe(0);
    expect(s.tables).toBe(0);
  });

  it("公式与表格按侧车回报计数", () => {
    const outcomes = new Map<number, ScanPageOutcome>([
      [
        1,
        {
          kind: "recognized",
          page: page(1, 0.5, {
            formulas: [{ bbox: { x0: 0, y0: 0, x1: 5, y1: 5 }, latex: "$x$", isDisplay: false }],
            tables: [{ bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } }],
          }),
          suspect: false,
        },
      ],
    ]);
    const s = summarizeScan([1], outcomes, 0);
    expect(s.formulas).toBe(1);
    expect(s.tables).toBe(1);
  });

  it("原因计数表键集合固定", () => {
    expect(Object.keys(emptySkipReasons()).sort()).toEqual([
      "batch-failed",
      "cancelled",
      "other",
      "rotated",
      "sidecar-unavailable",
    ]);
  });
});

describe("断点清单", () => {
  it("序列化后可原样解析", () => {
    const m = serializeManifest({ version: 1, batch: 3, pages: [21, 22, 23], status: "partial", dpi: 200 });
    const parsed = parseManifest(m);
    expect(parsed).toEqual({ version: 1, batch: 3, pages: [21, 22, 23], status: "partial", dpi: 200 });
  });

  it("畸形输入返回 null（对账走保守路径）", () => {
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 2, batch: 0, pages: [] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 1, batch: -1, pages: [] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 1, batch: 0 }))).toBeNull();
  });
});
