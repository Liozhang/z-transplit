// @vitest-environment jsdom
/**
 * B16 — 阅读器翻译面板 DOM 行为测试（src/ui/translatePane.ts）。
 *
 * 端到端驱动：jsdom 文档 + Zotero mock（Reader 选区/Prefs/locale）+ fetch mock
 * （custom 引擎端点）。断言对齐 leadero TranslatePanel 的行为契约，外加
 * z-transplit 的三条能力披露（readiness / 字数预算 / 译器模块加载）：
 *
 *   - 挂载读取当前阅读器选区（_selectionRanges 多段以空行拼接）
 *   - translate.auto 实时读 pref：开=自动翻译，关=idle 给「翻译」按钮
 *   - Enter 触发、IME 合成期不触发（语言未变化时 blur/Enter 不重译）
 *   - 复制失败不清空译文，只在译文下方追加失败提示
 *   - 超 maxChars 显式拒绝（错误里带上限）
 *   - 引擎失败 → error + retry；译文为空 → error（不装成功空态）
 *   - 引擎未就绪 → not-ready 错误（点名缺哪项）
 *   - destroy() 移除 DOM 并在途请求失效
 */
import { JSDOM } from "jsdom";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountTranslatePane } from "../../../src/ui/translatePane";
import {
  clearTranslationCache,
  engineCacheIdentity,
  resetGoogleFallbackForTests,
} from "../../../src/core/translation/translationEngines";
import {
  cacheKey,
  getCachedTranslations,
  setCacheDirForTests,
} from "../../../src/core/translation/translationCache";
import { clearAllWordCards } from "../../../src/core/wordcards/wordCardStore";
import { createZoteroMock } from "../../qa/harness/zotero-mock";
import { createFetchMock } from "../../qa/harness/fetch-mock";
import {
  installIOUTilsShim,
  uninstallIOUTilsShim,
} from "../../node/helpers/ioutils-shim";

const PREFIX = "extensions.zotero.ztransplit.";

/** Zotero 7 的 getString 在无 Fluent 环境回退为带前缀的键本身。 */
const K = {
  action: "ztransplit-pane-translate-action",
  retry: "ztransplit-pane-translate-retry",
  copy: "ztransplit-pane-translate-copy",
  refresh: "ztransplit-pane-translate-refresh",
  translating: "ztransplit-pane-translate-translating",
  placeholder: "ztransplit-pane-translate-placeholder",
  resultPlaceholder: "ztransplit-pane-translate-result-placeholder",
  emptySelection: "ztransplit-pane-translate-empty-selection",
  tooLong: "ztransplit-pane-translate-error-too-long",
  notReady: "ztransplit-pane-translate-error-not-ready",
  service: "ztransplit-pane-translate-error-service",
  emptyResult: "ztransplit-pane-translate-error-empty",
  genericError: "ztransplit-pane-translate-error",
  noReader: "ztransplit-pane-translate-no-reader",
  copyFailed: "ztransplit-pane-translate-copy-failed",
  lookup: "ztransplit-pane-translate-lookup-action",
  lookingUp: "ztransplit-pane-translate-looking-up",
  sourceYoudao: "ztransplit-pane-translate-card-source-youdao",
};

interface Ctx {
  dom: JSDOM;
  doc: any;
  body: any;
  z: ReturnType<typeof createZoteroMock>;
  fm: ReturnType<typeof createFetchMock>;
  text(el: any): string;
  buttons(label: string): any[];
  click(label: string): void;
}

function setup(prefs: Record<string, unknown>, selection: string[] | null): Ctx {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "chrome://zotero/content/zoteroPane.xhtml",
  });
  const doc = dom.window.document;
  const body = doc.createElement("div");
  doc.body.appendChild(body);

  const z = createZoteroMock({ locale: "zh-CN", prefs });
  z.install();
  z.reader = selection
    ? { tabID: 1, selectionRanges: selection.map((t) => ({ text: t })) }
    : null;
  (dom.window as any).Zotero = z.Zotero;
  (dom.window as any).Zotero_Tabs = { selectedID: 1 };

  const fm = createFetchMock();
  fm.install();

  return {
    dom,
    doc,
    body,
    z,
    fm,
    text: (el: any) => String(el?.textContent ?? ""),
    buttons: (label: string) =>
      [...doc.querySelectorAll("button")].filter((b: any) => String(b.textContent).includes(label)),
    click: (label: string) => {
      const btn = [...doc.querySelectorAll("button")].find((b: any) =>
        String(b.textContent).includes(label),
      );
      if (!btn) throw new Error(`no button labelled ${label}; buttons: ${[...doc.querySelectorAll("button")].map((b: any) => b.textContent).join("|")}`);
      btn.click();
    },
  };
}

