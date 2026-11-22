#!/usr/bin/env python3
"""
benchmark run — z-transplit 版面保留翻译的评测编排。

这个文件回答"怎么跑"：调解析器、跑无头渲染、调度量库、出报告、判门禁。
指标怎么算在 metrics.py，无头渲染怎么接在 render-entry.ts，三份经文件交换
数据，互不 import。

    python scripts/qa/benchmark/run.py --regen-keys
        从夹具 HTML 重新生成答案键。答案键提交进版本库，可人工审阅；改了
        夹具之后跑一次，diff 就是"真值变了什么"。

    python scripts/qa/benchmark/run.py
        跑全部数字版夹具，产出 out/results.json 与 out/report.md。

    python scripts/qa/benchmark/run.py --fixture formula-dense
        只跑一篇。

    python scripts/qa/benchmark/run.py --write-baseline
        把本次结果写成基线。第一跑只做这一件事，人工核对数字合理后再提交
        baseline.json。之后 --gate 以基线为准判回归。

    python scripts/qa/benchmark/run.py --gate
        与基线逐指标比，任何指标朝坏方向越过容差即失败。

    python scripts/qa/benchmark/run.py --real-machine --fixture formula-dense
        真机抽查：点火真机流水线，取出译文附件，用同一套版面指标度量，与
        无头结果并排打在报告里。这一步回答"无头路径可不可信"，不是每批都跑。

    python scripts/qa/benchmark/run.py --ocr
        扫描件层：有侧车产出就算 OCR 指标，没有就明确报缺数据。本机
        PaddleOCR 推理跑不通（oneDNN PIR 缺陷），所以这一项目前必然报缺。

门禁判相对回归而不是绝对阈值：当前代码是带着八个批次要修的缺陷的，用当前
状态定绝对阈值，等于把要修的缺陷一起冻进门禁。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metrics  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
BENCH_DIR = Path(__file__).resolve().parent
FIXTURE_DIR = ROOT / "scripts" / "qa" / "fixtures"
KEY_DIR = BENCH_DIR / "answer-keys"
OUT_DIR = BENCH_DIR / "out"
BASELINE_PATH = BENCH_DIR / "baseline.json"
# 真机基线单独一份文件。它与无头基线回答的不是同一个问题：无头基线防"这次改坏了"，
# 真机基线防"真机上才出现的退化"——字号压缩就是只有真机看得见的一类（无头五篇全是
# 0.000，真机最高 0.321）。混在一份文件里会让人以为门禁覆盖了真机，其实没有。
REAL_MACHINE_BASELINE_PATH = BENCH_DIR / "baseline-real-machine.json"
JAR_CANDIDATES = [
    ROOT / "src" / "core" / "pdf" / "lib" / "opendataloader-pdf-cli.jar",
    Path(r"D:\zt-qa\data\ztransplit\lib\opendataloader-pdf-cli.jar"),
]
REMOVER_JAR = ROOT / "src" / "core" / "pdf" / "lib" / "ztransplit-region-text-remover.jar"

# 夹具清单。layout 一列只作报告里的分组标签，真正的栏数与方向从 HTML 解析。
# 扫描件两篇没有 HTML 源，它们的标准答案来自派生源（reading-brain 的已知
# 原文），ocrTruth 一列记的就是这个派生关系。
FIXTURES = [
    {"name": "reading-brain", "layout": "单栏"},
    {"name": "attention-reading", "layout": "双栏"},
    {"name": "formula-dense", "layout": "双栏"},
    {"name": "three-column", "layout": "三栏"},
    {"name": "landscape-slides", "layout": "横版"},
    {"name": "scanned-sample", "layout": "图片型", "ocrTruth": "reading-brain"},
    {"name": "scanned-degraded", "layout": "图片型加损坏文本层", "ocrTruth": "reading-brain"},
]

# 合成译文的子句池。固定内容、按下标循环取用：同一篇夹具两次跑出来的译文
# 逐字节相同，基准数字才可比。译文长度按源文长度乘一个比例控制，把版面从
# 引擎波动里隔离出来——基准量的是版面，不是翻译好坏。
CLAUSES = [
    "这一段说明研究的目标与所要回答的问题",
    "数据来自长期的跟踪记录并按统一网格重采样",
    "估计量在权重收敛时保持稳定",
    "作者用两组独立样本交叉验证了上述结论",
    "图表显示了随训练周次变化的趋势",
    "对照组与实验组之间的差异在后期才显现",
    "该方法对句长与词频的变化不敏感",
    "误差主要来自标注一致性的上限",
    "后续工作会把这一设计推广到第二语言学习者",
    "结果支持注意力资源重组的解释",
    "测量在三个深度上进行并按时序对齐",
    "置信区间由自助法重复抽样得到",
    "这一节交代参数选取的依据",
    "综述部分比较了两种相互竞争的解释",
]
DEFAULT_RATIO = 0.55
# 真机流水线的等待上限（秒）。全新 profile 第一次跑比后续慢得多，见下方轮询处的说明。
REAL_MACHINE_TIMEOUT_S = 900

# 公式字符类与"看不见的数学符号"类。前一个与 odlToAssembly.ts 的
# FORMULA_CHAR_RE 逐字对应（含计数阈值 2）；后一个是夹具生成脚本点名的漏报
# 方向——上标、属于、子集、空集、真减号这些字符不在前一个类里。
FORMULA_CLASS_RE = re.compile(
    r"[∑∫√≈≤≥±×÷∂∇∞→←↔∀∃∝∠⊙⊕⊗≤≥≠αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]|\\[a-zA-Z]{2,}"
)
INVISIBLE_MATH_RE = re.compile(r"[²³¹∈∉⊂⊃⊆⊇∅−⋅∣⟨⟩∪∩]")

CAPTURE_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figcaption", "caption"}


class FixtureHtmlParser(HTMLParser):
    """把夹具 HTML 解析成答案键。

    只认这几类元素：标题、段落、列表项、图题、表题。公式段靠 class="eq"
    认，参考文献段靠在 .refs 容器里认。坐标一概不记——HTML 没有页的概念，
    坐标由度量端按文本相似度与解析器产出配对，避免手抄坐标出错。
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.stack: list[str] = []
        # 开着的 .refs 容器层数。参考文献段靠在不在这个容器里认，所以必须跟着
        # 容器的闭合一起减，只增不减会把参考文献之后的所有段落都标成参考文献。
        self.refs_depth = 0
        self.capture: dict | None = None
        self.elements: list[dict] = []
        self.figures = 0
        # 图内 SVG 文字节点数，按图序号存。图内文字（坐标轴刻度、图例、坐标轴
        # 标题）在夹具 HTML 里全是 <svg><text>，数它就有图内文字的真值——不需要
        # pymupdf，也不需要给解析器认图归属。figure_depth 跟着 <figure> 的开合
        # 增减，嵌套的 svg 不另计，所以 <text> 只要在任一层 figure 内就算。
        self.figure_depth = 0
        self.figure_text_spans: list[int] = []
        self.tables: list[dict] = []
        self.style_text: list[str] = []
        self.table_stack: list[dict] = []
        self.row_cells = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        attributes = dict(attrs)
        classes = attributes.get("class", "")
        if tag in ("head", "style", "script"):
            self.skip_depth += 1
            self.stack.append(tag)
            return
        self.stack.append(tag)
        if "refs" in classes.split():
            self.refs_depth += 1

        if tag == "figure":
            self.figures += 1
            self.figure_depth += 1
            self.figure_text_spans.append(0)
        # <text> 的计数必须放在下面那道 skip_depth/capture 提前返回之前：图内的
        # svg 不会开 capture（CAPTURE_TAGS 里没有 svg），放在后面就一个都数不到。
        if tag == "text" and self.figure_depth:
            self.figure_text_spans[-1] += 1
        if tag == "table":
            self.table_stack.append({"rows": 0, "cols": 0})
        if tag == "tr" and self.table_stack:
            self.row_cells = 0
        if tag in ("td", "th") and self.table_stack:
            self.row_cells += 1
            self.row_cells += int(attributes.get("colspan", 1) or 1) - 1
            if self.table_stack[-1]["rows"] == 0:
                self.table_stack[-1]["cols"] = self.row_cells

        if self.skip_depth or self.capture is not None:
            return
        if tag not in CAPTURE_TAGS:
            return
        level = int(tag[1]) if tag[0] == "h" and tag[1:].isdigit() else None
        self.capture = {
            "tag": tag,
            "cls": classes,
            "level": level,
            "depth": len(self.stack),
            "buf": [],
            "inRefs": self.refs_depth > 0,
        }

    def handle_endtag(self, tag: str) -> None:
        if tag in ("head", "style", "script") and self.skip_depth:
            self.skip_depth -= 1
            if self.stack and self.stack[-1] == tag:
                self.stack.pop()
            return
        capture = self.capture
        if capture and tag == capture["tag"] and len(self.stack) == capture["depth"]:
            self._emit(capture)
            self.capture = None
        if tag == "tr" and self.table_stack:
            self.table_stack[-1]["rows"] += 1
        if tag == "table" and self.table_stack:
            self.tables.append(self.table_stack.pop())
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        if tag == "figure" and self.figure_depth:
            self.figure_depth -= 1
        if tag in ("div", "section") and self.refs_depth:
            self.refs_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.skip_depth and self.stack and self.stack[-1] == "style":
            self.style_text.append(data)
        if self.capture is not None:
            self.capture["buf"].append(data)

    def _emit(self, capture: dict) -> None:
        text = " ".join("".join(capture["buf"]).split())
        if not text:
            return
        classes = capture["cls"].split()
        if capture["tag"][0] == "h" and capture["tag"][1:].isdigit():
            kind, level, formula = "heading", capture["level"], False
        elif "eq" in classes:
            kind, level, formula = "formula", None, True
        elif capture["tag"] == "figcaption" or capture["tag"] == "caption":
            kind, level, formula = "caption", None, False
        elif capture["inRefs"]:
            kind, level, formula = "reference", None, False
        elif capture["tag"] == "li":
            kind, level, formula = "listItem", None, False
        else:
            kind, level, formula = "body", None, False

        class_matches = FORMULA_CLASS_RE.findall(text)
        invisible = INVISIBLE_MATH_RE.findall(text)
        hard_case = None
        if not formula:
            if len(class_matches) >= 2:
                # 误报饵：通篇统计文字，符号密度跨过了阈值，整段会被当成公式区。
                hard_case = "false-positive-bait"
            elif invisible:
                # 漏报饵：含数学符号但不在字符类里，段落级判不出来（段内那些符号
                # 该不该保留是批次 1 的粒度问题，这里只标记位置）。
                hard_case = "false-negative-bait"

        self.elements.append(
            {
                "order": len(self.elements),
                "type": kind,
                "text": text,
                "formula": formula,
                **({"level": level} if level is not None else {}),
                **({"hardCase": hard_case} if hard_case else {}),
                **({"inlineMath": invisible} if invisible else {}),
                **({"cls": " ".join(classes)} if classes else {}),
            }
        )

    def summary(self, name: str) -> dict:
        style = " ".join(self.style_text)
        columns = 1
        column_match = re.search(r"column-count\s*:\s*(\d+)", style)
        if column_match:
            columns = int(column_match.group(1))
        return {
            "fixture": name,
            "columns": columns,
            "landscape": "landscape" in style.lower(),
            "sourceScript": "latin",
            "elements": self.elements,
            "figures": [
                {"index": i, "textSpans": spans}
                for i, spans in enumerate(self.figure_text_spans)
            ],
            "tables": self.tables,
            "knownGaps": [
                "SVG 矢量图进 PDF 后不是位图，解析器提不到图元素，图区检出数天然低于真值",
                "figureTextFilter 依赖删除器 --inspect 报含文字表单对象，而五篇夹具的图"
                "全是页面层矢量图，--inspect 实测返回 0，图内文字排除从未生效",
            ],
        }


