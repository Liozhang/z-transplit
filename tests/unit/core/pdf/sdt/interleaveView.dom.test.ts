// @vitest-environment jsdom
/**
 * interleaveView（src/core/pdf/sdt/interleaveView.ts）仅译文点击查看原文：
 *
 *   - 仅译文模式点击译文块 → 对应原文块获得 data-peek（临时显示）
 *   - 点击另一块 → peek 移动；再点同一块 → 取消；点击空白容器 → 取消
 *   - 上下对照模式点击无效果；切换模式清除 peek 并同步指针提示
 *   - 点击已显示的原文段落不取消 peek（保留划词等原生手势）
 *   - 有选区时的 click（拖选松手）不当作切换手势
 *   - dispose 清除 data-peek 并解绑监听
 *
 * LazyTranslateQueue 与翻译缓存整体替换为假件——本文件只关注注入、模式类与
 * 点击交互，翻译供给链路由 bilingualControl.dom.test 与队列自身测试覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../src/core/pdf/sdt/lazyQueue", () => ({
  LazyTranslateQueue: class {
    /** Hooks captured for direct driving (onDone/onFailed) in tests. */
    static lastHooks: any = null;
    constructor(_doc: unknown, _entries: unknown, hooks: any) {
      (this.constructor as any).lastHooks = hooks;
    }
    start(): void {}
    stop(): void {}
    stats(): { done: number; total: number } {
      return { done: 0, total: 0 };
    }
    retry(): void {}
    currentRefPath(): string | null {
      return null;
    }
  },
}));

vi.mock("../../../../../src/core/translation/translationCache", () => ({
  cacheAvailable: vi.fn(() => false),
  cacheKey: vi.fn(async () => null),
  getCachedTranslations: vi.fn(async () => new Map()),
  putCachedTranslation: vi.fn(async () => {}),
}));

import { buildInterleave } from "../../../../../src/core/pdf/sdt/interleaveView";
import { getString } from "../../../../../src/utils/locale";
import { LazyTranslateQueue } from "../../../../../src/core/pdf/sdt/lazyQueue";

type AnySession = Parameters<typeof buildInterleave>[0];

interface Fixture {
  container: HTMLElement;
  originals: HTMLElement[];
  session: AnySession;
}

function makeSession(): Fixture {
  const container = document.createElement("div");
  container.id = "sdt-content";
  document.body.appendChild(container);
  const originals: HTMLElement[] = [];
  const blocks = ["a", "b"].map((refPath) => {
    const p = document.createElement("p");
    p.dataset.refPath = refPath;
    p.textContent = "orig-" + refPath;
    container.appendChild(p);
    originals.push(p);
    return { refPath, text: "orig-" + refPath, el: p };
  });
  return {
    container,
    originals,
    session: {
      reader: {},
      internalReader: {},
      sdtView: {},
      doc: document,
      container,
      blocks,
      exit: vi.fn(async () => {}),
    } as unknown as AnySession,
  };
}

async function build(session: AnySession) {
  return buildInterleave(session, {
    targetLanguage: "zh-CN",
    batchTranslate: async (texts: string[]) => ({
      translations: texts.map((t) => "译-" + t),
      failedIndices: [],
    }),
  });
}

