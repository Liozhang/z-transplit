#!/usr/bin/env python3
"""
benchmark metrics — z-transplit 版面保留翻译的评测度量库。

这个文件只放"怎么算数"，不放"怎么跑"。编排在 run.py，无头渲染驱动在
render-entry.ts，三份东西经文件交换数据，互不 import。

三组指标，对应三条可以单独成立的真值链：

  A 组 解析层    原文 PDF → OpenDataLoader JSON → 与答案键比对
  B 组 端到端层  原文 PDF + ODL JSON → 真实装配与渲染 → 译文 PDF → 度量
  C 组 扫描件层  侧车 result.json → 与 reading-brain 的已知原文比对

坐标系全文只有一套：PDF 用户空间，原点在页面左下角，y 向上，单位点。
OpenDataLoader 的 "bounding box" 就是 [左, 下, 右, 上]，直接可用；
pymupdf 的 span bbox 与 drawings rect 是左上原点 y 向下，必须先翻——
忘这一步会让所有 IoU 整体镜像，而数字看起来仍然"合理"，是最难发现的
一类错。因此翻转函数只有一个入口 flip_y，并且自检里有一条专门断言它。

自检：python scripts/qa/benchmark/metrics.py --selftest
用合成小样本断言每个指标都能抓住已知扰动。指标抓不住扰动比没有指标更糟：
它会给出一个好看的绿脸。
"""

from __future__ import annotations

import argparse
import difflib
import math
import sys
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------


@dataclass
class Box:
    """PDF 用户空间矩形：原点左下，y 向上。"""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    def union_with(self, other: "Box") -> "Box":
        return Box(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )

    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)

    def diagonal(self) -> float:
        return math.hypot(self.w, self.h)

    def intersect(self, other: "Box") -> float:
        """交集面积。"""
        return (
            max(0.0, min(self.x1, other.x1) - max(self.x0, other.x0))
            * max(0.0, min(self.y1, other.y1) - max(self.y0, other.y0))
        )

    def shrink(self, pt: float) -> "Box":
        """四边各向内收 pt 磅。收穿了就返回零面积框。"""
        if self.w <= 2 * pt or self.h <= 2 * pt:
            return Box(self.x0, self.y0, self.x0, self.y0)
        return Box(self.x0 + pt, self.y0 + pt, self.x1 - pt, self.y1 - pt)

    def contains_pt(self, x: float, y: float) -> bool:
        return self.x0 <= x <= self.x1 and self.y0 <= y <= self.y1

    def contains(self, other: "Box") -> bool:
        """完整包含另一个框（边界相等也算）。"""
        return (
            self.x0 <= other.x0
            and other.x1 <= self.x1
            and self.y0 <= other.y0
            and other.y1 <= self.y1
        )


def iou(a: Box, b: Box) -> float:
    """交并比。两个都是零面积框时返回 0，不除零。"""
    inter = a.intersect(b)
    union = a.area() + b.area() - inter
    if union <= 0:
        return 0.0
    return inter / union


def flip_y(raw: list[float], page_height: float) -> Box:
    """pymupdf 的 [x0, y0, x1, y1]（左上原点 y 向下）翻成 PDF 用户空间。"""
    x0, y0, x1, y1 = raw[0], raw[1], raw[2], raw[3]
    return Box(min(x0, x1), page_height - max(y0, y1), max(x0, x1), page_height - min(y0, y1))


def odl_box(raw) -> Box | None:
    """OpenDataLoader 的 [左, 下, 右, 上] → Box。顺序颠倒的输入自动交换。"""
    if not isinstance(raw, (list, tuple)) or len(raw) < 4:
        return None
    try:
        vals = [float(v) for v in raw[:4]]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in vals):
        return None
    left, bottom, right, top = vals
    return Box(min(left, right), min(bottom, top), max(left, right), max(bottom, top))


# ---------------------------------------------------------------------------
# 文本相似度
# ---------------------------------------------------------------------------


def norm_text(text: str) -> str:
    """归一化：压掉所有连续空白，去掉首尾。

    解析器把一段里的换行并成一个空格，HTML 源码里同一个换行是换行符。
    两边先过同一个归一化才谈得上比对。
    """
    return " ".join((text or "").split())


def text_sim(a: str, b: str) -> float:
    """0 到 1 的相似度。用标准库的序列匹配比，够用且不引第三方依赖。"""
    a = norm_text(a)
    b = norm_text(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def kendall_tau(order_a: list[int], order_b: list[int]) -> float:
    """两组同一批元素的名次之间的 Kendall tau。

    元素用同一个标识集合。返回 -1（完全相反）到 1（完全一致）。任一组为空
    或元素集不同时返回 0.0 并让调用方知道"算不了"，不返回一个看起来像
    结论的数字。
    """
    if len(order_a) != len(order_b) or not order_a:
        return 0.0
    if set(order_a) != set(order_b):
        return 0.0
    rank_b = {key: i for i, key in enumerate(order_b)}
    seq = [rank_b[key] for key in order_a]
    concordant = 0
    discordant = 0
    for i in range(len(seq)):
        for j in range(i + 1, len(seq)):
            if seq[i] < seq[j]:
                concordant += 1
            elif seq[i] > seq[j]:
                discordant += 1
    total = concordant + discordant
    if total == 0:
        return 0.0
    return (concordant - discordant) / total


# ---------------------------------------------------------------------------
# OpenDataLoader JSON 摊平
# ---------------------------------------------------------------------------


@dataclass
class OdlBlock:
    """一个带文字的版面元素。order 是整篇文档里的出现次序，即阅读顺序。"""

    order: int
    page: int
    type: str
    text: str
    size: float
    box: Box
    level: int | None = None


@dataclass
class OdlTable:
    page: int
    box: Box
    rows: int
    cols: int


@dataclass
class OdlImage:
    page: int
    box: Box


@dataclass
class OdlDoc:
    blocks: list[OdlBlock] = field(default_factory=list)
    tables: list[OdlTable] = field(default_factory=list)
    images: list[OdlImage] = field(default_factory=list)

    def blocks_on(self, page: int) -> list[OdlBlock]:
        return [b for b in self.blocks if b.page == page]


# 带文字的元素类型。表格单元格里的段落也是其中之一。
_TEXT_TYPES = {"paragraph", "heading", "caption", "citation", "list item"}
# 容器类型：本身不带文字，但要继续往下走。
_KIDS_KEYS = ("kids", "listItems", "list items")


def flatten_odl(doc: dict) -> OdlDoc:
    """把 OpenDataLoader 的嵌套 JSON 摊平成一个带文档次序的扁平列表。

    为什么要自己走一遍：装配层只读 page.textBlocks，把表格、列表、页眉页脚
    全丢在一边；度量要看全貌，就得按文档顺序把每一种容器都走到底。次序计数器
    只对带文字的元素递增，这样它才等于阅读顺序。
    """
    out = OdlDoc()
    if not isinstance(doc, dict):
        return out
    counter = [0]

    def page_of(node: dict) -> int:
        value = node.get("page number")
        return int(value) if isinstance(value, (int, float)) else 0

    def visit(node, inherited_page: int) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item, inherited_page)
            return
        if not isinstance(node, dict):
            return
        page = page_of(node) or inherited_page
        kind = node.get("type")

        if kind in _TEXT_TYPES:
            text = norm_text(str(node.get("content", "")))
            box = odl_box(node.get("bounding box"))
            if text and box is not None:
                size = node.get("font size")
                level = node.get("heading level")
                out.blocks.append(
                    OdlBlock(
                        order=counter[0],
                        page=page,
                        type=str(kind),
                        text=text,
                        size=float(size) if isinstance(size, (int, float)) else 0.0,
                        box=box,
                        level=int(level) if isinstance(level, (int, float)) else None,
                    )
                )
                counter[0] += 1
            # 列表项可能还嵌着段落，继续往下。
            for key in _KIDS_KEYS:
                if key in node:
                    visit(node[key], page)
            return

        if kind == "table":
            box = odl_box(node.get("bounding box"))
            if box is not None:
                out.tables.append(
                    OdlTable(
                        page=page,
                        box=box,
                        rows=int(node.get("number of rows") or 0),
                        cols=int(node.get("number of columns") or 0),
                    )
                )
            for row in node.get("rows") or []:
                if isinstance(row, dict):
                    for cell in row.get("cells") or []:
                        visit(cell, page)
            return

        if kind in ("image", "chart"):
            box = odl_box(node.get("bounding box"))
            if box is not None:
                out.images.append(OdlImage(page=page, box=box))
            return

        # header / footer / textBlock / formula / 未知容器：只往下走。
        for key in _KIDS_KEYS:
            if key in node:
                visit(node[key], page)

    visit(doc.get("kids"), 1)
    return out


# ---------------------------------------------------------------------------
# A 组：解析层
# ---------------------------------------------------------------------------


def _prf(tp: int, fp: int, fn: int) -> dict:
    """精确率/召回率/F1。一样本都没有时三项报 None——那叫"不适用"，不是 0。

    报 0 的后果很具体：reading-brain 一篇公式都没有，报出来是"公式判域全错"，
    门禁还会拿这个假 0 当回归基线，将来任何人改公式判域都会触发误报。
    """
    if tp + fp + fn == 0:
        return {
            "tp": 0,
            "fp": 0,
            "fn": 0,
            "precision": None,
            "recall": None,
            "f1": None,
            "applicable": False,
        }
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "applicable": True,
    }


def formula_detection(
    key: dict,
    odl: OdlDoc,
    flagged_texts: set[tuple[int, str]],
    pairs: list[tuple[int, int]],
) -> dict:
    """公式判域的精确率与召回率。

    flagged_texts 是装配层真正标出来的公式集合，键为 (页码, 归一化文本)。
    真值来自答案键里标了 formula 的元素。

    预测必须先经配对映回真值元素才能比。答案键的 order 与解析器产出的 order
    是两个编号空间：答案键只有 30 个元素，解析器有 62 个块（表格单元格、图内
    标注都算块）。直接拿两个 order 集合求交，只在两边条数恰好相等时才碰巧
    正确——formula-dense 是 26 对 26 所以数字对，attention-reading 是 30 对 62
    于是恒为 0。这种"有时对"比恒错更难发现。

    另外单独列出已知的边界样本。聚合数字会把它们平均掉，而修批次 1 要看的
    正是这几个具体段落各自的去向。
    """
    element_by_order = {e["order"]: e for e in key.get("elements", [])}
    block_by_order = {b.order: b for b in odl.blocks}
    block_to_element = {block_order: element_order for element_order, block_order in pairs}

    flagged_blocks = [b for b in odl.blocks if (b.page, b.text) in flagged_texts]
    truth_elements = {o for o, e in element_by_order.items() if e.get("formula")}

    predicted_elements: set[int] = set()
    tp = 0
    fp = 0
    for block in flagged_blocks:
        element_order = block_to_element.get(block.order)
        element = element_by_order.get(element_order) if element_order is not None else None
        # 凡是真被标成公式的块，都算"预测为公式"——不管真值是不是公式。只把配到
        # 公式真值的记进 predicted_elements 的话，逐案表的预测列会把假阳性显示成
        # "预测正文"，正好把最该看的三个失败样本藏起来。
        if element_order is not None:
            predicted_elements.add(element_order)
        if element is not None and element.get("formula"):
            tp += 1
        else:
            # 标了公式但没有配到公式段：要么是多标了一个正文段，要么标的是答案键
            # 里没有的东西（图内标注之类）。两种都算假阳性。
            fp += 1
    fn = len(truth_elements - predicted_elements)
    result = _prf(tp, fp, fn)

    cases = []
    for element in key.get("elements", []):
        order = element["order"]
        block_order = next((b for e, b in pairs if e == order), None)
        block = block_by_order.get(block_order) if block_order is not None else None
        cases.append(
            {
                "order": order,
                "truth": bool(element.get("formula")),
                "predicted": order in predicted_elements,
                "hardCase": element.get("hardCase"),
                "text": (block.text if block else element.get("text", ""))[:70],
            }
        )
    result["cases"] = cases
    result["hardCaseFailures"] = [
        c for c in cases if c["hardCase"] and c["truth"] != c["predicted"]
    ]
    return result


