/**
 * renderOverlayTranslated 的 renderPages 选项（页码范围翻译的渲染端契约）。
 *
 * 两条硬约束：
 *   1. 未列出的页面整页跳过——范围外的页面（含旋转页）不得让整次翻译失败；
 *   2. 输出 PDF 的页数与页序不变：范围外的页面保持原样留在文档里。
 *
 * 范围外的旋转页曾被单独跳过（早于旋转支持），现在旋转页本身也能渲染，见本文件
 * 里"旋转页在范围内时照常渲染"一条与 tests/node/rotation-*.spec.ts。
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

  it("旋转页在范围内时照常渲染，不再报错", async () => {
    // 这一条原本断言的是"旋转页报错"——渲染端当年对 /Rotate 非 0 的页整体拒绝，
    // 理由是"正确的变换需要一份真实的旋转 PDF 来验证，而我们没有"。那份夹具
    // 后来补上了（scripts/qa/fixtures/reading-brain-rot*.pdf），实测发现变换的
    // 90° 与 270° 两种情形写反了，修好之后拒绝随之解除。详见
    // tests/node/rotation-transform.spec.ts 与 rotation-render.spec.ts。
    //
    // 现在守的是新行为：范围内的旋转页照常画，页数与旋转角都不变。
    const source = await twoPageSourceWithRotatedSecond();
    const result = await renderOverlayTranslated(
      source,
      [assembly("a"), assembly("b")],
      [["甲"], ["乙"]],
      { targetLanguage: "zh-CN" },
    );
    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(1).getRotation().angle).toBe(90);
    expect(result.stats.paragraphsRendered).toBe(2);
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
    expect(result.stats.formulasRendered).toBe(0);
    expect(result.stats.overflowed).toBe(0);
    const out = await PDFDocument.load(result.bytes);
    expect(out.getPageCount()).toBe(1);
  });
});
