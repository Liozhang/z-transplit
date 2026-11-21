/**
 * backgroundFill — 从源 PDF 的内容流里取矩形填充色，供遮罩配色。
 *
 * Why this exists: `Paragraph.backgroundColor` has existed in translationIR
 * with a full comment ("the white cover-up mask uses this instead of opaque
 * white so colored callouts / code blocks / striped table rows aren't punched
 * through") and both mask-drawing sites in LayoutPreservingRenderer have read
 * it since it was added. But nothing ever produced it, so every mask is drawn
 * pure white. Measured on the fixtures: landscape-slides loses a 12030pt²
 * pale-blue banner to 5 white masks, attention-reading loses its 6952pt² of
 * striped table-header grey to 17. That is exactly what the comment promised
 * to prevent.
 *
 * How it works: pdf-lib can hand us the page's content stream
 * (`page.node.Contents()` → a `PDFRawStream` whose `.contents` is the
 * FlateDecode-compressed token stream). Inflate it, tokenize, and run a small
 * graphics-state machine over it: `q`/`Q` save and restore the CTM and fill
 * colour, `cm` premultiplies the CTM, `rg`/`g`/`sc`/`scn`/`k` set the fill,
 * `re` pushes a rectangle onto the path, and `f`/`f*`/`F`/`B`/`B*`/`b`/`b*`
 * fill it — at which point the path points are transformed through the CTM
 * and the rectangle is recorded.
 *
 * The coordinate space is PDF user space (origin bottom-left, y up), which is
 * the same space ODL bboxes live in. Verified: on landscape-slides the banner
 * `0 101 1002 111 re` under `cm .23999999 0 0 -.23999999 0 594.95996` and
 * `cm 3.125 0 0 3.125 187.5 165.625` lands on x 45–796.5, y 396.21–479.46,
 * matching PyMuPDF's flip_y to within 0.05pt.
 *
 * ONLY rectangle fills are reported — both `re` and a `m`/`l`/`h` path whose
 * points form an axis-aligned rectangle (which is what pdf-lib's own
 * `drawRectangle` emits). A polyline path fill is deliberately ignored: its
 * bbox is the GRAPHIC's extent, not a background region. three-column's orange
 * polyline is one 192-segment path fill whose bbox spans most of the figure —
 * using it as a paragraph background would dye the mask orange. Rectangles are
 * told apart from polylines by "exactly two distinct x values AND exactly two
 * distinct y values", which a rectangle's four corners satisfy and a polyline
 * never does. Both regions that actually need fixing on the fixtures (the
 * pale-blue banner, the striped table header) are `re`.
 *
 * Fills thinner than MIN_BACKGROUND_EDGE on either side are also dropped:
 * column rules, table borders and hairlines are such slivers, and dyeing a mask
 * dark grey over one of them would make the translation unreadable.
 *
 * Scope, stated plainly because it is an ENHANCEMENT and not a guarantee: the
 * parser covers the operator forms that appear on the five fixtures. Real
 * PDFs can be far nastier — chained filters, fills inside `Do`-referenced
 * XObjects, colours coming from `gs`/ExtGState, shading dictionaries,
 * pattern fills. None of those are handled; when we meet one we skip it, and
 * skipping means that page gets no background colour, so masks fall back to
 * white — i.e. today's behaviour. The worst case is never worse than now.
 *
 * Host-independent by design (pdf-lib + zlib only, no Zotero Reader
 * internals) so it runs in the add-on AND in the headless benchmark.
 *
 * @module core/pdf/translation/backgroundFill
 */

import { PDFDocument, PDFName } from "pdf-lib";

/** 0–1 RGB, the same shape `Paragraph.color` uses. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 一个矩形填充，PDF 用户空间（原点左下，y 向上）。 */
export interface FillRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: Rgb;
}

