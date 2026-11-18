/**
 * scanDocumentAggregate — 把识别页并回文档级分析（PdfDocumentAnalysis）。
 *
 * 为什么需要：管线此前只用装配数组（assemblies）承载识别页，文档级对象
 * 里扫描页是空白——"这篇文档有哪些文字"这个问题得到的答案是漏的。接入
 * 聚合后，识别页的正文进 filteredText、标题与表格进 filteredMarkdown、
 * 表格/公式/图区进 allXxx 汇总，文档级视图与逐页账目一致。
 *
 * 混合文档的保真规则：数字页的 filteredText/Markdown 不重新从 IR 推导
 * （IR 丢标题层级与列表结构，重推导会让数字页的聚合降级），而是按页界
 * 原样保留，只把被识别页替换掉的位置换成识别页的片段。因此要求底本
 * 带页界记账（OpenDataLoaderJsonAdapter 产出；探针占位与旧缓存没有，
 * 按整篇降级，见 mergeScannedDocument 的分支说明）。
 *
 * 收录规则与数字路径一致（见 OpenDataLoaderJsonAdapter 的收集点）：
 *   - filteredText 只收正文类块（标题/正文/参考文献/脚注/侧栏）；页眉
 *     页脚、页码、边注、图注、公式都不进——公式是 LaTeX，不是行文；
 *   - filteredMarkdown 收标题（识别页无层级信息，统一一级）与正文，表格
 *     走共享的 tableToMarkdown；识别页的表格与文本之间无交错信息，
 *     表格附在本页文本之后。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/scanDocumentAggregate
 */

import type {
  LayoutRole,
  PdfDocumentAnalysis,
  PdfPageAnalysis,
  PdfTable,
} from "../PdfIR";
import { tableToMarkdown } from "../tableMarkdown";

/** 一页的聚合片段（页内按阅读顺序）。 */
export interface PageAggregateParts {
  textParts: string[];
  markdownParts: string[];
}

/** 进 filteredText 的角色（与数字路径的"正文"收集点对齐）。 */
const TEXT_ROLES = new Set<LayoutRole>([
  "title",
  "heading",
  "body",
  "reference-entry",
  "footnote",
  "sidebar",
]);

/**
 * 收集一页的聚合片段。阅读顺序即 textBlocks 顺序（识别页的块按阅读顺序
 * 产出，见 ocrToAnalysis）。角色从 regions 反查：块与角色区一一对应，
 * 反查不到按正文处理（宁可多收，不漏）。
 */
export function pageAnalysisAggregate(page: PdfPageAnalysis): PageAggregateParts {
  const roleByBlock = new Map<PdfPageAnalysis["textBlocks"][number], LayoutRole>();
  for (const region of page.regions) {
    for (const block of region.content ?? []) {
      if (!roleByBlock.has(block)) roleByBlock.set(block, region.role);
    }
  }
  const textParts: string[] = [];
  const markdownParts: string[] = [];
  for (const block of page.textBlocks) {
    // 公式块文本是 LaTeX，不是行文；数字路径的公式同样不进 filteredText。
    if (block.isFormula) continue;
    const text = block.text.trim();
    if (!text) continue;
    const role = roleByBlock.get(block) ?? "body";
    if (!TEXT_ROLES.has(role)) continue;
    textParts.push(text);
    markdownParts.push(role === "heading" ? `# ${text}` : text);
  }
  // 表格只进 Markdown（与数字路径一致：表格文本不进 filteredText）。
  for (const table of page.tables) {
    const md = tableToMarkdown(table);
    if (md) markdownParts.push(md);
  }
  return { textParts, markdownParts };
}

/** 带页界记账的拼接：与 OpenDataLoaderJsonAdapter 的 join("\n\n") 增量一致。 */
function joinWithSpans(
  items: Array<{ pageNumber: number; content: string }>,
): {
  text: string;
  spans: Array<{ pageNumber: number; start: number; end: number }>;
} {
  const spans: Array<{ pageNumber: number; start: number; end: number }> = [];
  const parts: string[] = [];
  let acc = 0;
  for (const item of items) {
    const start = acc === 0 ? 0 : acc + 2;
    acc = start + item.content.length;
    parts.push(item.content);
    spans.push({ pageNumber: item.pageNumber, start, end: acc });
  }
  return { text: parts.join("\n\n"), spans };
}

/** 一侧（纯文本或 Markdown）的合并输入。 */
interface AggregateSide {
  /** 底本全文。 */
  base: string;
  /** 底本的页界；缺失或为空表示"无页界"。 */
  baseSpans?: Array<{ pageNumber: number; start: number; end: number }>;
  /** 被识别页替换后该页的片段；空数组表示该页无内容。 */
  partsByPage: Map<number, string[]>;
}

/**
 * 合并一侧：按页序走底本页界，被替换的页换成识别片段；底本无页界时
 * 退化为"底本全文 + 识别片段附后"，且不再给页界（附后的片段与底本
 * 的页序关系已不可知，给错的页界比不给更糟）。
 */
