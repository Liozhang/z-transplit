/**
 * pdfPageProbe 纯变换测试（src/core/pdf/scan/pdfPageProbe.ts）。
 *
 * pixelBoxToPdfBox 把侧车位图上的像素框换算成 PDF 用户空间边界框，是
 * OCR 装配的唯一坐标入口：缩放基准用位图实际尺寸而不是 dpi 乘法（渲染
 * 尺寸会取整），y 轴必须翻转（位图原点左上，PDF 原点左下）。换算错了
 * 译文会整页镜像或偏移，本文件钉住这两种失败模式。
 */
import { describe, it, expect } from "vitest";
import {
  emptyAnalysisFromProbe,
  pixelBoxToPdfBox,
} from "../../../../../src/core/pdf/scan/pdfPageProbe";

// A4 @200dpi：595.28pt × 841.89pt → 1653.6 × 2338.6 px（取整后按实际尺寸缩放）
const RENDER = { width: 1654, height: 2339 };
const PAGE_PT = { width: 595.28, height: 841.89 };

describe("pixelBoxToPdfBox", () => {
  it("整页框换算后铺满整页", () => {
    const b = pixelBoxToPdfBox({ x0: 0, y0: 0, x1: RENDER.width, y1: RENDER.height }, RENDER, PAGE_PT);
    expect(b.x).toBeCloseTo(0, 5);
    expect(b.y).toBeCloseTo(0, 5);
    expect(b.width).toBeCloseTo(PAGE_PT.width, 1);
    expect(b.height).toBeCloseTo(PAGE_PT.height, 1);
  });

  it("y 轴翻转：位图顶部对应 PDF 高 y", () => {
    // 位图顶部 100px 的一条 → PDF 中贴近页面顶部的框（y 接近页高）。
    const b = pixelBoxToPdfBox({ x0: 0, y0: 0, x1: 100, y1: 100 }, RENDER, PAGE_PT);
    expect(b.y).toBeGreaterThan(PAGE_PT.height * 0.9);
    expect(b.height).toBeCloseTo((100 / RENDER.height) * PAGE_PT.height, 5);
  });

  it("位图底部对应 PDF 低 y", () => {
    const b = pixelBoxToPdfBox(
      { x0: 0, y0: RENDER.height - 50, x1: 50, y1: RENDER.height },
      RENDER,
      PAGE_PT,
    );
    expect(b.y).toBeLessThan(50 * (PAGE_PT.height / RENDER.height) + 0.01);
  });

  it("无序输入框（x1<x0）自动归一", () => {
    const b = pixelBoxToPdfBox({ x0: 200, y0: 300, x1: 100, y1: 200 }, RENDER, PAGE_PT);
    const b2 = pixelBoxToPdfBox({ x0: 100, y0: 200, x1: 200, y1: 300 }, RENDER, PAGE_PT);
    expect(b).toEqual(b2);
  });

  it("渲染尺寸与 dpi 乘法不一致时以实际尺寸为基准（取整鲁棒）", () => {
    // 声称 200dpi 但位图实际只有 1600px 宽：比例必须来自实际尺寸。
    const b = pixelBoxToPdfBox({ x0: 0, y0: 0, x1: 1600, y1: 100 }, { width: 1600, height: 2262 }, PAGE_PT);
    expect(b.width).toBeCloseTo(PAGE_PT.width, 5);
  });

  it("零尺寸位图不退化为 NaN（除零保护）", () => {
    const b = pixelBoxToPdfBox({ x0: 0, y0: 0, x1: 10, y1: 10 }, { width: 0, height: 0 }, PAGE_PT);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(Number.isFinite(b.width)).toBe(true);
  });
});

describe("emptyAnalysisFromProbe", () => {
  it("按探针结果建每页空文本的占位分析（纯扫描件兜底）", () => {
    const analysis = emptyAnalysisFromProbe([
      { pageNumber: 1, textLength: 0, widthPt: 595.28, heightPt: 841.89 },
      { pageNumber: 2, textLength: 0, widthPt: 612, heightPt: 792 },
    ]);
    expect(analysis.pages).toHaveLength(2);
    expect(analysis.totalPages).toBe(2);
    expect(analysis.pages[0].textBlocks).toEqual([]);
    expect(analysis.pages[1].width).toBe(612);
    // 每页无文本 → 分类层会把全部页判成 scanned，交给 OCR 管线
    expect(analysis.pages.every((p) => p.textBlocks.length === 0)).toBe(true);
  });

  it("尺寸缺失的页退回美制信纸（不产 0 尺寸页）", () => {
    const analysis = emptyAnalysisFromProbe([
      { pageNumber: 1, textLength: 0, widthPt: 0, heightPt: 0 },
    ]);
    expect(analysis.pages[0].width).toBe(612);
    expect(analysis.pages[0].height).toBe(792);
  });

  it("空探针返回空分析", () => {
    const analysis = emptyAnalysisFromProbe([]);
    expect(analysis.pages).toEqual([]);
    expect(analysis.totalPages).toBe(0);
  });
});
