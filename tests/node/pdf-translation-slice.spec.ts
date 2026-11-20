 
/**
 * PDF 布局保留翻译 — 切片测试
 *
 * 验证翻译辅助函数及 stub 翻译器的逻辑正确性，不验证翻译质量。
 *
 * 注入策略：
 *   - translate：stub，做简单的 en→zh 映射或原样返回，保留 {vn} 占位符
 *
 * Ported from leadero's tests/node/pdf-translation-slice.spec.ts. The
 * `formulaPreservingPrompt` / `ParagraphTranslator` imports now resolve to
 * src/core/pdf/translation/translateParagraphs.ts, which re-exports the single
 * wording from src/core/translation/prompts.ts and the type from
 * src/core/translation/types.ts.
 */

import { describe, it, expect } from "vitest";

import { formulaPreservingPrompt } from "../../src/core/pdf/translation/translateParagraphs";
import type { ParagraphTranslator } from "../../src/core/pdf/translation/translateParagraphs";

const ZH_MAP: Record<string, string> = {
  the: "该",
  a: "一个",
  an: "一个",
  of: "的",
  and: "与",
  in: "在",
  to: "至",
  is: "是",
  are: "是",
  for: "用于",
  with: "带有",
  on: "关于",
  by: "通过",
  this: "本文",
  we: "我们",
  our: "我们的",
  that: "该",
  model: "模型",
  data: "数据",
  result: "结果",
  method: "方法",
  algorithm: "算法",
  figure: "图",
  table: "表",
  section: "节",
  abstract: "摘要",
  introduction: "引言",
  conclusion: "结论",
  references: "参考文献",
};
const stubTranslator: ParagraphTranslator = async (
  text: string,
): Promise<string> => {
  // 不再需要手工保护占位符：生产链路上 formulaShield 会在请求前把公式摘成
  // 占位符、译后放回。这个 stub 模拟"引擎老实原样返回了公式"这一最好情况，
  // 用来验证渲染前的化简与提示词契约。
  const protected_ = text;
  // 逐词映射，未命中的词用「词」包裹表示是中文段
  const zh = protected_
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      const lower = tok.toLowerCase().replace(/[^a-z]/g, "");
      return ZH_MAP[lower] ?? `「${tok}」`;
    })
    .join("");
  return zh;
};

describe("PDF 布局保留翻译 — 端到端切片", () => {
  it("formulaPreservingPrompt 应包含明确的 $...$ 保留指令", () => {
    const prompt = formulaPreservingPrompt("Simplified Chinese", "English");
    expect(prompt).toContain("$...$");
    expect(prompt.toLowerCase()).toContain("preserve");
    expect(prompt.toLowerCase()).toContain("only the translated text");
    // 早先这里断言提示词承诺保留 {v0} 占位符。管线已经很久不生成那种占位符，
    // 承诺无法兑现，该条款已删——这里反过来断言它不再出现。
    expect(prompt).not.toMatch(/\{v0\}/);
  });

  it("stub 翻译器应原样保留 $...$ 公式并产出中文", async () => {
    const out = await stubTranslator("The value $x^2$ is given by $y$", "zh-CN");
    expect(out).toContain("$x^2$");
    expect(out).toContain("$y$");
    expect(out).toContain("该"); // "the" → "该"
    expect(out).toContain("「value」"); // 未命中词被中文括号包裹
  });
});

// 单独测 stub 翻译器逻辑（不依赖模型，始终运行）
describe("stub translator 公式保留", () => {
  it("保留多个 $...$ 公式且产出中文", async () => {
    const out = await stubTranslator("a $p$ b $q$ c", "zh-CN");
    expect(out).toContain("$p$");
    expect(out).toContain("$q$");
    // "a" → "一个"，未命中的 b/c 被中文括号包裹
    expect(out).toContain("一个");
    expect(out).toContain("「b」");
  });
});