def match_elements(key: dict, odl: OdlDoc, min_sim: float = 0.6) -> dict:
    """答案键元素与解析器产出的文本块做贪心一对一匹配。

    答案键不带页码（HTML 没有页的概念），所以匹配只用文本相似度，全局进行。
    位置对不对由阅读顺序那一项间接约束：匹配对的名次若不单调，Kendall tau
    会掉下来。把两件事混在一个指标里，出了偏差说不清是分割错了还是顺序错了。
    """
    elements = key.get("elements", [])
    used: set[int] = set()
    pairs: list[tuple[dict, OdlBlock, float]] = []

    # 候选对按相似度从高到低消化，先配强的，避免一个泛泛匹配抢走唯一的块。
    candidates: list[tuple[float, int, int]] = []
    for ei, element in enumerate(elements):
        text = element.get("text", "")
        if not norm_text(text):
            continue
        for block in odl.blocks:
            if block.order in used:
                continue
            sim = text_sim(text, block.text)
            if sim >= min_sim:
                candidates.append((sim, ei, block.order))
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
    taken_elements: set[int] = set()
    for sim, ei, order in candidates:
        if ei in taken_elements or order in used:
            continue
        taken_elements.add(ei)
        used.add(order)
        block = next(b for b in odl.blocks if b.order == order)
        pairs.append((elements[ei], block, sim))

    matched_elements = {e["order"] for e, _, _ in pairs}
    truth_orders = {e["order"] for e in elements if norm_text(e.get("text", ""))}
    tp = len(matched_elements)
    fn = len(truth_orders - matched_elements)
    # 假阳性是"解析器多产出的块"：总块数减去被真值认领的块数。早先一版写成
    # 已用块减已配元素，两边是不同的编号空间（一个在下标解析块、一个在下标
    # 真值元素），数字会随两边下标巧合而跳动，且恒接近 0，等于没有这一项。
    fp = len(odl.blocks) - len(pairs)
    result = _prf(tp, fp, fn)

    by_type: dict[str, dict] = {}
    for element in elements:
        if not norm_text(element.get("text", "")):
            continue
        kind = element.get("type", "body")
        slot = by_type.setdefault(kind, {"total": 0, "matched": 0})
        slot["total"] += 1
        if element["order"] in matched_elements:
            slot["matched"] += 1
    result["byType"] = {
        kind: {**slot, "recall": slot["matched"] / slot["total"] if slot["total"] else 0.0}
        for kind, slot in sorted(by_type.items())
    }
    result["meanSim"] = sum(s for _, _, s in pairs) / len(pairs) if pairs else 0.0
    # 配对关系交给阅读顺序那一项用：顺序错乱等于译文错位，但它与"分割对不对"
    # 是两个问题，必须分开算，否则出了偏差说不清是哪一个。
    result["pairs"] = [(e["order"], b.order) for e, b, _ in pairs]
    return result


def measured_column_width(boxes: list[Box], page_width: float = 0.0) -> float:
    """用同页段落框宽度的众数估计真实栏宽。

    不用"页宽 / 答案键栏数"：那个数把栏间隔也摊进了栏宽。三栏 A4 上
    594.96/3 = 198.32，而真实栏宽是 158.906（左缘 42.75、栏宽 158.906、
    栏间隔 16.016），高估四分之一——宽度阈值会漏判，275.66 的图内标签合并
    段因此差 2 磅落选。

    取众数而不是中位数：正常栏内段宽度完全一致，是分布的主峰；通栏标题与
    图注是少数，碎片行宽度杂乱但个数少。中位数在块数少时会漂——一页只有
    "一个宽块加一个窄块"时，偶数个元素的上中位数正好落在宽块上，阈值会被
    抬到所有段落都不超，串位全部漏报。众数平票时取较小值，偏向栏内段。

    众数必须占到块数的四分之一以上、且至少两个，才算"这一页有统一栏宽"。
    横版幻灯片每页布局都不同，17 个块里最频的宽度只出现 3 次且是 8 磅——那是
    坐标轴刻度标签，不是栏宽。没有主流宽度就退回页宽，等于这一页不判串位：
    判断不了比误判好。
    """
    if not boxes:
        return page_width
    counts: dict[float, int] = {}
    for b in boxes:
        key = round(b.w, 1)
        counts[key] = counts.get(key, 0) + 1
    best_width = 0.0
    best_count = 0
    for width in sorted(counts):  # 升序，平票时先遇到小值
        if counts[width] > best_count:
            best_count = counts[width]
            best_width = width
    if best_count < max(2, math.ceil(len(boxes) / 4)):
        return page_width
    return best_width


def merged_block_count(boxes: list[Box]) -> int:
    """bbox 完整包含至少三个同页其它段落的块数。

    这是"多栏文本被合并成一个块"的直接证据。解析器的阅读顺序算法把跨栏流式
    排版并成一段，产出的框是多个矩形片的并集，几何上吞掉同页其它块。宽度判据
    分不清"合法通栏元素"与"跨栏合并"——通栏标题虽宽，但不包住别人；这个判据
    能，因为吞掉邻段正是合并的副产品。
    """
    count = 0
    for i, a in enumerate(boxes):
        contained = 0
        for j, b in enumerate(boxes):
            if i == j:
                continue
            if a.contains(b):
                contained += 1
        if contained >= 3:
            count += 1
    return count


def column_bleed(key: dict, odl: OdlDoc, page_widths: dict[int, float]) -> dict:
    """栏串位：解析器产出横跨多栏的宽框的比例。

    阈值 0.6 是页宽的六成。一个正常的单栏段落（含通栏标题）可能到 0.9，
    所以这一项报两个数：超过 0.6 的比例，以及超过实测栏宽 1.4 倍的比例。
    第二个数才是"跨栏"的直接证据，但它对合法通栏元素无解——图注与标题本来
    就该超宽，所以它有一个下不去的最低值。

    真正该门禁的是 mergedBlockRatio：跨栏合并块吞掉邻段，通栏元素不吞。
    """
    columns = key.get("columns", 1)
    by_page: dict[int, list] = {}
    for block in odl.blocks:
        by_page.setdefault(block.page, []).append(block)

    wide_blocks = 0
    cross_blocks = 0
    merged_blocks = 0
    total = 0
    worst: list[dict] = []
    for page, blocks in by_page.items():
        width = page_widths.get(page)
        if not width:
            continue
        boxes = [b.box for b in blocks]
        column_width = measured_column_width(boxes, width)
        threshold = column_width * 1.4 if column_width > 0 else width
        merged_blocks += merged_block_count(boxes)
        for block in blocks:
            total += 1
            ratio = block.box.w / width
            if ratio > 0.6:
                wide_blocks += 1
            if block.box.w > threshold:
                cross_blocks += 1
                worst.append(
                    {"page": page, "ratio": round(ratio, 3), "text": block.text[:60]}
                )
    worst.sort(key=lambda w: -w["ratio"])
    return {
        "blocks": total,
        "columns": columns,
        "wideRatio": wide_blocks / total if total else 0.0,
        "crossColumnRatio": cross_blocks / total if total else 0.0,
        "mergedBlockRatio": merged_blocks / total if total else 0.0,
        "worst": worst[:5],
    }


def heading_levels(key: dict, odl: OdlDoc, pairs: list[tuple[int, int]]) -> dict:
    """标题层级一致率。

    解析器的 heading level 是 1 到 21 的嵌套深度，不是 HTML 的 h1 到 h3。
    所以不比绝对数值，只比深浅次序：对每一对同为标题的真值与预测，看它们的
    相对高低是否一致。比较对象必须经配对取到，不能按 order 直接对上——同
    公式那一项，两个 order 是不同编号空间。
    """
    element_by_order = {e["order"]: e for e in key.get("elements", [])}
    block_by_order = {b.order: b for b in odl.blocks}
    shared: list[tuple[int, int]] = []
    for element_order, block_order in pairs:
        element = element_by_order.get(element_order)
        block = block_by_order.get(block_order)
        if not element or not block:
            continue
        if element.get("type") != "heading" or block.type != "heading":
            continue
        if not element.get("level") or not block.level:
            continue
        shared.append((element["level"], block.level))
    agree = 0
    total = 0
    for i in range(len(shared)):
        for j in range(i + 1, len(shared)):
            total += 1
            if (shared[i][0] - shared[j][0] > 0) == (shared[i][1] - shared[j][1] > 0):
                agree += 1
    truth_headings = sum(1 for e in key.get("elements", []) if e.get("type") == "heading")
    predicted_headings = sum(1 for b in odl.blocks if b.type == "heading")
    return {
        "pairs": total,
        "agreement": agree / total if total else 0.0,
        "sharedHeadings": len(shared),
        "truthHeadings": truth_headings,
        "predictedHeadings": predicted_headings,
    }


def table_structure(key: dict, odl: OdlDoc) -> dict:
    """表格结构误差：行数列数的绝对差，以及跨格跨度的一致情况。"""
    key_tables = key.get("tables", [])
    odl_tables = odl.tables
    rows = sorted(t.get("rows", 0) for t in key_tables)
    cols = sorted(t.get("cols", 0) for t in key_tables)
    got_rows = sorted(t.rows for t in odl_tables)
    got_cols = sorted(t.cols for t in odl_tables)
    return {
        "truthCount": len(key_tables),
        "predictedCount": len(odl_tables),
        "rows": {"truth": rows, "predicted": got_rows},
        "cols": {"truth": cols, "predicted": got_cols},
        "rowError": sum(abs(a - b) for a, b in zip(rows, got_rows)) if rows and got_rows else None,
        "colError": sum(abs(a - b) for a, b in zip(cols, got_cols)) if cols and got_cols else None,
    }


def reading_order(key: dict, odl: OdlDoc, matched_pairs: list[tuple[int, int]]) -> dict:
    """阅读顺序：答案键文档序对解析器产出序的 Kendall tau。

    直接在配对对上数一致对与不一致对，不调 kendall_tau：那个函数要求两组元素
    属于同一个集合，而这里一组是真值下标、一组是解析器块下标，集合本来就不同。
    照它写的第一个版本在两边的块数不相等时恒返回 0，看起来像"阅读顺序完全
    乱"，其实只是集合不同。
    """
    if len(matched_pairs) < 2:
        return {"tau": 0.0, "pairs": len(matched_pairs)}
    ordered = sorted(matched_pairs)
    concordant = 0
    discordant = 0
    for i in range(len(ordered)):
        for j in range(i + 1, len(ordered)):
            if ordered[i][1] < ordered[j][1]:
                concordant += 1
            elif ordered[i][1] > ordered[j][1]:
                discordant += 1
    total = concordant + discordant
    return {
        "tau": (concordant - discordant) / total if total else 0.0,
        "pairs": len(matched_pairs),
    }


def figure_detection(key: dict, odl: OdlDoc) -> dict:
    """图区检出。

    已知差异：SVG 进 PDF 之后是矢量图形，解析器提不到图元素，只能看到一堆
    文字。所以这一项只记录，不进门禁——拿一个必然检不出的东西当门禁，只会
    训练人忽略门禁。
    """
    truth = len(key.get("figures", []))
    predicted = len(odl.images)
    return {
        "truth": truth,
        "predicted": predicted,
        "note": "SVG 矢量图不进解析器的图元素，检出数天然低于真值",
    }


