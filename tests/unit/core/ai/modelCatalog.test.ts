/**
 * modelCatalog 的单元测试（按模型名查表的供应商内省）。
 */
import { describe, it, expect } from "vitest";
import {
  FALLBACK_MODEL_BUDGETS,
  resolveModelBudgets,
} from "../../../../src/core/ai/modelCatalog";

describe("resolveModelBudgets", () => {
  it("空值与未识别模型回落默认常量（改动前行为）", () => {
    expect(resolveModelBudgets(undefined)).toEqual(FALLBACK_MODEL_BUDGETS);
    expect(resolveModelBudgets("")).toEqual(FALLBACK_MODEL_BUDGETS);
    expect(resolveModelBudgets("mystery-model-9000")).toEqual(FALLBACK_MODEL_BUDGETS);
  });

  it("大小写不敏感", () => {
    expect(resolveModelBudgets("GPT-5")).toEqual(resolveModelBudgets("gpt-5"));
    expect(resolveModelBudgets("DeepSeek-Chat")).toEqual(
      resolveModelBudgets("deepseek-chat"),
    );
  });

  it("命中常见托管家族并落在安全边界内", () => {
    const cases: Array<[string, number, number]> = [
      // [模型名, 上下文窗口, 输出上限]
      ["gpt-5", 400000, 65536],
      ["gpt-5-mini-2026-01", 400000, 65536],
      ["gpt-4.1", 1048576, 32768],
      ["o4-mini", 200000, 65536],
      ["claude-sonnet-4-5", 200000, 32000],
      ["claude-3-5-sonnet", 200000, 8192],
      ["gemini-2.5-pro", 1048576, 65536],
      ["deepseek-chat", 65536, 8192],
      ["deepseek-reasoner", 65536, 32768],
      ["glm-4.6", 200000, 32768],
      ["qwen3-max", 131072, 32768],
      ["kimi-k2", 131072, 8192],
    ];
    for (const [model, contextWindow, maxOutput] of cases) {
      const budgets = resolveModelBudgets(model);
      expect(
        budgets,
        `${model} 的预算`,
      ).toEqual({ contextWindowTokens: contextWindow, maxOutputTokens: maxOutput });
    }
  });

  it("特例优先于家族兜底（claude-3 不落到 claude 家族档）", () => {
    expect(resolveModelBudgets("claude-3-7-sonnet").maxOutputTokens).toBe(8192);
    expect(resolveModelBudgets("claude-sonnet-4").maxOutputTokens).toBe(32000);
  });

  it("任何命中值的输出上限都不低于可用的单段预算（4096 下限）", () => {
    for (const model of ["gpt-4o", "glm-4-air", "qwen-turbo", "llama-3"]) {
      expect(resolveModelBudgets(model).maxOutputTokens).toBeGreaterThanOrEqual(4096);
    }
  });
});
