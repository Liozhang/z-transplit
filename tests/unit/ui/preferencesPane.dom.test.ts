// @vitest-environment jsdom
/**
 * B17 — Zotero 设置 pane 行为测试（addon/content/preferences.xhtml + preferences.js）。
 *
 * 在 jsdom 里以 XML 模式加载真实 pane 标记，桩掉 Zotero 全局后执行真实的
 * preferences.js，再驱动 onLoad / 事件，断言：
 *   - 引擎下拉切换时字段组的显隐（只切 hidden 属性，不重建 DOM）
 *   - zotero-pdf-translate 安装状态探测（装了/没装两条路径）
 *   - maxChars / ODL timeout 输入校验（越界报错、失焦恢复旧值、合法写回 pref）
 *   - AI prompt 模板校验（非法不写 pref、失焦恢复、恢复默认、与 TS 权威实现同判）
 *   - 字体覆盖目录路径回显
 *   - FTL 消息形式与 xhtml 控件匹配（带 value 的 label→.value，
 *     menuitem/checkbox→.label，双语键集合一致）
 *
 * 这是设置界面「适配 Zotero 的良好可视化」里唯一可在无 Zotero 环境确定性
 * 验证的部分；真实 XUL 渲染观感属于本环境无法覆盖项（见测试报告 notCovered）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validatePromptTemplate } from "../../../src/core/translation/promptTemplate";

const ROOT = join(__dirname, "..", "..", "..");
const XHTML_FRAGMENT = readFileSync(join(ROOT, "addon/content/preferences.xhtml"), "utf8");
const PREFS_JS = readFileSync(join(ROOT, "addon/content/preferences.js"), "utf8");
const EN_FTL = readFileSync(join(ROOT, "addon/locale/en-US/ztransplit-preferences.ftl"), "utf8");
const ZH_FTL = readFileSync(join(ROOT, "addon/locale/zh-CN/ztransplit-preferences.ftl"), "utf8");

// The shipped fragment deliberately declares no namespaces: Zotero parses it
// through Zotero_Preferences._loadPane's defaultXUL branch, which supplies the
// XUL default namespace and the html: prefix. The test reproduces exactly that
// context by wrapping the fragment in a root that binds both. The fragment's
// own `<?xml?>` declaration is dropped — it may only stand at document start.
const XHTML = `<ztransplit-pane-root
  xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
  xmlns:html="http://www.w3.org/1999/xhtml"
>${XHTML_FRAGMENT.replace(/^<\?xml[^>]*\?>/, "")}</ztransplit-pane-root>`;

const PREFIX = "extensions.zotero.ztransplit.";

interface Harness {
  dom: JSDOM;
  window: any;
  doc: any;
  /** Switch the engine menulist and fire the events preferences.js listens to. */
  selectEngine(value: string): void;
  /** Read the pref map the stub Zotero.Prefs backed. */
  prefs: Map<string, unknown>;
}

function setupHarness(opts: { pdfTranslate?: boolean; prefs?: Record<string, unknown> } = {}): Harness {
  const dom = new JSDOM(XHTML, { contentType: "text/xml", url: "chrome://ztransplit/content/preferences.xhtml" });
  const { window } = dom;
  const prefs = new Map<string, unknown>(Object.entries(opts.prefs ?? {}));

  (window as any).Zotero = {
    debug: () => {},
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => {
        prefs.set(key, value);
      },
    },
    DataDirectory: { dir: "/tmp/zotero-data" },
    PDFTranslate: opts.pdfTranslate
      ? { api: { translate: async () => ({ status: "success", result: "x" }) } }
      : null,
  };

  // preferences.js is an IIFE that reads `window`/`Zotero`/`document` from the
  // jsdom global scope; evaluate it inside the window so its closures bind to
  // this document. jsdom's eval scope does not expose `window` as a name (and
  // `window` itself is a getter-only accessor), so the script is wrapped in a
  // function that receives them as parameters.
  const evalPaneScript = window.eval(
    `(function (window, document, Zotero) {\n${PREFS_JS}\n})`,
  ) as (w: unknown, d: unknown, z: unknown) => void;
  evalPaneScript(window, window.document, (window as any).Zotero);
  (window as any).ZTransplitPrefs.onLoad();

  const doc = window.document;
  return {
    dom,
    window,
    doc,
    prefs,
    selectEngine(value: string) {
      const list = doc.getElementById("ztransplit-pref-engine-type");
      if (!list) throw new Error("engine menulist not found");
      list.value = value;
      for (const type of ["select", "command"]) {
        list.dispatchEvent(new window.Event(type, { bubbles: true }));
      }
    },
  };
}

function isVisible(doc: any, id: string): boolean {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`element #${id} not found`);
  return !el.hasAttribute("hidden");
}

/** 驱动一次「输入 → 失焦（change）」序列，返回输入框。 */
function fireInputAndChange(h: Harness, id: string, value: string): any {
  const input = h.doc.getElementById(id);
  if (!input) throw new Error(`element #${id} not found`);
  input.value = value;
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  return input;
}

