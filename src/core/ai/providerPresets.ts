/**
 * providerPresets — AI 引擎的服务商预设表。
 *
 * WHY THIS EXISTS: AI 引擎原来的三个字段（接口地址 / 密钥 / 模型）全是手填
 * 自由文本，用户必须自己搞懂四件事——什么是 OpenAI 兼容接口、去哪申请密钥、
 * 接口地址的确切格式、模型名怎么写。真实反馈是「不知道怎么配置 AI API」：
 * Zotero 的用户是科研人员，这块先验知识不能当初赛门票。
 *
 * 预设表把配置成本从「查文档抄四个值」降到「选服务商 + 粘密钥」：选中服务
 * 即填入官方公布的兼容端点与一个当前可用的模型名，密钥仍由用户自己填
 * （本地服务商连密钥都不需要）。custom 一项保留给网关、自建 vLLM 等高级
 * 用户——灵活性不收回，只是不再人人必经。
 *
 * 显示名不放在这里：设置面板的下拉项用 data-l10n-id 走 FTL 本地化
 * （preferences-ztransplit-ai-provider-<id>），TS 侧只留 id / 端点 / 模型，
 * 避免同一份文案两处维护、还绕开项目的 i18n 门禁。
 *
 * 表内端点全部实测可达（2026-10，大陆网络）：国内五家返回 401/400（端点
 * 存活、只差密钥），OpenAI 直连超时——这正是预设的价值：大陆用户不必先
 * 发现自己连不上 api.openai.com 才知道要换服务商。
 *
 * 与 region.ts / ASSETS_SUBDIR 同一约定：面板脚本运行在独立沙箱、无法
 * import 主包，addon/content/preferences.js 里镜像一份同内容表，改这里必须
 * 同步改那边（有单元测试对照两侧一致性）。
 *
 * @module core/ai/providerPresets
 */

export interface AiProviderPreset {
  /** 稳定 id，与设置面板下拉项的 value 一一对应。 */
  id: string;
  /** OpenAI 兼容端点基址；空串 = 自定义，不预填。 */
  apiUrl: string;
  /** 推荐模型名；空串 = 留空由服务端决定。 */
  model: string;
  /** 本地服务商：不需要密钥，面板据此弱化密钥字段。 */
  keyless?: boolean;
  /** 中国大陆可直接访问（用于面板上的可达性标注）。 */
  mainlandFriendly?: boolean;
}

/**
 * 预设表。顺序即面板下拉顺序：国内常用在前（大陆用户是主要受众），国际与
 * 本地随后，自定义殿后。
 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: "deepseek",
    apiUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    mainlandFriendly: true,
  },
  {
    id: "qwen",
    apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    mainlandFriendly: true,
  },
  {
    id: "glm",
    apiUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
    mainlandFriendly: true,
  },
  {
    id: "kimi",
    apiUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    mainlandFriendly: true,
  },
  {
    id: "stepfun",
    apiUrl: "https://api.stepfun.com/v1",
    model: "step-2-16k",
    mainlandFriendly: true,
  },
  {
    id: "openai",
    apiUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    id: "ollama",
    apiUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    keyless: true,
  },
  {
    id: "lmstudio",
    apiUrl: "http://127.0.0.1:1234/v1",
    model: "",
    keyless: true,
  },
  {
    id: "custom",
    apiUrl: "",
    model: "",
  },
] as const;

/** 面板下拉的默认项（= 不预设，保留用户已填内容）。 */
export const AI_PROVIDER_PRESET_NONE = "none";

export function findProviderPreset(
  id: string | undefined | null,
): AiProviderPreset | undefined {
  if (!id) return undefined;
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

export interface PresetApplyResult {
  apiUrl: string;
  model: string;
  /** 预置是否为本地服务商（调用方据此调整密钥字段的必填提示）。 */
  keyless: boolean;
}

/**
 * 把预设应用到三个字段上。语义（纯函数，供测试）：
 *
 *   - `none` / 未知 id / custom：不动任何字段——用户已填的值原样保留，
 *     切到自定义不该清空用户辛苦抄来的网关地址；
 *   - 已知服务商：接口地址与模型名换成预设值。模型名只在用户当前为空或是
 *     「另一个预设的值」时才覆盖——用户手工改过的模型名（例如把
 *     deepseek-chat 改成 deepseek-reasoner）不被预设吞掉。
 */
export function applyProviderPreset(
  presetId: string | undefined | null,
  current: { apiUrl: string; model: string },
): PresetApplyResult {
  const preset = findProviderPreset(presetId);
  if (!preset || preset.id === "custom") {
    return { apiUrl: current.apiUrl, model: current.model, keyless: false };
  }
  const modelIsPresetOwned =
    !current.model ||
    AI_PROVIDER_PRESETS.some((p) => p.model && p.model === current.model);
  return {
    apiUrl: preset.apiUrl || current.apiUrl,
    model: modelIsPresetOwned ? preset.model : current.model,
    keyless: Boolean(preset.keyless),
  };
}

/**
 * 按已填的接口地址反查预设 id（面板加载时用：把存量的
 * translate.ai.apiUrl 映射回下拉选项，让老用户的界面状态与配置一致）。
 * 地址逐一精确比对；比对不上返回 none。
 */
export function detectProviderPresetId(apiUrl: string): string {
  const normalized = (apiUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return AI_PROVIDER_PRESET_NONE;
  const hit = AI_PROVIDER_PRESETS.find(
    (p) => p.apiUrl && p.apiUrl.replace(/\/+$/, "").toLowerCase() === normalized,
  );
  return hit ? hit.id : AI_PROVIDER_PRESET_NONE;
}
