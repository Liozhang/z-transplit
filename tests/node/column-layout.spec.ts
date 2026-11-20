/**
 * column-layout — 栏检测、跨栏合并块识别与切分的单元测试。
 *
 * 为什么单立一个文件：OpenDataLoader 的 xycut 会把多栏流式排版并成一个块，
 * 它的边界框是多个矩形片的并集。这件事在此前一条测试都没有，而它的四层后果
 * （遮罩涂白邻栏、折行宽度翻倍、删除清单互吞、跨栏段译文被后续遮罩擦除）全
 * 都看不见——`stats.overflowed` 反而不涨，因为译文塞得进那个虚高的并集框。
 *
 * 测试数据全部是五篇夹具的真实块框，从 OpenDataLoader 的 JSON 产出逐字抄来
 * （`scripts/qa/benchmark/` 的基准数据在仓库外，所以抄进来而不去读）。每个
 * 常量后面的注释标出该页的栏数与页宽，断言直接对着真值写：
 *
 *   - 栏界：三栏两个、双栏一个、单栏与横版零个。零个那条是"单栏不误切"的
 *     保证，比"检出几个"更重要。
 *   - 跨栏识别：三栏的 id=8 与 attention-reading 第 2 页的 id=48 命中，两个
 *     页面里的通栏标题、通栏图注、坐标轴标签全不命中。通栏元素虽宽，但不包
 *     住别人，这是两个判据能分开"合法通栏"与"跨栏合并"的原因。
 *   - 片段几何：与 PyMuPDF 量出的真实矩形片逐项比对。真实值只对三栏那一例
 *     有（PyMuPDF 按文本跨度还原），attention-reading 那例只有栏缘可比。
 *
 * @module tests/node/column-layout
 */

import { describe, expect, it } from "vitest";

import {
  allocateText,
  countSpannedBands,
  detectColumnEdges,
  isColumnSpanningBlock,
  largestYGap,
  splitBlockByColumns,
  type ColumnBox,
} from "../../src/core/pdf/translation/columnLayout";

/** 把 `[x0, y0, x1, y1]` 四元组换成框对象。 */
function boxes(quads: number[][]): ColumnBox[] {
  return quads.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));
}

// ─── 五篇夹具的真实块框 ────────────────────────────────────────────

/**
 * three-column 第 1 页：26 个块，三栏，页宽 595.28。
 *
 * 下标 3 是那个跨栏合并块（OpenDataLoader 的 id=8）：x 42.75–377.58，
 * y 511.58–733.99。它的框是第一栏底部两行与第二栏顶部六行的并集。
 */
const THREE_COLUMN = [
  [156.809, 779.21, 439.43, 796.93], // 通栏标题，宽 282.62
  [221.92, 760.47, 374.32, 770.44],
  [258.15, 747.19, 338.08, 756.04],
  [42.75, 511.58, 377.58, 733.99], // ← 跨栏合并块，宽 334.83
  [42.75, 713.76, 135.69, 724.83],
  [42.75, 626.33, 201.66, 706.99],
  [218.67, 612.83, 377.58, 658.24],
  [42.75, 561.83, 201.65, 619.24],
  [218.67, 590.01, 310.77, 601.08],
  [218.67, 526.58, 377.57, 583.24],
  [42.75, 539.01, 115.31, 550.08],
  [394.59, 665.33, 553.5, 733.99],
  [394.59, 642.51, 456.81, 653.58],
  [394.59, 567.08, 553.5, 635.74],
  [394.59, 514.58, 553.5, 559.24],
  [153.75, 458.87, 159.75, 465.52],
  [362.25, 470.12, 398.75, 485.77],
  [153.75, 432.62, 159.75, 439.27],
  [156.75, 410.12, 159.75, 416.77],
  [168.16, 401.87, 443.83, 408.52], // 通栏坐标轴标签，宽 275.66
  [42.75, 365.55, 553.5, 384.35], // 通栏图注，宽 510.75
  [42.75, 337.26, 97.75, 348.33],
  [42.75, 273.83, 201.65, 330.49],
  [218.67, 300.83, 377.58, 357.49],
  [394.59, 346.26, 448.18, 357.33],
  [394.59, 294.83, 553.5, 339.49],
];
const THREE_COLUMN_MERGED_FONT_SIZE = 8.497;

