// @vitest-environment jsdom
/**
 * 漏译看护（issue #3 后续）：会话清单漏掉的段落必须能被救回，并且整条
 * 供给链路真实走通——不是假件上的「注册了」而是「翻出来了」。
 *
 * 既有覆盖（interleaveView.manual.test.ts）用记录型队列假件钉住了触发与
 * 注册的入参契约；本文件补上它不能覆盖的半段：真实 LazyTranslateQueue
 * 消费 watch()/force() 注册的条目，真实渲染回调把译文写进注入块，队列
 * 统计把每个块都算进账——漏译的最终形态是「段落在页面上仍然没有译文」，
 * 看护必须断言到这一层。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../src/core/translation/translationCache", () => ({
  cacheAvailable: vi.fn(() => false),
  cacheKey: vi.fn(async () => null),
  getCachedTranslations: vi.fn(async () => new Map()),
  putCachedTranslation: vi.fn(async () => {}),
}));

// 真实 LazyTranslateQueue 不替换：jsdom 无布局，getBoundingClientRect 全零
// 的占位块落在视口判定内，force() 又是同步入队，链路完全可驱动。

import { buildInterleave } from "../../../../../src/core/pdf/sdt/interleaveView";

type AnySession = Parameters<typeof buildInterleave>[0];

interface Fixture {
  container: HTMLElement;
  /** 晚渲染的段落：有 ref-path，但不在 session.blocks 里。 */
  late: HTMLElement;
  session: AnySession;
}

function makeSession(): Fixture {
  const container = document.createElement("div");
  container.id = "sdt-content";
  document.body.appendChild(container);

  const p = document.createElement("p");
  p.dataset.refPath = "a";
  p.textContent = "orig-a";
  container.appendChild(p);

  const late = document.createElement("p");
  late.dataset.refPath = "late";
  late.textContent = "late rendered paragraph";
  container.appendChild(late);

  return {
    container,
    late,
    session: {
      reader: {},
      internalReader: {},
      sdtView: {},
      doc: document,
      container,
      blocks: [{ refPath: "a", text: "orig-a", el: p }],
      exit: vi.fn(async () => {}),
    } as unknown as AnySession,
  };
}

function flush(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询直到条件成立；jsdom 有 setInterval，真实队列靠 700ms 几何轮询推进。 */
async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await flush(50);
  }
}

function trigger(): HTMLElement {
  const el = document.querySelector(".ztransplit-bi-trigger");
  if (!el) throw new Error("no trigger button");
  return el as HTMLElement;
}

describe("漏译看护：清单外段落端到端救回", () => {
  let fx: Fixture | undefined;
  const translatedTexts: string[] = [];

  beforeEach(() => {
    translatedTexts.length = 0;
    fx = makeSession();
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    fx = undefined;
  });

  it("晚渲染段落：手动触发后真实队列翻译并渲染，统计入账", async () => {
    const { container, late, session } = fx!;
    const handle = await buildInterleave(session, {
      targetLanguage: "zh-CN",
      batchTranslate: async (texts: string[]) => {
        translatedTexts.push(...texts);
        return {
          translations: texts.map((t) => "译-" + t),
          failedIndices: [],
        };
      },
    });

    // 会话清单只有 a；晚渲染的 late 不在清单里
    expect(container.querySelectorAll(".ztransplit-bi").length).toBe(1);

    // 选区落在晚渲染段落上，松开 → 按钮 → 点击
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(late);
    sel.addRange(range);
    late.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(trigger().style.display).toBe("block");
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // 真实队列异步消化：force() 立即入队，清单内的 a 由几何轮询收编；
    // 等两块全部落定（没有任何块被静默丢弃）。
    await waitUntil(() => handle.stats().done === 2);

    // 端到端断言：译文块已注入、真实翻译已渲染到页面上
    const injected = container.querySelector(
      'div.ztransplit-bi[data-ref-path="late"]',
    );
    expect(injected).toBeTruthy();
    expect(injected!.textContent).toBe("译-late rendered paragraph");
    // 救回段与清单内段都真实送过引擎（force 送出 late，轮询收编 a）
    expect(translatedTexts).toContain("late rendered paragraph");
    expect(translatedTexts).toContain("orig-a");
    expect(handle.stats()).toMatchObject({ total: 2, done: 2, failed: 0 });
    // 朗读段也包含救回的段落（bonus：不丢读）
    expect(
      handle
        .translatedReadSegments()
        .some((s) => s.text.includes("late rendered")),
    ).toBe(true);

    await handle.dispose();
  });

  it("翻译失败的清单外块：渲染失败态而不是静默消失，可重试", async () => {
    const { container, late, session } = fx!;
    const handle = await buildInterleave(session, {
      targetLanguage: "zh-CN",
      batchTranslate: async (texts: string[]) => ({
        translations: texts.map(() => ""),
        failedIndices: texts.map((_, i) => i),
      }),
    });

    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(late);
    sel.addRange(range);
    late.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitUntil(() => {
      const st = handle.stats();
      return st.done + st.failed === 2;
    });

    const injected = container.querySelector(
      'div.ztransplit-bi[data-ref-path="late"]',
    )!;
    // 失败可见 + 有重试入口；统计 failed 入账
    expect(injected.querySelector(".ztransplit-bi-error")).toBeTruthy();
    expect(injected.querySelector(".ztransplit-bi-retry")).toBeTruthy();
    expect(handle.stats()).toMatchObject({ total: 2, done: 0, failed: 2 });

    await handle.dispose();
  });
});
