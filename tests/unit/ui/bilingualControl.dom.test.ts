// @vitest-environment jsdom
/**
 * 双语控制条（src/ui/bilingualControl.ts）朗读状态机与生命周期回归：
 *
 *   - pane-F1：播放中再点「朗读原文」= 停止，而不是重播
 *   - pane-F2：段落构建（async buildPdfSegments）期间再点击不产生并行控制器
 *   - pane-F7：样式挂 body、随 destroy 移除
 *   - behavior-F1：buildInterleave 失败回滚阅读模式，再点开关是重新开始
 *   - behavior-F3：退出双语 / 面板销毁停止朗读并复位 UI
 *   - behavior-F8：朗读译文从最顶可见块对应的段开始
 *   - 模式按钮与实际模式同步（defaultMode=transOnly），显式点选写入偏好
 *   - 一键直达：会话外点「仅译文」直接以该模式启动，选择被记住
 *   - 点击后立即出现准备反馈（reader 解析等待期间不再沉默）
 *   - 启动期间三个按钮禁用，结束后恢复可点（退出复位到存储的默认模式）
 *   - 开关文案固定（bilingual-enable 键），会话状态由 aria-pressed 表达；
 *     模式按钮无半透明态，当前模式用中性按压态高亮
 *   - 阅读器类型门控：快照条目不挂载双语块（PDF 专属能力），工具栏按钮
 *     同样只追加给 PDF 阅读器
 *
 * speechSynthesis 用Fake：cancel/finish 的 onend 一律落在后续宏任务（与真实
 * 平台一致），因此 stale-onend 竞态在本测试中真实复现。
 */
import { JSDOM } from "jsdom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mountBilingualControl,
  registerBilingualReaderToolbar,
  unregisterBilingualReaderToolbar,
  type BilingualControlHandle,
} from "../../../src/ui/bilingualControl";
import {
  createZoteroMock,
  resetReaderEventListeners,
} from "../../qa/harness/zotero-mock";
import * as pdfReaderTts from "../../../src/core/readAloud/pdfReaderTts";
import { exitBilingualSession } from "../../../src/core/pdf/sdt/sdtBridge";

/** interleaveView/sdtBridge 被替换后的会话交接点（每个测试自行填充）。 */
const h = vi.hoisted(() => ({
  handle: null as any,
  error: null as unknown,
}));

vi.mock("../../../src/core/readAloud/pdfReaderTts", () => ({
  pdfReadAloudSupported: vi.fn(() => true),
  currentPageNumber: vi.fn(() => 1),
  buildPdfSegments: vi.fn(async () => ({ segments: [], total: 1 })),
  highlightSegment: vi.fn(),
  clearSegmentHighlight: vi.fn(),
  followSegment: vi.fn(),
}));

vi.mock("../../../src/core/pdf/sdt/sdtBridge", () => ({
  enterBilingualSession: vi.fn(async () => ({
    reader: {},
    internalReader: {},
    sdtView: {},
    doc: {},
    container: { classList: { add() {}, remove() {} } },
    blocks: [],
    exit: vi.fn(async () => {}),
  })),
  exitBilingualSession: vi.fn(async () => {}),
}));

vi.mock("../../../src/core/pdf/sdt/interleaveView", () => ({
  buildInterleave: vi.fn(async () => {
    if (h.error) throw h.error;
    return h.handle;
  }),
}));

