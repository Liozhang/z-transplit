/**
 * region 机制的单元测试（网络区域选择，utils/region.ts）。
 * 偏好读写全部注入，不依赖 Zotero。
 */
import { describe, it, expect } from "vitest";
import {
  applyRegionRecommendations,
  getRegionProfile,
  initializeRegionFromLocale,
  normalizeRegion,
  regionFromLocale,
  regionRecommendation,
  SHIPPED_DEFAULTS,
  type RegionPrefIO,
} from "../../../src/utils/region";

/** 可预设初值的假偏好仓。 */
function fakeIO(initial: Record<string, string> = {}): RegionPrefIO & {
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    getPref: (key) => store[key] ?? "",
    setPref: (key, value) => {
      store[key] = value;
    },
  };
}

describe("normalizeRegion", () => {
  it("接受合法三态", () => {
    expect(normalizeRegion("auto")).toBe("auto");
    expect(normalizeRegion("global")).toBe("global");
    expect(normalizeRegion("cn")).toBe("cn");
    expect(normalizeRegion(" cn ")).toBe("cn");
  });

  it("非法值一律回落 auto", () => {
    expect(normalizeRegion("")).toBe("auto");
    expect(normalizeRegion("CN")).toBe("auto");
    expect(normalizeRegion("mainland")).toBe("auto");
    expect(normalizeRegion(null)).toBe("auto");
    expect(normalizeRegion(42)).toBe("auto");
  });
});

describe("getRegionProfile / regionRecommendation", () => {
  it("auto 没有推荐值", () => {
    expect(getRegionProfile("auto")).toBeNull();
  });

  it("global 推荐 Google 引擎与全球 Azure 区域", () => {
    expect(getRegionProfile("global")).toEqual({
      translateEngine: "google",
      bingRegion: "global",
    });
  });

  it("cn 推荐免密钥可达的 Bing 网页引擎与国内 Azure 区域", () => {
    expect(getRegionProfile("cn")).toEqual({
      translateEngine: "bing-web",
      bingRegion: "chinanorth",
    });
  });

  it("auto 的逐键推荐回落出厂默认", () => {
    expect(regionRecommendation("translate.engineType", "auto")).toBe("google");
    expect(regionRecommendation("translate.bing.region", "auto")).toBe("");
  });
});

describe("applyRegionRecommendations", () => {
  it("auto 是空操作", () => {
    const io = fakeIO();
    expect(applyRegionRecommendations("auto", { io })).toEqual([]);
    expect(io.store).toEqual({});
  });

  it("cn 把出厂默认的引擎与 Azure 区域改写为推荐值", () => {
    // 全新安装：声明键未被用户改过，读取时回落出厂默认（模拟 Zotero 的
    // 默认分支行为）。
    const io = fakeIO({
      "translate.engineType": "google",
      "translate.bing.region": "",
    });
    const written = applyRegionRecommendations("cn", { io });
    expect(written).toEqual(["translate.engineType", "translate.bing.region"]);
    expect(io.store["translate.engineType"]).toBe("bing-web");
    expect(io.store["translate.bing.region"]).toBe("chinanorth");
  });

  it("用户显式选过的引擎不被推翻（只覆盖出厂默认）", () => {
    const io = fakeIO({ "translate.engineType": "deepl" });
    const written = applyRegionRecommendations("cn", { io });
    expect(written).toEqual(["translate.bing.region"]);
    expect(io.store["translate.engineType"]).toBe("deepl");
  });

  it("已符合推荐值的键不重复写入", () => {
    const io = fakeIO({
      "translate.engineType": "bing-web",
      "translate.bing.region": "chinanorth",
    });
    expect(applyRegionRecommendations("cn", { io })).toEqual([]);
    expect(applyRegionRecommendations("global", { io })).toEqual([]); // 非出厂默认，全部跳过
  });

  it("换区域时跟着换：上一次由区域推荐写进去的值被改写", () => {
    // 用户选了「中国大陆」→ 插件写入 bing-web；再选「全球」必须拿回 Google，
    // 否则「支持 Google 的区域用 Google」这条落空。
    const io = fakeIO({
      "translate.engineType": "bing-web",
      "translate.bing.region": "chinanorth",
    });
    const written = applyRegionRecommendations("global", { io, from: "cn" });
    expect(written).toEqual(["translate.engineType", "translate.bing.region"]);
    expect(io.store["translate.engineType"]).toBe("google");
    expect(io.store["translate.bing.region"]).toBe("global");
  });

  it("用户自选的引擎不被覆盖，Azure 区域照旧跟着换", () => {
    // 选了「中国大陆」后用户自己把引擎改成 deepl，再选「全球」：deepl 不是出厂
    // 默认、也不是 cn 的推荐值，两级守门都不放行；而 Azure 区域是插件按 cn 写
    // 的，换区域时跟着换成全球。
    const io = fakeIO({
      "translate.engineType": "deepl",
      "translate.bing.region": "chinanorth",
    });
    const written = applyRegionRecommendations("global", { io, from: "cn" });
    expect(written).toEqual(["translate.bing.region"]);
    expect(io.store["translate.engineType"]).toBe("deepl");
    expect(io.store["translate.bing.region"]).toBe("global");
  });

  it("from 为 auto（首次选择）时只有出厂默认可写", () => {
    const io = fakeIO({
      "translate.engineType": "bing-web",
      "translate.bing.region": "chinanorth",
    });
    expect(applyRegionRecommendations("global", { io, from: "auto" })).toEqual(
      [],
    );
  });

  it("force 显式授权时覆盖用户自选值", () => {
    const io = fakeIO({ "translate.engineType": "deepl" });
    const written = applyRegionRecommendations("cn", { io, force: true });
    expect(written).toEqual(["translate.engineType", "translate.bing.region"]);
    expect(io.store["translate.engineType"]).toBe("bing-web");
  });

  it("出厂默认表与 z-search 语义一致：引擎默认 google、Azure 区域默认空", () => {
    expect(SHIPPED_DEFAULTS["translate.engineType"]).toBe("google");
    expect(SHIPPED_DEFAULTS["translate.bing.region"]).toBe("");
  });
});

