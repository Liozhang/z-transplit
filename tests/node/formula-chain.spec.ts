/**
 * formula-chain — 公式链路四个环节的单元测试：判据、子区间标记、引擎外的
 * 保护层、渲染前的 LaTeX 化简，外加截图回贴的账目。
 *
 * 为什么单独立一个文件：这条链路上的四个模块（isFormulaParagraph /
 * markFormulaSpans / formulaShield / latexToPlain）在此前一条测试都没有。
 * formulaExtractor、captureFormulaScreenshots、compositeFormulas 也是零覆盖，
 * 所以"公式在译文 PDF 里到底长什么样"这件事，改任何一处之前都没有回归保护。
 *
 * 测试用的五段真实文本取自 scripts/qa/benchmark/answer-keys/formula-dense.json
 * 点名的硬用例：四条真公式、三个统计正文误报诱饵、两个漏报诱饵。判据必须在
 * 这九段上全部分对，否则精确率 0.571 的老问题会回来。
 *
 * @module tests/node/formula-chain
 */

import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";

import {
  isFormulaParagraph,
  markFormulaSpans,
  countFormulaSpans,
  odlAnalysisToAssembly,
} from "../../src/core/pdf/translation/odlToAssembly";
import {
  shieldFormulas,
  restoreFormulas,
} from "../../src/core/pdf/translation/formulaShield";
import { latexToPlain } from "../../src/core/pdf/translation/latexToPlain";
import { isPureFormulaParagraph } from "../../src/core/pdf/translation/translateParagraphs";
import { compositeFormulas } from "../../src/core/pdf/translation/ImageCompositor";
import type { PdfDocumentAnalysis } from "../../src/core/pdf/PdfIR";

// ─── 答案键点名的九段硬用例 ───────────────────────────────────────────

const TRUE_FORMULAS = [
  "αi = exp(θ si) / Σj=1n exp(θ sj)(1)",
  "αi / αk = exp(θ (si − sk))(2)",
  "ℓ(θ) = Σi=1n di log αi − λ Σi=1n αi(3)",
  "T = (1/n) Σi=1n di / (1 + exp(−θ si))(4)",
];

const FALSE_POSITIVE_BAIT =
  "Under the null hypothesis of no attentional modulation we have θ = 0, and the " +
  "weights collapse to the uniform distribution. The estimator is asymptotically " +
  "normal: writing β and α for the regression coefficients, the standard error " +
  "satisfies s ≈ 1.96 / √n whenever p ≈ 0.05 and the residuals are homoscedastic. " +
  "In practice the inequality χ² ≥ 3.84 is the operative test, and we reject the " +
  "null whenever the observed statistic exceeds that threshold with r ≠ 0 and the " +
  "effect size is at least δ ≥ 0.2.";

const FALSE_POSITIVE_BAIT_2 =
  "Other unseen cases include the limit notation limn→∞, the trigonometric pair " +
  "sin θ + cos θ, the set relations x ∈ A and A ⊂ B, the membership of the empty " +
  "set ∅, and the subtraction written with the true minus sign a − b rather than " +
  "a hyphen. None of these characters appears in the symbol class, so none of them " +
  "triggers the formula path.";

const FALSE_POSITIVE_BAIT_3 =
  "Equation (4) reduces to the mean duration when θ = 0 and to a max-like statistic " +
  "when θ is large. Both limits are recovered correctly by the iteration, which is " +
  "the main practical argument for the softmax parameterisation.";

const FALSE_NEGATIVE_BAIT =
  "Some formulae contain no character from the heuristic's symbol class at all. The " +
  "most familiar example is the Pythagorean identity a² + b² = c², whose only " +
  "non-ASCII character is the superscript two.";

const CHINESE_STATISTICAL_PROSE =
  "在零假设下 θ = 0，权重退化为均匀分布，此时估计量渐近正态，记 β 与 α 为回归系数。";

