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
    expect(labels.length).toBe(22);
    for (const row of labels) {
      expect(enFtl.get(row.id)!.has("value"), `en-US ${row.id} 应写 .value`).toBe(true);
      expect(zhFtl.get(row.id)!.has("value"), `zh-CN ${row.id} 应写 .value`).toBe(true);
    }
  });

  it("8 个 menuitem 两语言都写 .label（XUL menuitem 只渲染 label 属性）", () => {
    const items = l10nBindings().filter((r) => r.tag === "menuitem");
    expect(items.length).toBe(8);
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
