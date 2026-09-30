/**
 * rateLimit — HTTP 429 限流的共享退避原语（自 leadero 的 src/utils/rateLimit.ts
 * 移植，按本仓库的调用面裁剪）。
 *
 * 背景：DeepL 免费版（每月 50 万字符、并发受限）与 AI 端点的 429 此前以原始
 * 形态冒泡为翻译失败，而批量全文翻译（数十段并发）恰是最容易触发限流的调用
 * 模式。本模块提供三件纯函数原语，供引擎层接入：
 *
 *   1. parseRetryAfterSec — 解析 Retry-After 响应头（只认整数秒；HTTP 日期
 *      形态不解析，返回 null 走指数退避兜底，不做时区算术）。
 *   2. rateLimitDelayMs — 计算退避时长：Retry-After 优先（超过上限返回
 *      null，语义是「对方要求等太久，直接终态」），无头时按 5 秒 × 2^(n-1)
 *      指数退避并带 ±20% 抖动（防止并发段齐射重试）。
 *   3. isRateLimitError — 判定一个错误是否为 429（优先看附着的 status 字段，
 *      兜底匹配 httpPost 系列的「HTTP 429: …」消息形态）。
 *
 * 纯函数、零依赖：不 import Zotero 相关模块，单元测试直接覆盖。
 *
 * @module utils/rateLimit
 */

export interface RateLimitDelayOptions {
  /**
   * Retry-After 超过此秒数视为「等待过久」，返回 null 让调用方直接终态。
   * 翻译路径取 120 秒：单段翻译的超时预算在 10–120 秒量级，等更久的重试
   * 已无意义。
   */
  maxRetryAfterSec?: number;
  /** 指数退避基准毫秒数（第 n 次重试 = base × 2^(n-1)）。 */
  baseMs?: number;
  /** 指数退避上限毫秒数。 */
  maxBackoffMs?: number;
}

/**
 * 解析 Retry-After 头的值（秒）。只接受正整数秒；HTTP 日期形态与小数
 * 一律返回 null，由调用方走指数退避兜底。
 */
export function parseRetryAfterSec(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const sec = parseInt(trimmed, 10);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/**
 * 纯指数退避（不含 Retry-After 语义）：
 * min(maxBackoffMs, baseMs × 2^max(0, n-1)) 再乘 ±20% 抖动。
 */
export function backoffDelayMs(
  attempt: number,
  options: Pick<RateLimitDelayOptions, "baseMs" | "maxBackoffMs"> = {},
): number {
  const baseMs = options.baseMs ?? 5000;
  const maxBackoffMs = options.maxBackoffMs ?? 60000;
  const raw = Math.min(maxBackoffMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return raw * (0.8 + Math.random() * 0.4);
}

/**
 * 计算一次限流后的等待时长。
 * 返回 null 表示「不该等」（Retry-After 超过上限）——调用方应把 429 作为
 * 终态处理，而不是把几分钟的等待塞进一次段落翻译。
 */
export function rateLimitDelayMs(
  retryAfterSec: number | null,
  attempt: number,
  options: RateLimitDelayOptions = {},
): number | null {
  const maxRetryAfterSec = options.maxRetryAfterSec ?? 120;
  if (retryAfterSec != null) {
    if (retryAfterSec > maxRetryAfterSec) return null;
    return retryAfterSec * 1000;
  }
  return backoffDelayMs(attempt, options);
}

/** 从 fetch 的 Headers 里取出 Retry-After 秒数（无该头返回 null）。 */
export function retryAfterFromHeaders(headers: Headers | undefined): number | null {
  try {
    return parseRetryAfterSec(headers?.get("retry-after"));
  } catch {
    return null;
  }
}

/**
 * 判定错误是否为 429。优先读 httpPost 系列与 openaiCompat 附着的
 * `status` 字段；兜底匹配「HTTP 429」消息前缀（覆盖未附着 status 的旧
 * 错误形态）。
 */
export function isRateLimitError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if ((e as { status?: unknown }).status === 429) return true;
  return e instanceof Error && /^HTTP 429[:\s]/.test(e.message);
}

/** 读取错误上附着的 Retry-After 秒数（无则 null）。 */
export function retryAfterOfError(e: unknown): number | null {
  const v = (e as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
