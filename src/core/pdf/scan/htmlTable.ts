/**
 * htmlTable — 把侧车给出的表格 HTML 解析成行/单元格结构。
 *
 * 版面引擎（PP-StructureV3 的 SLANet-plus）对表格区域输出带 colspan /
 * rowspan 的 HTML，这是目前拿得到的唯一结构化来源。插件侧需要一个不依赖
 * DOM 的解析器：Zotero 沙箱里没有 document，单测跑在纯 Node，引入 HTML
 * 解析依赖也不值得——表格 HTML 的语法面很窄（table/tr/td/th 加两个跨度
 * 属性），一个引号感知的扫描器就够。对引擎的畸形输出（缺闭合标签、属性
 * 值里带 >、未编码实体）必须稳：解析失败一律返回 null，调用方退回"只登记
 * 区域"的既有行为，绝不向上抛。
 *
 * 结构之外还给出每个单元格的网格列起点与网格规模（列数、展开行数）：
 * HTML 不带坐标，下游只能按均分近似定位单元格（见 ocrToAnalysis 的
 * cellBBox），没有列起点就无法处理被 rowspan 挤位的行。
 *
 * 输入规模设上限：OCR 输出可能来自任意畸形的页面，解析预算超支即判失败
 * （整表退回只计数），不在解析循环里做无界劳动。
 *
 * 纯模块：不碰宿主，可在 Node 单测。
 *
 * @module core/pdf/scan/htmlTable
 */

/** 输入 HTML 长度上限（字符数）。超过即判失败。 */
export const MAX_TABLE_HTML_CHARS = 4_000_000;
/** 行数上限。 */
export const MAX_TABLE_ROWS = 2000;
/** 列数上限（colspan 与 rowspan 的钳制基准）。 */
export const MAX_TABLE_COLUMNS = 200;
/** 单元格总数上限。 */
export const MAX_TABLE_CELLS = 20_000;
/** 单单元格文本长度上限（超长截断——把整表判失败只会丢更多内容）。 */
export const MAX_CELL_TEXT_CHARS = 8000;

export interface ParsedTableCell {
  /** 单元格文本（实体已解码，连续空白归一为单个空格）。 */
  text: string;
  colspan: number;
  rowspan: number;
  /** 网格列起点（0 基）。前面的 rowspan 占位会把本行后面的列往后挤。 */
  col: number;
}

export interface ParsedTableRow {
  cells: ParsedTableCell[];
}

export interface ParsedTable {
  rows: ParsedTableRow[];
  /** 网格列数（colspan 展开后）。 */
  columns: number;
  /** 网格行数（rowspan 展开后）。 */
  gridRows: number;
}

/** 常见命名实体。数值实体另行处理。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** 解码实体；无法识别的保持原样（宁可不解码，也不编造字符）。 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // 代理区半码：fromCodePoint 不抛但返回替换字符，等于把原文改坏
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** 归一空白：所有连续空白（含换行、制表符、不换行空格）并成一个空格。 */
function normalizeCellText(text: string): string {
  return normalizeSpace(decodeEntities(text));
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 取跨度属性（colspan / rowspan）：缺失、非法、超界都退回 1。 */
function spanAttr(attrs: string, name: "colspan" | "rowspan", max: number): number {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return 1;
  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(max, Math.trunc(n));
}

type Token =
  | { kind: "open"; name: string; attrs: string; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/**
 * 扫描器：按引号感知找标签边界，属性值里的 > 不算结束（title="a>b" 是
 * OCR 输出里出现过的写法）。无法识别的 < 当普通字符。
 */
function* tokenize(html: string): Generator<Token> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      yield { kind: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: html.slice(i, lt) };
    const next = html[lt + 1];
    if (next === "!") {
      // 注释 / DOCTYPE：整体跳过
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>?/.exec(html.slice(lt));
      if (!m) {
        yield { kind: "text", text: "<" };
        i = lt + 1;
        continue;
      }
      yield { kind: "close", name: m[1].toLowerCase() };
      i = lt + m[0].length;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt));
    if (!nameMatch) {
      yield { kind: "text", text: "<" };
      i = lt + 1;
      continue;
    }
    let j = lt + nameMatch[0].length;
    let quote = "";
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    const rawAttrs = html.slice(lt + nameMatch[0].length, j).trim();
    const selfClosing = rawAttrs.endsWith("/");
    yield {
      kind: "open",
      name: nameMatch[1].toLowerCase(),
      attrs: selfClosing ? rawAttrs.slice(0, -1).trim() : rawAttrs,
      selfClosing,
    };
    i = j < html.length ? j + 1 : html.length;
  }
}

/** 解析结果的中继状态（一个在建单元格）。 */
interface PendingCell {
  text: string;
  colspan: number;
  rowspan: number;
}

/**
 * 解析表格 HTML。返回 null 表示"没有可用的表格结构"：没有 <table>、一
 * 行一单元格都没有、输入超长或解析预算超支。调用方据此退回只登记区域的
 * 既有行为。
 */
