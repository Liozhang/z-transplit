/**
 * render-entry — 评测基准的无头渲染驱动。
 *
 * 这个文件是基准与产品代码之间唯一的接触点。它不实现任何排版逻辑，只是把
 * 仓库里真实的装配与渲染函数按评测需要的顺序接起来：
 *
 *   assemble  OpenDataLoader JSON → adaptOpenDataLoaderJson → odlAnalysisToAssembly
 *             产出 assembly.json（段落框、字号、图区、表格区、公式块）
 *   render    assembly.json + 合成译文 → renderOverlayTranslated
 *             产出译文 PDF、RenderResult.stats、原文删除区域清单
 *
 * 为什么要无头跑一遍而不是只靠真机：八个版式修复批次每一批都要回答"修好了
 * 还是修坏了"，真机一轮几分钟且只能人眼看截图。无头路径复现的是同一条装配
 * 与渲染代码，数字可复现，每批都能跑。它与真机的差异（不走适配器、不盖公式
 * 截图的那条取图路径）在 docs/development.md 的评测基准一节里逐条列明。
 *
 * 运行方式不是直接 node 这个文件：src 下的相对导入不带扩展名，Node 的 ESM
 * 解析器不认。由 run.py 先用 esbuild 打成包再执行。因此这里的 import 照仓库
 * 现有风格写即可，不必为 Node 单独改。
 *
 * 用法（由 run.py 调用，不建议手工执行）：
 *   node render-entry.mjs --config config.json
 */

import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { adaptOpenDataLoaderJson } from "../../../src/core/pdf/OpenDataLoaderJsonAdapter";
import { odlAnalysisToAssembly } from "../../../src/core/pdf/translation/odlToAssembly";
import { collectFillRects } from "../../../src/core/pdf/translation/backgroundFill";
import { classifyPages, pageTextStats } from "../../../src/core/pdf/scan/pageClassification";
import type { PageKind } from "../../../src/core/pdf/scan/pageClassification";
import {
  renderOverlayTranslated,
} from "../../../src/core/pdf/translation/LayoutPreservingRenderer";
import {
  buildRemovalRects,
  serializeRemovalRects,
} from "../../../src/core/pdf/translation/removalRects";
import type { AssemblyResult, Paragraph } from "../../../src/core/pdf/translation/translationIR";
import type {
  PdfChartArea,
  PdfDocumentAnalysis,
  PdfPageAnalysis,
  PdfTable,
} from "../../../src/core/pdf/PdfIR";

interface RenderConfig {
  mode: "assemble" | "render";
  /** OpenDataLoader 产出的 JSON 路径。 */
  odl?: string;
  /** 原文 PDF 路径。 */
  source?: string;
  /** assemble 模式的产出 / render 模式的输入之一。 */
  assembly?: string;
  /** render 模式的合并输入：assembly + translations + formulaImages。 */
  renderInput?: string;
  fonts?: {
    cjk?: string;
    bold?: string;
    italic?: string;
    boldItalic?: string;
    latin?: string;
  };
  outPdf?: string;
  outStats?: string;
  outRects?: string;
  targetLanguage?: string;
  docTitle?: string;
}

interface AssemblyPageJson {
  pageNumber: number;
  /** 页面尺寸取自原文 PDF 本身，不是解析器猜的。 */
  width: number;
  height: number;
  /**
   * 段落几何加原文文本。文本跟着段落走，不再单开一个 texts 数组：度量端要按
   * 段落判断"这段有没有译文"，没有文本连空段都分不出来。早先一版把文本放在
   * 页面级的 texts 里，度量读 paragraph.text 拿到空串，把所有段落都当成空段
   * 跳过——交并比恒为 0、未翻译数恒为 0，两个数字一起说谎。
   */
  paragraphs: Array<
    Pick<
      Paragraph,
      | "x"
      | "y"
      | "x0"
      | "x1"
      | "y0"
      | "y1"
      | "size"
      | "brk"
      | "color"
      | "bold"
      | "italic"
      | "sourceFontSize"
      | "backgroundColor"
    > & { text: string }
  >;
  images: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  tables: Array<{ x0: number; y0: number; x1: number; y1: number; rows: number; cols: number }>;
}

