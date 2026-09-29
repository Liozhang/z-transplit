/**
 * translationEngines — Unified translation engine dispatcher.
 *
 * Supports six engine types:
 *   - "ai"      → OpenAI-compatible chat-completions endpoint driven by a
 *                 user-owned, validated prompt template (translate.ai.*) via
 *                 src/core/translation/promptTemplate.ts. This is the port of
 *                 leadero's "ai" engine: unlike "custom" below it substitutes
 *                 the source/target language into the prompt and refuses to
 *                 translate while the template is invalid.
 *   - "google"  → Google Translate HTTP API (default; free endpoint or Cloud
 *                 Translation; falls back to keyless Bing web on failure)
 *   - "custom"  → OpenAI-compatible chat-completions endpoint with a fixed
 *                 formula-preserving prompt (translate.custom.apiUrl/apiKey/
 *                 model) via src/core/ai/openaiCompat.ts. Also the only engine
 *                 with batch JSON ability — see supportsBatching().
 *   - "bing"    → Azure Cognitive Services Translator
 *   - "deepl"   → DeepL API
 *   - "zotero-pdf-translate" → external plugin bridge
 *
 * All engines return the same signature:
 *   { success: true, translatedText: string } or { success: false, error: string }
 *
 * Formula placeholder preservation ({v0}, {v1}, …) is guaranteed only for the
 * model-backed engines ("ai" and "custom"), because they receive an explicit
 * prompt. Traditional MT APIs have no prompt mechanism, so callers that need
 * formula safety must stay on one of those two.
 *
 * Ported from leadero's src/core/translation/translationEngines.ts: leadero's
 * ModelRouter/AIProviderRegistry coupling is replaced by the local
 * OpenAI-compatible client (twice over — once per model-backed engine), and
 * every leadero-specific dependency (utils/defaults, react locale wrapper) is
 * swapped for z-transplit's own src/utils/* helpers.
 */

import { z } from "zod";
import type {
  BatchTranslateResult,
  BatchTranslator,
  BatchTranslatorHandle,
  ParagraphTranslator,
} from "./types";
import { createOpenAICompatClient } from "../ai/openaiCompat";
import { getPrefDynamic } from "../../utils/prefs";
import { parseJsonFromMarkdown } from "../../utils/json";
import { toErrorMessage } from "../../utils/error";
import { getString } from "../../utils/locale";
import { abortSignalTimeout } from "../../utils/abort";
import { getLanguageName } from "../tool/language";
import { batchJsonPrompt, formulaPreservingPrompt, sanitizeTranslations } from "./prompts";
import {
  promptFingerprint,
  renderPrompt,
  resolvePromptTemplate,
  validatePromptTemplate,
} from "./promptTemplate";

export type TranslationEngineType =
  | "ai"
  | "google"
  | "bing"
  | "deepl"
  | "custom"
  | "zotero-pdf-translate";

/**
 * Default engine. Must stay in lockstep with the `translate.engineType` default
 * declared in addon/prefs.js (z-transplit has no src/utils/defaults.ts — prefs.js
 * is the single source of truth for pref defaults).
 */
const DEFAULT_TRANSLATE_ENGINE_TYPE: TranslationEngineType = "google";

export interface GoogleTranslateOptions {
  apiKey?: string;
}

export interface BingTranslateOptions {
  apiKey: string;
  region: string;
}

export interface DeepLTranslateOptions {
  apiKey: string;
  useFreeEndpoint?: boolean;
}

export interface CustomTranslateOptions {
  apiUrl: string;
  apiKey?: string;
  model?: string;
}

export interface AITranslateOptions {
  apiUrl: string;
  /** Optional: local gateways (Ollama, LM Studio) usually need no key. */
  apiKey?: string;
  model?: string;
  /** Raw prompt template from prefs; "" = built-in default template. */
  prompt?: string;
}

/**
 * Map Zotero locale codes to ISO-639-1 codes used by translation APIs.
 */
function toApiSourceLang(code?: string): string {
  if (!code) return "auto";
  // Zotero uses zh-CN / zh-TW / en-US etc. Strip region for most APIs.
  const base = code.split("-")[0];
  if (base === "zh") return code; // keep zh-CN vs zh-TW distinction
  return base;
}

function toApiTargetLang(code: string): string {
  const base = code.split("-")[0];
  if (code.startsWith("zh")) return code; // keep zh-CN / zh-TW
  if (code.startsWith("pt")) return code; // pt-BR / pt-PT
  return base;
}

/**
 * DeepL-specific target language mapping.
 * DeepL expects uppercase without region for zh-CN (ZH), but keeps zh-TW.
 */
function toDeepLTargetLang(code: string): string {
  if (code === "zh-CN") return "ZH";
  if (code === "zh-TW") return "ZH-TW";
  return toApiTargetLang(code).toUpperCase();
}

/**
 * Timeout used for the keyless HTTP endpoints (Google free endpoint, Bing web).
 * A blocked/unreachable endpoint (e.g. Google in mainland China) must fail fast
 * so the fallback chain can take over instead of hanging on the OS network
 * timeout (~60-120s per paragraph).
 */
const KEYLESS_ENDPOINT_TIMEOUT_MS = 10000;