/** 查询框：页码从 1 开始，坐标是 PDF 用户空间。 */
export interface FillQuery {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 3×3 仿射矩阵，按 PDF 的 `[a b c d e f]` 顺序展开成
 * `x' = a·x + c·y + e`、`y' = b·x + d·y + f`。
 */
interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** `cm` 是左乘：新矩阵 = 参数 × 当前矩阵。 */
function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.b * n.c,
    b: m.a * n.b + m.b * n.d,
    c: m.c * n.a + m.d * n.c,
    d: m.c * n.b + m.d * n.d,
    e: m.e * n.a + m.f * n.c + n.e,
    f: m.e * n.b + m.f * n.d + n.f,
  };
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// ─── 内容流解码 ────────────────────────────────────────────────────────

/**
 * 解开 zlib 压缩的内容流。
 *
 * 用 `DecompressionStream("deflate-raw")` 而不是 `node:zlib`：这个模块要被
 * 插件构建打进去，而构建目标里没有 `node:zlib`（esbuild 直接报
 * "Could not resolve"）。DecompressionStream 在 Zotero 7 所用的 Firefox 与
 * Node 18+ 里都有，两边共用一份实现。
 *
 * PDF 的 FlateDecode 是标准 zlib 格式：2 字节头加 4 字节 Adler-32 校验和包着
 * 一段 raw deflate。所以要把头尾剥掉再喂给 deflate-raw。与 `zlib.inflateSync`
 * 的结果逐字节比对过，完全一致。
 *
 * 头部按 2 字节算：zlib 的 FDICT 位会让头部变 4 字节，但 PDF 生成器（PDFBox、
 * pdf-lib）都不设它。真遇到字典预设的情形解出来会是乱码，而乱码过不了后面的
 * 分词，那一页就当没有背景色——不会静默给出错颜色。
 */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  // 长度下限：2 字节 zlib 头加 4 字节校验和，再少就连头尾都不完整。
  if (data.length < 6) throw new Error("zlib stream too short");
  const raw = data.subarray(2, data.length - 4);
  // Blob + Response 的组合在 Zotero 7 的 Firefox 与 Node 18+ 里都有，而且避开
  // 了 ReadableStream 读写端在不同 TS lib 配置下的签名分歧。
  //
  // 拷一份再交给 Blob：`subarray` 返回的是带 ArrayBufferLike 参数的
  // Uint8Array，旧版 lib 的 BlobPart 不认它（node 配置会报 TS2322）。
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  const piped = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/**
 * 把一个页面的内容流解开成文本。
 *
 * `Contents` 可能是单个流，也可能是流数组（PDF 规范：数组按顺序连成一条内容
 * 流）。数组元素常常是间接引用，要经 `context.lookup` 才拿得到真身——pdf-lib
 * 自己保存出来的 PDF 就是数组套 PDFRef 的形态，不解析引用会一页都采不到。
 *
 * 只支持 FlateDecode：五篇夹具全是它，而 pdf-lib 的 `PDFRawStream` 不提供
 * 通用的解码入口（`PDFContentStream.of` 期待的是 dict 加操作符，不是流）。
 * 其它 Filter 返回 null——调用方把该页当"没有背景色"处理，即维持白色遮罩。
 */
async function decodeContentStream(
  contents: unknown,
  lookup: (ref: unknown) => unknown,
): Promise<string | null> {
  const streams: unknown[] = [];
  const asArray = contents as { asArray?: () => unknown[] } | null;
  if (asArray && typeof asArray.asArray === "function") {
    for (const item of asArray.asArray()) {
      streams.push(lookup(item));
    }
  } else if (contents) {
    streams.push(contents);
  }
  if (streams.length === 0) return null;

  const parts: string[] = [];
  for (const stream of streams) {
    const decoded = await decodeOneStream(stream);
    if (decoded === null) return null; // 有一段解不开，整页放弃
    parts.push(decoded);
  }
  return parts.join("\n");
}