/** Let the pane's async chain (dynamic import → fetch → render) settle. */
async function flush(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const ENGINE_PREFS: Record<string, unknown> = {
  "translate.enabled": true,
  "translate.auto": false,
  "translate.maxChars": 10000,
  "translate.engineType": "custom",
  "translate.custom.apiUrl": "http://127.0.0.1:1/v1",
  "translate.custom.apiKey": "k",
  "translate.custom.model": "m",
};

/** Route the custom engine endpoint to a fixed translation. */
function routeOK(fm: ReturnType<typeof createFetchMock>, translated = "译文"): void {
  fm.route("http://127.0.0.1:1/**").reply(200, {
    choices: [{ message: { content: translated } }],
  });
}

// The engine's LRU translation cache is module-level and survives across tests
// in this file. Clearing it per test keeps each case's fetch-count assertion
// honest (a cache hit legitimately means zero network calls). The word-card
// store keeps an in-memory index too — clear it so chip-strip cases start
// from an empty shelf.
beforeEach(() => {
  clearTranslationCache();
  clearAllWordCards();
});

describe("B16 阅读器翻译面板：选区与自动翻译", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  it("挂载即读选区并显示原文（多段以空行拼接）", () => {
    ctx = setup(ENGINE_PREFS, ["第一段", "第二段"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.text(ctx.body)).toContain("第一段");
    expect(ctx.text(ctx.body)).toContain("第二段");
  });

  it("auto=false：idle 给「翻译」按钮与译文占位框，不复读「请选择文本」占位", () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.buttons(K.action).length).toBe(1);
    expect(ctx.text(ctx.body)).not.toContain(K.placeholder);
    // 译文区作为稳定区块存在：空闲时渲染占位框，而不是等翻译成功才出现
    expect(ctx.text(ctx.body)).toContain(K.resultPlaceholder);
    expect(ctx.doc.querySelectorAll(".ztransplit-tp-result-text").length).toBe(1);
  });

  it("真机回归：reader 为附件 itemID、section 传入父条目 id 时仍能读到选区", () => {
    // Zotero 7.0.15 实测：reader.itemID=2（附件），ItemPaneManager 回调给 item.id=1（父条目）。
    // 严格相等比较会把合法面板拒绝成「未检测到阅读器」——必须接受附件/父条目两种身份。
    ctx = setup(ENGINE_PREFS, ["hello"]);
    ctx.z.reader!.itemID = 2;
    ctx.z.items.set(2, { parentItemID: 1 });
    mountTranslatePane({ doc: ctx.doc, body: ctx.body, itemID: 1 });
    expect(ctx.text(ctx.body)).toContain("hello");
    expect(ctx.text(ctx.body)).not.toContain(K.noReader);
  });

  it("无选区时显示占位文案而不是假的空态，译文区不再整体消失", () => {
    ctx = setup(ENGINE_PREFS, []);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.text(ctx.body)).toContain(K.emptySelection);
    expect(ctx.text(ctx.body)).toContain(K.resultPlaceholder);
    expect(ctx.doc.querySelectorAll(".ztransplit-tp-result-text").length).toBe(1);
    expect(ctx.buttons(K.action).length).toBe(0);
  });

  it("auto=true：挂载即自动翻译（fetch 打到 custom 端点）", async () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.auto": true }, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });

    // Auto-translation runs at mount time and must survive parallel-suite timing:
    // wait for the actual fetch (lazy module import + cacheKey + network) instead
    // of a single fixed tick.
    const deadline = Date.now() + 2000;
    while (ctx.fm.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(ctx.fm.calls.length).toBe(1);
    expect(ctx.fm.calls[0].url).toContain("127.0.0.1");
    expect(ctx.text(ctx.body)).toContain("译文");
  });

  it("点击「翻译」发起请求，成功渲染译文与复制按钮", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.fm.calls.length).toBe(1);
    expect(ctx.text(ctx.body)).toContain("译文");
    expect(ctx.buttons(K.copy).length).toBe(1);
  });

  it("Google 降级激活时，成功译文下方附来源提示", async () => {
    // google 引擎端点失败 → 会话内自动走 Bing 网页接口。译文照常渲染，
    // 但来源要对用户可见：降级激活期间成功结果下方附一行提示。
    resetGoogleFallbackForTests();
    const GOOGLE_PREFS = {
      ...ENGINE_PREFS,
      "translate.engineType": "google",
    };
    delete (GOOGLE_PREFS as any)["translate.custom.apiUrl"];
    delete (GOOGLE_PREFS as any)["translate.custom.apiKey"];
    delete (GOOGLE_PREFS as any)["translate.custom.model"];
    ctx = setup(GOOGLE_PREFS, ["hello"]);
    ctx.fm.route("**/translate_a/single**").reply(500, { message: "blocked" });
    ctx.fm.route("**/www.bing.com/translator**").reply(
      200,
      '<html><script>var _G={Region:"CN",IG:"CE47A2D005A84FF09AA51E7D3B6C25F1"};' +
        'var params_AbusePreventionHelper = [1690000000000,"abuseToken123",3600000];</script>' +
        '<div id="rich_tta" data-iid="translator.5023"></div></html>',
      { "content-type": "text/html" },
    );
    ctx.fm.route("**/ttranslatev3**").reply(200, [
      [
        {
          detectedLanguage: { language: "en" },
          translations: [{ text: "你好", to: "zh-Hans" }],
        },
      ],
    ]);

    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    const deadline = Date.now() + 3000;
    while (ctx.fm.calls.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    await flush();

    expect(ctx.text(ctx.body)).toContain("你好");
    expect(ctx.text(ctx.body)).toContain("ztransplit-pane-translate-fallback-note");
    resetGoogleFallbackForTests();
  });
});

