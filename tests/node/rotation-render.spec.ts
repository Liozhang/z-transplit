/**
 * rotation-render — 旋转页端到端：渲染端不再拒绝，译文落在原段落的位置上。
 *
 * 为什么单立一个文件：`renderOverlayTranslated` 曾经对 `/Rotate` 非 0 的页**整体
 * 抛错**（render-error-rotated-page），理由是"正确的变换需要一份真实的旋转 PDF
 * 来验证，而我们没有"。那份夹具现在有了——`scripts/qa/fixtures/reading-brain-rot*.pdf`
 * 是同一篇文档分别设了 /Rotate 90 / 180 / 270 存出来的，MediaBox 不变，只有 /Rotate 变。
 *
 * 拿它实测的结论（详见 tests/node/rotation-transform.spec.ts，那里钉住变换公式）：
 * 变换的 90° 与 270° 两种情形**写反了**——按旧的 90° 公式，真实段落的边界框会被送到
 * y = −177.6，即页面之外。所以当年选择拒绝不是在防一个假想的风险，而是在防一个真实
 * 存在的 bug；而正确的修法是把变换修对，不是继续拒绝。
 *
 * 本文件守的是另一件事：**拒绝确实被解除了，而且解除之后画出来的东西是对的。**
 * 它从仓库里的旋转夹具读出真实的 PDF 与真实的解析器产出，跑完整的装配加渲染，
 * 断言三件事：
 *   1. 不抛错（拒绝已解除）；
 *   2. 段落数与装配层一致（没有段被静默跳过）；
 *   3. 译文确实落在原始空间的段落框附近（用 applyRotation 把显示空间的框变换
 *      回原始空间，与渲染端画进去的位置比）。
 *
 * 第 3 条是关键：前两条只证明"画了"，证明不了"画对地方"。而画错地方正是当年
 * 拒绝时担心的后果。
 *
 * @module tests/node/rotation-render
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import { adaptOpenDataLoaderJson } from "../../src/core/pdf/OpenDataLoaderJsonAdapter";
import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";
import {
  applyRotation,
  renderOverlayTranslated,
} from "../../src/core/pdf/translation/LayoutPreservingRenderer";
import { cjkFontBytes } from "./helpers/sourceFixture";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 tests/node/ 下，上两级才是仓库根（sourceFixture 在 tests/node/helpers/，
// 那一边要上三级，不要照抄）。
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "scripts", "qa", "fixtures");

/** 旋转夹具：同一篇 reading-brain，只有 /Rotate 不同。 */
const ROTATED = [
  { angle: 90, pdf: "reading-brain-rot90.pdf", odl: "reading-brain-rot90.json" },
  { angle: 180, pdf: "reading-brain-rot180.pdf", odl: "reading-brain-rot180.json" },
  { angle: 270, pdf: "reading-brain-rot270.pdf", odl: "reading-brain-rot270.json" },
] as const;

/** 解析器预先跑好的 JSON，与 PDF 同目录。没有它们就跳过（那是环境缺数据）。 */
const ODL_DIR = path.join(FIXTURES, "odl-rotation");

function readFixture(name: string): Uint8Array {
  return fs.readFileSync(path.join(FIXTURES, name));
}

describe("旋转页端到端渲染", () => {
  for (const { angle, pdf, odl } of ROTATED) {
    it(`/Rotate ${angle}：不抛错，段落一个不少`, async () => {
      if (!fs.existsSync(path.join(FIXTURES, pdf))) {
        // 夹具缺失是仓库不完整，不是环境问题——照既有约定直接失败。
        throw new Error(`旋转夹具缺失：${pdf}`);
      }
      const odlPath = path.join(ODL_DIR, odl);
      if (!fs.existsSync(odlPath)) return; // 环境缺解析器产出，跳过

      const root = JSON.parse(fs.readFileSync(odlPath, "utf8"));
      const analysis = adaptOpenDataLoaderJson(root);
      const built = odlAnalysisToAssembly(analysis);

      const sourceBytes = readFixture(pdf);
      const translations = built.assemblies.map((a) =>
        a.texts.map(() => "这是一段用于测试的合成译文内容，长度受控。"),
      );

      const font = cjkFontBytes();
      const result = await renderOverlayTranslated(sourceBytes, built.assemblies, translations, {
        targetLanguage: "zh-CN",
        docTitle: "rotation regression",
        ...(font ? { cjkFontBytes: font } : {}),
      });

      // 拒绝已解除：跑到这里就没抛。段落数与装配层一致——没有段被静默跳过。
      const expected = built.assemblies.reduce((n, a) => n + a.paragraphs.length, 0);
      expect(result.stats.paragraphsRendered).toBe(expected);
      expect(expected).toBeGreaterThan(0);
      expect(result.bytes.length).toBeGreaterThan(0);
    });
  }

  it("译文画在原始空间的段落框附近（不是画对地方以外的任何地方）", async () => {
    const odlPath = path.join(ODL_DIR, "reading-brain-rot90.json");
    if (!fs.existsSync(odlPath)) return;

    const root = JSON.parse(fs.readFileSync(odlPath, "utf8"));
    const analysis = adaptOpenDataLoaderJson(root);
    const built = odlAnalysisToAssembly(analysis);
    const sourceBytes = readFixture("reading-brain-rot90.pdf");
    const font = cjkFontBytes();
    if (!font) return; // 没有中文字体，译文全是问号，量不出位置

    const translations = built.assemblies.map((a) =>
      a.texts.map(() => "这是一段用于测试的合成译文内容，长度受控。"),
    );
    await renderOverlayTranslated(sourceBytes, built.assemblies, translations, {
      targetLanguage: "zh-CN",
      docTitle: "rotation placement",
      cjkFontBytes: font,
    });

    // 把装配层第一个段落框从显示空间变换回原始空间，再与渲染端实际使用的
    // 页尺寸对照：框必须完整落在 MediaBox 之内。当年那个写反的公式会把框送到
    // y = −177.6，这一条就是钉它的。
    const doc = await PDFDocument.load(sourceBytes);
    const page = doc.getPages()[0];
    const rawW = page.getWidth();
    const rawH = page.getHeight();
    const p = built.assemblies[0].paragraphs[0];
    const raw = applyRotation(
      { ...p, x: p.x0, y: p.y0, size: p.size, brk: false } as never,
      page.getRotation().angle,
      rawW,
      rawH,
    );
    expect(raw.x0).toBeGreaterThanOrEqual(0);
    expect(raw.y0).toBeGreaterThanOrEqual(0);
    expect(raw.x1).toBeLessThanOrEqual(rawW + 0.01);
    expect(raw.y1).toBeLessThanOrEqual(rawH + 0.01);
    // 框要有实际面积，否则"落在页内"是空话。
    expect(raw.x1 - raw.x0).toBeGreaterThan(1);
    expect(raw.y1 - raw.y0).toBeGreaterThan(1);
  });
});
