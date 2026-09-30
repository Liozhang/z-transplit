/**
 * rateLimit 原语的单元测试（429 限流退避，utils/rateLimit.ts）。
 */
import { describe, it, expect } from "vitest";
import {
  backoffDelayMs,
  isRateLimitError,
  parseRetryAfterSec,
  rateLimitDelayMs,
  retryAfterFromHeaders,
  retryAfterOfError,
} from "../../../src/utils/rateLimit";

describe("parseRetryAfterSec", () => {
  it("接受正整数秒", () => {
    expect(parseRetryAfterSec("30")).toBe(30);
    expect(parseRetryAfterSec(" 120 ")).toBe(120);
  });

  it("拒绝空值、零、负数、小数与 HTTP 日期形态", () => {
    expect(parseRetryAfterSec(null)).toBeNull();
    expect(parseRetryAfterSec(undefined)).toBeNull();
    expect(parseRetryAfterSec("")).toBeNull();
    expect(parseRetryAfterSec("0")).toBeNull();
    expect(parseRetryAfterSec("-5")).toBeNull();
    expect(parseRetryAfterSec("1.5")).toBeNull();
    expect(parseRetryAfterSec("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("按 5s × 2^(n-1) 指数增长且带抖动", () => {
    for (let i = 0; i < 50; i++) {
      const first = backoffDelayMs(1);
      // ±20% 抖动：4000–6000ms
      expect(first).toBeGreaterThanOrEqual(4000 * 0.999);
      expect(first).toBeLessThanOrEqual(6000 * 1.001);
    }
    // 指数底：第 3 次 = 5s × 4 = 20s，抖动后落在 16–24s
    const third = backoffDelayMs(3);
    expect(third).toBeGreaterThanOrEqual(16000 * 0.999);
    expect(third).toBeLessThanOrEqual(24000 * 1.001);
  });

  it("封顶于 maxBackoffMs（抖动作用于封顶值之后，上限 ×1.2）", () => {
    expect(backoffDelayMs(10)).toBeLessThanOrEqual(60000 * 1.201);
    expect(backoffDelayMs(10, { baseMs: 1000, maxBackoffMs: 4000 })).toBeLessThanOrEqual(4800);
  });
});

describe("rateLimitDelayMs", () => {
  it("Retry-After 头优先，直接换算毫秒", () => {
    expect(rateLimitDelayMs(10, 1)).toBe(10000);
  });

  it("Retry-After 超上限返回 null（不该等，直接终态）", () => {
    expect(rateLimitDelayMs(121, 1)).toBeNull();
    expect(rateLimitDelayMs(300, 1)).toBeNull();
  });

  it("无头时回落指数退避", () => {
    const delay = rateLimitDelayMs(null, 1);
    expect(delay).not.toBeNull();
    expect(delay!).toBeGreaterThanOrEqual(4000);
    expect(delay!).toBeLessThanOrEqual(6000);
  });
});

describe("isRateLimitError / retryAfterOfError", () => {
  it("识别附着的 status 字段", () => {
    const e = Object.assign(new Error("HTTP 429: too many"), {
      status: 429,
      retryAfterSec: 7,
    });
    expect(isRateLimitError(e)).toBe(true);
    expect(retryAfterOfError(e)).toBe(7);
  });

  it("兜底匹配 HTTP 429 消息前缀", () => {
    expect(isRateLimitError(new Error("HTTP 429: quota"))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 500: boom"))).toBe(false);
    expect(isRateLimitError(new Error("x"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("429")).toBe(false);
  });

  it("retryAfterOfError 对缺失或非法值返回 null", () => {
    expect(retryAfterOfError(new Error("x"))).toBeNull();
    expect(retryAfterOfError(Object.assign(new Error("x"), { retryAfterSec: "9" }))).toBeNull();
  });
});

describe("retryAfterFromHeaders", () => {
  it("从 fetch Headers 读 Retry-After", () => {
    const headers = new Headers({ "retry-after": "12" });
    expect(retryAfterFromHeaders(headers)).toBe(12);
  });

  it("无头或非法值返回 null", () => {
    expect(retryAfterFromHeaders(new Headers())).toBeNull();
    expect(retryAfterFromHeaders(undefined)).toBeNull();
  });
});