/**
 * 解析 FTL 文本：消息 id -> 其上声明的属性名集合（.label / .value 等）。
 * 只识别本文件使用的两种形式——顶层消息（`key =`）与 4 空格缩进的属性
 * （`    .attr =`）；续行与注释行忽略。
 */
function parseFtlAttributes(text: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const attr = /^ {4}\.([a-zA-Z][a-zA-Z0-9-]*)\s*=/.exec(line);
    if (attr && current) {
      map.get(current)!.add(attr[1]);
      continue;
    }
    const msg = /^([a-zA-Z][a-zA-Z0-9-]*)\s*=/.exec(line);
    if (msg) {
      current = msg[1];
      if (!map.has(current)) map.set(current, new Set());
    }
  }
  return map;
}

describe("B17 设置 pane：引擎字段条件显隐", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  it("默认（google）只显示 Google 字段组，其余隐藏", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.engineType`]: "google" } });
    expect(isVisible(h.doc, "ztransplit-pref-engine-google")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-engine-bing")).toBe(false);
    expect(isVisible(h.doc, "ztransplit-pref-engine-deepl")).toBe(false);
    expect(isVisible(h.doc, "ztransplit-pref-engine-custom")).toBe(false);
  });

  it("menulist 缺 value 时回退读取 translate.engineType 偏好", () => {
    // 不预设 engineType：jsdom 里 menulist.value 为空 → 代码回退到 pref 回退链
    h = setupHarness({ prefs: { [`${PREFIX}translate.engineType`]: "deepl" } });
    expect(isVisible(h.doc, "ztransplit-pref-engine-deepl")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-engine-google")).toBe(false);
  });

  it("切换到 bing：显示 Bing 组并隐藏 Google 组（只切 hidden，不重建 DOM）", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.engineType`]: "google" } });
    const before = h.doc.getElementById("ztransplit-pref-engine-bing");
    h.selectEngine("bing");
    expect(isVisible(h.doc, "ztransplit-pref-engine-bing")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-engine-google")).toBe(false);
    // 同一节点被显隐，没有被替换
    expect(h.doc.getElementById("ztransplit-pref-engine-bing")).toBe(before);
  });

  it("切换到 custom：显示 OpenAI 兼容端点字段组", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.engineType`]: "google" } });
    h.selectEngine("custom");
    expect(isVisible(h.doc, "ztransplit-pref-engine-custom")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-engine-google")).toBe(false);
  });

  it("切换到 ai：显示 AI 字段组（含 prompt 模板编辑区）", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.engineType`]: "google" } });
    h.selectEngine("ai");
    expect(isVisible(h.doc, "ztransplit-pref-engine-ai")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-engine-google")).toBe(false);
    expect(h.doc.getElementById("ztransplit-pref-ai-prompt")).toBeTruthy();
    expect(h.doc.getElementById("ztransplit-pref-ai-prompt-restore")).toBeTruthy();
  });
});

