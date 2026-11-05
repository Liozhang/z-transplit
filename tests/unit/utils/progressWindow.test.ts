/**
 * 进度弹窗封装（utils/progressWindow.ts）的单元测试。
 *
 * 三处字段缺陷各有一条对应的钉子：
 *   1. 解析组件下载完成后弹窗不自动关闭 —— 终止分支只有 settle/fail 会设置
 *      关闭计时器，dismiss 不会锁终态（错误路径要先收起进行中弹窗，再补失败
 *      行，所以两者必须区分）。
 *   2. 双语懒翻译在终态后继续汇报，把刚关掉的弹窗又打开且不再计时 ——
 *      settle() 之后的 fraction()/note() 必须什么都不做。
 *   3. 每次汇报追加一行 —— fraction() 必须只建一行并就地改写。
 *
 * 宿主行为用 tests/qa/harness/zotero-mock.ts 的 ProgressWindow 替身：它按
 * Zotero 源码实现 ItemProgress（一行、setText 改写、setProgress 走圆形指示
 * 器），并记录调用顺序与行内容。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createZoteroMock } from "../../qa/harness/zotero-mock";
import { ProgressReporter } from "../../../src/utils/progressWindow";

let z: ReturnType<typeof createZoteroMock> | null = null;

function mount() {
  z = createZoteroMock();
  z.install();
  return z;
}

afterEach(() => {
  z?.uninstall();
  z = null;
});

/** 最近一次创建的弹窗替身。 */
function lastPopup(zmock: any) {
  return zmock.progressWindowInstances[zmock.progressWindowInstances.length - 1];
}

describe("ProgressReporter 生命周期", () => {
  it("构造即写入标题并显示", () => {
    const zmock = mount();
    new ProgressReporter({ headline: "Z-Transplit: 正在翻译全文…" });
    const pw = lastPopup(zmock);
    expect(pw.headline).toBe("Z-Transplit: 正在翻译全文…");
    expect(pw.shows).toBe(1);
  });

  it("note() 每次追加一行，并保持弹窗可见", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.note("正在解析 PDF 版面…");
    r.note("正在叠加译文…");
    const pw = lastPopup(zmock);
    expect(pw.descriptions).toEqual(["正在解析 PDF 版面…", "正在叠加译文…"]);
    // 两次 note 各调用一次 show()：用户手动关掉后，进行中的阶段行要能把它带回来
    expect(pw.shows).toBe(3); // 构造 1 次 + note 2 次
  });

  it("settle() 打印终态行并设置关闭计时器", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.settle("完成：已分屏打开「论文」", 4000);
    const pw = lastPopup(zmock);
    expect(pw.descriptions).toEqual(["完成：已分屏打开「论文」"]);
    expect(pw.closeTimers).toEqual([4000]);
  });

  it("settle(null) 只设置计时器，不追加空行", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.settle(null, 8000);
    const pw = lastPopup(zmock);
    expect(pw.descriptions).toEqual([]);
    expect(pw.closeTimers).toEqual([8000]);
  });

  it("fail() 打印失败行、设置计时器并锁终态", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.fail("✗ 引擎未配置", 10000);
    const pw = lastPopup(zmock);
    expect(pw.descriptions).toEqual(["✗ 引擎未配置"]);
    expect(pw.closeTimers).toEqual([10000]);
  });
});

describe("ProgressReporter 终态锁", () => {
  it("settle() 之后的迟汇报不再开窗、不再追加行", () => {
    // 复现字段缺陷：双语会话的懒翻译在「双语阅读已就绪」+3 秒之后仍在汇报，
    // 旧代码每次都 addDescription + show()，把刚关掉的弹窗又打开，且没有
    // 新的计时器——弹窗从此挂在主窗口角落不消失。
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.settle("双语阅读已就绪", 3000);
    const pw = lastPopup(zmock);
    const showsAfterSettle = pw.shows;

    r.fraction(3, 12, "已译 3/12 段");
    r.fraction(7, 12, "已译 7/12 段");
    r.note("迟到的阶段行");

    expect(pw.shows).toBe(showsAfterSettle);
    expect(pw.descriptions).toEqual(["双语阅读已就绪"]);
    expect(pw.rows).toEqual([]);
  });

  it("fail() 之后同样锁终态", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.fail("✗ 失败", 8000);
    r.fraction(1, 4, "已译 1/4 段");
    const pw = lastPopup(zmock);
    expect(pw.rows).toEqual([]);
    expect(pw.descriptions).toEqual(["✗ 失败"]);
  });

  it("dismiss() 只收起弹窗，不锁终态：错误路径先 dismiss 再补失败行", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.dismiss(1000);
    r.fail("✗ 翻译失败", 10000);
    const pw = lastPopup(zmock);
    // 计时器被后一次调用替换，与旧行为一致
    expect(pw.closeTimers).toEqual([1000, 10000]);
    expect(pw.descriptions).toEqual(["✗ 翻译失败"]);
  });
});

describe("ProgressReporter 单一进度行", () => {
  it("fraction() 只建一行，文本与百分比就地改写", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.fraction(1, 4, "批量翻译进度：1/4 块");
    r.fraction(2, 4, "批量翻译进度：2/4 块");
    r.fraction(3, 4, "批量翻译进度：3/4 块");
    const pw = lastPopup(zmock);
    expect(pw.rows).toHaveLength(1);
    expect(pw.rows[0].texts).toEqual([
      "批量翻译进度：1/4 块",
      "批量翻译进度：2/4 块",
      "批量翻译进度：3/4 块",
    ]);
    expect(pw.rows[0].percents).toEqual([25, 50, 75]);
    // 进度行不污染描述区
    expect(pw.descriptions).toEqual([]);
  });

  it("百分比按四舍五入取整，并钳制在 0–100", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.fraction(1, 3, "a"); // 33.33 → 33
    r.fraction(5, 12, "b"); // 41.67 → 42
    r.fraction(12, 12, "c"); // 100
    r.fraction(0, 0, "d"); // 分母为 0 → 0
    r.fraction(99, 50, "e"); // 越界 → 100
    const pw = lastPopup(zmock);
    expect(pw.rows[0].percents).toEqual([33, 42, 100, 0, 100]);
  });

  it("宿主没有 ItemProgress 时退化为追加行，数字不丢", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    delete (lastPopup(zmock) as any).ItemProgress;
    r.fraction(2, 8, "已译 2/8 段");
    const pw = lastPopup(zmock);
    expect(pw.rows).toEqual([]);
    expect(pw.descriptions).toEqual(["已译 2/8 段"]);
  });
});

describe("ProgressReporter 容错", () => {
  it("弹窗调用抛错不会向外传播", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    const pw = lastPopup(zmock);
    (pw as any).addDescription = () => {
      throw new Error("popup is gone");
    };
    expect(() => r.note("任何一行")).not.toThrow();
    expect(() => r.fraction(1, 2, "半程")).not.toThrow();
    expect(() => r.settle("完成", 3000)).not.toThrow();
    expect(() => r.dismiss(1000)).not.toThrow();
    expect(() => r.close()).not.toThrow();
  });

  it("Zotero 全局缺失时构造不抛错由调用方兜底（此处仅验证 close 幂等）", () => {
    const zmock = mount();
    const r = new ProgressReporter({ headline: "标题" });
    r.close();
    r.close();
    const pw = lastPopup(zmock);
    expect(pw.closed).toBe(true);
  });
});
