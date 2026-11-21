/**
 * backgroundFill — 内容流矩形填充采集的单元测试。
 *
 * 为什么单立一个文件：`Paragraph.backgroundColor` 从加进来那天起就没有生产方，
 * 遮罩永远是纯白。已量出后果——横版幻灯片 5 个遮罩打穿一块 12030 平方磅的浅蓝
 * 横幅，attention-reading 17 个遮罩打穿 6952 平方磅的表格表头斑马纹。这批补上
 * 生产方，这批测试锁住它。
 *
 * 测试分四层：
 *   1. 分词器：数字、名字、字面字符串、注释、十六进制字符串、数组开合。
 *   2. 图形状态机：q/Q 嵌套、cm 变换、只有 re 矩形被收而路径填充被忽略。
 *   3. 主导色选取：面积最大、零交集不计入、多色时取占比大的。
 *   4. 端到端：pdf-lib 现场造一个带彩色背景的 PDF，采样结果与画进去的颜色
 *      一致；再对五篇真实夹具跑一遍，横版浅蓝横幅与 attention 表头浅灰都采到。
 *
 * @module tests/node/background-fill
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "url";
import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";

import {
  collectFillRects,
  pickBackgroundColor,
  sampleBackgroundFills,
  type FillRect,
  type FillQuery,
} from "../../src/core/pdf/translation/backgroundFill";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests/node → 仓库根只要两级；tests/node/helpers 下的助手才要三级。
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "scripts", "qa", "fixtures");

function fixtureBytes(name: string): Uint8Array {
  const p = path.join(FIXTURES, `${name}.pdf`);
  if (!fs.existsSync(p)) {
    throw new Error(`夹具缺失：${p}。它是基准的必需输入，缺失说明仓库不完整。`);
  }
  return fs.readFileSync(p);
}

/** 造一个单页 PDF，画给定尺寸的彩色矩形，返回字节。 */
async function pdfWithFill(
  pageW: number,
  pageH: number,
  rects: Array<{ x: number; y: number; w: number; h: number; color: [number, number, number] }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([pageW, pageH]);
  for (const r of rects) {
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      color: rgb(r.color[0], r.color[1], r.color[2]),
    });
  }
  page.drawText("label", {
    x: 10,
    y: 10,
    size: 12,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return doc.save();
}

// ─── 分词器 ────────────────────────────────────────────────────────────

describe("collectFillRects — 分词与解码", () => {
  it("认得出数字、名字、字面字符串与注释", async () => {
    // 注释放中间不该打断后面的操作符；字符串里的空格不该被当成词元边界。
    const bytes = await pdfWithFill(200, 200, [
      { x: 10, y: 20, w: 50, h: 30, color: [0.9, 0.95, 0.97] },
    ]);
    const fills = await collectFillRects(bytes);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toHaveLength(1);
    const f = fills[0][0];
    expect(f.x0).toBeCloseTo(10, 3);
    expect(f.y0).toBeCloseTo(20, 3);
    expect(f.x1).toBeCloseTo(60, 3);
    expect(f.y1).toBeCloseTo(50, 3);
    expect(f.color.r).toBeCloseTo(0.9, 3);
    expect(f.color.g).toBeCloseTo(0.95, 3);
    expect(f.color.b).toBeCloseTo(0.97, 3);
  });

  it("不是 PDF 的字节返回空数组，不抛错", async () => {
    expect(await collectFillRects(new Uint8Array([1, 2, 3, 4, 5]))).toEqual([]);
  });

  it("空字节返回空数组，不抛错", async () => {
    expect(await collectFillRects(new Uint8Array())).toEqual([]);
  });

  it("多页 PDF 每页各自一组，页数一致", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]); // 无填充
    const p2 = doc.addPage([200, 200]);
    p2.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(0.5, 0.5, 0.5) });
    doc.addPage([200, 200]); // 无填充
    const fills = await collectFillRects(await doc.save());
    expect(fills).toHaveLength(3);
    expect(fills[0]).toEqual([]);
    expect(fills[1]).toHaveLength(1);
    expect(fills[2]).toEqual([]);
  });
});

// ─── 图形状态机 ────────────────────────────────────────────────────────