describe("B16 阅读器翻译面板：输入交互", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  function langInput(ctx: Ctx): any {
    const input = ctx.doc.querySelector("input");
    if (!input) throw new Error("no input in pane");
    return input;
  }

  it("目标语言框语言变化后 Enter 触发翻译", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    const input = langInput(ctx);
    // 真实交互：先改成新语言（input 事件同步），再按 Enter 提交
    input.focus();
    input.value = "English";
    input.dispatchEvent(new ctx.dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(ctx.fm.calls.length).toBe(1);
  });

  it("pane-F5 回归：语言未变的 blur 不发请求，保留已成功译文", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.fm.calls.length).toBe(1);
    const input = langInput(ctx);
    // 点入语言框再点出，值未变：不得重译，也不得把成功态冲成 loading
    input.focus();
    input.dispatchEvent(new ctx.dom.window.FocusEvent("blur"));
    await flush();
    expect(ctx.fm.calls.length).toBe(1);
    expect(ctx.text(ctx.body)).toContain("译文");
    expect(ctx.buttons(K.copy).length).toBe(1);
  });

  it("IME 合成期 Enter 不触发翻译", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    const input = langInput(ctx);
    input.dispatchEvent(
      new ctx.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
    );
    await flush();
    expect(ctx.fm.calls.length).toBe(0);
  });

  it("目标语言默认链：偏好 translate.targetLanguage 优先于 Zotero 界面语言", () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.targetLanguage": "fr-FR" }, ["hello"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    // mock 的界面语言是 zh-CN——偏好非空时必须胜出（与双语/分屏/全文翻译同链）
    expect(langInput(ctx).value).toBe("fr-FR");
  });

  it("目标语言默认链：无偏好时回落 Zotero 界面语言", () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(langInput(ctx).value).toBe("zh-CN");
  });

  it("「刷新选区」重新读取阅读器选区", async () => {
    ctx = setup(ENGINE_PREFS, ["旧文本"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    // 用户重新选了一段
    ctx.z.reader = { tabID: 1, selectionRanges: [{ text: "新选区" }] };
    ctx.click(K.refresh);
    await flush();
    expect(ctx.text(ctx.body)).toContain("新选区");
    expect(ctx.text(ctx.body)).not.toContain("旧文本");
  });
});