/** 解开单个流。认不出或解不开返回 null。 */
async function decodeOneStream(stream: unknown): Promise<string | null> {
  const s = stream as {
    contents?: Uint8Array;
    dict?: { get?: (name: unknown) => unknown };
  } | null;
  if (!s || !s.contents || !s.dict || typeof s.dict.get !== "function") {
    return null;
  }
  let filter: unknown;
  try {
    filter = s.dict.get(PDFName.of("Filter"));
  } catch {
    return null;
  }
  // Filter 可能是单个名字，也可能是名字数组。只要其中含 FlateDecode 且它是
  // 唯一的一个，就解；多个 Filter 串联或非 Flate 一概不解。
  const names: string[] = [];
  const filterAsArray = filter as { asArray?: () => Array<{ toString?: () => string }> } | null;
  if (filterAsArray && typeof filterAsArray.asArray === "function") {
    for (const item of filterAsArray.asArray()) {
      names.push(String(item));
    }
  } else if (filter) {
    names.push(String(filter));
  }
  if (names.length !== 1 || !names[0].includes("FlateDecode")) {
    return null;
  }
  try {
    const bytes = await inflateZlib(s.contents);
    // 内容流是字节流，按 latin1 逐字节映射成字符串——操作符与数字都是 ASCII，
    // 十六进制字符串里的任意字节也只是一个字符，不影响分词。
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  } catch {
    return null;
  }
}

// ─── 内容流分词 ────────────────────────────────────────────────────────

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "array-open" }
  | { kind: "array-close" };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * 把内容流切成操作符序列。
 *
 * 只认四类词元：数字、名字（`/Xxx`）、字面字符串（`(...)`）、操作符。十六进制
 * 字符串、字典（`<<...>>`）与注释都跳过——本模块只关心填充色与路径几何，
 * 那些一概用不到。遇到认不出的结构返回 null，调用方整页放弃。
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (WHITESPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === 0x25) {
      // 注释：到行尾。
      while (i < n && text.charCodeAt(i) !== 0x0a) i += 1;
      continue;
    }
    if (ch === 0x28) {
      // 字面字符串。嵌套括号与反斜杠转义都要走。
      i += 1;
      let depth = 1;
      let value = "";
      while (i < n && depth > 0) {
        const c = text.charCodeAt(i);
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x28) depth += 1;
        if (c === 0x29) {
          depth -= 1;
          if (depth === 0) break;
        }
        value += text[i];
        i += 1;
      }
      if (depth !== 0) return null;
      i += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (ch === 0x5b) {
      tokens.push({ kind: "array-open" });
      i += 1;
      continue;
    }
    if (ch === 0x5d) {
      tokens.push({ kind: "array-close" });
      i += 1;
      continue;
    }
    if (ch === 0x3c) {
      // 十六进制字符串或字典。字典本模块用不到，直接跳到配对的 >>。
      if (text.charCodeAt(i + 1) === 0x3c) {
        const end = text.indexOf(">>", i + 2);
        if (end < 0) return null;
        i = end + 2;
        continue;
      }
      const end = text.indexOf(">", i + 1);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === 0x2f) {
      // 名字。
      i += 1;
      let value = "";
      while (i < n) {
        const c = text.charCodeAt(i);
        if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: "name", value });
      continue;
    }
    if (ch === 0x3e) {
      const end = text.indexOf(">>", i);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    // 数字或操作符。
    let start = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (WHITESPACE.has(c) || DELIMITERS.has(c)) break;
      i += 1;
    }
    if (i === start) {
      // 单个界定符且上面没处理到（例如 `)` `>` `}`），跳过它。
      i += 1;
      continue;
    }
    const word = text.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      tokens.push({ kind: "number", value: Number(word) });
    } else {
      tokens.push({ kind: "operator", value: word });
    }
  }
  return tokens;
}

// ─── 图形状态机 ────────────────────────────────────────────────────────

interface GraphicsState {
  ctm: Matrix;
  /** 非空填充色（0–1 RGB）。null 表示没有设过填充色。 */
  fill: Rgb | null;
}

/**
 * 矩形填充的最小边长，单位磅。
 *
 * 低于这个值的矩形不当背景：栏间分隔线、表格边框线、装饰线都是这种细长条
 * ——formula-dense 的栏线宽 0.75 磅高 621 磅、颜色 0.7333 深灰，attention-reading
 * 的表格线宽 0.7 到 0.8 磅、颜色 0.2。拿它们当背景色会把遮罩染成深灰，译文直接
 * 不可读。而五篇上真正需要保留的背景最窄也有 30 磅（表格表头斑马纹的单元格），
 * 与 0.75 之间隔着四十倍，2 磅是安全的一刀。
 */