describe("collectFillRects — 图形状态", () => {
  it("多个不同颜色的矩形各自采到，颜色不互相串", async () => {
    // q/Q 的保存恢复在真实夹具上验：三栏与横版都有多层嵌套，横幅与图背景框
    // 的颜色采对了就说明栈没乱。这里只确认不同矩形不会串色。
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawRectangle({ x: 0, y: 200, width: 50, height: 50, color: rgb(0.5, 0.5, 0.5) });
    page.drawRectangle({ x: 60, y: 200, width: 50, height: 50, color: rgb(0.9, 0.95, 0.97) });
    page.drawRectangle({ x: 120, y: 200, width: 50, height: 50, color: rgb(0.62, 0.79, 0.88) });
    const fills = await collectFillRects(await doc.save());
    expect(fills[0]).toHaveLength(3);
    const at = (x: number) => fills[0].find((f) => Math.abs(f.x0 - x) < 0.01);
    expect(at(0)?.color.r).toBeCloseTo(0.5, 3);
    expect(at(60)?.color.b).toBeCloseTo(0.97, 3);
    expect(at(120)?.color.b).toBeCloseTo(0.88, 3);
  });

  it("cm 变换后的矩形落在用户空间", async () => {
    // drawRectangle 的 rotate 会产生 cm。绕 (x, y) 逆时针转 90 度后，宽 50 高 30
    // 的矩形变成宽 30 高 50：x 从 x-h 到 x，y 从 y 到 y+w。若 cm 没被乘进
    // CTM，或者乘反了顺序，这里会量到 50×30。
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawRectangle({
      x: 100,
      y: 10,
      width: 50,
      height: 30,
      color: rgb(0.9, 0.95, 0.97),
      rotate: degrees(90),
    });
    const fills = (await collectFillRects(await doc.save()))[0];
    expect(fills).toHaveLength(1);
    expect(fills[0].x1 - fills[0].x0).toBeCloseTo(30, 1);
    expect(fills[0].y1 - fills[0].y0).toBeCloseTo(50, 1);
    expect(fills[0].x1).toBeCloseTo(100, 1);
    expect(fills[0].y0).toBeCloseTo(10, 1);
  });

  it("只收矩形填充，路径填充被忽略", async () => {
    // pdf-lib 画折线走的是 m/l 路径加 stroke，不是 fill；而 drawRectangle
    // 走 re 加 fill。所以一个只画线的页面应该零填充。
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawLine({
      start: { x: 10, y: 10 },
      end: { x: 290, y: 290 },
      thickness: 2,
      color: rgb(1, 0.5, 0),
    });
    page.drawRectangle({
      x: 0,
      y: 250,
      width: 40,
      height: 40,
      color: rgb(1, 0.5, 0),
      opacity: 1,
    });
    const fills = (await collectFillRects(await doc.save()))[0];
    // 只有那个矩形，折线不收。
    expect(fills).toHaveLength(1);
    expect(fills[0].x1 - fills[0].x0).toBeCloseTo(40, 3);
  });

  it("纯描边（S）不算填充", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawRectangle({
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 1,
    });
    expect((await collectFillRects(await doc.save()))[0]).toEqual([]);
  });
});

// ─── 主导色选取 ────────────────────────────────────────────────────────

describe("pickBackgroundColor — 取框内面积最大的填充色", () => {
  const big: FillRect = { x0: 0, y0: 0, x1: 100, y1: 100, color: { r: 0.9, g: 0.95, b: 0.97 } };
  const small: FillRect = { x0: 0, y0: 0, x1: 10, y1: 10, color: { r: 0.2, g: 0.2, b: 0.2 } };

  it("多色时取占比大的那个", async () => {
    expect(pickBackgroundColor([small, big], { x0: 0, y0: 0, x1: 50, y1: 50 })).toEqual(big.color);
  });

  it("查询框小到只碰到小的那块时取小的", async () => {
    expect(pickBackgroundColor([small, big], { x0: 0, y0: 0, x1: 8, y1: 8 })).toEqual(small.color);
  });

  it("零交集不计入", async () => {
    expect(pickBackgroundColor([big], { x0: 500, y0: 500, x1: 600, y1: 600 })).toBeNull();
  });

  it("只有擦边相交时不计入（交集面积为 0）", async () => {
    expect(pickBackgroundColor([big], { x0: 100, y0: 0, x1: 200, y1: 50 })).toBeNull();
  });

  it("没有填充时返回 null", async () => {
    expect(pickBackgroundColor([], { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
  });

  it("查询框坐标顺序颠倒也能算", async () => {
    expect(pickBackgroundColor([big], { x0: 50, y0: 50, x1: 0, y1: 0 })).toEqual(big.color);
  });
});

// ─── 批量采样 ──────────────────────────────────────────────────────────

describe("sampleBackgroundFills", () => {
  it("按页码取各自的填充，输出与输入等长", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const p2 = doc.addPage([200, 200]);
    p2.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0.9, 0.95, 0.97) });
    const bytes = await doc.save();
    const queries: FillQuery[] = [
      { page: 1, x0: 0, y0: 0, x1: 50, y1: 50 },
      { page: 2, x0: 0, y0: 0, x1: 50, y1: 50 },
      { page: 3, x0: 0, y0: 0, x1: 50, y1: 50 }, // 越界页
    ];
    const out = await sampleBackgroundFills(bytes, queries);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
    expect(out[1]!.b).toBeCloseTo(0.97, 3);
    expect(out[2]).toBeNull();
  });

  it("页码 0 或负值安全返回 null", async () => {
    const bytes = await pdfWithFill(200, 200, [
      { x: 0, y: 0, w: 200, h: 200, color: [0.9, 0.95, 0.97] },
    ]);
    const out = await sampleBackgroundFills(bytes, [
      { page: 0, x0: 0, y0: 0, x1: 10, y1: 10 },
      { page: -1, x0: 0, y0: 0, x1: 10, y1: 10 },
    ]);
    expect(out).toEqual([null, null]);
  });
});

