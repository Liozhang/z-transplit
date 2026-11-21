/**
 * odlToAssembly — Adapt an OpenDataLoader `PdfDocumentAnalysis` into the
 * parallel-array `AssemblyResult` shape that `LayoutPreservingRenderer` and
 * `translateParagraphs` consume.
 *
 * Why this exists: OpenDataLoader's JSON output already
 * carries per-paragraph `bbox + fontSize + text` in the SAME coordinate
 * space the renderer expects (PDF user space, origin bottom-left, y up,
 * points) — so the assembler can be skipped entirely and the renderer handed a
 * pre-sliced `AssemblyResult` derived directly from ODL's text blocks.
 *
 * Coordinate mapping (no flip/scale needed — verified against
 * `OpenDataLoaderJsonAdapter.toBBox` and `LayoutPreservingRenderer`):
 *   ODL bbox  {x, y, width, height}  (x=left, y=bottom)
 *   → Paragraph.x0 = x
 *     Paragraph.x1 = x + width
 *     Paragraph.y0 = y            (paragraph bbox lower edge)
 *     Paragraph.y1 = y + height   (paragraph bbox upper edge)
 *     Paragraph.y  = y            (matches the assembler setting
 *                                  p.y = child.y0, i.e. the baseline region)
 *     Paragraph.size = textBlock.fontSize
 *     Paragraph.x = x, brk = false (required by type; renderer ignores both)
 *
 * Images: when the jar is run with `--image-output embedded`, every embedded
 * raster image is emitted as an `image` element with bbox + base64 data URI.
 * The translate adapter forces this mode, so figures ARE recovered and mapped
 * onto `AssemblyResult.images` for the renderer to composite back. (Vector
 * charts are still captured as text structure, not images — those are not
 * recoverable as raster.) When no images are present, `images` is absent and
 * the renderer produces text-only output.
 *
 * Ported from leadero's src/core/pdf/translation/odlToAssembly.ts. The only
 * import change is `../PdfIR`, which was ported alongside (same path).
 *
 * @module core/pdf/translation/odlToAssembly
 */

import type { PdfDocumentAnalysis, PdfPageAnalysis } from "../PdfIR";
import type {
  AssemblyResult,
  Paragraph,
  PlacedImage,
} from "./translationIR";
import { parseFontStyle, parseTextColor } from "./fontStyleParser";
import { pickBackgroundColor, type FillRect } from "./backgroundFill";
import {
  allocateText,
  detectColumnEdges,
  isColumnSpanningBlock,
  splitBlockByColumns,
} from "./columnLayout";

