/**
 * sidecarProtocol — 插件与扫描识别侧车之间的 JSON 契约。
 *
 * 侧车是一个独立进程（默认 python sidecar.py），插件按批调用：
 *   sidecar --pdf <路径> --pages 1-5,7 --out <目录> --dpi 200
 * 侧车在 <目录> 写一个 result.json（本文件定义的 SidecarBatchOutput）。
 * 两条输出流分工：stderr 每行一个 JSON 诊断（进度、单页失败、致命原因），
 * stdout 只放结果行——`--selftest` 成功时的一行 {"selftest":"ok",…}。
 * 契约与引擎无关：换 RapidDoc 或自组 ONNX 都不用改插件侧，只要产出同一份
 * JSON。
 *
 * 退出码：0 全部成功；2 部分成功（JSON 仍含成功页）；1 致命（参数错、PDF
 * 打不开、引擎导入失败、渲染探活失败）。
 *
 * 坐标约定：bbox 为位图像素框（原点左上、y 向下），页面尺寸同时给点
 * （pageSizePt）和位图实际尺寸（renderSizePx）——缩放以实际尺寸为基准，
 * 不信 dpi 乘法（渲染取整会漂）。 rotation 是源页的 /Rotate：非 0 时
 * 侧车不识别（叠加渲染器对旋转页本就拒绝），只回报 skipReason。
 *
 * 纯模块：解析与校验不碰宿主，可在 Node 单测。任何畸形输入都走
 * "返回 null / 记 warning" 的路子，绝不往上层抛异常——一批 300 页里
 * 有一页 JSON 坏了，不能让整批识别成果作废。
 *
 * @module core/pdf/scan/sidecarProtocol
 */

/** 位图像素边界框（原点左上，y 向下）。 */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SidecarTextLine {
  bbox: PixelBox;
  text: string;
  /** 行所属块的编号；同块各行拼成一个段落，编号顺序即阅读顺序。 */
  blockId: number;
  /** 版面模型给的块类型（text / title / figure_caption …），用于样式映射。 */
  blockType?: string;
  /** 识别置信度 0–1，可选。 */
  score?: number;
}

export interface SidecarFormula {
  bbox: PixelBox;
  latex: string;
  isDisplay: boolean;
}

export interface SidecarTable {
  bbox: PixelBox;
  /** 结构还原结果（HTML 表格），可选；缺失时只计区域。 */
  html?: string;
}

export interface SidecarFigure {
  bbox: PixelBox;
}

export interface SidecarPageResult {
  pageNumber: number;
  /** 源页尺寸（PDF 点）。 */
  pageSizePt: { width: number; height: number };
  /** 侧车实际渲染的位图尺寸（像素）。 */
  renderSizePx: { width: number; height: number };
  dpi: number;
  /** 源页 /Rotate（度）。非 0 时侧车不识别。 */
  rotation: number;
  /** 跳过原因（如 "rotated"）；与 noContent 一起表达"这页没有识别产出"。 */
  skipReason?: string;
  /** 这页没有任何可识别内容（空白页或只有不可识别元素）。 */
  noContent?: boolean;
  lines: SidecarTextLine[];
  formulas: SidecarFormula[];
  tables: SidecarTable[];
  figures: SidecarFigure[];
  /** 检出区域面积和占页面比例（0–1，重叠已惩罚），供覆盖率账目用。 */
  coverage: number;
}

export interface SidecarDiagnostics {
  engine?: string;
  engineVersion?: string;
  warnings?: string[];
}

export interface SidecarBatchOutput {
  pages: SidecarPageResult[];
  diagnostics?: SidecarDiagnostics;
}

/** 侧车退出码：全部页面识别成功。 */
export const SIDECAR_EXIT_OK = 0;
/** 侧车退出码：有页面失败但批内其余成果有效（result.json 仍可读）。 */
export const SIDECAR_EXIT_PARTIAL = 2;

export type SidecarRunStatus =
  | "ok"
  | "partial"
  | "failed"
  | "timeout"
  | "aborted"
  | "unconfigured";

export interface SidecarBatchRun {
  status: SidecarRunStatus;
  /** 按页码索引的成功页；缺失的页由账目层记为缺口，不静默丢弃。 */
  pages: Map<number, SidecarPageResult>;
  diagnostics?: SidecarDiagnostics;
  /** 进程 stderr 摘要（错误分类与排障用）。 */
  stderr: string;
  /** 失败时保留的侧车工作目录（供排障）；成功批已清理，为 undefined。 */
  workDir?: string;
}

/**
 * 按 shell 习惯拆分命令行为 argv：支持双引号与单引号（Windows 下
 * "C:\Program Files\Python\python.exe" 这类带空格路径必须加引号）。
 * 纯函数；无法拆分（引号不闭合）时返回 null，由调用方报配置错误。
 */
