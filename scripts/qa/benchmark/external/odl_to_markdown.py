#!/usr/bin/env python3
"""
odl_to_markdown — 把 OpenDataLoader 的 JSON 产出转成 pdf-parse-bench 要的
markdown，用来把这个后端放上外部横评榜。

为什么值得做：pdf-parse-bench 的榜上有 22 个解析器（PP-StructureV3、MinerU、
PyMuPDF4LLM、GROBID 等），但没有 OpenDataLoader。本项目整个版面链路建立在
这个 jar 上，它在公式与表格提取上的真实位置一直是个未知数。这一步把未知数
变成一个可对表的分数。

输出结构（pdf-parse-bench 的约定）：
    results/<解析器名>/<pdf 名>/parsed.md

公式的处理说明：OpenDataLoader 不产 LaTeX，公式被折进正文按 Unicode 文本
提出。这里不做任何"美化"——不把公式重新拼成 LaTeX，不调视觉模型。要量的就是
这个后端本身的文本提取质量，加工过的输出对上头榜是没有意义的。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def norm(text: str) -> str:
    return " ".join((text or "").split())


def table_to_markdown(table: dict) -> str:
    """ODL 的表格结构转 markdown 表格。跨格按左上角单元格填内容、右侧补空。"""
    rows = table.get("rows") or []
    if not rows:
        return ""
    grid: list[list[str]] = []
    for row in rows:
        cells = row.get("cells") or []
        line: list[str] = []
        for cell in cells:
            text = norm(cell.get("content", ""))
            span = int(cell.get("column span") or cell.get("columnSpan") or 1)
            line.append(text)
            line.extend([""] * max(0, span - 1))
        grid.append(line)
    if not grid:
        return ""
    width = max(len(r) for r in grid)
    for row in grid:
        row.extend([""] * (width - len(row)))
    out = ["| " + " | ".join(grid[0]) + " |", "|" + "---|" * width]
    for row in grid[1:]:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def emit(node, lines: list[str]) -> None:
    """按阅读顺序递归摊平。次序就是 kids 数组次序，与 ODL 的 xycut 排序一致。"""
    if isinstance(node, list):
        for item in node:
            emit(item, lines)
        return
    if not isinstance(node, dict):
        return
    kind = node.get("type")
    if kind in ("paragraph", "heading", "caption", "citation", "list item"):
        text = norm(node.get("content", ""))
        if text:
            prefix = "#" * int(node.get("heading level") or 1) if kind == "heading" else ""
            lines.append(f"{prefix} {text}".strip() if prefix else text)
            lines.append("")
        return
    if kind == "table":
        markdown = table_to_markdown(node)
        if markdown:
            lines.append(markdown)
            lines.append("")
        # 单元格里还嵌着段落，一并收进来，避免漏内容。
        for row in node.get("rows") or []:
            for cell in row.get("cells") or []:
                emit(cell.get("kids") or cell.get("kids ", []), lines)
        return
    # header / footer / textBlock / list / image / formula / chart：继续往下走。
    for key in ("kids", "listItems", "list items"):
        if key in node:
            emit(node[key], lines)


def convert(odl_json: Path) -> str:
    doc = json.loads(odl_json.read_text(encoding="utf-8"))
    lines: list[str] = []
    emit(doc.get("kids"), lines)
    text = "\n".join(lines).strip()
    return text + "\n" if text else ""


def main() -> int:
    if len(sys.argv) < 4:
        print("用法：odl_to_markdown.py <odl json 目录> <pdf 名列表文件 或 -> <输出目录>")
        return 2
    source = Path(sys.argv[1])
    names_arg = sys.argv[2]
    out_root = Path(sys.argv[3])

    if names_arg == "-":
        names = [p.stem for p in sorted(source.glob("*.json"))]
    else:
        names = [n.strip() for n in Path(names_arg).read_text(encoding="utf-8").splitlines() if n.strip()]

    written = 0
    empty = 0
    for name in names:
        src = source / f"{name}.json"
        if not src.exists():
            print(f"缺 {name}.json", file=sys.stderr)
            continue
        text = convert(src)
        if not text.strip():
            empty += 1
        dest_dir = out_root / name
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "parsed.md").write_text(text, encoding="utf-8")
        written += 1
    print(f"写了 {written} 个 markdown，其中 {empty} 个为空")
    return 0


if __name__ == "__main__":
    sys.exit(main())
