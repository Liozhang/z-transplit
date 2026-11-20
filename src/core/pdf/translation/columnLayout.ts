/**
 * columnLayout — 多栏版面里的栏检测、跨栏合并块识别与切分。
 *
 * Why this exists: OpenDataLoader's reading-order algorithm merges multi-column
 * flow into a single text block. The resulting bbox is the UNION of several
 * rectangular pieces — one per column the flow passed through — not one wide
 * paragraph. Measured on the three-column fixture: a 334.8pt-wide block whose
 * bbox is `[42.75, 511.582, 377.578, 733.992]`, which is exactly the union of
 * "2 lines at the bottom of column 1" (`x 42.75–201.66, y 511.58–532.24`) and
 * "6 lines at the top of column 2" (`x 218.67–377.58, y 665.33–733.99`).
 *
 * Four consequences, all measured:
 *   1. The mask is drawn over the whole union, whitening the neighbouring
 *      column's upper half.
 *   2. `maxWidth = x1 - x0` becomes 2.11× the real column width, so the
 *      translation wraps into 6 lines instead of 11 and spills sideways —
 *      while `stats.overflowed` stays 0, because 6 lines fit in the 222pt-tall
 *      union box. The defect is invisible to that metric.
 *   3. The removal-rects list swallows neighbouring paragraphs whole.
 *   4. The merged block's translation is drawn first, then a later paragraph's
 *      mask is drawn over it, erasing it in the first column. Confirmed by
 *      pixel measurement: dark-pixel ratio drops from 0.365 to 0.025.
 *
 * The same defect exists on attention-reading page 2 (a 504.7×251.3pt block
 * that geometrically contains 17 other blocks), so the fix has to be general.
 *
 * Splitting on x alone is NOT enough. Each column fragment would keep the
 * union's full y range, so its mask would still whiten that column's other
 * paragraphs. The y range has to come from somewhere, and OpenDataLoader emits
 * no column attribution in any output format — verified against JSON, text and
 * markdown, with and without `--keep-line-breaks`.
 *
 * It can be derived instead: within a column band, the space NOT occupied by
 * sibling blocks is exactly where the merged block's piece of that column must
 * live. Taking the largest such gap per band recovers the real geometry closely
 * (column 1: estimated 27.4pt tall vs the real 20.7pt; column 2: 89.0 vs 68.7).
 * Both over-estimates are safe — the fragment is slightly taller than its
 * content, never overlapping a neighbour.
 *
 * The over-estimate is NOT harmless, though: the gap's ends sit on the
 * neighbouring block's boundary, and between that boundary and the real content
 * there is a layer of inter-column padding (6.77pt and 7.09pt on three-column,
 * i.e. 0.8× the 8.497pt font size). Left in place, the fragment's mask whitens
 * the neighbour's first line. So each end that touches a neighbour is pulled
 * back by that padding; the two ends that ARE the merged block's own bbox ends
 * are left alone, because those coincide exactly with the real content's start
 * and end.
 *
 * @module core/pdf/translation/columnLayout
 */

/** 一个只需要几何字段的框。装配层的段落与解析器的块都满足这个形状。 */
export interface ColumnBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 切分出来的一个片段：栏带内的真实内容范围。 */
export interface ColumnFragment extends ColumnBox {
  /** 所属栏带的左界（栏界数组下标对应的位置）。 */
  bandStart: number;
  bandEnd: number;
}

/**
 * 栏间空白的最小宽度，按页宽的比例取，下限 4 磅。
 *
 * 不能用"中位块宽的一半"：三栏 A4 上栏间隔只有 16 磅，而栏宽 158.9，一半是
 * 79.5——按那个阈值一条栏界都找不到。栏间隔虽小，仍远大于词间距（2 到 3 磅），
 * 所以按页宽的百分之一取即可分开两者。
 */
const MIN_GUTTER_RATIO = 0.01;
const MIN_GUTTER_ABS = 4;

/** 判定"这一块跨栏合并"时，高度相对字号的异常倍数。 */
const MERGED_HEIGHT_RATIO = 18;

