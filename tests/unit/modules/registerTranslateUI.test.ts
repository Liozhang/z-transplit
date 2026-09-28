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
    unregisterTranslateUI();
    z.uninstall();
  });

  it("enabled + 引擎就绪 → 注册成功且记录 pane 配置", () => {
    z.prefs.load(READY_PREFS, PREFIX);
    expect(registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(1);
    const pane = z.registeredPanes[0];
    expect(pane.paneID).toBe(TRANSLATE_PANE_ID);
    expect(pane.header?.icon).toBe("chrome://ztransplit/content/icons/translate.svg");
    expect(pane.sidenav?.icon).toBe("chrome://ztransplit/content/icons/translate-20.svg");
    expect(typeof pane.onItemChange).toBe("function");
    expect(typeof pane.onRender).toBe("function");
    expect(typeof pane.onDestroy).toBe("function");
  });

  it("translate.enabled=false → 不注册（不出现会首用即失败的面板）", () => {
    z.prefs.load({ ...READY_PREFS, "translate.enabled": false }, PREFIX);
    expect(registerTranslateUI()).toBe(false);
    expect(z.registeredPanes).toHaveLength(0);
  });

  it("引擎未就绪（custom 缺 apiUrl）→ 不注册", () => {
    z.prefs.load(
      {
        "translate.enabled": true,
        "translate.engineType": "custom",
        "translate.custom.apiKey": "k",
      },
      PREFIX,
    );
    expect(registerTranslateUI()).toBe(false);
    expect(z.registeredPanes).toHaveLength(0);
  });

  it("重复注册是幂等的（不双注册）", () => {
    z.prefs.load(READY_PREFS, PREFIX);
    expect(registerTranslateUI()).toBe(true);
    expect(registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(1);
  });

  it("反注册后可重新注册", () => {
    z.prefs.load(READY_PREFS, PREFIX);
    registerTranslateUI();
    expect(unregisterTranslateUI()).toBe(true);
    expect(registerTranslateUI()).toBe(true);
    expect(z.registeredPanes).toHaveLength(2);
  });

  it("onItemChange 仅在 reader 标签启用面板", () => {
    z.prefs.load(READY_PREFS, PREFIX);
    registerTranslateUI();
    const { onItemChange } = z.registeredPanes[0];

    let enabled: boolean | undefined;
    onItemChange?.({ tabType: "reader", setEnabled: (v: boolean) => (enabled = v) });
    expect(enabled).toBe(true);

    onItemChange?.({ tabType: "library", setEnabled: (v: boolean) => (enabled = v) });
    expect(enabled).toBe(false);
  });

  it("宿主缺 ItemPaneManager → 不崩，返回 false", () => {
    z.prefs.load(READY_PREFS, PREFIX);
    // z.Zotero 是 getter（每次访问重建），不能整体替换——直接换 globalThis 上的引用。
    (globalThis as any).Zotero = { ...z.Zotero, ItemPaneManager: undefined };
    expect(registerTranslateUI()).toBe(false);
  });
});
