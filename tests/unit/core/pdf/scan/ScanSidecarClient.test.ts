/**
 * ScanSidecarClient 测试（src/core/pdf/scan/ScanSidecarClient.ts）。
 *
 * 客户端是插件里唯一启动识别进程的地方：argv 拼错（Windows 空格路径）、
 * 超时、取消、result.json 缺失或畸形，每一种都必须归类成明确的状态而
 * 不是抛异常或静默返回空。测试用假宿主（临时目录 + 组件桩）加模块级
 * mock 的 runProcess/readFile/removePath 驱动真实客户端。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  runProcess: vi.fn(),
  readFile: vi.fn(),
  removePath: vi.fn(),
}));

vi.mock("../../../../../src/core/pdf/OpenDataLoaderPdfClient", () => ({
  runProcess: h.runProcess,
  readFile: h.readFile,
  removePath: h.removePath,
}));

import { runSidecarBatch, sidecarConcurrencyInUse } from "../../../../../src/core/pdf/scan/ScanSidecarClient";

const VALID_BATCH = JSON.stringify({
  pages: [
    {
      pageNumber: 1,
      pageSizePt: { width: 595, height: 842 },
      renderSizePx: { width: 1654, height: 2339 },
      dpi: 200,
      rotation: 0,
      lines: [{ bbox: { x0: 10, y0: 10, x1: 100, y1: 30 }, text: "hello", blockId: 0 }],
      formulas: [],
      tables: [],
      figures: [],
      coverage: 0.3,
    },
  ],
  diagnostics: { engine: "fake" },
});

const createdDirs: string[] = [];

function installHost(): void {
  const base = "T:/tmp";
  const makeFile = (): any => {
    let name = "";
    return {
      get path() {
        return name ? `${base}/${name}` : base;
      },
      clone: () => makeFile(),
      append(n: string) {
        name = n;
        createdDirs.push(`${base}/${n}`);
      },
      createUnique() {
        /* no-op */
      },
    };
  };
  (globalThis as any).Zotero = { getTempDirectory: () => makeFile() };
}

beforeEach(() => {
  createdDirs.length = 0;
  installHost();
  h.runProcess.mockReset();
  h.readFile.mockReset();
  h.removePath.mockReset();
  h.removePath.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (globalThis as any).Zotero;
});

const ARGV = ["python", "sidecar.py"];

describe("runSidecarBatch", () => {
  it("未配置侧车（argv 为空）时不启动进程", async () => {
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: [] });
    expect(run.status).toBe("unconfigured");
    expect(h.runProcess).not.toHaveBeenCalled();
  });

  it("空页清单不启动进程，直接回报空结果", async () => {
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [], argv: ARGV });
    expect(run.status).toBe("ok");
    expect(run.pages.size).toBe(0);
    expect(h.runProcess).not.toHaveBeenCalled();
  });

  it("成功批：退出码 0 + result.json 可读 → ok，页进索引，临时目录被清理", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    h.readFile.mockResolvedValue(VALID_BATCH);
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("ok");
    expect(run.pages.get(1)!.lines[0].text).toBe("hello");
    expect(run.diagnostics!.engine).toBe("fake");
    expect(h.removePath).toHaveBeenCalledTimes(1);
    expect(run.workDir).toBeUndefined();
  });

  it("argv 透传：可执行文件、--pdf/--pages/--out/--dpi 与超时、信号", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    h.readFile.mockResolvedValue(VALID_BATCH);
    const controller = new AbortController();
    await runSidecarBatch({
      pdfPath: "C:/docs/scan.pdf",
      pages: [2, 1, 3],
      argv: ARGV,
      dpi: 300,
      timeoutMs: 1234,
      signal: controller.signal,
    });
    expect(h.runProcess).toHaveBeenCalledTimes(1);
    const [exe, args, timeout, signal] = h.runProcess.mock.calls[0];
    expect(exe).toBe("python");
    expect(args).toEqual([
      "sidecar.py",
      "--pdf",
      "C:/docs/scan.pdf",
      "--pages",
      "1,2,3",
      "--out",
      expect.any(String),
      "--dpi",
      "300",
    ]);
    expect(timeout).toBe(1234);
    expect(signal).toBe(controller.signal);
  });

  it("部分成功：退出码 2 仍读回结果", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "page 2 failed", timedOut: false });
    h.readFile.mockResolvedValue(VALID_BATCH);
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1, 2], argv: ARGV });
    expect(run.status).toBe("partial");
    expect(run.pages.size).toBe(1);
  });

  it("进程级失败：退出码 1 → failed，保留工作目录供排障", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "engine init failed", timedOut: false });
    h.readFile.mockResolvedValue(VALID_BATCH);
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("failed");
    expect(run.workDir).toBeDefined();
    expect(h.removePath).not.toHaveBeenCalled();
  });

  it("超时：归类 timeout 并保留目录", async () => {
    h.runProcess.mockResolvedValue({ exitCode: -1, stdout: "", stderr: "Process timed out", timedOut: true });
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("timeout");
    expect(run.workDir).toBeDefined();
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it("取消：归类 aborted，与超时区分（上层按取消收尾）", async () => {
    h.runProcess.mockResolvedValue({ exitCode: -1, stdout: "", stderr: "aborted", timedOut: false, aborted: true });
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("aborted");
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it("result.json 缺失 → failed 且带原因", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "side note", timedOut: false });
    h.readFile.mockRejectedValue(new Error("ENOENT"));
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("failed");
    expect(run.stderr).toContain("result.json unreadable");
    expect(run.workDir).toBeDefined();
  });

  it("result.json 畸形 → failed 且不抛异常", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    h.readFile.mockResolvedValue("这不是 JSON");
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("failed");
    expect(run.stderr).toContain("result.json malformed");
  });

  it("result.json 是合法 JSON 但结构不对 → failed", async () => {
    h.runProcess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    h.readFile.mockResolvedValue(JSON.stringify({ hello: "world" }));
    const run = await runSidecarBatch({ pdfPath: "x.pdf", pages: [1], argv: ARGV });
    expect(run.status).toBe("failed");
  });

  it("信号量限流：并发第三批必须等待前两批释放（泄漏会让它永久排队）", async () => {
    // 上限是 2：三个并发调用里必须至多两个同时在飞。release 坏了的话
    // 第三个永远等不到槽位，本用例以超时失败的形式暴露泄漏。
    let inFlight = 0;
    let maxInFlight = 0;
    h.runProcess.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    h.readFile.mockResolvedValue(VALID_BATCH);
    const runs = [1, 2, 3].map((p) =>
      runSidecarBatch({ pdfPath: "x.pdf", pages: [p], argv: ARGV }),
    );
    const results = await Promise.all(runs);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(sidecarConcurrencyInUse()).toBe(0);
  });
});