const MIN_BACKGROUND_EDGE = 2;

/**
 * 跑一遍内容流，收集 `re` 矩形填充。
 *
 * 路径填充（`m`/`l`/`c` 之后 `f`）被忽略——见模块头"ONLY `re` rectangles"。
 * 裁剪（`W`/`W*`）不实现：保守地把裁剪区内的填充也算进来。
 */
function collectFromTokens(tokens: Token[]): FillRect[] {
  const out: FillRect[] = [];
  const stack: GraphicsState[] = [];
  let ctm: Matrix = IDENTITY;
  let fill: Rgb | null = null;
  /** 待填充的矩形队列（`re` 之后 `f`）。 */
  let pending: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** 当前路径的点（`m`/`l`）。填充时用它判断是不是轴对齐矩形。 */
  let pathPoints: Array<{ x: number; y: number }> = [];

  const numbers: number[] = [];
  const clearPath = (): void => {
    pending = [];
    pathPoints = [];
  };
  for (const token of tokens) {
    if (token.kind === "number") {
      numbers.push(token.value);
      continue;
    }
    if (token.kind !== "operator") {
      // 名字与字符串只可能出现在 `gs`/`sh`/`Tf` 之类里，本模块不关心；
      // 数组开合同理。它们不该打断操作数累积，所以不清空 numbers。
      continue;
    }

    const op = token.value;
    switch (op) {
      case "q":
        stack.push({ ctm, fill });
        break;
      case "Q":
        if (stack.length > 0) {
          const restored = stack.pop()!;
          ctm = restored.ctm;
          fill = restored.fill;
        }
        break;
      case "cm":
        if (numbers.length >= 6) {
          const [a, b, c, d, e, f] = numbers.slice(-6);
          // PDF 规范：CTM_new = M × CTM_old，即先应用参数矩阵、再应用原有
          // 矩阵。写反顺序平移量会错——三栏与横版那两层 cm（外层缩放加 y
          // 翻转，内层缩放加平移）反序后平移从 (45, 790.92) 变成
          // (187.5, 2024.88)，矩形整体跑出页面。
          ctm = multiply({ a, b, c, d, e, f }, ctm);
        }
        break;
      case "g":
        if (numbers.length >= 1) {
          const v = numbers[numbers.length - 1];
          fill = { r: v, g: v, b: v };
        }
        break;
      case "rg":
        if (numbers.length >= 3) {
          const [r, g, b] = numbers.slice(-3);
          fill = { r, g, b };
        }
        break;
      case "k":
        if (numbers.length >= 4) {
          // CMYK 转 RGB 的近似：C = 1-min(1, C+K) 等。只用于挑背景色，
          // 精度足够；五篇夹具上没出现 CMYK 填充。
          const [c, m, y, k] = numbers.slice(-4);
          fill = {
            r: 1 - Math.min(1, c + k),
            g: 1 - Math.min(1, m + k),
            b: 1 - Math.min(1, y + k),
          };
        }
        break;
      case "sc":
      case "scn":
        // 名称空间与 Indexed/ICCBased 的设色本模块不解析；`scn` 的最后一个
        // 操作数可能是名字。只认三分量（RGB）与单分量（灰）两种形态。
        if (numbers.length === 1) {
          const v = numbers[0];
          fill = { r: v, g: v, b: v };
        } else if (numbers.length === 3) {
          fill = { r: numbers[0], g: numbers[1], b: numbers[2] };
        } else if (numbers.length === 4) {
          const [c, m, y, k] = numbers;
          fill = {
            r: 1 - Math.min(1, c + k),
            g: 1 - Math.min(1, m + k),
            b: 1 - Math.min(1, y + k),
          };
        }
        break;
      case "re":
        if (numbers.length >= 4) {
          const [x, y, w, h] = numbers.slice(-4);
          pending.push({ x, y, w, h });
        }
        break;
      case "m":
      case "l":
        if (numbers.length >= 2) {
          pathPoints.push({ x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] });
        }
        break;
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*": {
        if (fill) {
          for (const rect of pending) {
            pushIfBackground(out, transformRect(rect, ctm, fill));
          }
          // 路径填充也收，但只在它构成轴对齐矩形时收。pdf-lib 的
          // drawRectangle 走的就是 `m`/`l`/`h`/`f` 而不是 `re`，只认 `re` 会把它
          // 漏掉；而三栏那条 192 段的橙色折线同样走路径填充，必须排除——用
          // "x 与 y 各只有两个取值"这一条把两者分开：矩形四角只有两个 x 与两个
          // y，折线有几十个。
          const fromPath = axisAlignedRect(pathPoints);
          if (fromPath) {
            pushIfBackground(out, transformRect(fromPath, ctm, fill));
          }
        }
        clearPath();
        break;
      }
      case "S":
      case "s":
      case "n":
      case "W":
      case "W*":
      case "sh":
        // 这些操作符同样结束当前路径。漏掉它们会让上一个 `re` 残留在待填充
        // 队列里，被后面某次毫不相干的 `f` 按当时的填充色再收一遍——三栏那个
        // 图背景框因此被收成一白一橙两个坐标完全相同的矩形（`re` 之后跟的是
        // `S` 描边，不是 `f`）。裁剪本身不实现，见模块头。
        clearPath();
        break;
      default:
        break;
    }
    numbers.length = 0;
  }
  return out;
}