/**
 * Per-request timeout for the model-backed engines ("ai"). Generous compared to
 * the MT endpoints above because a chat completion of a long paragraph takes
 * far longer than a translate call, and the failure mode without it is a
 * request hanging on the OS network timeout (~60-120s) per paragraph.
 * leadero's MT helper omitted the timeout entirely (a latent bug); the port
 * passes one.
 */
const AI_ENDPOINT_TIMEOUT_MS = 120000;

/**
 * Floor for the model-backed engines' output budget. Reasoning-style models
 * spend completion tokens on hidden thinking before any visible text, so a
 * purely length-derived cap empties the budget mid-reasoning and returns no
 * content at all (observed on StepFun step-3.7-flash: a 37-char selection with
 * the length-derived cap came back finish_reason=length, content=""; 2048
 * returned the translation). 2048 matches the smallest budget observed to
 * clear reasoning and still leave room for the answer.
 */
const MODEL_OUTPUT_FLOOR_TOKENS = 2048;

async function httpPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs?: number,
): Promise<Response> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body,
    signal: timeoutMs ? abortSignalTimeout(timeoutMs) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
  }
  return resp;
}

async function httpPostForm(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams,
  timeoutMs?: number,
): Promise<Response> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: body.toString(),
    signal: timeoutMs ? abortSignalTimeout(timeoutMs) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
  }
  return resp;
}

