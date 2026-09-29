/**
 * figureTextFilter — 图片区域文字排除的纯函数测试。
 *
 * parseFigureRegionLines：解析删除器 --inspect 的输出（容忍注释、空行、
 * CRLF、坏行）；excludeFigureTextBlocks：中心点包含判定、页码匹配、
 * 页级包装护栏（面积 ≥ 85% 页面的表单不作为图片区域）、原地过滤计数。
 */
import { describe, expect, it } from "vitest";

import {
  excludeFigureTextBlocks,
  parseFigureRegionLines,
} from "../../src/core/pdf/translation/figureTextFilter";

function block(
  x: number,
  y: number,
  width = 40,
  height = 10,
  text = "label",
) {
  return { text, bbox: { x, y, width, height }, fontSize: 9, fontName: "F", hasEOL: true };
}

function page(
  pageNumber: number,
  textBlocks: any[],
  width = 612,
  height = 792,
) {
  return { pageNumber, width, height, textBlocks };
}

describe("parseFigureRegionLines", () => {
  it("解析标准行并归一化对角坐标", () => {
    const regions = parseFigureRegionLines("1 300.00 420.00 545.11 567.54\n");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ page: 1, x0: 300, y0: 420, x1: 545.11, y1: 567.54 });
  });

  it("容忍注释、空行、CRLF 与多空格分隔", () => {
    const text = "# header\r\n\r\n2   60.5   634   273.3   719\r\n4 50 173 286 715\n";
    const regions = parseFigureRegionLines(text);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual({ page: 2, x0: 60.5, y0: 634, x1: 273.3, y1: 719 });
    expect(regions[1].page).toBe(4);
  });

  it("跳过坏行与非正数页码", () => {
    expect(parseFigureRegionLines("abc\n1 1 2 3\n0 1 2 3 4\n-1 1 2 3 4")).toHaveLength(0);
    expect(parseFigureRegionLines("1 1 2 3 4 5 6")).toHaveLength(1);
  });
});

describe("excludeFigureTextBlocks", () => {
  it("移除中心落在区域内的段落，保留区域外的段落", () => {
    const pages = [
      page(1, [
        block(320, 500), // 中心 (340, 505) 在区域内
        block(320, 400), // 中心 (340, 405) 在区域外
      ]),
    ];
    const regions = [{ page: 1, x0: 308, y0: 489, x1: 546, y1: 568 }];
    const removed = excludeFigureTextBlocks(pages, regions);
    expect(removed).toBe(1);
    expect(pages[0].textBlocks).toHaveLength(1);
    expect(pages[0].textBlocks[0].bbox.y).toBe(400);
  });

  it("骑边小块按中心判定：中心在框内移除，中心在框外保留", () => {
    const pages = [
      page(1, [
        block(300, 480, 20, 20), // 中心 (310, 490) 在框内
        block(540, 560, 20, 20), // 中心 (550, 570) 超出右上角，在框外
      ]),
    ];
    const regions = [{ page: 1, x0: 308, y0: 489, x1: 546, y1: 568 }];
    const removed = excludeFigureTextBlocks(pages, regions);
    expect(removed).toBe(1);
    expect(pages[0].textBlocks[0].bbox.x).toBe(540);
  });

  it("页码不匹配的区域不影响其他页", () => {
    const pages = [page(2, [block(100, 100)])];
    const regions = [{ page: 1, x0: 0, y0: 0, x1: 612, y1: 791 }];
    expect(excludeFigureTextBlocks(pages, regions)).toBe(0);
    expect(pages[0].textBlocks).toHaveLength(1);
  });

  it("面积达到页面 85% 的区域按页级包装处理，不排除任何段落", () => {
    const pages = [page(1, [block(100, 100)])];
    // 612×792 的 85% ≈ 400 464；这里取整页的 90%
    const regions = [{ page: 1, x0: 0, y0: 0, x1: 612, y1: 712.8 }];
    expect(excludeFigureTextBlocks(pages, regions)).toBe(0);
    expect(pages[0].textBlocks).toHaveLength(1);
  });

  it("空区域列表直接返回 0 且不改动页面", () => {
    const pages = [page(1, [block(100, 100)])];
    expect(excludeFigureTextBlocks(pages, [])).toBe(0);
    expect(pages[0].textBlocks).toHaveLength(1);
  });
});