export function parseCommandLine(cmd: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) return null; // 引号不闭合
  if (hasToken || current) argv.push(current);
  return argv.length > 0 ? argv : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 归一化像素框：无序输入自动交换，钳到有限值。 */
function toPixelBox(raw: unknown): PixelBox | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x0 = num(r.x0, NaN);
  const y0 = num(r.y0, NaN);
  const x1 = num(r.x1, NaN);
  const y1 = num(r.y1, NaN);
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null;
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

/**
 * 解析并校验单页结果。返回 null 表示这一页的 JSON 不可用（缺页码或缺
 * 页面尺寸是硬伤；其余字段尽量容错补默认值）。
 */
export function parseSidecarPageResult(raw: unknown): SidecarPageResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pageNumber = num(r.pageNumber, NaN);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  const size = (r.pageSizePt ?? {}) as Record<string, unknown>;
  const width = num(size.width, 0);
  const height = num(size.height, 0);
  if (!(width > 0 && height > 0)) return null;

  const lines: SidecarTextLine[] = [];
  if (Array.isArray(r.lines)) {
    for (const item of r.lines) {
      if (!item || typeof item !== "object") continue;
      const l = item as Record<string, unknown>;
      const bbox = toPixelBox(l.bbox);
      const text = str(l.text);
      if (!bbox || !text.trim()) continue;
      lines.push({
        bbox,
        text,
        blockId: Math.trunc(num(l.blockId, 0)),
        ...(typeof l.blockType === "string" ? { blockType: l.blockType } : {}),
        ...(typeof l.score === "number" ? { score: l.score } : {}),
      });
    }
  }
  const formulas: SidecarFormula[] = [];
  if (Array.isArray(r.formulas)) {
    for (const item of r.formulas) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const bbox = toPixelBox(f.bbox);
      const latex = str(f.latex);
      if (!bbox || !latex.trim()) continue;
      formulas.push({ bbox, latex, isDisplay: f.isDisplay === true });
    }
  }
  const tables: SidecarTable[] = [];
  if (Array.isArray(r.tables)) {
    for (const item of r.tables) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const bbox = toPixelBox(t.bbox);
      if (!bbox) continue;
      tables.push({ bbox, ...(typeof t.html === "string" ? { html: t.html } : {}) });
    }
  }
  const figures: SidecarFigure[] = [];
  if (Array.isArray(r.figures)) {
    for (const item of r.figures) {
      if (!item || typeof item !== "object") continue;
      const bbox = toPixelBox((item as Record<string, unknown>).bbox);
      if (!bbox) continue;
      figures.push({ bbox });
    }
  }

  const render = (r.renderSizePx ?? {}) as Record<string, unknown>;
  const renderW = num(render.width, 0);
  const renderH = num(render.height, 0);

  return {
    pageNumber,
    pageSizePt: { width, height },
    renderSizePx: {
      width: renderW > 0 ? renderW : Math.round((width * num(r.dpi, 200)) / 72),
      height: renderH > 0 ? renderH : Math.round((height * num(r.dpi, 200)) / 72),
    },
    dpi: num(r.dpi, 200),
    rotation: Math.trunc(num(r.rotation, 0)),
    ...(typeof r.skipReason === "string" ? { skipReason: r.skipReason } : {}),
    ...(r.noContent === true ? { noContent: true } : {}),
    lines,
    formulas,
    tables,
    figures,
    coverage: Math.min(1, Math.max(0, num(r.coverage, 0))),
  };
}

/** 解析一批的 result.json。任何畸形输入返回 null，绝不抛异常。 */
export function parseSidecarBatchOutput(raw: unknown): SidecarBatchOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.pages)) return null;
  const pages: SidecarPageResult[] = [];
  for (const item of r.pages) {
    const page = parseSidecarPageResult(item);
    if (page) pages.push(page);
  }
  const diagnostics: SidecarDiagnostics = {};
  const d = r.diagnostics as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    if (typeof d.engine === "string") diagnostics.engine = d.engine;
    if (typeof d.engineVersion === "string") diagnostics.engineVersion = d.engineVersion;
    if (Array.isArray(d.warnings)) {
      diagnostics.warnings = d.warnings.filter((w): w is string => typeof w === "string");
    }
  }
  return { pages, diagnostics };
}

/** 按页码建索引，后出现的同页覆盖先出现的（侧车不应重复，防御性处理）。 */
export function indexPages(pages: SidecarPageResult[]): Map<number, SidecarPageResult> {
  const map = new Map<number, SidecarPageResult>();
  for (const page of pages) map.set(page.pageNumber, page);
  return map;
}
