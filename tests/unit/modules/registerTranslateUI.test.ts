/**
 * B16b — 阅读器翻译面板的注册门控（src/modules/registerTranslateUI.ts）。
 *
 * pane 的出现条件（leadero 同款能力驱动）：translate.enabled 开 且 翻译引擎
 * 就绪，才向 Zotero.ItemPaneManager.registerSection 注册；任一条件不满足都
 * 不注册并留下可诊断日志（而非静默缺失）。同时验证幂等、反注册、以及
 * onItemChange 只在 reader 标签启用。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerTranslateUI,
  unregisterTranslateUI,
  TRANSLATE_PANE_ID,
} from "../../../src/modules/registerTranslateUI";
import { createZoteroMock } from "../../qa/harness/zotero-mock";

const PREFIX = "extensions.zotero.ztransplit"; // load() 自己加分隔点，别带尾点
const READY_PREFS = {
  "translate.enabled": true,
  "translate.engineType": "google", // keyless 端点恒就绪
};

describe("B16b registerTranslateUI：注册门控", () => {
  let z: ReturnType<typeof createZoteroMock>;

  beforeEach(() => {
    z = createZoteroMock();
    z.install();
  });

  afterEach(() => {
    void unregisterTranslateUI();
    z.uninstall();
  });

  it("enabled + 引擎就绪 → 注册成功且记录 pane 配置", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    expect(await registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(1);
    const pane = z.registeredPanes[0];
    expect(pane.paneID).toBe(TRANSLATE_PANE_ID);
    expect(pane.header?.icon).toBe("chrome://ztransplit/content/icons/translate.svg");
    expect(pane.sidenav?.icon).toBe("chrome://ztransplit/content/icons/translate-20.svg");
    expect(typeof pane.onItemChange).toBe("function");
    expect(typeof pane.onRender).toBe("function");
    expect(typeof pane.onDestroy).toBe("function");
  });

  it("translate.enabled=false → 不注册（不出现会首用即失败的面板）", async () => {
    z.prefs.load({ ...READY_PREFS, "translate.enabled": false }, PREFIX);
    expect(await registerTranslateUI()).toBe(false);
    expect(z.registeredPanes).toHaveLength(0);
  });

  it("引擎未就绪（custom 缺 apiUrl）→ 不注册", async () => {
    z.prefs.load(
      {
        "translate.enabled": true,
        "translate.engineType": "custom",
        "translate.custom.apiKey": "k",
      },
      PREFIX,
    );
    expect(await registerTranslateUI()).toBe(false);
    expect(z.registeredPanes).toHaveLength(0);
  });

  it("重复注册是幂等的（不双注册）", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    expect(await registerTranslateUI()).toBe(true);
    expect(await registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(1);
  });

  it("反注册后可重新注册", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    await registerTranslateUI();
    expect(await unregisterTranslateUI()).toBe(true);
    expect(await registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(2);
  });

  it("onItemChange 仅在 reader 标签启用面板", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    await registerTranslateUI();
    const { onItemChange } = z.registeredPanes[0];

    let enabled: boolean | undefined;
    onItemChange?.({
      tabType: "reader",
      item: { attachmentReaderType: "pdf" },
      setEnabled: (v: boolean) => (enabled = v),
    });
    expect(enabled).toBe(true);

    onItemChange?.({
      tabType: "library",
      item: { attachmentReaderType: "pdf" },
      setEnabled: (v: boolean) => (enabled = v),
    });
    expect(enabled).toBe(false);
  });

  it("onItemChange 按阅读器类型门控：快照启用、EPUB 与未知不启用", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    await registerTranslateUI();
    const { onItemChange } = z.registeredPanes[0];

    const enableFor = (item: any) => {
      let enabled: boolean | undefined;
      onItemChange?.({
        tabType: "reader",
        item,
        setEnabled: (v: boolean) => (enabled = v),
      });
      return enabled;
    };

    // HTML 快照：选区翻译可用（选区弹窗事件带文本），区块启用。
    expect(enableFor({ attachmentReaderType: "snapshot" })).toBe(true);
    // EPUB：插件不提供任何读者界面，区块不出现。
    expect(enableFor({ attachmentReaderType: "epub" })).toBe(false);
    // 无阅读器的附件与笔记条目：不出现。
    expect(enableFor({ attachmentContentType: "image/png" })).toBe(false);
    expect(enableFor(undefined)).toBe(false);
    // 判定失效时 fail closed：reader 标签但类型取不到，仍然不启用。
    expect(enableFor({ id: 9 })).toBe(false);
  });

  it("onItemChange 以当前标签页的阅读器实例为准，不信 item（真机回归）", async () => {
    // 真机教训：Zotero 阅读器标签页的条目面板渲染的是附件的「父条目」
    // （上游 elements/contextPane.js#_addItemContext 在 parentID 存在时传父
    // 条目），所以 onItemChange 收到的 item 是一条没有阅读器类型的普通条目。
    // 若按 item 判类型，PDF 也会被误判为「无」而永远隐藏。门控必须先解析当前
    // 标签页的阅读器实例（resolveCurrentReader），item 只在解析不到时兜底。
    z.prefs.load(READY_PREFS, PREFIX);
    await registerTranslateUI();
    const { onItemChange } = z.registeredPanes[0];

    // 让 mock 的 Reader.getByTabID 能按 selectedID 找到 reader 桩；doc 的
    // defaultView 提供 resolveCurrentReader 需要的 Zotero / Zotero_Tabs。
    const docFor = (selectedID: number) =>
      ({
        defaultView: {
          Zotero: z.Zotero,
          Zotero_Tabs: { selectedID },
        },
      }) as any;

    const enableForReader = (readerType: string) => {
      z.reader = {
        tabID: 7,
        itemID: 2,
        selectionRanges: [],
        type: readerType as any,
      };
      let enabled: boolean | undefined;
      onItemChange?.({
        tabType: "reader",
        doc: docFor(7),
        // 父条目：没有任何附件字段——按它判类型会得到 "none"。
        item: { id: 1, isRegularItem: () => true },
        setEnabled: (v: boolean) => (enabled = v),
      });
      return enabled;
    };

    expect(enableForReader("pdf")).toBe(true);
    expect(enableForReader("snapshot")).toBe(true);
    expect(enableForReader("epub")).toBe(false);

    // 阅读器解析不到（doc 缺失）时退回 item：父条目 → 不启用。
    let enabled: boolean | undefined;
    onItemChange?.({
      tabType: "reader",
      item: { id: 1, isRegularItem: () => true },
      setEnabled: (v: boolean) => (enabled = v),
    });
    expect(enabled).toBe(false);
  });

  it("宿主缺 ItemPaneManager → 不崩，返回 false", async () => {
    z.prefs.load(READY_PREFS, PREFIX);
    // z.Zotero 是 getter（每次访问重建），不能整体替换——直接换 globalThis 上的引用。
    (globalThis as any).Zotero = { ...z.Zotero, ItemPaneManager: undefined };
    expect(await registerTranslateUI()).toBe(false);
  });
});