/** Per-page page geometry, returned alongside the per-page assemblies. */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * A paragraph flagged as formula-bearing, for vision-model LaTeX extraction.
 * `paragraphIndex` is the position within the page's `assembly.paragraphs` /
 * `assembly.texts` (so the adapter can splice the LaTeX back in). `bbox` is the
 * crop rectangle in PDF user space (y-up), and `pageNumber` is 1-indexed for
 * the rasterizer.
 *
 * `latex` is set when the block is a NATIVE formula region (OCR sidecar: the
 * block's text IS the LaTeX). The orchestrator then skips the crop + vision
 * model entirely and splices the text straight through — the screenshot path
 * still runs for visual preservation. Absent = heuristic flag (ODL path), where
 * the LaTeX has to be extracted from a crop.
 *
 * `latexStatus` records where the LaTeX came from, so the orchestrator can
 * decide whether a screenshot is still needed:
 *   native      — OCR sidecar, text is already LaTeX
 *   extracted   — vision model returned usable LaTeX
 *   failed      — vision model was tried and failed (crop exists, keep it)
 *   unavailable — no vision model configured (crop may not exist)
 */
export interface FormulaBlock {
  pageNumber: number;
  paragraphIndex: number;
  bbox: { x: number; y: number; width: number; height: number };
  originalText: string;
  latex?: string;
  latexStatus?: "native" | "extracted" | "failed" | "unavailable";
}

export interface OdlAssemblyOutput {
  /** One `AssemblyResult` per page, in page order. */
  assemblies: AssemblyResult[];
  /** Matching per-page geometry, same length as `assemblies`. */
  pageSizes: PageSize[];
  /** Formula-bearing paragraphs across all pages (for VLM LaTeX extraction). */
  formulaBlocks: FormulaBlock[];
}

/**
 * Convert a full ODL `PdfDocumentAnalysis` into per-page `AssemblyResult`s.
 *
 * Empty/whitespace text blocks are skipped (they produce no renderable
 * paragraph and would waste a translation call). Degenerate font sizes
 * (<=0, which ODL sometimes emits for spacing runs) are clamped to 1 so the
 * renderer's `Math.max(size, height)` doesn't collapse.
 *
 * Pure function — safe to unit-test in Node without JVM/Zotero.
 */
/**
 * 装配的可选增强输入。
 *
 * 全部可选，缺省时装配行为与加上这些字段之前完全一致——这样既有的二十多处
 * 调用点一个都不用改。
 */
export interface AssemblyOptions {
  /**
   * 每页的矩形背景填充，来自 backgroundFill.collectFillRects。给了它，段落
   * 就带上 `backgroundColor`，渲染端的遮罩不再一律涂白，而是用段落所在区域
   * 的真实背景色——否则彩色标注框、表格斑马纹会被打穿。
   *
   * 传空数组或不传都等于"没有背景信息"，遮罩退回白色，即加上该字段之前的
   * 行为。数组长度与页数不一致时按页号取，取不到就当没有。
   */
  backgroundFills?: FillRect[][];
}

export function odlAnalysisToAssembly(
  analysis: PdfDocumentAnalysis,
  options: AssemblyOptions = {},
): OdlAssemblyOutput {
  const assemblies: AssemblyResult[] = [];
  const pageSizes: PageSize[] = [];
  const formulaBlocks: FormulaBlock[] = [];

  analysis.pages.forEach((page, idx) => {
    const built = pageAnalysisToAssembly(page, idx + 1, options.backgroundFills?.[idx]);
    assemblies.push(built.assembly);
    pageSizes.push(built.pageSize);
    formulaBlocks.push(...built.formulaBlocks);
  });

  return { assemblies, pageSizes, formulaBlocks };
}

/**
 * 单页装配。按页导出供扫描管线路由用：OCR 页各自装配后替换掉 ODL 给出
 * 的空装配，两路产出在主管线里按页序合并。
 */
export function pageAnalysisToAssembly(
  page: PdfPageAnalysis,
  pageNumber: number,
  backgroundFills?: FillRect[],
): {
  assembly: AssemblyResult;
  pageSize: PageSize;
  formulaBlocks: FormulaBlock[];
} {
  const paragraphs: Paragraph[] = [];
  const texts: string[] = [];
  const formulaBlocks: FormulaBlock[] = [];

  // ── 第一遍：把块展开成条目 ──
  // 多栏文档里解析器会把跨栏流式排版并成一个块，它的边界框是多个矩形片的并集。
  // 这样的块必须先按栏带切开，否则遮罩会涂白邻栏、折行宽度是真实栏宽的两倍、
  // 删除清单吞掉邻段。切开之后每个片段成为一个独立条目，后续一律按条目处理。
  const pageWidth = page.width > 0 ? page.width : 612;
  const allBoxes = page.textBlocks
    .filter((b) => (b.text || "").trim())
    .map((b) => ({
      x0: b.bbox.x,
      y0: b.bbox.y,
      x1: b.bbox.x + (b.bbox.width > 0 ? b.bbox.width : 1),
      y1: b.bbox.y + Math.max(b.bbox.height, b.fontSize > 4 ? b.fontSize : 10),
    }));
  const edges = detectColumnEdges(allBoxes, pageWidth);

  interface Entry {
    /** 该条目的文本（跨栏块是切片，其余是整段）。 */
    text: string;
    /** 标记公式子区间之后的文本，送翻译用这个。 */
    marked: string;
    box: { x: number; y: number; width: number; height: number };
    size: number;
    /**
     * 解析器报的原始字号，未经回退。`size` 是渲染用的（0 或异常小的值被回退成
     * 10），这个留着供需要真值的调用方参考——装配层自己的遮罩收缩与折行估算
     * 一律用 `size`。
     */
    sourceFontSize: number;
    isFormula: boolean;
    /** ODL 折进字体名与文字颜色里的样式，原样带到段落上。 */
    bold?: boolean;
    italic?: boolean;
    color?: { r: number; g: number; b: number };
  }
  const entries: Entry[] = [];

  for (const block of page.textBlocks) {
    const text = (block.text || "").trim();
    // Skip spacing-only / empty runs — they would render nothing and waste a
    // translation request. ODL marks these with hasEOL but we re-check text.
    if (!text) continue;

    const { x, y, width, height } = block.bbox;
    // Clamp degenerate font sizes. The previous clamp (`>0 ? :1`) mapped ODL's
    // spacing runs (fontSize=0) to 1pt, producing invisible text and wasting a
    // translation call. A 1pt glyph is unreadable anyway; fall back to a
    // legible 10pt so even malformed inputs render something usable.
    const size = block.fontSize > 4 ? block.fontSize : 10;
    // Guard against zero-area boxes (would make wrap width collapse to the
    // renderer's `Math.max(10, x1 - x0)` floor — harmless, but keep it real).
    const w = width > 0 ? width : 1;

    // Detect element-level rotated text (vertical sidebar / margin note).
    // ODL reports these as a bbox whose WIDTH ≈ one font size (because the
    // rotated text's visual width is a single glyph) and whose HEIGHT is many
    // times the font size (because the whole rotated line stack becomes the
    // vertical extent). The renderer only supports horizontal text, so drawing
    // into such a narrow box produces a tall column of one-char-per-line that
    // overflows into the body text. We skip these — leaving the original
    // rotated text untouched is far better than a garbled translation column.
    // Verified precise on real fixtures: a.json's sidebar (w=5.455≈fontSize
    // 5.455, h=605.6) is caught; b.json's 174 short paragraphs (single chars /
    // short titles where h≈fontSize, not h>5×fontSize) are NOT caught.
    const isRotated =
      Math.abs(w - size) < 2 && height > size * 5 && text.length > 20;
    if (isRotated) continue;

    const box = { x0: x, y0: y, x1: x + w, y1: y + Math.max(height, size) };
    // Recover source styling that ODL folds into the font name + textColor.
    // Both are optional; when absent the renderer keeps legacy behaviour.
    // `block.bold` is the explicit style channel for backends that know the
    // weight directly (OCR sidecar marks titles) instead of encoding it in a
    // font name.
    const style = parseFontStyle(block.fontName);
    const bold = style.bold || block.bold === true;
    const color = parseTextColor(block.textColor);
    const styling = {
      ...(bold ? { bold: true as const } : {}),
      ...(style.italic ? { italic: true as const } : {}),
      ...(color ? { color } : {}),
    };

    if (isColumnSpanningBlock(box, allBoxes, edges, block.fontSize)) {
      // 跨栏合并块：按栏带切开，文本按各片段的面积容量分配。词切片按空白边界
      // 切，不切断单词；最后一个片段吃掉剩余部分，一个字都不丢。
      // 字号用来把片段两端从邻段边界收回一个栏内留白，见 columnLayout 的
      // INNER_MARGIN_RATIO。传已回退的 size，不用原始 block.fontSize——后者
      // 对 ODL 的间距跑次可能是 0，会让收缩量变成 0，等于没修。
      const fragments = splitBlockByColumns(box, allBoxes, edges, size);
      const slices = allocateText(text, fragments);
      fragments.forEach((fragment, i) => {
        entries.push({
          text: slices[i] ?? "",
          marked: markFormulaSpans(slices[i] ?? ""),
          box: {
            x: fragment.x0,
            y: fragment.y0,
            width: fragment.x1 - fragment.x0,
            height: fragment.y1 - fragment.y0,
          },
          size,
          sourceFontSize: block.fontSize,
          isFormula: block.isFormula === true,
          ...styling,
        });
      });
      continue;
    }

    entries.push({
      text,
      marked: markFormulaSpans(text),
      box: { x, y, width: w, height: Math.max(height, size) },
      size,
      sourceFontSize: block.fontSize,
      isFormula: block.isFormula === true,
      ...styling,
    });
  }

  // ── 第二遍：条目转成装配结构 ──
  let paragraphIndex = 0;
  for (const entry of entries) {
    if (!entry.text) continue;
    const { x, y, width: w, height } = entry.box;
    // 遮罩画的是段落框外扩 1 磅，所以用同一个外扩框去取背景色——颜色才与
    // 实际被涂掉的那块区域一致。
    const background = backgroundFills?.length
      ? pickBackgroundColor(backgroundFills, { x0: x - 1, y0: y - 1, x1: x + w + 1, y1: y + height + 1 })
      : null;

    // Formula detection. Two sources, priority order:
    //   1. 原生公式区域（OCR 侧车的 isFormula 块，文本即 LaTeX）：直接带出，
    //      不跑字符密度启发式——否则 LaTeX 里的 \frac 之类会二次命中，
    //      同一区域被重复标记、重复贴截图。
    //   2. ODL 路径：引擎不产公式，符号（Σ∫√ α β）被折进正文，按字符密度
    //      启发式标记，交给视觉模型裁剪提取。
    if (entry.isFormula) {
      formulaBlocks.push({
        pageNumber,
        paragraphIndex,
        bbox: { x, y, width: w, height },
        originalText: entry.text,
        latex: entry.text,
        latexStatus: "native",
      });
    } else if (isFormulaParagraph(entry.text)) {
      formulaBlocks.push({
        pageNumber,
        paragraphIndex,
        bbox: { x, y, width: w, height },
        originalText: entry.text,
        latexStatus: "unavailable",
      });
    }

    paragraphs.push({
      x0: x,
      x1: x + w,
      y0: y,
      y1: y + height,
      y,
      size: entry.size,
      x,
      brk: false,
      sourceFontSize: entry.sourceFontSize,
      ...(entry.bold ? { bold: true } : {}),
      ...(entry.italic ? { italic: true } : {}),
      ...(entry.color ? { color: entry.color } : {}),
      // 背景色：段落框内面积最大的那个矩形填充。采样在装配外做（要读源 PDF
      // 的内容流），这里只做选取。取不到就不带这个字段，渲染端照旧涂白。
      ...(background
        ? { backgroundColor: background }
        : {}),
    });
    texts.push(entry.marked);
    paragraphIndex++;
  }

  // Tables: SKIP entirely (keep the source table as-is).
  //
  // Previously each non-empty cell was added as a translatable paragraph and
  // the renderer drew a white mask over the cell + translated text. The result
  // was poor: grid lines were broken by the masks, merged cells misaligned,
  // and short data values (often untranslated anyway) rendered out of context.
  // In overlay mode (the default), the source PDF's table is already present
  // in the loaded document, so NOT masking/translating cells leaves the
  // original table fully intact — readers see the source table in the
  // translated PDF and the body text translated around it. This matches the
  // user's confirmed preference.
  //
  // (In white-page fallback mode the table will be absent because it was never
  // added to `paragraphs`; that mode already loses vector content, so this is
  // an acceptable, consistent trade-off.)
  //
  // The loop below is intentionally a no-op; it's kept as a documented marker
  // of where table handling would go if cell-level translation is ever wanted
  // again.
  for (const _table of page.tables) {
    // intentionally skipped
  }

  const images = extractImages(page);

  return {
    assembly: {
      texts,
      paragraphs,
      globalLines: [],
      // Empty by default — the orchestrator fills this with formula region
      // screenshots (rasterized from the reader) for the renderer to paste
      // back at the original bboxes. Initialized here so the renderer can
      // always read `assembly.placedFormulas` without a null-check.
      placedFormulas: [],
      // Only attach `images` when non-empty, so the legacy path (which
      // never sets it) and the common ODL path (no raster images) both
      // produce the same shape the renderer already understands.
      ...(images.length > 0 ? { images } : {}),
    },
    pageSize: {
      width: page.width > 0 ? page.width : 612,
      height: page.height > 0 ? page.height : 792,
    },
    formulaBlocks,
  };
}


/**
 * 公式符号字符类。ODL 把公式折进正文，这些字符是"这段里可能有公式"的锚点。
 *
 * 字符类的缺口曾是漏报的根源：上标数字（²、³）、集合关系符（∈、⊂、∅）、
 * 真减号（U+2212，不是连字符）都不在类里，于是 `a² + b² = c²` 整段判不上
 * 公式，符号被传统机器翻译引擎直接改写成普通数字。补齐之后，判公式的
 * 主力交给"拉丁实词数"这个条件（见 isFormulaParagraph）——字符类只负责
 * 召回，不再负责精确。
 */
const FORMULA_SYMBOLS =
  "αβγδεζηθικλµνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ" +
  "²³ⁿ½⅓¼∈∉⊂⊃⊆⊇∅∪∩∼≃≈≠≡≤≥±∓∞∑∏∐∫∬∭∂∇√∛∜∠⊥∥∀∃∴∵µℓ∆⊗⊕⊙¬∧∨−";

/** 数学函数名。这些名字本身就是公式信号，在自然语言里不作为独立单词出现。 */
const FORMULA_FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp",
  "max", "min", "arg", "mod", "det", "dim", "gcd", "lcm", "sup", "inf",
]);