interface AssemblyJson {
  pages: AssemblyPageJson[];
  formulaBlocks: Array<{
    pageNumber: number;
    paragraphIndex: number;
    originalText: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
  /**
   * 逐页角色。判据直接用产品自己的 `classifyPages`，不在这里重写一遍——
   * 同一个判断写在两处，其中一处迟早会过期，而过期的那处会静默给出错答案。
   *
   * 为什么无头路径也要分类：产品在 `opendataloaderSplitAdapter` 里按这个结果
   * 把扫描页与劣质文本层页路由给识别侧车，无头路径不跑那段编排，于是扫描页
   * 装配出 0 段、劣质页装配出满页乱码，两种情况都毫无信号。有了这个字段，
   * 度量侧才看得见"这一页本该走 OCR 却走了 ODL"。
   */
  pageRoles: PageRoleJson[];
}

/** 一页的角色与它引出的事实。 */
interface PageRoleJson {
  pageNumber: number;
  kind: PageKind;
  textLength: number;
  blockCount: number;
  saneRatio: number;
  /** 该页装配出的段落数。非数字页的这个数大于 0 就是越权。 */
  paragraphs: number;
}

interface RenderInputJson extends AssemblyJson {
  /** 每页的译文数组，与 assembly.pages[i].paragraphs 逐位对齐。 */
  translations: string[][];
  /** 每页要贴回的公式截图，键是页码（1 起）。 */
  formulaImages: Record<string, Array<{ dataUri: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>>;
}

function fail(message: string): never {
  // 失败必须带着上下文死在 stderr 上。无头驱动最常见的死法是"PDF 打得开、
  // 装配出来了、渲染抛了一句看不懂的"，那时唯一能定位问题的就是这条消息。
  process.stderr.write(`render-entry: ${message}\n`);
  process.exit(1);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`读不了 JSON ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readFont(file: string | undefined): Uint8Array | undefined {
  if (!file) return undefined;
  try {
    // 拷贝一份，不把 Buffer 直接交给 pdf-lib：Buffer 是共享底层 ArrayBuffer
    // 的视图，byteOffset 可能不是 0，pdf-lib 的 instanceof 检查会因此拒收。
    return new Uint8Array(fs.readFileSync(file));
  } catch (e) {
    fail(`读不了字体 ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1), "utf8");
}

/** 图表区与表格区从分析结果里搬进装配视图，供遮罩越界那一项当参照。 */
function regionsOf(page: PdfPageAnalysis): {
  images: AssemblyPageJson["images"];
  tables: AssemblyPageJson["tables"];
} {
  // 装配视图里所有框统一用 x0/y0/x1/y1。图区与表格区在 IR 里是 BBox（x/y/
  // width/height），在这里换算一次，让度量端只认一种形状——混用两种形状的
  // 代价是每个消费方都要写一遍转换，漏一处就炸一个 KeyError。
  const toRect = (box: { x: number; y: number; width: number; height: number }) => ({
    x0: box.x,
    y0: box.y,
    x1: box.x + box.width,
    y1: box.y + box.height,
  });
  const images: AssemblyPageJson["images"] = (page.chartAreas as PdfChartArea[]).map((c) =>
    toRect(c.bbox),
  );
  const tables: AssemblyPageJson["tables"] = (page.tables as PdfTable[]).map((t) => ({
    ...toRect(t.bbox),
    rows: t.rows.length,
    cols: t.rows[0]?.cells.length ?? 0,
  }));
  return { images, tables };
}