describe("B17 设置 pane：AI prompt 模板校验（prefs-AI1..AI4）", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  const AI_PROMPT_KEY = `${PREFIX}translate.ai.prompt`;
  const VALID = "from {{sourceLang}} to {{targetLang}}: {{text}}";

  it("初始值来自偏好写入模板编辑区", () => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: VALID } });
    expect(String(h.doc.getElementById("ztransplit-pref-ai-prompt").value)).toBe(
      VALID,
    );
  });

  it("留空（内置默认模板）是合法初始态：无错误提示", () => {
    h = setupHarness({ prefs: {} });
    expect(String(h.doc.getElementById("ztransplit-pref-ai-prompt").value)).toBe("");
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(false);
  });

  it("合法模板：错误提示隐藏，值写回偏好", () => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: "" } });
    const input = h.doc.getElementById("ztransplit-pref-ai-prompt");
    input.value = VALID;
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(false);
    expect(h.prefs.get(AI_PROMPT_KEY)).toBe(VALID);
  });

  it("非法模板：显示对应原因的不落地提示，且不写坏值", () => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: VALID } });
    const input = h.doc.getElementById("ztransplit-pref-ai-prompt");
    input.value = "从 {{sourceLang}} 译到 {{targetLang}}：{{txt}}";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(true);
    // 半成品值不得落进 pref（与 maxChars 同一策略）
    expect(h.prefs.get(AI_PROMPT_KEY)).toBe(VALID);
    // 提示文案来自隐藏的本地化节点，不是 JS 写死的字符串
    const expected = h.doc
      .getElementById("ztransplit-pref-string-ai-prompt-unknown-placeholder")
      .textContent.trim();
    expect(
      h.doc.getElementById("ztransplit-pref-ai-prompt-error").textContent.trim(),
    ).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
    expect(
      h.doc.getElementById("ztransplit-pref-ai-prompt").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it.each([
    ["缺 {{text}}", "从 {{sourceLang}} 译到 {{targetLang}}", "missing-text"],
    ["{{text}} 重复", "{{text}} 从 {{sourceLang}} 到 {{targetLang}}: {{text}}", "duplicate-text"],
    ["缺 {{sourceLang}}", "译到 {{targetLang}}：{{text}}", "missing-source-lang"],
    ["缺 {{targetLang}}", "从 {{sourceLang}} 译：{{text}}", "missing-target-lang"],
    ["花括号不成对", "从 {{sourceLang}} 译到 {{targetLang}}：{{text}", "unbalanced-braces"],
  ])("非法模板 %s：提示 %s 原因且不写坏值", (_label, raw, reason) => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: VALID } });
    const input = h.doc.getElementById("ztransplit-pref-ai-prompt");
    input.value = raw;
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(true);
    expect(h.prefs.get(AI_PROMPT_KEY)).toBe(VALID);
    const expected = h.doc
      .getElementById(`ztransplit-pref-string-ai-prompt-${reason}`)
      .textContent.trim();
    expect(
      h.doc.getElementById("ztransplit-pref-ai-prompt-error").textContent.trim(),
    ).toBe(expected);
  });

  it("非法模板失焦：恢复当前 pref 值且不改写设置（与文案承诺一致）", () => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: VALID } });
    const input = h.doc.getElementById("ztransplit-pref-ai-prompt");
    input.value = "broken {{txt}}";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    expect(String(input.value)).toBe(VALID);
    expect(h.prefs.get(AI_PROMPT_KEY)).toBe(VALID);
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(false);
    expect(
      h.doc.getElementById("ztransplit-pref-ai-prompt").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("「恢复默认模板」按钮：写空串（= 内置默认模板）并清空编辑区", () => {
    h = setupHarness({ prefs: { [AI_PROMPT_KEY]: VALID } });
    (h.window as any).ZTransplitPrefs.restoreDefaultPrompt();
    expect(h.prefs.get(AI_PROMPT_KEY)).toBe("");
    expect(String(h.doc.getElementById("ztransplit-pref-ai-prompt").value)).toBe("");
    expect(isVisible(h.doc, "ztransplit-pref-ai-prompt-error")).toBe(false);
  });

  it("面板 JS 的校验与 TS 权威实现同判（样例矩阵，含每种拒绝原因）", () => {
    // preferences.js 里的规则是 promptTemplate.ts 的镜像实现；两份必须对同一
    // 输入给出一致判定，否则面板说「合法」而引擎报错的割裂体验会漏到用户面前。
    const samples: Array<[string, string]> = [
      ["空串（默认模板）", ""],
      ["纯空白", "   \n "],
      ["合法模板", VALID],
      ["占位符带空格", "from {{ sourceLang }} to {{targetLang }}: {{ text }}"],
      ["含公式标记仍是合法内容", "译到 {{targetLang}} 从 {{sourceLang}}: {{text}} 保留 {v0}、{v1}"],
      ["拼错占位符", "从 {{sourceLang}} 到 {{targetLang}}: {{txt}}"],
      ["缺 {{text}}", "从 {{sourceLang}} 到 {{targetLang}}"],
      ["{{text}} 重复", "{{text}} 从 {{sourceLang}} 到 {{targetLang}}: {{text}}"],
      ["缺 {{sourceLang}}", "到 {{targetLang}}: {{text}}"],
      ["缺 {{targetLang}}", "从 {{sourceLang}}: {{text}}"],
      ["花括号不成对", "从 {{sourceLang}} 到 {{targetLang}}: {{text}"],
      ["超长", `x{{text}}${"y".repeat(4000)}`],
    ];
    h = setupHarness({ prefs: {} });
    const input = h.doc.getElementById("ztransplit-pref-ai-prompt");
    for (const [label, raw] of samples) {
      const before = h.prefs.get(AI_PROMPT_KEY);
      input.value = raw;
      input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
      const paneSaysValid = !isVisible(h.doc, "ztransplit-pref-ai-prompt-error");
      const tsSaysValid = validatePromptTemplate(raw).ok;
      expect(paneSaysValid, `样例「${label}」两边判定不一致`).toBe(tsSaysValid);
      // 合法才写回，非法则保持原值（半成品值不落盘）
      expect(h.prefs.get(AI_PROMPT_KEY)).toBe(tsSaysValid ? raw : before);
    }
  });
});

describe("B17 设置 pane：zotero-pdf-translate 探测", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  it("插件缺失：显示「未安装」提示，隐藏「已安装」提示，下拉项标注缺失文案", () => {
    h = setupHarness({ pdfTranslate: false });
    expect(isVisible(h.doc, "ztransplit-pref-pdftranslate-missing")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-pdftranslate-installed")).toBe(false);
    const item = h.doc.getElementById("ztransplit-pref-engine-item-pdftranslate");
    // 标签被同步为缺失文案（非空）
    expect(String(item.getAttribute("label") || "").length).toBeGreaterThan(0);
  });

  it("插件存在：显示「已安装」提示，隐藏「未安装」提示", () => {
    h = setupHarness({ pdfTranslate: true });
    expect(isVisible(h.doc, "ztransplit-pref-pdftranslate-installed")).toBe(true);
    expect(isVisible(h.doc, "ztransplit-pref-pdftranslate-missing")).toBe(false);
  });
});

