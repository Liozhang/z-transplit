/**
 * prefMigrations 的单元测试：版本闸门、单步失败可重试、v1→v2 的区域推定。
 *
 * prefs 模块整体替换为假件——迁移只该依赖「读写一个字符串偏好」。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store: Record<string, string> = {};
const setCalls: Array<[string, unknown]> = [];

/** 置 true 时下一次写入抛错，用来模拟宿主偏好不可写。 */
let failNextWrite = false;

const get = (key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined;
const set = (key: string, value: unknown): boolean => {
  if (failNextWrite) throw new Error("prefs unavailable");
  store[key] = String(value);
  setCalls.push([key, value]);
  return true;
};

// region.ts 的 defaultIO 走 getPref/setPref，迁移自身走 *Dynamic 两个入口，
// 四个都要给。
vi.mock("../../../src/utils/prefs", () => ({
  getPref: (key: string) => get(key),
  getPrefDynamic: (key: string) => get(key),
  setPref: (key: string, value: unknown) => set(key, value),
  setPrefDynamic: (key: string, value: unknown) => set(key, value),
  clearPrefDynamic: () => true,
}));

vi.mock("../../../src/utils/logger", () => ({
  safeDebug: vi.fn(),
}));

import {
  CURRENT_PREF_VERSION,
  migratePrefs,
} from "../../../src/utils/prefMigrations";

/** Zotero 界面语言（迁移读它推定初始区域）。 */
function stubLocale(locale: string | undefined): void {
  (globalThis as any).Zotero = locale === undefined ? undefined : { locale };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  setCalls.length = 0;
  failNextWrite = false;
  stubLocale(undefined);
});

describe("migratePrefs — 版本闸门", () => {
  it("全新安装：跑完所有步骤并把版本提到当前值", () => {
    stubLocale("zh-CN");
    migratePrefs();
    expect(store.prefSchemaVersion).toBe(String(CURRENT_PREF_VERSION));
  });

  it("已是最新版本时是空操作", () => {
    store.prefSchemaVersion = String(CURRENT_PREF_VERSION);
    stubLocale("zh-CN");
    migratePrefs();
    // 除版本戳外没有别的写入
    expect(setCalls).toEqual([]);
  });

  it("单步失败：版本不推进，下次启动从同一步重试", () => {
    store.prefSchemaVersion = "1";
    store["translate.engineType"] = "google";
    store["translate.bing.region"] = "";
    stubLocale("zh-CN");
    failNextWrite = true;
    migratePrefs();
    // 失败步骤不会被标记为已应用：版本停在 1，下次启动重试同一步
    expect(store.prefSchemaVersion).toBe("1");
    failNextWrite = false;
    migratePrefs();
    expect(store.prefSchemaVersion).toBe("2");
    expect(store.region).toBe("cn");
  });
});

describe("migratePrefs v1→v2 — 按界面语言推定初始区域", () => {
  it("简体中文界面：区域写中国大陆，引擎改写为 bing-web", () => {
    store.prefSchemaVersion = "1";
    store["translate.engineType"] = "google";
    store["translate.bing.region"] = "";
    stubLocale("zh-CN");
    migratePrefs();
    expect(store.region).toBe("cn");
    expect(store["translate.engineType"]).toBe("bing-web");
    expect(store["translate.bing.region"]).toBe("chinanorth");
    expect(store.prefSchemaVersion).toBe("2");
  });

  it("英文界面：区域写全球，引擎保持 Google", () => {
    store.prefSchemaVersion = "1";
    store["translate.engineType"] = "google";
    store["translate.bing.region"] = "";
    stubLocale("en-US");
    migratePrefs();
    expect(store.region).toBe("global");
    expect(store["translate.engineType"]).toBe("google");
    expect(store["translate.bing.region"]).toBe("global");
  });

  it("用户已声明过区域：不推定，只推进版本", () => {
    store.prefSchemaVersion = "1";
    store.region = "global";
    store["translate.engineType"] = "google";
    store["translate.bing.region"] = "";
    stubLocale("zh-CN");
    migratePrefs();
    expect(store.region).toBe("global");
    expect(store["translate.engineType"]).toBe("google");
    expect(store["translate.bing.region"]).toBe("");
  });

  it("宿主没有界面语言（vitest）：不推定", () => {
    store.prefSchemaVersion = "1";
    store["translate.engineType"] = "google";
    store["translate.bing.region"] = "";
    stubLocale(undefined);
    migratePrefs();
    expect(store.region).toBeUndefined();
    expect(store["translate.engineType"]).toBe("google");
    expect(store.prefSchemaVersion).toBe("2");
  });
});