async function assemble(config: RenderConfig): Promise<void> {
  const odlPath = config.odl;
  const sourcePath = config.source;
  const outPath = config.assembly;
  if (!odlPath || !outPath) fail("assemble 模式需要 odl 与 assembly 两个路径");
  if (!sourcePath) fail("assemble 模式需要 source（原文 PDF）——页面尺寸从它取");
  const root = readJson(odlPath);
  const analysis: PdfDocumentAnalysis = adaptOpenDataLoaderJson(root);
  // 遮罩配色：从原文 PDF 的内容流取矩形填充，段落带上 background color 之后
  // 遮罩不再一律涂白。采样失败只当没有背景信息，不影响其余装配。
  let backgroundFills: Awaited<ReturnType<typeof collectFillRects>> = [];
  try {
    backgroundFills = await collectFillRects(new Uint8Array(fs.readFileSync(sourcePath)));
  } catch (e) {
    process.stderr.write(`background-fill sampling skipped: ${e}\n`);
  }
  const built = odlAnalysisToAssembly(analysis, { backgroundFills });

  // 页面尺寸一律读原文 PDF。解析器的 JSON 不带 MediaBox，适配器只能猜一个
  // 标准尺寸——猜的是 612×792（Letter），而 A4 夹具实际是 594.96×841.92。
  // 渲染端用的是加载后 PDF 的真实尺寸，所以猜错不影响画在哪；但度量端要靠
  // 页面尺寸把 y 向上换算成位图行号，用猜的值会把整页遮罩算偏，框外像素差异
  // 凭空多出几个百分点。
  const sourceDoc = await PDFDocument.load(new Uint8Array(fs.readFileSync(sourcePath)));
  const sourcePages = sourceDoc.getPages();
  if (sourcePages.length !== built.assemblies.length) {
    fail(
      `页数不一致：原文 PDF ${sourcePages.length} 页，解析器产出 ${built.assemblies.length} 页。`
        + "基准要求两边逐页对齐，否则后面的页面会静默不渲染。",
    );
  }

  const out: AssemblyJson = { pages: [], formulaBlocks: [], pageRoles: [] };
  built.assemblies.forEach((assembly, index) => {
    const page = analysis.pages[index];
    const sourcePage = sourcePages[index];
    const { images, tables } = regionsOf(page);
    out.pages.push({
      pageNumber: index + 1,
      width: sourcePage.getWidth(),
      height: sourcePage.getHeight(),
      paragraphs: assembly.paragraphs.map((p, paragraphIndex) => ({
        x: p.x,
        y: p.y,
        x0: p.x0,
        x1: p.x1,
        y0: p.y0,
        y1: p.y1,
        size: p.size,
        brk: p.brk,
        text: assembly.texts[paragraphIndex] ?? "",
        ...(p.color ? { color: p.color } : {}),
        ...(p.bold !== undefined ? { bold: p.bold } : {}),
        ...(p.italic !== undefined ? { italic: p.italic } : {}),
        ...(p.sourceFontSize !== undefined ? { sourceFontSize: p.sourceFontSize } : {}),
        ...(p.backgroundColor ? { backgroundColor: p.backgroundColor } : {}),
      })),
      images,
      tables,
    });
  });
  out.formulaBlocks = built.formulaBlocks.map((f) => ({
    pageNumber: f.pageNumber,
    paragraphIndex: f.paragraphIndex,
    originalText: f.originalText,
    bbox: { x0: f.bbox.x, y0: f.bbox.y, x1: f.bbox.x + f.bbox.width, y1: f.bbox.y + f.bbox.height },
  }));
  // 页面角色：判据取自产品自己的分类器，输入是同一份 analysis。非数字页的
  // 段落数一并记下——它大于 0 就说明这一页本该走 OCR 却走了 ODL 装配。
  const classification = classifyPages(analysis.pages);
  out.pageRoles = analysis.pages.map((page, index) => {
    const stats = pageTextStats(page);
    return {
      pageNumber: page.pageNumber,
      kind: classification.kinds[index],
      textLength: stats.textLength,
      blockCount: stats.blockCount,
      saneRatio: stats.saneRatio,
      paragraphs: built.assemblies[index]?.paragraphs.length ?? 0,
    };
  });
  writeJson(outPath, out);
  const paragraphCount = out.pages.reduce((n, p) => n + p.paragraphs.length, 0);
  const offRole = out.pageRoles.filter((r) => r.kind !== "digital");
  const offRoleParagraphs = offRole.reduce((n, r) => n + r.paragraphs, 0);
  process.stdout.write(
    `assembled pages=${out.pages.length} paragraphs=${paragraphCount} formulas=${out.formulaBlocks.length}\n`,
  );
  if (offRole.length > 0) {
    // 明确说出来，不混在 assembled 那一行里：扫描页 0 段与劣质页满段乱码是两
    // 种完全不同的情形，前者是"没东西可译"，后者是"把乱码当正文译了"。
    const kinds = offRole.map((r) => `${r.pageNumber}:${r.kind}`).join(" ");
    process.stdout.write(`非数字页 ${offRole.length} 页（${kinds}），其中装配出 ${offRoleParagraphs} 段\n`);
  }
}

