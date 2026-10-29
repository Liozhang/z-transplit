/**
 * openaiCompat 自定义请求头契约（translate.*.headers 偏好 → 每个请求）。
 *
 * 两层各钉一组约束：
 *   1. parseCustomHeaders：宽容解析——空行与无法成对的行跳过，值保留内部
 *      冒号（URL），同名时最后一个值生效，空输入返回空对象；
 *   2. createOpenAICompatClient 的 extraHeaders 在内置 Content-Type 与
 *      Authorization 之后合并——同名时用户的值获胜，这是驱动「要求租户头
 *      或非 Bearer 认证方案的网关」的唯一通路。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAICompatClient,
  parseCustomHeaders,
} from "../../../../src/core/ai/openaiCompat";

describe("parseCustomHeaders — 请求头文本解析", () => {
  it("基础「名称: 值」与名称、值两侧空白修剪", () => {
    expect(parseCustomHeaders("X-Tenant: acme")).toEqual({
      "X-Tenant": "acme",
    });
    expect(parseCustomHeaders("  X-A :   v  ")).toEqual({ "X-A": "v" });
  });

  it("值里的冒号保留（URL 场景）", () => {
    expect(parseCustomHeaders("X-Callback: https://a.example/x")).toEqual({
      "X-Callback": "https://a.example/x",
    });
  });

  it("CRLF 与空行都能处理", () => {
    expect(
      parseCustomHeaders("X-A: 1\r\n\r\nX-B: 2"),
    ).toEqual({ "X-A": "1", "X-B": "2" });
  });

  it("非法行跳过：无冒号、空名称、名称含空格、空值", () => {
    expect(
      parseCustomHeaders(["no colon", ": novalue", "Bad Name: v", "X-Empty:"].join("\n")),
    ).toEqual({});
  });

  it("同名重复时最后一个值生效；合法行与非法行混排只取合法行", () => {
    expect(
      parseCustomHeaders("X-Tenant: old\nX-Tenant: new\nbroken line"),
    ).toEqual({ "X-Tenant": "new" });
  });

  it("空输入与非字符串输入都返回空对象", () => {
    expect(parseCustomHeaders("")).toEqual({});
    expect(parseCustomHeaders(undefined as any)).toEqual({});
    expect(parseCustomHeaders(null as any)).toEqual({});
  });
});

describe("createOpenAICompatClient — 请求头合并", () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      calls.push({ url, headers: init.headers ?? {} });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "ok",
      };
    });
  }

  async function chatOnce(config: any) {
    const client = createOpenAICompatClient(config);
    return client.chat({ messages: [{ role: "user", content: "hi" }] });
  }

  it("默认头：Content-Type 恒在，配置了密钥才有 Authorization", async () => {
    stubFetch();
    await chatOnce({ apiUrl: "https://api.example/v1", apiKey: "sk-1" });
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-1");

    await chatOnce({ apiUrl: "https://api.example/v1" });
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[1].headers["Content-Type"]).toBe("application/json");
  });

  it("extraHeaders 追加自定义头，且同名时覆盖内置头", async () => {
    stubFetch();
    await chatOnce({
      apiUrl: "https://api.example/v1",
      apiKey: "sk-1",
      extraHeaders: {
        "X-Tenant-Id": "my-team",
        Authorization: "Bearer tenant-token",
        "Content-Type": "text/plain",
      },
    });
    expect(calls[0].headers["X-Tenant-Id"]).toBe("my-team");
    // 用户值覆盖内置 Bearer 头（非 Bearer 认证方案的通路）
    expect(calls[0].headers.Authorization).toBe("Bearer tenant-token");
    expect(calls[0].headers["Content-Type"]).toBe("text/plain");
  });

  it("parseCustomHeaders 的结果可以直接作为 extraHeaders 发出去", async () => {
    stubFetch();
    await chatOnce({
      apiUrl: "https://api.example/v1",
      apiKey: "sk-1",
      extraHeaders: parseCustomHeaders(
        "X-Tenant-Id: my-team\nX-Trace: abc\nbroken line",
      ),
    });
    expect(calls[0].headers).toMatchObject({
      "X-Tenant-Id": "my-team",
      "X-Trace": "abc",
      Authorization: "Bearer sk-1",
    });
    expect(JSON.stringify(calls[0].headers)).not.toContain("broken line");
  });
});
