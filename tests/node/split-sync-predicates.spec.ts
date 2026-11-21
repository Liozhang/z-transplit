/**
 * split-sync-predicates — 分屏同步的阈值谓词与缩放静置暂停。
 *
 * 为什么单立一个文件：`splitViewSync.ts` 有 410 行、13 个导出，而
 * `tests/node/split-sync.spec.ts` 只覆盖其中 3 个（且都是从 `splitViewFactory`
 * 再导出后测的）。`fractionMoved` / `hFractionMoved` 这两个名字在整个 tests/ 里
 * 一次都没出现过。
 *
 * 它们决定的是"这一次滚动算不算用户操作"：
 *   - 判轻了，缩放后 pdf.js 重排造成的瞬时跳动会被当成用户滚动，把另一侧拽到
 *     错误位置，而且那个迟到的 settle 事件会逃过单 tick 的 mirrorGuard 弹回来，
 *     形成乒乓；
 *   - 判重了，小幅滚动不同步，读者会觉得分屏"粘手"。
 *
 * 两个阈值的来源都写在注释里：FRACTION_THRESHOLD 0.002 是"超过这个才算移动"，
 * SCALE_THRESHOLD 0.001 是"pdf.js 缩放运算的浮点噪声"。测试把这两个数当契约钉住，
 * 顺手照住 null 的语义（prime 之后第一次读、横向无滚动范围）——那两种情形下的
 * "不算移动"都是有理由的，不是漏判。
 *
 * @module tests/node/split-sync-predicates
 */

import { describe, expect, it, vi } from "vitest";

import {
  FRACTION_THRESHOLD,
  SCALE_THRESHOLD,
  ZOOM_SETTLE_MS,
  fractionMoved,
  hFractionMoved,
  pauseSyncForZoomSettle,
} from "../../src/core/pdf/splitview/splitViewSync";
import type { SplitTabState } from "../../src/core/pdf/splitview/types";

describe("阈值常量", () => {
  it("两个阈值都是契约值，改了会同时改行为", () => {
    expect(FRACTION_THRESHOLD).toBe(0.002);
    expect(SCALE_THRESHOLD).toBe(0.001);
    expect(ZOOM_SETTLE_MS).toBe(200);
  });
});

describe("fractionMoved", () => {
  it("prev 为 null 时不算移动（prime 之后的第一次读）", () => {
    // 第一次读没有可比对象。把它算成移动会让每次开分屏都触发一次无谓同步。
    expect(fractionMoved(0.5, null)).toBe(false);
    expect(fractionMoved(0, null)).toBe(false);
    expect(fractionMoved(1, null)).toBe(false);
  });

  it("超过阈值算移动", () => {
    expect(fractionMoved(0.5, 0.4975)).toBe(true);
    expect(fractionMoved(0.5, 0.503)).toBe(true);
  });

  it("恰好等于阈值不算移动（判据是严格大于）", () => {
    // 边界要用可精确表示的一对来测：以 0 为基准时，0.002 减去 0 得到的还是
    // 同一个双精度数，与阈值严格相等，判假。若拿 0.502 减 0.5 当"恰好等于"，
    // 实际差值是 0.0020000000000000018，会比阈值大一点点——那是浮点表示问题，
    // 不是判据问题，为它写断言只会得到一个随平台漂的结果。
    expect(fractionMoved(0.002, 0)).toBe(false);
    expect(fractionMoved(0, 0.002)).toBe(false);
  });

  it("阈值之内与阈值之外各一例", () => {
    expect(fractionMoved(0.001, 0)).toBe(false);
    expect(fractionMoved(0.0021, 0)).toBe(true);
  });

  it("方向无关，只看绝对差", () => {
    expect(fractionMoved(0.2, 0.21)).toBe(fractionMoved(0.21, 0.2));
    expect(fractionMoved(0.2, 0.21)).toBe(true);
  });

  it("从 0 到 1 的整程翻页算移动", () => {
    expect(fractionMoved(1, 0)).toBe(true);
    expect(fractionMoved(0, 1)).toBe(true);
  });
});