function render(config: RenderConfig): void {
  const inputPath = config.renderInput;
  const sourcePath = config.source;
  const outPdf = config.outPdf;
  if (!inputPath || !sourcePath || !outPdf) {
    fail("render 模式需要 renderInput、source 与 outPdf 三个路径");
  }
  const input = readJson(inputPath) as RenderInputJson;
  const sourceBytes = new Uint8Array(fs.readFileSync(sourcePath));

  const assemblies: AssemblyResult[] = input.pages.map((page) => {
    const assembly: AssemblyResult = {
      // texts 与 paragraphs 逐位对齐是 AssemblyResult 的契约。装配视图里文本
      // 跟着段落走，这里按段落顺序还原出 texts 数组。
      texts: page.paragraphs.map((p) => p.text),
      paragraphs: page.paragraphs.map((p) => {
        const { text: _text, ...geometry } = p;
        return { ...geometry };
      }),
      globalLines: [],
    };
    const placed = (input.formulaImages ?? {})[String(page.pageNumber)];
    if (placed && placed.length > 0) {
      assembly.placedFormulas = placed.map((f) => ({
        dataUri: f.dataUri,
        // 渲染器要的是 x/y/width/height，装配视图统一存 x0/y0/x1/y1。
        bbox: {
          x: f.bbox.x0,
          y: f.bbox.y0,
          width: f.bbox.x1 - f.bbox.x0,
          height: f.bbox.y1 - f.bbox.y0,
        },
      }));
    }
    return assembly;
  });

  const fonts = config.fonts ?? {};
  renderOverlayTranslated(sourceBytes, assemblies, input.translations ?? [], {
    targetLanguage: config.targetLanguage ?? "zh-CN",
    docTitle: config.docTitle ?? "Z-Transplit benchmark",
    ...(readFont(fonts.cjk) ? { cjkFontBytes: readFont(fonts.cjk) } : {}),
    ...(readFont(fonts.bold) ? { boldFontBytes: readFont(fonts.bold) } : {}),
    ...(readFont(fonts.italic) ? { italicFontBytes: readFont(fonts.italic) } : {}),
    ...(readFont(fonts.boldItalic) ? { boldItalicFontBytes: readFont(fonts.boldItalic) } : {}),
    ...(readFont(fonts.latin) ? { latinFontBytes: readFont(fonts.latin) } : {}),
  })
    .then((result) => {
      fs.mkdirSync(path.dirname(outPdf), { recursive: true });
      fs.writeFileSync(outPdf, result.bytes);
      if (config.outStats) writeJson(config.outStats, result.stats);
      if (config.outRects) {
        // 删除区域清单走产品自己的函数生成：度量要量的正是"适配器打算删哪些
        // 区域"，不是度量自己猜一份。
        const rects = buildRemovalRects(assemblies, input.translations ?? []);
        fs.mkdirSync(path.dirname(config.outRects), { recursive: true });
        fs.writeFileSync(config.outRects, serializeRemovalRects(rects), "utf8");
      }
      process.stdout.write(
        `rendered bytes=${result.bytes.length} paragraphs=${result.stats.paragraphsRendered} `
          + `overflowed=${result.stats.overflowed} formulasRendered=${result.stats.formulasRendered} `
          + `imagesRendered=${result.stats.imagesRendered} imagesDropped=${result.stats.imagesDropped}\n`,
      );
    })
    .catch((e) => {
      fail(`渲染失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
}

function main(): void {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf("--config");
  if (flagIndex < 0 || !argv[flagIndex + 1]) {
    fail("用法：node render-entry.mjs --config <config.json>");
  }
  const config = readJson(argv[flagIndex + 1]) as RenderConfig;
  // 两条分支都要把拒绝接住：async 函数的未处理拒绝在 Node 22 上是致命错误，
  // 会把真正的失败原因盖成一个没有上下文的 UnhandledPromiseRejection。
  if (config.mode === "assemble") assemble(config).catch((e) => fail(`装配失败：${e}`));
  else if (config.mode === "render") render(config);
  else fail(`未知模式 ${String(config.mode)}，只支持 assemble 与 render`);
}

main();