/**
 * attention-reading 第 2 页：11 个块，双栏，页宽 595.28。
 *
 * 下标 0 是跨栏合并块（OpenDataLoader 的 id=48）：x 45.00–549.73，
 * y 538.37–789.63，几何上完整包住同页另外 10 个块。这一页块少，且第一栏各块
 * 的右界参差不齐（216.73、223.99、284.62），是栏界估计最容易跑偏的一页。
 */
const ATTENTION_PAGE_2 = [
  [45.0, 538.37, 549.73, 789.63], // ← 跨栏合并块，宽 504.73
  [123.75, 774.62, 216.73, 781.27],
  [310.13, 737.54, 377.95, 749.72],
  [310.13, 650.12, 549.74, 728.88],
  [115.91, 702.62, 223.99, 709.27],
  [45.0, 653.44, 284.62, 685.55],
  [45.0, 625.8, 105.49, 637.97],
  [310.13, 622.05, 361.21, 634.22],
  [310.13, 592.65, 549.73, 613.73],
  [310.13, 566.4, 549.74, 587.48],
  [310.13, 539.4, 549.73, 560.48],
];
const ATTENTION_MERGED_FONT_SIZE = 9.495;

/** attention-reading 第 1 页：27 个块，双栏，页宽 595.28。块多，无跨栏合并块。 */
const ATTENTION_PAGE_1 = [
  [71.87, 750.5, 522.87, 790.31], // 通栏标题，宽 451.00
  [205.6, 728.87, 389.14, 739.38],
  [178.31, 711.83, 416.42, 721.24],
  [45.0, 609.02, 284.61, 695.26],
  [45.0, 577.52, 284.61, 600.01],
  [45.0, 550.05, 115.67, 562.22],
  [45.0, 461.87, 284.61, 541.39],
  [45.0, 386.88, 284.61, 452.89],
  [45.0, 359.55, 96.92, 371.73],
  [45.0, 336.63, 106.72, 347.14],
  [45.0, 263.88, 284.61, 329.14],
  [45.0, 240.63, 157.03, 251.14],
  [45.0, 154.38, 284.61, 233.89],
  [310.13, 686.44, 488.59, 695.3],
  [315.32, 597.9, 544.42, 677.48],
  [310.13, 521.87, 549.74, 587.89],
  [310.13, 494.55, 355.33, 506.72],
  [310.13, 392.88, 549.74, 485.89],
  [350.99, 334.38, 356.99, 341.03],
  [459.74, 353.88, 478.19, 369.53],
  [350.99, 308.13, 356.99, 314.78],
  [353.99, 285.63, 356.99, 292.28],
  [366.91, 278.13, 501.57, 284.78],
  [310.13, 229.7, 549.74, 261.81],
  [310.13, 153.63, 549.74, 218.89],
  [369.12, 130.32, 490.74, 143.15],
  [310.13, 80.88, 549.74, 120.65],
];

/** formula-dense 第 1 页：26 个块，双栏，页宽 595.28。无跨栏合并块。 */
const FORMULA_DENSE = [
  [52.3, 750.49, 542.44, 790.31], // 通栏标题，宽 490.14
  [219.87, 728.87, 374.87, 739.38],
  [207.22, 711.83, 387.51, 721.24],
  [45.0, 634.52, 284.61, 695.26],
  [45.0, 607.04, 82.88, 619.22],
  [45.0, 527.12, 284.62, 598.38],
  [98.91, 500.3, 284.61, 516.35],
  [45.0, 439.37, 284.61, 491.13],
  [110.86, 415.12, 284.61, 428.58],
  [45.0, 388.04, 85.92, 400.22],
  [45.0, 327.62, 284.61, 379.38],
  [91.1, 301.55, 284.61, 317.6],
  [45.0, 239.87, 284.61, 291.63],
  [45.0, 213.27, 181.75, 225.57],
  [45.0, 77.87, 284.61, 198.63],
  [310.14, 602.12, 549.75, 695.13],
  [310.14, 575.52, 488.27, 587.83],
  [310.14, 453.62, 549.75, 560.13],
  [310.14, 362.87, 549.75, 443.88],
  [310.14, 335.54, 434.83, 347.72],
  [310.14, 260.87, 549.75, 326.88],
  [352.51, 234.8, 549.75, 250.84],
  [310.14, 173.12, 549.75, 224.88],
  [310.14, 145.79, 361.21, 157.97],
  [310.14, 116.4, 549.74, 137.47],
  [310.14, 89.4, 549.75, 110.47],
];