def regen_keys() -> int:
    """从夹具 HTML 重新生成答案键。

    生成是纯 HTML 语义的，坐标一概产不出。但答案键里存着一批手工实测补进去的
    字段（columnLeftEdges 是各栏左缘的 PDF 坐标，来自渲染后测量），全量覆盖会
    把它们静默清掉——那批真值就白量了。所以写文件前先把旧文件里"新的产不出、
    旧的还在"的字段合并回去，并打印一行说明合并了什么。
    """
    # 只保留明确知道是手工补的字段，不要无脑合并——那会让删掉的字段复活。
    PRESERVED = ("columnLeftEdges",)
    KEY_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for fixture in FIXTURES:
        html_path = FIXTURE_DIR / f"{fixture['name']}.html"
        if not html_path.exists():
            continue
        parser = FixtureHtmlParser()
        parser.feed(html_path.read_text(encoding="utf-8"))
        key = parser.summary(fixture["name"])
        out = KEY_DIR / f"{fixture['name']}.json"
        carried: list[str] = []
        if out.exists():
            try:
                previous = json.loads(out.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                previous = {}
            for field in PRESERVED:
                if field in previous and field not in key:
                    key[field] = previous[field]
                    carried.append(field)
        out.write_text(json.dumps(key, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        formulas = sum(1 for e in key["elements"] if e["formula"])
        baits = sum(1 for e in key["elements"] if e.get("hardCase"))
        spans = sum(f.get("textSpans", 0) for f in key["figures"])
        print(
            f"{fixture['name']:20s} 元素 {len(key['elements']):3d}  公式段 {formulas}  "
            f"边界样本 {baits}  栏 {key['columns']}  横版 {key['landscape']}  "
            f"表 {len(key['tables'])}  图 {len(key['figures'])}  图内文字 {spans}"
            + (f"  保留 {','.join(carried)}" if carried else "")
        )
        written += 1
    print(f"\n写了 {written} 个答案键到 {KEY_DIR}")
    return 0


# 公式子串。装配层用 $...$ 圈出它们，保护层再把它们从翻译请求里摘出来、
# 译后放回。合成译文必须原样带回这些子串，否则度量端看不到公式曾经存在——
# stats.formulasRendered 会恒为 0，而那正是批 1 要量的东西。
FORMULA_SPAN_RE = re.compile(r"\$[^$]*\$")


def synthetic_translation(text: str, index: int, ratio: float) -> str:
    """按源文长度生成一条确定的中文译文，原样保留公式子串。

    保留公式这一步模拟"遵守公式保护契约的引擎"。真实的 shield/restore 在
    TypeScript 侧（formulaShield.ts），基准跑的是渲染入口、不过翻译层，所以
    在这里补上等价行为：公式子串既不计入译文长度，也不参与截断。
    """
    formulas = FORMULA_SPAN_RE.findall(text)
    prose = FORMULA_SPAN_RE.sub("", text)
    target = max(2, int(round(len(prose) * ratio)))
    parts: list[str] = []
    total = 0
    cursor = index
    while total < target:
        clause = CLAUSES[cursor % len(CLAUSES)]
        parts.append(clause)
        total += len(clause)
        cursor += 1
    joined = "".join(parts)[:target]
    if not formulas:
        return joined
    # 公式按原文顺序插在译文末尾。位置与真实链路不同（真实链路把它们放回
    # 原位），但基准量的是"公式有没有活到译文 PDF 里"，不是位置精度——
    # 位置由 layout.biou 与越界率负责。
    return joined + "".join(formulas)


def find_jar() -> Path:
    for candidate in JAR_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit(
        "找不到 OpenDataLoader 解析器 jar。找过：\n  "
        + "\n  ".join(str(c) for c in JAR_CANDIDATES)
    )


def run(
    cmd: list[str],
    cwd: Path | None = None,
    env: dict | None = None,
) -> subprocess.CompletedProcess:
    """跑一条外部命令。

    输出一律按 utf-8 读、坏字节替换：解析器 jar 在中文 Windows 上的 stderr 是
    GBK，按 utf-8 严格解码会抛 UnicodeDecodeError，把真正的失败原因埋掉。
    """
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def git_commit() -> str:
    """当前仓库的短提交号，取不到时给 "unknown"。

    真机基线必须带上它。真机测量一次要几分钟且要一个跑着的 Zotero，基线很可能会
    比 HEAD 旧好几个提交；不记下采自哪个提交，门禁报一项回归时分不清是"改坏了"
    还是"基线本来就旧"。取不到不抛错——脱离 git 工作树跑基准不该因此失败。
    """
    try:
        result = run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT)
    except OSError:
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    return result.stdout.strip() or "unknown"


def parse_with_jar(fixture_pdf: Path, workdir: Path) -> Path:
    """调解析器 jar，与产品同一套参数。返回产出的 JSON 路径。

    参数逐项对应 src/core/pdf/OpenDataLoaderPdfClient.ts 的 loadConfig 默认值：
    reading-order xycut 硬编码、table-method default、use-struct-tree 默认真、
    image-output embedded（翻译管线强制要内嵌图）。改这里而不改那边，基准量的
    就不是产品跑的那条路了。
    """
    jar = find_jar()
    out_dir = workdir / "odl"
    out_dir.mkdir(parents=True, exist_ok=True)
    result = run(
        [
            "java",
            "-jar",
            str(jar),
            "--format",
            "json",
            "--output-dir",
            str(out_dir),
            "--reading-order",
            "xycut",
            "--table-method",
            "default",
            "--image-output",
            "embedded",
            "--use-struct-tree",
            str(fixture_pdf),
        ]
    )
    produced = out_dir / f"{fixture_pdf.stem}.json"
    if result.returncode != 0 or not produced.exists():
        raise RuntimeError(
            f"解析器失败（退出码 {result.returncode}）\nstdout: {result.stdout[-2000:]}\n"
            f"stderr: {result.stderr[-2000:]}"
        )
    return produced


def clean_with_remover(fixture_pdf: Path, rects_path: Path, workdir: Path) -> Path | None:
    """用原文删除器跑一遍，返回删完的 PDF 路径。

    为什么无头路径要跑它：删除此前只在真机上量过（第一次真机抽查给出原文残留
    率 0.000 对 1.000），而无头路径压根不调用删除器——它产出 rects.txt 就丢在
    那里。那是整套基准里唯一"真机测得、无头从来没测过"的环节，而它守护的正是
    读者能不能复制到原文。

    参数与产品一致：jar 路径、rects 文件、输出 PDF，三个位置参数，没有额外开关。
    删除器把统计打在 stderr 上，这里原样收着交给度量侧解析。

    失败不抛：删除器缺失或崩溃时返回 None，度量侧报缺数据。基准不该因为一个
    可选环节的缺失而整篇失败。
    """
    if not REMOVER_JAR.exists():
        return None
    out_path = workdir / "cleaned.pdf"
    try:
        result = run(
            [
                "java",
                "-jar",
                str(REMOVER_JAR),
                str(fixture_pdf),
                str(rects_path),
                str(out_path),
            ]
        )
    except OSError:
        return None
    if result.returncode != 0 or not out_path.exists():
        return None
    return out_path


def bundle_driver(workdir: Path | None = None) -> Path:
    """把 TypeScript 驱动打包成 Node 可执行的文件。

    src 下的相对导入不带扩展名，Node 的 ESM 解析器不认，所以不能直接 node
    这个 .ts。esbuild 是 zotero-plugin-scaffold 的传递依赖，构建产物里本来
    就在用它，这里借用一下，不新增依赖。
    """
    esbuild = ROOT / "node_modules" / ".bin" / "esbuild.cmd"
    if not esbuild.exists():
        esbuild = ROOT / "node_modules" / ".bin" / "esbuild"
    if not esbuild.exists():
        raise SystemExit("找不到 esbuild（node_modules/.bin/esbuild）。先跑 npm install。")
    # 产物必须落在仓库内：--packages=external 会把 pdf-lib、fontkit 留成外部
    # 引用，Node 从产物所在目录逐级向上找 node_modules。放到临时目录就找不到，
    # 报成 ERR_MODULE_NOT_FOUND，看错误信息会以为是依赖没装。
    out = OUT_DIR / "render-entry.mjs"
    result = run(
        [
            str(esbuild),
            str(BENCH_DIR / "render-entry.ts"),
            "--bundle",
            "--format=esm",
            "--platform=node",
            "--packages=external",
            f"--outfile={out}",
        ]
    )
    if result.returncode != 0 or not out.exists():
        raise RuntimeError(f"打包驱动失败\nstdout: {result.stdout[-2000:]}\nstderr: {result.stderr[-2000:]}")
    return out


def node_driver(driver: Path, config: dict) -> dict:
    """跑一次无头驱动。config 经临时文件传递，避免命令行长度与转义问题。"""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    ) as handle:
        json.dump(config, handle, ensure_ascii=False)
        config_path = handle.name
    try:
        result = run(["node", str(driver), "--config", config_path])
    finally:
        os.unlink(config_path)
    if result.returncode != 0:
        raise RuntimeError(
            f"驱动失败（{config.get('mode')}）\nstdout: {result.stdout[-3000:]}\n"
            f"stderr: {result.stderr[-3000:]}"
        )
    return {"stdout": result.stdout.strip()}


def font_paths() -> dict:
    """字体候选路径。与 src/core/pdf/platform.ts 的 systemFontPathsForLang 同一
    份清单，顺序也一致——基准用的字体必须和产品在真机上解析到的是同一个，否则
    字宽度不同，换行与缩字的结论都不可迁移。"""
    windows_dir = os.environ.get("WINDIR") or r"C:\Windows"
    fonts = Path(windows_dir) / "Fonts"
    candidates = {
        "cjk": [fonts / "msyh.ttc", fonts / "msyhbd.ttc", fonts / "simsun.ttc", fonts / "simhei.ttf"],
        "latin": [fonts / "arial.ttf", fonts / "arialbd.ttf", fonts / "segoeui.ttf", fonts / "calibri.ttf"],
    }
    resolved: dict[str, str] = {}
    for slot, paths in candidates.items():
        for path in paths:
            if path.exists():
                resolved[slot] = str(path)
                break
    if "cjk" not in resolved:
        raise SystemExit(
            "找不到中文字体。基准的译文是中文，没有中文字体所有汉字会变成问号，"
            "版面指标全部失真。候选：" + ", ".join(str(p) for p in candidates["cjk"])
        )
    return resolved


def rasterize_formula_images(source_pdf: Path, assembly: dict, workdir: Path) -> dict:
    """把公式块的区域从原文栅格化出来，交给渲染器贴回原位。

    真机上这一步由 captureFormulaScreenshots 借阅读器的活 pdf.js 实例完成；
    无头路径用 pymupdf 渲染同一块区域。截图内容等价，取图路径不等价——这一点
    记在文档里，不装作覆盖。
    """
    fitz = metrics.fitz_module()
    out_dir = workdir / "formula-images"
    out_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[str, list[dict]] = {}
    doc = fitz.open(str(source_pdf))
    try:
        for block in assembly.get("formulaBlocks", []):
            page_index = block["pageNumber"] - 1
            if page_index >= doc.page_count:
                continue
            page = doc[page_index]
            box = block["bbox"]
            # 装配视图里所有框统一是 x0/y0/x1/y1（PDF 用户空间，左下原点）。
            # pymupdf 的 clip 用左上原点，翻一下再用。
            rect = fitz.Rect(
                box["x0"],
                page.rect.height - box["y1"],
                box["x1"],
                page.rect.height - box["y0"],
            )
            pixmap = page.get_pixmap(dpi=200, clip=rect)
            png_path = out_dir / f"p{block['pageNumber']}-{block['paragraphIndex']}.png"
            pixmap.save(str(png_path))
            data_uri = "data:image/png;base64," + base64.b64encode(
                png_path.read_bytes()
            ).decode("ascii")
            mapping.setdefault(str(block["pageNumber"]), []).append(
                {"dataUri": data_uri, "bbox": box}
            )
    finally:
        doc.close()
    return mapping


def run_fixture(name: str, ratio: float, keep_workdir: Path | None = None) -> dict:
    """跑一篇夹具的解析层与端到端层，返回该篇的全部指标。"""
    started = time.time()
    fixture_pdf = FIXTURE_DIR / f"{name}.pdf"
    key_path = KEY_DIR / f"{name}.json"
    if not fixture_pdf.exists():
        raise RuntimeError(f"夹具不存在：{fixture_pdf}")
    if not key_path.exists():
        raise RuntimeError(
            f"答案键不存在：{key_path}。先跑 python scripts/qa/benchmark/run.py --regen-keys"
        )
    key = json.loads(key_path.read_text(encoding="utf-8"))

    workdir = keep_workdir or Path(tempfile.mkdtemp(prefix="zt-bench-"))
    workdir.mkdir(parents=True, exist_ok=True)
    driver = bundle_driver()
    fonts = font_paths()

    # 1. 解析
    odl_path = parse_with_jar(fixture_pdf, workdir)
    odl_doc = json.loads(odl_path.read_text(encoding="utf-8"))

    # 2. 无头装配
    assembly_path = workdir / "assembly.json"
    node_driver(
        driver,
        {
            "mode": "assemble",
            "odl": str(odl_path),
            "source": str(fixture_pdf),
            "assembly": str(assembly_path),
        },
    )
    assembly = json.loads(assembly_path.read_text(encoding="utf-8"))

    # 3. 合成译文：逐页逐段，与装配段落严格对齐
    # 译文按段落下标与装配严格对齐。文本在装配视图里是单独一个 texts 数组，
    # 与 paragraphs 同位——渲染器的契约就是 paragraphs[i] 与 texts[i] 描述同一段。
    translations = [
        [
            synthetic_translation(paragraph["text"], page["pageNumber"] * 1000 + index, ratio)
            for index, paragraph in enumerate(page["paragraphs"])
        ]
        for page in assembly["pages"]
    ]

    # 4. 公式截图预栅格化
    formula_images = rasterize_formula_images(fixture_pdf, assembly, workdir)

    # 5. 无头渲染
    render_input_path = workdir / "render-input.json"
    render_input_path.write_text(
        json.dumps(
            {**assembly, "translations": translations, "formulaImages": formula_images},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    out_pdf = workdir / "translated.pdf"
    stats_path = workdir / "stats.json"
    rects_path = workdir / "rects.txt"
    node_driver(
        driver,
        {
            "mode": "render",
            "renderInput": str(render_input_path),
            "source": str(fixture_pdf),
            "fonts": fonts,
            "outPdf": str(out_pdf),
            "outStats": str(stats_path),
            "outRects": str(rects_path),
            "targetLanguage": "zh-CN",
        },
    )
    stats = json.loads(stats_path.read_text(encoding="utf-8")) if stats_path.exists() else {}

    # 6. 度量
    odl = metrics.flatten_odl(odl_doc)
    page_widths = {page["pageNumber"]: page["width"] for page in assembly["pages"]}
    flagged = {
        (block["pageNumber"], metrics.norm_text(block["originalText"]))
        for block in assembly.get("formulaBlocks", [])
    }
    # 公式子区间标记数：装配层写进送翻译文本的 $...$ 对数。
    #
    # 它和 formula 那三项量的不是一回事：那三项问"哪一段被整段判成公式区"，
    # 这个问"段内的公式子串被圈出来了多少"。行内公式只有后者看得见——一段
    # 统计正文整段判否是对的，但里面的 θ = 0 仍应被圈住、被保护层摘出翻译
    # 请求。批 1 之前这个数恒为 0，因为链路只做整段替换。
    span_marked = 0
    for page in assembly.get("pages", []):
        for para in page.get("paragraphs", []):
            span_marked += (para.get("text") or "").count("$") // 2

    matched = metrics.match_elements(key, odl)
    matched_pairs = list(matched.get("pairs", []))
    formula = metrics.formula_detection(key, odl, flagged, matched_pairs)
    parse_metrics = {
        "spanMarked": span_marked,
        "formula": {k: v for k, v in formula.items() if k != "cases"},
        "formulaCases": formula["cases"],
        "match": {k: v for k, v in matched.items() if k != "pairs"},
        "column": metrics.column_bleed(key, odl, page_widths),
        "heading": metrics.heading_levels(key, odl, matched_pairs),
        "table": metrics.table_structure(key, odl),
        "readingOrder": metrics.reading_order(key, odl, matched_pairs),
        "figure": metrics.figure_detection(key, odl),
        "figureText": metrics.figure_text(key, assembly, str(fixture_pdf)),
        "pageRoles": metrics.page_roles(assembly),
    }

    # 渲染端自己的诊断也传进去，度量才能算出 silentRight——它看见而产品没报的
    # 右溢出。见 metrics.layout_metrics 的 docstring。
    layout = metrics.layout_metrics(str(fixture_pdf), str(out_pdf), assembly, stats)
    layout["mask"]["punch"] = metrics.mask_punch(str(fixture_pdf), str(out_pdf), assembly)
    pixel = metrics.outside_pixel_diff(str(fixture_pdf), str(out_pdf), assembly)
    residue = metrics.source_residue(str(fixture_pdf), str(out_pdf), key.get("sourceScript", "latin"))

    # 原文删除：无头路径此前只产出 rects.txt 从不调用删除器，于是删除效果只能
    # 靠真机抽查量。这里补上——用同一份 rects 跑一遍 jar，再量删完的 PDF 还剩
    # 多少原文。这不改变译文 PDF 的产出路径（渲染仍用未删的源），是一次独立的
    # 旁路测量，所以不影响任何既有版面指标。
    cleaned = clean_with_remover(fixture_pdf, rects_path, workdir)
    removal = metrics.removal_effect(
        str(fixture_pdf), str(cleaned) if cleaned else None, rects_path, assembly
    )

    return {
        "fixture": name,
        "layout": next((f["layout"] for f in FIXTURES if f["name"] == name), ""),
        "elapsedMs": int((time.time() - started) * 1000),
        "parse": parse_metrics,
        "layout": layout,
        "pixel": pixel,
        "residue": residue,
        "removal": removal,
        "stats": stats,
        "artifacts": {
            "translatedPdf": str(out_pdf),
            "assembly": str(assembly_path),
        },
    }


# ---------------------------------------------------------------------------
# 门禁
# ---------------------------------------------------------------------------

# (指标路径, 容差种类, 方向)。路径里的 * 匹配任意一层键。
# 方向只有两种：higher 是越大越好，lower 是越小越好。
WATCHED: list[tuple[str, str, str]] = [
    ("parse.formula.precision", "ratio", "higher"),
    ("parse.formula.recall", "ratio", "higher"),
    ("parse.formula.f1", "ratio", "higher"),
    ("parse.match.f1", "ratio", "higher"),
    ("parse.match.meanSim", "ratio", "higher"),
    ("parse.match.byType.*.recall", "ratio", "higher"),
    ("parse.column.crossColumnRatio", "ratio", "lower"),
    # 合并块才是该门禁的：通栏标题与图注本来就超宽，宽度判据有一个下不去的最低
    # 值；而跨栏合并块吞掉邻段，通栏元素不吞，这一项能真正归零。
    ("parse.column.mergedBlockRatio", "ratio", "lower"),
    # 图内文字被当正文处理的段落数。量的是产品行为，不是解析器必然检不出的
    # 东西，所以进门禁：产品侧改成排除之后它该降下来，不改则一直绿。
    ("parse.figureText.paragraphs", "count", "lower"),
    # 非数字页上装配出的段落数。产品把扫描页与劣质文本层页路由给识别侧车，
    # 无头路径不跑那段编排；这一项大于 0 就是无头路径把本该走 OCR 的页走了
    # ODL 装配。它量的是无头路径的可信度，不是产品缺陷——五篇数字夹具上恒为
    # 0，涨起来说明无头路径开始照单全收不该它接的页。
    ("parse.pageRoles.nonDigitalParagraphs", "count", "lower"),
    # 删除后原文残留。旁路测量（用装配层的区域文件跑删除器，量删完的 PDF），
    # 不改变译文 PDF 的产出路径。涨起来说明删除器对该篇删不动了——批 7 修的
    # 正是"退出码 0 但一个字符都没删"那种情形。
    #
    # 盯的是 nonTableRatio 而不是 residueRatio：表格是产品有意不译不删的
    # （odlToAssembly 的注释写明是用户已确认的偏好），那部分残留是预期结果。
    # attention-reading 的 residueRatio 0.031 全部落在表格区内，nonTableRatio
    # 为 0。混在一个数里就看不出这个区分，每次都得人工核对一遍。
    ("removal.nonTableRatio", "ratio", "lower"),
    ("parse.heading.agreement", "ratio", "higher"),
    ("parse.readingOrder.tau", "ratio", "higher"),
    ("layout.biou", "ratio", "higher"),
    ("layout.boxRecall", "ratio", "higher"),
    ("layout.boxPrecision", "ratio", "higher"),
    ("layout.utb", "count", "lower"),
    ("layout.overflow.right", "count", "lower"),
    ("layout.overflow.bottom", "count", "lower"),
    ("layout.overflow.top", "count", "lower"),
    # 度量看见而渲染端没报的右溢出。渲染端补上横向计数之后它该归零；不为 0 说明
    # 读者看得见译文画出框外而产品统计不知道。
    ("layout.overflow.silentRight", "count", "lower"),
    ("layout.fontSize.below06Ratio", "ratio", "lower"),
    ("layout.fontSize.p10", "ratio", "higher"),
    ("layout.mask.intrusionIntoParagraph", "count", "lower"),
    ("layout.mask.intrusionIntoRegion", "count", "lower"),
    # 遮罩打穿非白背景的个数。产品侧补上背景色采样之后它该归零；不改则一直绿。
    ("layout.mask.punch.punchedMasks", "count", "lower"),
    ("layout.unassignedSpans", "count", "lower"),
    ("pixel.outsideDiffRatio", "ratio", "lower"),
    ("residue.residueRatio", "ratio", "lower"),
    ("stats.overflowed", "count", "lower"),
    ("stats.formulasRendered", "count", "lower"),
    ("stats.imagesDropped", "count", "lower"),
    ("stats.paragraphsRendered", "count", "higher"),
]

TOLERANCE = {"ratio": 0.01, "count": 0}

# 绝对底线：不管基线是多少都不许越过。0.002 沿用 prototype 下那个跑过 14 个
# 文档的探针的阈值；BIoU 大于 0 只是要求"确实有译文落在框里"。
#
# 字号那条是真机审核补的。无头路径五篇的 below06Ratio 全是 0.000（合成译文长度
# 受控，渲染端那两条杠杆根本不会启动），真机最高 0.321——近三分之一的译文字号被压
# 到原文六成以下。基线对照在这里不够用：基线只会把当前这个难看的值冻结成"正常"。
# 所以加一条绝对上限：一半以上的译文低于六成，无论基线怎么说都是坏的。渲染端的
# 字号下限是 max(4, 0.4×原文)，理论上这个比例能到 1.0，0.5 留出了余量。
FLOORS: list[tuple[str, str, float]] = [
    ("pixel.outsideDiffRatio", "<=", 0.002),
    ("layout.biou", ">", 0.0),
    ("layout.fontSize.below06Ratio", "<=", 0.5),
]

# 真机门禁不比对回归的路径。`silentRight` 等于"度量数到的右溢"减去"产品自己报的
# 右溢"，而真机测量拿不到产品的诊断（无头路径才传 stats），所以它在真机侧恒等于
# `overflow.right`。拿它比回归，等于把同一个数以两个名字报两遍，而且其中一个名字
# 会让人以为"产品开始静默溢出了"——那是无头路径上才有意义的判断。绝对底线不涉及
# 它，所以只从回归比较里摘掉。
REAL_MACHINE_SKIP_PATHS = {"layout.overflow.silentRight"}


def resolve(node, parts: list[str]):
    """按路径取叶子值，* 通配一层。

    终止分支必须是 yield 不能是 return：这是个生成器函数，return 只是结束
    迭代，什么都不产出。写成 return 的后果是 collect_watched 拿到空字典，
    门禁拿一个指标都比不了，于是永远"通过"——一个只会说绿的門禁比没有门禁更
    糟，因为它给人虚假的信心。这个错是真犯过又修掉的。
    """
    if not parts:
        yield node
        return
    head, rest = parts[0], parts[1:]
    if isinstance(node, dict):
        if head == "*":
            for value in node.values():
                yield from resolve(value, rest)
        elif head in node:
            yield from resolve(node[head], rest)
    elif isinstance(node, list):
        for item in node:
            yield from resolve(item, parts)


def collect_watched(result: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for path, _, _ in WATCHED:
        for value in resolve(result, path.split(".")):
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out[path] = float(value)
    return out


def compare(
    baseline: dict, current: dict, skip: set[str] | None = None
) -> tuple[list[dict], list[dict]]:
    """逐指标比基线与当前。返回 (回归项, 越过绝对底线的项)。

    skip 里的路径不参与回归比较（绝对底线照旧算）。给真机门禁用：有些指标只在
    无头路径上有意义，放到真机上比是在报一个没有含义的数。
    """
    skip = skip or set()
    baseline_watched = collect_watched(baseline)
    current_watched = collect_watched(current)
    regressions: list[dict] = []
    floor_breaks: list[dict] = []
    for path, kind, direction in WATCHED:
        if path in skip:
            continue
        if path not in baseline_watched or path not in current_watched:
            continue
        before = baseline_watched[path]
        after = current_watched[path]
        tolerance = TOLERANCE[kind]
        if direction == "higher":
            dropped = before - after
            if dropped > tolerance:
                regressions.append(
                    {"path": path, "baseline": before, "current": after, "delta": -dropped}
                )
        else:
            rose = after - before
            if rose > tolerance:
                regressions.append(
                    {"path": path, "baseline": before, "current": after, "delta": rose}
                )
    for path, operator, limit in FLOORS:
        for value in resolve(current, path.split(".")):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if operator == "<=" and value > limit:
                floor_breaks.append({"path": path, "value": value, "limit": limit, "op": operator})
            if operator == ">" and value <= limit:
                floor_breaks.append({"path": path, "value": value, "limit": limit, "op": operator})
    return regressions, floor_breaks


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------


def fmt(value, digits: int = 3) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_report(results: list[dict], regressions: list[dict], floors: list[dict]) -> str:
    lines: list[str] = []
    lines.append("# 版面保留翻译评测报告")
    lines.append("")
    lines.append(
        "生成命令：`python scripts/qa/benchmark/run.py`。数字为无头路径的结果，"
        "译文是长度受控的合成中文，度量的是版面不是翻译质量。"
    )
    lines.append("")
    lines.append("## 总览")
    lines.append("")
    header = [
        "夹具",
        "公式精确率",
        "公式召回率",
        "段落 F1",
        "栏串位率",
        "合并块率",
        "图内文字段",
        "交并比",
        "框内滞留",
        "未翻译块",
        "字号低于 0.6",
        "遮罩侵入段",
        "遮罩侵图区",
        "遮罩打穿",
        "静默右溢",
        "非数字页段",
        "删除区域数",
        "删除后残留 表内/表外",
        "框外像素差异",
        "原文残留",
        "渲染溢出 纵/横",
    ]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "---|" * len(header))
    for result in results:
        parse = result.get("parse", {})
        layout = result.get("layout", {})
        pixel = result.get("pixel", {})
        removal = result.get("removal", {})
        row = [
            result["fixture"],
            fmt(parse.get("formula", {}).get("precision")),
            fmt(parse.get("formula", {}).get("recall")),
            fmt(parse.get("match", {}).get("f1")),
            fmt(parse.get("column", {}).get("crossColumnRatio")),
            fmt(parse.get("column", {}).get("mergedBlockRatio")),
            str(parse.get("figureText", {}).get("paragraphs", "")),
            # 非数字页上装配出的段落数。产品把这些页路由给识别侧车，无头路径
            # 不跑那段编排——这一列大于 0 就说明无头路径把本该走 OCR 的页走了
            # ODL 装配（扫描页是 0 段没东西译，劣质页是满段乱码被当正文）。
            str(parse.get("pageRoles", {}).get("nonDigitalParagraphs", "")),
            # 删除区域数与删完后的原文残留。这一对是旁路测量：用装配层产出的同一份
            # 区域文件跑一遍删除器，再量删完的 PDF 还剩多少源语言字母。它不改变
            # 译文 PDF 的产出路径，所以不影响上面任何版面指标。
            #
            # 残留不为 0 有两种完全不同的原因，看数字大小能分：attention-reading
            # 的 0.031 全部来自那张从未被翻译的表格（表格在装配层没有对应段落，
            # 既不译也不删），那是第三批批次 8 的题目；若某篇残留接近 1，说明删除
            # 器对该篇一个字符都没删掉——那正是批 7 修的情形。
            str(removal.get("requested", "")),
            # 删除后残留拆成两个数：表格区内 / 区外。表格是产品有意不译不删的，
            # 区内那部分是预期残留；区外那部分才是"该删没删"。见 metrics
            # .removal_effect 的说明。
            (
                f"{fmt(removal.get('tableRatio'), 3)}/{fmt(removal.get('nonTableRatio'), 3)}"
                if removal.get("residueRatio") is not None
                else "未测"
            ),
            fmt(layout.get("biou")),
            fmt(layout.get("boxPrecision")),
            str(layout.get("utb", "")),
            fmt(layout.get("fontSize", {}).get("below06Ratio")),
            str(layout.get("mask", {}).get("intrusionIntoParagraph", "")),
            str(layout.get("mask", {}).get("intrusionIntoRegion", "")),
            str(layout.get("mask", {}).get("punch", {}).get("punchedMasks", "")),
            str(layout.get("overflow", {}).get("silentRight", "")),
            fmt(pixel.get("outsideDiffRatio"), 5),
            fmt(result.get("residue", {}).get("residueRatio")),
            # 纵向与横向分开显示：批 5 之前渲染端只数纵向，横向溢出一处都没报过，
            # 读者看得见译文画出框外而产品统计说一切正常。两个数各有各的含义——
            # 纵向是"塞不下被截断"，横向是"折行宽度的地板把字画出了框"。
            f"{result.get('stats', {}).get('overflowed', '')}"
            f"/{result.get('stats', {}).get('overflowedRight', '')}",
        ]
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    dense = next((r for r in results if r["fixture"] == "formula-dense"), None)
    if dense:
        lines.append("## 公式判域逐案（formula-dense）")
        lines.append("")
        lines.append(
            "聚合数字会把具体段落平均掉。这一张表列出每个已知边界样本各自的去向，"
            "第三批批次 1 要看的就是它。"
        )
        lines.append("")
        lines.append("| 真值 | 预测 | 边界样本 | 文本 |")
        lines.append("|---|---|---|---|")
        for case in dense.get("parse", {}).get("formulaCases", []):
            if not case.get("hardCase") and case.get("truth") == case.get("predicted"):
                continue
            lines.append(
                f"| {'公式' if case['truth'] else '正文'} "
                f"| {'公式' if case['predicted'] else '正文'} "
                f"| {case.get('hardCase') or '—'} "
                f"| {case['text'][:52]} |"
            )
        lines.append("")

    lines.append("## 门禁")
    lines.append("")
    if not regressions and not floors:
        lines.append("通过：没有指标越过容差，也没有指标越过绝对底线。")
    else:
        for item in regressions:
            lines.append(
                f"- 回归 `{item['path']}`：基线 {fmt(item['baseline'])} → 当前 "
                f"{fmt(item['current'])}（差 {fmt(item['delta'])}）"
            )
        for item in floors:
            lines.append(
                f"- 越过绝对底线 `{item['path']}`：当前 {fmt(item['value'])}，"
                f"要求 {item['op']} {fmt(item['limit'])}"
            )
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 真机抽查
# ---------------------------------------------------------------------------


def qa_zotero_running() -> bool:
    """有没有一个 QA 实例在跑。按命令行里是否带当前 QA_ROOT 判断。

    不能看 probe-ready.json：那个文件不随进程退出而清理，昨天跑完留下的 ready
    文件会让这一步以为真机还活着，于是把命令写进一个没有驱动轮询的通道里，直到
    超时——失败信息指向"installPdf 失败"，看起来像夹具或导入的问题，其实是真机
    根本没起。判断方式与 real-machine.mjs 的 stopQaZotero 一致。
    """
    qa_root = os.environ.get("QA_ROOT", r"D:\zt-qa")
    query = (
        'Get-CimInstance Win32_Process -Filter "name=\'zotero.exe\'" | '
        f"Where-Object {{ $_.CommandLine -like '*{qa_root}*' }} | "
        "ForEach-Object { $_.ProcessId }"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", query],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except Exception:  # noqa: BLE001
        return False
    return any(token.strip().isdigit() for token in result.stdout.split())


def real_machine_check(name: str, reuse_translated: bool = False) -> dict:
    """点火真机流水线，取出译文附件，用同一套版面指标度量。

    reuse_translated 为真时不重新点火，直接找库里已有的译文附件来度量。全新
    profile 的第一次流水线要反复重试「PDFViewerApplication not ready in reader
    iframe」，实测十分钟以上，且慢在与版面无关的一次性初始化上；只要比对数字，
    复用已有产出就够了。复用时打印文件的修改时间，避免拿一份来路不明的旧文件
    得出一个看起来新鲜的结论。
    """
    qa_root = Path(os.environ.get("QA_ROOT", r"D:\zt-qa"))
    launcher = ROOT / "scripts" / "qa" / "real-machine.mjs"
    fixture_pdf = FIXTURE_DIR / f"{name}.pdf"

    if reuse_translated:
        # 按夹具页数挑，别默认"最新一条就是它"。库里躺着历次抽查的产出，光取最新
        # 会取错——three-column 实测误取过 attention-reading 的两页附件。
        found = find_translated_attachment(launcher, expected_pages=pdf_page_count(str(fixture_pdf)))
        if found:
            print(f"  复用已有译文附件（修改于 {found[1]}）：{found[0]}")
            return measure_real_machine(name, fixture_pdf, found[0])
        print("  库里没有译文附件，改为正常点火流水线")

    # 已有 QA 实例就复用，没有才 boot。复用不是偷懒：boot 每次都用一份全新
    # profile，而全新 profile 第一次开阅读器要反复重试
    # 「PDFViewerApplication not ready in reader iframe」，实测多花十分钟以上，
    # 全花在和版面无关的一次性初始化上。要从头来就手工 shoot 再跑。
    if qa_zotero_running():
        print("  复用已在运行的 QA 实例（要重来先 node scripts/qa/real-machine.mjs shoot）")
    else:
        print("  启动真机（boot）……")
        boot = run(["node", str(launcher), "boot"])
        if boot.returncode != 0:
            raise RuntimeError(f"boot 失败\n{boot.stdout[-2000:]}\n{boot.stderr[-2000:]}")

    # 点火前先拍快照：库里此刻有哪些译文附件、各自改到什么时间。没有这一份，
    # 轮询分不清"这一轮新产出的"与"往轮次留下的"，第二篇以后的夹具就会拿上一篇
    # 的产出当结论（three-column 实测踩中：报"页数不一致：原文 1，译文 2"）。
    before = snapshot_translated_attachments(launcher)

    steps = [
        ["send", "installPdf", str(fixture_pdf)],
        ["send", "pipelineStart", "{}"],
    ]
    for step in steps:
        # 慢命令单独给超时：全新 profile 第一次导入附件要做索引与缩略图，
        # 默认 180 秒不够。QA_CMD_TIMEOUT 是启动器认的环境变量，单位毫秒。
        timeout = "600000" if step[1] in ("installPdf", "pipelineStart") else None
        result = run(
            ["node", str(launcher), *step],
            **({"env": {**os.environ, "QA_CMD_TIMEOUT": timeout}} if timeout else {}),
        )
        if result.returncode != 0:
            raise RuntimeError(f"真机命令 {step[1]} 失败\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}")
        print(f"  {step[1]}: {result.stdout.strip()[:200]}")


    # 轮询译文附件，直到出现**这一轮新的**或超时。全新 profile 的第一次流水线要做
    # 一堆一次性的事（解析器 jar、字体解析、阅读器开关、译文附件落盘），实测比"跑第二遍"
    # 慢一个量级，300 秒不够——第一版就是 300 秒，轮询空手而归，而译文在放弃之后
    # 几十秒才落地，失败信息指向"没有产出"，其实是等得不够久。
    #
    # 只判"库里有译文附件"是不够的：跑第二篇夹具时，上一篇的译文还躺在库里，轮询
    # 第一眼就看见它、立刻收工，于是拿上一篇的产出当本篇的结论。three-column 就
    # 是这样报了一次"页数不一致：原文 1，译文 2"——报得对，但病根在挑文件，不在
    # 流水线。所以轮询只认快照之后新出现的条目，或者文件确实被改写过的条目。
    deadline = time.time() + REAL_MACHINE_TIMEOUT_S
    translated_path = None
    fresh_stamp = ""
    waited = 0
    while time.time() < deadline:
        result = run(["node", str(launcher), "send", "translated"])
        fresh = fresh_translated_attachment(translated_items(result.stdout), before)
        if fresh:
            translated_path = fresh.get("filePath")
            fresh_stamp = translated_attachment_stamp(translated_path)
            break
        waited += 1
        if waited % 6 == 1:
            print(f"  等新译文附件……已等 {waited * 5} 秒", flush=True)
        time.sleep(5)
    if not translated_path or not Path(translated_path).exists():
        raise RuntimeError(
            f"等了 {REAL_MACHINE_TIMEOUT_S} 秒仍没有新的译文附件。先手工确认流水线能跑通："
            "node scripts/qa/real-machine.mjs send translated"
        )
    print(f"  本轮译文附件（修改于 {fresh_stamp}）：{translated_path}")
    return measure_real_machine(name, fixture_pdf, translated_path)


def load_real_machine_rows(path: Path) -> list[dict]:
    """读回历次真机抽查累积下来的行。文件不在或读坏了就当没有，不因此丢掉本轮结果。

    真机抽查一次只跑一篇，而它的价值在五篇并排看。早先每跑一篇就整份重写，
    五篇跑完只剩最后一篇——恰恰把最有信息量的对比弄丢了。所以改成按夹具名累积，
    同一夹具重跑就覆盖旧行。
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = payload.get("rows") if isinstance(payload, dict) else None
    return rows if isinstance(rows, list) else []


def translated_items(stdout: str) -> list[dict]:
    """从启动器的回包里取出译文附件数组。

    回包是 {"id":..,"ok":true,"action":"translated","result":{"count":..,"items":[..]}}
    ——items 在 result 里面，不在最外层。读错一层不会报错，只会永远返回空列表：
    译文附件明明已经落盘，轮询却一次都没看见，白等满整个超时。这种错不抛异常，
    只让你以为自己等得不够久。
    """
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, dict):
        return []
    inner = payload.get("result")
    if not isinstance(inner, dict):
        return []
    items = inner.get("items")
    return items if isinstance(items, list) else []


def pdf_page_count(file_path: str) -> int | None:
    """读一份 PDF 的页数，读不出给 None。"""
    try:
        doc = metrics.fitz_module().open(file_path)
    except Exception:  # noqa: BLE001
        return None
    try:
        return doc.page_count
    finally:
        doc.close()


def pick_attachment_by_page_count(
    candidates: list[dict],
    expected_pages: int,
    page_counter,
) -> tuple[dict, bool]:
    """从新到旧挑第一个页数对得上的译文附件。

    返回 (挑中的条目, 是否真对上了)。挑不到时返回最新的那条但第二个值是 False——
    调用方必须把这个"没对上"说出口。静默退回最新那条正是误取的成因：three-column
    实测就是这么拿了两页的旧附件，报了一个看起来像产品问题的"页数不一致"。

    candidates 按条目 id 升序（启动器的回包就是这个次序），所以倒着看就是从新到旧。
    """
    for item in reversed(candidates):
        if page_counter(item["filePath"]) == expected_pages:
            return item, True
    return candidates[-1], False


def find_translated_attachment(
    launcher: Path, expected_pages: int | None = None
) -> tuple[str, str] | None:
    """查库里已有的译文附件，返回 (路径, 修改时间)。没有返回 None。

    expected_pages 给了就按页数挑。库里躺着历次抽查好几篇夹具的产出，光取"最新一条"
    很可能取错；页数是附件上唯一能跟夹具对上的信号（附件元数据里没有夹具名）。
    """
    result = run(["node", str(launcher), "send", "translated"])
    items = translated_items(result.stdout)
    if not items:
        return None
    candidates = [i for i in items if i.get("filePath") and Path(i["filePath"]).exists()]
    if not candidates:
        return None
    chosen = candidates[-1]
    if expected_pages is not None:
        chosen, matched = pick_attachment_by_page_count(
            candidates, expected_pages, pdf_page_count
        )
        if not matched:
            newest = candidates[-1]
            print(
                f"  警告：库里没有 {expected_pages} 页的译文附件，"
                f"最新的那份是 {pdf_page_count(newest['filePath'])} 页"
                f"（{newest['filePath']}）。对不上就别信这个数。"
            )
    file_path = chosen["filePath"]
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(Path(file_path).stat().st_mtime))
    return file_path, stamp


def translated_attachment_stamp(file_path: str) -> str:
    """附件文件的本地修改时间，读不到时给一句实话而不是编一个时间。"""
    try:
        mtime = Path(file_path).stat().st_mtime
    except OSError:
        return "读取不到"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))


def snapshot_from_items(items: list[dict]) -> dict:
    """给一批译文附件条目拍快照：条目 id → 文件修改时间。

    用来把"这一轮新产出的附件"与"往轮次留下的旧附件"分开。items 按条目 id 升序，
    新导入的一轮 id 最大，所以正常情况下新条目直接靠"快照里没有这个 id"认出来；
    万一某一轮改写了同一条目（id 不变而文件被重写），修改时间这一路还能认出来。
    """
    snapshot: dict = {}
    for item in items:
        file_path = item.get("filePath")
        if not file_path:
            continue
        try:
            snapshot[item.get("id")] = Path(file_path).stat().st_mtime
        except OSError:
            # 文件不在了：记 None。之后任何同名产出都算新的——宁可多重跑一次度量，
            # 也不要把一份已经消失的文件当成有效基线。
            snapshot[item.get("id")] = None
    return snapshot


def snapshot_translated_attachments(launcher: Path) -> dict:
    """查一次库，把当前的译文附件拍成快照。"""
    result = run(["node", str(launcher), "send", "translated"])
    return snapshot_from_items(translated_items(result.stdout))


def fresh_translated_attachment(items: list[dict], before: dict) -> dict | None:
    """从一批条目里挑出快照之后新出现的译文附件，没有则 None。

    认新不认旧：条目 id 不在快照里，或者文件修改时间晚于快照记下的那个。
    两条都不满足的条目是往轮次的遗留产物——three-column 那次"页数不一致：原文 1，
    译文 2"就是误拿了这么一份。挑的时候取 id 最大的那个：items 按 id 升序，id 最大
    的是最后导入的，也就是这一轮最可能刚写出来的那份。
    """
    chosen: dict | None = None
    if isinstance(items, str):  # 调用点传错了：把回包原文当成了条目数组
        raise TypeError(
            "fresh_translated_attachment 要的是条目数组，不是回包字符串；"
            "先过一遍 translated_items()"
        )
    for item in items:
        key = item.get("id")
        file_path = item.get("filePath")
        if not file_path or not Path(file_path).exists():
            continue
        if key not in before:
            chosen = item
            continue
        previous = before[key]
        if previous is None:
            chosen = item
            continue
        try:
            if Path(file_path).stat().st_mtime > previous:
                chosen = item
        except OSError:
            continue
    return chosen


def measure_real_machine(name: str, fixture_pdf: Path, translated_path: str) -> dict:
    """对一份真机产出的译文 PDF 跑 B 组指标。装配视图仍由无头那一遍产出。"""
    workdir = Path(tempfile.mkdtemp(prefix="zt-bench-real-"))
    driver = bundle_driver()
    odl_path = parse_with_jar(fixture_pdf, workdir)
    assembly_path = workdir / "assembly.json"
    node_driver(
        driver,
        {
            "mode": "assemble",
            "odl": str(odl_path),
            "source": str(fixture_pdf),
            "assembly": str(assembly_path),
        },
    )
    assembly = json.loads(assembly_path.read_text(encoding="utf-8"))

    layout = metrics.layout_metrics(str(fixture_pdf), translated_path, assembly)
    pixel = metrics.outside_pixel_diff(str(fixture_pdf), translated_path, assembly)
    residue = metrics.source_residue(str(fixture_pdf), translated_path, "latin")
    return {
        "fixture": name,
        "translatedPdf": translated_path,
        "layout": layout,
        "pixel": pixel,
        "residue": residue,
    }


# ---------------------------------------------------------------------------
# 扫描件层
# ---------------------------------------------------------------------------


def ocr_stage() -> dict:
    """扫描件层。没有侧车产出就明确报缺数据，不假装通过。"""
    fitz = metrics.fitz_module()
    truth_pdf = FIXTURE_DIR / "reading-brain.pdf"
    ground_truth: list[dict] = []
    doc = fitz.open(str(truth_pdf))
    try:
        for page in doc:
            height = page.rect.height
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    text = metrics.norm_text(
                        "".join(span.get("text", "") for span in line.get("spans", []))
                    )
                    if not text:
                        continue
                    box = metrics.flip_y(line["bbox"], height)
                    ground_truth.append(
                        {
                            "page": page.number + 1,
                            "bbox": box,
                            "text": text,
                        }
                    )
    finally:
        doc.close()

    sidecar_dir = Path(os.environ.get("BENCH_SIDECAR_DIR", ""))
    result_path = sidecar_dir / "result.json" if str(sidecar_dir) else None
    if not result_path or not result_path.exists():
        return {
            "status": "unavailable",
            "reason": (
                "没有侧车产出。设 BENCH_SIDECAR_DIR 指向含 result.json 的目录即可算。"
                "本机 PaddleOCR 推理跑不通（oneDNN PIR 缺陷），这一项目前必然报缺。"
            ),
            "groundTruthLines": len(ground_truth),
        }
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    measured = metrics.ocr_metrics(payload.get("pages", []), ground_truth)
    return {"status": "ok", **measured}


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def harness_selftest() -> int:
    """真机挑附件与真机门禁的自检。

    为什么单为它开一个入口：这两处判错都不抛异常、不报错，只是安静地给错结论。
    挑附件挑错了，是拿一篇旧产出当新结论——three-column 实测就这么报过一次
    "页数不一致"；门禁判错了，是永远说绿。两种错在报告上都像被测对象的问题，
    所以判据本身必须有守卫。

    真机门禁那一组全是纯数据，不点火：它跑一次要几分钟且要一个活着的 Zotero，
    进不了日常自检，可它坏了就是永远绿。所以把"确实抓得到回归"这一条钉在这儿，
    包括一条正控——一模一样的两份数据不许报回归，否则"抓得到"可能只是它见什么都报。

    挑附件那一组全部用真实临时文件，不 mock 文件系统：判据一半建立在 mtime 上，
    mock 掉 stat 就等于把要测的东西测没了。
    """
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if ok:
            print(f"  ok   {name}")
        else:
            failures += 1
            print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))

    workdir = Path(tempfile.mkdtemp(prefix="zt-bench-selftest-"))
    try:
        old = workdir / "old.pdf"
        old.write_bytes(b"old")
        new = workdir / "new.pdf"
        new.write_bytes(b"new")
        old_mtime = old.stat().st_mtime

        # 往轮次留下的条目：id 在快照里，文件没动过。必须不认。
        stale = [{"id": 3, "filePath": str(old)}]
        before = snapshot_from_items(stale)
        check(
            "快照记下既有条目的 id 与修改时间",
            set(before) == {3} and abs(before[3] - old_mtime) < 1e-9,
            f"got {before}",
        )
        check(
            "文件未改动的旧条目不认（防拿上一篇产出当本篇结论）",
            fresh_translated_attachment(stale, before) is None,
        )

        # 这一轮新导入的条目：id 不在快照里。必须认。
        with_new = stale + [{"id": 12, "filePath": str(new)}]
        picked = fresh_translated_attachment(with_new, before)
        check(
            "快照里没有的新条目被认出",
            picked is not None and picked.get("id") == 12,
            f"got {picked}",
        )

        # 同一批里有多条新条目时取 id 最大的：items 按 id 升序，id 最大的是最后
        # 导入的那份，也就是这一轮最可能刚写出来的。
        with_two_new = with_new + [{"id": 15, "filePath": str(workdir / "newer.pdf")}]
        (workdir / "newer.pdf").write_bytes(b"newer")
        picked_two = fresh_translated_attachment(with_two_new, before)
        check(
            "多条新条目时取 id 最大的",
            picked_two is not None and picked_two.get("id") == 15,
            f"got {picked_two}",
        )

        # 同一条目被改写（id 不变、文件变了）：靠 mtime 认。
        time.sleep(0.05)
        old.write_bytes(b"rewritten")
        picked_rewritten = fresh_translated_attachment(stale, before)
        check(
            "同一条目文件被改写后靠修改时间认出",
            picked_rewritten is not None and picked_rewritten.get("id") == 3,
            f"got {picked_rewritten}",
        )

        # 快照里记的是 None（当时文件不存在）：之后出现即认。
        before_missing = snapshot_from_items([{"id": 7, "filePath": str(workdir / "gone.pdf")}])
        check("文件不存在时快照记 None", before_missing == {7: None}, f"got {before_missing}")
        (workdir / "gone.pdf").write_bytes(b"back")
        picked_back = fresh_translated_attachment(
            [{"id": 7, "filePath": str(workdir / "gone.pdf")}], before_missing
        )
        check("快照记 None 的条目重新出现后被认出", picked_back is not None, f"got {picked_back}")

        # 条目指向的文件不在：跳过，不当成候选。
        check(
            "文件不存在的条目被跳过",
            fresh_translated_attachment([{"id": 99, "filePath": str(workdir / "nope.pdf")}], before)
            is None,
        )
        # 没有 filePath 字段的条目：跳过，不抛 KeyError。
        check("缺 filePath 的条目被跳过", fresh_translated_attachment([{"id": 1}], before) is None)
        # 空列表：None。
        check("空列表返回 None", fresh_translated_attachment([], before) is None)

        # 累积读回：文件不在、内容是坏的 JSON、结构不对，都当没有，不炸。
        check(
            "real-machine.json 不存在时当没有行",
            load_real_machine_rows(workdir / "missing.json") == [],
        )
        broken = workdir / "broken.json"
        broken.write_text("{ 不是 json", encoding="utf-8")
        check("内容是坏的 JSON 时当没有行", load_real_machine_rows(broken) == [])
        wrong_shape = workdir / "wrong.json"
        wrong_shape.write_text(json.dumps({"rows": "not-a-list"}), encoding="utf-8")
        check("rows 不是数组时当没有行", load_real_machine_rows(wrong_shape) == [])
        good = workdir / "good.json"
        good.write_text(json.dumps({"rows": [{"fixture": "a"}]}), encoding="utf-8")
        check(
            "正常的文件读回原行",
            load_real_machine_rows(good) == [{"fixture": "a"}],
            f"got {load_real_machine_rows(good)}",
        )

        # ── 真机门禁那一侧 ──
        # 为什么必须在这儿测：真机门禁跑一次要几分钟且要一个活着的 Zotero，不可能
        # 进日常自检。可它要是坏了——比如 collect_watched 在真机行的结构上取不到值、
        # 或者 compare 对真机行不报回归——表现就是永远绿。一个只会说绿的门禁比没有
        # 门禁更糟。所以把"它确实抓得到"这一条钉在这里，用纯数据跑，不点火。
        real_row = {
            "fixture": "fake",
            "layout": {
                "biou": 0.71,
                "utb": 1,
                "fontSize": {"below06Ratio": 0.32, "p10": 0.556},
                "overflow": {"right": 5, "silentRight": 5},
                "mask": {"intrusionIntoParagraph": 0},
            },
            "pixel": {"outsideDiffRatio": 0.0},
            "residue": {"residueRatio": 0.0},
        }
        watched = collect_watched(real_row)
        check(
            "真机行上取得到字号与交并比（门禁不是在对空字典比）",
            watched.get("layout.fontSize.below06Ratio") == 0.32
            and watched.get("layout.biou") == 0.71
            and watched.get("layout.overflow.right") == 5,
            f"got {sorted(watched)}",
        )
        check(
            "真机行没有 parse.*，那些路径取不到（所以真机门禁覆盖的指标更少）",
            not any(path.startswith("parse.") for path in watched),
            f"got {sorted(watched)}",
        )
        # 正控：一模一样的两份不许报回归。少了这一条，"抓得到回归"可能只是它见什么都报。
        same_regressions, same_floors = compare(real_row, json.loads(json.dumps(real_row)))
        check("同一份数据比自己不报回归", not same_regressions and not same_floors)
        # 正控：字号退化必须报回归。这是真机审核补这条门禁的全部理由。
        worse = json.loads(json.dumps(real_row))
        worse["layout"]["fontSize"]["below06Ratio"] = 0.45
        worse_regressions, _ = compare(real_row, worse)
        check(
            "字号低于 0.6 的比例上升会报回归",
            any(item["path"] == "layout.fontSize.below06Ratio" for item in worse_regressions),
            f"got {worse_regressions}",
        )
        # 绝对底线：越过 0.5 一律报，哪怕基线本身就已经很高。基线对照会把这个值冻结成
        # "正常"，底线不会。
        over_floor = json.loads(json.dumps(real_row))
        over_floor["layout"]["fontSize"]["below06Ratio"] = 0.62
        _, floor_breaks = compare(real_row, over_floor)
        check(
            "字号低于 0.6 的比例越过 0.5 报绝对底线",
            any(
                item["path"] == "layout.fontSize.below06Ratio" and item["limit"] == 0.5
                for item in floor_breaks
            ),
            f"got {floor_breaks}",
        )
        # 交并比归零必须报——无头门禁那侧早有这条，真机这侧要同样成立。
        dead = json.loads(json.dumps(real_row))
        dead["layout"]["biou"] = 0.0
        _, dead_floors = compare(real_row, dead)
        check(
            "交并比归零报绝对底线",
            any(item["path"] == "layout.biou" for item in dead_floors),
            f"got {dead_floors}",
        )
        # 遮罩侵入段落上升必须报回归（方向是 lower）。
        intruded = json.loads(json.dumps(real_row))
        intruded["layout"]["mask"]["intrusionIntoParagraph"] = 3
        intrude_regressions, _ = compare(real_row, intruded)
        check(
            "遮罩侵入段落数上升报回归",
            any(item["path"] == "layout.mask.intrusionIntoParagraph" for item in intrude_regressions),
            f"got {intrude_regressions}",
        )
        # silentRight 在真机侧没有含义（恒等于 overflow.right），必须被排除，否则同一个
        # 数会以两个名字报两遍，而其中一个名字会让人误以为"产品开始静默溢出了"。
        silent = json.loads(json.dumps(real_row))
        silent["layout"]["overflow"]["silentRight"] = 9
        silent_regressions, _ = compare(real_row, silent, skip=REAL_MACHINE_SKIP_PATHS)
        check(
            "silentRight 被排除在真机回归比较之外",
            not any(item["path"] == "layout.overflow.silentRight" for item in silent_regressions),
            f"got {silent_regressions}",
        )
        check(
            "但不排除时它照旧报回归（无头门禁那边仍要用它）",
            any(
                item["path"] == "layout.overflow.silentRight"
                for item in compare(real_row, silent)[0]
            ),
        )

        # ── 复用路径按页数挑附件 ──
        # 库里同时躺着好几篇夹具的产出，"取最新一条"会取错：three-column 实测就这么
        # 误取了 attention-reading 的两页附件，报了一个看起来像产品问题的"页数不一致"。
        pages = {"a.pdf": 2, "b.pdf": 1, "c.pdf": 2}
        candidates = [
            {"id": 3, "filePath": "a.pdf"},
            {"id": 9, "filePath": "b.pdf"},
            {"id": 12, "filePath": "c.pdf"},
        ]
        picked, matched = pick_attachment_by_page_count(candidates, 1, lambda p: pages[p])
        check(
            "页数唯一的那篇被挑中，即使它不是最新的",
            matched and picked["filePath"] == "b.pdf",
            f"got {picked}",
        )
        picked_two, matched_two = pick_attachment_by_page_count(candidates, 2, lambda p: pages[p])
        check(
            "页数重复时取较新的那条",
            matched_two and picked_two["filePath"] == "c.pdf",
            f"got {picked_two}",
        )
        picked_none, matched_none = pick_attachment_by_page_count(
            candidates, 5, lambda p: pages[p]
        )
        check(
            "一篇都对不上时明确报没对上，而不是假装挑对了",
            not matched_none and picked_none["filePath"] == "c.pdf",
            f"got {picked_none}, matched={matched_none}",
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    print(f"\n真机挑附件自检：{'全部通过' if failures == 0 else f'{failures} 条失败'}")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="z-transplit 版面保留翻译的评测编排")
    parser.add_argument("--regen-keys", action="store_true", help="从夹具 HTML 重新生成答案键")
    parser.add_argument("names", nargs="*", help="夹具名，缺省跑全部有 HTML 源的数字版夹具")
    parser.add_argument("--ratio", type=float, default=DEFAULT_RATIO, help="合成译文长度比")
    parser.add_argument("--write-baseline", action="store_true", help="把结果写成基线")
    parser.add_argument("--gate", action="store_true", help="与基线比并判回归")
    parser.add_argument("--real-machine", action="store_true", help="真机抽查")
    parser.add_argument(
        "--reuse-translated",
        action="store_true",
        help="真机抽查不重点火流水线，直接度量库里已有的译文附件（省掉每次约十分钟的阅读器初始化）",
    )
    parser.add_argument("--ocr", action="store_true", help="扫描件层指标")
    parser.add_argument("--selftest", action="store_true", help="跑真机挑附件与真机门禁的自检后退出")
    parser.add_argument(
        "--write-real-machine-baseline",
        action="store_true",
        help="跑真机并把结果写成真机基线（与无头基线分开的一份参照）",
    )
    parser.add_argument(
        "--real-machine-gate",
        action="store_true",
        help="跑真机并与真机基线比，判回归。要几分钟且需要一个跑着的 QA 实例，不进日常门禁",
    )
    parser.add_argument("--keep-workdir", default="", help="保留中间产物到指定目录（排障用）")
    args = parser.parse_args()

    if args.regen_keys:
        return regen_keys()

    if args.selftest:
        return harness_selftest()

    if args.write_real_machine_baseline or args.real_machine_gate:
        # 真机门禁自己跑真机，所以这一步与 --real-machine 是分开的两条路，不能叠用。
        if args.names:
            return real_machine_gate(args.names, write_baseline=args.write_real_machine_baseline)
        parser.error(
            "--real-machine-gate / --write-real-machine-baseline 需要指定夹具名，"
            "例如 --real-machine-gate reading-brain landscape-slides"
        )

    if args.ocr:
        print(json.dumps(ocr_stage(), ensure_ascii=False, indent=1))
        return 0

    if args.real_machine:
        # 真机抽查是单独一条路，不与无头批跑混在一起：它要点火一整条真机流水线，
        # 而且它的产出要和同名的无头结果并排比才有意义。
        if not args.names:
            parser.error("--real-machine 需要指定夹具名，例如 --real-machine formula-dense")
        report_rows = []
        for name in args.names:
            print(f"真机抽查 {name}……")
            try:
                real = real_machine_check(name, reuse_translated=args.reuse_translated)
            except Exception as exc:  # noqa: BLE001
                print(f"  {name} 失败：{type(exc).__name__}: {exc}")
                if os.environ.get("BENCH_TRACEBACK"):
                    import traceback

                    traceback.print_exc()
                return 1
            headless = None
            results_file = OUT_DIR / "results.json"
            if results_file.exists():
                try:
                    previous = json.loads(results_file.read_text(encoding="utf-8"))
                    headless = next(
                        (r for r in previous.get("results", []) if r.get("fixture") == name),
                        None,
                    )
                except json.JSONDecodeError:
                    headless = None
            report_rows.append((real, headless))
            print(
                f"  真机交并比 {real['layout'].get('biou', 0):.3f}  "
                f"未翻译 {real['layout'].get('utb', 0)}  "
                f"遮罩侵入 {real['layout'].get('mask', {}).get('intrusionIntoParagraph', 0)}  "
                f"框外像素差异 {real['pixel'].get('outsideDiffRatio', 0):.5f}"
            )
            if headless:
                print(
                    f"  无头交并比 {headless['layout'].get('biou', 0):.3f}  "
                    f"未翻译 {headless['layout'].get('utb', 0)}  "
                    f"遮罩侵入 {headless['layout'].get('mask', {}).get('intrusionIntoParagraph', 0)}  "
                    f"框外像素差异 {headless['pixel'].get('outsideDiffRatio', 0):.5f}"
                )
            else:
                print("  无头结果不存在（先跑一次不带 --real-machine 的同名夹具）")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        rows = load_real_machine_rows(OUT_DIR / "real-machine.json")
        by_fixture = {row.get("fixture"): row for row in rows}
        stamp = {"commit": git_commit(), "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S")}
        for real, headless in report_rows:
            by_fixture[real["fixture"]] = {
                "fixture": real["fixture"],
                "translatedPdf": real["translatedPdf"],
                "layout": real["layout"],
                "pixel": real["pixel"],
                "residue": real["residue"],
                "headless": headless,
                # 这一行是哪个提交、什么时候量的。真机基线靠它判断新旧，没有它，
                # 一项回归分不清是"改坏了"还是"基线采得早"。
                "provenance": stamp,
            }
        # 按夹具在清单里的顺序排，同一批跑多少篇、分多少次跑，读出来的顺序都一样。
        order = [f["name"] for f in FIXTURES]
        merged = sorted(
            by_fixture.values(), key=lambda row: order.index(row["fixture"]) if row["fixture"] in order else len(order)
        )
        (OUT_DIR / "real-machine.json").write_text(
            json.dumps({"rows": merged}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"\n真机抽查结果：{OUT_DIR / 'real-machine.json'}（累计 {len(merged)} 篇）")
        return 0

    if args.names:
        names = args.names
    else:
        names = [f["name"] for f in FIXTURES if (FIXTURE_DIR / f"{f["name"]}.html").exists()]

    keep = Path(args.keep_workdir) if args.keep_workdir else None
    results: list[dict] = []
    for name in names:
        print(f"跑 {name}……")
        try:
            result = run_fixture(name, args.ratio, keep_workdir=keep)
        except Exception as exc:  # noqa: BLE001
            # 带异常类型名：一个裸 KeyError 的 'text' 说不出是哪个字典缺键。
            print(f"  {name} 失败：{type(exc).__name__}: {exc}")
            if os.environ.get("BENCH_TRACEBACK"):
                import traceback

                traceback.print_exc()
            results.append({"fixture": name, "error": str(exc)})
            continue
        layout = result.get("layout", {})
        pixel = result.get("pixel", {})
        print(
            f"  交并比 {layout.get('biou', 0):.3f}  未翻译 {layout.get('utb', 0)}  "
            f"遮罩侵入 {layout.get('mask', {}).get('intrusionIntoParagraph', 0)}  "
            f"框外像素差异 {pixel.get('outsideDiffRatio', 0):.5f}  "
            f"用时 {result['elapsedMs']} 毫秒"
        )
        results.append(result)

    ok_results = [r for r in results if "error" not in r]

    regressions: list[dict] = []
    floors: list[dict] = []
    if args.write_baseline:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "results": ok_results}
        BASELINE_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )
        print(f"\n基线写到 {BASELINE_PATH}")
        print("人工核对一遍数字再提交。这个文件是门禁的唯一参照。")
    elif args.gate:
        if not BASELINE_PATH.exists():
            print(f"没有基线 {BASELINE_PATH}。先跑 --write-baseline。")
            return 2
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        baseline_by_name = {r["fixture"]: r for r in baseline.get("results", [])}
        # 一篇都没跑成时不许报"通过"。没有可比对象不等于没有回归——实测过一次：
        # 度量库改坏之后五篇全抛 NameError，ok_results 为空，回归列表自然是空的，
        # 门禁于是打印"通过"。那是整套基准最难发现的一种坏法：绿得刺眼，而它其实
        # 什么都没量。宁可错杀，不可放过。
        if not ok_results:
            print(f"\n门禁失败：{len(results)} 篇夹具全部失败，没有可比的数字。")
            for result in results:
                print(f"  {result['fixture']}: {result.get('error', '未知错误')}")
            return 1
        missing = [r["fixture"] for r in results if "error" in r]
        if missing:
            # 部分失败照常比，但要把缺的几篇点出来——少比几篇也是少量了几篇。
            print(f"\n注意：{len(missing)} 篇夹具失败，未参与比较：{', '.join(missing)}")
        for result in ok_results:
            base = baseline_by_name.get(result["fixture"])
            if not base:
                continue
            item_regressions, item_floors = compare(base, result)
            for item in item_regressions:
                regressions.append({"fixture": result["fixture"], **item})
            for item in item_floors:
                floors.append({"fixture": result["fixture"], **item})
        if regressions or floors:
            print(f"\n门禁失败：{len(regressions)} 项回归，{len(floors)} 项越过绝对底线")
            for item in regressions:
                print(
                    f"  {item['fixture']} {item['path']}: "
                    f"{fmt(item['baseline'])} → {fmt(item['current'])}"
                )
            for item in floors:
                print(
                    f"  {item['fixture']} {item['path']}: "
                    f"{fmt(item['value'])} 越过 {item['op']} {fmt(item['limit'])}"
                )
        else:
            print("\n门禁通过")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "results.json").write_text(
        json.dumps({"results": results}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT_DIR / "report.md").write_text(
        render_report(results, regressions, floors), encoding="utf-8"
    )
    print(f"\n报告：{OUT_DIR / 'report.md'}")

    failed = [r for r in results if "error" in r]
    if failed:
        return 1
    if args.gate and (regressions or floors):
        return 1
    return 0


def real_machine_gate(names: list[str], write_baseline: bool) -> int:
    """真机门禁：点火真机跑指定夹具，与真机基线逐指标比。

    与无头门禁有两点本质区别，都是被坑出来的：

    1. **它自己跑真机，不读 `out/real-machine.json` 里躺着的旧行。** 真机一次要几分
       钟且要一个跑着的 Zotero，那些旧行很可能比 HEAD 旧好几个提交。拿旧行比基线，
       报出来的回归分不清是"这次改坏了"还是"基线本来就旧"。所以宁可每次重跑——
       这也是它不进 `npm run test:benchmark` 的原因：那条命令要能随手跑。
    2. **它覆盖的指标比无头少，而且必须说出来。** 真机行里只有 `layout` / `pixel` /
       `residue` 三块，`parse.*` 一项都没有（解析质量由无头路径量）。`compare` 对缺失
       的路径是静默跳过的，不点出来就会让人以为门禁全覆盖了。

    跑法：
        python scripts/qa/benchmark/run.py --write-real-machine-baseline reading-brain …
        python scripts/qa/benchmark/run.py --real-machine-gate reading-brain …
    """
    if write_baseline:
        print("写真机基线：先跑一遍指定夹具的真机流水线……")
    else:
        if not REAL_MACHINE_BASELINE_PATH.exists():
            print(f"没有真机基线 {REAL_MACHINE_BASELINE_PATH}。先跑 --write-real-machine-baseline。")
            return 2
        baseline = json.loads(REAL_MACHINE_BASELINE_PATH.read_text(encoding="utf-8"))
        baseline_by_name = {r["fixture"]: r for r in baseline.get("results", [])}
        print(
            f"真机基线采自提交 {baseline.get('commit', 'unknown')}"
            f"（{baseline.get('generatedAt', '时间未知')}），共 {len(baseline_by_name)} 篇"
        )

    rows: list[dict] = []
    for name in names:
        print(f"真机抽查 {name}……")
        try:
            real = real_machine_check(name)
        except Exception as exc:  # noqa: BLE001
            print(f"  {name} 失败：{type(exc).__name__}: {exc}")
            if os.environ.get("BENCH_TRACEBACK"):
                import traceback

                traceback.print_exc()
            return 1
        row = {
            "fixture": real["fixture"],
            "translatedPdf": real["translatedPdf"],
            "layout": real["layout"],
            "pixel": real["pixel"],
            "residue": real["residue"],
            "provenance": {"commit": git_commit(), "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S")},
        }
        layout = real["layout"]
        print(
            f"  交并比 {layout.get('biou', 0):.3f}  未翻译 {layout.get('utb', 0)}  "
            f"遮罩侵入 {layout.get('mask', {}).get('intrusionIntoParagraph', 0)}  "
            f"框外像素差异 {real['pixel'].get('outsideDiffRatio', 0):.5f}  "
            f"字号低于 0.6 {layout.get('fontSize', {}).get('below06Ratio', 0):.3f}"
        )
        rows.append(row)

    if write_baseline:
        REAL_MACHINE_BASELINE_PATH.write_text(
            json.dumps(
                {
                    "commit": git_commit(),
                    "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "results": rows,
                },
                ensure_ascii=False,
                indent=1,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"\n真机基线写到 {REAL_MACHINE_BASELINE_PATH}")
        print("人工核对一遍数字再提交。它与无头基线是两份参照，回答的不是同一个问题。")
        return 0

    regressions: list[dict] = []
    floors: list[dict] = []
    compared_paths: set[str] = set()
    for row in rows:
        base = baseline_by_name.get(row["fixture"])
        if not base:
            print(f"\n注意：真机基线里没有 {row['fixture']}，未参与比较")
            continue
        item_regressions, item_floors = compare(base, row, skip=REAL_MACHINE_SKIP_PATHS)
        # 记下这一次真正比到了哪些路径。缺的路径（parse.* 那一大批）是静默跳过的，
        # 不报出来就等于假装覆盖了。
        for path, _, _ in WATCHED:
            if path in REAL_MACHINE_SKIP_PATHS:
                continue
            if path in collect_watched(base) and path in collect_watched(row):
                compared_paths.add(path)
        for item in item_regressions:
            regressions.append({"fixture": row["fixture"], **item})
        for item in item_floors:
            floors.append({"fixture": row["fixture"], **item})

    print(
        f"\n本次实际比对 {len(compared_paths)} 项指标：{', '.join(sorted(compared_paths))}"
    )
    print("未比到的有两类：真机行里没有的（parse.* 解析质量那一批，由无头门禁覆盖），")
    print(f"以及在真机上没有含义、有意排除的（{', '.join(sorted(REAL_MACHINE_SKIP_PATHS))}）")

    if regressions or floors:
        print(f"\n真机门禁失败：{len(regressions)} 项回归，{len(floors)} 项越过绝对底线")
        for item in regressions:
            print(
                f"  {item['fixture']} {item['path']}: "
                f"{fmt(item['baseline'])} → {fmt(item['current'])}"
            )
        for item in floors:
            print(
                f"  {item['fixture']} {item['path']}: "
                f"{fmt(item['value'])} 越过 {item['op']} {fmt(item['limit'])}"
            )
        return 1
    print("\n真机门禁通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
