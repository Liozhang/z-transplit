/**
 * ScanPipeline 测试（src/core/pdf/scan/ScanPipeline.ts）。
 *
 * 编排层的行为承诺：分批调用、可疑页只重试一次、缺口显式记账、取消提前
 * 收手、侧车未配置时整批记不可用而不逐批空跑。全部通过注入假 runBatch
 * 驱动，不碰真实侧车与文件系统（writeManifestFile 注入为内存记录）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { runScanPipeline } from "../../../../../src/core/pdf/scan/ScanPipeline";
import type { SidecarBatchRun, SidecarPageResult } from "../../../../../src/core/pdf/scan/sidecarProtocol";

function page(pageNumber: number, coverage = 0.5, over: Partial<SidecarPageResult> = {}): SidecarPageResult {
  return {
    pageNumber,
    pageSizePt: { width: 595.28, height: 841.89 },
    renderSizePx: { width: 1654, height: 2339 },
    dpi: 200,
    rotation: 0,
    lines: [
      { bbox: { x0: 100, y0: 100, x1: 800, y1: 130 }, text: `第 ${pageNumber} 页正文`, blockId: 0 },
    ],
    formulas: [],
    tables: [],
    figures: [],
    coverage,
    ...over,
  };
}

function run(pages: SidecarPageResult[], status: SidecarBatchRun["status"] = "ok"): SidecarBatchRun {
  return { status, pages: new Map(pages.map((p) => [p.pageNumber, p])), stderr: "" };
}

/** 记录调用的假侧车：按页码段返回预设结果。 */
function fakeSidecar(script: (pages: number[], dpi: number) => SidecarBatchRun) {
  const calls: Array<{ pages: number[]; dpi: number }> = [];
  const fn = async (pages: number[], dpi: number): Promise<SidecarBatchRun> => {
    calls.push({ pages, dpi });
    return script(pages, dpi);
  };
  return { fn, calls };
}

const manifests: Array<{ name: string; content: string }> = [];

beforeEach(() => {
  manifests.length = 0;
});

function options(over: Partial<Parameters<typeof runScanPipeline>[0]> = {}) {
  return {
    pdfPath: "scan.pdf",
    pages: [1, 2, 3],
    dpi: 200,
    batchSize: 2,
    runDir: "RUN",
    writeManifestFile: async (dir: string, name: string, content: string) => {
      manifests.push({ name, content });
    },
    onProgress: () => {},
    ...over,
  };
}