/**
 * reading-brain：两页，单栏，页宽 595.28。
 *
 * 这一篇是"单栏不误切"的主要证据：所有块的 x0 都是 73.50，横向投影没有空隙。
 */
const READING_BRAIN_PAGE_1 = [
  [73.5, 751.56, 257.7, 772.6],
  [73.5, 725.54, 214.57, 737.72],
  [73.5, 689.32, 118.15, 702.61],
  [73.5, 631.79, 522.0, 677.72],
  [73.5, 589.79, 522.0, 619.22],
  [73.5, 555.82, 150.63, 569.11],
  [73.5, 498.29, 522.0, 544.22],
  [73.5, 455.54, 521.99, 484.97],
  [73.5, 421.57, 130.17, 434.86],
  [73.5, 346.79, 522.0, 410.72],
  [73.5, 312.82, 122.84, 326.11],
  [73.5, 272.54, 522.0, 301.97],
  [73.5, 230.54, 521.99, 259.22],
  [73.5, 196.57, 139.52, 209.86],
  [73.5, 138.29, 522.0, 184.97],
];
const READING_BRAIN_PAGE_2 = [
  [73.5, 742.57, 147.52, 755.86],
  [73.5, 701.54, 521.99, 730.97],
  [73.5, 659.54, 522.0, 688.97],
];

/**
 * landscape-slides：两页，单栏横版，页宽 841.89。
 *
 * 横版幻灯片是最容易误切的一类：段落接近满页宽，块与块之间只剩很小的横向
 * 空隙。这一篇要求一条栏界都不检出。
 */
const LANDSCAPE_PAGE_1 = [
  [113.58, 526.45, 727.91, 555.49], // 通栏标题，宽 614.34
  [186.68, 499.21, 654.81, 513.73],
  [55.75, 451.53, 124.94, 468.29],
  [55.75, 414.13, 767.13, 442.16], // 通栏正文，宽 711.39
  [45.0, 363.03, 132.5, 379.79],
  [63.0, 302.38, 443.73, 353.66],
  [45.0, 267.78, 151.65, 284.54],
  [45.0, 230.38, 784.56, 258.41], // 通栏正文，宽 739.56
  [182.24, 189.28, 189.75, 196.82],
  [182.24, 163.03, 189.75, 170.57],
  [182.24, 133.03, 189.75, 140.57],
  [185.99, 106.78, 189.74, 114.32],
  [228.55, 97.78, 518.44, 105.32],
  [564.75, 157.03, 587.39, 179.57],
  [68.0, 64.95, 773.49, 75.56], // 通栏图注，宽 705.48
];
const LANDSCAPE_PAGE_2 = [
  [45.0, 536.28, 148.35, 553.04],
  [45.0, 498.88, 761.51, 526.91],
];

// ─── 栏检测 ────────────────────────────────────────────────────────