# 图内文字判据：字号相对该页文字跨度字号中位数的比例上限。
FIGURE_TEXT_SIZE_RATIO = 0.8
# 矢量路径分簇的间隙阈值，按页高的比例取。
FIGURE_CLUSTER_GAP_RATIO = 0.03


def median_font_size(spans: list[tuple[float, Box]]) -> float | None:
    """文字跨度字号的中位数。空表返回 None——不适用，不报 0。

    为什么是中位数不是众数：横版幻灯片那一页的字号众数是 6.75，而那正是图内
    文字的字号。按众数取阈值会得 5.40，一篇图内文字都检不出。中位数 10.24
    正常。五篇夹具上逐一量过，中位数在两个方向上都稳。
    """
    sizes = sorted(size for size, _ in spans)
    if not sizes:
        return None
    n = len(sizes)
    mid = n // 2
    return sizes[mid] if n % 2 else (sizes[mid - 1] + sizes[mid]) / 2


def vector_clusters(rects: list[Box], gap: float) -> list[Box]:
    """把矢量路径的包围盒按间隙贪心合并成簇。

    为什么要分簇而不能用全局并集：通栏元素与页面装饰会把并集拉到接近整页，
    全局并集内的文字从表格正文到标题全都有（attention-reading 页 1 实测并集
    内有 77 个跨度，字号从 6.0 到 10.99）。分簇之后每个簇才对应一块真实的
    图形区域。

    间隙阈值故意取粗（页高的 3%）：三栏那篇的装饰栏线与图只隔 6.8 磅，任何
    精细阈值都会把它们并成一簇。并成一簇不可怕——簇内正文靠字号条件挡掉，
    见 figure_text 的判据。真正要防的是把两个相隔很远的图形合成一簇。
    """
    ordered = sorted(rects, key=lambda r: (r.x0, r.y0))
    clusters: list[Box] = []
    for rect in ordered:
        for index, cluster in enumerate(clusters):
            if (
                rect.x0 <= cluster.x1 + gap
                and cluster.x0 <= rect.x1 + gap
                and rect.y0 <= cluster.y1 + gap
                and cluster.y0 <= rect.y1 + gap
            ):
                # union_with 返回新 Box 而不原地改，所以要把返回值放回列表。
                clusters[index] = cluster.union_with(rect)
                break
        else:
            clusters.append(Box(rect.x0, rect.y0, rect.x1, rect.y1))
    return clusters


def figure_text_span_boxes(
    spans: list[tuple[float, Box]],
    clusters: list[Box],
    median: float | None,
) -> list[Box]:
    """按判据挑出图内文字的跨度框。

    两个条件同时满足：字号小于中位数的 0.8 倍，且跨度中心落在某个矢量簇内。

    字号条件是主力：五篇上图内文字字号 6.00 与 6.75，正文 8.50 起，比值
    0.61 到 0.71，都在阈值内。簇条件是护栏，挡掉"正文里恰好有小字号"的情形
    ——脚注、上标、参考文献小字通常不在图形区域里。

    表格文字因此不误伤：attention-reading 页 1 的表格文字字号 8.20，与中位数
    8.80 的比值 0.93，过不了字号这一关。
    """
    if median is None or median <= 0:
        return []
    limit = median * FIGURE_TEXT_SIZE_RATIO
    hits: list[Box] = []
    for size, box in spans:
        if size >= limit:
            continue
        cx = (box.x0 + box.x1) / 2
        cy = (box.y0 + box.y1) / 2
        if any(c.x0 <= cx <= c.x1 and c.y0 <= cy <= c.y1 for c in clusters):
            hits.append(box)
    return hits


def figure_text(key: dict, assembly: dict, source_pdf: str) -> dict:
    """图内文字被当成正文处理的程度。

    量三件事，层层递进：
      truth      答案键的图内文字跨度真值，来自夹具 HTML 的 SVG <text> 节点
                 （ FixtureHtmlParser 数出来的，与解析器无关）
      detected   判据从源 PDF 检出的跨度数——用来验证判据本身准不准
      paragraphs 装配段落里落在检出并集内的数量——产品实际把多少图内文字
                 当正文翻译、画遮罩、删原文、叠译文

    为什么读源 PDF 不读译文 PDF：译文里原文可能已被删除器删掉，从译文数不出
    来。源 PDF 的文本层与矢量路径都是完整的。

    为什么这一项进门禁而 figure_detection 不进：figure_detection 量的是解析器
    必然检不出的东西；这一项量的是产品行为，基线记下当前值，产品侧改了降下来
    是改善，不改则一直绿，不会假红。
    """
    fitz = _fitz()
    truth = sum(f.get("textSpans", 0) or 0 for f in key.get("figures", []))

    pages = {p.get("pageNumber"): p for p in assembly.get("pages", [])}
    detected = 0
    as_body = 0
    by_page: dict[str, int] = {}
    usable = False

    doc = fitz.open(source_pdf)
    try:
        for page in doc:
            height = page.rect.height
            spans: list[tuple[float, Box]] = []
            for block in page.get_text("dict").get("blocks", []):
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text = span.get("text", "")
                        if not text.strip():
                            continue
                        spans.append(
                            (float(span.get("size", 0.0)), flip_y(span["bbox"], height))
                        )
            if not spans:
                continue
            usable = True
            median = median_font_size(spans)
            rects = [flip_y(list(d["rect"]), height) for d in page.get_drawings()]
            clusters = vector_clusters(rects, height * FIGURE_CLUSTER_GAP_RATIO)
            hits = figure_text_span_boxes(spans, clusters, median)
            detected += len(hits)

            # 与装配段落配对：段落框与任一检出跨度框有交集即算被当正文处理。
            #
            # 不能用"段落中心落在跨度内"：一个段落常含多个图内跨度，三栏的
            # `Wk 1 Wk 3 Wk 5 Wk 6` 是 4 个跨度并成一段，段落中心落在 Wk 3 与
            # Wk 5 之间的空档里，按中心判会把这段整个漏掉——而它恰恰是最显眼
            # 的一处图内文字。
            paragraph = pages.get(page.number + 1)
            if not paragraph or not hits:
                continue
            count = 0
            for para in paragraph.get("paragraphs", []):
                box = Box(para.get("x0", 0), para.get("y0", 0), para.get("x1", 0), para.get("y1", 0))
                overlaps = any(box.intersect(h) > 0 for h in hits)
                if overlaps:
                    count += 1
            as_body += count
            by_page[str(page.number + 1)] = count
    finally:
        doc.close()

    if not usable:
        return {
            "truth": truth,
            "detected": None,
            "paragraphs": None,
            "note": "源 PDF 无文字跨度，判据不适用",
        }
    return {
        "truth": truth,
        "detected": detected,
        "paragraphs": as_body,
        "byPage": by_page,
        "note": (
            "图内文字按「字号小于该页中位字号的 0.8 倍且落在矢量路径簇内」检出；"
            "figureTextFilter 依赖的 --inspect 在五篇夹具上返回 0，排除从未生效"
        ),
    }


# ---------------------------------------------------------------------------
# B 组：端到端版面
# ---------------------------------------------------------------------------


def _fitz():
    """延迟导入 pymupdf。A 组与 C 组不需要它，自检的核心断言也不应该被一个
    可选的第三方库挡住。"""
    try:
        import fitz  # type: ignore

        return fitz
    except Exception as exc:  # pragma: no cover - 环境相关
        raise RuntimeError(
            "pymupdf 不可用（pip install pymupdf）。B 组指标需要它渲染位图并"
            "提取译文 PDF 的文本与坐标。"
        ) from exc


def fitz_module():
    """公开的 pymupdf 入口。延迟导入，让 A 组、C 组与自检在没装 pymupdf 的
    环境里也能跑。"""
    return _fitz()


@dataclass
class TranslatedSpan:
    box: Box
    size: float
    text: str
    color: int
    font: str


def _has_cjk(text: str) -> bool:
    """这一行里有没有中日韩文字。

    叠加模式下原文内容流原样留在页里，遮罩只是拿白矩形盖住它，文本层仍能
    提取出原文。所以"译文 PDF 的文本"是原文加译文的混合，不分开就没法算
    译文落在了哪里。基准的目标语言恒为中文，用有没有中文字符区分两侧，比
    靠字体名可靠——子体内嵌前缀在原文里也可能本来就有。
    """
    return any(
        "\u3400" <= c <= "\u4dbf"
        or "\u4e00" <= c <= "\u9fff"
        or "\u3040" <= c <= "\u30ff"
        or "\uac00" <= c <= "\ud7af"
        for c in text
    )


def extract_translated_spans(pdf_path: str) -> tuple[list[list[TranslatedSpan]], list[Box], list[int]]:
    """从译文 PDF 提取每页的译文片段、白色矩形与页旋转角。

    只收译文的行：一整行里只要有中文字符就算译文行，行内混排的数字与英文
    词跟着一起收——它们是同一次绘制出来的，位置属于同一个块。

    返回 (每页译文 span 列表, 每页白色矩形列表, 每页旋转角)。所有框都翻成
    PDF 用户空间。旋转页直接报错：叠加渲染器对旋转页本就拒绝，安静地算出一
    堆错数字比报错难查得多。
    """
    fitz = _fitz()
    doc = fitz.open(pdf_path)
    pages_spans: list[list[TranslatedSpan]] = []
    pages_masks: list[list[Box]] = []
    rotations: list[int] = []
    try:
        for page in doc:
            rotation = int(page.rotation or 0)
            rotations.append(rotation)
            if rotation != 0:
                raise RuntimeError(
                    f"译文 PDF 第 {page.number + 1} 页旋转 {rotation} 度。度量假定"
                    "未旋转页面；叠加渲染路径对旋转页本就拒绝，出现这个值说明"
                    "有夹具带着 /Rotate 进来了，先补旋转页的处理再谈度量。"
                )
            height = page.rect.height
            spans: list[TranslatedSpan] = []
            data = page.get_text("dict")
            for block in data.get("blocks", []):
                for line in block.get("lines", []):
                    line_spans = line.get("spans", [])
                    if not any(_has_cjk(s.get("text", "")) for s in line_spans):
                        continue  # 原文行，遮罩盖住了但文本层还在
                    for span in line_spans:
                        text = span.get("text", "")
                        if not text.strip():
                            continue
                        spans.append(
                            TranslatedSpan(
                                box=flip_y(span["bbox"], height),
                                size=float(span.get("size", 0.0)),
                                text=text,
                                color=int(span.get("color", 0)),
                                font=str(span.get("font", "")),
                            )
                        )
            pages_spans.append(spans)

            masks: list[Box] = []
            for drawing in page.get_drawings():
                fill = drawing.get("fill")
                if not fill:
                    continue
                if not all(isinstance(c, (int, float)) and c > 0.98 for c in fill[:3]):
                    continue
                masks.append(flip_y(list(drawing["rect"]), height))
            pages_masks.append(masks)
    finally:
        doc.close()
    return pages_spans, pages_masks, rotations