describe("B17 设置 pane：maxChars 校验", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  it("初始值来自偏好并写入输入框", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.maxChars`]: 4321 } });
    const input = h.doc.getElementById("ztransplit-pref-maxchars");
    expect(String(input.value)).toBe("4321");
  });

  it("越界输入：显示错误提示，不写坏值", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.maxChars`]: 10000 } });
    const input = h.doc.getElementById("ztransplit-pref-maxchars");
    input.value = "999999"; // 超过 50000 上限
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(isVisible(h.doc, "ztransplit-pref-maxchars-error")).toBe(true);
    // 坏值不得落进 pref
    expect(h.prefs.get(`${PREFIX}translate.maxChars`)).toBe(10000);
  });

  it("合法输入：错误提示隐藏，值写回偏好", () => {
    h = setupHarness({ prefs: { [`${PREFIX}translate.maxChars`]: 10000 } });
    const input = h.doc.getElementById("ztransplit-pref-maxchars");
    input.value = "20000";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    expect(isVisible(h.doc, "ztransplit-pref-maxchars-error")).toBe(false);
    expect(h.prefs.get(`${PREFIX}translate.maxChars`)).toBe(20000);
  });
});

describe("B17 设置 pane：maxChars 失焦恢复（prefs-F4）", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  // 与文案承诺一致：非法输入（非纯整数 / 越界 / 负数 / 空串）失焦时恢复为
  // 当前 pref 值，绝不夹紧后改写设置。
  it.each(["999999", "50", "100.5", "-5", ""])(
    "非法值 %s 失焦后恢复旧值且不改写偏好",
    (raw) => {
      h = setupHarness({ prefs: { [`${PREFIX}translate.maxChars`]: 10000 } });
      const input = fireInputAndChange(h, "ztransplit-pref-maxchars", raw);
      expect(String(input.value)).toBe("10000");
      expect(h.prefs.get(`${PREFIX}translate.maxChars`)).toBe(10000);
      // 恢复后错误提示隐藏
      expect(isVisible(h.doc, "ztransplit-pref-maxchars-error")).toBe(false);
    },
  );
});

describe("B17 设置 pane：ODL timeout 校验（prefs-F5）", () => {
  let h: Harness;
  afterEach(() => {
    h?.dom.window.close();
  });

  it("合法值：错误提示隐藏并写入偏好", () => {
    h = setupHarness({
      prefs: { [`${PREFIX}pdfParser.opendataloader.timeout`]: 300 },
    });
    const input = fireInputAndChange(h, "ztransplit-pref-odl-timeout", "600");
    expect(isVisible(h.doc, "ztransplit-pref-odl-timeout-error")).toBe(false);
    expect(h.prefs.get(`${PREFIX}pdfParser.opendataloader.timeout`)).toBe(600);
    expect(String(input.value)).toBe("600");
  });

  it.each(["999999", "10", "100.5", "-5", ""])(
    "非法值 %s 失焦后恢复旧值且不改写偏好",
    (raw) => {
      h = setupHarness({
        prefs: { [`${PREFIX}pdfParser.opendataloader.timeout`]: 300 },
      });
      const input = fireInputAndChange(h, "ztransplit-pref-odl-timeout", raw);
      expect(String(input.value)).toBe("300");
      expect(h.prefs.get(`${PREFIX}pdfParser.opendataloader.timeout`)).toBe(300);
      expect(isVisible(h.doc, "ztransplit-pref-odl-timeout-error")).toBe(false);
    },
  );
});