describe("detectColumnEdges — 五篇夹具的期望输出", () => {
  it("三栏得两个界，落在两处栏间空白的中点", () => {
    // 真实栏间空白是 201.66–218.67 与 377.58–394.59，中点 210.17 与 386.09。
    // 覆盖计数按整磅离散化，得 210 与 386，误差在半磅以内。
    expect(detectColumnEdges(boxes(THREE_COLUMN), 595.28)).toEqual([210, 386]);
  });

  it("双栏得一个界，两页一致", () => {
    // 真实栏间空白 284.61–310.13，中点 297.37。
    expect(detectColumnEdges(boxes(ATTENTION_PAGE_1), 595.28)).toEqual([297.5]);
    expect(detectColumnEdges(boxes(ATTENTION_PAGE_2), 595.28)).toEqual([297.5]);
    expect(detectColumnEdges(boxes(FORMULA_DENSE), 595.28)).toEqual([297.5]);
  });

  it("单栏两页都零界——这是不误切的保证", () => {
    // reading-brain 所有块同左缘 73.5，横向投影没有空隙。
    expect(detectColumnEdges(boxes(READING_BRAIN_PAGE_1), 595.28)).toEqual([]);
    expect(detectColumnEdges(boxes(READING_BRAIN_PAGE_2), 595.28)).toEqual([]);
  });

  it("横版幻灯片两页都零界——满页宽的段落之间不切", () => {
    expect(detectColumnEdges(boxes(LANDSCAPE_PAGE_1), 841.89)).toEqual([]);
    expect(detectColumnEdges(boxes(LANDSCAPE_PAGE_2), 841.89)).toEqual([]);
  });

  it("通栏元素缝不住栏间空白", () => {
    // 三栏那页有图注（宽 510.75）、通栏标题（282.62）、坐标轴标签（275.66）
    // 三样横跨整页的东西，布尔投影会一条界都找不到。按覆盖计数仍得两个界。
    // 它们并不都与页边对齐（标题左缘 156.81、标签左缘 168.16），所以按
    // "宽度超过页宽四成"来数，不按 x0/x1 是否等于页边。
    const wide = boxes(THREE_COLUMN).filter((b) => b.x1 - b.x0 > 595.28 * 0.4);
    // 四个：三个通栏元素，外加那个跨栏合并块（334.83）。后者同样横跨整页，
    // 一样会把栏间空白缝起来。
    expect(wide).toHaveLength(4);
    expect(detectColumnEdges(boxes(THREE_COLUMN), 595.28)).toHaveLength(2);
  });

  it("输入不足两块或页宽非正时返回空", () => {
    const one = boxes([[10, 10, 100, 20]]);
    expect(detectColumnEdges(one, 595.28)).toEqual([]);
    expect(detectColumnEdges(boxes(THREE_COLUMN), 0)).toEqual([]);
  });
});

// ─── 跨栏合并块识别 ────────────────────────────────────────────────

describe("isColumnSpanningBlock — 命中合并块，不命中通栏元素", () => {
  const threeColumnBoxes = boxes(THREE_COLUMN);
  const threeColumnEdges = detectColumnEdges(threeColumnBoxes, 595.28);

  it("三栏的 id=8 命中", () => {
    const merged = threeColumnBoxes[3];
    expect(isColumnSpanningBlock(merged, threeColumnBoxes, threeColumnEdges, 0)).toBe(true);
  });

  it("attention-reading 第 2 页的 id=48 命中", () => {
    const page2 = boxes(ATTENTION_PAGE_2);
    const edges = detectColumnEdges(page2, 595.28);
    expect(isColumnSpanningBlock(page2[0], page2, edges, 0)).toBe(true);
  });

  it("三栏页其余 25 个块全不命中——通栏标题与图注也在内", () => {
    const falsePositives: number[] = [];
    threeColumnBoxes.forEach((box, i) => {
      if (i === 3) return;
      if (isColumnSpanningBlock(box, threeColumnBoxes, threeColumnEdges, 0)) {
        falsePositives.push(i);
      }
    });
    expect(falsePositives).toEqual([]);
  });

  it("attention-reading 第 1 页 27 个块全不命中", () => {
    const page1 = boxes(ATTENTION_PAGE_1);
    const edges = detectColumnEdges(page1, 595.28);
    const falsePositives: number[] = [];
    page1.forEach((box, i) => {
      if (isColumnSpanningBlock(box, page1, edges, 0)) falsePositives.push(i);
    });
    expect(falsePositives).toEqual([]);
  });

  it("判据一：完整包含至少三个兄弟块即算，不靠宽度", () => {
    // 宽度判据分不清"合法通栏元素"与"跨栏合并"——通栏标题虽宽，但不包住别人。
    const wideButClean = { x0: 0, y0: 0, x1: 500, y1: 10 };
    const siblings = [wideButClean, { x0: 0, y0: 20, x1: 100, y1: 30 }];
    expect(isColumnSpanningBlock(wideButClean, siblings, [], 0)).toBe(false);
  });

  it("判据二：跨两个栏带且高度超过字号 18 倍才算——通栏元素被高度挡住", () => {
    const edges = [300];
    // 高 200 = 字号 10 的 20 倍，跨两个栏带 → 命中。
    const tallSpanning = { x0: 0, y0: 0, x1: 500, y1: 200 };
    expect(isColumnSpanningBlock(tallSpanning, [tallSpanning], edges, 10)).toBe(true);
    // 同样宽度但只有一行高（字号 10 的 1.8 倍）→ 通栏标题，不命中。
    const shortWide = { x0: 0, y0: 0, x1: 500, y1: 18 };
    expect(isColumnSpanningBlock(shortWide, [shortWide], edges, 10)).toBe(false);
    // 字号取不到（0）时判据二整体失效，不猜。
    expect(isColumnSpanningBlock(tallSpanning, [tallSpanning], edges, 0)).toBe(false);
  });

  it("没有栏界时判据二不生效", () => {
    const tall = { x0: 0, y0: 0, x1: 500, y1: 200 };
    expect(isColumnSpanningBlock(tall, [tall], [], 10)).toBe(false);
  });
});

