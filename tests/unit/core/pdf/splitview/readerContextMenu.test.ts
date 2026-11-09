/**
 * 阅读器右键菜单「Z-Transplit」子菜单的 append 载荷契约
 * （splitViewFactory#registerReaderContextMenu）。
 *
 * 视图右键菜单每次右键都由宿主重建，插件 handler 的 append 载荷就是用户
 * 看到的菜单本体：单个顶层项携带 groups 数组（宿主渲染为子菜单，组间自动
 * 分隔线），组内项携带 checked（宿主渲染为原生对勾）。本文件把这些契约
 * 钉死：只 append 一次、分组结构与顺序、取消项条件性、对勾来源（分屏状态
 * 读真实 stateMap，双语模式打桩 bilingualLauncher）。
 *
 * Zotero 10 硬校验契约一并钉死：任何项不得携带 icon/slider（顶层项命中
 * 即抛 "Icons and sliders are unsupported in native context menus"，整个
 * 右键菜单不渲染）；groups/checked 不在受检字段之列（omni.ja 取证）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = (id: string) => `ztransplit-${id}`;

const { getActiveBilingualModeForItemMock } = vi.hoisted(() => ({
  getActiveBilingualModeForItemMock: vi.fn<() => "interleave" | "transOnly" | null>(
    () => null,
  ),
}));

vi.mock("../../../../../src/core/pdf/sdt/bilingualLauncher", () => ({
  getActiveBilingualModeForItem: getActiveBilingualModeForItemMock,
  startBilingualSession: vi.fn(),
  stopBilingualSession: vi.fn(),
  getLastEngineError: () => null,
  onSessionChange: () => () => {},
}));

vi.mock("../../../../../src/core/pdf/translation/opendataloaderSplitAdapter", () => ({
  translateAndSplitWithOpenDataLoader: vi.fn(),
}));

import {
  createZoteroMock,
  resetReaderEventListeners,
} from "../../../../qa/harness/zotero-mock";
import {
  registerReaderContextMenu,
  unregisterReaderContextMenu,
} from "../../../../../src/core/pdf/splitview/splitViewFactory";
import { stateMap } from "../../../../../src/core/pdf/splitview/splitViewSync";

/**
 * 触发一次右键菜单构建，收集全部 append 载荷。
 *
 * reader 桩默认是 PDF 阅读器（Zotero 的 ReaderInstance.type）：本文件的契约
 * 用例全部面向 PDF；阅读器类型门控的用例显式传其他类型覆盖。
 */
function fireViewContextMenu(reader: any): any[] {
  const appended: any[] = [];
  z!.fireReaderEvent("createViewContextMenu", {
    reader: { type: "pdf", ...reader },
    append: (...items: any[]) => appended.push(...items),
  });
  return appended;
}

/** flushMicrotasks：setTimeout(0) 前会先排干全部微任务。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let z: ReturnType<typeof createZoteroMock> | null = null;

/** 造一个挂进 stateMap 的分屏标签状态（只带对勾判定需要的字段）。 */
function stubSplitState(tabID: string, leftID: number, rightID: number): any {
  return {
    tabID,
    leftAdapter: { item: { id: leftID } },
    rightAdapter: { item: { id: rightID } },
  };
}

