/**
 * bilingualLauncher 批量路径的引擎原因记录（真机复现 2026-11-02 的缺陷修复）。
 *
 * 背景：批量 translate 的失败只以 failedIndices 返回、从不抛出，引擎原因
 * 如果不在启动器这里记录，双语进度行只能显示「未知错误」（修复前 AI 批量
 * 429 时 95 段全败，进度行只有 "Unknown error"）。本文件钉死三件事：
 *   - 批量失败且带原因 → getLastEngineError 记下该原因；
 *   - 整块成功 → 原因清空（与逐段分支同一语义）；
 *   - 失败但无原因（旧实现或原因未知）→ 保留上一次原因，不写成空。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  enterBilingualSessionMock,
  exitBilingualSessionMock,
  buildInterleaveMock,
  batchTranslateMock,
} = vi.hoisted(() => ({
  enterBilingualSessionMock: vi.fn(),
  exitBilingualSessionMock: vi.fn(),
  buildInterleaveMock: vi.fn(),
  batchTranslateMock: vi.fn(),
}));

vi.mock("../../../../../src/core/pdf/sdt/sdtBridge", () => ({
  enterBilingualSession: enterBilingualSessionMock,
  exitBilingualSession: exitBilingualSessionMock,
}));

vi.mock("../../../../../src/core/pdf/sdt/interleaveView", () => ({
  buildInterleave: buildInterleaveMock,
}));

// supportsBatching 为真：走批量分支（被测路径）。
vi.mock("../../../../../src/core/translation/translationEngines", () => ({
  supportsBatching: () => true,
  createTranslator: () => async () => "x",
  createAIBatchTranslator: async () => ({ translate: batchTranslateMock }),
}));

import {
  getLastEngineError,
  startBilingualSession,
  stopBilingualSession,
} from "../../../../../src/core/pdf/sdt/bilingualLauncher";

/** 带 SDT 入口的 reader 桩：waitForReaderSdtEntry 立即通过，不必真等 10 秒。 */
function readerStub() {
  return {
    _internalReader: {
      _setReadingMode: async () => {},
      _loadSDT: async () => {},
    },
  };
}

/** 启动会话，取回启动器交给 interleaveView 的 batchTranslate。 */
async function startAndGetBatchTranslate() {
  buildInterleaveMock.mockResolvedValue({
    setMode: vi.fn(),
    getMode: vi.fn(() => "interleave"),
    dispose: vi.fn(async () => {}),
  });
  await startBilingualSession({
    reader: readerStub(),
    itemID: 7,
    mode: "interleave",
    targetLanguage: "zh-CN",
  });
  const opts = buildInterleaveMock.mock.calls[0][1];
  return opts.batchTranslate as (
    texts: string[],
  ) => Promise<{ translations: string[]; failedIndices: number[]; error?: string }>;
}

beforeEach(() => {
  enterBilingualSessionMock.mockReset().mockResolvedValue({});
  exitBilingualSessionMock.mockReset().mockResolvedValue(undefined);
  buildInterleaveMock.mockReset();
  batchTranslateMock.mockReset();
});

afterEach(async () => {
  await stopBilingualSession();
});

describe("bilingualLauncher：批量路径的引擎原因记录", () => {
  it("批量失败且带原因时记入 lastEngineError（进度行据此显示）", async () => {
    const batchTranslate = await startAndGetBatchTranslate();
    batchTranslateMock.mockResolvedValue({
      translations: ["甲", "乙"],
      failedIndices: [1],
      error: "translation-error-rate-limited",
    });
    await batchTranslate(["甲", "乙"]);
    expect(getLastEngineError()).toBe("translation-error-rate-limited");
  });

  it("整块成功时清空原因", async () => {
    const batchTranslate = await startAndGetBatchTranslate();
    batchTranslateMock.mockResolvedValueOnce({
      translations: ["甲"],
      failedIndices: [0],
      error: "translation-error-rate-limited",
    });
    await batchTranslate(["甲"]);
    expect(getLastEngineError()).toBe("translation-error-rate-limited");

    batchTranslateMock.mockResolvedValueOnce({
      translations: ["译文"],
      failedIndices: [],
    });
    await batchTranslate(["乙"]);
    expect(getLastEngineError()).toBeNull();
  });

  it("失败但无原因时保留上一次原因，不写成空", async () => {
    const batchTranslate = await startAndGetBatchTranslate();
    batchTranslateMock.mockResolvedValueOnce({
      translations: ["甲"],
      failedIndices: [0],
      error: "translation-error-rate-limited",
    });
    await batchTranslate(["甲"]);

    // 无 error 字段（旧实现或原因未知）：保留已有原因，进度行继续说限流，
    // 不退回「未知错误」。
    batchTranslateMock.mockResolvedValueOnce({
      translations: ["乙", "丙"],
      failedIndices: [0, 1],
    });
    await batchTranslate(["乙", "丙"]);
    expect(getLastEngineError()).toBe("translation-error-rate-limited");
  });
});
