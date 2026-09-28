/**
 * translationEngines real-logic tests.
 *
 * Real engine selection + wire contracts + cache behavior run against a
 * URL-routed global fetch stub. Prefs are map-backed (plugin-prefixed keys
 * via getPrefDynamic). The custom (OpenAI-compatible) engine path runs the
 * real openaiCompat client — only `fetch` is stubbed.
 *
 * Ported from leadero's tests/unit/core/translation/translationEngines.test.ts
 * with the "ai" engine removed: its cases now target the "custom" engine, and
 * the ModelRouter/translateParagraphs module mocks are gone (no such modules).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchCalls: [] as any[],
  routes: [] as Array<{
    match: (url: string) => boolean;
    respond: (call: any) => any;
  }>,
}));

vi.mock("../../../../src/utils/locale", () => ({
  // 返回键名（带 args 时附 JSON），与 leadero 的 research.test.ts 同款——
  // 断言因此钉的是"走对了哪个错误分支"，而不是某个语言的文案。
  getString: (key: string, opts?: any) =>
    opts && Object.keys(opts).length > 0
      ? `${key}:${JSON.stringify(opts)}`
      : key,
}));

import {
  getEngineConfig,
  clearTranslationCache,
  resetBingWebSession,
  createTranslator,
  createAIBatchTranslator,
  supportsBatching,
} from "../../../../src/core/translation/translationEngines";

// z-transplit has no shared vitest setup file (see vitest.config.ts), so the
// Zotero global the pref layer expects is installed here.
const Z: any = (globalThis as any).Zotero ?? {};

function jsonResponse(obj: any, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function setPrefs(prefs: Record<string, unknown>) {
  Z.Prefs = {
    get: (k: string) => {
      for (const [suffix, v] of Object.entries(prefs)) {
        if (String(k).endsWith(suffix)) return v;
      }
      return undefined;
    },
  };
}

function route(match: string | RegExp, respond: (call: any) => any) {
  h.routes.push({
    match: (url) =>
      typeof match === "string" ? url.includes(match) : match.test(url),
    respond,
  });
}

beforeEach(() => {
  h.fetchCalls.length = 0;
  h.routes.length = 0;
  (globalThis as any).Zotero = Z;
  setPrefs({});
  clearTranslationCache();
  resetBingWebSession();
  delete Z.PDFTranslate;

  vi.stubGlobal("fetch", (url: string, init: any = {}) => {
    const call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body,
      signal: init.signal,
    };
    h.fetchCalls.push(call);
    for (const r of h.routes) {
      if (r.match(url)) return Promise.resolve(r.respond(call));
    }
    return Promise.resolve(jsonResponse({}, false, 404, "no route"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getEngineConfig", () => {
  it("defaults: google engine (keyless), global bing region, empty custom model (server default)", () => {
    const cfg = getEngineConfig();
    expect(cfg).toMatchObject({
      engineType: "google",
      bingRegion: "global",
      customModel: "",
      deeplUseFree: false,
    });
  });

  it("reads engine settings from prefs (deepl free tier flag is a string)", () => {
    setPrefs({
      "translate.engineType": "deepl",
      "translate.deepl.apiKey": "key-1",
      "translate.deepl.useFree": "true",
      "translate.custom.model": "qwen-max",
    });
    const cfg = getEngineConfig();
    expect(cfg.engineType).toBe("deepl");
    expect(cfg.deeplApiKey).toBe("key-1");
    expect(cfg.deeplUseFree).toBe(true);
    expect(cfg.customModel).toBe("qwen-max");
  });
});

describe("engine wire contracts", () => {
  it("google free endpoint: sl/tl params, sentences joined", async () => {
    setPrefs({ "translate.engineType": "google" });
    route("translate_a/single", () =>
      jsonResponse([
        [
          ["你好", "hello", null, null],
          ["世界", "world", null, null],
        ],
        null,
        "en",
      ]),
    );

    const t = createTranslator("zh-CN");
    const out = await t("hello world", "zh-CN");
    expect(out).toBe("你好世界");
    expect(h.fetchCalls[0].method).toBe("GET");
    expect(h.fetchCalls[0].url).toContain("sl=auto");
    expect(h.fetchCalls[0].url).toContain("tl=zh-CN"); // zh region preserved
  });

  it("google with API key: v2 POST body {q, target, format}", async () => {
    setPrefs({
      "translate.engineType": "google",
      "translate.google.apiKey": "gk-1",
    });
    route("language/translate/v2", () =>
      jsonResponse({ data: { translations: [{ translatedText: "Salut" }] } }),
    );

    const t = createTranslator("fr-FR", "en-US");
    const out = await t("hello", "fr-FR", "en-US");
    expect(out).toBe("Salut");
    const call = h.fetchCalls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toContain("key=gk-1");
    const body = JSON.parse(call.body);
    expect(body).toEqual({
      q: "hello",
      source: "en",
      target: "fr",
      format: "text",
    });
  });

  it("bing: subscription headers, Text array body, empty from for auto", async () => {
    setPrefs({
      "translate.engineType": "bing",
      "translate.bing.apiKey": "bk-1",
      "translate.bing.region": "eastasia",
    });
    route("cognitive.microsofttranslator", () =>
      jsonResponse([{ translations: [{ text: "Hola" }] }]),
    );

    const t = createTranslator("es-ES");
    expect(await t("hello", "es-ES")).toBe("Hola");
    const call = h.fetchCalls[0];
    expect(call.headers["Ocp-Apim-Subscription-Key"]).toBe("bk-1");
    expect(call.headers["Ocp-Apim-Subscription-Region"]).toBe("eastasia");
    expect(call.url).toContain("from=&");
    expect(JSON.parse(call.body)).toEqual([{ Text: "hello" }]);
  });

  it("bing without a key fails fast with a configuration error", async () => {
    setPrefs({ "translate.engineType": "bing" });
    const t = createTranslator("es-ES");
    await expect(t("hello", "es-ES")).rejects.toThrow(
      "translation-error-bing-not-configured",
    );
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("deepl: zh-CN→ZH mapping, free host, auth header, form body", async () => {
    setPrefs({
      "translate.engineType": "deepl",
      "translate.deepl.apiKey": "dk-1:fx",
      "translate.deepl.useFree": "true",
    });
    route("api-free.deepl.com", (call) => {
      const params = new URLSearchParams(call.body);
      return jsonResponse({
        translations: [
          { text: `[${params.get("target_lang")}]{${params.get("text")}}` },
        ],
      });
    });

    const t = createTranslator("zh-CN", "en-US");
    expect(await t("hello", "zh-CN", "en-US")).toBe("[ZH]{hello}");
    const call = h.fetchCalls[0];
    expect(call.url).toContain("https://api-free.deepl.com/v2/translate");
    expect(call.headers.Authorization).toBe("DeepL-Auth-Key dk-1:fx");
    expect(call.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(new URLSearchParams(call.body).get("source_lang")).toBe("EN");
  });

  it("deepl auto source omits source_lang; pro host by default", async () => {
    setPrefs({
      "translate.engineType": "deepl",
      "translate.deepl.apiKey": "dk-2",
    });
    route("api.deepl.com", () =>
      jsonResponse({ translations: [{ text: "ok" }] }),
    );

    const t = createTranslator("de-DE");
    await t("hi", "de-DE");
    const body = new URLSearchParams(h.fetchCalls[0].body);
    expect(body.get("target_lang")).toBe("DE");
    expect(body.has("source_lang")).toBe(false);
  });

  it("custom endpoint: URL normalized, model + bounded max_tokens, response trimmed", async () => {
    setPrefs({
      "translate.engineType": "custom",
      "translate.custom.apiUrl": "http://localhost:11434/v1/",
      "translate.custom.apiKey": "ck-1",
      "translate.custom.model": "llama3",
    });
    route("chat/completions", () =>
      jsonResponse({ choices: [{ message: { content: "  Bonjour  " } }] }),
    );

    const t = createTranslator("fr-FR");
    expect(await t("hello", "fr-FR")).toBe("Bonjour");
    const call = h.fetchCalls[0];
    expect(call.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(call.headers.Authorization).toBe("Bearer ck-1");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("llama3");
    expect(body.max_tokens).toBe(10); // min(len*2, 4000)
    expect(body.temperature).toBe(0.3);
    expect(body.messages[0].role).toBe("system");
    // formula-preserving prompt (the ex-"ai" engine's contract, now on custom)
    expect(body.messages[0].content).toContain("from auto-detect to French");
    expect(body.messages[0].content).toContain("{v0}");
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("custom endpoint already ending in /chat/completions is not double-suffixed", async () => {
    setPrefs({
      "translate.engineType": "custom",
      "translate.custom.apiUrl": "https://gw.example/v1/chat/completions",
    });
    route("chat/completions", () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );

    const t = createTranslator("en-US");
    await t("hi", "en-US");
    expect(h.fetchCalls[0].url).toBe("https://gw.example/v1/chat/completions");
  });

  it("custom endpoint without a URL fails fast", async () => {
    setPrefs({ "translate.engineType": "custom" });
    const t = createTranslator("en-US");
    await expect(t("hi", "en-US")).rejects.toThrow(
      "translation-error-custom-url-missing",
    );
  });

  it("custom engine maps zh-CN to a language name in the prompt", async () => {
    setPrefs({
      "translate.engineType": "custom",
      "translate.custom.apiUrl": "https://gw.example",
    });
    route("chat/completions", () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    const t = createTranslator("zh-CN", "en-US");
    await t("hello", "zh-CN", "en-US");
    const body = JSON.parse(h.fetchCalls[0].body);
    expect(body.messages[0].content).toContain(
      "from English to Simplified Chinese",
    );
  });

  it("zotero-pdf-translate: delegates via the plugin API and maps task status", async () => {
    setPrefs({ "translate.engineType": "zotero-pdf-translate" });

    // plugin missing → actionable configuration error
    const noPlugin = createTranslator("zh-CN");
    await expect(noPlugin("hi", "zh-CN")).rejects.toThrow(
      "translation-error-pdf-translate-missing",
    );

    Z.PDFTranslate = {
      api: {
        translate: async (raw: string, opts: any) => {
          if (raw === "bad") return { status: "failed", result: "engine boom" };
          return { status: "success", result: `译:${raw}`, opts };
        },
      },
    };
    const t = createTranslator("zh-CN");
    expect(await t("hi", "zh-CN", "en-US")).toBe("译:hi");
    await expect(t("bad", "zh-CN")).rejects.toThrow("engine boom");
  });

  it("google failure falls back to the keyless Bing web endpoint", async () => {
    resetBingWebSession();
    setPrefs({ "translate.engineType": "google" });
    route("translate_a/single", () =>
      jsonResponse({ message: "blocked" }, false, 500, "Internal Server Error"),
    );
    route("www.bing.com/translator", () => {
      const html =
        '<html><script>var _G={Region:"CN",IG:"CE47A2D005A84FF09AA51E7D3B6C25F1"};' +
        'var params_AbusePreventionHelper = [1690000000000,"abuseToken123",3600000];</script>' +
        '<div id="rich_tta" data-iid="translator.5023"></div></html>';
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://cn.bing.com/translator",
        text: async () => html,
      } as any;
    });
    route("ttranslatev3", () =>
      jsonResponse([
        [
          {
            detectedLanguage: { language: "en" },
            translations: [{ text: "你好", to: "zh-Hans" }],
          },
        ],
      ]),
    );

    const t = createTranslator("zh-CN");
    expect(await t("hello", "zh-CN")).toBe("你好");

    // Call order: google (fails) → bing token page → ttranslatev3.
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[1].url).toContain("www.bing.com/translator");
    // Live-page request shape: IG/IID/SFX + token/key all in the QUERY STRING.
    const postUrl = h.fetchCalls[2].url;
    expect(postUrl).toContain(
      "ttranslatev3?isVertical=1&IG=CE47A2D005A84FF09AA51E7D3B6C25F1",
    );
    expect(postUrl).toContain("IID=translator.5023");
    expect(postUrl).toContain("SFX=0");
    expect(postUrl).toContain("token=abuseToken123");
    expect(postUrl).toContain("key=1690000000000");
    // Body carries only the translation payload — auth never rides in the body.
    const body = new URLSearchParams(h.fetchCalls[2].body);
    expect(body.get("to")).toBe("zh-Hans"); // zh-CN mapped to Bing web id
    // Live endpoint rejects fromLang=auto ({"statusCode":400}); auto-detect
    // must be requested as "auto-detect" (verified against cn.bing.com).
    expect(body.get("fromLang")).toBe("auto-detect");
    expect(body.get("text")).toBe("hello");
    expect(body.get("token")).toBeNull();
    expect(body.get("key")).toBeNull();
  });

  it("bing web rejection (statusCode 400) refreshes the session and retries once", async () => {
    resetBingWebSession();
    setPrefs({ "translate.engineType": "google" });
    route("translate_a/single", () =>
      jsonResponse({ message: "blocked" }, false, 500, "Internal Server Error"),
    );
    let tokenPageHits = 0;
    route("www.bing.com/translator", () => {
      tokenPageHits++;
      const html =
        '<html><script>var _G={IG:"CE47A2D005A84FF09AA51E7D3B6C25F1"};' +
        'var params_AbusePreventionHelper = [1690000000000,"abuseToken123",3600000];</script>' +
        '<div id="rich_tta" data-iid="translator.5023"></div></html>';
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://cn.bing.com/translator",
        text: async () => html,
      } as any;
    });
    let translateHits = 0;
    route("ttranslatev3", () => {
      translateHits++;
      // First call (fresh session, SFX=0) rejects with the live-page rejection
      // body; the retried call — after the session refresh — succeeds.
      if (translateHits === 1) {
        return jsonResponse({ statusCode: 400, errorMessage: "" });
      }
      return jsonResponse([
        [{ translations: [{ text: "你好", to: "zh-Hans" }] }],
      ]);
    });

    const t = createTranslator("zh-CN");
    expect(await t("hello", "zh-CN")).toBe("你好");
    // Rejected → session dropped → token page refetched → retry succeeds.
    expect(tokenPageHits).toBe(2);
    expect(translateHits).toBe(2);
    // A fresh session restarts its SFX counter at 0 (matches the live page,
    // where the counter is per page load).
    const lastUrl = new URL(h.fetchCalls[h.fetchCalls.length - 1].url);
    expect(lastUrl.searchParams.get("SFX")).toBe("0");
  });

  it("unreachable Google AND Bing surfaces a combined error", async () => {
    setPrefs({ "translate.engineType": "google" });
    route("translate_a/single", () =>
      jsonResponse({}, false, 429, "Too Many Requests"),
    );
    route("www.bing.com/translator", () =>
      jsonResponse({}, false, 503, "Service Unavailable"),
    );
    route("ttranslatev3", () =>
      jsonResponse({}, false, 503, "Service Unavailable"),
    );

    const t = createTranslator("zh-CN");
    await expect(t("hello", "zh-CN")).rejects.toThrow(
      /translation-error-google-fallback-failed/,
    );
  });

  it("HTTP failures surface with status + body (via the fallback chain)", async () => {
    setPrefs({ "translate.engineType": "google" });
    route("translate_a/single", () =>
      jsonResponse(
        { message: "quota exceeded" },
        false,
        429,
        "Too Many Requests",
      ),
    );

    const t = createTranslator("zh-CN");
    await expect(t("hello", "zh-CN")).rejects.toThrow("HTTP 429");
  });
});

describe("custom engine (OpenAI-compatible)", () => {
  function customPrefs(overrides: Record<string, unknown> = {}) {
    setPrefs({
      "translate.engineType": "custom",
      "translate.custom.apiUrl": "https://gw.example/v1",
      "translate.custom.apiKey": "ck-1",
      "translate.custom.model": "llama3",
      ...overrides,
    });
  }

  it("supportsBatching is true only for the custom engine", () => {
    customPrefs();
    expect(supportsBatching()).toBe(true);
    setPrefs({ "translate.engineType": "google" });
    expect(supportsBatching()).toBe(false);
  });

  it("createAIBatchTranslator exposes the token budgets and the batch JSON contract", async () => {
    customPrefs();
    route("chat/completions", () =>
      jsonResponse({
        choices: [{ message: { content: '{"translations":["a","b"]}' } }],
      }),
    );

    const handle = await createAIBatchTranslator("zh-CN", "en-US");
    // 128000 context − 600 system reserve − 4096 output = 123304 tokens × 2.5
    // chars/token; 4096 × 0.85 × 2.5 (before any usage calibration).
    expect(handle.inputBudgetChars).toBe(308260);
    expect(handle.outputBudgetChars).toBe(8702);

    const result = await handle.translate(["x", "y"]);
    expect(result).toEqual({ translations: ["a", "b"], failedIndices: [] });

    const body = JSON.parse(h.fetchCalls[0].body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("llama3");
    expect(body.temperature).toBe(0.1);
    // batch prompt: segments in, translations out, formula/token preservation
    expect(body.messages[0].content).toContain('{"segments"');
    expect(body.messages[0].content).toContain("Simplified Chinese");
    expect(body.messages[1]).toEqual({
      role: "user",
      content: '{"segments":["x","y"]}',
    });
  });

  it("batch: empty translations fall back to the originals and are flagged", async () => {
    customPrefs();
    route("chat/completions", () =>
      jsonResponse({
        choices: [{ message: { content: '{"translations":["","ok"]}' } }],
      }),
    );

    const handle = await createAIBatchTranslator("zh-CN", "en-US");
    const result = await handle.translate(["keep", "second"]);
    expect(result).toEqual({
      translations: ["keep", "ok"],
      failedIndices: [0],
    });
  });

  it("batch: degrades to manual JSON parsing when structured output is unusable", async () => {
    customPrefs();
    let call = 0;
    route("chat/completions", () => {
      call++;
      // chatJson retries once (attempt 2 also garbage), then level 2's plain
      // chat succeeds with the same envelope.
      if (call <= 2) return jsonResponse({ choices: [{ message: { content: "not json at all" } }] });
      return jsonResponse({
        choices: [
          { message: { content: '```json\n{"translations":["p","q"]}\n```' } },
        ],
      });
    });

    const handle = await createAIBatchTranslator("zh-CN", "en-US");
    const result = await handle.translate(["x", "y"]);
    expect(result).toEqual({ translations: ["p", "q"], failedIndices: [] });
    expect(h.fetchCalls).toHaveLength(3);
    // Level 1 asks for structured output; level 2 does not.
    expect(JSON.parse(h.fetchCalls[0].body).response_format).toEqual({
      type: "json_object",
    });
    expect(JSON.parse(h.fetchCalls[2].body).response_format).toBeUndefined();
  });

  it("batch: falls back to per-paragraph, then originals, when the endpoint is down", async () => {
    customPrefs();
    route("chat/completions", () =>
      jsonResponse({ error: "boom" }, false, 500, "Internal Server Error"),
    );

    const handle = await createAIBatchTranslator("zh-CN", "en-US");
    const result = await handle.translate(["x", "y"]);
    expect(result).toEqual({
      translations: ["x", "y"],
      failedIndices: [0, 1],
    });
    // 2 (chatJson attempts) + 2 (chat attempts) + 2 (per-paragraph)
    expect(h.fetchCalls).toHaveLength(6);
    // Per-paragraph level uses the single-paragraph formula prompt.
    const last = JSON.parse(h.fetchCalls[h.fetchCalls.length - 1].body);
    expect(last.messages[0].content).toContain("{v0}");
    expect(last.messages[1]).toEqual({ role: "user", content: "y" });
  });

  it("batch: an aborted signal cancels before any call", async () => {
    customPrefs();
    route("chat/completions", () =>
      jsonResponse({ choices: [{ message: { content: '{"translations":[]}' } }] }),
    );

    const handle = await createAIBatchTranslator("zh-CN", "en-US");
    await expect(
      handle.translate(["x"], AbortSignal.abort()),
    ).rejects.toThrow("translation_cancelled");
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("createAIBatchTranslator throws when the custom engine has no URL", async () => {
    setPrefs({ "translate.engineType": "custom" });
    await expect(createAIBatchTranslator("zh-CN")).rejects.toThrow(
      "translation-error-custom-url-missing",
    );
  });
});

describe("translation cache", () => {
  function googleRoute() {
    route("translate_a/single", () =>
      jsonResponse([[["x", "y", null, null]], null, "en"]),
    );
  }

  it("repeat translations of the same text hit the engine once", async () => {
    setPrefs({ "translate.engineType": "google" });
    googleRoute();
    const t = createTranslator("zh-CN");
    await t("same text", "zh-CN");
    await t("same text", "zh-CN");
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("clearTranslationCache forces a refetch", async () => {
    setPrefs({ "translate.engineType": "google" });
    googleRoute();
    const t = createTranslator("zh-CN");
    await t("text", "zh-CN");
    clearTranslationCache();
    await t("text", "zh-CN");
    expect(h.fetchCalls).toHaveLength(2);
  });

  it("texts over 5000 chars bypass the cache entirely", async () => {
    setPrefs({ "translate.engineType": "google" });
    googleRoute();
    const t = createTranslator("zh-CN");
    const long = "a".repeat(5001);
    await t(long, "zh-CN");
    await t(long, "zh-CN");
    expect(h.fetchCalls).toHaveLength(2);
  });

  it("changing the credential pref invalidates the cache key (L-23)", async () => {
    setPrefs({
      "translate.engineType": "google",
      "translate.google.apiKey": "key-AAAAAA",
    });
    route("language/translate/v2", () =>
      jsonResponse({ data: { translations: [{ translatedText: "x" }] } }),
    );

    const t1 = createTranslator("zh-CN");
    await t1("text", "zh-CN");
    await t1("text", "zh-CN"); // cached
    expect(h.fetchCalls).toHaveLength(1);

    setPrefs({
      "translate.engineType": "google",
      "translate.google.apiKey": "key-BBBBBB",
    });
    const t2 = createTranslator("zh-CN");
    await t2("text", "zh-CN");
    expect(h.fetchCalls).toHaveLength(2); // new fingerprint → refetch
  });

  it("different language pairs cache separately", async () => {
    setPrefs({ "translate.engineType": "google" });
    googleRoute();
    const t = createTranslator("zh-CN");
    await t("text", "zh-CN");
    await t("text", "zh-TW");
    expect(h.fetchCalls).toHaveLength(2);
  });
});