/**
 * 片段两端相对邻段边界的收缩量，按字号的倍数取。
 *
 * 用最大空隙求出的片段必然顶到邻段的边界，而邻段边界与合并块在这一栏的真实
 * 内容之间还隔着一层栏内留白。三栏夹具实测：片段 1 的空隙上界 539.01 磅正是
 * 邻段标题的上界，真实内容上界 532.24，差 6.77；片段 2 的空隙下界 658.24 是
 * 邻段的下界，真实内容下界 665.33，差 7.09。字号 8.497，两个差分别是它的
 * 0.797 与 0.834 倍。取 0.8 把片段收回到真实内容附近，遮罩不再涂掉邻段的
 * 第一行。
 *
 * 只收缩"这一端不是合并块自身的端点"的那些端。合并块 bbox 的两端就是内容真
 * 实的起点与终点——三栏夹具上 511.58 与 733.99 都与 PyMuPDF 量出的真实值分毫
 * 不差——所以那两端不能收，收了会切掉内容。
 */
const INNER_MARGIN_RATIO = 0.8;

/**
 * 用同页所有块的横向覆盖计数求栏界。
 *
 * 做法：统计每个 x 位置被多少个块的 `[x0, x1]` 覆盖，找覆盖数既低于全局上限、
 * 又相对两侧明显凹陷的连续带。每个带的中点就是一条栏界。
 *
 * 为什么数计数而不是只看有没有覆盖：通栏元素（图注、通栏标题）横跨整页，会把
 * 栏间空白"缝"起来——三栏夹具上图注宽 510.75 磅、通栏标题宽 282.62 磅，用布尔
 * 投影整页 x 轴无一空隙，一条栏界都找不到。但栏间空白只被这几个通栏元素经过，
 * 覆盖数远低于栏内区域（三栏实测：栏内 8 到 11，空白 2），所以按计数能把它们
 * 分开。
 *
 * 为什么还要局部凹陷：只比全局上限会误检。双栏文档第二页只有 11 个块，其中一
 * 个是宽 504.7 磅的跨栏合并块，它单独经过的某些 x 段覆盖数也是 1，低于上限，
 * 却被当成了栏界——切出来的片段宽 65 磅，只有真实栏宽的四分之一。加一道"带内
 * 覆盖数不足两侧较小者的一半"就把这类误检挡掉了：真正的栏间空白两侧都是成排
 * 的栏内块。
 *
 * 只有两侧都有覆盖的带才算栏间空白——页面左右边距不是。单栏文档覆盖数处处
 * 一致，返回空数组，这是"单栏不误切"的保证。
 */