describe("isFormulaParagraph — 两条件判据", () => {
  it("四条真公式全部命中", () => {
    for (const text of TRUE_FORMULAS) {
      expect(isFormulaParagraph(text), text).toBe(true);
    }
  });

  it("三个统计正文误报诱饵全部排除", () => {
    for (const text of [FALSE_POSITIVE_BAIT, FALSE_POSITIVE_BAIT_2, FALSE_POSITIVE_BAIT_3]) {
      expect(isFormulaParagraph(text), text.slice(0, 40)).toBe(false);
    }
  });

  it("漏报诱饵整段不判公式——靠子区间标记兜住内部的 a² + b² = c²", () => {
    // 这一段真值是"正文"，但里面嵌着一条真公式。整段判否是对的，公式本身
    // 由 markFormulaSpans 标出，见下一个 describe。
    expect(isFormulaParagraph(FALSE_NEGATIVE_BAIT)).toBe(false);
    expect(markFormulaSpans(FALSE_NEGATIVE_BAIT)).toContain("$a² + b² = c²$");
  });

  it("中文统计正文不被误判（汉字数超过上限）", () => {
    // 旧判据只看希腊字母密度，这段有两个希腊字母加一个不等号，会被整段判成
    // 公式区、裁图、译文被盖死。汉字上限把它挡住。
    expect(isFormulaParagraph(CHINESE_STATISTICAL_PROSE)).toBe(false);
    // 但短中文引导语加公式仍然命中。
    expect(isFormulaParagraph("设 x² + y² = z²")).toBe(true);
  });

  it("单个散落符号不触发（阈值仍为 2）", () => {
    expect(isFormulaParagraph("The coefficient β was estimated.")).toBe(false);
    expect(isFormulaParagraph("α")).toBe(false);
    expect(isFormulaParagraph("")).toBe(false);
  });
});

describe("markFormulaSpans — 公式子区间标记", () => {
  it("行内公式被单独圈出，引导语留在外面", () => {
    expect(markFormulaSpans("Under the null hypothesis we have θ = 0, and χ² ≥ 3.84"))
      .toBe("Under the null hypothesis we have $θ = 0$, and $χ² ≥ 3.84$");
  });

  it("原本漏报的 a² + b² = c² 被整条圈出", () => {
    // 上标数字不在旧字符类里，整段判不上公式，符号被机器翻译引擎改写成普通
    // 数字。补齐字符类之后这一条能圈出来。
    expect(markFormulaSpans("a² + b² = c²")).toBe("$a² + b² = c²$");
    expect(countFormulaSpans("a² + b² = c²")).toBe(1);
  });

  it("逗号不再是公式内容，相邻公式不会被连成一片", () => {
    // 第一版把逗号算作公式运算符，`limn→∞, sin θ` 被圈成一个区间。
    const marked = markFormulaSpans(
      "limn→∞, sin θ + cos θ, x ∈ A and A ⊂ B, the empty set ∅, and a − b rather",
    );
    expect(marked).toContain("$∞$");
    expect(marked).toContain("$sin θ + cos θ$");
    expect(marked).toContain("$x ∈ A$");
    expect(marked).toContain("$A ⊂ B$");
    expect(marked).toContain("$∅$");
    expect(marked).toContain("$a − b$");
    expect(countFormulaSpans(marked)).toBe(6);
  });

  it("双字母变量收进区间，双字母虚词不收", () => {
    // `p(ti | t<i)` 要整块收；`weight as αi` 里的 `as` 不该被圈进公式，否则
    // 译文会把 `as` 原样保留成英文。
    expect(markFormulaSpans("si = −log p(ti | t<i)")).toBe("$si = −log p(ti | t<i)$");
    expect(markFormulaSpans("the latent weight as αi")).toBe("the latent weight as $αi$");
  });

  it("已经带 $ 的文本原样返回（OCR 侧车与视觉模型的 LaTeX 不再二次包裹）", () => {
    expect(markFormulaSpans("$E = mc^2$")).toBe("$E = mc^2$");
    expect(markFormulaSpans("定理 $$E = mc^2$$ 如下")).toBe("定理 $$E = mc^2$$ 如下");
  });

  it("没有公式的正文一个区间都不标", () => {
    expect(markFormulaSpans("Equation (1) is the softmax form.")).toBe(
      "Equation (1) is the softmax form.",
    );
    expect(countFormulaSpans("Substituting (1) and collecting terms")).toBe(0);
  });
});