// ─── 按栏切分 ──────────────────────────────────────────────────────

describe("splitBlockByColumns — 片段几何对着真值", () => {
  it("三栏的合并块切成两个片段，x 边界与 y 边界都命中真实矩形片", () => {
    const siblings = boxes(THREE_COLUMN);
    const edges = detectColumnEdges(siblings, 595.28);
    const fragments = splitBlockByColumns(siblings[3], siblings, edges, THREE_COLUMN_MERGED_FONT_SIZE);

    expect(fragments).toHaveLength(2);
    const [first, second] = fragments;

    // 真实矩形片由 PyMuPDF 按文本跨度还原：第一栏底部两行
    // x 42.75–201.66、y 511.58–532.24，第二栏顶部六行
    // x 218.67–377.58、y 665.33–733.99。
    expect(first.x0).toBeCloseTo(42.75, 2);
    expect(first.x1).toBeCloseTo(201.66, 2);
    expect(first.y0).toBeCloseTo(511.58, 2);
    // 收缩量 0.8 × 8.497 = 6.80，真实上界 532.24。
    expect(first.y1).toBeCloseTo(532.21, 1);

    expect(second.x0).toBeCloseTo(218.67, 2);
    expect(second.x1).toBeCloseTo(377.58, 2);
    // 真实下界 665.33，估到 665.04，偏低 0.29——偏低只会让片段比内容矮一点，
    // 渲染端重新折行，不会压到邻居。
    expect(second.y0).toBeCloseTo(665.04, 1);
    expect(second.y1).toBeCloseTo(733.99, 2);
  });

  it("片段边界都取栏带内兄弟块的极值，不取栏界本身", () => {
    // 栏界是栏间空白的中点（297.5），落在空白里。真实栏缘是第一栏块的右界
    // 284.62 与第二栏块的左界 310.13。按栏界切会让片段 1 向右伸进第二栏
    // 十二磅多。
    const siblings = boxes(ATTENTION_PAGE_2);
    const edges = detectColumnEdges(siblings, 595.28);
    const fragments = splitBlockByColumns(siblings[0], siblings, edges, ATTENTION_MERGED_FONT_SIZE);

    expect(fragments).toHaveLength(2);
    expect(fragments[0].x0).toBeCloseTo(45.0, 2);
    expect(fragments[0].x1).toBeCloseTo(284.62, 2);
    expect(fragments[1].x0).toBeCloseTo(310.13, 2);
    expect(fragments[1].x1).toBeCloseTo(549.73, 2);
  });

  it("片段不压到同栏任何兄弟块", () => {
    // 这是收缩那一步的目的：不收缩的话三栏那两处会各盖住邻段第一行（实测
    // 侵入 321.81 与 149.12 平方磅）。逐对检查片段与同栏兄弟块是否相交。
    for (const [quads, mergedIndex, fontSize] of [
      [THREE_COLUMN, 3, THREE_COLUMN_MERGED_FONT_SIZE],
      [ATTENTION_PAGE_2, 0, ATTENTION_MERGED_FONT_SIZE],
    ] as const) {
      const siblings = boxes(quads);
      const edges = detectColumnEdges(siblings, 595.28);
      const fragments = splitBlockByColumns(
        siblings[mergedIndex],
        siblings,
        edges,
        fontSize,
      );
      expect(fragments.length).toBeGreaterThan(0);
      for (const f of fragments) {
        siblings.forEach((s, i) => {
          if (i === mergedIndex) return;
          const overlap =
            Math.max(0, Math.min(f.x1, s.x1) - Math.max(f.x0, s.x0)) *
            Math.max(0, Math.min(f.y1, s.y1) - Math.max(f.y0, s.y0));
          expect(overlap, `片段 y ${f.y0.toFixed(2)}–${f.y1.toFixed(2)} 压到块 ${i}`)
            .toBeLessThanOrEqual(0);
        });
      }
    }
  });

  it("没有栏界时原样返回，不切", () => {
    const siblings = boxes(READING_BRAIN_PAGE_1);
    const fragments = splitBlockByColumns(siblings[3], siblings, [], 10);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].x0).toBeCloseTo(73.5, 6);
    expect(fragments[0].x1).toBeCloseTo(522.0, 6);
  });

  it("字号取不到时不收缩，退回纯空隙", () => {
    // 宁可盖住邻段一点，也不要凭一个猜出来的字号把内容切掉。
    const siblings = boxes(THREE_COLUMN);
    const edges = detectColumnEdges(siblings, 595.28);
    const unshrunk = splitBlockByColumns(siblings[3], siblings, edges, 0);
    // 空隙上界是邻段标题的上界 539.01，不收缩时片段一直顶到那里。
    expect(unshrunk[0].y1).toBeCloseTo(539.01, 2);
    expect(unshrunk[1].y0).toBeCloseTo(658.24, 2);
  });

  it("每个片段的带宽都不小于一个字符宽，且覆盖原块的 x 范围", () => {
    const siblings = boxes(THREE_COLUMN);
    const edges = detectColumnEdges(siblings, 595.28);
    const merged = siblings[3];
    const fragments = splitBlockByColumns(merged, siblings, edges, THREE_COLUMN_MERGED_FONT_SIZE);
    for (const f of fragments) {
      expect(f.x1 - f.x0).toBeGreaterThan(1);
      expect(f.x0).toBeGreaterThanOrEqual(merged.x0 - 1e-6);
      expect(f.x1).toBeLessThanOrEqual(merged.x1 + 1e-6);
    }
  });
});