export function detectColumnEdges(boxes: ColumnBox[], pageWidth: number): number[] {
  if (boxes.length < 2 || pageWidth <= 0) return [];
  const width = Math.ceil(pageWidth);
  if (width <= 0) return [];

  const counts = new Uint16Array(width);
  let peak = 0;
  for (const b of boxes) {
    const lo = Math.max(0, Math.floor(Math.min(b.x0, b.x1)));
    const hi = Math.min(width, Math.ceil(Math.max(b.x0, b.x1)));
    for (let x = lo; x < hi; x++) {
      counts[x] += 1;
      if (counts[x] > peak) peak = counts[x];
    }
  }
  // 栏间空白的覆盖数上限：通栏元素个数，远少于栏内块数。取峰值的四成，栏内
  // 区域（实测为峰值的 0.7 到 1.0）不会落进去，空白（0.2 左右）会。
  const ceiling = Math.max(1, Math.floor(peak * 0.4));
  const minGutter = Math.max(MIN_GUTTER_ABS, pageWidth * MIN_GUTTER_RATIO);

  // 先收集候选带，再逐条做局部凹陷判定。
  //
  // rawStart / rawEnd 是"覆盖数不超过上限"的整段，start / end 是收紧后的真空白
  // 子带。两者都要留着：edge 用收紧后的（位置准），局部凹陷的邻域用收紧前的
  // （侧翼没被甩掉，峰值不被参差区拉低——见 tightestRun 的注释）。
  const candidates: Array<{
    start: number;
    end: number;
    rawStart: number;
    rawEnd: number;
    inside: number;
  }> = [];
  let runStart = -1;
  const close = (end: number): void => {
    if (runStart < 0) return;
    // runStart > 0 挡住左页边距；end < width 挡住右页边距。
    if (runStart > 0 && end < width && end - runStart >= minGutter) {
      // 带内还要再收紧一道。覆盖数不超过上限的区域，可能把"栏内块右界参差"
      // 造成的低覆盖区与真正的栏间空白连成一条：attention-reading 第 2 页只
      // 有 11 个块，栏 1 各块右界是 216.73、223.99、284.62，于是 x 224 到
      // 284 只有两个块经过（计数 2，等于上限），与右侧计数 1 的真空白连成
      // 224–309 一条带，中点 267，比真实栏间空白的中点 297.4 偏了 30 磅。
      // 收紧到覆盖数等于带内最小值的连续子带就分开了：那段是 285–309，中点
      // 297.5。三栏夹具的空白区计数处处相等（三个通栏元素都穿过），收紧后
      // 不变。
      const tight = tightestRun(counts, runStart, end);
      if (tight) {
        candidates.push({
          start: tight.start,
          end: tight.end,
          rawStart: runStart,
          rawEnd: end,
          inside: tight.inside,
        });
      }
    }
    runStart = -1;
  };
  for (let x = 0; x < width; x++) {
    if (counts[x] <= ceiling) {
      if (runStart < 0) runStart = x;
      continue;
    }
    close(x);
  }
  close(width);

  const edges: number[] = [];
  // 每侧看多宽的邻域。通栏元素的边缘不一定正好落在栏界上，紧邻栏界的那一磅
  // 可能仍只有通栏元素经过，只看 1 磅会把真正的栏界也挡掉（三栏夹具实测）。
  // 取页宽的百分之五：三栏 A4 上是 29.75 磅，足以越过过渡区又不跨到邻栏的
  // 另一条空白带上。
  const reach = Math.max(4, Math.round(pageWidth * 0.05));
  for (const band of candidates) {
    const left = neighbourhoodPeak(counts, band.rawStart - reach, band.rawStart);
    const right = neighbourhoodPeak(counts, band.rawEnd, band.rawEnd + reach);
    const neighbour = Math.min(left, right);
    // 栏间空白比栏内少经过至少两个块。用绝对差而不是倍数：三栏夹具上栏间空白
    // 被 4 个通栏元素穿过、栏内被 7 个块经过，比值 1.75——2 倍阈值会把它当误检
    // 挡掉，而绝对差 3 稳稳过。双栏第二页那种误检带两侧与带内都是 1 个块，
    // 差 0，仍被挡住。
    if (neighbour - band.inside >= 2) {
      edges.push((band.start + band.end) / 2);
    }
  }
  return edges;
}

function neighbourhoodPeak(counts: Uint16Array, from: number, to: number): number {
  let peak = 0;
  for (let x = Math.max(0, from); x < Math.min(counts.length, to); x++) {
    if (counts[x] > peak) peak = counts[x];
  }
  return peak;
}

/**
 * 在 `[from, to)` 里找覆盖数最小的连续子带，返回最长的那一段。
 *
 * 为什么要收这一道：见 detectColumnEdges 里 close() 的注释。栏内块右界参差会
 * 让覆盖数在中途降一档，与真正的栏间空白连成一条过宽的候选带，带的中点因此
 * 偏离真实栏界。取带内最小值的那一段，就把参差区甩掉了。
 *
 * 返回 null 表示这一段全是页边距（不会发生——调用方已用 runStart > 0 与
 * end < width 挡掉），或最小值的连续段长度为 0。
 */
function tightestRun(
  counts: Uint16Array,
  from: number,
  to: number,
): { start: number; end: number; inside: number } | null {
  let min = Infinity;
  for (let x = from; x < to; x++) {
    if (counts[x] < min) min = counts[x];
  }
  if (!Number.isFinite(min)) return null;

  let best: { start: number; end: number } | null = null;
  let runStart = -1;
  for (let x = from; x <= to; x++) {
    if (x < to && counts[x] === min) {
      if (runStart < 0) runStart = x;
      continue;
    }
    if (runStart >= 0) {
      if (!best || x - runStart > best.end - best.start) {
        best = { start: runStart, end: x };
      }
      runStart = -1;
    }
  }
  return best ? { ...best, inside: min } : null;
}

/**
 * 这一块是不是"多栏文本被合并成一个块"。
 *
 * 两个判据，满足其一即算：
 *   1. bbox 完整包含至少三个同页其它块。这是直接证据——合并块的框是多个矩形
 *      片的并集，几何上吞掉邻段。宽度判据分不清"合法通栏元素"与"跨栏合并"，
 *      这个判据能：通栏标题虽宽，但不包住别人。
 *   2. 跨越至少两个栏带，且块高超过字号的 18 倍。兜底"邻居也被一起吞了"的
 *      极端情形——那时没有邻居可包含，判据 1 失效。高度条件挡掉通栏元素：
 *      通栏标题与图注都只有一两行。
 */