/** 长度不小于 4 的纯拉丁字母串。`hypothesis`、`estimator` 这类实词。 */
const LATIN_WORD_RE = /[A-Za-z]{4,}/g;

/** 中日韩表意文字。用于挡住"含希腊字母的中文统计正文"被误判成公式。 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

/** 单个字符是否是公式符号。空串必须先挡掉——`includes("")` 恒为真。 */
function isFormulaSymbol(ch: string): boolean {
  return ch.length === 1 && FORMULA_SYMBOLS.includes(ch);
}

/** 一段文本里的公式锚点数：公式符号加数学函数名。 */
function formulaAnchorCount(text: string): number {
  let n = 0;
  for (const ch of text) if (isFormulaSymbol(ch)) n++;
  for (const word of text.match(/[A-Za-z]+/g) || []) {
    if (FORMULA_FUNCTIONS.has(word.toLowerCase())) n++;
  }
  return n;
}

/** 长度不小于 4 的纯拉丁字母实词个数。 */
function countLatinWords(text: string): number {
  return (text.match(LATIN_WORD_RE) || []).length;
}

/**
 * 启发式：一段文字是不是公式区。
 *
 * 两个条件必须同时成立：
 *   1. 公式锚点数不小于 `threshold`（保召回）。短行内式如 `β = 0.05` 有两个
 *      锚点（β 与 =），能过。
 *   2. 这段不像自然语言正文（保精确）：长度不小于 4 的纯拉丁字母实词不超过
 *      一个，且汉字不超过 8 个。公式里出现的是单个字母变量与短函数名，
 *      不会形成实词；而统计正文哪怕只提一个希腊字母，也必然带着成句的
 *      实词。
 *
 * 条件 2 是这一次修复的核心。旧判据只数公式字符的匹配次数，阈值 2，于是一段
 * 普通统计文字只要成串出现希腊字母与不等号就越过阈值——formula-dense 夹具的
 * 三个假阳性（答案键 order 14、18、22）全是这么来的，实测精确率 0.571。
 *
 * Exported for unit testing.
 */
