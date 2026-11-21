/**
 * rotation-transform — 旋转页的坐标变换，用真实旋转 PDF 量出来的数字钉住。
 *
 * 为什么单立一个文件：`LayoutPreservingRenderer` 对 `/Rotate` 非 0 的页**整体
 * 拒绝渲染**（抛 render-error-rotated-page）。拒绝的理由写在代码注释里——"正确
 * 的变换需要一份真实的旋转 PDF 来验证，而我们没有"。于是那份变换
 * （`applyRotation` 与 `ImageCompositor.rotateBBox`）一直是**凭公式写的、从未
 * 被真实数据验过**。
 *
 * 本文件补上那份数据。做法：把 reading-brain 用 pymupdf 设成 /Rotate 90、180、
 * 270 各存一份（MediaBox 不变，只有 /Rotate 变），让解析器各跑一遍，按文本
 * （"Reading and the Brain"）把同一段在四种旋转下的边界框配起来。未旋转那一份
 * 的边界框就是该段在 **MediaBox 原始空间**里的真实位置——另外三份的变换结果
 * 必须与它重合。
 *
 * 实测结论：**180 是对的，90 与 270 的公式互换了。** 这不是推测，是拿真实数据
 * 算出来的——按现有 90 公式变换，边界框的 y 变成负数（-177.6），整段画到页面
 * 之外。这正是当年选择"拒绝"时担心会发生的事：他们知道公式可能不对，于是宁可
 * 报错也不画错。而现在有了数据，可以把公式修对。
 *
 * 坐标口径（都用真实数据核过）：
 *   - 解析器报的是**显示空间**（应用 /Rotate 之后读者看到的空间）；
 *   - pdf-lib 的 drawText / drawRectangle 画在 **MediaBox 原始空间**（未旋转）；
 *   - pdf-lib 的 `page.getWidth()` 返回的是**未旋转**的 MediaBox 宽高，旋转页
 *     上也是（实测 rot90/180/270 全是 594.96 × 841.92），所以变换公式里的
 *     pageW/pageH 就是 MediaBox 的原始尺寸，不随旋转变。
 *
 * @module tests/node/rotation-transform
 */

import { describe, expect, it } from "vitest";

import { applyRotation } from "../../src/core/pdf/translation/LayoutPreservingRenderer";
import { rotateBBox } from "../../src/core/pdf/translation/ImageCompositor";

/** reading-brain 的 MediaBox（A4 纵向，未旋转）。 */
const PAGE_W = 594.96;
const PAGE_H = 841.92;

/**
 * 标题段 "Reading and the Brain" 在四种旋转下的边界框，解析器报的显示空间坐标。
 *
 * 来源：reading-brain.pdf 与它设了 /Rotate 90 / 180 / 270 的三个副本，各跑一遍
 * OpenDataLoader（参数与产品一致），按文本配对取出。rot0 那一行同时就是该段在
 * MediaBox 原始空间里的真实位置——另外三行的变换结果必须与它重合到 0.5 磅内。
 */
const TITLE_BOX = {
  rot0: [73.5, 751.561, 257.705, 772.599],
  rot90: [751.561, 337.255, 772.599, 521.46],
  rot180: [337.255, 69.321, 521.46, 90.359],
  rot270: [69.321, 73.5, 90.359, 257.705],
} as const;

/** 造一个只带几何的段落（变换只碰 x0/y0/x1/y1/x/y）。 */
function para(box: readonly [number, number, number, number]) {
  return {
    x0: box[0],
    y0: box[1],
    x1: box[2],
    y1: box[3],
    x: box[0],
    y: box[1],
    size: 10,
    brk: false,
  } as never;
}