def _assign_spans(
    spans: list[TranslatedSpan], paragraphs: list[dict]
) -> tuple[dict[int, list[TranslatedSpan]], int]:
    """把每个译文片段归到中心距最近的段落框。

    按段落框分组而不是按绘制调用分组：pymupdf 不知道哪几行是同一次 drawText
    画出来的，但它知道每个片段落在哪。用"落进哪个框"分组，天然处理一段对
    多行，也不需要猜渲染器的调用边界。

    归属半径取所辖框对角线的四分之一：译文整体偏移十几磅时仍然归得进原段，
    只是交并比掉下来——这正是想看到的"偏了但没跑丢"。半径定死成几磅会把
    偏移的译文整段判成未翻译，两个不同的病看起来一模一样。
    """
    boxes = []
    for index, paragraph in enumerate(paragraphs):
        box = Box(paragraph["x0"], paragraph["y0"], paragraph["x1"], paragraph["y1"])
        boxes.append((index, box))

    assigned: dict[int, list[TranslatedSpan]] = {i: [] for i, _ in boxes}
    unassigned = 0
    for span in spans:
        cx, cy = span.box.center()
        best_key = None
        best_index = None
        for index, box in boxes:
            # 片段中心到框的距离：在框内算 0，在外算到框的欧氏距离。
            dx = max(box.x0 - cx, 0.0, cx - box.x1)
            dy = max(box.y0 - cy, 0.0, cy - box.y1)
            distance = math.hypot(dx, dy)
            # 排序键：先在框内的优先，再距离近的优先，最后框小的优先。第三位是
            # 关键——解析器把多栏并成一个大块时，大块框盖住了各段自己的框，
            # 距离同样为 0，不按面积分辨就会把译文全记到大块名下。
            key = (0 if distance == 0 else 1, distance, box.area())
            if best_key is None or key < best_key:
                best_key = key
                best_index = index
        if best_index is None:
            unassigned += 1
            continue
        radius = max(2.0, 0.25 * boxes[best_index][1].diagonal())
        if best_key is not None and best_key[1] <= radius:
            assigned[best_index].append(span)
        else:
            unassigned += 1
    return assigned, unassigned


def _mask_ownership(
    masks: list[Box], paragraphs: list[dict], regions: list[Box]
) -> tuple[list[tuple[Box, Box]], int, int, int]:
    """判定每个白色矩形是不是渲染器画的遮罩，以及它越界到了哪里。

    认遮罩不能靠"白填充"：原文自己的白填充矩形（图框底色、表头底色）也是白
    的，一起算进来就会天天报假警。判据是"这个矩形有三成以上面积压在某个段落
    框上"——渲染器的遮罩本就是段落框外扩一磅，必然满足；原文里那些白矩形在
    图区表格区，压不到段落框上。

    归属取压得最多的那个段落，不取交并比最大的：通栏段落的遮罩横跨两栏，对
    自己那一栏的交并比只有五成，按交并比匹配会认错主人甚至认不出来。

    返回 (认出的遮罩与所辖段落, 遮罩总数, 压到别段的数量, 压到图区表格区的
    数量)。
    """
    boxes = [Box(p["x0"], p["y0"], p["x1"], p["y1"]) for p in paragraphs]
    owned: list[tuple[Box, Box]] = []
    intrusion_paragraph = 0
    intrusion_region = 0
    for mask in masks:
        mask_area = mask.area()
        if mask_area <= 0:
            continue
        best_index = None
        best_overlap = 0.0
        for index, box in enumerate(boxes):
            overlap = mask.intersect(box)
            if overlap > best_overlap:
                best_overlap = overlap
                best_index = index
        if best_index is None or best_overlap / mask_area < 0.3:
            continue  # 不是遮罩，是原文自带的白色填充
        owner = boxes[best_index]
        owned.append((mask, owner))
        hit_paragraph = False
        hit_region = False
        for index, box in enumerate(boxes):
            if index == best_index:
                continue
            # 遮罩压到别的段落框就算侵入，不再减掉"所辖段落本来就和这个框重叠"
            # 的部分。
            #
            # 那道减法本意是容忍通栏段落遮罩横跨两栏，实际效果是把真实的侵入
            # 也减掉了：跨栏合并块的遮罩是多个矩形片的并集，几何上完整包住同页
            # 若干邻段，此时 owner.intersect(box) == mask.intersect(box)，差值
            # 恒为 0——三栏夹具上 intrusionIntoParagraph 因此永远是 0，而那正是
            # 缺陷最严重的一篇。段落框理论上互不重叠，压到别人就该报。
            if mask.intersect(box) > 1.0:
                hit_paragraph = True
        for region in regions:
            if mask.intersect(region) - owner.intersect(region) > 1.0:
                hit_region = True
        if hit_paragraph:
            intrusion_paragraph += 1
        if hit_region:
            intrusion_region += 1
    return owned, len(masks), intrusion_paragraph, intrusion_region