export function isFormulaParagraph(text: string, threshold = 2): boolean {
  if (formulaAnchorCount(text) < threshold) return false;
  if (countLatinWords(text) > 1) return false;
  if ((text.match(CJK_RE) || []).length > 8) return false;
  return true;
}

/**
 * 词元种类。`markFormulaSpans` 靠它决定哪些片段属于公式区间。
 * - `var` 单个拉丁字母，是变量；两个及以上字母若不是函数名就是自然语言单词
 * - `func` 已知数学函数名
 * - `punct` 逗号、分号、句号。它们大多是句子标点，**不是**公式内容，因此
 *   构成区间边界——否则 `limn→∞, sin θ` 会被连成一个公式
 * - `word` 其他拉丁字母串，是公式区间的边界
 * - `other` 汉字与非常规标点，同样是边界
 */
type TokenKind = "symbol" | "number" | "op" | "punct" | "var" | "func" | "word" | "space" | "other";

interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

/**
 * 英语最高频的双字母虚词。它们是正文而不是变量——收进公式区间会让译文把
 * 它们原样保留成英文（"权重 as αi"）。数学里常用的双字母转写（`pi`、`mu`、
 * `xi`、`ti`）刻意不进这张表：它们是变量。
 */
const SHORT_FUNCTION_WORDS = new Set([
  "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
  "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we", "an",
]);

