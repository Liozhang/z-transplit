/**
 * translateError — 把原始报错改写成用户能行动的本地化文案。
 *
 * 两类使用者：
 *   - friendlyOdlError（分屏翻译管线）：先做组件与 Java 的专项判定，再把
 *     HTTP、网络、未配置三类通用判定委托到这里，保持原有判定顺序不变；
 *   - 划词面板、双语进度行、词典查询、菜单失败行：没有专项判定，直接用
 *     friendlyTranslateError / friendlyTranslateMessage 兜底。
 *
 * 此前这些位置把 toErrorMessage 的原文（"HTTP 401: {整段响应体}"）直接
 * 显示给用户，用户无从判断是密钥、网络还是服务端的问题。设置面板的
 * 「测试连接」（connectionTest）早已按状态码分类，本模块把同一套判定
 * 提升为共用实现，两处不再各自漂移。
 *
 * 原始报错只保留在 detail 里并截断，界面主体永远是原因加下一步。
 */

import { getString } from "../../utils/locale";
import { toErrorMessage } from "../../utils/error";

/** HTTP 状态码在错误文本里的形态：httpStatusError 与 openaiCompat 都这么拼。 */
const HTTP_RE = /\bHTTP\s+(\d{3})\b/;

/** 网络层失败的常见词形（fetch 的 TypeError、引擎层的超时兜底）。 */
const NETWORK_RE = /网络|網路|network|timeout|timed out|连接|連線/i;

/** 模型返回了约定 JSON 之外的内容（chatJson 的两条失败路径）。 */
const BAD_RESPONSE_RE = /returned non-json|failed schema validation/i;

/** 「未配置」类文案（多语言）与英文原始报错的词形。 */
const NOT_CONFIGURED_RE =
  /翻译未配置|翻譯未設定|未配置|not configured|no ai provider/i;

/**
 * HTTP 状态码 → 专用文案。401/403 密钥、429 限流、其余带状态码与摘要。
 * 文本里没有状态码时返回 null，调用方继续用其他判定。
 */
export function classifyHttpMessage(msg: string): string | null {
  const http = HTTP_RE.exec(msg || "");
  if (!http) return null;
  const code = Number(http[1]);
  if (code === 401 || code === 403) {
    return getString("odl-error-http-auth", { code });
  }
  if (code === 429) {
    return getString("odl-error-http-rate", { code });
  }
  return getString("odl-error-http-other", { code, detail: msg.slice(0, 100) });
}

/** 网络层失败 → 网络文案（带 100 字符摘要）。文本不匹配时返回 null。 */
export function classifyNetworkMessage(msg: string): string | null {
  if (NETWORK_RE.test(msg || "")) {
    return getString("odl-error-network", { detail: msg.slice(0, 100) });
  }
  return null;
}

/** 「未配置」类 → 配置引导文案。文本不匹配时返回 null。 */
export function classifyNotConfiguredMessage(msg: string): string | null {
  if (NOT_CONFIGURED_RE.test(msg || "")) {
    return getString("odl-error-not-configured");
  }
  return null;
}

/** 模型返回内容不合约定 → 换模型、查接口文档的引导。不匹配时返回 null。 */
export function classifyBadResponseMessage(msg: string): string | null {
  if (BAD_RESPONSE_RE.test(msg || "")) {
    return getString("translation-error-ai-bad-response");
  }
  return null;
}

/**
 * 把一段报错文本改写成用户能行动的形态。输入若已经是限流的两种专门文案
 * 之一，原样返回——重新改写会把「等太久」这类细节抹平成笼统的限流提示。
 */
export function friendlyTranslateMessage(msg: string): string {
  const text = msg || "";
  if (
    text === getString("translation-error-rate-limited") ||
    text === getString("translation-error-rate-limited-wait-too-long")
  ) {
    return text;
  }
  const classified =
    classifyHttpMessage(text) ??
    classifyBadResponseMessage(text) ??
    classifyNetworkMessage(text) ??
    classifyNotConfiguredMessage(text);
  if (classified) return classified;
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

/**
 * 把抛出的错误对象改写成用户能行动的文案。空补全（模型把输出预算耗尽在
 * 思考阶段）带着 emptyCompletion 标记，是可自愈的一类，直接给出对应指引。
 */
export function friendlyTranslateError(e: unknown): string {
  const marked = e as { emptyCompletion?: boolean } | null;
  if (marked && marked.emptyCompletion) {
    return getString("pane-translate-error-empty");
  }
  return friendlyTranslateMessage(toErrorMessage(e));
}
