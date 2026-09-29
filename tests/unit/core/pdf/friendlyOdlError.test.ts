/**
 * friendlyOdlError / isJavaMissingError — 用户可见的错误分类契约。
 *
 * 关键行为：
 *   - HTTP 状态码优先：401/403 → 密钥文案、429 → 配额文案、其余 → 状态码
 *     加响应摘要，不再透出原始英文；
 *   - Java 判定基于启动失败签名，而非裸 "java" 子串 —— java.lang.* 堆栈、
 *     含 "javascript" 的 URL 等不得误入「需要安装 Java」分支。
 *
 * vitest 环境无 Localization，getString 返回 `ztransplit-<key>` 本身，
 * 断言按 key 前缀进行。
 */
import { describe, it, expect } from "vitest";
import {
  friendlyOdlError,
  isJavaMissingError,
} from "../../../../src/core/pdf/splitview/splitViewFactory";

const KEY = (id: string) => `ztransplit-${id}`;

describe("friendlyOdlError — HTTP 状态码分类", () => {
  it("401/403 映射到密钥无效文案", () => {
    expect(friendlyOdlError("HTTP 401: Unauthorized")).toBe(
      KEY("odl-error-http-auth"),
    );
    expect(friendlyOdlError("Request failed: HTTP 403 (forbidden)")).toBe(
      KEY("odl-error-http-auth"),
    );
  });

  it("429 映射到配额/限流文案", () => {
    expect(friendlyOdlError("HTTP 429: Too Many Requests")).toBe(
      KEY("odl-error-http-rate"),
    );
  });

  it("其他 HTTP 错误保留状态码并截断原始信息", () => {
    const long = "HTTP 500: " + "x".repeat(300);
    const out = friendlyOdlError(long);
    expect(out.startsWith(KEY("odl-error-http-other"))).toBe(true);
    expect(out.length).toBeLessThan(KEY("odl-error-http-other").length + 130);
  });
});

describe("friendlyOdlError / isJavaMissingError — Java 启动失败签名", () => {
  const missing = [
    "Java runtime not found. Please install Java 11+ and add it to PATH.",
    "OpenDataLoader requires Java 11+. Install Java, make sure `java` is on PATH, then retry.",
    "Error: java: command not found",
    "'java' is not recognized as an internal or external command",
    "需要安装 Java 11+",
    "需要安裝 Java",
    "A JVM was not found on this system",
  ];
  it.each(missing)("识别为缺 Java：%s", (msg) => {
    expect(isJavaMissingError(msg)).toBe(true);
    expect(friendlyOdlError(msg)).toBe(KEY("odl-error-java-missing"));
  });

  const notMissing = [
    // 运行中 JVM 的堆栈是运行时错误，不是「未安装」
    "java.lang.NullPointerException at com.example.Translate",
    // URL/模型名里恰好含 "java" 子串
    "GET https://api.example.com/models?filter=javascript failed",
    "java.util.concurrent.TimeoutException while awaiting response",
  ];
  it.each(notMissing)("不误判为缺 Java：%s", (msg) => {
    expect(isJavaMissingError(msg)).toBe(false);
  });
});

describe("friendlyOdlError — 其余既有分类不受影响", () => {
  it("超时归入网络错误", () => {
    expect(friendlyOdlError("Request timed out after 30000ms")).toBe(
      KEY("odl-error-network"),
    );
  });

  it("未配置归入配置引导", () => {
    expect(friendlyOdlError("翻译未配置：请先选择引擎")).toBe(
      KEY("odl-error-not-configured"),
    );
    expect(friendlyOdlError("AI engine not configured")).toBe(
      KEY("odl-error-not-configured"),
    );
  });

  it("含 Java 子串的 HTTP 错误仍按 HTTP 分类（优先级）", () => {
    expect(friendlyOdlError("HTTP 401: unauthorized java client")).toBe(
      KEY("odl-error-http-auth"),
    );
  });
});
