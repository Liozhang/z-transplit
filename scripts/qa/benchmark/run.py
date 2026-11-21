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
JAR_CANDIDATES = [
    ROOT / "src" / "core" / "pdf" / "lib" / "opendataloader-pdf-cli.jar",
    Path(r"D:\zt-qa\data\ztransplit\lib\opendataloader-pdf-cli.jar"),
]

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
    }

    # 渲染端自己的诊断也传进去，度量才能算出 silentRight——它看见而产品没报的
    # 右溢出。见 metrics.layout_metrics 的 docstring。
    layout = metrics.layout_metrics(str(fixture_pdf), str(out_pdf), assembly, stats)
    layout["mask"]["punch"] = metrics.mask_punch(str(fixture_pdf), str(out_pdf), assembly)
    pixel = metrics.outside_pixel_diff(str(fixture_pdf), str(out_pdf), assembly)
    residue = metrics.source_residue(str(fixture_pdf), str(out_pdf), key.get("sourceScript", "latin"))

    return {
        "fixture": name,
        "layout": next((f["layout"] for f in FIXTURES if f["name"] == name), ""),
        "elapsedMs": int((time.time() - started) * 1000),
        "parse": parse_metrics,
        "layout": layout,
        "pixel": pixel,
        "residue": residue,
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
FLOORS: list[tuple[str, str, float]] = [
    ("pixel.outsideDiffRatio", "<=", 0.002),
    ("layout.biou", ">", 0.0),
]


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


def compare(baseline: dict, current: dict) -> tuple[list[dict], list[dict]]:
    """逐指标比基线与当前。返回 (回归项, 越过绝对底线的项)。"""
    baseline_watched = collect_watched(baseline)
    current_watched = collect_watched(current)
    regressions: list[dict] = []
    floor_breaks: list[dict] = []
    for path, kind, direction in WATCHED:
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
        row = [
            result["fixture"],
            fmt(parse.get("formula", {}).get("precision")),
            fmt(parse.get("formula", {}).get("recall")),
            fmt(parse.get("match", {}).get("f1")),
            fmt(parse.get("column", {}).get("crossColumnRatio")),
            fmt(parse.get("column", {}).get("mergedBlockRatio")),
            str(parse.get("figureText", {}).get("paragraphs", "")),
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
        found = find_translated_attachment(launcher)
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


    # 轮询译文附件，直到出现或超时。全新 profile 的第一次流水线要做一堆一次性
    # 的事（解析器 jar、字体解析、阅读器开关、译文附件落盘），实测比"跑第二遍"
    # 慢一个量级，300 秒不够——第一版就是 300 秒，轮询空手而归，而译文在放弃之后
    # 几十秒才落地，失败信息指向"没有产出"，其实是等得不够久。
    deadline = time.time() + REAL_MACHINE_TIMEOUT_S
    translated_path = None
    waited = 0
    while time.time() < deadline:
        result = run(["node", str(launcher), "send", "translated"])
        items = translated_items(result.stdout)
        if items:
            translated_path = items[-1].get("filePath")
            break
        waited += 1
        if waited % 6 == 1:
            print(f"  等译文附件……已等 {waited * 5} 秒", flush=True)
        time.sleep(5)
    if not translated_path or not Path(translated_path).exists():
        raise RuntimeError(
            f"等了 {REAL_MACHINE_TIMEOUT_S} 秒仍没有译文附件。先手工确认流水线能跑通："
            "node scripts/qa/real-machine.mjs send translated"
        )
    return measure_real_machine(name, fixture_pdf, translated_path)


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


def find_translated_attachment(launcher: Path) -> tuple[str, str] | None:
    """查库里已有的译文附件，返回 (路径, 修改时间)。没有返回 None。"""
    result = run(["node", str(launcher), "send", "translated"])
    items = translated_items(result.stdout)
    if not items:
        return None
    file_path = items[-1].get("filePath")
    if not file_path or not Path(file_path).exists():
        return None
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(Path(file_path).stat().st_mtime))
    return file_path, stamp


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
    parser.add_argument("--keep-workdir", default="", help="保留中间产物到指定目录（排障用）")
    args = parser.parse_args()

    if args.regen_keys:
        return regen_keys()

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
        (OUT_DIR / "real-machine.json").write_text(
            json.dumps(
                {
                    "rows": [
                        {
                            "fixture": real["fixture"],
                            "translatedPdf": real["translatedPdf"],
                            "layout": real["layout"],
                            "pixel": real["pixel"],
                            "residue": real["residue"],
                            "headless": headless,
                        }
                        for real, headless in report_rows
                    ]
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n真机抽查结果：{OUT_DIR / 'real-machine.json'}")
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


if __name__ == "__main__":
    sys.exit(main())