function biOf(container: HTMLElement, ref: string): HTMLElement {
  const el = container.querySelector(
    `div.ztransplit-bi[data-ref-path="${ref}"]`,
  );
  if (!el) throw new Error("no injected block " + ref);
  return el as HTMLElement;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("interleaveView：仅译文点击查看原文", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    fx = makeSession();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    fx = undefined;
  });

  it("上下对照模式点击译文块：不产生 peek，而是切换该段译文的显隐", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);
    expect(container.classList.contains("ztransplit-bi-mode-interleave")).toBe(
      true,
    );
    const bi = biOf(container, "a");
    click(bi);
    // 显隐状态落在注入块自身，原文不获得 peek
    expect(bi.hasAttribute("data-hidden")).toBe(true);
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
    expect(originals[1].hasAttribute("data-peek")).toBe(false);

    // 再点同一条恢复显示
    click(bi);
    expect(bi.hasAttribute("data-hidden")).toBe(false);
    // 另一块不受影响
    click(biOf(container, "b"));
    expect(bi.hasAttribute("data-hidden")).toBe(false);
    expect(biOf(container, "b").hasAttribute("data-hidden")).toBe(true);
  });

  it("仅译文模式点击译文块显示对应原文，可移动、可取消", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);
    handle.setMode("transOnly");

    click(biOf(container, "a"));
    expect(originals[0].getAttribute("data-peek")).toBe("");
    expect(originals[1].hasAttribute("data-peek")).toBe(false);

    // 点击另一块 → peek 移动
    click(biOf(container, "b"));
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
    expect(originals[1].getAttribute("data-peek")).toBe("");

    // 再点同一块 → 取消
    click(biOf(container, "b"));
    expect(originals[1].hasAttribute("data-peek")).toBe(false);

    // 点击空白容器 → 取消
    click(biOf(container, "a"));
    expect(originals[0].hasAttribute("data-peek")).toBe(true);
    click(container);
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
  });

  it("仅译文模式给出指针提示，切回上下对照时移除并清 peek", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);
    handle.setMode("transOnly");
    expect(biOf(container, "a").getAttribute("title")).toBe(
      getString("bilingual-peek-hint"),
    );

    click(biOf(container, "a"));
    expect(originals[0].hasAttribute("data-peek")).toBe(true);

    handle.setMode("interleave");
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
    expect(biOf(container, "a").hasAttribute("title")).toBe(false);
  });

  it("点击已显示的原文段落不取消 peek（保留划词手势）", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);
    handle.setMode("transOnly");
    click(biOf(container, "a"));
    click(originals[0]);
    expect(originals[0].hasAttribute("data-peek")).toBe(true);
  });

  it("有选区时的 click 不切换 peek（拖选松手不是点击手势）", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);
    handle.setMode("transOnly");

    const target = biOf(container, "a");
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.addRange(range);
    click(target);
    expect(originals[0].hasAttribute("data-peek")).toBe(false);

    sel.removeAllRanges();
    click(target);
    expect(originals[0].getAttribute("data-peek")).toBe("");
  });

  it("dispose 清除 data-peek 并解绑点击监听", async () => {
    const { container, originals, session } = fx!;
    const handle = await build(session);
    handle.setMode("transOnly");
    click(biOf(container, "a"));
    expect(originals[0].hasAttribute("data-peek")).toBe(true);

    await handle.dispose();
    // 临时显示状态被剥离，注入节点移除，退出钩子被调用
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
    expect(container.querySelectorAll(".ztransplit-bi").length).toBe(0);
    expect(session.exit).toHaveBeenCalled();

    // 解绑后点击不再产生任何 peek 状态
    click(container);
    click(originals[0]);
    expect(originals[0].hasAttribute("data-peek")).toBe(false);
    expect(originals[1].hasAttribute("data-peek")).toBe(false);
  });
});

describe("interleaveView：段落显隐（上下对照点击折叠译文）", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    fx = makeSession();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    fx = undefined;
  });

  it("折叠后带恢复提示（title 来自本地化键），恢复后提示移除", async () => {
    const { container } = fx!;
    await build(fx!.session);
    const bi = biOf(container, "a");
    click(bi);
    expect(bi.getAttribute("title")).toBe(getString("bilingual-show-hint"));
    click(bi);
    expect(bi.hasAttribute("title")).toBe(false);
  });

  it("切到仅译文模式清除全部折叠状态（两块都藏会让段落整个消失）", async () => {
    const { container } = fx!;
    const handle = await build(fx!.session);
    click(biOf(container, "a"));
    click(biOf(container, "b"));
    expect(container.querySelectorAll("[data-hidden]").length).toBe(2);

    handle.setMode("transOnly");
    expect(container.querySelectorAll("[data-hidden]").length).toBe(0);
    // 仅译文的查看原文提示照常就位
    expect(biOf(container, "a").getAttribute("title")).toBe(
      getString("bilingual-peek-hint"),
    );
  });

  it("有选区时的 click 不折叠（拖选松手不是切换手势）", async () => {
    const { container } = fx!;
    await build(fx!.session);
    const bi = biOf(container, "a");
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bi);
    sel.addRange(range);
    click(bi);
    expect(bi.hasAttribute("data-hidden")).toBe(false);

    sel.removeAllRanges();
    click(bi);
    expect(bi.hasAttribute("data-hidden")).toBe(true);
  });

  it("失败块的重试按钮点击不触发折叠", async () => {
    const { container } = fx!;
    const handle = await build(fx!.session);
    // 队列假件捕获了 hooks：直接驱动 onFailed 渲染失败态（含重试按钮）
    ((LazyTranslateQueue as unknown as { lastHooks: any }).lastHooks).onFailed(
      "a",
    );
    const retry = biOf(container, "a").querySelector(
      ".ztransplit-bi-retry",
    ) as HTMLElement | null;
    expect(retry).toBeTruthy();
    click(retry!);
    expect(biOf(container, "a").hasAttribute("data-hidden")).toBe(false);
    await handle.dispose();
  });
});

