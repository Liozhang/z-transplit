/**
 * region — 网络区域选择（自 z-search 的 src/utils/region.ts 移植，按本仓库
 * 的翻译场景裁剪）。
 *
 * 背景：本仓库的出厂默认按国际互联网配置（Google 免费端点优先），而中国大陆
 * 网络下 Google 不可达，免密钥可达的只有 Bing 网页端；Azure 翻译的订阅区域
 * 参数也因区域而异。引擎选错时翻译失败并显示该引擎自己的错误，用户只能自己
 * 逐项试出可用引擎，因此网络环境值得提成一个设置：
 *
 *   1. `region` 偏好（auto | global | cn）声明用户的网络环境；
 *   2. 每个声明区域带一份推荐值（翻译引擎、Azure 订阅区域），仅在目标键
 *      **仍是出厂默认值**、或**仍是上一个区域的推荐值**时套用——用户显式
 *      选过的引擎永不被区域选择推翻；
 *
 * 首次启动时若用户从未声明过区域（`region` 仍是 auto），按 Zotero 的界面语言
 * 推定一个初始区域（见 {@link regionFromLocale}）：只用用户自己选过的界面语言，
 * 不探 IP、不看时区。推定结果写进 `region` 偏好，在设置面板里可见可改——推断
 * 对用户透明，不是藏在背后的行为。用户此后手动选过区域，推定永不再次发生。
 *
 * 推荐值的实际写入发生在设置面板（addon/content/preferences.js，面板脚本
 * 无法 import 本模块，那里保留一份必须与本文件保持一字不差的推荐值表）；
 * 本模块是该机制的唯一权威定义与单元测试对象。
 *
 * @module utils/region
 */

import { getPref, setPref } from "./prefs";

export const REGION_PREF_KEY = "region";

export const NETWORK_REGIONS = ["auto", "global", "cn"] as const;

/**
 * 用户的网络环境。`auto` = 未声明：首次启动按界面语言推定后即被写成具体区域
 * （见 {@link initializeRegionFromLocale}），此后仍是 auto 说明用户显式选了
 * 「自动（不声明）」。
 */
export type NetworkRegion = (typeof NETWORK_REGIONS)[number];

/** 声明区域后给出的推荐取值（只做默认值，用户随时可改）。 */
export interface TranslationRegionProfile {
  /** 翻译引擎（translationEngines 的 engineType）。 */
  translateEngine: string;
  /** Azure Translator 订阅区域（仅 engineType = "bing" 时使用）。 */
  bingRegion: string;
}

export const REGION_PROFILES: Record<
  Exclude<NetworkRegion, "auto">,
  TranslationRegionProfile
> = {
  // 国际互联网：Google 免费端点可达，保持出厂默认。
  global: {
    translateEngine: "google",
    bingRegion: "global",
  },
  // 中国大陆：Google 端点不可达——引擎落免密钥可达的 Bing 网页端，免去
  // 每段翻译先付出 Google 端点超时的代价；Azure 订阅区取国内区域，配了
  // Azure 密钥的用户无需再手改。
  cn: {
    translateEngine: "bing-web",
    bingRegion: "chinanorth",
  },
};

/**
 * 出厂默认值（addon/prefs.js 的镜像）。推荐值只覆盖仍等于这些值的键。
 */
export const SHIPPED_DEFAULTS: Record<string, string> = {
  "translate.engineType": "google",
  "translate.bing.region": "",
};

/** 推荐值写入的目标键。 */
export const REGION_RECOMMENDED_KEYS = [
  "translate.engineType",
  "translate.bing.region",
] as const;

export type RegionRecommendedKey = (typeof REGION_RECOMMENDED_KEYS)[number];

/** 归一化：非法值（含空串与旧版残留）一律回落 auto，绝不让坏值改变行为。 */
export function normalizeRegion(value: unknown): NetworkRegion {
  const v = typeof value === "string" ? value.trim() : "";
  return (NETWORK_REGIONS as readonly string[]).includes(v)
    ? (v as NetworkRegion)
    : "auto";
}

/**
 * 由 Zotero 界面语言推定初始区域。
 *
 * 只用用户自己在 Zotero 里选过的界面语言，不探 IP、不看时区：简体中文界面的
 * 用户几乎都在大陆网络（Google 端点不可达，推荐免密钥可达的 Bing 网页端），
 * 其余界面语言推荐 Google。繁体中文（zh-TW / zh-HK）归 global——那些地区
 * Google 可达，没有理由换引擎。
 *
 * 误判代价由可改性兜住：推定结果写进 region 偏好，设置面板里看得见，一次
 * 点击就能改。
 */