describe("formulaShield — 引擎外的公式保护", () => {
  it("往返：摘出来再放回去，内容与位置都不变", () => {
    const text = "Under the null hypothesis we have $θ = 0$, and $χ² ≥ 3.84$";
    const { shielded, slots } = shieldFormulas(text);
    expect(shielded).not.toContain("$");
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.latex)).toEqual(["θ = 0", "χ² ≥ 3.84"]);
    expect(restoreFormulas(shielded, slots).text).toBe(text);
  });

  it("$$...$$ 优先于 $...$，展示公式不被切成两个空的内联式", () => {
    const { slots } = shieldFormulas("前 $$E = mc^2$$ 后");
    expect(slots).toHaveLength(1);
    expect(slots[0].latex).toBe("E = mc^2");
  });

  it("空公式不占位（占位符会看不见，原文更短）", () => {
    const { shielded, slots } = shieldFormulas("a $$ b");
    expect(slots).toHaveLength(0);
    expect(shielded).toBe("a $$ b");
  });

  it("降级一：引擎在符号之间插了空格，仍能换回", () => {
    const { shielded, slots } = shieldFormulas("结果是 $x^2$ 可知");
    const padded = shielded.replace(/⟦/g, "⟦ ").replace(/⟧/g, " ⟧");
    const out = restoreFormulas(padded, slots);
    expect(out.restored).toBe(1);
    expect(out.lost).toHaveLength(0);
    expect(out.text).toBe("结果是 $x^2$ 可知");
  });

  it("降级二：占位符被整个丢掉，公式追加到段末（位置不对但内容不丢）", () => {
    const { shielded, slots } = shieldFormulas("结果是 $x^2$ 可知");
    const dropped = shielded.replace(/⟦F\d+⟧/g, "");
    const out = restoreFormulas(dropped, slots);
    expect(out.restored).toBe(0);
    expect(out.lost).toEqual(["x^2"]);
    expect(out.text).toContain("$x^2$");
  });

  it("降级三：占位符被改写成普通方括号，残留被清掉、公式追加到段末", () => {
    const { shielded, slots } = shieldFormulas("结果是 $x^2$ 可知");
    const garbled = shielded.replace("⟦F0⟧", "[F0]");
    const out = restoreFormulas(garbled, slots);
    expect(out.restored).toBe(0);
    // 我们只能确定数学方括号是占位符残留；普通方括号可能属于正文，不能误伤。
    expect(out.text).toContain("[F0]");
    expect(out.text).toContain("$x^2$");
  });

  it("没有公式时 shield/restore 都是恒等变换", () => {
    const { shielded, slots } = shieldFormulas("普通正文");
    expect(shielded).toBe("普通正文");
    expect(slots).toHaveLength(0);
    expect(restoreFormulas("普通译文", slots).text).toBe("普通译文");
  });
});

describe("latexToPlain — 渲染前的化简", () => {
  it("常见结构转成 Unicode", () => {
    const bs = String.fromCharCode(92);
    expect(latexToPlain("$E = mc^2$")).toBe("E = mc²");
    expect(latexToPlain("$x_{i} + y^{2}$")).toBe("xᵢ + y²");
    expect(latexToPlain(`$${bs}frac{${bs}alpha}{${bs}beta}$`)).toBe("α/β");
    expect(latexToPlain(`$${bs}sum_{i=1}^{n} a_i$`)).toBe("∑ᵢ₌₁ⁿ aᵢ");
    expect(latexToPlain(`$${bs}sqrt{${bs}frac{a}{b}}$`)).toBe("√(a/b)");
    expect(latexToPlain(`$${bs}mathbb{R}^{n}$`)).toBe("Rⁿ");
    expect(latexToPlain("$10^{-3}$")).toBe("10⁻³");
    expect(latexToPlain(`$${bs}theta = 0$`)).toBe("θ = 0");
  });

  it("分式先于花括号处理——否则分子分母会粘成一个词", () => {
    const bs = String.fromCharCode(92);
    // 若先剥花括号，`\\frac{a}{b}` 会变成 `ab`。
    expect(latexToPlain(`$${bs}frac{a}{b}$`)).toBe("a/b");
  });

  it("$ 之外的正文原样不动", () => {
    expect(latexToPlain("由上式 $E = mc^2$ 可得")).toBe("由上式 E = mc² 可得");
    expect(latexToPlain("没有公式的正文")).toBe("没有公式的正文");
  });
});

describe("isPureFormulaParagraph", () => {
  it("整段只有公式时为真", () => {
    expect(isPureFormulaParagraph("$E = mc^2$")).toBe(true);
    expect(isPureFormulaParagraph("$a$$b$")).toBe(true);
    expect(isPureFormulaParagraph("  $x^2$  ")).toBe(true);
  });

  it("夹了正文时为假", () => {
    expect(isPureFormulaParagraph("由 $x^2$ 可得")).toBe(false);
    expect(isPureFormulaParagraph("")).toBe(false);
    expect(isPureFormulaParagraph("普通正文")).toBe(false);
  });
});