describe("interleaveView：两模式样式分层（样式契约）", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    fx = makeSession();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    fx = undefined;
  });

  /** 样式表是本契约的直接载体，断言读它注入后的原文。 */
  function css(): string {
    const el = document.getElementById("ztransplit-bi-style");
    if (!el) throw new Error("no injected style");
    return el.textContent || "";
  }

  it("基线只含结构规则：全墨、字号继承、无装饰（仅译文模式即正文）", async () => {
    await build(fx!.session);
    const m = /\.ztransplit-bi\s*\{([^}]*)\}/.exec(css());
    expect(m).toBeTruthy();
    const base = m![1];
    expect(base).toContain("font-size: 1em");
    expect(base).toContain("line-height: 1.75");
    expect(base).not.toContain("opacity:");
    expect(base).not.toContain("border-inline-start");
    expect(base).not.toContain("background:");
  });

  it("对照模式层负责淡墨：透明度、小一号、灰细线，悬停恢复全墨", async () => {
    await build(fx!.session);
    const m = /\.ztransplit-bi-mode-interleave \.ztransplit-bi\s*\{([^}]*)\}/.exec(
      css(),
    );
    expect(m).toBeTruthy();
    const mute = m![1];
    expect(mute).toContain("opacity: 0.74");
    expect(mute).toContain("font-size: 0.92em");
    expect(mute).toContain("border-inline-start");
    expect(css()).toMatch(
      /\.ztransplit-bi-mode-interleave \.ztransplit-bi:hover\s*\{[^}]*opacity: 1/,
    );
  });

  it("仅译文层不设透明度：cursor 与 display 之外无视觉改写", async () => {
    await build(fx!.session);
    const rules = [
      ...css().matchAll(
        /\.ztransplit-bi-mode-trans-only \.ztransplit-bi\s*\{([^}]*)\}/g,
      ),
    ].map((m) => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const body of rules) {
      expect(body).not.toContain("opacity");
      expect(body).not.toContain("font-size");
    }
    // 两个行为样式仍在
    expect(css()).toMatch(
      /\.ztransplit-bi-mode-trans-only \.ztransplit-bi\s*\{[^}]*cursor: pointer/,
    );
    expect(css()).toMatch(
      /\.ztransplit-bi-mode-trans-only \.ztransplit-bi\s*\{[^}]*display: block !important/,
    );
  });

  it("折叠横条声明在对照层之后（同特异性靠顺序取胜），且为中性灰", async () => {
    await build(fx!.session);
    const text = css();
    const interleaveAt = text.indexOf(".ztransplit-bi-mode-interleave .ztransplit-bi {");
    const hiddenAt = text.indexOf(".ztransplit-bi[data-hidden]");
    expect(interleaveAt).toBeGreaterThan(-1);
    expect(hiddenAt).toBeGreaterThan(interleaveAt);
    const m = /\.ztransplit-bi\[data-hidden\]\s*\{([^}]*)\}/.exec(text);
    expect(m![1]).toContain("rgba(127, 127, 127, 0.45)");
  });

  it("瞬时状态在两种模式下都保持自己的颜色", async () => {
    await build(fx!.session);
    const text = css();
    expect(text).toMatch(/\.ztransplit-bi-error\s*\{[^}]*color:/);
    expect(text).toMatch(/\.ztransplit-sent-active\s*\{[^}]*background:/);
  });
});

