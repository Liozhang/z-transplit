/**
 * region — 网络区域选择（自 z-search 的 src/utils/region.ts 移植，按本仓库
 * 的翻译场景裁剪）。
 *
 * 背景：本仓库的出厂默认按国际互联网配置（Google 免费端点优先），而中国大陆
 * 网络下 Google 不可达，免密钥可达的只有 Bing 网页端；Azure 翻译的订阅区域
 * 参数也因区域而异。历史上这些差异全靠「Google 失败 → Bing 网页兜底」这条
 * 隐式链路吸收，用户只能自己逐项试出可用引擎。本模块把网络环境提成用户的
 * 一个显式选项：
 *
 *   1. `region` 偏好（auto | global | cn）声明用户的网络环境；
 *   2. 每个声明区域带一份推荐值（翻译引擎、Azure 订阅区域），仅在目标键
 *      **仍是出厂默认值**时套用——用户显式选过的引擎永不被区域选择推翻；
 *
 * `auto` 是缺省：不声明就完全沿用现有行为（国际默认端点 + 兜底链），不猜
 * 用户在哪——按 IP 或时区推断在学术工具里不可接受（隐私代价与误判代价都
 * 由用户承担）。
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

/** 用户的网络环境。`auto` = 未声明（沿用出厂默认，不做任何推断）。 */
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
 * 守门：只有当前值仍等于出厂默认的键才会被改写——用户显式选过的引擎不被
 * 区域选择推翻（区域只是「默认值」，不是「强制值」）。`force` 供设置面板的
 * 「重新应用」按钮使用：那一次点击本身就是显式授权。
 *
 * @returns 实际写入的键（设置面板据此回显改了什么）。
 */
export function applyRegionRecommendations(
  region: NetworkRegion,
  options: { force?: boolean; io?: RegionPrefIO } = {},
): RegionRecommendedKey[] {
  const io = options.io ?? defaultIO;
  const profile = getRegionProfile(region);
  if (!profile) return [];
  const written: RegionRecommendedKey[] = [];
  for (const key of REGION_RECOMMENDED_KEYS) {
    const current = io.getPref(key);
    if (!options.force && current !== SHIPPED_DEFAULTS[key]) continue;
    const next = regionRecommendation(key, region);
    if (current === next) continue;
    io.setPref(key, next);
    written.push(key);
  }
  return written;
}