describe("compositeFormulas — 截图回贴的账目", () => {
  /** 生成一个 1×1 的合法 PNG data URI（不依赖任何外部图片文件）。 */
  function tinyPngDataUri(r = 255, g = 255, b = 255): string {
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
    const crc32 = (buf: Uint8Array): number => {
      let crc = 0xffffffff;
      for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, data.length);
      const typed = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
      const body = new Uint8Array([...typed, ...data]);
      const crc = new Uint8Array(4);
      new DataView(crc.buffer).setUint32(0, crc32(body));
      return new Uint8Array([...len, ...body, ...crc]);
    };
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, 1);
    ihdrView.setUint32(4, 1);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    const idat = new Uint8Array(zlib.deflateSync(Buffer.from([0, r, g, b])));
    const png = new Uint8Array([
      ...sig,
      ...chunk("IHDR", ihdr),
      ...chunk("IDAT", idat),
      ...chunk("IEND", new Uint8Array(0)),
    ]);
    return "data:image/png;base64," + Buffer.from(png).toString("base64");
  }

  it("有效截图计入 imagesRendered", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const stats = { imagesRendered: 0, imagesDropped: 0 };
    await compositeFormulas(
      page,
      doc,
      { placedFormulas: [{ dataUri: tinyPngDataUri(), bbox: { x: 10, y: 10, width: 50, height: 20 } }] },
      0,
      200,
      200,
      stats,
    );
    expect(stats.imagesRendered).toBe(1);
    expect(stats.imagesDropped).toBe(0);
  });

  it("坏数据 URI 与不支持的格式计入 imagesDropped，不中断", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const stats = { imagesRendered: 0, imagesDropped: 0 };
    await compositeFormulas(
      page,
      doc,
      {
        placedFormulas: [
          { dataUri: "not-a-data-uri", bbox: { x: 10, y: 10, width: 50, height: 20 } },
          { dataUri: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", bbox: { x: 10, y: 40, width: 50, height: 20 } },
        ],
      },
      0,
      200,
      200,
      stats,
    );
    expect(stats.imagesRendered).toBe(0);
    expect(stats.imagesDropped).toBe(2);
  });

  it("没有截图时直接返回，账目不动", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const stats = { imagesRendered: 0, imagesDropped: 0 };
    await compositeFormulas(page, doc, {}, 0, 200, 200, stats);
    await compositeFormulas(page, doc, { placedFormulas: [] }, 0, 200, 200, stats);
    expect(stats).toEqual({ imagesRendered: 0, imagesDropped: 0 });
  });
});

describe("端到端：从 ODL 装配到送翻译的文本", () => {
  function analysisWith(texts: string[]): PdfDocumentAnalysis {
    return {
      source: "tier2-opendataloader-pdf",
      totalPages: 1,
      pages: [
        {
          pageNumber: 1,
          width: 594.96,
          height: 841.92,
          textBlocks: texts.map((text, i) => ({
            text,
            bbox: { x: 50, y: 700 - i * 30, width: 200, height: 15 },
            fontSize: 10,
            fontName: "Helvetica",
            hasEOL: false,
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

  it("行内公式段：标记 → 摘出 → 译文 → 放回 → 化简，一路内容不丢", () => {
    const { assemblies, formulaBlocks } = odlAnalysisToAssembly(
      analysisWith(["Under the null hypothesis we have θ = 0, and χ² ≥ 3.84"]),
    );

    // 整段不是公式区（有完整英文句子），所以不进 formulaBlocks，也就不会被
    // 截图盖死——这正是止损的那一步。
    expect(formulaBlocks).toHaveLength(0);

    // 但公式子串已被标出，保护层能把它从翻译请求里摘出来。
    const { shielded, slots } = shieldFormulas(assemblies[0].texts[0]);
    expect(slots).toHaveLength(2);
    expect(shielded).not.toContain("θ");

    // 模拟一个机器翻译引擎：老实返回了占位符，其余译成中文。
    const engineOutput = "在零假设下我们有 ⟦F0⟧，且 ⟦F1⟧";
    const restored = restoreFormulas(engineOutput, slots);
    expect(restored.lost).toHaveLength(0);
    // 渲染前再化简，读者看到的是数学符号而不是 LaTeX 源码。
    expect(latexToPlain(restored.text)).toBe("在零假设下我们有 θ = 0，且 χ² ≥ 3.84");
  });

  it("真公式段：进 formulaBlocks，latexStatus 初始为 unavailable（等视觉模型）", () => {
    const { assemblies, formulaBlocks } = odlAnalysisToAssembly(
      analysisWith(["αi = exp(θ si) / Σj=1n exp(θ sj)(1)"]),
    );
    expect(formulaBlocks).toHaveLength(1);
    expect(formulaBlocks[0].latexStatus).toBe("unavailable");
    expect(formulaBlocks[0].latex).toBeUndefined();
    // 段内没有可译正文，标记后仍是纯公式，不会被送进翻译引擎。
    expect(isPureFormulaParagraph(assemblies[0].texts[0])).toBe(true);
  });
});
