/**
 * connectionTest — AI 引擎配置的「测试连接」。
 *
 * WHY THIS EXISTS: 配置面板原来没有任何验证手段——三个字段填完，对错只能
 * 点翻译试错；失败时用户看到的是 HTTP 层原始错误（401/404/超时），不会
 * 联想到是自己哪里填错了。真实反馈「不知道怎么配置 AI API」里有一大部
 * 分是「不确定自己配对了没有」。
 *
 * 本模块用当前配置发一个最小请求（prompt 要求回一个词，输出预算压到
 * 64 tokens），把结果分类成用户能直接行动的种类：密钥问题、地址问题、
 * 网络不可达、限流、成功。分类依据是 openaiCompat 抛出的错误上携带的
 * HTTP status，以及 fetch 的网络层 TypeError——两者在这台机器上实测可区
 * 分（国内五家服务商 401、OpenAI 直连 TypeError）。
 *
 * 主包通过 Zotero.ZTransplit.ai.testConnection 暴露给设置面板（面板脚本
 * 在独立沙箱，无法 import 主包——与 java/odlJar 同一约定）。
 *
 * @module core/ai/connectionTest
 */

import { createOpenAICompatClient } from "./openaiCompat";
import { getString } from "../../utils/locale";

export interface AiConnectionConfig {
  apiUrl: string;
  apiKey?: string;
  model?: string;
  /**
   * Extra headers from the panel's headers textarea — the test must probe
   * exactly the configuration the user is looking at, headers included.
   */
  headers?: Record<string, string>;
}

/** 测试结果分类。kind 决定面板显示的文案与行动建议。 */
export type AiTestFailureKind =
  | "auth" // 401/403：密钥缺失或错误
  | "not-found" // 404：地址填错（多半是服务商选错或路径不对）
  | "rate-limit" // 429：限流
  | "network" //  fetch 层失败：端点不可达（需要代理或换服务商）
  | "empty" // 连通但模型没有返回内容
  | "http" // 其它 HTTP 错误
  | "invalid"; // 配置本身不完整（没有接口地址）

export interface AiTestResult {
  ok: boolean;
  /** 失败分类；ok 时为 undefined。 */
  kind?: AiTestFailureKind;
  /** 面向用户的本地化消息（含具体状态码/原因）。 */
  message: string;
  /** 成功时实际应答的模型标识（服务端返回的 model 字段）。 */
  model?: string;
  /** 成功时的耗时毫秒。 */
  ms?: number;
}

const TEST_TIMEOUT_MS = 30000;
const TEST_MAX_TOKENS = 64;

function fail(kind: AiTestFailureKind, message: string): AiTestResult {
  return { ok: false, kind, message };
}

/**
 * 用给定配置测试 AI 端点。不读偏好——参数由调用方（面板）显式传入，测的就
 * 是用户眼前表单里的值。
 */
export async function testAiConnection(
  config: AiConnectionConfig,
): Promise<AiTestResult> {
  const apiUrl = (config.apiUrl || "").trim();
  if (!apiUrl) {
    return fail("invalid", getString("ai-test-invalid"));
  }

  const client = createOpenAICompatClient({
    apiUrl,
    apiKey: (config.apiKey || "").trim() || undefined,
    defaultModel: (config.model || "").trim() || undefined,
    emptyResultErrorKey: "ai-test-empty",
    extraHeaders: config.headers,
  });

  const started = Date.now();
  try {
    const result = await client.chat({
      messages: [
        {
          role: "user",
          content:
            "Reply with the single word: OK. Do not explain, do not translate.",
        },
      ],
      maxTokens: TEST_MAX_TOKENS,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    return {
      ok: true,
      message: getString("ai-test-ok", {
        model: config.model?.trim() || getString("ai-test-server-default"),
        ms: Date.now() - started,
      }),
      model: config.model?.trim() || undefined,
      ms: Date.now() - started,
    };
  } catch (e: unknown) {
    const err = e as Error & {
      status?: number;
      emptyCompletion?: boolean;
    };
    const status = typeof err?.status === "number" ? err.status : undefined;
    // 连通但模型没返回内容：openaiCompat 给这类错误打了标记（它没有 HTTP
    // status，不打标记会和 fetch 层网络失败混为一谈）。
    if (err?.emptyCompletion) {
      return fail("empty", getString("ai-test-empty"));
    }
    if (status === 401 || status === 403) {
      return fail(
        "auth",
        getString("ai-test-auth", { detail: err.message || `HTTP ${status}` }),
      );
    }
    if (status === 404) {
      return fail(
        "not-found",
        getString("ai-test-not-found", { detail: err.message || "HTTP 404" }),
      );
    }
    if (status === 429) {
      return fail(
        "rate-limit",
        getString("ai-test-rate-limit", {
          detail: err.message || "HTTP 429",
        }),
      );
    }
    if (status !== undefined) {
      return fail(
        "http",
        getString("ai-test-http", {
          status,
          detail: err.message || `HTTP ${status}`,
        }),
      );
    }
    // 没有 status：fetch 层就失败了（DNS、连接拒绝、超时）。大陆网络下
    // api.openai.com 走的正是这条——提示换服务商或检查代理。
    const isTimeout = /timeout|aborted/i.test(err?.message || "");
    return fail(
      "network",
      isTimeout
        ? getString("ai-test-timeout", { ms: TEST_TIMEOUT_MS })
        : getString("ai-test-network", { detail: err?.message || String(e) }),
    );
  }
}
