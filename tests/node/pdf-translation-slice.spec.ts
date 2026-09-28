 
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
  // 保留 {vn} 占位符原样（formulaPreservingPrompt 已强调，这里 stub 也遵守）
  const placeholders: string[] = [];
  const protected_ = text.replace(/\{\s*v[\d\s]+\}/gi, (m) => {
    placeholders.push(m);
    return `\x00${placeholders.length - 1}\x00`;
  });
  // 逐词映射，未命中的词用「词」包裹表示是中文段
  const zh = protected_
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      const lower = tok.toLowerCase().replace(/[^a-z]/g, "");
      return ZH_MAP[lower] ?? `「${tok}」`;
    })
    .join("");
  // eslint-disable-next-line no-control-regex -- \x00 delimiters are intentional placeholder markers
  return zh.replace(/\x00(\d+)\x00/g, (_, i) => placeholders[Number(i)]);
};

describe("PDF 布局保留翻译 — 端到端切片", () => {
  it("formulaPreservingPrompt 应包含明确的 {vn} 保留指令", () => {
    const prompt = formulaPreservingPrompt("Simplified Chinese", "English");
    expect(prompt).toMatch(/\{v0\}/);
    expect(prompt.toLowerCase()).toContain("preserve");
    expect(prompt.toLowerCase()).toContain("only the translated text");
  });

  it("stub 翻译器应保留 {vn} 占位符并产出中文", async () => {
    const out = await stubTranslator("The value {v0} is given by {v1}", "zh-CN");
    expect(out).toContain("{v0}");
    expect(out).toContain("{v1}");
    expect(out).toContain("该"); // "the" → "该"
    expect(out).toContain("「value」"); // 未命中词被中文括号包裹
  });
});

// 单独测 stub 翻译器逻辑（不依赖模型，始终运行）
describe("stub translator 占位符保留", () => {
  it("保留多个 {vn} 且产出中文", async () => {
    const out = await stubTranslator("a {v0} b {v1} c", "zh-CN");
    expect(out).toContain("{v0}");
    expect(out).toContain("{v1}");
    // "a" → "一个"，未命中的 b/c 被中文括号包裹
    expect(out).toContain("一个");
    expect(out).toContain("「b」");
  });
});