describe("B16 选区读数过期时以弹窗文本为准（2026-10-09 回归）", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  const AUTO_PREFS = { ...ENGINE_PREFS, "translate.auto": true };

  /** 实时同步有 250 ms 去抖，另加一次请求往返。 */
  async function settleAfterPopup(): Promise<void> {
    await flush(320);
    await flush();
  }

  it("实时同步：范围读数仍是旧单词而弹窗文本为新句子 → 翻译新句子", async () => {
    ctx = setup(AUTO_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    await flush();
    expect(ctx.fm.calls.length).toBe(1); // hello 的挂载即译

    // 用户划了一个长句：弹窗渲染并携带新句子，但 _selectionRanges 仍停在旧
    // 单词（过期场景：新选区落在面板没有读到的那个阅读器视图里）
    ctx.z.fireSelectionPopup("这是一段新句子选区");
    await settleAfterPopup();

    expect(ctx.text(ctx.body)).toContain("这是一段新句子选区");
    expect(ctx.text(ctx.body)).not.toContain("hello");
    expect(ctx.fm.calls.length).toBe(2);
    expect(ctx.fm.calls[1].body).toContain("这是一段新句子选区");
  });

  it("「刷新选区」：范围读数过期时同样采用最近弹窗文本", async () => {
    ctx = setup(AUTO_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    await flush();

    ctx.z.fireSelectionPopup("这是一段新句子选区");
    await settleAfterPopup();
    const callsAfterLiveSync = ctx.fm.calls.length;

    // 清掉引擎缓存，强制刷新真实发请求：请求体必须带句子（弹窗文本），
    // 而不是过期的 "hello"（否则就是旧单词又被查了一遍的回归）
    clearTranslationCache();
    ctx.click(K.refresh);
    await flush();
    expect(ctx.text(ctx.body)).toContain("这是一段新句子选区");
    expect(ctx.text(ctx.body)).not.toContain("hello");
    expect(ctx.fm.calls.length).toBe(callsAfterLiveSync + 1);
    expect(ctx.fm.calls[ctx.fm.calls.length - 1].body).toContain(
      "这是一段新句子选区",
    );
  });

  it("清除选区（点空白）后刷新：空读数生效，残留弹窗文本不复活选区", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.z.fireSelectionPopup("hello"); // 单词的弹窗，与范围读数一致
    await settleAfterPopup();
    expect(ctx.text(ctx.body)).toContain("hello");

    // 用户点空白清除选区：弹窗关闭不发事件，_selectionRanges 变为空
    ctx.z.reader = { tabID: 1, selectionRanges: [] };
    ctx.click(K.refresh);
    await flush();
    expect(ctx.text(ctx.body)).toContain(K.emptySelection);
    expect(ctx.text(ctx.body)).not.toContain("hello");
  });
});

describe("B16 阅读器翻译面板：失败显式披露（失败≠空）", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  it("超 maxChars：显式拒绝且错误里带上限值", async () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.maxChars": 10 }, ["0123456789ABC"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain(K.tooLong);
    expect(ctx.text(ctx.body)).toContain("10");
    expect(ctx.fm.calls.length).toBe(0); // 不发请求
  });

  it("引擎网络失败：error + retry 按钮", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    ctx.fm.route("http://127.0.0.1:1/**").throws(new Error("boom"));
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.buttons(K.retry).length).toBe(1);
  });

  it("译文为空：按失败披露，不留成功空态", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm, "   ");
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain(K.emptyResult);
  });

  it("引擎未就绪（custom 缺 apiUrl）：not-ready 错误，不发请求", async () => {
    ctx = setup(
      {
        "translate.enabled": true,
        "translate.auto": false,
        "translate.maxChars": 10000,
        "translate.engineType": "custom",
        "translate.custom.apiKey": "k",
      },
      ["hello"],
    );
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain(K.notReady);
    expect(ctx.fm.calls.length).toBe(0);
  });

  it("pane-F6 回归：复制失败不清空译文，追加可见失败提示", async () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain("译文");
    // 测试环境三级复制链路全失败（mock 无 Zotero clipboard，jsdom 无
    // navigator.clipboard / execCommand），点「复制」必走失败分支
    ctx.click(K.copy);
    await flush();
    expect(ctx.text(ctx.body)).toContain("译文"); // 结果未被丢弃
    expect(ctx.text(ctx.body)).toContain(K.copyFailed); // 失败提示可见
    expect(ctx.buttons(K.retry).length).toBe(0); // 仍是 success，而非 error
    expect(ctx.buttons(K.copy).length).toBe(1); // 复制按钮还在
  });
});