describe("B17 设置 pane：FTL 消息形式与 xhtml 控件匹配（prefs-F1/F2）", () => {
  const enFtl = parseFtlAttributes(EN_FTL);
  const zhFtl = parseFtlAttributes(ZH_FTL);

  /** 收集 xhtml 里全部 data-l10n-id 及其标签名 / 是否带静态 value。 */
  function l10nBindings(): Array<{ id: string; tag: string; hasValue: boolean }> {
    const h = setupHarness({});
    const rows: Array<{ id: string; tag: string; hasValue: boolean }> = [];
    for (const el of h.doc.querySelectorAll("[data-l10n-id]")) {
      rows.push({
        id: el.getAttribute("data-l10n-id")!,
        tag: String(el.tagName).toLowerCase(),
        hasValue: el.hasAttribute("value"),
      });
    }
    h.dom.window.close();
    return rows;
  }

  it("en-US 与 zh-CN 的消息键集合完全一致", () => {
    expect([...zhFtl.keys()].sort()).toEqual([...enFtl.keys()].sort());
  });

  it("每个 data-l10n-id 在两份 FTL 中都有定义", () => {
    const rows = l10nBindings();
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(enFtl.has(row.id), `en-US 缺少 ${row.id}`).toBe(true);
      expect(zhFtl.has(row.id), `zh-CN 缺少 ${row.id}`).toBe(true);
    }
  });

  it("带静态 value 的 XUL label 两语言都写 .value（纯文本只写 textContent，替换不了 value）", () => {
    const labels = l10nBindings().filter((r) => r.tag === "label" && r.hasValue);
    // 25 = 24 原有（23 + 解析组件小节行标签）+ AI 服务商行标签。
    expect(labels.length).toBe(25);
    for (const row of labels) {
      expect(enFtl.get(row.id)!.has("value"), `en-US ${row.id} 应写 .value`).toBe(true);
      expect(zhFtl.get(row.id)!.has("value"), `zh-CN ${row.id} 应写 .value`).toBe(true);
    }
  });

  it("22 个 menuitem 两语言都写 .label（XUL menuitem 只渲染 label 属性）", () => {
    const items = l10nBindings().filter((r) => r.tag === "menuitem");
    // 22 = 7 原有引擎项 + 10 个 AI 服务商预设项 + 5 个 Bing 区域项。
    expect(items.length).toBe(22);
    for (const row of items) {
      expect(enFtl.get(row.id)!.has("label"), `en-US ${row.id} 应写 .label`).toBe(true);
      expect(zhFtl.get(row.id)!.has("label"), `zh-CN ${row.id} 应写 .label`).toBe(true);
    }
  });

  it("checkbox 两语言都写 .label", () => {
    const boxes = l10nBindings().filter((r) => r.tag === "checkbox");
    // 13 = 11 原有 + 词卡开关 + 原文删除开关（preferences-ztransplit-pdf-removal-enabled）。
    expect(boxes.length).toBe(13);
    for (const row of boxes) {
      expect(enFtl.get(row.id)!.has("label"), `en-US ${row.id} 应写 .label`).toBe(true);
      expect(zhFtl.get(row.id)!.has("label"), `zh-CN ${row.id} 应写 .label`).toBe(true);
    }
  });
});

describe("B17 设置 pane：PDF 字体覆盖目录回显", () => {
  it("assetsDir 把数据目录写进提示节点", () => {
    const h = setupHarness({});
    const node = h.doc.getElementById("ztransplit-pref-pdf-fonts-path");
    expect(node).toBeTruthy();
    expect(String(node.textContent)).toContain("zotero-data");
    h.dom.window.close();
  });
});

// ── Java 运行库：状态检测 + 安装/修复按钮 ─────────────────────────────────
//
// 修复「一次 Java 安装失败后全插件无入口可用」时加入的主动入口。面板通过
// Zotero.ZTransplit.java（主包暴露）检测与安装；这里用桩验证回显与按钮态。

type JavaStatusStub = {
  ready: boolean;
  version?: string;
  managed?: boolean;
  error?: string;
};

interface JavaHarness extends Harness {
  /** Click a Java button and wait out the promise chain preferences.js runs. */
  clickJava(id: string): Promise<void>;
}

function setupJavaHarness(java?: {
  getStatus?: () => JavaStatusStub | Promise<JavaStatusStub>;
  install?: () => Promise<boolean>;
}): JavaHarness {
  const h = setupHarness({});
  const zt = (h.window as any).Zotero;
  zt.ZTransplit = java ? { java } : undefined;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    ...h,
    async clickJava(id: string) {
      const btn = h.doc.getElementById(id);
      if (!btn) throw new Error(`element #${id} not found`);
      btn.dispatchEvent(new h.window.Event("command", { bubbles: true }));
      // 覆盖 onJavaInstall 的安装 await + 刷新 await 两层链。
      await flush();
      await flush();
    },
  };
}