/** 可以被公式区间吸收的词元。空格单独处理（见 collectSpan）。 */
const SPAN_HARD_KINDS = new Set<TokenKind>(["symbol", "number", "op", "var", "func"]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const start = i;
    let kind: TokenKind;
    if (isFormulaSymbol(ch)) {
      i++;
      kind = "symbol";
    } else if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] || ""))) {
      while (i < text.length && /[0-9.]/.test(text[i])) i++;
      kind = "number";
    } else if (/[A-Za-z]/.test(ch)) {
      while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
      const word = text.slice(start, i);
      kind = word.length === 1 ? "var" : FORMULA_FUNCTIONS.has(word.toLowerCase()) ? "func" : "word";
    } else if (ch === " " || ch === "\t") {
      while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
      kind = "space";
    } else if (",;.".includes(ch)) {
      while (i < text.length && ",;.".includes(text[i])) i++;
      kind = "punct";
    } else if ("+-*/=<>|^_()[]{}:".includes(ch)) {
      i++;
      kind = "op";
    } else {
      i++;
      kind = "other";
    }
    tokens.push({ start, end: i, kind });
  }
  return tokens;
}

/**
 * 从锚点词元向左右收集公式区间。
 *
 * 空格只有在两侧都属于公式时才收进来——`θ = 0` 的空格要保留，`we have θ` 的
 * 空格必须成为区间边界，否则整句话会被圈进公式。
 *
 * 长度不超过 2 的字母串若不是虚词，就按双字母变量收进区间——`ti`、`si`、
 * `di` 这类下标变量在 PDF 文本层里常写成两个相连字母。`p(ti | t<x)` 因此
 * 能整块收进来。虚词（`as`、`of`、`to`）不收，否则译文会把它们原样保留成
 * 英文："the latent weight as αi" 只能圈住 `αi`。
 *
 * 区间首尾的空格与句读最后修剪掉。`,` `;` `.` 是句子标点，已由 tokenize 归为
 * `punct` 因而不是公式内容；`:` 仍算公式内容，因为 `A:B` 在数学里是比例。
 */
