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

  it("设置面板预设的模型按真实上下文档位取值（不高估）", () => {
    // 预设表 prefill 的四个国内模型：qwen-plus / glm-4-plus / moonshot-v1-8k /
    // step-2-16k。前两个本就落在家族规则的正确档位，后两个曾是 8 倍 / 16 倍
    // 高估（moonshot-v1-8k 按 131072、step-2-16k 落 128000 兜底）。
    expect(resolveModelBudgets("qwen-plus")).toEqual({
      contextWindowTokens: 131072,
      maxOutputTokens: 8192,
    });
    expect(resolveModelBudgets("glm-4-plus")).toEqual({
      contextWindowTokens: 131072,
      maxOutputTokens: 16384,
    });
    expect(resolveModelBudgets("moonshot-v1-8k")).toEqual({
      contextWindowTokens: 8192,
      maxOutputTokens: 4096,
    });
    expect(resolveModelBudgets("step-2-16k")).toEqual({
      contextWindowTokens: 16384,
      maxOutputTokens: 4096,
    });
  });

  it("moonshot 分档优先于家族兜底，v1 新家族仍走 128k 档", () => {
    expect(resolveModelBudgets("moonshot-v1-8k").contextWindowTokens).toBe(8192);
    expect(resolveModelBudgets("moonshot-v1-32k").contextWindowTokens).toBe(32768);
    expect(resolveModelBudgets("moonshot-v1-128k").contextWindowTokens).toBe(131072);
    expect(resolveModelBudgets("kimi-latest").contextWindowTokens).toBe(131072);
  });

  it("小窗口模型的输入预算不会超过它的真实窗口", () => {
    // 与 createAIBatchTranslator 的推导同构：contextWindow − 系统预留 − 输出上限。
    for (const model of ["moonshot-v1-8k", "step-2-16k", "moonshot-v1-32k"]) {
      const b = resolveModelBudgets(model);
      const inputBudget = Math.min(
        b.contextWindowTokens - 600 - b.maxOutputTokens,
        8192, // translate.batchMaxTokens 出厂值
      );
      expect(inputBudget + b.maxOutputTokens, `${model} 的输入加输出`).toBeLessThanOrEqual(
        b.contextWindowTokens,
      );
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