describe("B17 设置 pane：Java 运行库状态行与按钮", () => {
  it("主包未挂载：点击检测显示引导文案，不抛错", async () => {
    const h = setupJavaHarness(undefined);
    await h.clickJava("ztransplit-pref-pdf-java-check");
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("插件主包未加载");
    h.dom.window.close();
  });

  it("ready + managed：显示版本与「插件管理」标注", async () => {
    const h = setupJavaHarness({
      getStatus: async () => ({
        ready: true,
        version: "17.0.12",
        managed: true,
      }),
    });
    await h.clickJava("ztransplit-pref-pdf-java-check");
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("17.0.12");
    expect(String(status.textContent)).toContain("插件管理");
    h.dom.window.close();
  });

  it("ready + 系统 Java：标注为系统安装", async () => {
    const h = setupJavaHarness({
      getStatus: async () => ({ ready: true, version: "21.0.1", managed: false }),
    });
    await h.clickJava("ztransplit-pref-pdf-java-check");
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("21.0.1");
    expect(String(status.textContent)).toContain("系统安装");
    h.dom.window.close();
  });

  it("未就绪：显示缺失引导（错误详情不上墙，界面保持双语）", async () => {
    const h = setupJavaHarness({
      getStatus: async () => ({
        ready: false,
        error: "Java runtime not found. Please install Java 11+ …",
      }),
    });
    await h.clickJava("ztransplit-pref-pdf-java-check");
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("未检测到");
    expect(String(status.textContent)).not.toContain("Please install");
    h.dom.window.close();
  });

  it("安装：点击后按钮禁用并切到「正在安装」，完成后恢复并刷新为可用状态", async () => {
    let installed = false;
    const h = setupJavaHarness({
      getStatus: async () =>
        installed
          ? { ready: true, version: "17.0.12", managed: true }
          : { ready: false },
      install: async () => {
        installed = true;
        return true;
      },
    });
    const installBtn = h.doc.getElementById("ztransplit-pref-pdf-java-install")!;
    await h.clickJava("ztransplit-pref-pdf-java-install");
    expect(installed).toBe(true);
    expect(installBtn.hasAttribute("disabled")).toBe(false);
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("17.0.12");
    h.dom.window.close();
  });

  it("安装失败（resolve false）：恢复按钮，状态行回到缺失引导", async () => {
    const h = setupJavaHarness({
      getStatus: async () => ({ ready: false }),
      install: async () => false,
    });
    const installBtn = h.doc.getElementById("ztransplit-pref-pdf-java-install")!;
    await h.clickJava("ztransplit-pref-pdf-java-install");
    expect(installBtn.hasAttribute("disabled")).toBe(false);
    const status = h.doc.getElementById("ztransplit-pref-pdf-java-status")!;
    expect(String(status.textContent)).toContain("未检测到");
    h.dom.window.close();
  });
});

// ── 解析组件：状态检测 + 下载/修复按钮 ─────────────────────────────────────
//
// 与 Java 小节同一套路：面板通过 Zotero.ZTransplit.odlJar（主包暴露）检测与
// 下载修复；这里用桩验证回显与按钮态。这一节是「精简版升级后组件缺失仍提示
// 重新安装插件」的手动出口：按钮必须存在、失败必须把细节上墙。

type OdlStatusStub = {
  present: boolean;
  version?: string;
  source?: "landed" | "bundled";
  path?: string;
  stale?: boolean;
};

interface OdlHarness extends Harness {
  /** Click an ODL button and wait out the promise chain preferences.js runs. */
  clickOdl(id: string): Promise<void>;
}

function setupOdlHarness(odl?: {
  getStatus?: () => OdlStatusStub | Promise<OdlStatusStub>;
  install?: () => Promise<string>;
}): OdlHarness {
  const h = setupHarness({});
  const zt = (h.window as any).Zotero;
  zt.ZTransplit = odl ? { odlJar: odl } : undefined;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    ...h,
    async clickOdl(id: string) {
      const btn = h.doc.getElementById(id);
      if (!btn) throw new Error(`element #${id} not found`);
      btn.dispatchEvent(new h.window.Event("command", { bubbles: true }));
      // 覆盖 onOdlDownload 的安装 await + 刷新 await 两层链。
      await flush();
      await flush();
    },
  };
}

describe("B17 设置 pane：解析组件状态行与按钮", () => {
  it("主包未挂载：点击检测显示引导文案，不抛错", async () => {
    const h = setupOdlHarness(undefined);
    await h.clickOdl("ztransplit-pref-odl-comp-check");
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("插件主包未加载");
    h.dom.window.close();
  });

  it("就绪 + 数据目录副本：显示版本与落地标注", async () => {
    const h = setupOdlHarness({
      getStatus: async () => ({
        present: true,
        version: "2.5.0",
        source: "landed",
        path: "/tmp/zotero-data/ztransplit/lib/opendataloader-pdf-cli.jar",
      }),
    });
    await h.clickOdl("ztransplit-pref-odl-comp-check");
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("2.5.0");
    expect(String(status.textContent)).toContain("数据目录");
    h.dom.window.close();
  });

  it("就绪 + 安装包内置：标注为内置", async () => {
    const h = setupOdlHarness({
      getStatus: async () => ({
        present: true,
        version: "2.5.0",
        source: "bundled",
      }),
    });
    await h.clickOdl("ztransplit-pref-odl-comp-check");
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("安装包内置");
    h.dom.window.close();
  });

  it("缺失：显示下载引导", async () => {
    const h = setupOdlHarness({
      getStatus: async () => ({ present: false, version: "2.5.0" }),
    });
    await h.clickOdl("ztransplit-pref-odl-comp-check");
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("未找到解析组件");
    h.dom.window.close();
  });

  it("下载：点击后按钮禁用并切到「正在下载」，完成后恢复并刷新为就绪状态", async () => {
    let installed = false;
    const h = setupOdlHarness({
      getStatus: async () =>
        installed
          ? {
              present: true,
              version: "2.5.0",
              source: "landed",
              path: "/tmp/jar",
            }
          : { present: false },
      install: async () => {
        installed = true;
        return "/tmp/jar";
      },
    });
    const downloadBtn = h.doc.getElementById(
      "ztransplit-pref-odl-comp-download",
    )!;
    await h.clickOdl("ztransplit-pref-odl-comp-download");
    expect(installed).toBe(true);
    expect(downloadBtn.hasAttribute("disabled")).toBe(false);
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("2.5.0");
    h.dom.window.close();
  });

  it("下载失败：状态行上墙错误细节，不被缺失引导覆盖", async () => {
    const h = setupOdlHarness({
      getStatus: async () => ({ present: false }),
      install: async () => {
        throw new Error("ODL jar provision failed: no mirror reachable");
      },
    });
    await h.clickOdl("ztransplit-pref-odl-comp-download");
    const status = h.doc.getElementById("ztransplit-pref-odl-comp-status")!;
    expect(String(status.textContent)).toContain("下载失败");
    expect(String(status.textContent)).toContain("no mirror reachable");
    h.dom.window.close();
  });
});

