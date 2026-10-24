/**
 * providerPresets — AI 服务商预设表的纯函数测试。
 *
 * 契约（src/core/ai/providerPresets.ts，面板镜像表与此一致）：
 *   - 选中已知服务商 → 填入端点与推荐模型；
 *   - none / custom / 未知 id → 不动任何字段（切到自定义不清空用户抄来的
 *     网关地址）；
 *   - 模型名的覆盖守门：只在当前为空、或当前值是「另一个预设的值」时才盖
 *     掉——用户手工改过的模型名不被预设吞掉；
 *   - detectProviderPresetId 按地址反查，供面板加载时回显。
 */
import { describe, it, expect } from "vitest";
import {
  AI_PROVIDER_PRESETS,
  AI_PROVIDER_PRESET_NONE,
  applyProviderPreset,
  detectProviderPresetId,
  findProviderPreset,
} from "../../../../src/core/ai/providerPresets";

describe("applyProviderPreset", () => {
  it("选中已知服务商：填入端点与推荐模型", () => {
    const result = applyProviderPreset("deepseek", {
      apiUrl: "",
      model: "",
    });
    expect(result).toEqual({
      apiUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      keyless: false,
    });
  });

  it("none / 未知 id / custom：一个字段都不动", () => {
    const current = { apiUrl: "https://my-gateway.internal/v1", model: "my-model" };
    for (const id of [AI_PROVIDER_PRESET_NONE, "custom", "no-such-provider", undefined, ""]) {
      expect(applyProviderPreset(id, current)).toEqual({
        apiUrl: current.apiUrl,
        model: current.model,
        keyless: false,
      });
    }
  });

  it("用户手工改过的模型名不被预设吞掉", () => {
    // 先选 DeepSeek（填入 deepseek-chat），用户改成 reasoner，再切到智谱：
    // 端点跟着换，模型名保留用户的 reasoner。
    const afterDeepseek = applyProviderPreset("deepseek", {
      apiUrl: "",
      model: "",
    });
    const afterManualEdit = {
      apiUrl: afterDeepseek.apiUrl,
      model: "deepseek-reasoner",
    };
    const afterGlm = applyProviderPreset("glm", afterManualEdit);
    expect(afterGlm.apiUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(afterGlm.model).toBe("deepseek-reasoner");
  });

  it("模型名还是另一个预设的值时，允许被新预设覆盖", () => {
    // 用户没手工改过：从 DeepSeek 切到 Kimi，模型名换成 Kimi 的推荐值。
    const result = applyProviderPreset("kimi", {
      apiUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
    expect(result.model).toBe("moonshot-v1-8k");
  });

  it("本地服务商标记 keyless", () => {
    expect(applyProviderPreset("ollama", { apiUrl: "", model: "" }).keyless).toBe(true);
    expect(applyProviderPreset("lmstudio", { apiUrl: "", model: "" }).keyless).toBe(true);
    expect(applyProviderPreset("deepseek", { apiUrl: "", model: "" }).keyless).toBe(false);
  });

  it("每个预设的端点都非空（custom 除外）且模型名可达", () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      if (preset.id === "custom") {
        expect(preset.apiUrl).toBe("");
        continue;
      }
      expect(preset.apiUrl, preset.id).toMatch(/^https?:\/\//);
      expect(typeof preset.model).toBe("string");
    }
  });

  it("预设 id 唯一", () => {
    const ids = AI_PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("detectProviderPresetId", () => {
  it("按地址精确反查（容忍末尾斜杠与大小写）", () => {
    expect(detectProviderPresetId("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectProviderPresetId("https://api.deepseek.com/v1/")).toBe("deepseek");
    expect(detectProviderPresetId("  https://API.deepseek.com/v1  ")).toBe("deepseek");
  });

  it("空地址与未知地址返回 none", () => {
    expect(detectProviderPresetId("")).toBe(AI_PROVIDER_PRESET_NONE);
    expect(detectProviderPresetId("   ")).toBe(AI_PROVIDER_PRESET_NONE);
    expect(detectProviderPresetId("https://example.com/v1")).toBe(AI_PROVIDER_PRESET_NONE);
  });

  it("反查与 apply 互为 round-trip：预设填出的地址能反查回自己", () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      if (!preset.apiUrl) continue;
      expect(detectProviderPresetId(preset.apiUrl), preset.id).toBe(preset.id);
    }
  });
});

describe("findProviderPreset", () => {
  it("按 id 查找，空输入返回 undefined", () => {
    expect(findProviderPreset("glm")?.apiUrl).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(findProviderPreset(undefined)).toBeUndefined();
    expect(findProviderPreset("")).toBeUndefined();
    expect(findProviderPreset("nope")).toBeUndefined();
  });
});
