#!/usr/bin/env python3
"""
odl_formula_coverage — 不调用外部裁判，估计 OpenDataLoader 在公式内容上
保留了多少。

为什么需要它：pdf-parse-bench 的正式分数必须走 OpenRouter 的 LLM 裁判，
而这个基准自己的论文测出，文本级指标与人判的相关性只有 0.01 到 0.31
（公式）与 0.70（表格，TEDS/GriTS 上限）。所以下面算出来的数不是榜上那个
0 到 10 的裁判分，换任何文本匹配规则都拿不到可比分数。

这个脚本给的是一个下界估计：把标准答案的 LaTeX 去掉命令名，剩下的字母数字
字符构成多重集，看其中有多少能在解析输出全文里找到。它低估真实水平——LaTeX
源码与 PDF 文本层是同一条公式的两种表示，命令名（\\sum、\\mathbf 之类）在
PDF 里本来就不存在，会被算成缺失。但它是零成本、零依赖、可复现的，用来回答
"这个后端在公式上是不是基本可用"足够。

同时报几个不受表示形式影响的结构观察，这些才是能直接指导修复的：
  - 公式被拆成几个段落（拆得越碎，后续按段翻译越容易把公式打散）
  - 上下标与特殊符号的丢失（PDF 文本层的固有问题，但要知道有多少）
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

# LaTeX 命令名：反斜杠加一串字母。去掉它们才是"公式的实质内容"。
LATEX_COMMAND = re.compile(r"\\[a-zA-Z]+")
# 只保留字母与数字。符号（= + − ∈ ∅ 之类）在两边表示都可能不同，不计入。
ALNUM = re.compile(r"[0-9A-Za-z]")


def norm_alnum(text: str) -> Counter:
    """先做 NFKC 兼容归一化，再取 ASCII 字母数字。

    归一化这一步是必需的，不是讲究：LaTeX 生成的 PDF，其文本层用的是 Unicode
    的数学字母数字符号——斜体 K 是 U+1D43E 而不是 ASCII 的 K，斜体 X 是
    U+1D44B，斜体 f 是 U+1D453。不归一化的话，公式里的变量会被整个算成缺失，
    覆盖率凭空掉一成多，而 PDF 文本层其实一个字符都没漏。第一版就犯过这个错，
    把"解析输出把变量提成了数学斜体"误读成"内容丢失"。
    """
    folded = unicodedata.normalize("NFKC", text)
    return Counter(ALNUM.findall(folded))


def formula_content(latex: str) -> Counter:
    """标准答案公式去掉命令名后的字母数字多重集。"""
    stripped = LATEX_COMMAND.sub(" ", latex)
    return norm_alnum(stripped)


def parse_output_content(markdown: str) -> Counter:
    return norm_alnum(markdown)


def coverage(gt: Counter, out: Counter) -> float:
    """gt 的字符里有多少能在 out 中找到。按多重集相交算。"""
    total = sum(gt.values())
    if total == 0:
        return 1.0
    found = sum((gt & out).values())
    return found / total


def main() -> int:
    if len(sys.argv) < 3:
        print("用法：odl_formula_coverage.py <ground_truth 目录> <parsed 根目录>")
        return 2
    gt_dir = Path(sys.argv[1])
    parsed_root = Path(sys.argv[2])

    names = sorted(p.stem for p in gt_dir.glob("*.json"))
    rows = []
    all_gt = Counter()
    all_out = Counter()
    formula_gt_total = 0
    # 按"条"计的两个完整率。早先一版把按篇累加的计数和按条计数的总数打在
    # 一起，得出一个 81/2070 的数——分子是篇数、分母是条数，那个数字没有意义。
    formula_multiset_full = 0
    formula_substring_full = 0
    paragraph_counts = []

    for name in names:
        gt_path = gt_dir / f"{name}.json"
        md_path = parsed_root / name / "parsed.md"
        if not md_path.exists():
            continue
        gt_doc = json.loads(gt_path.read_text(encoding="utf-8"))
        markdown = md_path.read_text(encoding="utf-8")
        markdown_folded = unicodedata.normalize("NFKC", markdown)

        gt_formula_chars = Counter()
        formula_count = 0
        for item in gt_doc:
            if not isinstance(item, dict):
                continue
            if item.get("type") in ("inline-formula", "display-formula"):
                formula_count += 1
                latex = str(item.get("data", ""))
                gt_formula_chars += formula_content(latex)
                # 判据一（宽松）：这条公式去掉命令名后的字符，能否在该篇解析
                # 输出的任意位置找齐。分散在几个段落里也算过。
                if formula_content(latex) and (formula_content(latex) - norm_alnum(markdown)).total() == 0:
                    formula_multiset_full += 1
                # 判据二（严格）：去掉命令名与所有非字母数字后的字符序列，能否
                # 作为连续子串出现在解析输出里。这一条才回答"公式有没有被当作
                # 一个整体提出来"，也正是后续按段翻译会不会把公式打散的根源。
                needle = "".join(ALNUM.findall(unicodedata.normalize("NFKC", LATEX_COMMAND.sub(" ", latex))))
                if needle and needle in "".join(ALNUM.findall(markdown_folded)):
                    formula_substring_full += 1
        out_chars = norm_alnum(markdown)

        ratio = coverage(gt_formula_chars, out_chars)
        doc_full = (gt_formula_chars & out_chars).total() == sum(gt_formula_chars.values())

        rows.append(
            {
                "name": name,
                "formulas": formula_count,
                "gtChars": sum(gt_formula_chars.values()),
                "coverage": ratio,
                "complete": doc_full,
                "markdownChars": len(markdown),
            }
        )
        all_gt += gt_formula_chars
        all_out += out_chars
        formula_gt_total += formula_count
        paragraph_counts.append(markdown.count("\n\n") + 1)

    rows.sort(key=lambda r: r["coverage"])
    total_chars = sum(all_gt.values())
    overall = sum((all_gt & all_out).values()) / total_chars if total_chars else 1.0

    print(f"篇数 {len(rows)}  标准答案公式 {formula_gt_total} 条")
    print(f"公式内容字符（去 LaTeX 命令名后）合计 {total_chars}")
    print(f"整体字符覆盖率 {overall:.3f}")
    print(
        f"字符找齐的公式（宽松，允许分散在多段） {formula_multiset_full}/{formula_gt_total}"
        f" = {formula_multiset_full / formula_gt_total:.3f}"
    )
    print(
        f"作为连续子串完整出现的公式（严格） {formula_substring_full}/{formula_gt_total}"
        f" = {formula_substring_full / formula_gt_total:.3f}"
    )
    print(f"解析输出平均段落数 {sum(paragraph_counts)/len(paragraph_counts):.1f}")
    print()
    print("覆盖率最低的 10 篇：")
    print(f"{'篇':>5} {'公式数':>6} {'字符数':>7} {'覆盖率':>8}")
    for r in rows[:10]:
        print(f"{r['name']:>5} {r['formulas']:>6} {r['gtChars']:>7} {r['coverage']:>8.3f}")
    print()
    print("覆盖率最高的 5 篇：")
    for r in rows[-5:]:
        print(f"{r['name']:>5} {r['formulas']:>6} {r['gtChars']:>7} {r['coverage']:>8.3f}")

    out_json = Path(parsed_root).parent / "odl-formula-coverage.json"
    out_json.write_text(
        json.dumps(
            {
                "documents": len(rows),
                "formulaCount": formula_gt_total,
                "gtChars": total_chars,
                "overallCoverage": overall,
                "completeFormulas": formula_found_full,
                "rows": rows,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"\n明细：{out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
