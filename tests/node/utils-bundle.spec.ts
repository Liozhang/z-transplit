/**
 * utils-bundle — 四个小工具加一个取消错误类型。
 *
 * 为什么打包成一个文件：各自 15 到 61 行，全是纯函数或近乎纯的类，而且是同一批
 * 补测对象。分成五个文件会有五个几乎一样的头部注释。
 *
 * 挑这几个的理由不是"没测"，而是"它们在最不经意的处被依赖"：
 *   - `Semaphore` 是 JVM 解析并发与批量翻译并发的闸门，放太宽会把机器压垮；
 *   - `isIMEComposing` 决定合成期按 Enter 是确认候选还是提交——正是那种
 *     "面板层测了、谓词本身没测"的一行，回归了很难查；
 *   - `abort` 那三级回退是 Zotero 10.0.3 上实测出来的（插件作用域里
 *     `AbortController` 不存在）；
 *   - `ZTransplitCancelledError` 的识别契约是按 `name` 而不是按消息文本——
 *     消息走本地化，按文本比会在切语言后失效。
 *
 * `dom` 那一组需要真实 DOM，所以本文件跑 jsdom 环境（仓库里既有 9 个文件用
 * 同一手法）；其余各组在 Node 下即可。
 *
 * @module tests/node/utils-bundle
 */

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  abortSignalTimeout,
  createAbortController,
  getAbortControllerCtor,
} from "../../src/utils/abort";
import { Semaphore } from "../../src/utils/Semaphore";
import { isIMEComposing } from "../../src/utils/ime";
import { XHTML_NS, clearChildren, el } from "../../src/utils/dom";
import { ZTransplitCancelledError } from "../../src/core/pdf/CancelledError";

describe("Semaphore", () => {
  it("并发未达上限时立即拿到许可", async () => {
    const sem = new Semaphore(2);
    const release = await sem.acquire();
    expect(typeof release).toBe("function");
    release();
  });

  it("达到上限后第三个要等前一个释放", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let thirdDone = false;
    const third = sem.acquire().then((release) => {
      thirdDone = true;
      return release;
    });
    // 让微任务跑一轮：第三个此时必须还卡着。
    await Promise.resolve();
    expect(thirdDone).toBe(false);
    r1();
    const r3 = await third;
    expect(thirdDone).toBe(true);
    r2();
    r3();
  });

  it("释放函数幂等，重复调用不把计数扣成负数", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    release();
    // 若计数被扣成负数，下面这个 acquire 之后的第二个就会异常地立即成功。
    const a = await sem.acquire();
    let bDone = false;
    const b = sem.acquire().then((r) => {
      bDone = true;
      return r;
    });
    await Promise.resolve();
    expect(bDone).toBe(false);
    a();
    await b;
  });

  it("释放按排队顺序唤醒，不是任意一个", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = await sem.acquire();
    // 注意：await 一个 acquire() 拿到的是**释放函数**，不会自动释放。所以这里
    // 先把三个释放函数收起来，再按顺序手动调，才能真正验唤醒顺序。
    const releases: Array<() => void> = [];
    for (const n of [1, 2, 3]) {
      sem.acquire().then((release) => {
        order.push(n);
        releases.push(release);
      });
    }
    await Promise.resolve();
    expect(order).toEqual([]);
    first();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);
    releases[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2, 3]);
    releases[2]();
  });

  it("max 为 1 时等价于互斥锁", async () => {
    const sem = new Semaphore(1);
    const a = await sem.acquire();
    let bStarted = false;
    const b = sem.acquire().then((r) => {
      bStarted = true;
      return r;
    });
    await Promise.resolve();
    expect(bStarted).toBe(false);
    a();
    await b;
  });
});