def layout_metrics(
    source_pdf: str,
    translated_pdf: str,
    assembly: dict,
    stats: dict | None = None,
) -> dict:
    """B 组：版面保留的全部指标。

    assembly 是 render-entry.ts 产出的装配视图（段落框、字号、图区、表格区、
    公式块）。它是渲染器真正的输入，所以度量以它为准，而不是以原始解析产出
    为准——用渲染器没看到的框去要求译文落位，会系统性冤枉它。

    stats 是渲染端自己回吐的诊断（overflowed、overflowedRight 等）。给了它才能
    算出 silentRight——度量看见而产品没报的溢出。缺省时按产品什么都没报算。
    """
    fitz = _fitz()
    spans_by_page, masks_by_page, _ = extract_translated_spans(translated_pdf)

    per_page = []
    biou_samples: list[float] = []
    recall_samples: list[float] = []
    precision_samples: list[float] = []
    ratio_samples: list[float] = []
    small_font_count = 0
    font_sample_count = 0
    overflow_counts = {"right": 0, "bottom": 0, "top": 0}
    max_overflow = {"right": 0.0, "bottom": 0.0, "top": 0.0}
    untranslated_total = 0
    untranslated_reasons = {"noText": 0, "empty": 0}
    mask_total = 0
    intrusion_into_paragraph = 0
    intrusion_into_region = 0
    unassigned_spans = 0

    for page in assembly.get("pages", []):
        number = page["pageNumber"]
        index = number - 1
        spans = spans_by_page[index] if index < len(spans_by_page) else []
        masks = masks_by_page[index] if index < len(masks_by_page) else []
        paragraphs = page.get("paragraphs", [])

        assigned, unassigned = _assign_spans(spans, paragraphs)
        unassigned_spans += unassigned
        page_iou: list[float] = []
        page_untranslated = 0
        for position, paragraph in enumerate(paragraphs):
            own = assigned.get(position, [])
            source_text = paragraph.get("text", "")
            if not source_text.strip():
                untranslated_reasons["empty"] += 1
                continue
            if not own:
                page_untranslated += 1
                untranslated_reasons["noText"] += 1
                continue
            target = Box(paragraph["x0"], paragraph["y0"], paragraph["x1"], paragraph["y1"])
            union_box = own[0].box
            for span in own[1:]:
                union_box = union_box.union_with(span.box)
            page_iou.append(iou(union_box, target))
            # 覆盖率与滞留率分开报。译文比原文短是常态，只报交并比会把"短但
            # 位置对"和"位置错"混成一个偏低的数；拆开之后，覆盖率答"盖住了该
            # 盖的地方吗"，滞留率答"有跑出该待的地方吗"，两个问题各自看得见。
            recall_samples.append(union_box.intersect(target) / target.area() if target.area() else 0.0)
            precision_samples.append(
                union_box.intersect(target) / union_box.area() if union_box.area() else 0.0
            )
            for span in own:
                font_sample_count += 1
                ratio = span.size / paragraph["size"] if paragraph["size"] > 0 else 0.0
                ratio_samples.append(ratio)
                if ratio < 0.6:
                    small_font_count += 1
                right = span.box.x1 - target.x1
                bottom = target.y0 - span.box.y0
                top = span.box.y1 - target.y1
                if right > 1.0:
                    overflow_counts["right"] += 1
                    max_overflow["right"] = max(max_overflow["right"], right)
                if bottom > 1.0:
                    overflow_counts["bottom"] += 1
                    max_overflow["bottom"] = max(max_overflow["bottom"], bottom)
                if top > 1.0:
                    overflow_counts["top"] += 1
                    max_overflow["top"] = max(max_overflow["top"], top)
        biou_samples.extend(page_iou)
        untranslated_total += page_untranslated

        # 遮罩越界。
        regions = [Box(r["x0"], r["y0"], r["x1"], r["y1"]) for r in page.get("images", [])]
        regions += [Box(t["x0"], t["y0"], t["x1"], t["y1"]) for t in page.get("tables", [])]
        _, page_mask_total, page_para_intrusion, page_region_intrusion = _mask_ownership(
            masks, paragraphs, regions
        )
        mask_total += page_mask_total
        intrusion_into_paragraph += page_para_intrusion
        intrusion_into_region += page_region_intrusion

        per_page.append(
            {
                "page": number,
                "paragraphs": len(paragraphs),
                "translated": len(paragraphs) - page_untranslated,
                "untranslated": page_untranslated,
                "meanIou": sum(page_iou) / len(page_iou) if page_iou else 0.0,
                "masks": len(masks),
            }
        )

    sorted_ratios = sorted(ratio_samples)
    percentile_10 = (
        sorted_ratios[max(0, math.floor(0.1 * len(sorted_ratios)) - 1)] if sorted_ratios else 0.0
    )
    result = {
        "biou": sum(biou_samples) / len(biou_samples) if biou_samples else 0.0,
        "biouSamples": len(biou_samples),
        "boxRecall": sum(recall_samples) / len(recall_samples) if recall_samples else 0.0,
        "boxPrecision": sum(precision_samples) / len(precision_samples) if precision_samples else 0.0,
        "utb": untranslated_total,
        "utbReasons": untranslated_reasons,
        "overflow": {
            **overflow_counts,
            # 度量数到而产品没报的右溢出处数。产品侧（LayoutPreservingRenderer）此前
            # 只判纵向，横向溢出一处都没报过，而这一项在五篇上一共数到 10 处——读者
            # 看得见译文画出框外，产品统计却说一切正常。批 5 给渲染端补上横向计数，
            # 这一项就是那件事生效与否的直接检验，也是将来的哨兵。
            #
            # 注意它只说明"产品没有少报"，不说明"产品没有多报"：产品报得比度量多时
            # 它同样是 0。多报要靠 stats.overflowedRight 与 overflow.right 的绝对值
            # 对比人工看。
            "silentRight": max(
                0, overflow_counts["right"] - int((stats or {}).get("overflowedRight", 0) or 0)
            ),
        },
        "maxOverflow": max_overflow,
        "fontSize": {
            "median": sorted_ratios[len(sorted_ratios) // 2] if sorted_ratios else 0.0,
            "p10": percentile_10,
            "below06Ratio": small_font_count / font_sample_count if font_sample_count else 0.0,
        },
        "mask": {
            "total": mask_total,
            "intrusionIntoParagraph": intrusion_into_paragraph,
            "intrusionIntoRegion": intrusion_into_region,
        },
        "unassignedSpans": unassigned_spans,
        "perPage": per_page,
    }
    return result


def _fill_rects_with_color(page) -> list[tuple[Box, tuple[float, float, float]]]:
    """一页里所有填充矩形，连同填充色。坐标翻成 PDF 用户空间。"""
    height = page.rect.height
    out: list[tuple[Box, tuple[float, float, float]]] = []
    for drawing in page.get_drawings():
        fill = drawing.get("fill")
        if fill is None:
            continue
        if not all(isinstance(c, (int, float)) for c in fill[:3]):
            continue
        out.append((flip_y(list(drawing["rect"]), height), tuple(fill[:3])))
    return out


def mask_punch(source_pdf: str, translated_pdf: str, assembly: dict) -> dict:
    """遮罩打穿非白背景的程度。

    `Paragraph.backgroundColor` 从加进来那天起就没有生产方，遮罩一律涂白。后果
    已量出：横版幻灯片 5 个遮罩打穿一块 12030 平方磅的浅蓝横幅，attention-reading
    17 个遮罩打穿 6952 平方磅的表格表头斑马纹。产品侧补上生产方（backgroundFill
    从内容流取矩形填充）之后，遮罩改用段落所在区域的真实背景色，这一项该归零。

    判据是「遮罩压在某个非白填充区域上，且两者颜色不同」。遮罩用了正确的背景色
    时颜色一致，不算打穿；遮罩仍是白色而区域有色才算。

    认遮罩的判据照抄 _mask_ownership：矩形有三成以上面积压在某个段落框上。原文
    自带的白色填充（图框底色、表头底色）压不到段落框上，不会混进来。区别只在这
    里要连颜色一起记——所以自己提一遍，不复用 extract_translated_spans。
    """
    fitz = _fitz()

    # 源 PDF 的非白填充。三分量都大于 0.98 算白，跳过。
    source_fills: dict[int, list[tuple[Box, tuple[float, float, float]]]] = {}
    src = fitz.open(source_pdf)
    try:
        for page in src:
            fills = [
                (box, color)
                for box, color in _fill_rects_with_color(page)
                if not all(c > 0.98 for c in color)
            ]
            source_fills[page.number + 1] = fills
    finally:
        src.close()

    pages = {p.get("pageNumber"): p for p in assembly.get("pages", [])}
    doc = fitz.open(translated_pdf)
    punched_masks = 0
    punched_area = 0.0
    colors: set[str] = set()
    try:
        for page in doc:
            number = page.number + 1
            fills = source_fills.get(number) or []
            paragraph = pages.get(number)
            if not fills or not paragraph:
                continue
            boxes = [
                Box(p.get("x0", 0), p.get("y0", 0), p.get("x1", 0), p.get("y1", 0))
                for p in paragraph.get("paragraphs", [])
            ]
            for mask_box, mask_color in _fill_rects_with_color(page):
                area = mask_box.area()
                if area <= 0:
                    continue
                best = max((mask_box.intersect(b) for b in boxes), default=0.0)
                if best / area < 0.3:
                    continue  # 不是遮罩，是原文自带的填充
                for fill_box, fill_color in fills:
                    overlap = mask_box.intersect(fill_box)
                    if overlap <= 0.01:
                        continue
                    # 颜色相同就不算打穿：遮罩用的正是这块区域的背景色。容差
                    # 取 0.02，容纳 PDF 里 0.933 与 0.9333 这类表示差。
                    if all(abs(a - b) <= 0.02 for a, b in zip(mask_color, fill_color)):
                        continue
                    punched_masks += 1
                    punched_area += overlap
                    colors.add(
                        f"遮罩({mask_color[0]:.2f},{mask_color[1]:.2f},{mask_color[2]:.2f})"
                        f"压背景({fill_color[0]:.2f},{fill_color[1]:.2f},{fill_color[2]:.2f})"
                    )
                    break
    finally:
        doc.close()

    return {
        "fills": sum(len(v) for v in source_fills.values()),
        "punchedMasks": punched_masks,
        "punchedArea": round(punched_area, 1),
        "colors": sorted(colors),
    }


def outside_pixel_diff(
    source_pdf: str,
    translated_pdf: str,
    assembly: dict,
    dpi: int = 120,
    erode_px: int = 3,
    band_px: int = 12,
    threshold: int = 32,
) -> dict:
    """框外像素差异：渲染原文与译文，只比较所有段落框之外的像素。

    这是最强的一条单指标：任何画到不该画的地方——遮罩越界、公式截图贴错
    位置、图像合成偏移——都会在框外留下像素。设计照搬 prototype 下那个跑过
    14 个文档的探针：框内侵蚀几像素算"框内"，外扩一圈算"环带跳过"，其余算
    "框外"参与比较。环带是必需的，字形删掉后边缘像素会溅出小框几像素，不跳
    过就连正确的输出也会报差异。
    """
    fitz = _fitz()
    scale = dpi / 72.0
    source_doc = fitz.open(source_pdf)
    translated_doc = fitz.open(translated_pdf)
    try:
        if source_doc.page_count != translated_doc.page_count:
            raise RuntimeError(
                f"页数不一致：原文 {source_doc.page_count}，译文 {translated_doc.page_count}"
            )
        pages = {p["pageNumber"]: p for p in assembly.get("pages", [])}
        # 页高取原文 PDF 自己的。解析器 JSON 不带 MediaBox，装配视图里的尺寸
        # 虽然已经改成从原文补，但度量库既然已经打开了原文，就以原文为准——
        # y 向上换算位图行号只差一页的高度，整页遮罩就会算偏。
        page_heights = {p.number: p.rect.height for p in source_doc}
        outside_total = 0
        outside_diff = 0
        inside_total = 0
        inside_diff = 0
        samples: list[str] = []
        for index in range(source_doc.page_count):
            page_assembly = pages.get(index + 1)
            if page_assembly is None:
                continue
            before = source_doc[index].get_pixmap(dpi=dpi)
            after = translated_doc[index].get_pixmap(dpi=dpi)
            if before.width != after.width or before.height != after.height:
                raise RuntimeError(
                    f"第 {index + 1} 页渲染尺寸不一致：原文 "
                    f"{before.width}x{after.height}，译文 {after.width}x{after.height}"
                )
            width, height = before.width, before.height
            # 0 框外（参与比较）、1 环带（跳过）、2 框内（参与比较）
            mask = bytearray(width * height)
            for paragraph in page_assembly.get("paragraphs", []):
                page_height = page_heights.get(index + 1) or page_assembly["height"]
                x0 = int(round(paragraph["x0"] * scale))
                x1 = int(round(paragraph["x1"] * scale))
                y0 = int(round((1 - paragraph["y1"] / page_height) * height))
                y1 = int(round((1 - paragraph["y0"] / page_height) * height))
                x0 = max(0, min(width - 1, x0))
                x1 = max(0, min(width - 1, x1))
                y0 = max(0, min(height - 1, y0))
                y1 = max(0, min(height - 1, y1))
                for y in range(max(0, y0 - band_px), min(height - 1, y1 + band_px) + 1):
                    row = y * width
                    for x in range(max(0, x0 - band_px), min(width - 1, x1 + band_px) + 1):
                        strict_inside = (
                            x >= x0 + erode_px
                            and x <= x1 - erode_px
                            and y >= y0 + erode_px
                            and y <= y1 - erode_px
                        )
                        if strict_inside:
                            mask[row + x] = 2
                        elif mask[row + x] == 0:
                            mask[row + x] = 1
            before_samples = before.samples
            after_samples = after.samples
            channels = before.n
            stride = width * channels
            for y in range(height):
                mask_row = mask[y * width : (y + 1) * width]
                # 计数走 bytes.count：一行上千个像素，逐个 Python 循环会让一篇
                # 十页的夹具跑上几十秒。整行字节相同就整行跳过差异比较，只有真
                # 变了的行才逐像素看——页面上变的就是几段文字，其余行原样跳过。
                outside_total += width - mask_row.count(1) - mask_row.count(2)
                inside_total += mask_row.count(2)
                row_offset = y * stride
                if before_samples[row_offset : row_offset + stride] == after_samples[
                    row_offset : row_offset + stride
                ]:
                    continue
                for x in range(width):
                    kind = mask_row[x]
                    if kind == 1:
                        continue
                    offset = row_offset + x * channels
                    changed = (
                        abs(before_samples[offset] - after_samples[offset]) > threshold
                        or abs(before_samples[offset + 1] - after_samples[offset + 1]) > threshold
                        or abs(before_samples[offset + 2] - after_samples[offset + 2]) > threshold
                    )
                    if kind == 2:
                        if changed:
                            inside_diff += 1
                    else:
                        if changed:
                            outside_diff += 1
                            if len(samples) < 20:
                                samples.append(f"p{index + 1}:{x},{y}")
    finally:
        source_doc.close()
        translated_doc.close()
    return {
        "outsideDiffRatio": outside_diff / outside_total if outside_total else 0.0,
        "outsideDiff": outside_diff,
        "outsideTotal": outside_total,
        "insideChangedRatio": inside_diff / inside_total if inside_total else 0.0,
        "outsideSamples": samples,
    }


def source_residue(source_pdf: str, translated_pdf: str, source_script: str = "latin") -> dict:
    """原文残留率：译文 PDF 里还能提取到多少源语言文本。

    叠加模式下原文内容流原样保留在页里，遮罩只是拿白矩形盖住它。盖不住或
    漏盖，提取层就仍然命中原文——读者复制全文时会复制到原文，搜索原文也能
    搜到。这个比例就是"盖住了多少"的直接度量。

    只数字源文字的字母：译文是另一种文字（中文），混进来会把残留率稀释成
    一个好看但假的数。Python 的 isalpha 把汉字也算字母，所以必须按文字系
    统分别数，不能用 isalpha 一把抓。
    """
    fitz = _fitz()

    def letters(text: str) -> int:
        if source_script == "latin":
            return sum(1 for c in text if ("a" <= c <= "z") or ("A" <= c <= "Z"))
        return sum(1 for c in text if "\u4e00" <= c <= "\u9fff")

    source_doc = fitz.open(source_pdf)
    source_text = "".join(page.get_text() for page in source_doc)
    source_doc.close()
    translated_doc = fitz.open(translated_pdf)
    translated_text = "".join(page.get_text() for page in translated_doc)
    translated_doc.close()

    total = letters(source_text)
    residual = letters(translated_text)
    return {
        "sourceLetters": total,
        "residualLetters": residual,
        "residueRatio": residual / total if total else 0.0,
        "sourceScript": source_script,
    }


# ---------------------------------------------------------------------------
# C 组：扫描件层
# ---------------------------------------------------------------------------


def _edit_distance(a: str, b: str) -> int:
    """标准编辑距离。CER 与 WER 共用，不引第三方库。"""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (0 if ca == cb else 1),
                )
            )
        previous = current
    return previous[-1]


def _cer(reference: str, hypothesis: str) -> float:
    reference = reference.replace(" ", "")
    hypothesis = hypothesis.replace(" ", "")
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return _edit_distance(reference, hypothesis) / len(reference)


def _wer(reference: str, hypothesis: str) -> float:
    ref_words = reference.split()
    hyp_words = hypothesis.split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    return _edit_distance(ref_words, hyp_words) / len(ref_words)