class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  voice: any = null;
  onend: (() => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSynth {
  spoken: FakeUtterance[] = [];
  private current: FakeUtterance | null = null;
  speak(u: FakeUtterance): void {
    this.spoken.push(u);
    this.current = u;
  }
  cancel(): void {
    const u = this.current;
    this.current = null;
    if (u) setTimeout(() => u.onend?.(), 0);
  }
  finish(): void {
    const u = this.current;
    this.current = null;
    if (u) setTimeout(() => u.onend?.(), 0);
  }
  pause(): void {}
  resume(): void {}
  getVoices(): any[] {
    return [];
  }
}

function makeHandle(opts: { startRef?: string | null } = {}): any {
  const segments = ["T1", "T2"].map((text, i) => ({
    text,
    meta: { refPath: String(i), sentenceIndex: 0 },
  }));
  let mode = "interleave";
  return {
    setMode: vi.fn((m: string) => {
      mode = m;
    }),
    getMode: vi.fn(() => mode),
    stats: () => ({ done: segments.length, total: segments.length }),
    retry: () => {},
    currentRefPath: vi.fn(() =>
      opts.startRef === undefined ? null : opts.startRef,
    ),
    translationOf: () => "",
    translatedReadSegments: vi.fn(() => segments),
    highlightTranslatedSentence: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

interface Ctx {
  dom: JSDOM;
  doc: any;
  body: any;
  z: ReturnType<typeof createZoteroMock>;
  synth: FakeSynth;
  handle: BilingualControlHandle;
  click(label: string): void;
  button(label: string): HTMLButtonElement;
  spoken(): string[];
  playingVisible(): boolean;
  toggleText(): string;
  togglePressed(): string;
  statusText(): string;
  modeValue(): string;
  modeHighlighted(): number;
  modeDisabled(): boolean;
  storedMode(): unknown;
}

function setup(prefs: Record<string, unknown> = {}): Ctx {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "chrome://zotero/content/zoteroPane.xhtml",
  });
  const doc = dom.window.document;
  const body = doc.createElement("div");
  doc.body.appendChild(body);

  const z = createZoteroMock({ locale: "zh-CN", prefs });
  z.install();
  // SDT-capable reader（capabilities 探针要求两个内部方法存在）。
  (globalThis as any).Zotero.Reader.getByTabID = () => ({
    itemID: 1,
    _internalReader: {
      _setReadingMode: async () => {},
      _loadSDT: async () => {},
      _primaryView: { _selectionRanges: [] },
    },
  });
  (dom.window as any).Zotero = (globalThis as any).Zotero;
  (dom.window as any).Zotero_Tabs = { selectedID: 1 };

  const synth = new FakeSynth();
  (dom.window as any).speechSynthesis = synth;
  (dom.window as any).SpeechSynthesisUtterance = FakeUtterance;

  const handle = mountBilingualControl({ doc, body, itemID: 1, readerKind: "pdf" });

  const button = (label: string): HTMLButtonElement => {
    const btn = [...doc.querySelectorAll("button")].find((b: any) =>
      String(b.textContent).includes(label),
    );
    if (!btn) throw new Error("no button " + label);
    return btn as HTMLButtonElement;
  };
  return {
    dom,
    doc,
    body,
    z,
    synth,
    handle,
    click: (label) => button(label).click(),
    button,
    spoken: () => synth.spoken.map((u) => u.text),
    playingVisible: () => !button("readaloud-stop").hidden,
    toggleText: () =>
      String(doc.querySelector("button.ztransplit-bc-toggle")?.textContent ?? ""),
    togglePressed: () =>
      String(
        doc
          .querySelector("button.ztransplit-bc-toggle")
          ?.getAttribute("aria-pressed") ?? "",
      ),
    statusText: () =>
      String(doc.querySelector(".ztransplit-bc-status")?.textContent ?? ""),
  modeValue: () =>
    String(
      (
        doc.querySelector(
          "button.ztransplit-bc-mode-btn[data-active='true']",
        ) as any
      )?.dataset?.mode ?? "",
    ),
  /** 当前处于高亮态的模式按钮数量（无会话时应为 0：无高亮即无歧义）。 */
  modeHighlighted: () =>
    doc.querySelectorAll("button.ztransplit-bc-mode-btn[data-active='true']")
      .length,
  /** 全部模式按钮处于禁用态（仅启动进行中为真）。 */
  modeDisabled: () => {
    const btns = [
      ...doc.querySelectorAll("button.ztransplit-bc-mode-btn"),
    ] as HTMLButtonElement[];
    return btns.length > 0 && btns.every((b) => b.disabled);
  },
  /** 存储的启动默认模式（reader.bilingual.defaultMode 当前值）。 */
  storedMode: () =>
    z.prefs.get("extensions.zotero.ztransplit.reader.bilingual.defaultMode"),
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 开启双语会话（sdtBridge/interleaveView 已 mock）。 */
async function toggleOn(ctx: Ctx): Promise<void> {
  ctx.click("bilingual-enable");
  await flush();
}

beforeEach(() => {
  // 每个测试自行决定 buildPdfSegments 的行为，避免上一个测试的实现泄漏。
  vi.mocked(pdfReaderTts.buildPdfSegments).mockReset();
  vi.mocked(pdfReaderTts.buildPdfSegments).mockResolvedValue({
    segments: [],
    total: 1,
  });
  vi.mocked(exitBilingualSession).mockClear();
  // h.error/h.handle 是跨 mock 的交接点，失败测试不能把状态带给下一个。
  h.error = null;
  h.handle = null;
});

describe("双语控制条：朗读状态机", () => {
  let ctx: Ctx | undefined;
  afterEach(() => {
    ctx?.handle.destroy();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
    ctx = undefined;
  });

  it("pane-F1：播放中再点「朗读原文」= 停止并隐藏按钮，而不是重播", async () => {
    ctx = setup();
    let resolveBuild!: (r: { segments: any[]; total: number }) => void;
    vi.mocked(pdfReaderTts.buildPdfSegments).mockImplementation(
      () => new Promise((res) => (resolveBuild = res)),
    );
    ctx.click("readaloud-original");
    await flush();
    resolveBuild({ segments: [{ text: "A", meta: {} }, { text: "B", meta: {} }], total: 1 });
    await flush();
    expect(ctx.spoken()).toEqual(["A"]);
    expect(ctx.playingVisible()).toBe(true);

    ctx.click("readaloud-original"); // 同源再点 → 停止
    expect(ctx.playingVisible()).toBe(false);
    await flush(); // 被 cancel 的 A 的 onend 迟到
    expect(ctx.spoken()).toEqual(["A"]); // 没有重播第二个 utterance
    expect(ctx.playingVisible()).toBe(false);
  });

  it("pane-F1：停止后再次点击是重新开始（新 utterance、按钮恢复）", async () => {
    ctx = setup();
    vi.mocked(pdfReaderTts.buildPdfSegments).mockResolvedValue({
      segments: [{ text: "A", meta: {} }],
      total: 1,
    });
    ctx.click("readaloud-original");
    await flush();
    expect(ctx.spoken()).toEqual(["A"]);
    ctx.click("readaloud-original"); // 停止
    expect(ctx.playingVisible()).toBe(false);
    ctx.click("readaloud-original"); // 重新开始
    await flush();
    expect(ctx.spoken()).toEqual(["A", "A"]);
    expect(ctx.playingVisible()).toBe(true);
  });

  it("pane-F2：原文构建期间点「朗读译文」取消构建，全程只有一个控制器", async () => {
    ctx = setup();
    h.handle = makeHandle();
    let resolveBuild!: (r: { segments: any[]; total: number }) => void;
    vi.mocked(pdfReaderTts.buildPdfSegments).mockImplementation(
      () => new Promise((res) => (resolveBuild = res)),
    );
    await toggleOn(ctx);
    expect(ctx.modeValue()).toBe("interleave");

    ctx.click("readaloud-original"); // 构建挂起
    ctx.click("readaloud-translation"); // 构建期间切换来源 → 译文立即开播
    expect(ctx.spoken()).toEqual(["T1"]);
    expect(ctx.playingVisible()).toBe(true);

    resolveBuild({ segments: [{ text: "A", meta: {} }], total: 1 }); // 迟到的构建
    await flush();
    expect(ctx.spoken()).toEqual(["T1"]); // 孤儿构建被 generation 拦下
    expect(vi.mocked(pdfReaderTts.buildPdfSegments)).toHaveBeenCalledTimes(1);
  });

  it("behavior-F8：朗读译文从最顶可见块对应的段开始", async () => {
    ctx = setup();
    h.handle = makeHandle({ startRef: "1" });
    await toggleOn(ctx);
    ctx.click("readaloud-translation");
    await flush();
    expect(ctx.spoken()).toEqual(["T2"]); // 不是从头（T1），而是 currentRefPath 对应段
    expect(h.handle.highlightTranslatedSentence).toHaveBeenCalledWith("1", 0);
  });

  it("构建失败：状态行给出可见错误且可重新点击", async () => {
    ctx = setup();
    vi.mocked(pdfReaderTts.buildPdfSegments).mockRejectedValueOnce(
      new Error("boom"),
    );
    ctx.click("readaloud-original");
    await flush();
    expect(ctx.statusText()).toContain("readaloud-start-failed");

    vi.mocked(pdfReaderTts.buildPdfSegments).mockResolvedValueOnce({
      segments: [{ text: "A", meta: {} }],
      total: 1,
    });
    ctx.click("readaloud-original"); // 失败后再点 = 重新开始
    await flush();
    expect(ctx.spoken()).toEqual(["A"]);
  });
});

describe("双语控制条：会话与面板生命周期", () => {
  let ctx: Ctx | undefined;
  afterEach(() => {
    ctx?.handle.destroy();
    ctx?.z.uninstall();
    ctx?.dom.window.close();
    ctx = undefined;
  });

  it("behavior-F3：退出双语停止朗读，按钮复位、模式高亮清除", async () => {
    ctx = setup();
    h.handle = makeHandle();
    await toggleOn(ctx);
    ctx.click("readaloud-translation");
    expect(ctx.playingVisible()).toBe(true);
    expect(ctx.modeDisabled()).toBe(false);

    ctx.click("bilingual-enable"); // 开关文案固定，退出也是点同一个按钮
    await flush();
    expect(ctx.playingVisible()).toBe(false);
    expect(ctx.spoken()).toEqual(["T1"]); // 无新增语音
    expect(ctx.toggleText()).toContain("bilingual-enable");
    expect(ctx.togglePressed()).toBe("false");
    // 无会话时不回写默认模式高亮：无高亮 = 「模式跟随下次启动的选择」，
    // 模式按钮保持可点（点击 = 以该模式直启），不再用半透明暗示禁用。
    expect(ctx.modeHighlighted()).toBe(0);
    expect(ctx.modeValue()).toBe("");
    // 模式按钮始终可点（会话外点击 = 以该模式启动），只有启动进行中禁用。
    expect(ctx.modeDisabled()).toBe(false);
  });

  it("behavior-F3：面板销毁停止原文朗读（无需会话）并移除样式", async () => {
    ctx = setup();
    vi.mocked(pdfReaderTts.buildPdfSegments).mockResolvedValue({
      segments: [{ text: "A", meta: {} }],
      total: 1,
    });
    ctx.click("readaloud-original");
    await flush();
    expect(ctx.spoken()).toEqual(["A"]);
    expect(ctx.playingVisible()).toBe(true);

    // pane-F7：样式挂在面板 body 内，而不是 documentElement
    expect(ctx.body.querySelectorAll("style.ztransplit-bc-style").length).toBe(1);

    // destroy 会把按钮连同面板一起移走，先抓住元素再断言其状态。
    const stopBtn = ctx.button("readaloud-stop");
    ctx.handle.destroy();
    expect(stopBtn.hidden).toBe(true);
    await flush();
    expect(ctx.spoken()).toEqual(["A"]); // 语音已停，无新增
    expect(ctx.doc.querySelectorAll("style.ztransplit-bc-style").length).toBe(0);
  });

  it("behavior-F1：buildInterleave 失败回滚阅读模式，再点开关是重新开始", async () => {
    ctx = setup();
    h.error = new Error("boom");
    ctx.click("bilingual-enable");
    await flush();
    // 回滚：reading mode 退出路径被调用，开关回到未开启态
    expect(vi.mocked(exitBilingualSession)).toHaveBeenCalled();
    expect(ctx.toggleText()).toContain("bilingual-enable");
    expect(ctx.statusText()).toContain("bilingual-sdt-unpack-failed");

    h.error = null; // 再点击 = 重新开始（不是重复 enter 叠加）
    h.handle = makeHandle();
    ctx.click("bilingual-enable");
    await flush();
    expect(ctx.togglePressed()).toBe("true");
    expect(vi.mocked(exitBilingualSession)).toHaveBeenCalledTimes(1);
  });

  it("模式按钮与实际模式同步（defaultMode=transOnly），显式点选写入偏好", async () => {
    ctx = setup({ "reader.bilingual.defaultMode": "transOnly" });
    h.handle = makeHandle();
    await toggleOn(ctx);
    expect(ctx.modeValue()).toBe("transOnly");

    // 点「上下对照」→ 高亮与底层模式同步切换，并被记住为下次的启动模式
    ctx.click("bilingual-mode-interleave");
    expect(ctx.modeValue()).toBe("interleave");
    expect(h.handle.setMode).toHaveBeenCalledWith("interleave");
    expect(ctx.storedMode()).toBe("interleave");

    ctx.click("bilingual-enable"); // 退出点同一个开关
    await flush();
    // 退出清除模式高亮（无会话 = 无高亮）；存储的默认模式保持 interleave 不变
    expect(ctx.modeHighlighted()).toBe(0);
    expect(ctx.modeValue()).toBe("");
    expect(ctx.storedMode()).toBe("interleave");
    expect(ctx.modeDisabled()).toBe(false);
  });

  it("一键直达：会话外点「仅译文」直接以该模式启动并记住选择", async () => {
    ctx = setup();
    h.handle = makeHandle();
    // 会话外模式按钮不再禁用
    expect(ctx.modeDisabled()).toBe(false);
    ctx.click("bilingual-mode-trans-only");
    await flush();
    expect(ctx.togglePressed()).toBe("true");
    expect(ctx.modeValue()).toBe("transOnly");
    expect(h.handle.setMode).toHaveBeenCalledWith("transOnly");
    expect(ctx.storedMode()).toBe("transOnly");
  });

  it("点击后立即出现准备反馈（reader 解析等待之前）", async () => {
    ctx = setup();
    h.handle = makeHandle();
    ctx.click("bilingual-enable");
    // 同步可见：不再是点击后数秒无响应
    expect(ctx.statusText()).toContain("bilingual-sdt-loading");
    await flush();
    // 启动成功后状态行清空
    expect(ctx.statusText()).toBe("");
  });

  it("启动期间三个按钮禁用，结束后恢复", async () => {
    ctx = setup();
    h.handle = makeHandle();
    ctx.click("bilingual-enable");
    expect(ctx.modeDisabled()).toBe(true);
    expect(ctx.button("bilingual-enable").disabled).toBe(true);
    await flush();
    expect(ctx.modeDisabled()).toBe(false);
    expect(ctx.button("bilingual-enable").disabled).toBe(false);
  });

  it("开关文案固定，会话状态由按压态（aria-pressed）表达", async () => {
    ctx = setup();
    h.handle = makeHandle();
    expect(ctx.toggleText()).toContain("bilingual-enable");
    expect(ctx.togglePressed()).toBe("false");
    await toggleOn(ctx);
    // 文案不变，状态切换交给 aria-pressed / data-active（红色按压态）
    expect(ctx.toggleText()).toContain("bilingual-enable");
    expect(ctx.togglePressed()).toBe("true");
    ctx.click("bilingual-enable"); // 再点 = 退出
    await flush();
    expect(ctx.togglePressed()).toBe("false");
  });
});

describe("双语控制条：阅读器类型门控", () => {
  let z: ReturnType<typeof createZoteroMock> | null = null;

  beforeEach(() => {
    resetReaderEventListeners();
  });

  afterEach(() => {
    unregisterBilingualReaderToolbar();
    resetReaderEventListeners();
    z?.uninstall();
    z = null;
  });

  it("快照条目不挂载任何 DOM，destroy 无害", () => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const doc = dom.window.document;
    const body = doc.createElement("div");
    doc.body.appendChild(body);

    const handle = mountBilingualControl({
      doc: doc as any,
      body: body as any,
      itemID: 2,
      readerKind: "snapshot",
    });

    // 双语块根元素（ztransplit-bc-root）与样式都不出现。
    expect(doc.querySelector(".ztransplit-bc-root")).toBeNull();
    expect(doc.querySelector("style")).toBeNull();
    expect(body.childNodes).toHaveLength(0);
    expect(() => handle.destroy()).not.toThrow();
    dom.window.close();
  });

  it("PDF 条目正常挂载（对照：门控只挡非 PDF）", () => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const doc = dom.window.document;
    const body = doc.createElement("div");
    doc.body.appendChild(body);

    const handle = mountBilingualControl({
      doc: doc as any,
      body: body as any,
      itemID: 3,
      readerKind: "pdf",
    });
    expect(doc.querySelector(".ztransplit-bc-root")).not.toBeNull();
    handle.destroy();
    dom.window.close();
  });

  it("工具栏按钮只追加给 PDF 阅读器", () => {
    z = createZoteroMock({ locale: "zh-CN" });
    z.install();
    registerBilingualReaderToolbar();

    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const doc = dom.window.document;

    const appended: any[] = [];
    const append = (el: any) => appended.push(el);

    // EPUB 阅读器：不追加（双语与朗读在其上均不可用）。
    z!.fireReaderEvent("renderToolbar", {
      reader: { type: "epub" },
      doc,
      append,
    });
    expect(appended).toHaveLength(0);

    // 快照阅读器：同样不追加。
    z!.fireReaderEvent("renderToolbar", {
      reader: { type: "snapshot" },
      doc,
      append,
    });
    expect(appended).toHaveLength(0);

    // PDF 阅读器：追加。
    z!.fireReaderEvent("renderToolbar", {
      reader: { type: "pdf" },
      doc,
      append,
    });
    expect(appended).toHaveLength(1);
    dom.window.close();
  });
});
