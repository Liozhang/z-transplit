// @vitest-environment jsdom
/**
 * interleaveView（src/core/pdf/sdt/interleaveView.ts）手动翻译触发（issue #3）：
 *
 *   - 选区非空时松开鼠标 → 选区旁出现「翻译本段」按钮
 *   - 点击按钮 → 所在块被翻译：清单外的块（被 collectBlocks 跳过的容器、
 *     晚渲染的段落）现场注入译文块并经 watch() 注册进队列
 *   - 已有译文的块 → force(..., bypassCache: true) 真正重译
 *   - 无 ref-path 的选区、选区收起 → 按钮不出现/隐藏
 *   - 参考文献区域（sdt-reference）与自动翻译同样排除：按钮不出现
 *   - 按钮位置在选区中下：水平居中、贴底边，越界时夹回视口
 *   - 在按钮上按下鼠标不提前隐藏按钮
 *   - dispose 移除按钮与文档级监听，手动注入的块一并清理
 *
 * LazyTranslateQueue 整体替换为记录型假件（watch/force 入参与 hooks 全部
 * 捕获），缓存替换为空转假件——翻译供给链路本身由 lazyQueue 自身的测试
 * 与 interleaveView.dom.test 覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recorded = vi.hoisted(() => ({
  hooks: null as any,
  watched: [] as Array<{ refPath: string; entry: any }>,
  forced: [] as Array<{ refPath: string; opts?: any }>,
}));

vi.mock("../../../../../src/core/pdf/sdt/lazyQueue", () => ({
  LazyTranslateQueue: class {
    constructor(
      _doc: unknown,
      _entries: unknown,
      hooks: any,
      _options: unknown,
    ) {
      recorded.hooks = hooks;
    }
    start(): void {}
    stop(): void {}
    stats(): { total: number; done: number; failed: number; loading: number; queued: number } {
      return { total: 0, done: 0, failed: 0, loading: 0, queued: 0 };
    }
    retry(): void {}
    currentRefPath(): string | null {
      return null;
    }
    watch(refPath: string, entry: any): void {
      recorded.watched.push({ refPath, entry });
    }
    force(refPath: string, opts?: any): void {
      recorded.forced.push({ refPath, opts });
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
  /** A <ul> with a ref-path that collectBlocks would skip (not in blocks). */
  skippedList: HTMLElement;
  /** A plain container child WITHOUT a ref-path (never translatable). */
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

  const skippedList = document.createElement("ul");
  skippedList.dataset.refPath = "x";
  skippedList.innerHTML = "<li>skipped item one</li><li>skipped item two</li>";
  container.appendChild(skippedList);

  const plainDiv = document.createElement("div");
  plainDiv.textContent = "no ref path here";
  container.appendChild(plainDiv);

  return {
    container,
    originals,
    skippedList,
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

function trigger(): HTMLElement {
  const el = document.querySelector(".ztransplit-bi-trigger");
  if (!el) throw new Error("no trigger button");
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

function clickTrigger(): void {
  trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("interleaveView：手动翻译触发", () => {
  let fx: Fixture | undefined;

  beforeEach(() => {
    recorded.hooks = null;
    recorded.watched.length = 0;
    recorded.forced.length = 0;
    fx = makeSession();
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    fx = undefined;
  });

  it("清单外的块：选区松开出现按钮，点击后注入译文块并注册进队列", async () => {
    const { container, skippedList, session } = fx!;
    await build(session);

    selectContents(skippedList);
    mouseUp(container);
    expect(trigger().style.display).toBe("block");

    clickTrigger();
    // 译文块注入在 <ul> 之后，与初始注入的兄弟结构一致
    const injected = skippedList.nextElementSibling as HTMLElement;
    expect(injected.className).toBe("ztransplit-bi");
    expect(injected.dataset.refPath).toBe("x");
    expect(container.contains(injected)).toBe(true);
    // watch() 把文本与占位块交给队列，force() 立即入队、不绕过缓存
    expect(recorded.watched).toEqual([
      {
        refPath: "x",
        entry: {
          text: expect.stringContaining("skipped item"),
          placeholder: injected,
        },
      },
    ]);
    expect(recorded.forced).toEqual([
      { refPath: "x", opts: { bypassCache: false } },
    ]);
  });

  it("已有译文的块：点击按钮以 bypassCache 重译，且不重复注入", async () => {
    const { container, originals, session } = fx!;
    await build(session);

    // 队列假件不回调，直接驱动 onDone 模拟「a 已译完」
    recorded.hooks.onDone("a", "译文甲");
    expect(originals[0].nextElementSibling!.textContent).toBe("译文甲");

    // 在译文块（注入块）内选择 —— 重译的是同一个 refPath
    const bi = container.querySelector(
      'div.ztransplit-bi[data-ref-path="a"]',
    ) as HTMLElement;
    selectContents(bi);
    mouseUp(container);
    clickTrigger();

    expect(recorded.watched).toEqual([]); // 会话清单内已有，无需注册
    expect(recorded.forced).toEqual([
      { refPath: "a", opts: { bypassCache: true } },
    ]);
    // 没有第二个 a 译文块
    expect(
      container.querySelectorAll('div.ztransplit-bi[data-ref-path="a"]').length,
    ).toBe(1);
  });

  it("无 ref-path 的选区不出按钮；选区收起后按钮隐藏", async () => {
    const { container, plainDiv, originals, session } = fx!;
    await build(session);

    // 按钮常驻 DOM（一次性创建），只以 display 控制显隐
    selectContents(plainDiv);
    mouseUp(container);
    expect(trigger().style.display).toBe("none");

    selectContents(originals[0]);
    mouseUp(container);
    expect(trigger().style.display).toBe("block");
    window.getSelection()!.removeAllRanges();
    mouseUp(container);
    expect(trigger().style.display).toBe("none");
  });

  it("参考文献区域与自动翻译同样排除：按钮不出现", async () => {
    const { container, session } = fx!;
    const refs = document.createElement("div");
    refs.className = "sdt-reference";
    refs.dataset.refPath = "r";
    refs.textContent = "Smith J. et al. Some paper. 2024.";
    container.appendChild(refs);
    await build(session);

    selectContents(refs);
    mouseUp(container);
    expect(trigger().style.display).toBe("none");
    expect(recorded.watched).toEqual([]);
    expect(recorded.forced).toEqual([]);
  });

  it("按钮位于选区中下：水平居中、贴底边，越界时夹回视口", async () => {
    const { container, originals, session } = fx!;
    await build(session);

    const proto = Range.prototype as any;
    const originalRect = proto.getBoundingClientRect;
    try {
      // jsdom 无布局：按钮 offsetWidth 为 0，实现回退到 120
      proto.getBoundingClientRect = () => ({
        left: 300,
        width: 100,
        bottom: 200,
      });
      selectContents(originals[0]);
      mouseUp(container);
      // 中心 350，左移半宽 60 → 290；视口 1024 内不触边
      expect(trigger().style.left).toBe("290px");
      expect(trigger().style.top).toBe("206px");

      proto.getBoundingClientRect = () => ({
        left: 980,
        width: 100,
        bottom: 200,
      });
      mouseUp(container);
      // 不夹取会得到 970；上限 1024 − 120 − 8 = 896
      expect(trigger().style.left).toBe("896px");
    } finally {
      if (originalRect === undefined) delete proto.getBoundingClientRect;
      else proto.getBoundingClientRect = originalRect;
    }
  });

  it("在按钮上按下鼠标不提前隐藏按钮", async () => {
    const { container, originals, session } = fx!;
    await build(session);
    selectContents(originals[0]);
    mouseUp(container);
    trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(trigger().style.display).toBe("block");
  });

  it("dispose 移除按钮与文档级监听，手动注入的块一并清理", async () => {
    const { container, skippedList, session } = fx!;
    const handle = await build(session);

    selectContents(skippedList);
    mouseUp(container);
    clickTrigger();
    expect(container.querySelectorAll(".ztransplit-bi").length).toBe(3); // a, b, x

    await handle.dispose();
    expect(container.querySelectorAll(".ztransplit-bi").length).toBe(0);
    expect(document.querySelector(".ztransplit-bi-trigger")).toBeNull();

    // 解绑后 mouseup 不再抛错、也不再恢复按钮
    selectContents(skippedList);
    mouseUp(container);
    expect(document.querySelector(".ztransplit-bi-trigger")).toBeNull();
  });
});