def ocr_metrics(sidecar_pages: list[dict], ground_truth_lines: list[dict]) -> dict:
    """OCR 产出对已知原文的度量。

    sidecar_pages 是侧车 result.json 的 pages 数组；ground_truth_lines 是
    [{"page", "bbox"(y 向上), "text"}]，bbox 已是 PDF 用户空间。

    注意侧车的 bbox 是位图像素框（左上原点 y 向下），换算成 PDF 用户空间要
    走 pixelBoxToPdfBox 那条公式：缩放以位图实际尺寸为基准，不信 dpi 乘法。
    这里假定调用方已经换算好，换算本身由单测覆盖。
    """
    hyp_lines: list[dict] = []
    for page in sidecar_pages:
        size = page.get("pageSizePt") or {}
        render = page.get("renderSizePx") or {}
        width = float(size.get("width") or 0)
        height = float(size.get("height") or 0)
        render_width = float(render.get("width") or 0)
        render_height = float(render.get("height") or 0)
        sx = width / render_width if render_width else 0.0
        sy = height / render_height if render_height else 0.0
        for line in page.get("lines") or []:
            box = line.get("bbox") or {}
            x0 = min(float(box.get("x0", 0)), float(box.get("x1", 0))) * sx
            x1 = max(float(box.get("x0", 0)), float(box.get("x1", 0))) * sx
            top = min(float(box.get("y0", 0)), float(box.get("y1", 0))) * sy
            bottom = max(float(box.get("y0", 0)), float(box.get("y1", 0))) * sy
            hyp_lines.append(
                {
                    "page": int(page.get("pageNumber") or 0),
                    "box": Box(x0, height - bottom, x1, height - top),
                    "text": norm_text(line.get("text", "")),
                    "blockId": int(line.get("blockId") or 0),
                }
            )

    # 行级配对：同页内按文本相似度贪心一对一。
    pairs: list[tuple[dict, dict, float]] = []
    used_hyp: set[int] = set()
    for gt in ground_truth_lines:
        best_index = None
        best_sim = 0.0
        for index, hyp in enumerate(hyp_lines):
            if index in used_hyp or hyp["page"] != gt["page"]:
                continue
            sim = text_sim(gt["text"], hyp["text"])
            if sim > best_sim:
                best_sim = sim
                best_index = index
        if best_index is not None and best_sim >= 0.5:
            used_hyp.add(best_index)
            pairs.append((gt, hyp_lines[best_index], best_sim))

    cer_samples = [_cer(gt["text"], hyp["text"]) for gt, hyp, _ in pairs]
    wer_samples = [_wer(gt["text"], hyp["text"]) for gt, hyp, _ in pairs]
    iou_samples = [
        iou(Box(*gt["bbox"]) if not isinstance(gt["bbox"], Box) else gt["bbox"], hyp["box"])
        for gt, hyp, _ in pairs
    ]

    # 段落召回：按 blockId 聚成块，与真值行做覆盖比对。
    blocks: dict[int, list[str]] = {}
    block_order: list[int] = []
    for line in hyp_lines:
        key = line["blockId"]
        if key not in blocks:
            block_order.append(key)
        blocks.setdefault(key, []).append(line["text"])
    matched_text = {hyp["text"] for _, hyp, _ in pairs}
    matched_blocks = sum(1 for key in block_order if any(t in matched_text for t in blocks[key]))
    gt_pages = len({gt["page"] for gt in ground_truth_lines})

    return {
        "linePairs": len(pairs),
        "groundTruthLines": len(ground_truth_lines),
        "lineRecall": len(pairs) / len(ground_truth_lines) if ground_truth_lines else 0.0,
        "cer": sum(cer_samples) / len(cer_samples) if cer_samples else 0.0,
        "wer": sum(wer_samples) / len(wer_samples) if wer_samples else 0.0,
        "boxIou": sum(iou_samples) / len(iou_samples) if iou_samples else 0.0,
        "blockRecall": matched_blocks / len(block_order) if block_order else 0.0,
        "blocks": len(block_order),
        "groundTruthPages": gt_pages,
    }


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------


def _check(name: str, condition: bool, detail: str = "") -> bool:
    if condition:
        print(f"PASS  {name}")
        return True
    print(f"FAIL  {name}" + (f"\n      {detail}" if detail else ""))
    return False


