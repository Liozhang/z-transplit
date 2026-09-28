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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mountTranslatePane } from "../../../src/ui/translatePane";
import { clearTranslationCache } from "../../../src/core/translation/translationEngines";
import { createZoteroMock } from "../../qa/harness/zotero-mock";
import { createFetchMock } from "../../qa/harness/fetch-mock";

const PREFIX = "extensions.zotero.ztransplit.";

/** Zotero 7 的 getString 在无 Fluent 环境回退为带前缀的键本身。 */
const K = {
  action: "ztransplit-pane-translate-action",
  retry: "ztransplit-pane-translate-retry",
  copy: "ztransplit-pane-translate-copy",
  refresh: "ztransplit-pane-translate-refresh",
  translating: "ztransplit-pane-translate-translating",
  placeholder: "ztransplit-pane-translate-placeholder",
  emptySelection: "ztransplit-pane-translate-empty-selection",
  tooLong: "ztransplit-pane-translate-error-too-long",
  notReady: "ztransplit-pane-translate-error-not-ready",
  service: "ztransplit-pane-translate-error-service",
  emptyResult: "ztransplit-pane-translate-error-empty",
  genericError: "ztransplit-pane-translate-error",
  noReader: "ztransplit-pane-translate-no-reader",
  copyFailed: "ztransplit-pane-translate-copy-failed",
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
// honest (a cache hit legitimately means zero network calls).
beforeEach(() => {
  clearTranslationCache();
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

  it("auto=false：idle 给「翻译」按钮，不復读「请选择文本」占位", () => {
    ctx = setup(ENGINE_PREFS, ["hello"]);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.buttons(K.action).length).toBe(1);
    expect(ctx.text(ctx.body)).not.toContain(K.placeholder);
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

  it("无选区时显示占位文案而不是假的空态", () => {
    ctx = setup(ENGINE_PREFS, []);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    expect(ctx.text(ctx.body)).toContain(K.emptySelection);
  });

  it("auto=true：挂载即自动翻译（fetch 打到 custom 端点）", async () => {
    ctx = setup({ ...ENGINE_PREFS, "translate.auto": true }, ["hello"]);
    routeOK(ctx.fm);
    mountTranslatePane({ doc: ctx.doc, body: ctx.body });
    await flush();
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