// ── AI 服务商预设 + 测试连接 ──────────────────────────────────────────────────
//
// 修复「用户说不知道怎么配置 AI API」时加入：服务商下拉把配置成本从「查文档
// 抄四个值」降到「选一项 + 粘密钥」，测试连接给填完即可验证的手段。面板脚本
// 在独立沙箱里镜像了主包的预设表；这里同时钉两侧一致性与交互行为。

interface AiHarness extends Harness {
  /** 切换服务商下拉并派发事件。 */
  selectProvider(value: string): void;
  /** 点击测试连接并冲刷偏好脚本里的 Promise 链。 */
  clickAiTest(): Promise<void>;
  /** 主包收到的最近一次 testConnection 参数。 */
  seen: { config: any | null };
}

function setupAiHarness(opts: {
  prefs?: Record<string, unknown>;
  ai?: { testConnection?: (config: any) => Promise<any> };
} = {}): AiHarness {
  const base = setupHarness({ prefs: opts.prefs });
  const seen: { config: any | null } = { config: null };
  (base.window as any).Zotero.ZTransplit = opts.ai
    ? {
        ai: {
          testConnection: (config: any) => {
            seen.config = config;
            return opts.ai!.testConnection!(config);
          },
        },
      }
    : undefined;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    ...base,
    seen,
    selectProvider(value: string) {
      const list = base.doc.getElementById("ztransplit-pref-ai-provider");
      if (!list) throw new Error("provider menulist not found");
      list.value = value;
      for (const type of ["select", "command"]) {
        list.dispatchEvent(new base.window.Event(type, { bubbles: true }));
      }
    },
    async clickAiTest() {
      const btn = base.doc.getElementById("ztransplit-pref-ai-test-btn");
      if (!btn) throw new Error("test button not found");
      btn.dispatchEvent(new base.window.Event("command", { bubbles: true }));
      await flush();
      await flush();
      await flush();
    },
  };
}

describe("B17 设置 pane：AI 服务商预设", () => {
  it("面板加载：按已填地址反查预设（老用户的下拉状态与配置一致）", () => {
    const h = setupAiHarness({
      prefs: {
        [`${PREFIX}translate.ai.apiUrl`]: "https://api.deepseek.com/v1",
        [`${PREFIX}translate.ai.model`]: "deepseek-chat",
      },
    });
    expect(h.doc.getElementById("ztransplit-pref-ai-provider")!.value).toBe("deepseek");
    h.dom.window.close();
  });

  it("地址不在预设表里：下拉显示「不预设」", () => {
    const h = setupAiHarness({
      prefs: { [`${PREFIX}translate.ai.apiUrl`]: "https://my-gateway.internal/v1" },
    });
    expect(h.doc.getElementById("ztransplit-pref-ai-provider")!.value).toBe("none");
    h.dom.window.close();
  });

  it("选服务商：接口地址与模型名写入偏好并回填输入框", () => {
    const h = setupAiHarness({
      prefs: { [`${PREFIX}translate.ai.apiUrl`]: "", [`${PREFIX}translate.ai.model`]: "" },
    });
    h.selectProvider("glm");
    expect(h.prefs.get(`${PREFIX}translate.ai.apiUrl`)).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(h.prefs.get(`${PREFIX}translate.ai.model`)).toBe("glm-4-plus");
    // 输入框立即回显（XUL preference 绑定的反向同步时机不保证）
    expect(h.doc.getElementById("ztransplit-pref-ai-url")!.value).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(h.doc.getElementById("ztransplit-pref-ai-model")!.value).toBe("glm-4-plus");
    h.dom.window.close();
  });

  it("选自定义/不预设：一个字段都不动", () => {
    const h = setupAiHarness({
      prefs: {
        [`${PREFIX}translate.ai.apiUrl`]: "https://my-gateway.internal/v1",
        [`${PREFIX}translate.ai.model`]: "my-model",
      },
    });
    h.selectProvider("custom");
    expect(h.prefs.get(`${PREFIX}translate.ai.apiUrl`)).toBe("https://my-gateway.internal/v1");
    expect(h.prefs.get(`${PREFIX}translate.ai.model`)).toBe("my-model");
    h.selectProvider("none");
    expect(h.prefs.get(`${PREFIX}translate.ai.apiUrl`)).toBe("https://my-gateway.internal/v1");
    expect(h.prefs.get(`${PREFIX}translate.ai.model`)).toBe("my-model");
    h.dom.window.close();
  });

  it("手工改过的模型名不被预设吞掉", () => {
    const h = setupAiHarness({
      prefs: {
        [`${PREFIX}translate.ai.apiUrl`]: "https://api.deepseek.com/v1",
        [`${PREFIX}translate.ai.model`]: "deepseek-reasoner",
      },
    });
    h.selectProvider("kimi");
    expect(h.prefs.get(`${PREFIX}translate.ai.apiUrl`)).toBe("https://api.moonshot.cn/v1");
    expect(h.prefs.get(`${PREFIX}translate.ai.model`)).toBe("deepseek-reasoner");
    h.dom.window.close();
  });

  it("面板镜像的预设表与主包 providerPresets.ts 一致", async () => {
    const { AI_PROVIDER_PRESETS } = await import("../../../src/core/ai/providerPresets");
    const h = setupAiHarness({});
    const ids = [...h.doc.querySelectorAll("#ztransplit-pref-ai-provider menuitem")].map(
      (el: any) => el.getAttribute("value"),
    );
    // 下拉多一个「不预设」占位，其余顺序与 id 完全对应
    expect(ids[0]).toBe("none");
    expect(ids.slice(1)).toEqual(AI_PROVIDER_PRESETS.map((p) => p.id));
    h.dom.window.close();
  });
});