describe("isIMEComposing", () => {
  it("合成期为真", () => {
    expect(isIMEComposing({ isComposing: true })).toBe(true);
    expect(isIMEComposing({ keyCode: 229 })).toBe(true);
  });

  it("非合成期为假", () => {
    expect(isIMEComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isIMEComposing({})).toBe(false);
  });

  it("空事件不抛错", () => {
    expect(isIMEComposing(null)).toBe(false);
    expect(isIMEComposing(undefined)).toBe(false);
  });

  it("nativeEvent 上的合成期同样算（合成期按 Enter 是确认候选，不是提交）", () => {
    expect(isIMEComposing({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isIMEComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isIMEComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });

  it("两者都没给时不当成合成期", () => {
    expect(isIMEComposing({ nativeEvent: {} })).toBe(false);
  });
});

describe("abort — 插件作用域里的 AbortController", () => {
  it("平台全局有时直接用，不去找主窗口", () => {
    // Node 有全局 AbortController，这条走的就是快路径。
    const ctor = getAbortControllerCtor();
    expect(typeof ctor).toBe("function");
    const controller = createAbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("平台全局缺失时从 Zotero 主窗口取", () => {
    // 这正是 Zotero 10.0.3 上实测到的情形：插件作用域里 AbortController 不存在，
    // 它住在主窗口上。三级回退的第一级失效时必须落到第二级。
    const real = (globalThis as any).AbortController;
    const fakeWindow = { AbortController: real };
    const stubbed = { getMainWindow: () => fakeWindow };
    const had = (globalThis as any).Zotero;
    try {
      delete (globalThis as any).AbortController;
      (globalThis as any).Zotero = stubbed;
      expect(getAbortControllerCtor()).toBe(real);
      const controller = createAbortController();
      expect(controller.signal.aborted).toBe(false);
    } finally {
      (globalThis as any).AbortController = real;
      if (had === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = had;
    }
  });

  it("两级都没有时返回 undefined，createAbortController 抛可读的错误", () => {
    const real = (globalThis as any).AbortController;
    const had = (globalThis as any).Zotero;
    try {
      delete (globalThis as any).AbortController;
      delete (globalThis as any).Zotero;
      expect(getAbortControllerCtor()).toBeUndefined();
      expect(() => createAbortController()).toThrow(/AbortController unavailable/);
    } finally {
      (globalThis as any).AbortController = real;
      if (had === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = had;
    }
  });

  it("abortSignalTimeout 优先用平台静态方法", () => {
    // Node 18+ 有 AbortSignal.timeout。
    const signal = abortSignalTimeout(10);
    expect(signal).toBeDefined();
    expect(typeof signal.aborted).toBe("boolean");
  });

  it("平台静态缺失时退回控制器加定时器", () => {
    const realSignal = (globalThis as any).AbortSignal;
    const realAC = (globalThis as any).AbortController;
    const had = (globalThis as any).Zotero;
    try {
      // 造一个没有静态 timeout 的 AbortSignal，并给一个会立即触发的主窗口定时器。
      (globalThis as any).AbortSignal = function NoTimeout() {};
      (globalThis as any).AbortController = realAC;
      (globalThis as any).Zotero = {
        getMainWindow: () => ({ setTimeout: (fn: () => void) => fn() }),
      };
      const signal = abortSignalTimeout(5);
      expect(signal).toBeDefined();
      // 定时器立即触发，所以信号应当已经中止。
      expect(signal.aborted).toBe(true);
    } finally {
      (globalThis as any).AbortSignal = realSignal;
      (globalThis as any).AbortController = realAC;
      if (had === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = had;
    }
  });

  it("拿不到定时器时返回一个永不中止的信号，不抛错", () => {
    const realSignal = (globalThis as any).AbortSignal;
    const realAC = (globalThis as any).AbortController;
    const had = (globalThis as any).Zotero;
    try {
      (globalThis as any).AbortSignal = function NoTimeout() {};
      (globalThis as any).AbortController = realAC;
      delete (globalThis as any).Zotero;
      const signal = abortSignalTimeout(5);
      expect(signal).toBeDefined();
      expect(signal.aborted).toBe(false);
    } finally {
      (globalThis as any).AbortSignal = realSignal;
      (globalThis as any).AbortController = realAC;
      if (had === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = had;
    }
  });
});

describe("dom — XHTML 命名空间的元素助手", () => {
  it("常量就是 XHTML 命名空间", () => {
    expect(XHTML_NS).toBe("http://www.w3.org/1999/xhtml");
  });

  it("el 建在 XHTML 命名空间里，不是 HTML 命名空间", () => {
    // Zotero 7 的 chrome 文档里建错了命名空间的元素渲染不出来——这是这条断言
    // 存在的全部理由。
    const doc = document.implementation.createDocument(XHTML_NS, "html", null);
    const node = el(doc, "div", "cls");
    expect(node.namespaceURI).toBe(XHTML_NS);
    expect(node.tagName).toBe("div");
    expect(node.className).toBe("cls");
  });

  it("不传类名时不设 className", () => {
    const doc = document.implementation.createDocument(XHTML_NS, "html", null);
    const node = el(doc, "span");
    expect(node.className).toBe("");
    expect(node.namespaceURI).toBe(XHTML_NS);
  });

  it("clearChildren 清空所有子节点", () => {
    const doc = document.implementation.createDocument(XHTML_NS, "html", null);
    const parent = el(doc, "div");
    parent.appendChild(el(doc, "span"));
    parent.appendChild(el(doc, "span"));
    parent.appendChild(el(doc, "span"));
    expect(parent.childNodes.length).toBe(3);
    clearChildren(parent);
    expect(parent.childNodes.length).toBe(0);
  });

  it("clearChildren 对空节点是空操作", () => {
    const doc = document.implementation.createDocument(XHTML_NS, "html", null);
    const parent = el(doc, "div");
    expect(() => clearChildren(parent)).not.toThrow();
    expect(parent.childNodes.length).toBe(0);
  });
});

describe("ZTransplitCancelledError", () => {
  it("按 name 识别，不按消息文本（消息走本地化）", () => {
    // 契约就在文件头注释里：调用方必须按 name 比较。按文本比的话，切语言之后
    // 就再也认不出取消，会被当成普通失败上报给用户。
    const err = new ZTransplitCancelledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ZTransplitCancelled");
  });

  it("消息非空（无宿主时退回键名）", () => {
    const err = new ZTransplitCancelledError();
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("两个实例的 name 一致，可直接用于 catch 里归类", () => {
    const a = new ZTransplitCancelledError();
    const b = new ZTransplitCancelledError();
    expect(a.name).toBe(b.name);
  });
});