describe("interleaveView：译文继承相邻原文段落的计算样式", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    fx = makeSession();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    fx = undefined;
  });

  /** 段落内联样式即 jsdom 的计算样式来源，足以驱动派生规则。 */
  function styleOriginal(
    el: HTMLElement,
    decl: Record<string, string>,
  ): void {
    for (const [k, v] of Object.entries(decl)) el.style.setProperty(k, v);
  }

  it("标题段落：译文按标题字号收窄到上限，字重与倾斜跟随，字体不跟随", async () => {
    const { container, originals } = fx!;
    styleOriginal(originals[0], {
      "font-size": "30px",
      "font-weight": "700",
      "font-style": "italic",
      "font-family": "Times New Roman",
      color: "rgb(20, 20, 20)",
    });
    await build(fx!.session);
    const bi = biOf(container, "a");
    // 30 × 0.92 = 27.6，超过上限，取上限
    expect(bi.style.fontSize).toBe("24px");
    expect(bi.style.fontWeight).toBe("700");
    expect(bi.style.fontStyle).toBe("italic");
    expect(bi.style.color).toBe("rgb(20, 20, 20)");
    // 字体族明确不继承：原文那套可能是子集衬线或符号字形，给了中文译文就是豆腐块
    expect(bi.style.fontFamily).toBe("");
  });

  it("正文字号乘 0.92，未设字重的段落不写行内字重", async () => {
    const { container, originals } = fx!;
    styleOriginal(originals[0], { "font-size": "16px" });
    await build(fx!.session);
    const bi = biOf(container, "a");
    expect(bi.style.fontSize).toBe("14.7px");
    // jsdom 对未设字重的段落回报 normal——等于基线值，不应落成行内声明
    expect(bi.style.fontWeight).toBe("");
    // 未设样式的另一段保持基线（jsdom 的字号回报 medium，解析不出像素）
    expect(biOf(container, "b").style.fontSize).toBe("");
  });

  it("浅灰原文不把颜色传给译文（对照层还有一层不透明度），字号照旧派生", async () => {
    const { container, originals } = fx!;
    styleOriginal(originals[0], {
      "font-size": "18px",
      color: "rgb(200, 200, 200)",
    });
    await build(fx!.session);
    const bi = biOf(container, "a");
    expect(bi.style.color).toBe("");
    expect(bi.style.fontSize).toBe("16.6px");
  });

  it("取不到计算样式时保持基线，不抛错", async () => {
    const { container } = fx!;
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(() => ({}) as CSSStyleDeclaration);
    try {
      await build(fx!.session);
    } finally {
      spy.mockRestore();
    }
    const bi = biOf(container, "a");
    expect(bi.style.fontSize).toBe("");
    expect(bi.style.color).toBe("");
  });

  it("朗读高亮重建块内容后，派生样式仍在", async () => {
    const { container, originals } = fx!;
    styleOriginal(originals[0], {
      "font-size": "20px",
      "font-weight": "700",
    });
    const handle = await build(fx!.session);
    const bi = biOf(container, "a");
    expect(bi.style.fontSize).toBe("18.4px");
    expect(bi.style.fontWeight).toBe("700");
    // 先给一段译文，再驱动朗读高亮——高亮只重建块的子节点
    ((LazyTranslateQueue as unknown as { lastHooks: any }).lastHooks).onDone(
      "a",
      "第一句。第二句。",
    );
    handle.highlightTranslatedSentence("a", 0);
    expect(bi.querySelector(".ztransplit-sent-active")).toBeTruthy();
    expect(bi.textContent).toContain("第一句");
    // 行内声明挂在块自身上，不随子节点重建丢失
    expect(bi.style.fontSize).toBe("18.4px");
    expect(bi.style.fontWeight).toBe("700");
    await handle.dispose();
  });
});