describe("runScanPipeline", () => {
  it("按批调用侧车，每批写一条断点清单", async () => {
    const sidecar = fakeSidecar((pages) => run(pages.map((p) => page(p))));
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(sidecar.calls).toHaveLength(2);
    expect(sidecar.calls[0].pages).toEqual([1, 2]);
    expect(sidecar.calls[1].pages).toEqual([3]);
    expect(manifests.map((m) => m.name)).toEqual(["batch-0000.json", "batch-0001.json"]);
    expect(result.summary.recognized).toBe(3);
    expect(result.analyses.get(1)!.textBlocks[0].text).toContain("第 1 页正文");
    expect(result.cancelled).toBe(false);
  });

  it("覆盖率偏低的页触发一次更高分辨率重试，只替换可疑页", async () => {
    const sidecar = fakeSidecar((pages, dpi) => {
      // 首轮：第 2 页覆盖率低，其余正常；重试轮：第 2 页恢复
      if (dpi === 200) return run(pages.map((p) => page(p, p === 2 ? 0.05 : 0.5)));
      return run(pages.filter((p) => p === 2).map((p) => page(p, 0.6)));
    });
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    // 批 [1,2] → 重试 [1,2] → 批 [3]，共 3 次
    expect(sidecar.calls).toHaveLength(3);
    expect(sidecar.calls[1].dpi).toBe(300); // 200 × 1.5
    expect(sidecar.calls[1].pages).toEqual([1, 2]);
    expect(sidecar.calls[2].pages).toEqual([3]);
    expect(result.summary.recognized).toBe(3);
    expect(result.summary.suspect).toBe(0);
    expect(result.summary.retriedBatches).toBe(1);
    expect(manifests.map((m) => m.name)).toContain("batch-0000-retry.json");
  });

  it("重试后仍偏低的页保留产出并标注可疑（不丢弃）", async () => {
    const sidecar = fakeSidecar((pages, dpi) =>
      dpi === 200 ? run(pages.map((p) => page(p, p === 2 ? 0.02 : 0.5))) : run([page(2, 0.03)]),
    );
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(result.summary.recognized).toBe(3);
    expect(result.summary.suspect).toBe(1);
    // 产出仍在：译文管线照常处理，只是汇总里标注
    expect(result.analyses.get(2)).not.toBeNull();
  });

  it("每批最多重试一次（不无限重试）", async () => {
    const sidecar = fakeSidecar((pages, dpi) =>
      dpi === 200 ? run(pages.map((p) => page(p, 0.01))) : run(pages.map((p) => page(p, 0.01))),
    );
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    // 2 批 × 各 1 次重试 = 4 次调用，不会更多
    expect(sidecar.calls).toHaveLength(4);
    expect(result.summary.retriedBatches).toBe(2);
  });

  it("旋转页记跳过，不进入识别产出", async () => {
    const sidecar = fakeSidecar((pages) =>
      run([page(1, 0.5), page(2, 0.5, { rotation: 90, skipReason: "rotated" }), page(3, 0.5)]),
    );
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(result.summary.recognized).toBe(2);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.skipReasons.rotated).toBe(1);
    expect(result.analyses.get(2)).toBeNull();
  });

  it("侧车某页无回报 → 对账记为 batch-failed，不静默", async () => {
    const sidecar = fakeSidecar((pages) => run([page(1, 0.5)])); // 第 2、3 页缺失
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(result.summary.recognized).toBe(1);
    expect(result.summary.skipped).toBe(2);
    expect(result.summary.skipReasons["batch-failed"]).toBe(2);
    expect(result.reconciliation.missing).toEqual([]);
    expect(result.analyses.get(2)).toBeNull();
    expect(result.analyses.get(3)).toBeNull();
  });

  it("侧车未配置：整批记不可用并收手，不逐批空跑", async () => {
    const sidecar = fakeSidecar(() => run([], "unconfigured"));
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(sidecar.calls).toHaveLength(1); // 第一批就停
    expect(result.summary.skipped).toBe(3);
    expect(result.summary.skipReasons["sidecar-unavailable"]).toBe(3);
  });

  it("取消：剩余页记 cancelled，不再调用侧车", async () => {
    const controller = new AbortController();
    const sidecar = fakeSidecar((pages) => {
      controller.abort(); // 第一批返回后取消
      return run(pages.map((p) => page(p)));
    });
    const result = await runScanPipeline(
      options({ runBatch: sidecar.fn, signal: controller.signal }),
    );
    expect(result.cancelled).toBe(true);
    expect(sidecar.calls).toHaveLength(1);
    expect(result.summary.skipReasons.cancelled).toBe(1); // 第 3 页
    expect(result.summary.recognized).toBe(2);
  });

  it("取消发生在最后一批：cancelled 仍为 true（循环自然结束也要置位）", async () => {
    // 回归：取消只在批内发生时，若不在批次返回后立即收手，最后一批被取消
    // 会让循环自然结束、cancelled 保持 false，调用方的取消闸口不触发。
    const controller = new AbortController();
    const sidecar = fakeSidecar((pages) => {
      controller.abort(); // 每批返回后取消——最后一批即末批
      return run(pages.map((p) => page(p)));
    });
    const result = await runScanPipeline(
      options({ runBatch: sidecar.fn, signal: controller.signal, batchSize: 2, pages: [1, 2] }),
    );
    expect(sidecar.calls).toHaveLength(1);
    expect(result.cancelled).toBe(true);
    // 本批页面已有产出，保留；但取消状态必须让上层看到
    expect(result.summary.recognized).toBe(2);
    expect(result.summary.skipReasons.cancelled).toBe(0);
  });

  it("取消发生在重试调用上：同样置 cancelled", async () => {
    // 回归：首轮 aborted 有专门分支，重试回报后若不复查，取消落在重试窗口
    // 时 cancelled 保持 false。
    const controller = new AbortController();
    const sidecar = fakeSidecar((pages, dpi) => {
      if (dpi === 200) {
        // 首轮全部覆盖率低 → 触发重试
        return run(pages.map((p) => page(p, 0.01)));
      }
      controller.abort(); // 取消落在重试调用里
      return run([], "aborted");
    });
    const result = await runScanPipeline(
      options({ runBatch: sidecar.fn, signal: controller.signal, batchSize: 2, pages: [1, 2] }),
    );
    expect(sidecar.calls).toHaveLength(2);
    expect(result.cancelled).toBe(true);
  });

  it("侧车给出计划外的跳过原因：记「其它」并留明细，不算已识别", async () => {
    const sidecar = fakeSidecar((pages) =>
      run([
        page(1, 0.5),
        page(2, 0.5, { skipReason: "engine-quota" }),
        page(3, 0.5),
      ]),
    );
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(result.summary.recognized).toBe(2);
    expect(result.summary.skipped).toBe(1);
    expect(result.summary.skipReasons.other).toBe(1);
    const outcome = result.outcomes.get(2)!;
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("other");
      expect(outcome.detail).toBe("engine-quota");
    }
    expect(result.analyses.get(2)).toBeNull();
  });

  it("空页清单：零调用、零产出", async () => {
    const sidecar = fakeSidecar(() => run([]));
    const result = await runScanPipeline(options({ pages: [], runBatch: sidecar.fn }));
    expect(sidecar.calls).toHaveLength(0);
    expect(result.summary.selected).toBe(0);
  });

  it("续跑：已识别的页不再调侧车，按沿用记账", async () => {
    const sidecar = fakeSidecar((pages) => run(pages.map((p) => page(p))));
    const resumed = new Map([[1, page(1)]]);
    const result = await runScanPipeline(
      options({ runBatch: sidecar.fn, resumed }),
    );
    // 只剩 2、3 两页进侧车，且第 1 页不在任何批次里
    expect(sidecar.calls).toHaveLength(1);
    expect(sidecar.calls[0].pages).toEqual([2, 3]);
    expect(result.summary.recognized).toBe(3);
    expect(result.summary.resumed).toBe(1);
    const outcome = result.outcomes.get(1)!;
    expect(outcome.kind === "recognized" && outcome.resumed).toBe(true);
    // 沿用的页照样进 IR（装配与翻译不受来源影响）
    expect(result.analyses.get(1)!.textBlocks[0].text).toContain("第 1 页");
  });

  it("续跑页不在选中集合内：忽略（页码范围收窄的场景）", async () => {
    const sidecar = fakeSidecar((pages) => run(pages.map((p) => page(p))));
    const resumed = new Map([[99, page(99)]]);
    const result = await runScanPipeline(options({ runBatch: sidecar.fn, resumed }));
    expect(result.summary.resumed).toBe(0);
    expect(result.outcomes.has(99)).toBe(false);
  });

  it("新识别的页逐页落盘（续跑状态的写入方被调用）", async () => {
    const sidecar = fakeSidecar((pages) => run(pages.map((p) => page(p))));
    const persisted: number[] = [];
    const result = await runScanPipeline(
      options({
        runBatch: sidecar.fn,
        batchSize: 2,
        persistPage: async (p) => {
          persisted.push(p.pageNumber);
        },
      }),
    );
    expect(persisted).toEqual([1, 2, 3]);
    expect(result.summary.recognized).toBe(3);
  });

  it("沿用的页不重复落盘", async () => {
    const sidecar = fakeSidecar((pages) => run(pages.map((p) => page(p))));
    const persisted: number[] = [];
    await runScanPipeline(
      options({
        runBatch: sidecar.fn,
        resumed: new Map([[1, page(1)]]),
        persistPage: async (p) => {
          persisted.push(p.pageNumber);
        },
      }),
    );
    expect(persisted).toEqual([2, 3]);
  });

  it("无内容页（noContent）记 empty 且不产 IR", async () => {
    const sidecar = fakeSidecar((pages) =>
      run([page(1, 0.5), page(2, 0.0, { noContent: true, lines: [] }), page(3, 0.5)]),
    );
    const result = await runScanPipeline(options({ runBatch: sidecar.fn }));
    expect(result.summary.empty).toBe(1);
    expect(result.summary.recognized).toBe(2);
    expect(result.analyses.get(2)!.textBlocks).toEqual([]);
  });
});
