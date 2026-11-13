/**
 * youdaoTranslate — Youdao translation: the signing/encoding contract and the
 * two request shapes, as pure functions.
 *
 * Two services, mirroring the bing / bing-web split in translationEngines.ts:
 *
 *   - 智云文本翻译 (official): GET https://openapi.youdao.com/api with a
 *     signType=v3 signature. Requires an app id + secret from the Youdao
 *     console; the free tier covers ordinary use. Contract is documented and
 *     stable, so a failure is diagnosable (the API answers with an errorCode).
 *   - 免密钥 demo 端点: POST https://aidemo.youdao.com/trans with a form body.
 *     This is a reverse-engineered endpoint behind fanyi.youdao.com — same
 *     risk class as the keyless Bing web endpoint: it can change or vanish
 *     without notice. The contract here is therefore one-way: resolve to a
 *     translation on success, to an error on ANY shape mismatch. The caller
 *     reports that error; it never substitutes another provider.
 *
 * Only the PURE parts live here (language mapping, query truncation, the
 * signature input, the request shapes, the error-code classification). The
 * fetch calls live in translationEngines.ts next to the other engines, which
 * owns the private HTTP helpers — so this module is unit-testable with no
 * network and no Zotero global.
 *
 * Reference: windingwind/zotero-pdf-translate src/modules/services/
 * youdaozhiyun.ts (signature + params) and youdao.ts (keyless form body),
 * cross-checked against the Youdao 智云 error-code table.
 *
 * @module core/translation/youdaoTranslate
 */

import { sha256HexOfString } from "../../utils/hash";

/** Official 智云 text-translation endpoint (signType=v3). */
export const YOUDAO_ZHIYUN_ENDPOINT = "https://openapi.youdao.com/api";

/** Keyless demo endpoint behind fanyi.youdao.com (reverse-engineered). */
export const YOUDAO_WEB_ENDPOINT = "https://aidemo.youdao.com/trans";

/**
 * Translation domains the official API accepts. Only honoured when the app has
 * the domain translation product enabled; otherwise the API ignores it.
 */
export const YOUDAO_DOMAINS = [
  "general",
  "computers",
  "medicine",
  "finance",
  "game",
] as const;

export type YoudaoDomain = (typeof YOUDAO_DOMAINS)[number];

/** Default domain when the preference is empty or unrecognized. */
export const YOUDAO_DEFAULT_DOMAIN: YoudaoDomain = "general";

/** Youdao's language codes differ from BCP-47 only for Chinese. */
const YOUDAO_LANG_MAP: Record<string, string> = {
  "zh-CN": "zh-CHS",
  "zh-TW": "zh-CHT",
  "zh-HK": "zh-CHT",
  "zh-MO": "zh-CHT",
};

/**
 * Map a Zotero locale code to a Youdao language code. Chinese keeps its
 * script distinction (zh-CHS / zh-CHT); everything else takes the primary
 * subtag, which is already what Youdao uses ("en", "ja", "fr", …).
 */
export function toYoudaoLang(code: string | undefined): string {
  const c = String(code ?? "").trim();
  if (!c) return "";
  return YOUDAO_LANG_MAP[c] ?? c.split("-")[0];
}

/**
 * The signature input rule: q itself when it is short, otherwise its first 10
 * characters + its length + its last 10. (Length is in UTF-16 code units, the
 * same unit `String.prototype.length` reports — that is what the server
 * expects, since the rule is defined on the JS string.)
 */
export function truncateYoudaoQuery(q: string): string {
  const len = q.length;
  if (len <= 20) return q;
  return q.substring(0, 10) + len + q.substring(len - 10, len);
}

/**
 * RFC 5987-style encoding for the `q` query parameter. encodeURIComponent
 * already covers everything the server needs except `'()*` and the space
 * form; the reference implementation escapes those explicitly, so we do too.
 */
export function encodeYoudaoQuery(q: string): string {
  return encodeURIComponent(q)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
    .replace(/%20/g, "+");
}

export interface YoudaoSignatureParams {
  /** Application id (有道智云控制台的应用 ID). */
  appKey: string;
  /** Application secret (应用密钥). */
  appSecret: string;
  /** The text being translated — the raw query, NOT the truncated form. */
  query: string;
  /** Random salt (any non-repeating value; ms timestamp in production). */
  salt: string;
  /** Current UNIX time in SECONDS. */
  curtime: string;
}

/**
 * The exact string the signature covers: appKey + truncate(q) + salt + curtime
 * + appSecret. Exported so a test can pin the concatenation without going
 * through the digest.
 */
export function youdaoSignatureInput(p: YoudaoSignatureParams): string {
  return (
    p.appKey + truncateYoudaoQuery(p.query) + p.salt + p.curtime + p.appSecret
  );
}