// ─── 文本分配 ──────────────────────────────────────────────────────

describe("allocateText — 按面积容量切词切片", () => {
  const fragments = [
    { x0: 0, y0: 0, x1: 100, y1: 20, bandStart: -Infinity, bandEnd: 300 },
    { x0: 300, y0: 0, x1: 400, y1: 70, bandStart: 300, bandEnd: Infinity },
  ];

  it("一个片段时原样返回", () => {
    expect(allocateText("hello world", [fragments[0]])).toEqual(["hello world"]);
  });

  it("所有切片拼起来一个字都不丢", () => {
    const text = "Tide height was recorded every fifteen minutes for six weeks and more";
    const slices = allocateText(text, fragments);
    expect(slices).toHaveLength(2);
    expect(slices.join(" ").split(/\s+/).sort()).toEqual(text.split(/\s+/).sort());
  });

  it("词切片不切断单词", () => {
    const words = "alpha beta gamma delta epsilon zeta eta theta".split(" ");
    const text = words.join(" ");
    const slices = allocateText(text, fragments);
    for (const slice of slices) {
      for (const token of slice.split(/\s+/)) {
        expect(words).toContain(token);
      }
    }
  });

  it("片段容量大的分到的词更多", () => {
    // 第二个片段面积 100×70，第一个 100×20，前者应是后者的 3.5 倍。
    const words = Array.from({ length: 45 }, (_, i) => `w${i}`);
    const slices = allocateText(words.join(" "), fragments);
    expect(slices[1].split(/\s+/).length).toBeGreaterThan(slices[0].split(/\s+/).length);
  });

  it("每个片段至少拿到一个词，最后一个吃掉剩余部分", () => {
    const many = Array.from({ length: 4 }, (_, i) => `t${i}`);
    const slices = allocateText(many.join(" "), fragments);
    expect(slices[0].split(/\s+/).length).toBeGreaterThanOrEqual(1);
    expect(slices[1].split(/\s+/).length).toBeGreaterThanOrEqual(1);
    expect(slices.map((s) => s.split(/\s+/).length).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("空文本给每个片段一个空串", () => {
    expect(allocateText("   ", fragments)).toEqual(["", ""]);
  });
});

// ─── 辅助函数 ──────────────────────────────────────────────────────

describe("largestYGap — 兄弟块未占用的最大空隙", () => {
  it("取最大那段，不是第一段", () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const gap = largestYGap(box, [
      { x0: 0, y0: 20, x1: 100, y1: 30 }, // 上方留 20
      { x0: 0, y0: 80, x1: 100, y1: 90 }, // 中间 30–80 留 50
    ]);
    expect(gap).not.toBeNull();
    expect(gap!.y0).toBeCloseTo(30, 6);
    expect(gap!.y1).toBeCloseTo(80, 6);
  });

  it("完全不重叠的兄弟块被忽略", () => {
    const box = { x0: 0, y0: 10, x1: 100, y1: 20 };
    const gap = largestYGap(box, [{ x0: 0, y0: 200, x1: 100, y1: 300 }]);
    expect(gap).not.toBeNull();
    expect(gap!.y0).toBeCloseTo(10, 6);
    expect(gap!.y1).toBeCloseTo(20, 6);
  });

  it("被兄弟块填满时返回 null", () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(largestYGap(box, [{ x0: 0, y0: 0, x1: 100, y1: 100 }])).toBeNull();
  });

  it("不足一磅的空隙算没有", () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const gap = largestYGap(box, [
      { x0: 0, y0: 0.5, x1: 100, y1: 100 }, // 上方只留 0.5
    ]);
    expect(gap).toBeNull();
  });

  it("y0 大于 y1 的输入按归一化处理", () => {
    const box = { x0: 0, y0: 100, x1: 100, y1: 0 };
    const gap = largestYGap(box, [{ x0: 0, y0: 40, x1: 100, y1: 60 }]);
    expect(gap).not.toBeNull();
    expect(gap!.y0).toBeCloseTo(0, 6);
    expect(gap!.y1).toBeCloseTo(40, 6);
  });
});