describe("registerReaderContextMenu — append 载荷契约", () => {
  beforeEach(() => {
    resetReaderEventListeners();
    stateMap.clear();
    getActiveBilingualModeForItemMock.mockReset();
    getActiveBilingualModeForItemMock.mockReturnValue(null);
    z = createZoteroMock();
    z.install();
    registerReaderContextMenu();
  });

  afterEach(() => {
    unregisterReaderContextMenu();
    stateMap.clear();
    z?.uninstall();
    z = null;
    resetReaderEventListeners();
  });

  it("空闲时只 append 一个子菜单载荷，不带 icon/slider，分组结构与顺序固定", () => {
    const appended = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });

    // 统一契约：五个入口收拢为一次 append 的单个顶层项（子菜单）。
    expect(appended).toHaveLength(1);
    const root = appended[0];
    expect(root.label).toBe(KEY("splitview-menu-root"));

    // 空组过滤：无进行中翻译时第一组（取消）不出现。
    expect(root.groups).toHaveLength(2);
    const [splitGroup, bilingualGroup] = root.groups;
    expect(splitGroup.map((m: any) => m.label)).toEqual([
      KEY("splitview-menu-translate"),
      KEY("splitview-menu-compare"),
    ]);
    expect(bilingualGroup.map((m: any) => m.label)).toEqual([
      KEY("splitview-menu-interleave"),
      KEY("splitview-menu-trans-only"),
    ]);

    // Zotero 10 硬校验契约：顶层项与任何嵌套项都不得带 icon/slider。
    for (const item of appended) {
      expect(item.icon).toBeUndefined();
      expect(item.slider).toBeUndefined();
    }
    for (const group of root.groups) {
      for (const item of group) {
        expect(item.icon).toBeUndefined();
        expect(item.slider).toBeUndefined();
        expect(typeof item.onCommand).toBe("function");
      }
    }
  });

  it("分屏对勾：当前标签是分屏标签时两个分屏项都勾选，普通阅读标签不勾", () => {
    stateMap.set("tab-split", stubSplitState("tab-split", 11, 12));

    const inSplit = fireViewContextMenu({ itemID: 11, tabID: "tab-split" });
    const [splitGroupIn, bilingualGroupIn] = inSplit[0].groups;
    expect(splitGroupIn.map((m: any) => m.checked)).toEqual([true, true]);
    expect(bilingualGroupIn.map((m: any) => m.checked)).toEqual([false, false]);

    const outside = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(outside[0].groups[0].map((m: any) => m.checked)).toEqual([
      false,
      false,
    ]);
  });

  it("双语对勾：会话在当前条目且模式匹配的项才勾选，并把解析出的条目 id 传给查询", () => {
    getActiveBilingualModeForItemMock.mockReturnValue("interleave");
    const appended = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(getActiveBilingualModeForItemMock).toHaveBeenCalledWith(11);
    const bilingualGroup = appended[0].groups[1];
    expect(bilingualGroup.map((m: any) => m.checked)).toEqual([true, false]);

    getActiveBilingualModeForItemMock.mockReturnValue("transOnly");
    const appended2 = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(appended2[0].groups[1].map((m: any) => m.checked)).toEqual([
      false,
      true,
    ]);

    getActiveBilingualModeForItemMock.mockReturnValue(null);
    const appended3 = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(appended3[0].groups[1].map((m: any) => m.checked)).toEqual([
      false,
      false,
    ]);
  });

  it("取消组条件性：翻译进行中出现取消项且能中止翻译，结束后消失", async () => {
    const { translateAndSplitWithOpenDataLoader } = await import(
      "../../../../../src/core/pdf/translation/opendataloaderSplitAdapter"
    );
    const translateMock = translateAndSplitWithOpenDataLoader as ReturnType<
      typeof vi.fn
    >;
    let capturedOpts: any = null;
    let resolvePending: (result: unknown) => void = () => {};
    translateMock.mockImplementationOnce((opts: any) => {
      capturedOpts = opts;
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    });

    // 条目 11 是无父条目、无关系的普通附件 → 复用查找落空，走完整翻译流程。
    z!.items.set(11, {
      id: 11,
      parentItemID: null,
      getField: () => "Source",
      getRelations: () => ({}),
    });
    const idle = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    const translateEntry = idle[0].groups[0][0];
    expect(translateEntry.label).toBe(KEY("splitview-menu-translate"));

    void translateEntry.onCommand();
    await vi.waitFor(() => expect(capturedOpts).not.toBeNull());

    // 翻译挂起期间再次右键：第一组变成取消项。
    const busy = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(busy[0].groups).toHaveLength(3);
    expect(busy[0].groups[0].map((m: any) => m.label)).toEqual([
      KEY("splitview-menu-cancel"),
    ]);

    // 取消项触发协作取消。
    busy[0].groups[0][0].onCommand();
    expect(capturedOpts.signal.aborted).toBe(true);

    resolvePending({ splitTabID: null, translatedAttachmentId: 0 });
    await flush();
    await flush();

    // 流程结束：控制器清空，取消组随之消失。
    const settled = fireViewContextMenu({ itemID: 11, tabID: "tab-src" });
    expect(settled[0].groups).toHaveLength(2);
  });

  it("非 PDF 阅读器不追加子菜单（EPUB / 快照 / 未知类型）", () => {
    // 分屏与双语两条链路都绑定 PDF（pdf.js 窗格 + SDT 阅读模式），宿主却对
    // 每种阅读器都会派发 createViewContextMenu；类型门控让子菜单根本不出现，
    // 而不是出现后点击才报错（见 src/core/readerKind.ts）。
    expect(fireViewContextMenu({ itemID: 11, type: "epub", tabID: "tab-epub" })).toEqual([]);
    expect(
      fireViewContextMenu({ itemID: 12, type: "snapshot", tabID: "tab-snap" }),
    ).toEqual([]);
    // 类型取不到（reader 无 type、条目查不到）→ fail closed，同样不追加。
    // 绕过助手：它会给 reader 桩默认合入 type: "pdf"。
    const appended: any[] = [];
    z!.fireReaderEvent("createViewContextMenu", {
      reader: { itemID: 13, tabID: "tab-x" },
      append: (...items: any[]) => appended.push(...items),
    });
    expect(appended).toEqual([]);
  });
});
