/**
 * translateError — 通用报错分类的行为契约。
 *
 * vitest 环境没有 Localization，getString 回落为 `ztransplit-<键名>`，
 * 断言按键前缀进行。分类依据与 connectionTest 相同：错误对象上的 HTTP
 * status 文本与 fetch 层 TypeError 的词形。
 */
import { describe, it, expect } from "vitest";
import {
  classifyHttpMessage,
  classifyNetworkMessage,
  classifyNotConfiguredMessage,
  classifyBadResponseMessage,
  friendlyTranslateMessage,
  friendlyTranslateError,
} from "../../../../src/core/translation/translateError";

const KEY = (id: string) => `ztransplit-${id}`;

describe("classifyHttpMessage — 状态码分类", () => {
  it("401/403 → 密钥文案；429 → 限流文案", () => {
    expect(classifyHttpMessage("HTTP 401: Unauthorized")).toBe(
      KEY("odl-error-http-auth"),
    );
    expect(classifyHttpMessage("Request failed: HTTP 403 (forbidden)")).toBe(
      KEY("odl-error-http-auth"),
    );
    expect(classifyHttpMessage("HTTP 429: Too Many Requests")).toBe(
      KEY("odl-error-http-rate"),
    );
  });

  it("其他状态码保留状态码与截断摘要", () => {
    const out = classifyHttpMessage("HTTP 500: " + "x".repeat(300));
    expect(out).toBe(KEY("odl-error-http-other"));
  });

  it("没有状态码的文本返回 null（调用方继续其他判定）", () => {
    expect(classifyHttpMessage("NetworkError when attempting to fetch.")).toBeNull();
    expect(classifyHttpMessage("")).toBeNull();
  });
});

describe("classifyNetworkMessage / classifyNotConfiguredMessage", () => {
  it("网络词形 → 网络文案", () => {
    expect(classifyNetworkMessage("NetworkError when attempting to fetch.")).toBe(
      KEY("odl-error-network"),
    );
    expect(classifyNetworkMessage("Request timed out after 30000ms")).toBe(
      KEY("odl-error-network"),
    );
    expect(classifyNetworkMessage("网络连接失败")).toBe(KEY("odl-error-network"));
  });

  it("非网络词形返回 null", () => {
    expect(classifyNetworkMessage("some unrelated failure")).toBeNull();
  });

  it("未配置词形 → 配置引导（含本地化引擎文案）", () => {
    expect(classifyNotConfiguredMessage("翻译未配置：请先选择引擎")).toBe(
      KEY("odl-error-not-configured"),
    );
    expect(classifyNotConfiguredMessage("AI engine not configured")).toBe(
      KEY("odl-error-not-configured"),
    );
    expect(classifyNotConfiguredMessage("all good")).toBeNull();
  });
});

describe("classifyBadResponseMessage — 模型返回不合约定", () => {
  it("两条失败词形都指向换模型的引导", () => {
    expect(classifyBadResponseMessage("Custom API returned non-JSON content")).toBe(
      KEY("translation-error-ai-bad-response"),
    );
    expect(
      classifyBadResponseMessage(
        "Custom API JSON failed schema validation: expected array",
      ),
    ).toBe(KEY("translation-error-ai-bad-response"));
  });

  it("普通失败不误入", () => {
    expect(classifyBadResponseMessage("HTTP 500: oops")).toBeNull();
  });
});

describe("friendlyTranslateMessage — 兜底改写", () => {
  it("按 HTTP → 坏响应 → 网络 → 未配置 的顺序分类", () => {
    // 含 "network" 又含 "not configured" 的文本：HTTP 之外的优先级固定。
    expect(friendlyTranslateMessage("HTTP 401: not configured client")).toBe(
      KEY("odl-error-http-auth"),
    );
    expect(friendlyTranslateMessage("network not configured")).toBe(
      KEY("odl-error-network"),
    );
  });

  it("已是限流专门文案的输入原样返回（保留「等太久」等细节）", () => {
    const waitTooLong = KEY("translation-error-rate-limited-wait-too-long");
    expect(friendlyTranslateMessage(waitTooLong)).toBe(waitTooLong);
    const limited = KEY("translation-error-rate-limited");
    expect(friendlyTranslateMessage(limited)).toBe(limited);
  });

  it("没有词形命中的文本截断到 200 字符", () => {
    const long = "x".repeat(300);
    expect(friendlyTranslateMessage(long)).toBe(long.slice(0, 200) + "…");
    expect(friendlyTranslateMessage("short")).toBe("short");
  });
});

describe("friendlyTranslateError — 错误对象入口", () => {
  it("空补全（emptyCompletion 标记）→ 输出上限指引", () => {
    const e = new Error(KEY("translation-error-ai-empty")) as Error & {
      emptyCompletion?: boolean;
    };
    e.emptyCompletion = true;
    expect(friendlyTranslateError(e)).toBe(KEY("pane-translate-error-empty"));
  });

  it("HTTP 错误分类，普通错误保留原文", () => {
    expect(friendlyTranslateError(new Error("HTTP 429: slow down"))).toBe(
      KEY("odl-error-http-rate"),
    );
    const plain = new Error("some plain failure");
    expect(friendlyTranslateError(plain)).toBe("some plain failure");
  });
});
