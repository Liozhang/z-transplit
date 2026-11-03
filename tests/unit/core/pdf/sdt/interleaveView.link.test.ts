// @vitest-environment jsdom
/**
 * interleaveView（src/core/pdf/sdt/interleaveView.ts）段落级联动高亮：
 *
 *   - 上下对照模式选中原文块 → 原文与对应译文块同亮（data-linked）
 *   - 选中译文块 → 反向联动，两侧同亮
 *   - 改选另一段 → 旧的清除、新的亮（单一焦点）
 *   - 选区收起 / 无 ref-path / 引用区 → 不高亮
 *   - 键盘选择（keyup）同样联动
 *   - 仅译文模式不联动；切模式与 dispose 剥离临时属性（含官方元素上的）
 *   - 样式契约：仅对照模式作用域、两侧同浓度、inset 竖线、横条除外
 *
 * LazyTranslateQueue 与翻译缓存整体替换为假件——本文件只关注选区联动
 * 与注入的模式类，翻译供给链路由既有测试覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../src/core/pdf/sdt/lazyQueue", () => ({
  LazyTranslateQueue: class {
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

type AnySession = Parameters<typeof buildInterleave>[0];

interface Fixture {
  container: HTMLElement;
  originals: HTMLElement[];
  plainDiv: HTMLElement;
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
  // 无 ref-path 的普通节点：选区落在它里面不联动
  const plainDiv = document.createElement("div");
  plainDiv.textContent = "no ref path here";
  container.appendChild(plainDiv);
  return {
    container,
    originals,
    plainDiv,
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

function selectContents(el: Element): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.addRange(range);
}

function mouseUp(at: Element): void {
  at.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function keyUp(): void {
  document.dispatchEvent(new Event("keyup", { bubbles: true }));
}

/** 当前带 data-linked 的元素（含官方原文块与注入译文块）。 */
function linked(): Element[] {
  return Array.from(document.querySelectorAll("[data-linked]"));
}

describe("interleaveView：段落级联动高亮", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    fx = makeSession();
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    fx = undefined;
  });

  it("选中原文块：原文与对应译文块同亮，另一段不受影响", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);

    selectContents(originals[0]);
    mouseUp(container);

    expect(originals[0].getAttribute("data-linked")).toBe("");
    expect(biOf(container, "a").getAttribute("data-linked")).toBe("");
    // 单一焦点：另一段两侧都不亮
    expect(originals[1].hasAttribute("data-linked")).toBe(false);
    expect(biOf(container, "b").hasAttribute("data-linked")).toBe(false);
  });

  it("选中译文块：反向联动，两侧同亮", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);

    selectContents(biOf(container, "b"));
    mouseUp(container);

    expect(biOf(container, "b").getAttribute("data-linked")).toBe("");
    expect(originals[1].getAttribute("data-linked")).toBe("");
    expect(originals[0].hasAttribute("data-linked")).toBe(false);
  });

  it("改选另一段：旧的清除、新的亮", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);

    selectContents(originals[0]);
    mouseUp(container);
    expect(linked().length).toBe(2);

    selectContents(originals[1]);
    mouseUp(container);
    expect(originals[0].hasAttribute("data-linked")).toBe(false);
    expect(biOf(container, "a").hasAttribute("data-linked")).toBe(false);
    expect(originals[1].getAttribute("data-linked")).toBe("");
    expect(biOf(container, "b").getAttribute("data-linked")).toBe("");
    expect(linked().length).toBe(2);
  });

  it("选区收起后松开：全部清除", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);

    selectContents(originals[0]);
    mouseUp(container);
    expect(linked().length).toBe(2);

    window.getSelection()!.removeAllRanges();
    mouseUp(container);
    expect(linked().length).toBe(0);
    expect(originals[0].hasAttribute("data-linked")).toBe(false);
  });

  it("无 ref-path 的选区与引用区：不高亮", async () => {
    const { container, plainDiv, session } = fx!;
    const refs = document.createElement("div");
    refs.className = "sdt-reference";
    refs.dataset.refPath = "r";
    refs.textContent = "Smith J. et al. Some paper. 2024.";
    container.appendChild(refs);
    await build(session);

    selectContents(plainDiv);
    mouseUp(container);
    expect(linked().length).toBe(0);

    selectContents(refs);
    mouseUp(container);
    expect(linked().length).toBe(0);
  });

  it("键盘选择（keyup）同样联动", async () => {
    const { container, originals } = fx!;
    await build(fx!.session);

    selectContents(originals[0]);
    keyUp();

    expect(originals[0].getAttribute("data-linked")).toBe("");
    expect(biOf(container, "a").getAttribute("data-linked")).toBe("");
  });

  it("仅译文模式不联动：原文整批隐藏，另一侧不可见", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);
    handle.setMode("transOnly");

    selectContents(biOf(container, "a"));
    mouseUp(container);

    expect(linked().length).toBe(0);
    // 官方元素上不留临时属性
    expect(originals[0].hasAttribute("data-linked")).toBe(false);
  });

  it("切模式清除联动；切回后重新选择可再亮", async () => {
    const { container, originals } = fx!;
    const handle = await build(fx!.session);

    selectContents(originals[0]);
    mouseUp(container);
    expect(linked().length).toBe(2);

    handle.setMode("transOnly");
    expect(linked().length).toBe(0);

    handle.setMode("interleave");
    selectContents(originals[0]);
    mouseUp(container);
    expect(linked().length).toBe(2);
  });

  it("dispose 剥离官方元素上的临时属性并解绑监听", async () => {
    const { container, originals, session } = fx!;
    const handle = await build(session);

    selectContents(originals[0]);
    mouseUp(container);
    expect(linked().length).toBe(2);

    await handle.dispose();
    expect(originals[0].hasAttribute("data-linked")).toBe(false);
    expect(container.querySelectorAll(".ztransplit-bi").length).toBe(0);
    expect(session.exit).toHaveBeenCalled();

    // 解绑后再操作不再产生任何状态
    selectContents(originals[0]);
    mouseUp(container);
    keyUp();
    expect(linked().length).toBe(0);
  });
});

describe("interleaveView：联动样式契约", () => {
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

  it("仅对照模式作用域，两侧同浓度，原文侧带 inset 竖线", async () => {
    await build(fx!.session);
    const text = css();

    const orig =
      /\.ztransplit-bi-mode-interleave \[data-ref-path\]\[data-linked\]\s*\{([^}]*)\}/.exec(
        text,
      );
    expect(orig).toBeTruthy();
    expect(orig![1]).toContain("rgba(31, 158, 141, 0.14)");
    expect(orig![1]).toContain("box-shadow: inset 3px 0 0");
    // 竖线不占布局：不用 border（peek 的一次性显隐可以接受跳动）
    expect(orig![1]).not.toContain("border-inline-start");

    const trans =
      /\.ztransplit-bi-mode-interleave \.ztransplit-bi\[data-linked\]:not\(\[data-hidden\]\)\s*\{([^}]*)\}/.exec(
        text,
      );
    expect(trans).toBeTruthy();
    expect(trans![1]).toContain("rgba(31, 158, 141, 0.14)");
    // 折叠横条保持自己的灰色身份
    expect(trans![0]).toContain(":not([data-hidden])");
  });

  it("不泄漏到仅译文模式，且与朗读句高亮的暖色分开", async () => {
    await build(fx!.session);
    const text = css();
    expect(text).not.toMatch(/ztransplit-bi-mode-trans-only[^{]*\[data-linked\]/);
    expect(text).toMatch(/\.ztransplit-sent-active\s*\{[^}]*245, 158, 11/);
  });
});