describe("B16 阅读器翻译面板：生命周期", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  it("destroy() 移除 DOM 与样式，在途请求不再渲染", async () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.auto": true }, ["hello"]);
    // 延迟回复：destroy 发生在 fetch 落地前
    ctx.fm.route("http://127.0.0.1:1/**").reply(200, { choices: [{ message: { content: "译文" } }] }, );
    const handle = mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    handle.destroy();
    await flush(60);
    expect(ctx.body.childNodes.length).toBe(0);
    expect(ctx.doc.querySelectorAll("style.ztransplit-tp-style").length).toBe(0);
  });

  it("同一 body 重复挂载是幂等的（刷新而非重建）", () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    const first = mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    const nodes = ctx.body.childNodes.length;
    const second = mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(second).toBe(first);
    expect(ctx.body.childNodes.length).toBe(nodes); // 没有重复渲染
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 词卡：单词选区走词典链（src/core/translation/dictionaryCard.ts）
// ─────────────────────────────────────────────────────────────────────────────

/** 有道英汉响应，按 2026-09-29 真机实测形状精简。 */
const YOUDAO_EN = {
  simple: { word: [{ word: "resonance", usphone: "ˈrezənəns" }] },
  ec: {
    word: [{ trs: [{ tr: [{ l: { i: ["n. 共鸣；（物理）共振"] } }] }] }],
  },
  blng_sents_part: {
    "sentence-pair": [
      {
        "sentence-eng": "The city resonates with history.",
        "sentence-translation": "这座城市回荡着历史的回声。",
      },
    ],
  },
};

function routeYoudao(fm: ReturnType<typeof createFetchMock>): void {
  fm.route("https://dict.youdao.com/**").reply(200, YOUDAO_EN);
}

describe("词卡：单词选区走词典链", () => {
  let ctx: Ctx;
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
  });

  it("单词选区 idle 给「查询」按钮，点击渲染词典卡片（音标+释义+例句+来源）", async () => {
    ctx = setup(
      { ...ENGINE_PREFS, "wordcards.enabled": true },
      ["resonance"],
    );
    routeYoudao(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.buttons(K.lookup).length).toBe(1);
    ctx.click(K.lookup);
    await flush();
    const text = ctx.text(ctx.body);
    expect(text).toContain("resonance");
    expect(text).toContain("ˈrezənəns");
    expect(text).toContain("共鸣");
    expect(text).toContain("这座城市回荡着历史的回声。");
    expect(text).toContain(K.sourceYoudao);
    expect(ctx.buttons(K.copy).length).toBe(1);
  });

  it("查词成功后自动入库：最近查词词块行出现当前词", async () => {
    ctx = setup(
      { ...ENGINE_PREFS, "wordcards.enabled": true },
      ["resonance"],
    );
    routeYoudao(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.lookup);
    await flush(60); // 查询 + 入库 + 词块刷新三段异步
    const chips = ctx.doc.querySelector(".ztransplit-tp-chips");
    expect(chips).not.toBeNull();
    expect((chips as any).hidden).toBe(false);
    expect(ctx.text(chips)).toContain("resonance");
  });

  it("查词不做引擎就绪前置检查：未配置引擎时有道层照样出卡", async () => {
    ctx = setup(
      {
        "translate.enabled": true,
        "translate.auto": false,
        "translate.engineType": "custom",
        "wordcards.enabled": true,
      },
      ["resonance"],
    );
    routeYoudao(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.lookup);
    await flush();
    expect(ctx.text(ctx.body)).toContain("ˈrezənəns");
    expect(ctx.fm.calls.length).toBe(1); // 只打了有道
  });

  it("wordcards.enabled=false：单词选区保持普通翻译路径", async () => {
    ctx = setup(
      { ...ENGINE_PREFS, "wordcards.enabled": false },
      ["resonance"],
    );
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.buttons(K.action).length).toBe(1);
    expect(ctx.buttons(K.lookup).length).toBe(0);
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain("译文");
    expect(ctx.fm.calls[0].url).toContain("127.0.0.1");
  });

  it("有道失败降级到 MT 简卡，卡片标注翻译来源", async () => {
    ctx = setup(
      { ...ENGINE_PREFS, "wordcards.enabled": true },
      ["resonance"],
    );
    ctx.fm.route("https://dict.youdao.com/**").reply(500, { error: "down" });
    routeOK(ctx.fm, "共振");
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.lookup);
    // 降级链路含模型层 chatJson 的一次 500ms 重试退避，等待要覆盖它
    await flush(1200);
    expect(ctx.text(ctx.body)).toContain("共振");
    expect(ctx.text(ctx.body)).toContain(
      "ztransplit-pane-translate-card-source-mt",
    );
  });

  it("词块点击离线重画存储卡片，不打网络", async () => {
    ctx = setup(
      { ...ENGINE_PREFS, "wordcards.enabled": true },
      ["resonance"],
    );
    routeYoudao(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    ctx.click(K.lookup);
    await flush(60);
    expect(ctx.fm.calls.length).toBe(1);

    // 换成句子选区，走普通翻译
    ctx.z.reader = { tabID: 1, selectionRanges: [{ text: "hello world" }] };
    routeOK(ctx.fm);
    ctx.click(K.refresh);
    await flush();
    expect(ctx.buttons(K.action).length).toBe(1);
    ctx.click(K.action);
    await flush();
    expect(ctx.text(ctx.body)).toContain("译文");
    const callsAfterSentence = ctx.fm.calls.length;

    // 点词块 → 卡片回来，零新增网络请求
    const chip = [...ctx.doc.querySelectorAll(".ztransplit-tp-chip")].find(
      (c: any) => String(c.textContent) === "resonance",
    );
    expect(chip).toBeTruthy();
    (chip as any).click();
    await flush();
    expect(ctx.fm.calls.length).toBe(callsAfterSentence);
    expect(ctx.text(ctx.body)).toContain("ˈrezənəns");
    expect(ctx.text(ctx.body)).toContain(K.sourceYoudao);
  });
});