export function isColumnSpanningBlock(
  box: ColumnBox,
  siblings: ColumnBox[],
  edges: number[],
  fontSize = 0,
): boolean {
  let contained = 0;
  for (const s of siblings) {
    if (s === box) continue;
    if (
      box.x0 <= s.x0 && s.x1 <= box.x1 &&
      box.y0 <= s.y0 && s.y1 <= box.y1
    ) {
      contained++;
    }
  }
  if (contained >= 3) return true;

  if (edges.length > 0 && fontSize > 0) {
    if (countSpannedBands(box, edges) >= 2) {
      const height = Math.abs(box.y1 - box.y0);
      if (height > fontSize * MERGED_HEIGHT_RATIO) return true;
    }
  }
  return false;
}

/** 块的 x 范围跨过几个栏带。 */
export function countSpannedBands(box: ColumnBox, edges: number[]): number {
  let spanned = 0;
  let cursor = -Infinity;
  for (const edge of [...edges, Infinity]) {
    if (box.x1 > cursor && box.x0 < edge) spanned++;
    cursor = edge;
  }
  return spanned;
}

/**
 * 把跨栏合并块按栏带切成片段，每个片段的 y 范围取该栏带内兄弟块未占用的
 * 最大空隙，再在顶到邻段边界的那些端上收缩一个栏内留白。
 *
 * 为什么空隙最大：合并块在这一栏的内容只能放在邻居没占的地方，而它通常是
 * 该栏最大的那块空白（邻段之间的栏内留白很小）。取最大空隙在三栏夹具上恢复
 * 出的几何与真实值相差几磅，且只会偏高不会偏低——偏高安全，片段比内容高一
 * 点，绝不压到邻居。
 *
 * 为什么还要收缩：空隙的两端顶在邻段边界上，而邻段与真实内容之间还有一层栏
 * 留白（三栏实测 6.77 与 7.09 磅，约为字号的 0.8 倍）。不收缩的话片段会盖住
 * 邻段的第一行。合并块 bbox 自身的两端是内容真实的起点与终点，那两端不收。
 *
 * `fontSize` 取不到时（0 或负数）不收缩，退回纯空隙——那时宁可盖住邻段一点，
 * 也不要凭一个猜出来的字号把内容切掉。
 */
export function splitBlockByColumns(
  box: ColumnBox,
  siblings: ColumnBox[],
  edges: number[],
  fontSize = 0,
): ColumnFragment[] {
  if (edges.length === 0) {
    return [{ ...normalize(box), bandStart: -Infinity, bandEnd: Infinity }];
  }

  const bounds = [-Infinity, ...edges, Infinity];
  // 邻段边界到真实内容的栏内留白。字号为 0 时设 0，等价于不收缩。
  const margin = fontSize > 0 ? fontSize * INNER_MARGIN_RATIO : 0;
  const top = Math.min(box.y0, box.y1);
  const bottom = Math.max(box.y0, box.y1);

  const fragments: ColumnFragment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const bandStart = bounds[i];
    const bandEnd = bounds[i + 1];

    // 只算 x 完全落在这个栏带里的兄弟块——跨栏的邻居会把两个栏带都算脏。
    const bandSiblings = siblings.filter(
      (s) => s.x0 >= bandStart - 0.5 && s.x1 <= bandEnd + 0.5,
    );

    // 片段的左右界用栏带内兄弟块的极值夹，不直接用栏界。栏界是栏间空白的中点，
    // 落在空白里：attention-reading 第 2 页栏界 297.5，而真实栏 1 右界 284.62、
    // 栏 2 左界 310.13，按栏界切会让片段 1 向右伸进栏 2 十二磅多。栏内正常块
    // 的 x0 与 x1 才是栏缘的真值——这正是"栏检测是纯几何问题，不需要版面检测
    // 模型"的依据。三栏上这一夹把片段从 42.75–210.00 收成 42.75–201.66，与
    // PyMuPDF 量出的真实片段一致。
    let left = Math.max(box.x0, bandStart);
    let right = Math.min(box.x1, bandEnd);
    if (bandSiblings.length > 0) {
      const innerLeft = Math.min(...bandSiblings.map((s) => s.x0));
      const innerRight = Math.max(...bandSiblings.map((s) => s.x1));
      if (innerLeft > left) left = innerLeft;
      if (innerRight < right) right = innerRight;
    }
    if (right - left <= 1) continue;

    const gap = largestYGap(box, bandSiblings);
    if (!gap) continue;

    let y0 = gap.y0;
    let y1 = gap.y1;
    // 上端不是合并块的起点，说明它顶在邻段的下界上，那里还有一层栏内留白。
    if (y1 < bottom - 0.5) y1 -= margin;
    // 下端不是合并块的终点，同理。
    if (y0 > top + 0.5) y0 += margin;
    if (y1 - y0 <= 1) continue;

    fragments.push({
      x0: left,
      x1: right,
      y0,
      y1,
      bandStart,
      bandEnd,
    });
  }
  return fragments.length > 0 ? fragments : [{ ...normalize(box), bandStart: -Infinity, bandEnd: Infinity }];
}