export function regionFromLocale(
  locale: string | undefined,
): Exclude<NetworkRegion, "auto"> {
  const v = String(locale ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  return v === "zh-cn" ? "cn" : "global";
}

/** 读当前区域选择。 */
export function getNetworkRegion(): NetworkRegion {
  return normalizeRegion(getPref(REGION_PREF_KEY));
}

/** 写区域选择。 */
export function setNetworkRegion(region: NetworkRegion): void {
  setPref(REGION_PREF_KEY, normalizeRegion(region));
}

/** 声明区域的推荐值；未声明（auto）返回 null。 */
export function getRegionProfile(
  region: NetworkRegion = getNetworkRegion(),
): TranslationRegionProfile | null {
  return region === "auto" ? null : REGION_PROFILES[region];
}

/** 当前网络是否声明为中国大陆。 */
export function isChinaRegion(region: NetworkRegion = getNetworkRegion()): boolean {
  return region === "cn";
}

/** 取区域推荐值在某个键上的取值（auto 回落出厂默认）。 */
export function regionRecommendation(
  key: RegionRecommendedKey,
  region: NetworkRegion = getNetworkRegion(),
): string {
  const profile = getRegionProfile(region);
  if (!profile) return SHIPPED_DEFAULTS[key];
  if (key === "translate.engineType") return profile.translateEngine;
  return profile.bingRegion;
}

/** 偏好读写注入点（单元测试用；缺省落到真实的 Zotero 偏好）。 */
export interface RegionPrefIO {
  getPref(key: string): string;
  setPref(key: string, value: string): void;
}

const defaultIO: RegionPrefIO = {
  getPref: (key) => {
    const v = getPref(key);
    return v === undefined || v === null ? "" : String(v);
  },
  setPref: (key, value) => {
    setPref(key, value);
  },
};

/**
 * 套用区域推荐值。
 *
 * 守门分两级，`from` 是切换前的区域：
 *
 *   1. 当前值仍等于出厂默认 —— 用户没碰过这个键，区域推荐值可以写入；
 *   2. 当前值等于 `from` 区域的推荐值 —— 这个值是插件上一次替用户写的，
 *      这次换区域理应跟着换（否则「选全球却拿不到 Google」，正是区域选择想
 *      解决的事）。
 *
 * 用户自选的值两级都不匹配，永不被推翻（区域只是「默认值」，不是「强制值」）。
 * `force` 供设置面板的「重新应用」按钮使用：那一次点击本身就是显式授权。
 *
 * @returns 实际写入的键（设置面板据此回显改了什么）。
 */
export function applyRegionRecommendations(
  region: NetworkRegion,
  options: { force?: boolean; from?: NetworkRegion; io?: RegionPrefIO } = {},
): RegionRecommendedKey[] {
  const io = options.io ?? defaultIO;
  const profile = getRegionProfile(region);
  if (!profile) return [];
  const previous = getRegionProfile(options.from ?? "auto");
  const written: RegionRecommendedKey[] = [];
  for (const key of REGION_RECOMMENDED_KEYS) {
    const current = io.getPref(key);
    const ours = previous ? regionRecommendation(key, options.from) : null;
    const mayWrite =
      options.force ||
      current === SHIPPED_DEFAULTS[key] ||
      (ours !== null && current === ours);
    if (!mayWrite) continue;
    const next = regionRecommendation(key, region);
    if (current === next) continue;
    io.setPref(key, next);
    written.push(key);
  }
  return written;
}

/**
 * 首次启动的区域推定：用户从未声明过区域（`region` 仍是 auto）时，按 Zotero
 * 的界面语言定一个初始区域并写入，再按该区域的推荐值改写仍处于出厂默认的
 * 引擎与 Azure 订阅区域。
 *
 * 三条守门：宿主拿不到界面语言（vitest、无 Zotero 全局）不推定；用户声明过
 * 区域不推定；用户自选的引擎不被推荐值推翻（交给 applyRegionRecommendations
 * 的守门）。推定是一次的——用户此后手动选过区域，`region` 不再是 auto，本函数
 * 从此不再动手。
 *
 * @returns 写入的区域；未推定返回 null。
 */
export function initializeRegionFromLocale(
  locale: string | undefined,
  io: RegionPrefIO = defaultIO,
): NetworkRegion | null {
  if (!String(locale ?? "").trim()) return null;
  if (normalizeRegion(io.getPref(REGION_PREF_KEY)) !== "auto") return null;
  const region = regionFromLocale(locale);
  io.setPref(REGION_PREF_KEY, region);
  applyRegionRecommendations(region, { io });
  return region;
}
