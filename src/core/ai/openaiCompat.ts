/**
 * openaiCompat — minimal OpenAI-compatible chat-completions client.
 *
 * This is the z-transplit replacement for leadero's "ai" engine: a single
 * `/chat/completions` POST against a user-configured endpoint (translate.custom.
 * apiUrl / apiKey / model), backed by plain `fetch` — no SDK, no provider
 * registry, no streaming. It is deliberately the ONLY network client in the
 * translation core besides the classic MT endpoints, so every model-backed
 * translation path (single paragraph and batch JSON) routes through here.
 *
 * Two entry points:
 *   - chat()     → one completion, returns { content, usage? }
 *   - chatJson() → completion + JSON parse (+ optional zod validation),
 *                  one retry on parse/validation failure
 *
 * Cancellation: pass `signal` (or `timeoutMs`) on the request; both are
 * forwarded to fetch. A rejected/aborted fetch propagates to the caller —
 * translating an abort into a domain-specific error is the caller's job.
 */

import { z } from "zod";
import { parseJsonFromMarkdown } from "../../utils/json";
import { getString } from "../../utils/locale";
import { abortSignalTimeout } from "../../utils/abort";

export interface OpenAICompatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAICompatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface OpenAICompatChatRequest {
  messages: OpenAICompatMessage[];
  /** Overrides the client's configured default model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Forwarded as the wire `response_format`. */
  responseFormat?: { type: "json_object" | "text" };
  signal?: AbortSignal;
  /** Convenience total timeout when the caller has no signal of its own. */
  timeoutMs?: number;
}

export interface OpenAICompatChatResult {
  content: string;
  usage?: OpenAICompatUsage;
}

export interface OpenAICompatJsonResult<T> {
  data: T;
  usage?: OpenAICompatUsage;
}

export interface OpenAICompatClientConfig {
  /** Base endpoint, e.g. "https://api.openai.com/v1" or ".../v1/chat/completions". */
  apiUrl: string;
  apiKey?: string;
  /** Model used when a request does not override it; "" = server default. */
  defaultModel?: string;
  /**
   * Fluent message id (no `ztransplit-` prefix) reported when the endpoint
   * returns an empty completion. Defaults to the custom engine's message;
   * callers that are not the custom engine pass their own key so the error
   * names the engine the user actually selected.
   */
  emptyResultErrorKey?: string;
}

export interface OpenAICompatClient {
  readonly apiUrl: string;
  readonly model: string;
  chat(request: OpenAICompatChatRequest): Promise<OpenAICompatChatResult>;
  /**
   * `Input` is widened to `any` so schemas with a preprocessing step
   * (z.preprocess, whose input type is `unknown`) fit alongside plain
   * ZodObjects — the output type T is what callers consume.
   */
  chatJson<T>(
    request: OpenAICompatChatRequest,
    schema?: z.ZodType<T, z.ZodTypeDef, any>,
  ): Promise<OpenAICompatJsonResult<T>>;
}

const RETRY_BACKOFF_MS = 500;

/**
 * Budget for the one escalated retry after an empty completion — see the
 * comment at the retry site inside chat().
 */
const EMPTY_COMPLETION_RETRY_MAX_TOKENS = 32768;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normalize a user-configured base URL to the chat-completions endpoint.
 *
 * Ported verbatim from leadero's custom engine (translationEngines.ts:513-516):
 * a URL that already ends in /chat/completions is left alone (gateways that
 * mount it at a custom path), otherwise the trailing /v1 is stripped and
 * /v1/chat/completions appended.
 */
export function normalizeChatCompletionsUrl(apiUrl: string): string {
  let baseUrl = apiUrl.replace(/\/+$/, "");
  if (!baseUrl.endsWith("/chat/completions")) {
    baseUrl = baseUrl.replace(/\/v1\/?$/, "") + "/v1/chat/completions";
  }
  return baseUrl;
}

function toUsage(raw: any): OpenAICompatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage: OpenAICompatUsage = {};
  if (typeof raw.prompt_tokens === "number") usage.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === "number")
    usage.completionTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === "number") usage.totalTokens = raw.total_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Create a client bound to one endpoint/model/key.
 *
 * The Authorization header is only sent when a key is actually configured —
 * an empty key must not produce a literal "Bearer undefined" header.
 */
export function createOpenAICompatClient(
  config: OpenAICompatClientConfig,
): OpenAICompatClient {
  const url = normalizeChatCompletionsUrl(config.apiUrl);
  const model = config.defaultModel || "";
  const emptyErrorKey = config.emptyResultErrorKey ?? "translation-error-custom-empty";

  async function chat(
    request: OpenAICompatChatRequest,
  ): Promise<OpenAICompatChatResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    // An empty model id means "let the server pick its default" (the
    // preferences pane promises exactly that) — omit the field instead of
    // sending an empty string, which not every gateway treats as default.
    const body: Record<string, unknown> = {};
    const modelId = request.model || model;
    if (modelId) body.model = modelId;
    body.messages = request.messages;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.responseFormat) body.response_format = request.responseFormat;

    const signal =
      request.signal ??
      (request.timeoutMs ? abortSignalTimeout(request.timeoutMs) : undefined);

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
    }
    const data = (await resp.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      // Reasoning-style models spend completion tokens on hidden thinking that
      // scales with input size, so a request-shaped cap can be exhausted
      // mid-thought with an empty visible answer even when the text itself is
      // short (observed on StepFun step-3.7-flash with whole-paper batches at
      // 4096). One escalated retry with a much larger budget recovers those;
      // well-behaved models never hit this path, and the retry keeps the same
      // request shape so gateways that reject exotic params are unaffected.
      if (
        request.maxTokens !== undefined &&
        request.maxTokens < EMPTY_COMPLETION_RETRY_MAX_TOKENS
      ) {
        return chat({
          ...request,
          maxTokens: EMPTY_COMPLETION_RETRY_MAX_TOKENS,
        });
      }
      throw new Error(getString(emptyErrorKey));
    }
    return { content: content.trim(), usage: toUsage(data?.usage) };
  }

  async function chatJson<T>(
    request: OpenAICompatChatRequest,
    schema?: z.ZodType<T>,
  ): Promise<OpenAICompatJsonResult<T>> {
    // Ask for JSON up front unless the caller pinned a response_format; the
    // retry below re-sends the same request (most gateways recover on a second
    // pass, and a bad pass costs one round trip).
    const jsonRequest: OpenAICompatChatRequest = {
      ...request,
      responseFormat: request.responseFormat ?? { type: "json_object" },
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chat(jsonRequest);
        const parsed = parseJsonFromMarkdown(result.content);
        if (parsed === null || parsed === undefined) {
          throw new Error("Custom API returned non-JSON content");
        }
        if (schema) {
          const validated = schema.safeParse(parsed);
          if (!validated.success) {
            throw new Error(
              `Custom API JSON failed schema validation: ${validated.error.message}`,
            );
          }
          return { data: validated.data, usage: result.usage };
        }
        return { data: parsed as T, usage: result.usage };
      } catch (e) {
        lastError = e;
        if (attempt === 0) await sleep(RETRY_BACKOFF_MS);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  return { apiUrl: url, model, chat, chatJson };
}