def selftest() -> int:
    failures = 0

    # ── 几何 ──
    a = Box(0, 0, 10, 10)
    failures += not _check("iou 相同框为 1", abs(iou(a, Box(0, 0, 10, 10)) - 1.0) < 1e-9)
    failures += not _check("iou 不相交为 0", iou(a, Box(20, 20, 30, 30)) == 0.0)
    half = Box(5, 0, 15, 10)
    failures += not _check(
        "iou 半重合为 1/3", abs(iou(a, half) - (50 / 150)) < 1e-9, f"got {iou(a, half)}"
    )
    failures += not _check(
        "iou 零面积框不除零", iou(Box(0, 0, 0, 0), Box(0, 0, 0, 0)) == 0.0
    )

    # ── y 翻转 ──
    # 这是唯一一条专门盯坐标约定的断言。翻转写反，所有 IoU 仍然落在 0 到 1
    # 之间，报告看起来一切正常，只有逐页核对才发现整体镜像。
    flipped = flip_y([10, 20, 110, 70], 800)
    failures += not _check(
        "flip_y 把左上原点翻成左下原点",
        abs(flipped.x0 - 10) < 1e-9 and abs(flipped.x1 - 110) < 1e-9
        and abs(flipped.y0 - (800 - 70)) < 1e-9 and abs(flipped.y1 - (800 - 20)) < 1e-9,
        f"got {flipped}",
    )
    failures += not _check(
        "odl_box 顺序颠倒自动交换",
        odl_box([100, 200, 50, 100]) == Box(50, 100, 100, 200),
    )

    # ── 文本相似度 ──
    failures += not _check(
        "norm_text 压掉换行与缩进",
        norm_text("宇宙\n  和地球") == "宇宙 和地球",
    )
    failures += not _check(
        "text_sim 跨换行仍能配上", text_sim("a b c", "a\nb  c") > 0.99, f"{text_sim('a b c', 'a\nb  c')}"
    )

    # ── Kendall tau ──
    failures += not _check("tau 同序为 1", abs(kendall_tau([1, 2, 3], [1, 2, 3]) - 1.0) < 1e-9)
    failures += not _check("tau 逆序为 -1", abs(kendall_tau([1, 2, 3], [3, 2, 1]) + 1.0) < 1e-9)
    failures += not _check(
        "tau 元素集不同返回 0", kendall_tau([1, 2], [1, 3]) == 0.0
    )

    # ── A 组 ──
    key = {
        "elements": [
            {"order": 0, "type": "body", "text": "plain prose one", "formula": False},
            {"order": 1, "type": "body", "text": "plain prose two", "formula": False},
            {"order": 2, "type": "body", "text": "plain prose three", "formula": False},
            {"order": 3, "type": "body", "text": "an equation alpha beta", "formula": True},
            {"order": 4, "type": "body", "text": "an equation gamma delta", "formula": True},
        ]
    }
    blocks = [
        OdlBlock(0, 1, "paragraph", "plain prose one", 10, Box(0, 0, 10, 10)),
        OdlBlock(1, 1, "paragraph", "plain prose two", 10, Box(0, 10, 10, 20)),
        OdlBlock(2, 1, "paragraph", "plain prose three", 10, Box(0, 20, 10, 30)),
        OdlBlock(3, 1, "paragraph", "an equation alpha beta", 10, Box(0, 30, 10, 40)),
    ]
    odl = OdlDoc(blocks=blocks)
    flagged = {(1, "an equation alpha beta"), (1, "plain prose two")}
    matched = match_elements(key, odl)
    formula = formula_detection(key, odl, flagged, list(matched["pairs"]))
    failures += not _check(
        "公式精确率 1/2、召回率 1/2",
        abs(formula["precision"] - 0.5) < 1e-9 and abs(formula["recall"] - 0.5) < 1e-9,
        f"got P={formula['precision']} R={formula['recall']}",
    )
    failures += not _check(
        "漏报的那条进 cases", any(c["truth"] and not c["predicted"] for c in formula["cases"])
    )

    failures += not _check(
        "四条真值配上、一条漏配、解析没有多产",
        matched["tp"] == 4 and matched["fn"] == 1 and matched["fp"] == 0,
        f"got tp={matched['tp']} fn={matched['fn']} fp={matched['fp']}",
    )

    three_col_key = {"columns": 3}
    # 六个等宽栏内段加一个通栏段。等宽段是主流，众数栏宽因此落在 150 上。
    narrow_blocks = [
        OdlBlock(i, 1, "paragraph", f"narrow {i}", 10, Box(0, i * 10, 150, i * 10 + 10))
        for i in range(6)
    ]
    wide_odl = OdlDoc(
        blocks=[
            *narrow_blocks,
            OdlBlock(6, 1, "paragraph", "wide one", 10, Box(0, 60, 500, 70)),
        ]
    )
    bleed = column_bleed(three_col_key, wide_odl, {1: 500})
    failures += not _check(
        "三栏页上宽框记串位、窄框不记",
        abs(bleed["crossColumnRatio"] - 1 / 7) < 1e-9
        and abs(bleed["wideRatio"] - 1 / 7) < 1e-9,
        f"got {bleed}",
    )

    # 块数太少、宽度各异时建立不了主流栏宽，此时退回页宽——不判串位比误判好。
    # 横版幻灯片每页布局不同，正是这个情形：17 个块里最频宽度只出现 3 次且是
    # 8 磅的坐标轴刻度标签，若不设门槛，栏宽会被估成 8 磅，整页都算串位。
    few_odl = OdlDoc(
        blocks=[
            OdlBlock(0, 1, "paragraph", "wide one", 10, Box(0, 0, 500, 10)),
            OdlBlock(1, 1, "paragraph", "narrow one", 10, Box(0, 10, 150, 20)),
        ]
    )
    bleed_few = column_bleed(three_col_key, few_odl, {1: 500})
    failures += not _check(
        "建立不了主流栏宽时不判串位",
        bleed_few["crossColumnRatio"] == 0.0,
        f"got {bleed_few}",
    )

    # ── 图内文字判据 ──
    # 这三个纯函数是批 3 新度量 figure_text 的核心。合成数据逐个钉住判据的边界：
    # 一条写反就整篇检不出或整页误伤，而两者在报告上都看不出异常——前者恒为 0
    # 像"没有图内文字"，后者把正文算进去像"图很多"。
    failures += not _check(
        "字号中位数取中间值，不用众数",
        abs(median_font_size([(10.0, a), (10.0, a), (6.0, a)]) - 10.0) < 1e-9,
    )
    failures += not _check(
        "偶数个跨度取中间两个的均值",
        abs(median_font_size([(8.0, a), (10.0, a), (12.0, a), (14.0, a)]) - 11.0) < 1e-9,
    )
    failures += not _check(
        "空表返回 None 而不是 0", median_font_size([]) is None
    )
    # 横版幻灯片那一页的字号众数正是图内文字的 6.75（12 个，比正文任一档都多）。
    # 这条断言钉住那个真实反例：换成众数判据，阈值会掉到 5.40，一篇图内文字都
    # 检不出。合成数据照那页的真实分布取：6.75×12、9.49×2、10.99×11、15.0×3。
    landscape_sizes = (
        [(6.75, a)] * 12 + [(9.49, a)] * 2 + [(10.99, a)] * 11 + [(15.0, a)] * 3
    )
    failures += not _check(
        "众数落在图内文字上时中位数仍取正文",
        abs(median_font_size(landscape_sizes) - 10.24) < 1e-9,
        f"got {median_font_size(landscape_sizes)}",
    )

    # 图内小字号命中；同页的正文（字号 10，是中位数的 1.0 倍）不命中。
    fig_spans = [
        (10.0, Box(0, 0, 100, 10)),    # 正文
        (10.0, Box(0, 20, 100, 30)),   # 正文
        (10.0, Box(0, 40, 100, 50)),   # 正文
        (6.0, Box(20, 60, 40, 70)),    # 图内刻度，落在簇内
        (6.0, Box(50, 60, 80, 70)),    # 图内图例，落在簇内
    ]
    fig_clusters = [Box(10, 55, 90, 75)]
    fig_hits = figure_text_span_boxes(fig_spans, fig_clusters, 10.0)
    failures += not _check(
        "图内小字号命中、正文不命中",
        len(fig_hits) == 2,
        f"got {len(fig_hits)}",
    )

    # 表格文字：字号只比正文小一截，过不了字号这一关。这是簇条件之外的第二道
    # 护栏——attention-reading 页 1 的表格文字字号 8.20、中位数 8.80，比值 0.93。
    table_spans = [
        (10.0, Box(0, 0, 100, 10)),
        (10.0, Box(0, 20, 100, 30)),
        (8.2, Box(20, 40, 60, 50)),   # 表格单元格，落在簇内
    ]
    failures += not _check(
        "表格同号文字不误伤",
        figure_text_span_boxes(table_spans, fig_clusters, 10.0) == [],
    )

    # 没有矢量路径就没有簇，字号再小也不判——脚注与参考文献小字靠这一条挡住。
    failures += not _check(
        "没有矢量簇时一篇都不判",
        figure_text_span_boxes(fig_spans, [], 10.0) == [],
    )

    # 相距很远的两个图形必须是两簇，不能因为间隙阈值粗就并成一簇。
    far = vector_clusters([Box(0, 0, 10, 10), Box(500, 500, 510, 510)], 20)
    failures += not _check(
        "相距远的矢量路径分成两簇", len(far) == 2, f"got {len(far)}"
    )
    near = vector_clusters([Box(0, 0, 10, 10), Box(12, 0, 22, 10)], 20)
    failures += not _check(
        "间隙小于阈值的矢量路径并成一簇", len(near) == 1, f"got {len(near)}"
    )

    # 合并块：bbox 完整包住四个同页其它块。宽度判据分不清"合法通栏元素"与
    # "跨栏合并"，这个判据能——通栏标题虽宽，但不包住别人。
    merged_odl = OdlDoc(
        blocks=[
            OdlBlock(0, 1, "paragraph", "merged", 10, Box(0, 0, 300, 100)),
            OdlBlock(1, 1, "paragraph", "a", 10, Box(0, 80, 100, 90)),
            OdlBlock(2, 1, "paragraph", "b", 10, Box(0, 60, 100, 70)),
            OdlBlock(3, 1, "paragraph", "c", 10, Box(0, 40, 100, 50)),
            OdlBlock(4, 1, "paragraph", "d", 10, Box(0, 20, 100, 30)),
        ]
    )
    bleed_merged = column_bleed({"columns": 3}, merged_odl, {1: 400})
    failures += not _check(
        "包住至少三个邻段的块计入合并块",
        abs(bleed_merged["mergedBlockRatio"] - 1 / 5) < 1e-9,
        f"got {bleed_merged}",
    )

    # 通栏元素虽宽但不包住别人，不能计入合并块。
    full_width_odl = OdlDoc(
        blocks=[
            OdlBlock(0, 1, "paragraph", "figure caption", 10, Box(0, 90, 400, 100)),
            OdlBlock(1, 1, "paragraph", "body one", 10, Box(0, 60, 150, 70)),
            OdlBlock(2, 1, "paragraph", "body two", 10, Box(0, 30, 150, 40)),
            OdlBlock(3, 1, "paragraph", "body three", 10, Box(0, 0, 150, 10)),
        ]
    )
    bleed_full = column_bleed({"columns": 2}, full_width_odl, {1: 400})
    failures += not _check(
        "通栏图注不计入合并块",
        bleed_full["mergedBlockRatio"] == 0.0,
        f"got {bleed_full}",
    )

    tau = reading_order(key, odl, [(0, 0), (1, 1), (2, 2), (3, 3)])
    failures += not _check("阅读顺序同序 tau 为 1", abs(tau["tau"] - 1.0) < 1e-9)
    reversed_tau = reading_order(key, odl, [(0, 3), (1, 2), (2, 1), (3, 0)])
    failures += not _check("阅读顺序逆序 tau 为 -1", abs(reversed_tau["tau"] + 1.0) < 1e-9)

    # ── 遮罩归属：所辖段完整包含邻段时，侵入仍必须被抓到 ──
    # 这一条盯的是三栏夹具上 intrusionIntoParagraph 恒为 0 的缺陷。旧判据是
    # 「遮罩∩邻段 − 所辖段∩邻段」，当跨栏合并块的遮罩（多个矩形片的并集）几何上
    # 完整包住邻段时，两个交集相等，差值恒为 0——真实的侵入被那道减法减掉了。
    owner_box = Box(0, 0, 400, 400)
    nested_boxes = [Box(10, 10, 100, 50), Box(10, 60, 100, 100), Box(10, 110, 100, 150)]
    nested_paras = [
        {"x0": owner_box.x0, "y0": owner_box.y0, "x1": owner_box.x1, "y1": owner_box.y1}
    ]
    for b in nested_boxes:
        nested_paras.append({"x0": b.x0, "y0": b.y0, "x1": b.x1, "y1": b.y1})

    _, _, nested_intrusion, _ = _mask_ownership([Box(-1, -1, 401, 401)], nested_paras, [])
    failures += not _check(
        "遮罩的所辖段包住邻段时侵入仍被抓到",
        nested_intrusion >= 1,
        f"got intrusion_paragraph={nested_intrusion}",
    )

    # 反向：遮罩只压所辖段的空白一侧、不碰任何邻段时，不报侵入。
    _, _, clean_intrusion, _ = _mask_ownership([Box(150, 150, 399, 399)], nested_paras, [])
    failures += not _check(
        "遮罩不碰邻段时不报侵入",
        clean_intrusion == 0,
        f"got intrusion_paragraph={clean_intrusion}",
    )

    # ── 编号空间：真值下标与解析器块下标不是同一套，指标必须经配对换算 ──
    # 这一条盯的是一个真发生过缺陷：答案键 30 个元素、解析器 62 个块，直接拿
    # 两边的 order 集合求交，公式三项恒为 0，而 formula-dense 恰好 26 对 26 所以
    # 数字是对的——同一个 bug 在一篇夹具上隐身、在另一篇上现形。
    sparse_key = {
        "elements": [
            {"order": 0, "type": "heading", "level": 1, "text": "a heading here", "formula": False},
            {"order": 1, "type": "body", "text": "plain prose one", "formula": False},
            {"order": 2, "type": "body", "text": "an equation alpha beta", "formula": True},
        ]
    }
    sparse_odl = OdlDoc(
        blocks=[
            # 解析器多产出了表格单元格与图内标注，块下标与真值下标错开。
            OdlBlock(0, 1, "heading", "a heading here", 12, Box(0, 0, 10, 10), 1),
            OdlBlock(1, 1, "paragraph", "plain prose one", 10, Box(0, 10, 10, 20)),
            OdlBlock(2, 1, "paragraph", "a table cell fragment", 8, Box(0, 20, 10, 30)),
            OdlBlock(3, 1, "paragraph", "an axis label", 6, Box(0, 30, 10, 40)),
            OdlBlock(4, 1, "paragraph", "an equation alpha beta", 10, Box(0, 40, 10, 50)),
        ]
    )
    sparse_matched = match_elements(sparse_key, sparse_odl)
    sparse_pairs = list(sparse_matched["pairs"])
    sparse_formula = formula_detection(
        sparse_key, sparse_odl, {(1, "an equation alpha beta")}, sparse_pairs
    )
    failures += not _check(
        "块下标错开时公式判域仍然算得对",
        sparse_formula["tp"] == 1 and sparse_formula["fp"] == 0 and sparse_formula["fn"] == 0,
        f"got {sparse_formula}",
    )
    sparse_heading = heading_levels(sparse_key, sparse_odl, sparse_pairs)
    failures += not _check(
        "块下标错开时标题层级仍能配上",
        sparse_heading["sharedHeadings"] == 1,
        f"got {sparse_heading}",
    )

    # ── C 组 ──
    failures += not _check(
        "CER 一处替换为 1/长度",
        abs(_cer("abcd", "abxd") - 0.25) < 1e-9,
        f"got {_cer('abcd', 'abxd')}",
    )
    failures += not _check("CER 完全相同为 0", _cer("abc", "abc") == 0.0)
    failures += not _check(
        "WER 一个词错为 1/词数",
        abs(_wer("a b c", "a x c") - 1 / 3) < 1e-9,
        f"got {_wer('a b c', 'a x c')}",
    )

    sidecar_pages = [
        {
            "pageNumber": 1,
            "pageSizePt": {"width": 600, "height": 800},
            "renderSizePx": {"width": 1200, "height": 1600},
            "lines": [
                {"bbox": {"x0": 100, "y0": 100, "x1": 300, "y1": 120}, "text": "the quick brown fox", "blockId": 0},
                {"bbox": {"x0": 100, "y0": 140, "x1": 300, "y1": 160}, "text": "jumps over the lazy dog", "blockId": 0},
                {"bbox": {"x0": 100, "y0": 900, "x1": 300, "y1": 920}, "text": "a drifted line far away", "blockId": 1},
            ],
        }
    ]
    gt_lines = [
        {"page": 1, "bbox": Box(50, 740, 150, 750), "text": "the quick brown fox"},
        {"page": 1, "bbox": Box(50, 720, 150, 730), "text": "jumps over the lazy dog"},
        {"page": 1, "bbox": Box(50, 700, 150, 720), "text": "a line that was never seen"},
    ]
    ocr = ocr_metrics(sidecar_pages, gt_lines)
    failures += not _check(
        "OCR 行召回 2/3",
        abs(ocr["lineRecall"] - 2 / 3) < 1e-9,
        f"got {ocr['lineRecall']}",
    )
    failures += not _check(
        "OCR 坐标翻转后 IoU 大于 0.9",
        ocr["boxIou"] > 0.9,
        f"got {ocr['boxIou']}",
    )

    # ── B 组（需要 pymupdf）──
    try:
        _fitz()
    except RuntimeError as exc:
        print(f"SKIP  B 组自检：{exc}")
        print(f"\n{'FAILED' if failures else 'OK'}  {failures} 项失败")
        return 1 if failures else 0

    import os
    import tempfile

    fitz = _fitz()
    with tempfile.TemporaryDirectory() as tmp:
        # 一页 600×800。两个并排段落框（y 向上 300 到 400），下方一个图区，
        # 再加上一块落在所有框之外的黑色色块——它专门用来验证"画到框外会被
        # 像素差异抓到"。
        # pymupdf 的 insert_text 用左上原点，所以 y 向上 390 的基线要写成 410。
        source_path = os.path.join(tmp, "src.pdf")
        translated_path = os.path.join(tmp, "out.pdf")
        assembly = {
            "pages": [
                {
                    "pageNumber": 1,
                    "width": 600,
                    "height": 800,
                    "paragraphs": [
                        {
                            "text": "left paragraph",
                            "x0": 50,
                            "y0": 300,
                            "x1": 280,
                            "y1": 400,
                            "size": 10,
                        },
                        {
                            "text": "right paragraph",
                            "x0": 320,
                            "y0": 300,
                            "x1": 550,
                            "y1": 400,
                            "size": 10,
                        },
                    ],
                    "images": [{"x0": 50, "y0": 100, "x1": 280, "y1": 250}],
                    "tables": [],
                }
            ]
        }
        # 六行铺满左框：行距 15 磅，从基线 390 排到 315。左侧英文是原文，
        # 右侧中文是译文——度量靠"有没有中文字符"把两侧分开。
        line_rows = (410, 425, 440, 455, 470, 485)
        english = "left paragraph source line that is long enough to fill"
        chinese = "这一段是用于自检的合成译文内容需要足够长一些"

        doc = fitz.open()
        page = doc.new_page(width=600, height=800)
        page.draw_rect(fitz.Rect(100, 150, 200, 200), color=None, fill=(0, 0, 0))
        for y in line_rows:
            page.insert_text((50, y), english, fontsize=10)
        doc.save(source_path)
        doc.close()

        # 译文一：只改左框。框外应当全等。
        doc = fitz.open(source_path)
        page = doc[0]
        page.draw_rect(fitz.Rect(49, 399, 281, 501), color=None, fill=(1, 1, 1))
        for y in line_rows:
            page.insert_text((50, y), chinese, fontsize=10, fontname="china-s")
        doc.save(translated_path)
        doc.close()

        spans, masks, rotations = extract_translated_spans(translated_path)
        failures += not _check(
            "六行中文译文都翻回 PDF 空间并落在左框里",
            len(spans[0]) == 6 and all(299 <= s.box.y0 and s.box.y1 <= 401 for s in spans[0]),
            f"got {len(spans[0])} spans: {[s.box for s in spans[0]][:2]}",
        )
        failures += not _check(
            "白遮罩被认出且只有一个",
            len(masks[0]) == 1,
            f"got {len(masks[0])}",
        )
        failures += not _check("未旋转页旋转角为 0", rotations == [0])

        layout = layout_metrics(source_path, translated_path, assembly)
        failures += not _check(
            "只译一段时 UTB 为 1",
            layout["utb"] == 1,
            f"got {layout['utb']}",
        )
        failures += not _check(
            "译文铺满左框时交并比高",
            layout["biou"] > 0.75,
            f"got {layout['biou']}",
        )
        failures += not _check(
            "译文在框内时滞留率接近 1",
            layout["boxPrecision"] > 0.95,
            f"got {layout['boxPrecision']}",
        )
        failures += not _check(
            "遮罩没有侵入邻栏",
            layout["mask"]["intrusionIntoParagraph"] == 0,
            f"got {layout['mask']}",
        )
        baseline_iou = layout["biou"]

        diff = outside_pixel_diff(source_path, translated_path, assembly)
        failures += not _check(
            "只改框内时框外像素差异为 0",
            diff["outsideDiff"] == 0,
            f"got {diff['outsideDiff']}/{diff['outsideTotal']} samples={diff['outsideSamples'][:3]}",
        )

        # 译文二：遮罩放大到盖住右栏。侵入必须被抓到。
        doc = fitz.open(source_path)
        page = doc[0]
        page.draw_rect(fitz.Rect(49, 399, 551, 501), color=None, fill=(1, 1, 1))
        for y in line_rows:
            page.insert_text((50, y), chinese, fontsize=10, fontname="china-s")
        doc.save(translated_path)
        doc.close()

        layout = layout_metrics(source_path, translated_path, assembly)
        failures += not _check(
            "遮罩盖住邻栏时侵入被抓到",
            layout["mask"]["intrusionIntoParagraph"] >= 1,
            f"got {layout['mask']}",
        )

        # 译文三：遮罩向下压进图区。
        doc = fitz.open(source_path)
        page = doc[0]
        page.draw_rect(fitz.Rect(49, 399, 281, 601), color=None, fill=(1, 1, 1))
        doc.save(translated_path)
        doc.close()
        layout = layout_metrics(source_path, translated_path, assembly)
        failures += not _check(
            "遮罩压进图区时侵入图区被抓到",
            layout["mask"]["intrusionIntoRegion"] >= 1,
            f"got {layout['mask']}",
        )

        # 译文四：拿白矩形盖掉框外那块黑色。像素差异必须抓到。
        doc = fitz.open(source_path)
        page = doc[0]
        page.draw_rect(fitz.Rect(100, 150, 200, 200), color=None, fill=(1, 1, 1))
        doc.save(translated_path)
        doc.close()
        diff = outside_pixel_diff(source_path, translated_path, assembly)
        failures += not _check(
            "盖掉框外内容时框外像素差异大于 0",
            diff["outsideDiff"] > 0,
            f"got {diff['outsideDiff']}/{diff['outsideTotal']}",
        )

        # 译文五：译文整块搬到两栏之外的空白带。交并比必须塌成 0，两段都算未
        # 翻译——这正是"译文跑丢"的形状，也是这条指标最该抓住的病。
        doc = fitz.open(source_path)
        page = doc[0]
        page.draw_rect(fitz.Rect(49, 399, 281, 501), color=None, fill=(1, 1, 1))
        for y in (250, 265, 280, 295, 310, 325):
            page.insert_text((50, y), chinese, fontsize=10, fontname="china-s")
        doc.save(translated_path)
        doc.close()
        moved = layout_metrics(source_path, translated_path, assembly)
        failures += not _check(
            "译文搬到框外时交并比塌成 0 且两段都算未翻译",
            moved["biou"] == 0.0 and moved["utb"] == 2,
            f"moved biou={moved['biou']} utb={moved['utb']} baseline={baseline_iou}",
        )

        # 残留率：不盖遮罩时原文英文字符整个留在文本层里，比例应当接近 1。
        doc = fitz.open(source_path)
        page = doc[0]
        for y in line_rows:
            page.insert_text((50, y), chinese, fontsize=10, fontname="china-s")
        doc.save(translated_path)
        doc.close()
        residue = source_residue(source_path, translated_path)
        failures += not _check(
            "不盖遮罩时原文残留接近 1",
            residue["residueRatio"] > 0.95,
            f"got {residue}",
        )

        # ── 遮罩打穿（mask_punch）──
        # 合成一对 PDF：原文一块浅蓝背景，译文一个遮罩压在段落框上。三个变体分别
        # 对应"白色遮罩打穿彩色背景"、"遮罩用了背景色所以不打穿"、"没有彩色背景"。
        punch_assembly = {
            "pages": [
                {
                    "pageNumber": 1,
                    "width": 600,
                    "height": 800,
                    "paragraphs": [
                        {"text": "p", "x0": 50, "y0": 300, "x1": 280, "y1": 400, "size": 10}
                    ],
                    "images": [],
                    "tables": [],
                }
            ]
        }
        # pymupdf 左上原点：用户空间 y 300–400 是 pymupdf y 400–500。浅蓝背景取
        # 用户空间 y 290–410，比段落框大一圈，遮罩外扩 1 磅也还在里面。
        pale_blue = (0.933, 0.949, 0.973)

        def punch_pair(mask_color):
            """造一对原文/译文 PDF，返回译文路径。"""
            src = os.path.join(tmp, f"punch-src-{mask_color and 'a' or 'b'}.pdf")
            dst = os.path.join(tmp, f"punch-out-{mask_color and 'a' or 'b'}.pdf")
            doc = fitz.open()
            page = doc.new_page(width=600, height=800)
            page.draw_rect(fitz.Rect(40, 390, 290, 510), color=None, fill=pale_blue)
            page.insert_text((50, 410), "source line", fontsize=10)
            doc.save(src)
            doc.close()
            doc = fitz.open(src)
            page = doc[0]
            page.draw_rect(
                fitz.Rect(49, 399, 281, 501),
                color=None,
                fill=mask_color if mask_color else (1, 1, 1),
            )
            page.insert_text((50, 410), "合成译文内容", fontsize=10, fontname="china-s")
            doc.save(dst)
            doc.close()
            return src, dst

        src_a, dst_a = punch_pair(None)
        punch_a = mask_punch(src_a, dst_a, punch_assembly)
        failures += not _check(
            "白色遮罩压彩色背景被抓到",
            punch_a["punchedMasks"] == 1 and punch_a["punchedArea"] > 100,
            f"got {punch_a}",
        )

        src_b, dst_b = punch_pair(pale_blue)
        punch_b = mask_punch(src_b, dst_b, punch_assembly)
        failures += not _check(
            "遮罩用了背景色就不算打穿",
            punch_b["punchedMasks"] == 0,
            f"got {punch_b}",
        )

        # 没有彩色背景时一个都不报。
        src_c = os.path.join(tmp, "punch-src-c.pdf")
        dst_c = os.path.join(tmp, "punch-out-c.pdf")
        doc = fitz.open()
        page = doc.new_page(width=600, height=800)
        page.insert_text((50, 410), "source line", fontsize=10)
        doc.save(src_c)
        doc.close()
        doc = fitz.open(src_c)
        page = doc[0]
        page.draw_rect(fitz.Rect(49, 399, 281, 501), color=None, fill=(1, 1, 1))
        page.insert_text((50, 410), "合成译文内容", fontsize=10, fontname="china-s")
        doc.save(dst_c)
        doc.close()
        punch_c = mask_punch(src_c, dst_c, punch_assembly)
        failures += not _check(
            "没有彩色背景时一个都不报",
            punch_c["punchedMasks"] == 0 and punch_c["fills"] == 0,
            f"got {punch_c}",
        )

        # ── 静默右溢（silentRight）──
        # 同一个 assembly，一段窄到放不下译文的段落。量它的时候故意把渲染端诊断
        # 传成空——那就是批 5 之前的真实状况：渲染端只判纵向，横向溢出一处都没报，
        # 而度量侧在五篇上一共数到 10 处。补上传入真实 overflowedRight 之后它该
        # 归零。
        silent_assembly = {
            "pages": [
                {
                    "pageNumber": 1,
                    "width": 600,
                    "height": 800,
                    "paragraphs": [
                        {"text": "p", "x0": 350, "y0": 400, "x1": 370, "y1": 410, "size": 6}
                    ],
                    "images": [],
                    "tables": [],
                }
            ]
        }
        silent_src = os.path.join(tmp, "silent-src.pdf")
        silent_dst = os.path.join(tmp, "silent-out.pdf")
        doc = fitz.open()
        page = doc.new_page(width=600, height=800)
        page.insert_text((50, 410), "source line", fontsize=10)
        doc.save(silent_src)
        doc.close()
        doc = fitz.open(silent_src)
        page = doc[0]
        # 段落框在用户空间 x 350–370、y 400–410；遮罩跟着外扩一磅。中文画在
        # pymupdf 坐标 (350, 395)——pymupdf 是左上原点，y 395 对应用户空间
        # 405，落在段框内，所以 _assign_spans 认得出它属于这段。四个 6 磅汉字共
        # 24 磅宽，右界 374 超出段框右界 370，右溢 4 磅。
        page.draw_rect(fitz.Rect(349, 385, 371, 405), color=None, fill=(1, 1, 1))
        page.insert_text((350, 395), "刻度译文", fontsize=6, fontname="china-s")
        doc.save(silent_dst)
        doc.close()

        # 渲染端什么都没报——silentRight 应等于度量数到的右溢出处数。
        silent_none = layout_metrics(silent_src, silent_dst, silent_assembly, {})
        failures += not _check(
            "渲染端没报横向溢出时 silentRight 等于度量数到的处数",
            silent_none["overflow"]["silentRight"] == silent_none["overflow"]["right"]
            and silent_none["overflow"]["silentRight"] > 0,
            f"got {silent_none['overflow']}",
        )

        # 渲染端报够了——silentRight 归零。
        silent_ok = layout_metrics(
            silent_src,
            silent_dst,
            silent_assembly,
            {"overflowedRight": silent_none["overflow"]["right"]},
        )
        failures += not _check(
            "渲染端报够了时 silentRight 归零",
            silent_ok["overflow"]["silentRight"] == 0,
            f"got {silent_ok['overflow']}",
        )

        # 渲染端报得比度量多（过度报告）时不为负——下限是 0。
        silent_over = layout_metrics(
            silent_src,
            silent_dst,
            silent_assembly,
            {"overflowedRight": silent_none["overflow"]["right"] + 5},
        )
        failures += not _check(
            "渲染端报得更多时 silentRight 不为负",
            silent_over["overflow"]["silentRight"] == 0,
            f"got {silent_over['overflow']}",
        )

    print(f"\n{'FAILED' if failures else 'OK'}  {failures} 项失败")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="z-transplit 版面保留翻译的评测度量库")
    parser.add_argument("--selftest", action="store_true", help="跑内置自检后退出")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
