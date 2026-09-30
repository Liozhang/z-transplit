/**
 * region 机制的单元测试（网络区域选择，utils/region.ts）。
 * 偏好读写全部注入，不依赖 Zotero。
 */
import { describe, it, expect } from "vitest";
import {
  applyRegionRecommendations,
  getRegionProfile,
  normalizeRegion,
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