/** 把一个 `re` 矩形经 CTM 变换成用户空间矩形。 */
function transformRect(
  rect: { x: number; y: number; w: number; h: number },
  ctm: Matrix,
  color: Rgb,
): FillRect {
  const p0 = apply(ctm, rect.x, rect.y);
  const p1 = apply(ctm, rect.x + rect.w, rect.y + rect.h);
  return {
    x0: Math.min(p0.x, p1.x),
    y0: Math.min(p0.y, p1.y),
    x1: Math.max(p0.x, p1.x),
    y1: Math.max(p0.y, p1.y),
    color,
  };
}

/** 边长够格的矩形才当背景；细长条是分隔线或装饰线，见 MIN_BACKGROUND_EDGE。 */
function pushIfBackground(out: FillRect[], rect: FillRect): void {
  if (rect.x1 - rect.x0 >= MIN_BACKGROUND_EDGE && rect.y1 - rect.y0 >= MIN_BACKGROUND_EDGE) {
    out.push(rect);
  }
}

/**
 * 一组路径点若构成轴对齐矩形，返回它的 `x y w h`，否则 null。
 *
 * 判据是"x 只有两个取值且 y 只有两个取值，且至少有四个点"。矩形四角必然满足；
 * 折线有几十个不同的 x 与 y，必然不满足。闭合时 `h` 会把首点重复一遍，所以
 * 用去重后的取值计数，不数点数。
 */
function axisAlignedRect(
  points: Array<{ x: number; y: number }>,
): { x: number; y: number; w: number; h: number } | null {
  if (points.length < 4) return null;
  const xs = new Set(points.map((p) => p.x));
  const ys = new Set(points.map((p) => p.y));
  if (xs.size !== 2 || ys.size !== 2) return null;
  const xValues = [...xs].sort((a, b) => a - b);
  const yValues = [...ys].sort((a, b) => a - b);
  return {
    x: xValues[0],
    y: yValues[0],
    w: xValues[1] - xValues[0],
    h: yValues[1] - yValues[0],
  };
}

// ─── 公开接口 ──────────────────────────────────────────────────────────

/**
 * 按页收集源 PDF 里的矩形填充。
 *
 * 任何一页解不开、读不出或解析失败，该页返回空数组——调用方按"没有背景色"
 * 处理，遮罩退回白色。整体不抛错：采样是增强，不是必经环节。
 *
 * 异步是因为 pdf-lib 只有异步的 `PDFDocument.load`。
 */
