/**
 * modelCatalog — 按模型名查表的「供应商内省」。
 *
 * leadero 通过 provider.getContextWindow() / getMaxOutputTokens() 动态读取
 * 上下文窗口与输出上限；本仓库的 OpenAI 兼容客户端没有 provider 注册表，
 * 此前把两者硬编码为 128000 / 16384。本模块以模型名模式表替代固定常量：
 *
 *   - 命中规则的模型：按其公开契约取值（上下文窗口、单次输出上限）；
 *   - 未命中的模型：沿用原常量（fallback），行为与改动前完全一致。
 *
 * 取值方向刻意保守：低估输出上限只会让批量翻译分更多批（安全），高估则可能
 * 让请求超过模型真实上限而报错。因此表内输出上限普遍低于各模型的公开峰值，
 * 且只收录托管服务上有稳定契约的家族；本地部署（Ollama 等）的上下文由部署
 * 方决定，无法按名推断，一律走 fallback，由用户自行调低
 * translate.batchMaxTokens。
 *
 * 纯数据 + 纯函数：单元测试直接覆盖。
 *
 * @module core/ai/modelCatalog
 */

/** 模型的输入与输出预算（估算 token）。 */
export interface ModelBudgets {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

/**
 * 未识别模型的兜底值——即引入本模块前的硬编码常量，行为基准不变。
 */
export const FALLBACK_MODEL_BUDGETS: ModelBudgets = {
  contextWindowTokens: 128000,
  maxOutputTokens: 16384,
};

interface ModelBudgetRule {
  /** 对模型 id（小写化后）做 test；首个命中的规则生效。 */
  pattern: RegExp;
  budgets: ModelBudgets;
}

/**
 * 模型预算规则表。顺序有意义：特例在前，家族兜底在后。
 * 每条规则的取值依据写在行内注释里（公开契约来源与保守化说明）。
 */
const MODEL_BUDGET_RULES: readonly ModelBudgetRule[] = [
  // gpt-5 家族：400k 输入 / 128k 输出；输出按 64k 保守取值。
  { pattern: /gpt-5/, budgets: { contextWindowTokens: 400000, maxOutputTokens: 65536 } },
  // gpt-4.1：1M 输入 / 32k 输出。
  { pattern: /gpt-4\.1/, budgets: { contextWindowTokens: 1048576, maxOutputTokens: 32768 } },
  // o 系列推理模型：200k 输入；输出按 64k 保守取值（o1-mini 上限 65536）。
  { pattern: /^o[134](-|$)/, budgets: { contextWindowTokens: 200000, maxOutputTokens: 65536 } },
  // Claude 3.x（含 3.5 与 3.7 的 8k 基线档）：200k 输入 / 8192 输出。
  { pattern: /claude-3/, budgets: { contextWindowTokens: 200000, maxOutputTokens: 8192 } },
  // Claude 4 系（sonnet-4 峰值 64k、opus-4 峰值 32k）：输出按 32k 保守取值。
  { pattern: /claude/, budgets: { contextWindowTokens: 200000, maxOutputTokens: 32000 } },
  // gemini-2.5：1M 输入 / 64k 输出。
  { pattern: /gemini-2\.5/, budgets: { contextWindowTokens: 1048576, maxOutputTokens: 65536 } },
  // gemini 其余（2.0 flash 等）：1M 输入 / 8192 输出。
  { pattern: /gemini/, budgets: { contextWindowTokens: 1048576, maxOutputTokens: 8192 } },
  // deepseek-reasoner（R1）：64k 输入；输出按 32k 保守取值。
  { pattern: /deepseek-reasoner/, budgets: { contextWindowTokens: 65536, maxOutputTokens: 32768 } },
  // deepseek-chat（V3）：64k 输入 / 8192 输出。
  { pattern: /deepseek/, budgets: { contextWindowTokens: 65536, maxOutputTokens: 8192 } },
  // GLM-4.6：200k 输入；输出按 32k 保守取值（峰值 128k）。
  { pattern: /glm-4\.6/, budgets: { contextWindowTokens: 200000, maxOutputTokens: 32768 } },
  // GLM-4.5：128k 输入；输出按 32k 保守取值（峰值 96k）。
  { pattern: /glm-4\.5/, budgets: { contextWindowTokens: 131072, maxOutputTokens: 32768 } },
  // GLM 其余：按 4.5 档取 128k 输入。
  { pattern: /glm/, budgets: { contextWindowTokens: 131072, maxOutputTokens: 16384 } },
  // Qwen3：128k 原生输入；输出按 32k 保守取值。
  { pattern: /qwen3/, budgets: { contextWindowTokens: 131072, maxOutputTokens: 32768 } },
  // Qwen 其余（2.5 等）：128k 输入 / 8192 输出。
  { pattern: /qwen/, budgets: { contextWindowTokens: 131072, maxOutputTokens: 8192 } },
  // Kimi 与 Moonshot：128k 输入；输出按 8192 保守取值。
  { pattern: /kimi|moonshot/, budgets: { contextWindowTokens: 131072, maxOutputTokens: 8192 } },
];

/**
 * 解析一个模型 id 的预算。大小写不敏感；空值与未识别的名字返回
 * FALLBACK_MODEL_BUDGETS（改动前的行为）。
 */
export function resolveModelBudgets(model?: string | null): ModelBudgets {
  const id = String(model ?? "").toLowerCase();
  if (!id) return FALLBACK_MODEL_BUDGETS;
  for (const rule of MODEL_BUDGET_RULES) {
    if (rule.pattern.test(id)) return rule.budgets;
  }
  return FALLBACK_MODEL_BUDGETS;
}