/**
 * 在 `box` 的 y 范围内，找没有被 `siblings` 占用的最大空隙。
 *
 * 做法：把兄弟块的 y 区间排序合并，取补集里与 box 相交的最大一段。
 */
export function largestYGap(
  box: ColumnBox,
  siblings: ColumnBox[],
): { y0: number; y1: number } | null {
  const lo = Math.min(box.y0, box.y1);
  const hi = Math.max(box.y0, box.y1);
  const intervals = siblings
    .map((s) => ({ a: Math.min(s.y0, s.y1), b: Math.max(s.y0, s.y1) }))
    .filter((iv) => iv.b > lo && iv.a < hi)
    .sort((p, q) => p.a - q.a);

  let cursor = lo;
  let best: { y0: number; y1: number } | null = null;
  for (const iv of intervals) {
    if (iv.a > cursor) {
      const candidate = { y0: cursor, y1: Math.min(iv.a, hi) };
      if (!best || candidate.y1 - candidate.y0 > best.y1 - best.y0) best = candidate;
    }
    cursor = Math.max(cursor, iv.b);
    if (cursor >= hi) break;
  }
  if (cursor < hi) {
    const candidate = { y0: cursor, y1: hi };
    if (!best || candidate.y1 - candidate.y0 > best.y1 - best.y0) best = candidate;
  }
  return best && best.y1 - best.y0 > 1 ? best : null;
}

/**
 * 把一段文本按各片段的面积容量切成词切片。
 *
 * 容量 = 片段宽 × 片段高度。行高系数用 1.347——那是 58 个真实样本上
 * `块高 / (字号 × 行数)` 的中位数，10 分位 1.275、90 分位 1.413。它只用来
 * 给各片段分配词数比例，绝对精度不影响正确性：渲染端本来就要重新折行。
 *
 * 词切片按空白边界切，不切断单词。最后一个片段吃掉剩余部分，保证一个字都
 * 不丢。
 */
export function allocateText(text: string, fragments: ColumnFragment[]): string[] {
  if (fragments.length <= 1) return [text];
  const trimmed = text.trim();
  if (!trimmed) return fragments.map(() => "");

  const weights = fragments.map((f) => Math.max(1, (f.x1 - f.x0) * (f.y1 - f.y0)));
  const total = weights.reduce((a, b) => a + b, 0);

  const words = trimmed.split(/\s+/);
  const out: string[] = [];
  let consumed = 0;
  for (let i = 0; i < fragments.length; i++) {
    const remainingFragments = fragments.length - i;
    if (i === fragments.length - 1) {
      out.push(words.slice(consumed).join(" "));
      break;
    }
    const share = Math.round((weights[i] / total) * words.length);
    // 至少留一个词给后面的片段，否则后面的片段会是空的。
    const take = Math.max(1, Math.min(share, words.length - consumed - (remainingFragments - 1)));
    out.push(words.slice(consumed, consumed + take).join(" "));
    consumed += take;
  }
  return out;
}

function normalize(box: ColumnBox): ColumnBox {
  return {
    x0: Math.min(box.x0, box.x1),
    x1: Math.max(box.x0, box.x1),
    y0: Math.min(box.y0, box.y1),
    y1: Math.max(box.y0, box.y1),
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