describe("regionFromLocale — 由界面语言推定初始区域", () => {
  it("简体中文界面推定中国大陆（Google 不可达，推荐 Bing 网页端）", () => {
    expect(regionFromLocale("zh-CN")).toBe("cn");
    expect(regionFromLocale("zh-cn")).toBe("cn");
    expect(regionFromLocale("zh_CN")).toBe("cn");
  });

  it("其余界面语言推定全球（Google 可达，保持出厂默认）", () => {
    expect(regionFromLocale("en-US")).toBe("global");
    expect(regionFromLocale("ja-JP")).toBe("global");
    expect(regionFromLocale("de")).toBe("global");
  });

  it("繁体中文归全球：那些地区 Google 可达，没有理由换引擎", () => {
    expect(regionFromLocale("zh-TW")).toBe("global");
    expect(regionFromLocale("zh-HK")).toBe("global");
    expect(regionFromLocale("zh-MO")).toBe("global");
  });

  it("空值与无法解析的值归全球（保守：不猜用户在大陆）", () => {
    expect(regionFromLocale("")).toBe("global");
    expect(regionFromLocale(undefined)).toBe("global");
    expect(regionFromLocale("zh")).toBe("global");
  });
});

describe("initializeRegionFromLocale — 首次启动的区域推定", () => {
  const FRESH = {
    "translate.engineType": "google",
    "translate.bing.region": "",
  };

  it("简体中文界面：写入中国大陆，并把引擎与 Azure 区域改成推荐值", () => {
    const io = fakeIO(FRESH);
    expect(initializeRegionFromLocale("zh-CN", io)).toBe("cn");
    expect(io.store.region).toBe("cn");
    expect(io.store["translate.engineType"]).toBe("bing-web");
    expect(io.store["translate.bing.region"]).toBe("chinanorth");
  });

  it("英文界面：写入全球，引擎保持 Google、Azure 区域写全球", () => {
    const io = fakeIO(FRESH);
    expect(initializeRegionFromLocale("en-US", io)).toBe("global");
    expect(io.store.region).toBe("global");
    expect(io.store["translate.engineType"]).toBe("google");
    expect(io.store["translate.bing.region"]).toBe("global");
  });

  it("用户声明过区域就不再推定（auto 是显式选择，一样尊重）", () => {
    const io = fakeIO({ region: "global", ...FRESH });
    expect(initializeRegionFromLocale("zh-CN", io)).toBeNull();
    expect(io.store.region).toBe("global");
    expect(io.store["translate.engineType"]).toBe("google");
  });

  it("宿主拿不到界面语言不推定（vitest / 无 Zotero 全局）", () => {
    const io = fakeIO(FRESH);
    expect(initializeRegionFromLocale(undefined, io)).toBeNull();
    expect(initializeRegionFromLocale("  ", io)).toBeNull();
    expect(io.store.region).toBeUndefined();
  });

  it("用户自选的引擎不被推荐值推翻", () => {
    const io = fakeIO({
      region: "auto",
      "translate.engineType": "deepl",
      "translate.bing.region": "",
    });
    expect(initializeRegionFromLocale("zh-CN", io)).toBe("cn");
    expect(io.store["translate.engineType"]).toBe("deepl");
    // Azure 订阅区域仍是出厂默认，照写
    expect(io.store["translate.bing.region"]).toBe("chinanorth");
  });

  it("推定是一次性的：再调一次不改变任何东西", () => {
    const io = fakeIO(FRESH);
    initializeRegionFromLocale("zh-CN", io);
    const after = { ...io.store };
    expect(initializeRegionFromLocale("zh-CN", io)).toBeNull();
    expect(io.store).toEqual(after);
  });
});
