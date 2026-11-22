/**
 * translationScope — 哪些段落不送翻译、保留原文。
 *
 * 批 3 记在案、由用户拍定的产品决策：**图内文字只翻放得下的**。两条判据都是纯
 * 几何与纯文本，不依赖图片区域检测（figureTextFilter 靠的那条 --inspect 路径
 * 在五篇基准夹具上返回 0 个区域，排除从未生效）。
 *
 * 这个文件钉住三件事：
 *   1. 两条判据各自的边界——尤其是"框宽 ÷ 字号恰好等于 1"算放得下（判据是严格
 *      小于），以及纯数字串的承认范围（符号、千分位、百分号算，字母不算）；
 *   2. 目标语不是中日韩时一条都不标——窄框对拉丁语种不是问题；
 *   3. 走完整条装配链路后，标注真的落在段落数组上、且与 texts 同位。
 *
 * 最后一条不是重复：判据算对了但挂错位置（比如按页而不是按段），前两组测试看
 * 不出来，而下游全都按位取值，错位会让另一段被清空。
 *
 * @module tests/node/translation-scope
 */

import { describe, expect, it } from "vitest";

import {
  computeKeepOriginal,
  isCjkTargetLanguage,
  isNumericOnlyText,
  paragraphTooNarrowForCjk,
  shouldKeepOriginal,
} from "../../src/core/pdf/translation/translationScope";
import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";
import type { Paragraph } from "../../src/core/pdf/translation/translationIR";
import type { PdfDocumentAnalysis } from "../../src/core/pdf/PdfIR";

function para(overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    x: 50,
    y: 700,
    x0: 50,
    x1: 300,
    y0: 700,
    y1: 715,
    size: 12,
    brk: false,
    ...overrides,
  } as Paragraph;
}

describe("isCjkTargetLanguage", () => {
  it("中日韩三种都算", () => {
    expect(isCjkTargetLanguage("zh-CN")).toBe(true);
    expect(isCjkTargetLanguage("zh-TW")).toBe(true);
    expect(isCjkTargetLanguage("ja")).toBe(true);
    expect(isCjkTargetLanguage("ko")).toBe(true);
  });

  it("大小写与空值都不算", () => {
    expect(isCjkTargetLanguage("ZH-CN")).toBe(true);
    expect(isCjkTargetLanguage("en")).toBe(false);
    expect(isCjkTargetLanguage("fr")).toBe(false);
    expect(isCjkTargetLanguage("")).toBe(false);
    expect(isCjkTargetLanguage(null)).toBe(false);
    expect(isCjkTargetLanguage(undefined)).toBe(false);
  });
});

describe("isNumericOnlyText", () => {
  it("坐标轴刻度那几种形状都算", () => {
    expect(isNumericOnlyText("0")).toBe(true);
    expect(isNumericOnlyText("20")).toBe(true);
    expect(isNumericOnlyText(" 15 ")).toBe(true);
    expect(isNumericOnlyText("1,000")).toBe(true);
    expect(isNumericOnlyText("3.14")).toBe(true);
    expect(isNumericOnlyText("-5")).toBe(true);
    expect(isNumericOnlyText("+5")).toBe(true);
    expect(isNumericOnlyText("25%")).toBe(true);
  });

  it("带字母、带其他符号、空串都不算", () => {
    // 混了字母就不是纯数字：三栏的 `Wk 1 Wk 3` 是图例不是刻度，照旧译。
    expect(isNumericOnlyText("Wk 1")).toBe(false);
    expect(isNumericOnlyText("20th")).toBe(false);
    expect(isNumericOnlyText("N/A")).toBe(false);
    expect(isNumericOnlyText("...")).toBe(false);
    expect(isNumericOnlyText("—")).toBe(false);
    expect(isNumericOnlyText("")).toBe(false);
    expect(isNumericOnlyText("   ")).toBe(false);
    expect(isNumericOnlyText(undefined)).toBe(false);
    expect(isNumericOnlyText(null)).toBe(false);
  });
});

describe("paragraphTooNarrowForCjk", () => {
  it("框宽放不下一个字号宽的汉字时为真", () => {
    // 实测的坐标轴刻度：3 磅框配 6 磅字号，半个汉字都放不下。
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 103, size: 6 }))).toBe(true);
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 105.9, size: 6 }))).toBe(true);
  });

  it("恰好等于一个汉字宽算放得下（判据是严格小于）", () => {
    // 6 磅框配 6 磅字号：一个汉字刚好。这一条钉的是边界口径——改成 <= 会把
    // 一批刚好放得下的段一并排除。
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 106, size: 6 }))).toBe(false);
    expect(paragraphTooNarrowForCjk(para({ x0: 50, x1: 300, size: 12 }))).toBe(false);
  });

  it("退化框不判，交给既有护栏", () => {
    // 宽或高非正时判什么都可能误伤，交给 clampParagraph 与 odlToAssembly 的守卫。
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 100, size: 6 }))).toBe(false);
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 90, size: 6 }))).toBe(false);
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 200, size: 0 }))).toBe(false);
    expect(paragraphTooNarrowForCjk(para({ x0: 100, x1: 200, size: -3 }))).toBe(false);
  });
});