export async function collectFillRects(pdfBytes: Uint8Array): Promise<FillRect[][]> {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    return [];
  }
  const pages: FillRect[][] = [];
  try {
    const lookup = (ref: unknown) => doc.context.lookup(ref as never);
    for (const page of doc.getPages()) {
      const node = (page as unknown as { node: { Contents?: () => unknown } }).node;
      const contents = typeof node.Contents === "function" ? node.Contents() : null;
      const text = await decodeContentStream(contents, lookup);
      if (!text) {
        pages.push([]);
        continue;
      }
      const tokens = tokenize(text);
      pages.push(tokens ? collectFromTokens(tokens) : []);
    }
  } catch {
    // 中途失败：把剩下的页补成空数组，保证返回值与页数一致。
    while (pages.length < doc.getPageCount()) pages.push([]);
  }
  return pages;
}

/**
 * 查询框内面积最大的那个填充色；没有则 null。
 *
 * 为什么取面积最大而不是中心点：一个段落常跨在背景区域的边缘上，中心点可
 * 能正好落在边界外；而"框内占比最大的颜色"就是这块区域的主导背景。横版那
 * 条浅蓝横幅完全包住正文段，取出来是浅蓝；表格表头行同理取到浅灰。
 *
 * 完全不重叠的填充（交集面积为 0）不计入。
 */
export function pickBackgroundColor(
  fills: FillRect[],
  box: { x0: number; y0: number; x1: number; y1: number },
): Rgb | null {
  const bx0 = Math.min(box.x0, box.x1);
  const bx1 = Math.max(box.x0, box.x1);
  const by0 = Math.min(box.y0, box.y1);
  const by1 = Math.max(box.y0, box.y1);
  let best: Rgb | null = null;
  let bestArea = 0;
  for (const f of fills) {
    const overlap =
      Math.max(0, Math.min(bx1, f.x1) - Math.max(bx0, f.x0)) *
      Math.max(0, Math.min(by1, f.y1) - Math.max(by0, f.y0));
    if (overlap > bestArea) {
      bestArea = overlap;
      best = f.color;
    }
  }
  return best;
}

/**
 * 批量采样：输入一批查询框，输出同长度的颜色或 null。
 *
 * `collectFillRects` 只跑一次，所有框共用——解析内容流是这批工作里最贵的
 * 一步，逐框重跑会让页数乘框数的代价翻倍。
 */
export async function sampleBackgroundFills(
  pdfBytes: Uint8Array,
  queries: FillQuery[],
): Promise<Array<Rgb | null>> {
  const perPage = await collectFillRects(pdfBytes);
  return queries.map((q) => {
    const fills = perPage[q.page - 1];
    if (!fills || fills.length === 0) return null;
    return pickBackgroundColor(fills, q);
  });
}

/**
 * 读每页的 /Rotate（度），与页序一一对应。
 *
 * 为什么需要它：解析器报的段落框是**显示空间**的坐标（已应用 /Rotate），而删除器
 * 解析的是内容流、画在**原始空间**。旋转页上两者不一致，删除区域必须先变换回去
 * 再交给删除器，否则删的是别处——或者哪儿都没删。批 8 之前 `buildRemovalRects`
 * 压根不知道旋转这回事。
 *
 * /Rotate 只在 PDF 里有，解析器的 JSON 不带它，所以只能从源 PDF 读。这里与
 * `collectFillRects` 一样走 pdf-lib 载入，是因为装配层已经在为背景填充加载同一
 * 份字节了——单开一个轻量解析器（正则扫 /Rotate）反而更脆。
 *
 * 读不出来时返回空数组而不是抛错：调用方按"没有旋转"处理，那是旋转页之外的
 * 全部文档的常态，为一个可选信息让整次翻译失败是反的。
 */
export async function collectPageRotations(pdfBytes: Uint8Array): Promise<number[]> {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    return [];
  }
  try {
    return doc.getPages().map((page) => {
      try {
        return page.getRotation().angle;
      } catch {
        return 0;
      }
    });
  } catch {
    return [];
  }
}
