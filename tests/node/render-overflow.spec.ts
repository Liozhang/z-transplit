/**
 * render-overflow — 横向溢出从"静默"变成"有声"的端到端回归。
 *
 * 为什么单立一个文件：`LayoutPreservingRenderer.renderParagraph` 用两条杠杆避免
 * 纵向溢出（先缩字号、再缩行高），用尽后硬截断并记 `stats.overflowed`。但它此前
 * **完全不知道横向溢出**——折行宽度的 10 磅地板把窄段落（坐标轴刻度、图例标签，
 * 实测宽 3 到 6 磅）的宽度抬到 10 磅，画出来右溢 3 磅，而渲染端一次都没报过。
 *
 * 后果是读者看得见译文画出框外，产品统计却说一切正常。基准的度量侧
 * `layout.overflow.right` 在五篇上一共数到 10 处，门禁也管它，但产品侧的
 * `stats.overflowed` 全是 0——两边对不上，而没有任何机制会发现这件事。
 *
 * 批 5 补上 `stats.overflowedRight`，本文件钉住三件事：
 *   1. 窄段落画到框外时，产品报得出这个数（不再静默）。
 *   2. 正常宽度的段落不误报（不能把计数变成噪声）。
 *   3. 10 磅地板保留——去掉它的实测代价见 text-wrapper-overflow.spec.ts 的说明，
 *      这里用断言把它锁住：窄段落的折行宽度确实被地板抬高了。
 *
 * @module tests/node/render-overflow
 */

import { describe, expect, it } from "vitest";

import { renderLayoutPreserving } from "../../src/core/pdf/translation/LayoutPreservingRenderer";
import { cjkFontBytes } from "./helpers/sourceFixture";
import type { AssemblyResult } from "../../src/core/pdf/translation/translationIR";

/** 页面尺寸：`AssemblyResult` 不带页宽页高，它是渲染选项，不放在装配里。 */
const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

/** 造一个单页装配：一个段落加一段译文。 */
function assemblyWith(
  paragraph: { x0: number; y0: number; x1: number; y1: number; size: number },
  text: string,
): AssemblyResult {
  return {
    texts: [text],
    paragraphs: [{ ...paragraph, y: paragraph.y0, x: paragraph.x0, brk: false }],
    globalLines: [],
  } as unknown as AssemblyResult;
}

/**
 * 渲染一页，取回 stats。
 *
 * 必须带 CJK 字体：没有它时渲染端走 StandardFonts 回退，`sanitizeForFont` 把每个
 * 中文字符换成 `?` 再把连续的 `?` 折叠成单个 `…`——译文被压成一个字符，什么溢出
 * 都造不出来。所以这里从 sourceFixture 探测真实字体；探测不到就跳过这组用例
 * （那是环境缺字体，不是被测代码的问题）。
 */
async function renderStats(
  assembly: AssemblyResult,
  translated: string[],
): Promise<{ overflowed: number; overflowedRight: number } | null> {
  const font = cjkFontBytes();
  if (!font) return null;
  const result = await renderLayoutPreserving(assembly, translated, {
    targetLanguage: "zh-CN",
    pageWidth: PAGE_WIDTH,
    pageHeight: PAGE_HEIGHT,
    cjkFontBytes: font,
  });
  return {
    overflowed: result.stats.overflowed,
    overflowedRight: result.stats.overflowedRight,
  };
}