describe("hFractionMoved", () => {
  it("任一侧为 null 都不算移动", () => {
    // null 的两种合法来源都写在注释里：缩放静置后的 prime，以及横向本就放得下
    // （没有横向滚动范围）的页面。两种都不该被当成用户横向滚动。
    expect(hFractionMoved(null, 0.5)).toBe(false);
    expect(hFractionMoved(0.5, null)).toBe(false);
    expect(hFractionMoved(null, null)).toBe(false);
  });

  it("超过阈值算移动，与纵向同阈值", () => {
    expect(hFractionMoved(0.5, 0.4975)).toBe(true);
    expect(hFractionMoved(0.5, 0.503)).toBe(true);
  });

  it("阈值之内与阈值之外各一例（边界同理用可精确表示的一对）", () => {
    expect(hFractionMoved(0.5, 0.5)).toBe(false);
    expect(hFractionMoved(0.002, 0)).toBe(false);
    expect(hFractionMoved(0.0021, 0)).toBe(true);
  });

  it("方向无关", () => {
    expect(hFractionMoved(0.2, 0.21)).toBe(hFractionMoved(0.21, 0.2));
  });
});

describe("pauseSyncForZoomSettle", () => {
  /** 造一个只带本条测试需要的字段的状态对象。 */
  function stateWith(fakeWin: any): SplitTabState {
    return {
      tabID: "t1",
      win: fakeWin,
      syncPaused: false,
      isCleaningUp: false,
      timeoutIds: [],
      leftAdapter: {
        getScrollFraction: () => 0.25,
        getHScrollFraction: () => null,
      },
      rightAdapter: {
        getScrollFraction: () => 0.75,
        getHScrollFraction: () => null,
      },
    } as unknown as SplitTabState;
  }

  it("立即置上 syncPaused", () => {
    const state = stateWith({ setTimeout: () => 1 });
    expect(state.syncPaused).toBe(false);
    pauseSyncForZoomSettle(state);
    expect(state.syncPaused).toBe(true);
  });

  it("按 ZOOM_SETTLE_MS 排一个定时器，并把 id 记进 timeoutIds 供统一回收", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const state = stateWith({
      setTimeout: (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms });
        return 42;
      },
    });
    pauseSyncForZoomSettle(state);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(ZOOM_SETTLE_MS);
    // id 必须记下来：splitViewCleanup 靠这个清单清定时器，漏记就会在分屏关掉
    // 之后还触发一次同步，那是很难复现的一类偶发。
    expect(state.timeoutIds).toEqual([42]);
  });

  it("定时器到点后解除暂停并重新 prime 基线", () => {
    let fire: (() => void) | null = null;
    const state = stateWith({
      setTimeout: (fn: () => void) => {
        fire = fn;
        return 1;
      },
    });
    pauseSyncForZoomSettle(state);
    expect(state.syncPaused).toBe(true);
    // prime 之前先把基线改成旧值，好验证 prime 真的重写了它们。
    (state as any).lastLeftFraction = 999;
    (state as any).lastRightFraction = 999;
    (state as any).lastLeftHFraction = 999;
    (state as any).lastRightHFraction = 999;
    fire!();
    expect(state.syncPaused).toBe(false);
    expect((state as any).lastLeftFraction).toBe(0.25);
    expect((state as any).lastRightFraction).toBe(0.75);
    expect((state as any).lastLeftHFraction).toBeNull();
    expect((state as any).lastRightHFraction).toBeNull();
  });

  it("正在清理时到点不做任何事（不解除暂停、不 prime）", () => {
    let fire: (() => void) | null = null;
    const state = stateWith({
      setTimeout: (fn: () => void) => {
        fire = fn;
        return 1;
      },
    });
    pauseSyncForZoomSettle(state);
    state.isCleaningUp = true;
    (state as any).lastLeftFraction = 999;
    fire!();
    // 分屏已经在拆，此时碰状态会碰到已释放的 pane。
    expect((state as any).lastLeftFraction).toBe(999);
  });

  it("没有适配器时 prime 出 null，不抛错", () => {
    let fire: (() => void) | null = null;
    const state = stateWith({
      setTimeout: (fn: () => void) => {
        fire = fn;
        return 1;
      },
    });
    state.leftAdapter = null;
    state.rightAdapter = null;
    pauseSyncForZoomSettle(state);
    expect(() => fire!()).not.toThrow();
    expect((state as any).lastLeftFraction).toBeNull();
    expect((state as any).lastRightFraction).toBeNull();
  });
});
