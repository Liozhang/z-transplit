/**
 * Dictionary card chain tests (dictionaryCard.ts + youdaoDict.ts).
 *
 * Real chain logic run against a URL-routed global fetch stub: the Youdao
 * layer with fixtures built from the verified live response shapes, the model
 * layer through the real openaiCompat client, and the MT simple-card layer
 * through the real engine selection. Only fetch and the locale/prefs layers
 * are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  return {
    routes: [] as Array<{ match: (url: string) => boolean; respond: (call: any) => any }>,
  };
});

vi.mock("../../../../src/utils/locale", () => ({
  // 断言钉的是"走对了哪个错误分支"，不是具体文案（与 translationEngines 同款）。
  getString: (key: string, opts?: any) =>
    opts && Object.keys(opts).length > 0
      ? `${key}:${JSON.stringify(opts)}`
      : key,
}));

import {
  isSingleWord,
  lookupWord,
  flattenCardText,
} from "../../../../src/core/translation/dictionaryCard";
import {
  clearTranslationCache,
  resetBingWebSession,
} from "../../../../src/core/translation/translationEngines";

// z-transplit has no shared vitest setup file, so the Zotero global the pref
// layer expects is installed here (suffix-matched map, see
// translationEngines.test.ts).
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

// Youdao en fixture, condensed from the live response verified 2026-09-29
// (branch `ec`, usphone, blng_sents_part with one translation-less pair).
const YOUDAO_EN = {
  simple: {
    word: [{ word: "resonance", usphone: "ˈrezənəns", ukphone: "ˈrezənəns" }],
  },
  ec: {
    word: [
      {
        trs: [
          {
            tr: [
              { l: { i: ["n. （声音的）深沉，洪亮；（情感的）共鸣，反响"] } },
              { l: { i: ["n. （物理）共鸣，共振"] } },
            ],
          },
        ],
      },
    ],
  },
  blng_sents_part: {
    "sentence-pair": [
      {
        "sentence-eng": "The city resonates with history.",
        "sentence-translation": "这座城市回荡着历史的回声。",
      },
      { "sentence-eng": "a pair without a translation" },
    ],
  },
};

beforeEach(() => {
  h.routes.length = 0;
  (globalThis as any).Zotero = Z;
  setPrefs({});
  clearTranslationCache();
  resetBingWebSession();

  vi.stubGlobal("fetch", (url: string, init: any = {}) => {
    const found = h.routes.find((r) => r.match(url));
    if (!found) return Promise.reject(new Error("unrouted fetch: " + url));
    return Promise.resolve(
      found.respond({
        url,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        body: init.body,
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete Z.Prefs;
});

describe("isSingleWord", () => {
  it("accepts single Latin tokens, hyphenated compounds and clitics", () => {
    expect(isSingleWord("resonance")).toBe(true);
    expect(isSingleWord("  state-of-the-art ")).toBe(true);
    expect(isSingleWord("don't")).toBe(true);
    expect(isSingleWord("don’t")).toBe(true);
  });

  it("rejects phrases, punctuation, digits and over-long tokens", () => {
    expect(isSingleWord("hello world")).toBe(false);
    expect(isSingleWord("resonance,")).toBe(false);
    expect(isSingleWord("COVID-19")).toBe(false);
    expect(isSingleWord("")).toBe(false);
    expect(isSingleWord("   ")).toBe(false);
    expect(isSingleWord("a".repeat(65))).toBe(false);
  });

  it("accepts short CJK entries but not CJK sentence fragments", () => {
    expect(isSingleWord("共鸣")).toBe(true);
    expect(isSingleWord("ゆえ")).toBe(true);
    expect(isSingleWord("共振态研究")).toBe(false);
  });
});

describe("flattenCardText", () => {
  it("renders word header, senses with POS, and example pairs", () => {
    expect(
      flattenCardText({
        word: "word",
        phonetic: "/wɜːd/",
        senses: [
          { pos: "n.", meaning: "词", example: "a word", exampleTranslation: "一个词" },
        ],
        examples: [{ text: "in other words", translation: "换句话说" }],
        source: "youdao",
      }),
    ).toBe("word /wɜːd/\nn. 词\na word — 一个词\nin other words — 换句话说");
  });
});

describe("lookupWord chain", () => {
  it("prefers Youdao for Latin words with a Chinese target", async () => {
    route(/dict\.youdao\.com/, () => jsonResponse(YOUDAO_EN));
    const result = await lookupWord("resonance", "zh-CN");
    expect(result.source).toBe("youdao");
    expect(result.phonetic).toBe("ˈrezənəns");
    expect(result.senses).toHaveLength(2);
    expect(result.senses[0]).toEqual({
      pos: "n.",
      meaning: "（声音的）深沉，洪亮；（情感的）共鸣，反响",
    });
    // The pair without a translation is filtered out.
    expect(result.examples).toHaveLength(1);
    expect(result.examples![0].translation).toBe("这座城市回荡着历史的回声。");
  });

  it("skips Youdao for non-Chinese targets and uses the model endpoint", async () => {
    setPrefs({
      "translate.engineType": "ai",
      "translate.ai.apiUrl": "https://ai.test/v1",
      "translate.ai.model": "m1",
    });
    let youdaoCalled = false;
    route(/dict\.youdao\.com/, () => {
      youdaoCalled = true;
      return jsonResponse(YOUDAO_EN);
    });
    route(/ai\.test/, () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                word: "resonance",
                phonetic: "ʁezɔnɑ̃s",
                senses: [{ pos: "n.f.", meaning: "résonance" }],
              }),
            },
          },
        ],
      }),
    );
    const result = await lookupWord("resonance", "fr-FR");
    expect(youdaoCalled).toBe(false);
    expect(result.source).toBe("model");
    expect(result.senses[0].meaning).toBe("résonance");
  });

  it("degrades to the MT simple card when Youdao has no usable entry", async () => {
    // Default engine google (no prefs), keyless endpoint.
    route(/dict\.youdao\.com/, () => jsonResponse({ simple: {}, web_trans: {} }));
    route(/translate\.googleapis\.com/, () =>
      jsonResponse([[["共振", "resonance", null, null, 10]], null, "en"]),
    );
    const result = await lookupWord("resonance", "zh-CN");
    expect(result.source).toBe("mt");
    expect(result.senses[0].meaning).toBe("共振");
  });

  it("degrades to MT when the model card fails schema validation", async () => {
    setPrefs({ "translate.ai.apiUrl": "https://ai.test/v1" });
    route(/dict\.youdao\.com/, () => jsonResponse({}));
    // senses: [] violates min(1) on both chatJson attempts → chain moves on.
    route(/ai\.test/, () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ senses: [] }) } }],
      }),
    );
    route(/translate\.googleapis\.com/, () =>
      jsonResponse([[["翻译兜底", "fallback"]]]),
    );
    const result = await lookupWord("wordy", "zh-CN");
    expect(result.source).toBe("mt");
    expect(result.senses[0].meaning).toBe("翻译兜底");
  });

  it("throws the localized all-failed error when every layer fails", async () => {
    route(/dict\.youdao\.com/, () => jsonResponse({}, false, 500, "ISE"));
    route(/translate\.googleapis\.com/, () => jsonResponse({}, false, 500, "ISE"));
    // Google's keyless path falls back to the keyless Bing web endpoint.
    route(/bing\.com/, () => {
      throw new Error("network down");
    });
    await expect(lookupWord("zzz", "zh-CN")).rejects.toThrow(
      /dictionary-error-all-failed/,
    );
  });

  it("treats an empty word as an immediate localized failure", async () => {
    await expect(lookupWord("   ", "zh-CN")).rejects.toThrow(
      /dictionary-error-unavailable/,
    );
  });
});