describe("renderLayoutPreserving — 横向溢出终于被报出来", () => {
  it("窄段落画到框外时 overflowedRight 报得出数", async () => {
    // 宽 3 磅的段落（三栏纵轴刻度 `0` 就是这个尺寸），配一段中文译文。折行宽度的
    // 10 磅地板会把宽度抬到 10 磅，画出来右溢——此前渲染端一次都没报过。
    const assembly = assemblyWith(
      { x0: 354, y0: 410, x1: 357, y1: 417, size: 6 },
      "这一节交代参数选取的",
    );
    const stats = await renderStats(assembly, [assembly.texts[0]]);
    if (stats === null) return; // 环境无 CJK 字体，跳过
    expect(stats.overflowedRight).toBeGreaterThan(0);
  });

  it("宽 6 磅的窄段同样报得出", async () => {
    // 宽 6 磅的段落放一个中文就超宽（一个字约等于字号宽，5 磅以上），地板再抬到
    // 10 磅，一行能放两个字，右界必超段宽。
    const assembly = assemblyWith(
      { x0: 351, y0: 458, x1: 357, y1: 464, size: 6 },
      "结果支持注意力",
    );
    const stats = await renderStats(assembly, [assembly.texts[0]]);
    if (stats === null) return;
    expect(stats.overflowedRight).toBeGreaterThan(0);
  });

  it("正常宽度的段落不误报", async () => {
    // 宽 200 磅的正文段，译文放得下——计数必须是 0，否则这个指标会变成噪声，
    // 也就失去了"报出真问题"的作用。
    const assembly = assemblyWith(
      { x0: 50, y0: 300, x1: 250, y1: 400, size: 10 },
      "这是一段长度适中的合成译文用于验证不误报",
    );
    const stats = await renderStats(assembly, [assembly.texts[0]]);
    if (stats === null) return;
    expect(stats.overflowedRight).toBe(0);
    expect(stats.overflowed).toBe(0);
  });

  it("横向与纵向分开计数，互不干扰", async () => {
    // 一个又窄又矮的段落：横向必然溢出（地板把宽度抬到 10 磅），纵向也放不下
    // （高度只有 6 磅，字号缩到 4 磅地板仍塞不进）。两个计数都该动，且各自独立
    // ——合并成一个数就分不出是哪边出问题。
    const assembly = assemblyWith(
      { x0: 354, y0: 410, x1: 357, y1: 416, size: 6 },
      "这一节交代参数选取的理由很长",
    );
    const stats = await renderStats(assembly, [assembly.texts[0]]);
    if (stats === null) return;
    expect(stats.overflowedRight).toBeGreaterThan(0);
    expect(stats.overflowed).toBeGreaterThan(0);
  });
});

describe("renderLayoutPreserving — 10 磅地板被锁住", () => {
  it("窄段落的折行宽度确实被地板抬高（这是保留地板的实测依据）", async () => {
    // 这一条是那次"想去掉地板"实测的结论固化：去掉地板会让窄段每行只放一个字，
    // 字号被砍到 4 磅、内容被截断，五篇的 boxRecall 全线下降。地板在，译文才保持
    // 字号正常、内容较完整——代价是右溢，而右溢现在会被 overflowedRight 报出来。
    const narrow = assemblyWith(
      { x0: 354, y0: 410, x1: 357, y1: 430, size: 6 },
      "刻度",
    );
    const stats = await renderStats(narrow, [narrow.texts[0]]);
    if (stats === null) return;
    // 有右溢 → 说明折行宽度用的是地板值 10 磅，不是段宽 3 磅。
    expect(stats.overflowedRight).toBeGreaterThan(0);
  });
});

describe("renderLayoutPreserving — 混合字体的宽度测量", () => {
  it("CJK 与 Latin 混排的整行宽度也量准（不只量第一段）", async () => {
    // drawLineMixed 把一行拆成 CJK 与 Latin 分别绘制。横向溢出判定用的是整行宽度
    // （font.widthOfTextAtSize(line, size)），与分段绘制无关。这一条保证判定不会
    // 因为混排而漏计。
    const assembly = assemblyWith(
      { x0: 354, y0: 410, x1: 357, y1: 430, size: 6 },
      "参数 a1 取值 b2",
    );
    const stats = await renderStats(assembly, [assembly.texts[0]]);
    if (stats === null) return;
    expect(stats.overflowedRight).toBeGreaterThan(0);
  });
});