async function httpGet(url: string, timeoutMs?: number): Promise<Response> {
  const resp = await fetch(url, {
    signal: timeoutMs ? abortSignalTimeout(timeoutMs) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
  }
  return resp;
}

/**
 * Google Translate.
 *
 * If apiKey is provided, uses Cloud Translation API v2:
 *   POST https://translation.googleapis.com/language/translate/v2
 *
 * Otherwise falls back to the undocumented free endpoint:
 *   GET https://translate.googleapis.com/translate_a/single?client=gtx&...
 *
 * The free endpoint has rate limits (~5k chars/day) and may break without notice,
 * but requires zero configuration and is useful as a quick fallback.
 */
async function translateWithGoogle(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
  opts: GoogleTranslateOptions = {},
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  const src = toApiSourceLang(sourceLanguage);
  const tgt = toApiTargetLang(targetLanguage);

  try {
    if (opts.apiKey) {
      // Cloud Translation API v2 (paid, requires API key)
      const body = JSON.stringify({
        q: text,
        source: src === "auto" ? undefined : src,
        target: tgt,
        format: "text",
      });
      const resp = await httpPost(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(opts.apiKey)}`,
        {},
        body,
        KEYLESS_ENDPOINT_TIMEOUT_MS,
      );
      const data = (await resp.json()) as any;
      const translated = data?.data?.translations?.[0]?.translatedText;
      if (!translated)
        throw new Error(getString("translation-error-google-empty"));
      return { success: true, translatedText: translated };
    } else {
      // Free undocumented endpoint (no key required)
      const url =
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=` +
        encodeURIComponent(src) +
        `&tl=` +
        encodeURIComponent(tgt) +
        `&dt=t&q=` +
        encodeURIComponent(text);
      const resp = await httpGet(url, KEYLESS_ENDPOINT_TIMEOUT_MS);
      const data = (await resp.json()) as any;
      // Response shape: [[["translated","original",...]],null,"srcLang"]
      const sentences = data?.[0] ?? [];
      const translated = sentences.map((s: any) => s?.[0] ?? "").join("");
      if (!translated)
        throw new Error(getString("translation-error-google-empty"));
      return { success: true, translatedText: translated };
    }
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Bing / Azure Cognitive Services Translator.
 *
 * Requires apiKey (Azure subscription key) and region (e.g. "global", "eastasia").
 * Docs: https://learn.microsoft.com/en-us/azure/cognitive-services/translator/
 */
async function translateWithBing(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
  opts: BingTranslateOptions = { apiKey: "", region: "global" },
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  const src = toApiSourceLang(sourceLanguage);
  const tgt = toApiTargetLang(targetLanguage);

  try {
    const body = JSON.stringify([{ Text: text }]);
    const url =
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=` +
      encodeURIComponent(src === "auto" ? "" : src) +
      `&to=` +
      encodeURIComponent(tgt);
    const resp = await httpPost(
      url,
      {
        "Ocp-Apim-Subscription-Key": opts.apiKey,
        "Ocp-Apim-Subscription-Region": opts.region,
      },
      body,
    );
    const data = (await resp.json()) as any;
    const translated = data?.[0]?.translations?.[0]?.text;
    if (!translated) throw new Error(getString("translation-error-bing-empty"));
    return { success: true, translatedText: translated };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Keyless Bing web translator (the Bing Translator web app endpoint, same
 * engine behind bing.com/translator). Reachable in regions where Google is not
 * (e.g. mainland China), which is why it backs the default Google engine. Not
 * exposed as a selectable engine — it only serves as fallback.
 *
 * Request shape reverse-engineered from the live page (2026-08-29):
 *   GET  https://www.bing.com/translator            (redirects to cn.bing.com in CN)
 *     → _G.IG page token, params_AbusePreventionHelper [key, token, expiryMs],
 *       container data-iid
 *   POST {origin}/ttranslatev3?isVertical=1&IG=…&IID=…&SFX=<counter>
 *        &token=…&key=…                              (auth params in the QUERY STRING)
 *     body: fromLang&to&text (form-urlencoded)
 *
 * Cookies are intentionally NOT forwarded manually — in Zotero the fetch goes
 * through the Firefox network stack, which keeps the bing.com cookie jar alive
 * between the token-page GET and the translate POST on its own.
 */

interface BingWebSession {
  origin: string;
  ig: string;
  iid: string;
  key: string;
  token: string;
  expiresAt: number;
  sfx: number;
}

let bingWebSession: BingWebSession | null = null;

/** Drop the cached Bing web session (tests; also correct after long suspend). */
export function resetBingWebSession(): void {
  bingWebSession = null;
}

/** Map Zotero locale codes to Bing web language ids (zh-CN → zh-Hans etc.). */
function toBingWebLang(code: string): string {
  // The live ttranslatev3 endpoint rejects fromLang=auto with
  // {"statusCode":400}; auto-detection must ask for "auto-detect" (verified
  // against cn.bing.com on 2026-09-24 — mocked tests can't see server-side
  // contract changes).
  if (!code || code === "auto") return "auto-detect";
  if (code === "zh-CN") return "zh-Hans";
  if (code === "zh-TW" || code === "zh-HK") return "zh-Hant";
  return code.split("-")[0];
}

async function fetchBingWebSession(): Promise<BingWebSession> {
  if (bingWebSession && Date.now() < bingWebSession.expiresAt) {
    return bingWebSession;
  }
  const resp = await httpGet(
    "https://www.bing.com/translator",
    KEYLESS_ENDPOINT_TIMEOUT_MS,
  );
  const html = await resp.text();
  const ig = html.match(/IG:"([A-Fa-f0-9]{16,})"/)?.[1] || "";
  const abuse = html.match(
    /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/,
  );
  const iid =
    html.match(/id="rich_tta"\s+data-iid="(translator\.\d+)"/)?.[1] ||
    "translator.5023";
  if (!ig || !abuse) {
    throw new Error(getString("translation-error-bing-token-unavailable"));
  }
  const [, key, token, expiresMs] = abuse;
  bingWebSession = {
    // www.bing.com redirects to cn.bing.com in CN — POST to the final origin.
    origin: new URL(resp?.url || "https://www.bing.com").origin,
    ig,
    iid,
    key,
    token,
    // Refresh a minute ahead of the server-reported expiry (typically 1h).
    expiresAt: Date.now() + Math.max(60000, Number(expiresMs) - 60000),
    sfx: 0,
  };
  return bingWebSession;
}

async function postBingWebTranslate(
  text: string,
  targetLanguage: string,
  sourceLanguage: string,
  session: BingWebSession,
): Promise<{
  success: boolean;
  translatedText?: string;
  error?: string;
  tokenRejected?: boolean;
}> {
  try {
    // SFX is a per-session request counter on the live page (ei++).
    const sfx = session.sfx++;
    const url =
      `${session.origin}/ttranslatev3?isVertical=1` +
      `&IG=${encodeURIComponent(session.ig)}` +
      `&IID=${encodeURIComponent(session.iid)}` +
      `&SFX=${sfx}` +
      `&token=${encodeURIComponent(session.token)}` +
      `&key=${encodeURIComponent(session.key)}`;
    const body = new URLSearchParams({
      fromLang: toBingWebLang(sourceLanguage),
      to: toBingWebLang(targetLanguage),
      text,
      tryFetchingGenderDebiasedTranslations: "false",
    });
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${session.origin}/translator`,
      },
      body: body.toString(),
      signal: abortSignalTimeout(KEYLESS_ENDPOINT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return {
        success: false,
        error: `HTTP ${resp.status}: ${resp.statusText}`,
        tokenRejected: resp.status === 401 || resp.status === 403,
      };
    }
    const data = (await resp.json()) as any;
    // Two observed shapes: [{ translations: [...] }] and [[{ translations: [...] }]].
    // Bing rejection (e.g. stale token): { statusCode: 400, errorMessage: "" }.
    const entry = Array.isArray(data?.[0])
      ? data[0].find((x: any) => x?.translations)
      : data?.[0];
    const translated = entry?.translations?.[0]?.text;
    if (!translated) {
      return {
        success: false,
        error:
          typeof data?.errorMessage === "string" && data.errorMessage
            ? getString("translation-error-bing-rejected", {
                status: String(data.statusCode ?? 400),
              })
            : getString("translation-error-bing-empty"),
        tokenRejected: true,
      };
    }
    return { success: true, translatedText: translated };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

async function translateWithBingWeb(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  const src = toApiSourceLang(sourceLanguage);
  try {
    let result = await postBingWebTranslate(
      text,
      targetLanguage,
      src,
      await fetchBingWebSession(),
    );
    if (!result.success && result.tokenRejected) {
      // Stale/invalid session — refetch the token page once and retry.
      bingWebSession = null;
      result = await postBingWebTranslate(
        text,
        targetLanguage,
        src,
        await fetchBingWebSession(),
      );
    }
    if (!result.success) {
      return {
        success: false,
        error: result.error || getString("translation-error-bing-failed"),
      };
    }
    return { success: true, translatedText: result.translatedText };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * DeepL API.
 *
 * Requires apiKey (Auth Key from DeepL Pro/Free plan).
 * - Free tier: https://api-free.deepl.com/v2/translate
 * - Pro tier:   https://api.deepl.com/v2/translate
 *
 * Docs: https://developers.deepl.com/docs
 */
async function translateWithDeepL(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
  opts: DeepLTranslateOptions = { apiKey: "" },
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  const src = toApiSourceLang(sourceLanguage);
  const tgt = toDeepLTargetLang(targetLanguage);

  try {
    const host = opts.useFreeEndpoint ? "api-free.deepl.com" : "api.deepl.com";
    const params = new URLSearchParams();
    params.set("target_lang", tgt);
    if (src !== "auto")
      params.set("source_lang", toApiTargetLang(src).toUpperCase());
    params.set("text", text);

    const resp = await httpPostForm(
      `https://${host}/v2/translate`,
      { Authorization: `DeepL-Auth-Key ${opts.apiKey}` },
      params,
    );
    const data = (await resp.json()) as any;
    const translated = data?.translations?.[0]?.text;
    if (!translated)
      throw new Error(getString("translation-error-deepl-empty"));
    return { success: true, translatedText: translated };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Model-backed translation ("ai" engine) — the port of leadero's "ai" engine
 * onto z-transplit's own OpenAI-compatible client.
 *
 * The prompt is not hard-coded: it comes from the user's template
 * (translate.ai.prompt, "" = built-in default) with the language pair and the
 * text substituted into it. The template is validated first and a rejected
 * template fails the request with the exact reason instead of sending a
 * half-broken prompt to the model.
 *
 * The rendered template is the whole user message — the template owns where
 * the text goes, so a separate system message would either bypass it or send
 * the text twice.
 */
async function translateWithAI(
  text: string,
  targetLanguage: string,
  sourceLanguage: string | undefined,
  opts: AITranslateOptions,
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  // Language descriptors are resolved here (not in the template) so the user
  // writes "{{sourceLang}}" and the plugin decides it means "Simplified Chinese".
  const targetDesc = getLanguageName(targetLanguage);
  const sourceDesc = sourceLanguage
    ? getLanguageName(sourceLanguage)
    : "auto-detect";

  const check = validatePromptTemplate(opts.prompt);
  if (!check.ok) {
    return {
      success: false,
      error: getString(`translation-error-ai-prompt-${check.reason}`),
    };
  }

  try {
    const client = createOpenAICompatClient({
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      defaultModel: opts.model,
      emptyResultErrorKey: "translation-error-ai-empty",
    });

    const result = await client.chat({
      messages: [
        {
          role: "user",
          content: renderPrompt(check.template, {
            text,
            sourceLang: sourceDesc,
            targetLang: targetDesc,
          }),
        },
      ],
      maxTokens: Math.max(MODEL_OUTPUT_FLOOR_TOKENS, Math.min(text.length * 2, 4000)),
      temperature: 0.3,
      timeoutMs: AI_ENDPOINT_TIMEOUT_MS,
    });

    return { success: true, translatedText: result.content };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Custom OpenAI-compatible endpoint.
 *
 * Sends a chat completion with the formula-preserving system prompt (see
 * src/core/translation/prompts.ts) through the shared OpenAI-compatible client.
 * Useful for self-hosted models (Ollama, LM Studio, vLLM, etc.) or any
 * OpenAI-compatible API — this is also the only engine with batch JSON ability.
 */
async function translateWithCustom(
  text: string,
  targetLanguage: string,
  sourceLanguage: string | undefined,
  opts: CustomTranslateOptions,
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  const targetDesc = getLanguageName(targetLanguage);
  const sourceDesc = sourceLanguage
    ? getLanguageName(sourceLanguage)
    : "auto-detect";

  try {
    const client = createOpenAICompatClient({
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      defaultModel: opts.model,
    });

    const result = await client.chat({
      messages: [
        {
          role: "system",
          content: formulaPreservingPrompt(targetDesc, sourceDesc),
        },
        { role: "user", content: text },
      ],
      maxTokens: Math.max(MODEL_OUTPUT_FLOOR_TOKENS, Math.min(text.length * 2, 4000)),
      temperature: 0.3,
    });

    return { success: true, translatedText: result.content };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

/**
 * Zotero PDF Translate plugin bridge.
 *
 * Delegates translation to the external zotero-pdf-translate plugin via its
 * public API: `Zotero.PDFTranslate.api.translate(raw, options)`.
 * The call returns a TranslateTask whose `result` is already populated
 * because the API awaits `runTranslationTask` internally.
 */
async function translateWithZoteroPdfTranslate(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
): Promise<{ success: boolean; translatedText?: string; error?: string }> {
  try {
    const api =
      typeof Zotero === "undefined"
        ? undefined
        : (Zotero as any)?.PDFTranslate?.api;
    if (!api?.translate) {
      return {
        success: false,
        error: getString("translation-error-pdf-translate-missing"),
      };
    }

    const task = await api.translate(text, {
      pluginID: "ztransplit@zotero.org",
      langfrom: sourceLanguage,
      langto: targetLanguage,
    });

    if (task.status === "success" && task.result) {
      return { success: true, translatedText: task.result };
    }

    return {
      success: false,
      error: task.result || getString("translation-error-pdf-translate-failed"),
    };
  } catch (e: any) {
    return { success: false, error: toErrorMessage(e) };
  }
}

export interface EngineConfig {
  engineType: TranslationEngineType;
  googleApiKey?: string;
  bingApiKey?: string;
  bingRegion?: string;
  deeplApiKey?: string;
  deeplUseFree?: boolean;
  customApiUrl?: string;
  customApiKey?: string;
  customModel?: string;
  aiApiUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  /** Raw prompt template ("" = built-in default). */
  aiPrompt?: string;
}

/**
 * Read the current engine config from dynamic prefs.
 */
export function getEngineConfig(): EngineConfig {
  const get = (key: string, fallback?: string) => {
    const v = getPrefDynamic(key);
    return v !== undefined && v !== null ? String(v) : fallback;
  };

  return {
    engineType:
      (get("translate.engineType") as TranslationEngineType) ||
      DEFAULT_TRANSLATE_ENGINE_TYPE,
    googleApiKey: get("translate.google.apiKey") || undefined,
    bingApiKey: get("translate.bing.apiKey") || undefined,
    bingRegion: get("translate.bing.region") || "global",
    deeplApiKey: get("translate.deepl.apiKey") || undefined,
    deeplUseFree: get("translate.deepl.useFree") === "true",
    customApiUrl: get("translate.custom.apiUrl") || undefined,
    customApiKey: get("translate.custom.apiKey") || undefined,
    // Empty string = no model override: openaiCompat omits the wire `model`
    // field so the server picks its default, as the preferences pane promises.
    customModel: get("translate.custom.model") || "",
    aiApiUrl: get("translate.ai.apiUrl") || undefined,
    aiApiKey: get("translate.ai.apiKey") || undefined,
    // Same "empty = server default" contract as customModel above.
    aiModel: get("translate.ai.model") || "",
    aiPrompt: get("translate.ai.prompt") || "",
  };
}

/**
 * Stable fingerprint of the engine configuration for the persistent translation
 * cache (translationCache.ts). Two runs with the same identity are assumed to
 * produce interchangeable translations, so cached paragraphs are reused.
 * Credentials only enter as a short fingerprint (never the full secret).
 *
 * The "ai" engine additionally fingerprints its prompt template: the template
 * *is* the engine's behaviour, so editing it must invalidate cached paragraphs
 * (a cached Google paragraph is interchangeable with another Google paragraph;
 * a cached paragraph from prompt A is not one from prompt B).
 */
export function engineCacheIdentity(): string {
  const cfg = getEngineConfig();
  const parts: string[] = [cfg.engineType];
  if (cfg.engineType === "ai") {
    parts.push(
      cfg.aiModel || "",
      cfg.aiApiUrl || "",
      (cfg.aiApiKey || "").slice(-6),
      promptFingerprint(resolvePromptTemplate(cfg.aiPrompt)),
    );
  } else if (cfg.engineType === "custom") {
    parts.push(cfg.customModel || "", cfg.customApiUrl || "", (cfg.customApiKey || "").slice(-6));
  } else if (cfg.engineType === "google") {
    parts.push(cfg.googleApiKey ? "keyed" : "keyless");
  } else if (cfg.engineType === "deepl") {
    parts.push(cfg.deeplUseFree ? "free" : "pro");
  }
  return parts.join("|");
}

/** In-memory LRU cache for translation results.
 *  Eliminates repeat API calls for the same text + language + engine combo.
 *  Session-scoped (not persisted) — translations are cheap to redo on restart. */
const TRANSLATION_CACHE = new Map<string, string>();
const TRANSLATION_CACHE_MAX = 500;

/** Clear the translation cache (e.g. when engine settings change). */
export function clearTranslationCache(): void {
  TRANSLATION_CACHE.clear();
}

/**
 * Create a ParagraphTranslator based on the current prefs.
 *
 * The returned translator is wrapped with an LRU cache so that repeated
 * translations of the same text (e.g. retry, language toggle) return instantly
 * without an additional API call.
 */
export function createTranslator(
  targetLanguage: string,
  sourceLanguage?: string,
): ParagraphTranslator {
  const cfg = getEngineConfig();
  const inner = createTranslatorUncached(targetLanguage, sourceLanguage);

  return async (text: string, tgt: string, src?: string) => {
    // Only cache texts under 5000 chars to avoid memory bloat from long PDFs.
    if (text.length > 5000) return inner(text, tgt, src);

    // L-23: fold the model + API-key fingerprint into the cache key —
    // switching key/model within the same engine type must not serve the
    // previous configuration's cached translations.
    const credKey =
      cfg.engineType === "google"
        ? cfg.googleApiKey
        : cfg.engineType === "bing"
          ? cfg.bingApiKey
          : cfg.engineType === "deepl"
            ? cfg.deeplApiKey
            : cfg.engineType === "ai"
              ? cfg.aiApiKey
              : cfg.engineType === "custom"
                ? cfg.customApiKey
                : "";
    // The endpoint is part of a model-backed engine's configuration identity —
    // the same key/model against a different apiUrl serves a different service.
    const apiUrlKey =
      cfg.engineType === "custom"
        ? cfg.customApiUrl || ""
        : cfg.engineType === "ai"
          ? cfg.aiApiUrl || ""
          : "";
    // …and so is the prompt: same endpoint, different template, different
    // translations. Resolving first keeps the key stable for the default
    // template (empty pref), so switching from edited to default re-hits it.
    const promptKey =
      cfg.engineType === "ai"
        ? promptFingerprint(resolvePromptTemplate(cfg.aiPrompt))
        : "";
    const modelKey =
      cfg.engineType === "ai" ? cfg.aiModel || "" : cfg.customModel || "";
    const key = `${cfg.engineType}:${modelKey}:${(credKey || "").slice(-6)}:${apiUrlKey}:${promptKey}:${tgt || targetLanguage}:${src || sourceLanguage || "auto"}:${text}`;
    const cached = TRANSLATION_CACHE.get(key);
    if (cached !== undefined) {
      // LRU refresh: delete + re-insert moves entry to end (most recently used).
      TRANSLATION_CACHE.delete(key);
      TRANSLATION_CACHE.set(key, cached);
      return cached;
    }

    const result = await inner(text, tgt, src);
    if (result) {
      // Evict oldest entry (first in Map iteration order) if at capacity.
      if (TRANSLATION_CACHE.size >= TRANSLATION_CACHE_MAX) {
        const oldest = TRANSLATION_CACHE.keys().next().value;
        if (oldest !== undefined) TRANSLATION_CACHE.delete(oldest);
      }
      TRANSLATION_CACHE.set(key, result);
    }
    return result;
  };
}

function createTranslatorUncached(
  targetLanguage: string,
  sourceLanguage?: string,
): ParagraphTranslator {
  const cfg = getEngineConfig();

  switch (cfg.engineType) {
    case "ai":
      return async (text: string) => {
        if (!cfg.aiApiUrl)
          throw new Error(getString("translation-error-ai-url-missing"));
        const result = await translateWithAI(
          text,
          targetLanguage,
          sourceLanguage,
          {
            apiUrl: cfg.aiApiUrl,
            apiKey: cfg.aiApiKey,
            model: cfg.aiModel,
            prompt: cfg.aiPrompt,
          },
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-ai-failed"),
          );
        return result.translatedText || "";
      };
    case "google": {
      const googleOnly = async (text: string) => {
        const result = await translateWithGoogle(
          text,
          targetLanguage,
          sourceLanguage,
          {
            apiKey: cfg.googleApiKey,
          },
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-google-failed"),
          );
        return result.translatedText!;
      };
      // Default-engine resilience: when Google is unreachable (network block,
      // rate limit, outage) fall back to the keyless Bing web endpoint, which
      // is reachable in regions Google is not. Applies to both the keyless and
      // the keyed Google paths — it only ever fires after Google failed.
      return async (text: string) => {
        try {
          return await googleOnly(text);
        } catch (googleErr) {
          const bing = await translateWithBingWeb(
            text,
            targetLanguage,
            sourceLanguage,
          );
          if (!bing.success) {
            throw new Error(
              getString("translation-error-google-fallback-failed", {
                googleError:
                  googleErr instanceof Error
                    ? googleErr.message
                    : String(googleErr),
                bingError:
                  bing.error || getString("translation-error-unknown"),
              }),
              { cause: googleErr },
            );
          }
          return bing.translatedText!;
        }
      };
    }
    case "bing":
      return async (text: string) => {
        if (!cfg.bingApiKey)
          throw new Error(getString("translation-error-bing-not-configured"));
        const result = await translateWithBing(
          text,
          targetLanguage,
          sourceLanguage,
          {
            apiKey: cfg.bingApiKey,
            region: cfg.bingRegion || "global",
          },
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-bing-failed"),
          );
        return result.translatedText!;
      };
    case "deepl":
      return async (text: string) => {
        if (!cfg.deeplApiKey)
          throw new Error(getString("translation-error-deepl-not-configured"));
        const result = await translateWithDeepL(
          text,
          targetLanguage,
          sourceLanguage,
          {
            apiKey: cfg.deeplApiKey,
            useFreeEndpoint: cfg.deeplUseFree,
          },
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-deepl-failed"),
          );
        return result.translatedText || "";
      };
    case "zotero-pdf-translate":
      return async (text: string) => {
        const result = await translateWithZoteroPdfTranslate(
          text,
          targetLanguage,
          sourceLanguage,
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-pdf-translate-failed"),
          );
        return result.translatedText || "";
      };
    case "custom":
    // Unknown engine id falls through to the custom engine: it is the only
    // engine that can honour a system prompt without a user-owned template, and
    // it fails with an actionable configuration error when unconfigured.
    default:
      return async (text: string) => {
        if (!cfg.customApiUrl)
          throw new Error(getString("translation-error-custom-url-missing"));
        const result = await translateWithCustom(
          text,
          targetLanguage,
          sourceLanguage,
          {
            apiUrl: cfg.customApiUrl,
            apiKey: cfg.customApiKey,
            model: cfg.customModel,
          },
        );
        if (!result.success)
          throw new Error(
            result.error || getString("translation-error-custom-failed"),
          );
        return result.translatedText || "";
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch translation (custom / OpenAI-compatible engine only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for the batch translation response. chatJson validates against it
 * on the structured-output path, and the manual JSON path re-parses the same
 * shape, so both levels share one contract.
 *
 * A bare string array (not `{id, translation}` objects) keeps the schema simple
 * and reduces the model error surface — alignment is positional, so array order
 * is the source of truth.
 */
const BatchTranslationSchema = z.object({
  translations: z.array(z.string()),
});

/**
 * Whether the currently configured engine benefits from batch translation.
 * Only the custom engine does — it packs paragraphs into one model call with
 * structured JSON output. Traditional MT APIs (Google/Bing/DeepL) are stateless
 * and accept single text, so per-paragraph dispatch stays appropriate for them.
 * The "ai" engine is per-paragraph too: its prompt is a single-text template,
 * so a batch envelope would have to bypass the user's template.
 */
export function supportsBatching(): boolean {
  return getEngineConfig().engineType === "custom";
}

/**
 * Token budgets. leadero read these off the resolved provider
 * (getContextWindow/getMaxOutputTokens); the OpenAI-compatible client has no
 * such introspection, so the port starts from the same constants it defaulted
 * to and refines the ratio from real usage via calibrateCharsPerToken.
 */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const SYSTEM_RESERVE_TOKENS = 600; // batch prompt + JSON wrapper overhead
const SAFETY_MARGIN = 0.15; // 15% for estimation error + delimiter overhead

/**
 * Chars-per-token ratio. Starts at 2.5 (Chinese-mixed text average) and
 * self-calibrates with an exponential moving average from reported usage —
 * same semantics as leadero's TokenBudgetEstimator (clamp 1..6, alpha 0.3).
 * Fixed 2.5 underestimates tokens for CJK-heavy text (~1.5-2 chars/token),
 * oversizing the input budget until the API rejects the call.
 */
const INITIAL_CHARS_PER_TOKEN = 2.5;
const CHARS_PER_TOKEN_EMA_ALPHA = 0.3;
let charsPerToken = INITIAL_CHARS_PER_TOKEN;

function calibrateCharsPerToken(
  totalChars: number,
  actualInputTokens: number,
): void {
  if (actualInputTokens <= 0 || totalChars <= 0) return;
  const measured = totalChars / actualInputTokens;
  // Clamp to reasonable range (1..6 chars/token)
  const clamped = Math.max(1, Math.min(6, measured));
  charsPerToken =
    charsPerToken * (1 - CHARS_PER_TOKEN_EMA_ALPHA) +
    clamped * CHARS_PER_TOKEN_EMA_ALPHA;
}

/** Sentinel message for user-initiated cancellation. */
const CANCELLED = "translation_cancelled";

function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === CANCELLED;
}

const RETRY_BACKOFF_MS = 500;

function backoff(): Promise<void> {
  return new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
}

/**
 * Race a promise against an optional abort signal and optional total timeout.
 * Used for chatJson (non-streaming → no idleness detection).
 */
function raceAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error(CANCELLED));

  const racers: Promise<unknown>[] = [work];
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (signal) {
    racers.push(
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error(CANCELLED)), {
          once: true,
        }),
      ),
    );
  }
  if (timeoutMs) {
    racers.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    );
  }

  if (racers.length === 1) return work;
  for (const r of racers) r.catch(() => {});
  return Promise.race(racers).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Execute a client call with a timeout and cooperative cancellation.
 *
 * leadero resets this timer on every onStream event for true idleness
 * detection. openaiCompat is non-streaming (it returns the full completion at
 * once), so there is no token event to reset on: the idle budget degenerates
 * into a total timeout — exactly how leadero's own non-streaming providers
 * (Google/custom) degrade.
 */
async function executeWithIdleTimeout<T>(
  call: () => Promise<T>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error(CANCELLED);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idleP = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `idle timeout — no completion for ${Math.round(idleMs / 1000)}s`,
          ),
        ),
      idleMs,
    );
  });

  const racers: Promise<unknown>[] = [call(), idleP];
  if (signal) {
    racers.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(new Error(CANCELLED));
        signal.addEventListener("abort", () => reject(new Error(CANCELLED)), {
          once: true,
        });
      }),
    );
  }
  for (const r of racers) r.catch(() => {});

  try {
    return (await Promise.race(racers)) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create a batch translator that packs multiple paragraphs into a single
 * model call via structured JSON output.
 *
 * The returned translator NEVER throws — on any failure it degrades:
 *   1. chatJson with BatchTranslationSchema (response_format json_object,
 *      one built-in retry on parse/validation failure)
 *   2. chat + parseJsonFromMarkdown (manual JSON, one retry)
 *   3. Per-paragraph chat (the original single-paragraph path)
 *   4. Original text preserved (marked as failed)
 *
 * At every level the result always contains exactly `texts.length` strings.
 *
 * Also computes the token-budget parameters (inputBudgetChars,
 * outputBudgetChars), so the orchestrator can size chunks correctly.
 *
 * @throws if the custom engine has no API URL configured.
 */
export async function createAIBatchTranslator(
  targetLanguage: string,
  sourceLanguage?: string,
): Promise<BatchTranslatorHandle> {
  const cfg = getEngineConfig();
  if (!cfg.customApiUrl) {
    throw new Error(getString("translation-error-custom-url-missing"));
  }

  const client = createOpenAICompatClient({
    apiUrl: cfg.customApiUrl,
    apiKey: cfg.customApiKey,
    defaultModel: cfg.customModel,
  });

  // ── Language descriptors ──
  const targetDesc = getLanguageName(targetLanguage);
  const sourceDesc = sourceLanguage
    ? getLanguageName(sourceLanguage)
    : "auto-detect";

  // ── Token budgets ──
  // Two hard constraints: contextWindow (input + output must fit) and
  // maxOutputTokens (output cap). Output is usually the tighter bottleneck.
  // `||` (not `??`) on both: a 0 return means "unknown", not "zero".
  const contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutput = DEFAULT_MAX_OUTPUT_TOKENS;

  const outputBudgetTokens = Math.floor(maxOutput * (1 - SAFETY_MARGIN));
  const outputBudgetChars = Math.max(
    1000,
    Math.floor(outputBudgetTokens * charsPerToken),
  );
  const inputBudgetTokens = Math.max(
    1000,
    contextWindow - SYSTEM_RESERVE_TOKENS - maxOutput,
  );
  const inputBudgetChars = Math.max(
    1000,
    Math.floor(inputBudgetTokens * charsPerToken),
  );

  const prompt = batchJsonPrompt(targetDesc, sourceDesc);
  const singlePrompt = formulaPreservingPrompt(targetDesc, sourceDesc);

  // ── Timeouts ──
  // chatJson is a single non-streaming round trip → generous total timeout.
  // chat() likewise returns once, so the idle budget acts as a total timeout.
  const TOTAL_TIMEOUT_BATCH_MS = 180000; // 3 min
  const IDLE_TIMEOUT_BATCH_MS = 120000; // 2 min for batch calls
  const IDLE_TIMEOUT_SINGLE_MS = 60000; // 1 min for single-paragraph

  // ── Batch translator (multi-level fallback; throws CANCELLED on abort) ──
  const translate: BatchTranslator = async (
    texts: string[],
    signal?: AbortSignal,
  ): Promise<BatchTranslateResult> => {
    const inputJson = JSON.stringify({ segments: texts });

    // Level 1: chatJson with structured output + schema validation. Non-streaming
    // → no idleness detection → generous total timeout. chatJson already retries
    // once internally on parse/validation failure, so one call here keeps the
    // total at two attempts (leadero's outer 2-attempt generateObject loop).
    if (signal?.aborted) throw new Error(CANCELLED);
    try {
      const result = await raceAbort(
        client.chatJson(
          {
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: inputJson },
            ],
            maxTokens: maxOutput,
            temperature: 0.1,
            signal,
          },
          BatchTranslationSchema,
        ),
        signal,
        TOTAL_TIMEOUT_BATCH_MS,
      );
      if (result.usage?.promptTokens) {
        calibrateCharsPerToken(inputJson.length, result.usage.promptTokens);
      }
      const out = result.data.translations;
      if (out.length === texts.length) {
        return sanitizeTranslations(out, texts);
      }
      // Count mismatch — fall through to level 2.
    } catch (e) {
      if (isCancelled(e)) throw e;
      // chatJson threw (parse/validation failure / HTTP / timeout) — level 2.
    }

    // Level 2: chat + manual JSON parse. Same shape contract, no
    // response_format — some gateways 400 on it.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error(CANCELLED);
      try {
        const result = await executeWithIdleTimeout(
          () =>
            client.chat({
              messages: [
                { role: "system", content: prompt },
                { role: "user", content: inputJson },
              ],
              maxTokens: maxOutput,
              temperature: 0.1,
              signal,
            }),
          IDLE_TIMEOUT_BATCH_MS,
          signal,
        );
        if (result.usage?.promptTokens) {
          calibrateCharsPerToken(inputJson.length, result.usage.promptTokens);
        }
        const parsed = parseJsonFromMarkdown(result.content);
        const arr = Array.isArray(parsed) ? parsed : parsed?.translations;
        if (Array.isArray(arr) && arr.length === texts.length) {
          const translations = arr.map((x: any) =>
            typeof x === "string" ? x : (x?.translation ?? x?.text ?? ""),
          );
          return sanitizeTranslations(translations, texts);
        }
      } catch (e) {
        if (isCancelled(e)) throw e;
        // timeout or error — retry
      }
      if (attempt === 0) await backoff();
    }

    // Level 3: per-paragraph fallback with the single-paragraph prompt.
    const translations: string[] = [];
    const failedIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (signal?.aborted) throw new Error(CANCELLED);
      try {
        const result = await executeWithIdleTimeout(
          () =>
            client.chat({
              messages: [
                { role: "system", content: singlePrompt },
                { role: "user", content: texts[i] },
              ],
              maxTokens: Math.max(
                MODEL_OUTPUT_FLOOR_TOKENS,
                Math.min(texts[i].length * 2, 4000),
              ),
              temperature: 0.1,
              signal,
            }),
          IDLE_TIMEOUT_SINGLE_MS,
          signal,
        );
        const content = result.content || "";
        translations.push(content || texts[i]);
        if (!content && texts[i].trim()) failedIndices.push(i);
      } catch (e) {
        if (isCancelled(e)) throw e;
        translations.push(texts[i]);
        failedIndices.push(i);
      }
    }
    return { translations, failedIndices };
  };

  return { translate, inputBudgetChars, outputBudgetChars };
}

export type { BatchTranslatorHandle, BatchTranslator, BatchTranslateResult };