export function parseHtmlTable(html: string): ParsedTable | null {
  if (typeof html !== "string" || html.length > MAX_TABLE_HTML_CHARS) return null;
  if (!/<table\b/i.test(html)) return null;

  const rows: ParsedTableRow[] = [];
  /** "行,列" → 已被某单元格（含 rowspan 向下延伸）占用。 */
  const occupied = new Set<string>();
  let columns = 0;
  let gridRows = 0;
  let cellCount = 0;
  /** 本行已扫到的列（同行从左到右填，免去每格从头扫描）。 */
  let scanCol = 0;

  let tableDepth = 0; // 第一个 <table> 的深度：它结束即止
  let nested = 0; // 单元格内嵌套 <table> 的深度：其结构标签不并入外表
  let rowOpen: ParsedTableRow | null = null;
  let cell: PendingCell | null = null;
  let cellRow = 0;
  let cellCol = 0;
  let skipText = 0; // <script>/<style> 深度：其中的字符不是内容

  const closeCell = (): void => {
    if (!cell) return;
    if (rowOpen) {
      const text = normalizeCellText(cell.text);
      cellCount++;
      rowOpen.cells.push({
        text: text.length > MAX_CELL_TEXT_CHARS ? text.slice(0, MAX_CELL_TEXT_CHARS) : text,
        colspan: cell.colspan,
        rowspan: cell.rowspan,
        col: cellCol,
      });
      columns = Math.max(columns, cellCol + cell.colspan);
      gridRows = Math.max(gridRows, cellRow + cell.rowspan);
    }
    cell = null;
  };

  const closeRow = (): void => {
    closeCell();
    if (rowOpen && rowOpen.cells.length > 0) rows.push(rowOpen);
    rowOpen = null;
    scanCol = 0;
  };

  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      if (cell && skipText === 0) cell.text += token.text;
      continue;
    }
    if (token.kind === "open") {
      if (skipText > 0) {
        // script/style 内部：连结构标签一起忽略（里面出现 <td> 也不开格）
        if (token.name === "script" || token.name === "style") skipText++;
        continue;
      }
      if (token.name === "script" || token.name === "style") {
        skipText++;
        continue;
      }
      if (token.name === "br") {
        if (cell) cell.text += " ";
        continue;
      }
      if (token.name === "table") {
        if (tableDepth === 0) tableDepth = 1;
        else nested++;
        continue;
      }
      if (tableDepth === 0) continue; // 第一个 <table> 之前的标签与结构无关
      if (nested > 0) {
        // 嵌套表格内部：结构不并入外层行，只在单元格之间补空格，免得
        // 宿主单元格里的文字粘成一片。
        if (cell && (token.name === "td" || token.name === "th")) cell.text += " ";
        continue;
      }
      if (token.name === "tr") {
        closeRow();
        if (rows.length >= MAX_TABLE_ROWS) return null;
        rowOpen = { cells: [] };
      } else if (token.name === "td" || token.name === "th") {
        closeCell();
        if (!rowOpen) rowOpen = { cells: [] }; // 缺 <tr> 的畸形输出
        if (cellCount >= MAX_TABLE_CELLS) return null;
        const colspan = spanAttr(token.attrs, "colspan", MAX_TABLE_COLUMNS);
        const rowspan = spanAttr(token.attrs, "rowspan", MAX_TABLE_ROWS);
        cellRow = rows.length;
        cellCol = Math.min(scanCol, Math.max(0, MAX_TABLE_COLUMNS - colspan));
        // 被上方 rowspan 占位的列跳过；同行的跨度区间整块留给自己
        while (cellCol < MAX_TABLE_COLUMNS) {
          let free = true;
          for (let dr = 0; dr < rowspan && free; dr++) {
            for (let dc = 0; dc < colspan && free; dc++) {
              if (occupied.has(`${cellRow + dr},${cellCol + dc}`)) free = false;
            }
          }
          if (free) break;
          cellCol++;
        }
        for (let dr = 0; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) occupied.add(`${cellRow + dr},${cellCol + dc}`);
        }
        cell = { text: "", colspan, rowspan };
        scanCol = cellCol + colspan;
        if (token.selfClosing) closeCell(); // <td/>：开合各一次
      }
      // 其余标签（b/i/sup/sub/span/p/div…）忽略标签本身，文本照常计入
      if (token.selfClosing && token.name === "tr") closeRow();
      continue;
    }
    // 闭合标签
    if (skipText > 0) {
      if (token.name === "script" || token.name === "style") skipText--;
      continue;
    }
    if (token.name === "script" || token.name === "style") continue;
    if (token.name === "br") continue;
    if (token.name === "table") {
      if (nested > 0) {
        nested--;
        continue;
      }
      tableDepth = 0;
      closeRow();
      break; // 第一个表格结束即止
    }
    if (tableDepth === 0) continue;
    if (nested > 0) {
      // 嵌套表格内部：结构不并入外层行，仅在单元格之间补一个空格，
      // 免得宿主单元格里的文字粘成一片。
      if (cell && (token.name === "td" || token.name === "th")) cell.text += " ";
      continue;
    }
    if (token.name === "td" || token.name === "th") closeCell();
    else if (token.name === "tr") closeRow();
  }

  if (rows.length === 0 || cellCount === 0) return null;
  return {
    rows,
    // 占位列找不到空位时会停在上限值（畸形输入的兜底），列数随之越界——
    // 钳回上限，均分近似才不会算出表格外的框。
    columns: Math.min(MAX_TABLE_COLUMNS, Math.max(1, columns)),
    gridRows: Math.max(1, gridRows),
  };
}