function collectSpan(
  tokens: Token[],
  anchorIdx: number,
  text: string,
): { from: number; to: number } {
  /** 跳过空格之后，下一个词元是否属于公式内容。 */
  function hardAfterSpace(idx: number): boolean {
    let j = idx + 1;
    while (j < tokens.length && tokens[j].kind === "space") j++;
    return j < tokens.length && SPAN_HARD_KINDS.has(tokens[j].kind);
  }
  /** 公式内部的双字母变量（`ti`、`si`）。后面仍接公式内容才算。 */
  function shortVar(idx: number): boolean {
    const t = tokens[idx];
    if (t.kind !== "word" || t.end - t.start > 2) return false;
    if (SHORT_FUNCTION_WORDS.has(text.slice(t.start, t.end).toLowerCase())) return false;
    return hardAfterSpace(idx);
  }
  function isSentencePunct(t: Token): boolean {
    return t.kind === "punct";
  }

  let from = anchorIdx;
  let to = anchorIdx + 1;
  while (to < tokens.length) {
    const t = tokens[to];
    if (SPAN_HARD_KINDS.has(t.kind) || shortVar(to)) {
      to++;
      continue;
    }
    if (t.kind === "space" && to + 1 < tokens.length &&
        (SPAN_HARD_KINDS.has(tokens[to + 1].kind) || shortVar(to + 1))) {
      to++;
      continue;
    }
    break;
  }
  while (from > 0) {
    const t = tokens[from - 1];
    if (SPAN_HARD_KINDS.has(t.kind) || shortVar(from - 1)) {
      from--;
      continue;
    }
    if (t.kind === "space" && from - 2 >= 0 &&
        (SPAN_HARD_KINDS.has(tokens[from - 2].kind) || shortVar(from - 2))) {
      from--;
      continue;
    }
    break;
  }
  while (to > from && (tokens[to - 1].kind === "space" || isSentencePunct(tokens[to - 1]))) to--;
  while (from < to && (tokens[from].kind === "space" || isSentencePunct(tokens[from]))) from++;
  return { from, to };
}