/** 变换结果与 rot0（真实原始空间位置）比对。 */
function expectMatchesRawSpace(
  angle: 90 | 180 | 270,
  out: { x0: number; y0: number; x1: number; y1: number },
): void {
  const [rx0, ry0, rx1, ry1] = TITLE_BOX.rot0;
  expect(out.x0, `rot${angle} x0`).toBeCloseTo(rx0, 1);
  expect(out.y0, `rot${angle} y0`).toBeCloseTo(ry0, 1);
  expect(out.x1, `rot${angle} x1`).toBeCloseTo(rx1, 1);
  expect(out.y1, `rot${angle} y1`).toBeCloseTo(ry1, 1);
  // 顺带断言落在页内：负坐标或超出 MediaBox 都说明变换反了。
  expect(out.x0).toBeGreaterThanOrEqual(0);
  expect(out.y0).toBeGreaterThanOrEqual(0);
  expect(out.x1).toBeLessThanOrEqual(PAGE_W);
  expect(out.y1).toBeLessThanOrEqual(PAGE_H);
}

describe("applyRotation — 用真实旋转 PDF 量出的坐标", () => {
  it("rot0 是恒等变换", () => {
    const out = applyRotation(para(TITLE_BOX.rot0), 0, PAGE_W, PAGE_H);
    expect(out.x0).toBeCloseTo(TITLE_BOX.rot0[0], 6);
    expect(out.y1).toBeCloseTo(TITLE_BOX.rot0[3], 6);
  });

  it("rot90 变换后与真实原始空间位置重合", () => {
    const out = applyRotation(para(TITLE_BOX.rot90), 90, PAGE_W, PAGE_H);
    expectMatchesRawSpace(90, out);
  });

  it("rot180 变换后与真实原始空间位置重合", () => {
    const out = applyRotation(para(TITLE_BOX.rot180), 180, PAGE_W, PAGE_H);
    expectMatchesRawSpace(180, out);
  });

  it("rot270 变换后与真实原始空间位置重合", () => {
    const out = applyRotation(para(TITLE_BOX.rot270), 270, PAGE_W, PAGE_H);
    expectMatchesRawSpace(270, out);
  });

  it("90 与 270 不是同一个公式（这正是当年写反的地方）", () => {
    // 注意不能拿"同一个框按 90 与 270 变换结果不同"来断言——正确的两个变换
    // 会把各自不同的显示框映到同一个原始框，结果本来就该接近。要钉住的是公式
    // 本身不同：喂同一个显示框，90 与 270 必须给出不同答案。
    // 当年那个 bug 的形态正是 90 用了 270 的公式、270 用了 90 的公式。
    const same = para(TITLE_BOX.rot90);
    const a = applyRotation(same, 90, PAGE_W, PAGE_H);
    const b = applyRotation(same, 270, PAGE_W, PAGE_H);
    expect(a.x0).not.toBeCloseTo(b.x0, 1);
    expect(a.y0).not.toBeCloseTo(b.y0, 1);
  });
});

describe("rotateBBox — 与 applyRotation 同一套变换", () => {
  it("rot90 的图区边界框同样变换到真实原始空间", () => {
    const [x0, y0, x1, y1] = TITLE_BOX.rot90;
    const out = rotateBBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, 90, PAGE_W, PAGE_H);
    const [rx0, ry0, rx1, ry1] = TITLE_BOX.rot0;
    expect(out.x).toBeCloseTo(rx0, 1);
    expect(out.y).toBeCloseTo(ry0, 1);
    expect(out.x + out.width).toBeCloseTo(rx1, 1);
    expect(out.y + out.height).toBeCloseTo(ry1, 1);
  });

  it("rot270 的图区边界框同样变换到真实原始空间", () => {
    const [x0, y0, x1, y1] = TITLE_BOX.rot270;
    const out = rotateBBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, 270, PAGE_W, PAGE_H);
    const [rx0, ry0, rx1, ry1] = TITLE_BOX.rot0;
    expect(out.x).toBeCloseTo(rx0, 1);
    expect(out.y).toBeCloseTo(ry0, 1);
    expect(out.x + out.width).toBeCloseTo(rx1, 1);
    expect(out.y + out.height).toBeCloseTo(ry1, 1);
  });
});