describe("B16 划词翻译：持久段落缓存（与 PDF 管线 / 双语对照共用同一存储）", () => {
  let ctx: Ctx | undefined;
  let cacheDir: string;
  beforeEach(() => {
    // 真实读写一个临时缓存目录：断言的是磁盘记录与命中行为，不是内存桩。
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ztransplit-pane-cache-"));
    setCacheDirForTests(cacheDir);
    installIOUTilsShim();
    clearTranslationCache();
    clearAllWordCards();
  });
  afterEach(() => {
    ctx?.fm.uninstall();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
    setCacheDirForTests(null);
    uninstallIOUTilsShim();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("翻译成功后写入与管线同键的缓存记录", async () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.auto": true }, [
      "persistent paragraph",
    ]);
    routeOK(ctx.fm, "已缓存译文");
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    await flush(80);
    expect(ctx.text(ctx.body)).toContain("已缓存译文");

    // 键空间与管线一致：引擎指纹 + auto 源语言 + 目标语言 + 原文
    const key = await cacheKey(
      engineCacheIdentity(),
      "auto",
      "zh-CN",
      "persistent paragraph",
    );
    const hits = await getCachedTranslations([key]);
    expect(hits.get(key)).toBe("已缓存译文");
  });

  it("同一文本再次翻译命中缓存：不再发网络请求", async () => {
    // 第一次：真实翻译并落盘（1 次网络请求）
    ctx = setup({ ...ENGINE_PREFS, "translate.auto": true }, ["repeat me"]);
    routeOK(ctx.fm, "缓存命中译文");
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    await flush(80);
    expect(ctx.fm.calls.length).toBe(1);

    // 清掉内存 LRU，强制第二块面板走磁盘层；同一选区文本应直接命中。
    clearTranslationCache();
    const body2 = ctx.doc.createElement("div");
    ctx.doc.body.appendChild(body2);
    mountTranslatePane({ doc: ctx.doc, body: body2 });
    await flush(80);
    expect(String(body2.textContent)).toContain("缓存命中译文");
    expect(ctx.fm.calls.length).toBe(1); // 未新增网络请求
  });
});