/**
 * 把一段文字里的公式子串用 `$` 包裹，产出带公式边界的文本。
 *
 * 为什么需要它：ODL 的 textBlock 粒度是整段，一条行内公式和它的引导语落在
 * 同一个块里，旧链路只能整段替换或整段截图，引导语被丢弃。标出子区间之后，
 * 保护层（formulaShield）可以只圈住公式本身，引导语照常翻译。
 *
 * 例：
 *   `Under the null hypothesis we have θ = 0, and χ² ≥ 3.84`
 *   → `Under the null hypothesis we have $θ = 0$, and $χ² ≥ 3.84$`
 *
 * 已经含 `$` 的文本原样返回：OCR 侧车与视觉模型给出的 LaTeX 本来就带
 * `$...$` 边界，再包一层会让保护层的正则失配。
 */
export function markFormulaSpans(text: string): string {
  if (!text || text.includes("$")) return text;
  const tokens = tokenize(text);
  // 先把所有区间按字符位置收齐，再一次拼接。不能边扫描边输出——向左扩展会
  // 越过已经输出的词元（`a²` 的 `a` 在锚点 `²` 之前），那会把它输出两遍，
  // 第一版就犯过这个错：`a² + b² = c²` 产出 `a$a² + b² = c²$`。
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].kind !== "symbol") {
      i++;
      continue;
    }
    const { from, to } = collectSpan(tokens, i, text);
    const start = tokens[from].start;
    const end = tokens[to - 1].end;
    const last = spans[spans.length - 1];
    // 相邻或重叠的公式合成一个区间：`αi = exp(θ si)` 里两个锚点扫的是同一段。
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      spans.push({ start, end });
    }
    i = to;
  }
  if (spans.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const span of spans) {
    out += text.slice(pos, span.start) + "$" + text.slice(span.start, span.end) + "$";
    pos = span.end;
  }
  return out + text.slice(pos);
}

/** 一段文本里被 markFormulaSpans 标出的公式子串个数，供基准统计用。 */
export function countFormulaSpans(text: string): number {
  const marked = markFormulaSpans(text);
  return (marked.match(/\$/g) || []).length / 2;
}

/**
 * Collect raster images that should be composited back onto the page.
 * In the common heuristic-engine case this returns `[]` (charts are vector).
 */
function extractImages(page: PdfPageAnalysis): PlacedImage[] {
  const out: PlacedImage[] = [];
  for (const area of page.chartAreas) {
    if (!area.imageDataUri) continue;
    out.push({
      bbox: {
        x: area.bbox.x,
        y: area.bbox.y,
        width: area.bbox.width,
        height: area.bbox.height,
      },
      dataUri: area.imageDataUri,
    });
  }
  return out;
}
