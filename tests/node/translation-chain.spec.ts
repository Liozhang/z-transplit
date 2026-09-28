/**
 * translation-chain — 真实翻译链路单测（不走 Zotero）
 *
 * 覆盖：
 *  - createTranslator("custom") 真的把译文请求发给了 OpenAI 兼容端点
 *  - createTranslator 按 engineType 分发到 google/bing/deepl/custom
 *  - zotero-pdf-translate / 缺 key / 缺 URL 的配置错误分支
 *  - createAIBatchTranslator 的批量 JSON 链路（含降级到逐段）
 *
 * 相对 leadero 版 tests/node/translation-chain.spec.ts 的裁剪：engineType 锚点
 * 从 "ai" 改为 "custom"（ai 引擎连同 ModelRouter 依赖一并移除）；原文件中
 * translateParagraphs 相关用例属于 src/core/pdf/**（不归本模块），随该模块的
 * 测试一并落地，此处不再重复。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
vi.mock("../../src/utils/locale", () => ({
  // 键名即断言对象（同 leadero 的 research.test.ts）：文案本地化后，
  // 断言不该再依赖某个具体语言的字符串。
  getString: (key: string, opts?: any) =>
    opts && Object.keys(opts).length > 0
      ? `${key}:${JSON.stringify(opts)}`
      : key,
}));

// 待测模块
// ---------------------------------------------------------------------------
import {
  createTranslator,
  createAIBatchTranslator,
} from "../../src/core/translation/translationEngines";
import { getLanguageName } from "../../src/core/tool/language";
import * as prefs from "../../src/utils/prefs";

// prefs 模块 mock（ESM 命名空间上直接 spyOn 过不了 z-transplit 的
// tsconfig.node.json 类型检查）
vi.mock("../../src/utils/prefs", () => ({
  getPrefDynamic: vi.fn(),
}));

const setPrefDynamic = vi.mocked(prefs.getPrefDynamic);

// ---------------------------------------------------------------------------
// 测试锚定的 pref 集：引擎默认钉在 custom（产品默认是 google 免 key）
// ---------------------------------------------------------------------------
function defaultPrefs(overrides: Record<string, any> = {}) {
  const map: Record<string, any> = {
    "translate.engineType": "custom",
    "translate.custom.apiUrl": "https://my-llm.example.com",
    "translate.custom.apiKey": "custom-key",
    "translate.custom.model": "my-model",
    "translate.targetLanguage": "zh-CN",
    "translate.google.apiKey": "",
    "translate.bing.apiKey": "",
    "translate.bing.region": "global",
    "translate.deepl.apiKey": "",
    "translate.deepl.useFree": "false",
    ...overrides,
  };
  setPrefDynamic.mockImplementation((key: string) => map[key]);
}

beforeEach(() => {
  setPrefDynamic.mockReset();
  // custom-engine tests rely on the engine being "custom"; the real pref
  // default is "google" (keyless), so pin it explicitly here.
  setPrefDynamic.mockImplementation((key: string) =>
    key === "translate.engineType" ? "custom" : (undefined as any),
  );
});

// ===========================================================================
// 1. custom（OpenAI 兼容）引擎
// ===========================================================================
describe("createTranslator / custom 引擎", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("调用 chat/completions 并返回译文（带公式保护 prompt）", async () => {
    defaultPrefs();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "结果" } }] }),
    } as any);

    const translate = createTranslator("zh-CN", "en");
    const out = await translate("result", "zh-CN", "en");
    expect(out).toBe("结果");

    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toBe("https://my-llm.example.com/v1/chat/completions");
    const init = (globalThis.fetch as any).mock.calls[0][1] as Record<
      string,
      any
    >;
    expect(init.headers.Authorization).toBe("Bearer custom-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("my-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[0].content).toContain("from en to Simplified Chinese");
    expect(body.messages[0].content).toContain("{v0}");
  });

  it("URL 已以 /chat/completions 结尾时不重复拼接", async () => {
    defaultPrefs({
      "translate.custom.apiUrl": "https://gw.example/v1/chat/completions",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: "结果" } }] }),
    } as any);

    const translate = createTranslator("zh-CN", "en");
    await translate("result", "zh-CN", "en");
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      "https://gw.example/v1/chat/completions",
    );
  });

  it("未配置 API URL 时抛出错误", async () => {
    defaultPrefs({ "translate.custom.apiUrl": "" });
    const translate = createTranslator("zh-CN");
    await expect(translate("x", "zh-CN")).rejects.toThrow(
      "translation-error-custom-url-missing",
    );
  });

  it("HTTP 错误透出状态码与响应体", async () => {
    defaultPrefs();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("bad key"),
    } as any);

    const translate = createTranslator("zh-CN");
    await expect(translate("x", "zh-CN")).rejects.toThrow("HTTP 401: bad key");
  });
});

// ===========================================================================
// 2. 各引擎分发
// ===========================================================================
describe("createTranslator / 引擎分发", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("engineType=google 走 Google 端点（无 key 走免费接口）", async () => {
    defaultPrefs({
      "translate.engineType": "google",
      "translate.targetLanguage": "zh-CN",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([[["结果", "result", null, null, 1]], null, "en"]),
    } as any);

    const translate = createTranslator("zh-CN", "en");
    const out = await translate("result", "zh-CN", "en");
    expect(out).toBe("结果");

    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("translate.googleapis.com/translate_a/single");
    expect(url).toContain("tl=zh-CN");
  });

  it("engineType=bing 走 Azure Translator 端点", async () => {
    defaultPrefs({
      "translate.engineType": "bing",
      "translate.bing.apiKey": "fake-key",
      "translate.bing.region": "eastasia",
      "translate.targetLanguage": "zh-CN",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ translations: [{ text: "結果" }] }]),
    } as any);

    const translate = createTranslator("zh-TW", "en");
    const out = await translate("result", "zh-TW", "en");
    expect(out).toBe("結果");

    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("api.cognitive.microsofttranslator.com");
    expect(url).toContain("to=zh-TW");
    const init = (globalThis.fetch as any).mock.calls[0][1] as Record<
      string,
      any
    >;
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("fake-key");
  });

  it("engineType=deepl 走 DeepL 端点", async () => {
    defaultPrefs({
      "translate.engineType": "deepl",
      "translate.deepl.apiKey": "fake-key",
      "translate.deepl.useFree": "false",
      "translate.targetLanguage": "zh-CN",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ translations: [{ text: "结果" }] }),
    } as any);

    const translate = createTranslator("zh-CN", "en");
    const out = await translate("result", "zh-CN", "en");
    expect(out).toBe("结果");

    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain("api.deepl.com/v2/translate");
    const body = new URLSearchParams(
      (globalThis.fetch as any).mock.calls[0][1].body,
    );
    expect(body.get("target_lang")).toBe("ZH");
  });

  it("未配置 API Key 时抛出错误", async () => {
    defaultPrefs({ "translate.engineType": "bing" });
    const translate = createTranslator("zh-CN");
    await expect(translate("x", "zh-CN")).rejects.toThrow(
      "translation-error-bing-not-configured",
    );
  });

  it("engineType=zotero-pdf-translate 缺插件时报配置错误（无 Zotero 全局不崩）", async () => {
    defaultPrefs({ "translate.engineType": "zotero-pdf-translate" });
    const translate = createTranslator("zh-CN");
    await expect(translate("x", "zh-CN")).rejects.toThrow(
      "translation-error-pdf-translate-missing",
    );
  });
});

// ===========================================================================
// 3. 批量翻译链路
// ===========================================================================
describe("createAIBatchTranslator / 批量链路", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("一次调用打包多段，位置对齐返回", async () => {
    defaultPrefs();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: '{"translations":["结果一","结果二","结果三"]}',
              },
            },
          ],
        }),
    } as any);

    const handle = await createAIBatchTranslator("zh-CN", "en");
    expect(handle.inputBudgetChars).toBeGreaterThan(0);
    expect(handle.outputBudgetChars).toBeGreaterThan(0);

    const result = await handle.translate(["one", "two", "three"]);
    expect(result.translations).toEqual(["结果一", "结果二", "结果三"]);
    expect(result.failedIndices).toEqual([]);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[1].content).toBe(
      '{"segments":["one","two","three"]}',
    );
  });

  it("接口持续失败时回退到原文并标记 failedIndices", async () => {
    defaultPrefs();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.resolve("down"),
    } as any);

    const handle = await createAIBatchTranslator("zh-CN", "en");
    const result = await handle.translate(["one", "two"]);
    expect(result).toEqual({
      translations: ["one", "two"],
      failedIndices: [0, 1],
    });
  });
});

// ===========================================================================
// 4. 语言名映射
// ===========================================================================
describe("getLanguageName", () => {
  it("映射已知区域码，未知码原样返回", () => {
    expect(getLanguageName("zh-CN")).toBe("Simplified Chinese");
    expect(getLanguageName("zh-TW")).toBe("Traditional Chinese");
    expect(getLanguageName("en-US")).toBe("English");
    expect(getLanguageName("ja-JP")).toBe("Japanese");
    expect(getLanguageName("ko-KR")).toBe("Korean");
    expect(getLanguageName("fr-FR")).toBe("French");
    expect(getLanguageName("de-DE")).toBe("German");
    expect(getLanguageName("es-ES")).toBe("Spanish");
    expect(getLanguageName("ru-RU")).toBe("Russian");
    expect(getLanguageName("xx-YY")).toBe("xx-YY");
  });
});