// ─── 真实夹具 ──────────────────────────────────────────────────────────

describe("collectFillRects — 五篇真实夹具", () => {
  it("横版幻灯片的浅蓝横幅被采到，颜色与 PyMuPDF 量的一致", async () => {
    const fills = await collectFillRects(fixtureBytes("landscape-slides"));
    const banner = fills[0].find(
      (f) =>
        Math.abs(f.color.r - 0.933) < 0.01 &&
        Math.abs(f.color.g - 0.949) < 0.01 &&
        Math.abs(f.color.b - 0.973) < 0.01,
    );
    expect(banner).toBeDefined();
    // 横幅通栏：x 45–796.5。PDF 用户空间 y 396.21–479.46（页高 594.96）。
    expect(banner!.x0).toBeCloseTo(45, 0);
    expect(banner!.x1).toBeCloseTo(796.5, 0);
    expect(banner!.y0).toBeGreaterThan(390);
    expect(banner!.y1).toBeLessThan(485);
  });

  it("attention-reading 表头的浅灰斑马纹被采到", async () => {
    const fills = await collectFillRects(fixtureBytes("attention-reading"));
    const grey = fills[0].filter((f) => Math.abs(f.color.r - 0.937) < 0.01);
    // 表头 5 个单元格各一块，横跨整张表：左缘 310.5 到右缘 549.7。
    expect(grey).toHaveLength(5);
    for (const g of grey) {
      expect(g.x0).toBeGreaterThanOrEqual(310);
      expect(g.x1).toBeLessThanOrEqual(550);
      expect(g.y1 - g.y0).toBeCloseTo(18, 0);
    }
    // 五个格子首尾相接，中间没有缝。
    const sorted = [...grey].sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x0).toBeCloseTo(sorted[i - 1].x1, 0);
    }
  });

  it("三栏只采到白色图背景框，192 段橙色折线不收", async () => {
    // 图背景框是 `re` 填充白色；那条橙色折线是 192 段的路径填充，包围盒横跨
    // 大半个图区，收了会把遮罩染成橙色。x 与 y 各只有两个取值这一条把矩形与
    // 折线分开。渲染验证：图区中心像素确实是 (255,255,255)。
    const fills = (await collectFillRects(fixtureBytes("three-column")))[0];
    expect(fills).toHaveLength(1);
    expect(fills[0].color).toEqual({ r: 1, g: 1, b: 1 });
    expect(fills[0].x0).toBeCloseTo(138, 0);
    expect(fills[0].x1).toBeCloseTo(459, 0);
    expect(fills[0].y0).toBeCloseTo(391.9, 0);
    expect(fills[0].y1).toBeCloseTo(502.9, 0);
  });

  it("reading-brain 与 formula-dense 没有可用的矩形背景", async () => {
    // 两篇的彩色区域只有栏间分隔线与表格线，都是细长条，被 MIN_BACKGROUND_EDGE
    // 挡掉——拿 0.7333 的深灰当背景色会把遮罩染成灰，译文不可读。这也解释了
    // 为什么它们不在 mask_punch 的打穿报告里。
    expect((await collectFillRects(fixtureBytes("reading-brain")))[0]).toEqual([]);
    const dense = (await collectFillRects(fixtureBytes("formula-dense")))[0];
    expect(dense).toEqual([]);
  });

  it("细长条填充被护栏挡掉——分隔线不是背景", async () => {
    // formula-dense 的栏线解析出来是用户空间 x 297.0–297.75、y 75.42–696.42，
    // 宽 0.75 磅高 621 磅、颜色 0.7333。它确实在内容流里，但不该当背景色。
    // 挡掉之后那页一个都不剩。
    const dense = await collectFillRects(fixtureBytes("formula-dense"));
    expect(dense[0]).toEqual([]);
    // 再用 pdf-lib 造一条细矩形，确认护栏本身有效，而不是碰巧那页没解出来。
    const bytes = await pdfWithFill(300, 400, [
      { x: 10, y: 10, w: 0.8, h: 300, color: [0.2, 0.2, 0.2] }, // 细长条
      { x: 20, y: 10, w: 100, h: 50, color: [0.9, 0.95, 0.97] }, // 正常背景
    ]);
    const fills = (await collectFillRects(bytes))[0];
    expect(fills).toHaveLength(1);
    expect(fills[0].color.r).toBeCloseTo(0.9, 3);
  });

  it("所有夹具页数一致，没有一页因解析失败而缺", async () => {
    for (const name of ["landscape-slides", "attention-reading", "three-column"]) {
      const fills = await collectFillRects(fixtureBytes(name));
      const expected = name === "attention-reading" ? 2 : name === "landscape-slides" ? 2 : 1;
      expect(fills, name).toHaveLength(expected);
    }
  });
});