function mergeSide(side: AggregateSide, totalPages: number): {
  text: string;
  spans?: Array<{ pageNumber: number; start: number; end: number }>;
} {
  const hasParts = [...side.partsByPage.values()].some((p) => p.length > 0);
  if (!side.baseSpans || side.baseSpans.length === 0) {
    if (!side.base) {
      // 底本无文本（探针占位 / 纯扫描）：按页序从识别片段构建。
      const items: Array<{ pageNumber: number; content: string }> = [];
      for (let pn = 1; pn <= totalPages; pn++) {
        const parts = side.partsByPage.get(pn);
        if (parts && parts.length > 0) items.push({ pageNumber: pn, content: parts.join("\n\n") });
      }
      return joinWithSpans(items);
    }
    if (!hasParts) return { text: side.base, spans: side.baseSpans };
    // 旧缓存：底本有文本但无页界。保留底本，识别片段按页序附后。
    const tail: string[] = [];
    for (let pn = 1; pn <= totalPages; pn++) {
      const parts = side.partsByPage.get(pn);
      if (parts && parts.length > 0) tail.push(parts.join("\n\n"));
    }
    const text = tail.length > 0 ? side.base + "\n\n" + tail.join("\n\n") : side.base;
    return { text, spans: undefined };
  }

  const spanByPage = new Map(side.baseSpans.map((s) => [s.pageNumber, s]));
  const items: Array<{ pageNumber: number; content: string }> = [];
  for (let pn = 1; pn <= totalPages; pn++) {
    const parts = side.partsByPage.get(pn);
    if (parts && parts.length > 0) {
      items.push({ pageNumber: pn, content: parts.join("\n\n") });
      continue;
    }
    const span = spanByPage.get(pn);
    // 底本片段原样保留（含空串）——拼接分隔符与底本一致，数字页的聚合
    // 一个字都不变。
    if (span) items.push({ pageNumber: pn, content: side.base.slice(span.start, span.end) });
  }
  // 底本页界可能漏页（无正文的页没有 span）；这些页若被识别出内容，
  // 按页序补进 items（上面的循环已覆盖全部页，这里只需防 baseSpans
  // 超出页码范围的情况）。
  const joined = joinWithSpans(items);
  return { text: joined.text, spans: joined.spans };
}

/**
 * 把识别页并回文档级分析。返回新对象，不改底本（与
 * mergeScannedAssemblies 的非突变约定一致）。
 *
 * 替换规则与装配合并一致：跳过（null）的页保留底本页面——旋转页的跳过
 * 记在扫描账目里，叠加渲染端本就跳过它们；被替换的页整页换成识别产出。
 */
export function mergeScannedDocument(opts: {
  base: PdfDocumentAnalysis;
  ocrAnalyses: Map<number, PdfPageAnalysis | null>;
}): PdfDocumentAnalysis {
  const { base, ocrAnalyses } = opts;
  const pages = base.pages.slice();
  const replacedPages = new Set<number>();
  const textPartsByPage = new Map<number, string[]>();
  const markdownPartsByPage = new Map<number, string[]>();
  for (const [pageNumber, ocrPage] of ocrAnalyses) {
    if (!ocrPage) continue;
    const index = pageNumber - 1;
    if (index < 0 || index >= pages.length) continue; // 范围外的记录不撑数
    pages[index] = ocrPage;
    replacedPages.add(pageNumber);
    const parts = pageAnalysisAggregate(ocrPage);
    textPartsByPage.set(pageNumber, parts.textParts);
    markdownPartsByPage.set(pageNumber, parts.markdownParts);
  }

  // 汇总随页面重算：替换页的表格/公式/图区进 allXxx，被换掉的底本条目
  // 自然消失（页面整页替换，不存在两条并存）。
  const allTables: PdfTable[] = [];
  const allFormulas: PdfDocumentAnalysis["allFormulas"] = [];
  const allChartAreas: PdfDocumentAnalysis["allChartAreas"] = [];
  const allCitations: PdfDocumentAnalysis["allCitations"] = [];
  for (const page of pages) {
    allTables.push(...page.tables);
    allFormulas.push(...page.formulas);
    allChartAreas.push(...page.chartAreas);
    allCitations.push(...page.citations);
  }

  const totalPages = pages.length;
  const text = mergeSide(
    { base: base.filteredText, baseSpans: base.filteredPageSpans, partsByPage: textPartsByPage },
    totalPages,
  );
  const markdown = mergeSide(
    {
      base: base.filteredMarkdown,
      baseSpans: base.filteredMarkdownPageSpans,
      partsByPage: markdownPartsByPage,
    },
    totalPages,
  );

  // 整篇都走识别时，source 才标 scan-sidecar：混合文档的底本仍是 jar 解析，
  // 标 scan-sidecar 会丢掉"这是混合文档"的信息。无生产消费者按此分支，
  // 这个标签只服务于将来的审计与调试。
  const allReplaced = totalPages > 0 && replacedPages.size === totalPages;

  return {
    source: allReplaced ? "scan-sidecar" : base.source,
    totalPages,
    pages,
    allTables,
    allFormulas,
    allChartAreas,
    allCitations,
    filteredText: text.text,
    ...(text.spans ? { filteredPageSpans: text.spans } : {}),
    filteredMarkdown: markdown.text,
    ...(markdown.spans ? { filteredMarkdownPageSpans: markdown.spans } : {}),
    confidence: allReplaced ? 0.8 : base.confidence,
    processingMs: base.processingMs,
  };
}