describe("B17 设置 pane：AI 测试连接按钮", () => {
  it("主包未挂载：显示引导文案，不抛错", async () => {
    const h = setupAiHarness({});
    await h.clickAiTest();
    const status = h.doc.getElementById("ztransplit-pref-ai-test-status")!;
    expect(String(status.textContent)).toContain("插件主模块尚未加载");
    h.dom.window.close();
  });

  it("成功：状态行显示主包返回的消息（表单值原样传给主包）", async () => {
    const h = setupAiHarness({
      prefs: {
        [`${PREFIX}translate.ai.apiUrl`]: "https://api.deepseek.com/v1",
        [`${PREFIX}translate.ai.apiKey`]: "sk-1",
        [`${PREFIX}translate.ai.model`]: "deepseek-chat",
      },
      ai: {
        testConnection: async () => ({ ok: true, message: "连接成功：模型 deepseek-chat" }),
      },
    });
    await h.clickAiTest();
    expect(h.seen.config).toEqual({
      apiUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-1",
      model: "deepseek-chat",
    });
    const status = h.doc.getElementById("ztransplit-pref-ai-test-status")!;
    expect(String(status.textContent)).toContain("连接成功");
    // 按钮恢复可用（in-flight 结束后解除禁用）
    expect(h.doc.getElementById("ztransplit-pref-ai-test-btn")!.hasAttribute("disabled")).toBe(false);
    h.dom.window.close();
  });

  it("失败：状态行显示失败消息", async () => {
    const h = setupAiHarness({
      prefs: { [`${PREFIX}translate.ai.apiUrl`]: "https://api.deepseek.com/v1" },
      ai: {
        testConnection: async () => ({ ok: false, kind: "auth", message: "密钥被拒绝（401）" }),
      },
    });
    await h.clickAiTest();
    const status = h.doc.getElementById("ztransplit-pref-ai-test-status")!;
    expect(String(status.textContent)).toContain("密钥被拒绝");
    h.dom.window.close();
  });

  it("表单里未失焦的改动优先于偏好（测的就是眼前的值）", async () => {
    const h = setupAiHarness({
      prefs: { [`${PREFIX}translate.ai.apiUrl`]: "https://old.example.com/v1" },
      ai: { testConnection: async () => ({ ok: true, message: "ok" }) },
    });
    // 用户刚粘贴了新地址，还没失焦（pref 未落盘）
    h.doc.getElementById("ztransplit-pref-ai-url")!.value = "https://new.example.com/v1";
    await h.clickAiTest();
    expect(h.seen.config.apiUrl).toBe("https://new.example.com/v1");
    h.dom.window.close();
  });

  it("切服务商后清掉过期的测试结果", async () => {
    const h = setupAiHarness({
      prefs: { [`${PREFIX}translate.ai.apiUrl`]: "" },
      ai: { testConnection: async () => ({ ok: true, message: "连接成功" }) },
    });
    await h.clickAiTest();
    expect(String(h.doc.getElementById("ztransplit-pref-ai-test-status")!.textContent)).toContain("连接成功");
    h.selectProvider("deepseek");
    expect(String(h.doc.getElementById("ztransplit-pref-ai-test-status")!.textContent)).toBe("");
    h.dom.window.close();
  });
});