describe("countSpannedBands — 块的 x 范围跨过几个栏带", () => {
  it("三栏的合并块只跨前两个带——第三栏从 394.59 起，它够不到", () => {
    expect(countSpannedBands({ x0: 42.75, y0: 0, x1: 377.58, y1: 10 }, [210, 386])).toBe(2);
  });

  it("真正横跨三栏的块跨三个带", () => {
    // 三栏那页的通栏图注：x 42.75–553.50，把三栏全盖住。
    expect(countSpannedBands({ x0: 42.75, y0: 0, x1: 553.5, y1: 10 }, [210, 386])).toBe(3);
  });

  it("单栏块跨一个带", () => {
    expect(countSpannedBands({ x0: 42.75, y0: 0, x1: 201.66, y1: 10 }, [210, 386])).toBe(1);
    expect(countSpannedBands({ x0: 394.59, y0: 0, x1: 553.5, y1: 10 }, [210, 386])).toBe(1);
  });

  it("没有栏界时任何块都只跨一个带", () => {
    expect(countSpannedBands({ x0: 0, y0: 0, x1: 500, y1: 10 }, [])).toBe(1);
  });

  it("边界正好压在栏界上不算跨过去", () => {
    expect(countSpannedBands({ x0: 0, y0: 0, x1: 210, y1: 10 }, [210])).toBe(1);
  });
});
