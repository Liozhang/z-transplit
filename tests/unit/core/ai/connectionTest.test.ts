/**
 * connectionTest — 「测试连接」结果分类测试（src/core/ai/connectionTest.ts）。
 *
 * 只桩 fetch：被测代码走真实的 openaiCompat 客户端（URL 归一化、Authorization
 * 头、错误 status 传递），分类逻辑依据错误上携带的 HTTP status 与 fetch 层
 * TypeError。覆盖用户配置出错的每一种典型形态：
 *
 *   - 401/403 → 密钥问题（最常见：忘了粘密钥）
 *   - 404     → 地址问题（服务商选错/路径抄错）
 *   - 429     → 限流
 *   - 无 status → 网络不可达（大陆直连 api.openai.com 正是这条）
 *   - 200 但空 content → 连通但模型没应答
 *   - 没填地址 → 配置不完整
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testAiConnection } from "../../../../src/core/ai/connectionTest";

/** fetch 桩：按 URL 路由返回预置响应或抛错。 */
let handler: (url: string, init: any) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okCompletion(content: string): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
    model: "test-model",
  });
}

beforeEach(() => {
  handler = () => okCompletion("OK");
  vi.stubGlobal("fetch", (url: string, init: any = {}) => handler(String(url), init));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CFG = {
  apiUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
};

describe("testAiConnection — 成功路径", () => {
  it("连通：返回 ok 与本地化成功消息", async () => {
    const result = await testAiConnection(CFG);
    expect(result.ok).toBe(true);
    expect(result.kind).toBeUndefined();
    // 单测环境没有 Localization 实例，getString 返回消息 id 本身；文案内容
    // 由 FTL 承担（tests/unit/i18n 负责键集合与死键）。
    expect(result.message).toContain("ai-test-ok");
    // 模型名走结构化字段（message 在无 Localization 的环境里只是消息 id）
    expect(result.model).toBe("deepseek-chat");
    expect(typeof result.ms).toBe("number");
  });

  it("请求形态：POST 到 /chat/completions，带 Authorization 与最小预算", async () => {
    let seen: any = null;
    handler = (url, init) => {
      seen = { url, init };
      return okCompletion("OK");
    };
    await testAiConnection(CFG);
    expect(seen.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(seen.init.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.max_tokens).toBeLessThanOrEqual(64);
  });

  it("没配密钥时不发送 Authorization 头（本地服务商场景）", async () => {
    let seen: any = null;
    handler = (_url, init) => {
      seen = init;
      return okCompletion("OK");
    };
    const result = await testAiConnection({ ...CFG, apiKey: "" });
    expect(result.ok).toBe(true);
    expect(seen.headers.Authorization).toBeUndefined();
  });

  it("基址已指向 /chat/completions 时不重复拼接", async () => {
    let seen: any = null;
    handler = (url) => {
      seen = url;
      return okCompletion("OK");
    };
    await testAiConnection({ ...CFG, apiUrl: "https://gw.example.com/openai/deployments/x/chat/completions" });
    expect(seen).toBe("https://gw.example.com/openai/deployments/x/chat/completions");
  });
});

describe("testAiConnection — 失败分类", () => {
  it("401 → 密钥问题", async () => {
    handler = () => jsonResponse({ error: "invalid key" }, 401);
    const result = await testAiConnection(CFG);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("auth");
    expect(result.message).toContain("ai-test-auth");
  });

  it("403 同样归为密钥问题", async () => {
    handler = () => jsonResponse({ error: "forbidden" }, 403);
    const result = await testAiConnection(CFG);
    expect(result.kind).toBe("auth");
  });

  it("404 → 地址问题", async () => {
    handler = () => jsonResponse({ error: "not found" }, 404);
    const result = await testAiConnection(CFG);
    expect(result.kind).toBe("not-found");
    expect(result.message).toContain("ai-test-not-found");
  });

  it("429 → 限流", async () => {
    handler = () => jsonResponse({ error: "slow down" }, 429);
    const result = await testAiConnection(CFG);
    expect(result.kind).toBe("rate-limit");
  });

  it("500 → 其它 HTTP 错误，带状态码", async () => {
    handler = () => jsonResponse({ error: "boom" }, 500);
    const result = await testAiConnection(CFG);
    expect(result.kind).toBe("http");
    expect(result.message).toContain("ai-test-http");
  });

  it("fetch 层失败（连接被拒/超时）→ 网络不可达", async () => {
    handler = () => {
      throw new TypeError("fetch failed");
    };
    const result = await testAiConnection(CFG);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("network");
    expect(result.message).toContain("ai-test-network");
  });

  it("超时（AbortError）→ 网络不可达的超时文案", async () => {
    handler = () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    const result = await testAiConnection(CFG);
    expect(result.kind).toBe("network");
    expect(result.message).toContain("ai-test-timeout");
  });

  it("200 但模型没有返回内容 → 空应答", async () => {
    handler = () => jsonResponse({ choices: [{ message: { content: "" } }] });
    const result = await testAiConnection(CFG);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("empty");
  });

  it("没填接口地址 → 配置不完整，且根本不发请求", async () => {
    let called = false;
    handler = () => {
      called = true;
      return okCompletion("OK");
    };
    const result = await testAiConnection({ ...CFG, apiUrl: "  " });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("invalid");
    expect(called).toBe(false);
  });
});
