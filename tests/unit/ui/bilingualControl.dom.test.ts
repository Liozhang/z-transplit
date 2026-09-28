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
 *   - 模式下拉与实际模式同步（defaultMode=transOnly），退出复位 interleave
 *
 * speechSynthesis 用Fake：cancel/finish 的 onend 一律落在后续宏任务（与真实
 * 平台一致），因此 stale-onend 竞态在本测试中真实复现。
 */
import { JSDOM } from "jsdom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mountBilingualControl,
  type BilingualControlHandle,
} from "../../../src/ui/bilingualControl";
import { createZoteroMock } from "../../qa/harness/zotero-mock";
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
  statusText(): string;
  modeValue(): string;
  modeDisabled(): boolean;
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

  const handle = mountBilingualControl({ doc, body, itemID: 1 });

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
    statusText: () =>
      String(doc.querySelector(".ztransplit-bc-status")?.textContent ?? ""),
    modeValue: () =>
      String((doc.querySelector("select.ztransplit-bc-mode") as any)?.value ?? ""),
    modeDisabled: () =>
      !!(doc.querySelector("select.ztransplit-bc-mode") as any)?.disabled,
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

  it("behavior-F3：退出双语停止朗读，按钮复位、下拉复位 interleave", async () => {
    ctx = setup();
    h.handle = makeHandle();
    await toggleOn(ctx);
    ctx.click("readaloud-translation");
    expect(ctx.playingVisible()).toBe(true);
    expect(ctx.modeDisabled()).toBe(false);

    ctx.click("bilingual-exit");
    await flush();
    expect(ctx.playingVisible()).toBe(false);
    expect(ctx.spoken()).toEqual(["T1"]); // 无新增语音
    expect(ctx.toggleText()).toContain("bilingual-enable");
    expect(ctx.modeValue()).toBe("interleave");
    expect(ctx.modeDisabled()).toBe(true);
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
    expect(ctx.toggleText()).toContain("bilingual-exit");
    expect(vi.mocked(exitBilingualSession)).toHaveBeenCalledTimes(1);
  });

  it("模式下拉与实际模式同步（defaultMode=transOnly），退出复位", async () => {
    ctx = setup({ "reader.bilingual.defaultMode": "transOnly" });
    h.handle = makeHandle();
    await toggleOn(ctx);
    expect(ctx.modeValue()).toBe("transOnly");

    ctx.click("bilingual-exit");
    await flush();
    expect(ctx.modeValue()).toBe("interleave");
    expect(ctx.modeDisabled()).toBe(true);
  });
});