/**
 * Lowercase hex SHA-256 of the signature input, or null when this host offers
 * no WebCrypto (see utils/hash.ts). A null result MUST abort the request: an
 * unsigned or wrongly signed call is rejected by the server with an opaque
 * error, which is worse than telling the user the host cannot sign.
 */
export async function buildYoudaoSignature(
  p: YoudaoSignatureParams,
): Promise<string | null> {
  return sha256HexOfString(youdaoSignatureInput(p));
}

export interface YoudaoZhiyunRequest {
  appKey: string;
  appSecret: string;
  /** Optional glossary id (术语库 ID); omitted from the request when empty. */
  vocabId?: string;
  /** Translation domain; omitted when empty or unrecognized. */
  domain?: string;
  query: string;
  from: string;
  to: string;
  salt: string;
  curtime: string;
  /** Lowercase hex SHA-256 of youdaoSignatureInput(). */
  sign: string;
}

/**
 * Build the official endpoint URL with every parameter in the documented
 * order. Empty vocabId / unrecognized domain are left out entirely rather than
 * sent as empty values (the API treats an empty vocabId as an error).
 */
export function buildZhiyunUrl(req: YoudaoZhiyunRequest): string {
  const params: [string, string][] = [
    ["q", encodeYoudaoQuery(req.query)],
    ["appKey", req.appKey],
    ["salt", req.salt],
    ["from", req.from],
    ["to", req.to],
    ["sign", req.sign],
    ["signType", "v3"],
    ["curtime", req.curtime],
  ];
  if (req.vocabId) params.push(["vocabId", req.vocabId]);
  if (req.domain && (YOUDAO_DOMAINS as readonly string[]).includes(req.domain)) {
    params.push(["domain", req.domain]);
  }
  const search = params
    .map(([k, v]) => `${k}=${encodeQueryValue(v)}`)
    .join("&");
  return `${YOUDAO_ZHIYUN_ENDPOINT}?${search}`;
}

/**
 * Query-value encoder for everything except `q`: the same RFC 5987 escaping
 * without the space→`+` rewrite (that one is `q`-specific, matching the
 * reference implementation's treatment of the text parameter).
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The keyless endpoint's form body — three fields, no credentials. */
export function buildWebFormParams(params: {
  from: string;
  to: string;
  query: string;
}): URLSearchParams {
  return new URLSearchParams({
    from: params.from,
    to: params.to,
    q: params.query,
  });
}

/**
 * The throttle (rate-limit) message id, which carries the raw code.
 *
 * 411 / 412 are the documented codes (访问频率受限 / 长请求过于频繁). 471 is
 * NOT in any Youdao error table — it was observed live (2026-11, batch
 * translation of a 361-paragraph document: 6 segments OK, then a wall of
 * failures) and matches the same pattern the demo endpoint reproducibly
 * returns as 411, so it is classified as a throttle variant. Keeping the raw
 * code in the message means an undocumented code can never be silently
 * relabelled.
 */
export const YOUDAO_RATE_LIMIT_ERROR_KEY = "translation-error-youdao-rate-limited";

/** Whether an API errorCode means the endpoint is throttling this client. */
export function isYoudaoThrottleCode(errorCode: string | number): boolean {
  switch (String(errorCode)) {
    case "411":
    case "412":
    case "471":
      return true;
    default:
      return false;
  }
}

/**
 * Fluent message id for an API errorCode, or null when the code is unknown.
 *
 * Only the codes a misconfiguration actually produces are mapped — the rest
 * fall through to the generic message that carries the raw code, so nothing is
 * silently swallowed.
 */
export function youdaoErrorKey(errorCode: string | number): string | null {
  if (isYoudaoThrottleCode(errorCode)) return YOUDAO_RATE_LIMIT_ERROR_KEY;
  switch (String(errorCode)) {
    case "108":
      return "translation-error-youdao-code-108";
    case "110":
      return "translation-error-youdao-code-110";
    case "202":
      return "translation-error-youdao-code-202";
    case "206":
      return "translation-error-youdao-code-206";
    default:
      return null;
  }
}

/** The generic (unknown-code) message id, which carries the raw code. */
export const YOUDAO_GENERIC_ERROR_KEY = "translation-error-youdao-code-other";

/**
 * Normalize a domain preference value: anything unrecognized becomes the
 * default, so a typo in about:config cannot produce an API rejection.
 */
export function normalizeYoudaoDomain(value: string | undefined): YoudaoDomain {
  const v = String(value ?? "").trim();
  return (YOUDAO_DOMAINS as readonly string[]).includes(v)
    ? (v as YoudaoDomain)
    : YOUDAO_DEFAULT_DOMAIN;
}
