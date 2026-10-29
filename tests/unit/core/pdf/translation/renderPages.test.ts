/**
 * renderOverlayTranslated 的 renderPages 选项（页码范围翻译的渲染端契约）。
 *
 * 两条硬约束：
 *   1. 未列出的页面整页跳过——包括旋转检查。旋转页（扫描件、横版插图页）
 *      在范围外时不得让整次翻译失败；
 *   2. 输出 PDF 的页数与页序不变：范围外的页面保持原样留在文档里。
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, degrees, StandardFonts } from "pdf-lib";

import { renderOverlayTranslated } from "../../../../../src/core/pdf/translation/LayoutPreservingRenderer";
import type { AssemblyResult, Paragraph } from "../../../../../src/core/pdf/translation/translationIR";

function paragraph(overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    y: 700,
    x: 72,
    x0: 72,
    x1: 500,
    y0: 700,
    y1: 720,
    size: 12,
    brk: false,
    ...overrides,
  };
}

function assembly(text: string): AssemblyResult {
  return {
    texts: text ? [text] : [],
    paragraphs: text ? [paragraph()] : [],
    formulas: [],
    globalLines: [],
  };
}

async function twoPageSourceWithRotatedSecond(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page0 = doc.addPage([612, 792]);
  page0.drawText("page one", { x: 72, y: 700, size: 12, font });
  const page1 = doc.addPage([612, 792]);
  page1.setRotation(degrees(90));
  page1.drawText("page two", { x: 72, y: 700, size: 12, font });
  return doc.save();
}

describe("renderOverlayTranslated — renderPages（页码范围）", () => {
  it("范围外整页跳过：含旋转页的文档不再失败，页数页序保持", async () => {
    const source = await twoPageSourceWithRotatedSecond();
    const assemblies = [assembly("第一段"), assembly("第二段")];
    // 只有第 1 页（0 基 0）被翻译；第 2 页是旋转页且不在范围内。
    const result = await renderOverlayTranslated(
      source,
      assemblies,
      [["第一段译文"], [""]],
      { targetLanguage: "zh-CN", renderPages: new Set([0]) },
    );

    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(1).getRotation().angle).toBe(90);
  });

  it("未传 renderPages 时维持原行为：旋转页报错", async () => {
    const source = await twoPageSourceWithRotatedSecond();
    await expect(
      renderOverlayTranslated(source, [assembly("a"), assembly("b")], [["甲"], ["乙"]], {
        targetLanguage: "zh-CN",
      }),
    ).rejects.toThrow();
  });

  it("空译文集的页面不盖章也不打遮罩（范围外页面逐字保留）", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText("original", { x: 72, y: 700, size: 12, font });
    const source = await doc.save();

    // 译文集为空数组 + 该页不在 renderPages：什么都不画。
    const result = await renderOverlayTranslated(
      source,
      [assembly("original")],
      [[]],
      { targetLanguage: "zh-CN", renderPages: new Set() },
    );
    // stats 全零 = 没有遮罩、没有译文、没有公式贴图；页数不变（原文保留）。
    expect(result.stats.paragraphsRendered).toBe(0);
    expect(result.stats.formulasDropped).toBe(0);
    expect(result.stats.overflowed).toBe(0);
    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(1);
  });
});