describe("shouldKeepOriginal", () => {
  it("纯数字串一律保留，与宽窄无关", () => {
    // 数字译成中文数字只会变宽（「20」→「二十」翻倍），保持阿拉伯数字放得下。
    expect(shouldKeepOriginal(para({ x1: 300 }), "20", true)).toBe(true);
    expect(shouldKeepOriginal(para({ x0: 100, x1: 103, size: 6 }), "0", true)).toBe(true);
  });

  it("窄的非数字段保留", () => {
    expect(shouldKeepOriginal(para({ x0: 100, x1: 103, size: 6 }), "A", true)).toBe(true);
  });

  it("够宽的非数字段照旧译", () => {
    expect(shouldKeepOriginal(para(), "正常正文", true)).toBe(false);
    expect(shouldKeepOriginal(para({ x1: 300 }), "Wk 1 Wk 3 Wk 5", true)).toBe(false);
  });

  it("目标语不是中日韩时一条都不保留", () => {
    // 窄框对中文日语是放不下，对拉丁语种的同样宽度放得下「20」。
    expect(shouldKeepOriginal(para({ x0: 100, x1: 103, size: 6 }), "0", false)).toBe(false);
    expect(shouldKeepOriginal(para({ x0: 100, x1: 103, size: 6 }), "A", false)).toBe(false);
    expect(shouldKeepOriginal(para(), "20", false)).toBe(false);
  });
});

describe("computeKeepOriginal", () => {
  it("逐段给出，与输入同位", () => {
    const paragraphs = [
      para({ x1: 300 }),                              // 宽正文
      para({ x0: 100, x1: 103, size: 6 }),            // 窄刻度
      para({ x0: 100, x1: 106, size: 6 }),            // 刚好一个汉字
    ];
    const texts = ["正常正文", "0", "A"];
    expect(computeKeepOriginal(paragraphs, texts, true)).toEqual([false, true, false]);
  });

  it("texts 比 paragraphs 短时不越界（缺的当空串）", () => {
    // 这一条钉的是"不抛、不越界"，不是值：第二段窄，几何判据本就该标 true，
    // 与它的文本是什么无关（这里 texts[1] 缺失，当空串）。
    const paragraphs = [para({ x1: 300 }), para({ x0: 100, x1: 103, size: 6 })];
    expect(computeKeepOriginal(paragraphs, ["只有一段"], true)).toEqual([false, true]);
    // 空数组两个方向都不炸。
    expect(computeKeepOriginal([], [], true)).toEqual([]);
    expect(computeKeepOriginal([para()], [], true)).toEqual([false]);
  });
});

describe("odlAnalysisToAssembly 挂上 keepOriginal", () => {
  /** 造一份只带文字块的分析。bbox 用 x/y/width/height，与 PdfIR 一致。 */
  function analysisWithBlocks(
    blocks: Array<{ text: string; x: number; y: number; width: number; height: number; size: number }>,
  ): PdfDocumentAnalysis {
    return {
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: blocks.map((b) => ({
            text: b.text,
            bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
            fontSize: b.size,
            fontName: "Helvetica",
            hasEOL: true,
          })),
          regions: [],
          tables: [],
          chartAreas: [],
          formulas: [],
          repeatedElements: [],
          citations: [],
        },
      ],
      allTables: [],
      allFormulas: [],
      allChartAreas: [],
      allCitations: [],
      filteredText: "",
      filteredMarkdown: "",
      confidence: 0.9,
      processingMs: 0,
    } as unknown as PdfDocumentAnalysis;
  }

  it("窄数字刻度被标上，宽正文与宽图例不标", () => {
    const built = odlAnalysisToAssembly(
      analysisWithBlocks([
        { text: "这是一段足够宽的正文，用来对照。", x: 50, y: 700, width: 300, height: 14, size: 12 },
        { text: "Wk 1 Wk 3 Wk 5 Wk 6", x: 50, y: 600, width: 120, height: 8, size: 6 },
        { text: "0", x: 100, y: 500, width: 3, height: 6, size: 6 },
        { text: "20", x: 100, y: 400, width: 6, height: 6, size: 6 },
      ]),
    );
    const page = built.assemblies[0];
    expect(page.keepOriginal).toHaveLength(page.paragraphs.length);
    expect(page.keepOriginal).toHaveLength(page.texts.length);
    // 逐段核对到具体文本，避免"数量对但错位"——错位会让另一段被清空。
    const flagged = page.texts.filter((_, i) => page.keepOriginal?.[i]);
    expect(flagged.sort()).toEqual(["0", "20"]);
  });

  it("目标语传英语时一条都不标", () => {
    const built = odlAnalysisToAssembly(
      analysisWithBlocks([
        { text: "0", x: 100, y: 500, width: 3, height: 6, size: 6 },
        { text: "20", x: 100, y: 400, width: 6, height: 6, size: 6 },
      ]),
      { targetLanguage: "en" },
    );
    expect(built.assemblies[0].keepOriginal).toEqual([false, false]);
  });

  it("不传目标语言时按中文目标算（插件的默认目标语）", () => {
    const built = odlAnalysisToAssembly(
      analysisWithBlocks([{ text: "20", x: 100, y: 400, width: 6, height: 6, size: 6 }]),
    );
    expect(built.assemblies[0].keepOriginal).toEqual([true]);
  });
});
