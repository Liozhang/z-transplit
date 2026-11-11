/**
 * runTranslator（src/core/pdf/translation/runTranslator.ts）的单元测试：引擎
 * 配置每次运行只解析一次，运行中途改偏好不换 translator。
 *
 * translationEngines 整体替换为假件——本文件只关心「解析几次、传给谁」，
 * 真实引擎的分发与缓存由 translationEngines 自己的测试覆盖。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const created: Array<{ target: string; source?: string }> = [];
/** 每次 createTranslator 调用返回的新 translator（按调用次序）。 */
const innerCalls: Array<[string, string | undefined, string | undefined]> = [];
let innerImpl: (text: string) => Promise<string> = async (t) => "译:" + t;

vi.mock("../../../../../src/core/translation/translationEngines", () => ({
  createTranslator: (target: string, source?: string) => {
    created.push({ target, source });
    return async (
      text: string,
      _tgt: string,
      _src?: string,
    ): Promise<string> => {
      innerCalls.push([text, _tgt, _src]);
      return innerImpl(text);
    };
  },
}));

import { makeRunTranslator } from "../../../../../src/core/pdf/translation/runTranslator";

beforeEach(() => {
  created.length = 0;
  innerCalls.length = 0;
  innerImpl = async (t) => "译:" + t;
});

describe("makeRunTranslator — 引擎配置每次运行只解析一次", () => {
  it("建 translator 时解析一次，之后每段都不再解析", async () => {
    const translator = makeRunTranslator("zh-CN", "en");
    expect(created).toEqual([{ target: "zh-CN", source: "en" }]);

    // 连译三段：createTranslator 没有被再次调用
    expect(await translator("a", "zh-CN", "en")).toBe("译:a");
    expect(await translator("b", "zh-CN", "en")).toBe("译:b");
    expect(await translator("c", "zh-CN", "en")).toBe("译:c");
    expect(created).toHaveLength(1);
    // 三段都走了同一个 inner translator
    expect(innerCalls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });

  it("每段都用本次运行定型的语言对，不随调用参数漂移", async () => {
    const translator = makeRunTranslator("zh-CN", "en");
    // 调用方即便传来别的语言对（translateParagraphs 会原样转发自己的参数），
    // 发的仍是运行定型的那一对
    await translator("x", "ja-JP", "fr-FR");
    expect(innerCalls[0][1]).toBe("zh-CN");
    expect(innerCalls[0][2]).toBe("en");
  });

  it("运行中途改偏好不换 translator：一份文档不会混用两个引擎", async () => {
    const translator = makeRunTranslator("zh-CN");
    await translator("第一段", "zh-CN");
    // 模拟用户在设置里换了引擎：再建一个 translator 才会解析新配置，
    // 手上这个继续用原来的
    const other = makeRunTranslator("zh-CN");
    await translator("第二段", "zh-CN");
    await other("别人的文档", "zh-CN");
    // 两次解析，各自只一次
    expect(created).toHaveLength(2);
    expect(innerCalls.map((c) => c[0])).toEqual([
      "第一段",
      "第二段",
      "别人的文档",
    ]);
  });

  it("源语言缺省时不传（由引擎自动判别）", async () => {
    const translator = makeRunTranslator("zh-CN");
    expect(created).toEqual([{ target: "zh-CN", source: undefined }]);
    await translator("hello", "zh-CN");
    expect(innerCalls[0][2]).toBeUndefined();
  });

  it("内层失败照实抛给调用方（不在这层吞掉）", async () => {
    innerImpl = async () => {
      throw new Error("HTTP 429");
    };
    const translator = makeRunTranslator("zh-CN");
    await expect(translator("x", "zh-CN")).rejects.toThrow("HTTP 429");
  });
});
