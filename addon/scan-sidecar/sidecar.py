#!/usr/bin/env python3
"""Scanned-page recognition sidecar for Z-Transplit.

Recognizes scanned PDF pages and writes a batch JSON that the plugin's
``src/core/pdf/scan/sidecarProtocol.ts`` consumes. Engine-agnostic by
design: the plugin only reads the JSON contract, so the recognizer can be
swapped without touching the plugin.

Pipeline (composable small models, all CPU-capable):

  pypdfium2            render the page to a bitmap at the requested dpi
  PP-StructureV3       layout regions + reading order + formulas + tables
                       (one pipeline; the exact model versions are whatever
                       the installed PaddleOCR ships as defaults)
  PaddleOCR            per-line text boxes (det + rec)

Compute path (oneDNN compatibility): PaddleX accelerates CPU inference with
mkldnn by default. On some processors the oneDNN fusion pass emits
instructions whose PIR attributes cannot be converted
(``NotImplementedError`` in ``onednn_instruction.cc``); the engines still
build fine, but every ``predict`` raises. ``--selftest`` probes one small
image through both engines, reports the mode that works so the install can
record it in ``env.json``, and the sidecar reads it at startup. If a page
still hits the signature at runtime, the sidecar records the compatibility
mode and restarts itself without mkldnn, so later batches start in it
directly instead of rediscovering the defect on every batch.

Usage:
    python sidecar.py --pdf paper.pdf --pages 1-5,7 --out workdir --dpi 200

Model weights live in a ``models/`` directory next to this script (PaddleX's
cache root is redirected there via ``PADDLE_PDX_CACHE_HOME``), so the whole
recognition stack — script, env marker, weights — sits inside the plugin's
own data directory and is removed together when the environment is
discarded. See the "Model cache location" note below the imports.

Output (``<out>/result.json``)::

    {
      "pages": [ SidecarPageResult, ... ],
      "diagnostics": { "engine": ..., "engineVersion": ..., "warnings": [...] }
    }

Exit codes: 0 = every requested page recognized, 2 = partial (some pages
failed; the JSON still carries the pages that worked), 1 = fatal (bad
arguments, unreadable PDF, engine import failure). Diagnostics go to
stderr as one JSON line.

Install:
    pip install -r requirements.txt   # see README.md in this directory
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import traceback
from typing import Any, Dict, List, Optional


# ── Model cache location ─────────────────────────────────────────────────────
# 模型权重（几百兆到几个 G）默认落在用户主目录的 ~/.paddlex：那里不受插件
# 管辖——卸载后留在机器上，换数据目录重装要重新下，多用户机器上还会和别的
# PaddleX 用户抢同一份缓存。插件把侧车脚本 materialize 到数据目录下的
# ztransplit/scan-sidecar/，模型缓存就放它同级的 models/：跟着数据目录走，
# 卸载识别环境时整个目录一起清掉。
#
# PaddleX 的缓存根在 import 时从 PADDLE_PDX_CACHE_HOME 读一次
# （paddlex/utils/cache.py：CACHE_DIR = os.environ.get("PADDLE_PDX_CACHE_HOME",
#  osp.join(expanduser("~"), ".paddlex"))），所以必须在任何 paddlex import
# 之前设好——本文件的 paddlex 导入全在函数里惰性发生，放在模块顶层就够。
def _model_cache_dir() -> str:
    """模型缓存目录：侧车脚本同级的 models/。"""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


MODEL_CACHE_DIR = _model_cache_dir()
os.environ["PADDLE_PDX_CACHE_HOME"] = MODEL_CACHE_DIR


# ── Diagnostics ───────────────────────────────────────────────────────────────

def _diag(level: str, message: str, **extra: Any) -> None:
    """One JSON object per line on stderr; the plugin surfaces the tail."""
    payload = {"level": level, "message": message}
    payload.update(extra)
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


# ── Page selection ────────────────────────────────────────────────────────────

def parse_pages(spec: str) -> List[int]:
    """``"1-5,7"`` -> ``[1, 2, 3, 4, 5, 7]`` (1-based, ascending, deduped)."""
    pages: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            start, end = int(lo), int(hi)
            if end < start:
                start, end = end, start
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    return sorted(set(p for p in pages if p >= 1))


# ── Defensive field extraction ───────────────────────────────────────────────
# The PaddleOCR result schema shifts between minor versions. Rather than pin
# one exact shape, every reader tries the known field names in order and
# reports what it could not find. A version drift degrades to "fewer fields",
# never to a crash mid-batch.

def _first(mapping: Dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(mapping, dict) and name in mapping and mapping[name] is not None:
            return mapping[name]
    return default


def _as_bbox(raw: Any) -> Optional[List[float]]:
    """Normalize a bbox to [x0, y0, x1, y1] from any known shape.

    认得的形状：字典（x0/y0/x1/y1 风格的键）、扁平四点 [x0,y0,x1,y1]、
    四边形点列 [[x,y] x4]。点列要连 numpy 数组一起认——PaddleX 3.x 的
    rec_boxes / dt_polys 就是 ndarray，既不是 list 也不是 tuple；真机实测
    2026-11-23：不认 ndarray 时 28 个文字行全部因取不到框被丢弃，输出只剩
    版面块的内容（行级几何全丢，字体大小估算随之失真）。
    """
    if raw is None:
        return None
    if isinstance(raw, dict):
        keys_x0 = ("x0", "left", "x_min", "xmin")
        keys_y0 = ("y0", "top", "y_min", "ymin")
        keys_x1 = ("x1", "right", "x_max", "xmax")
        keys_y1 = ("y1", "bottom", "y_max", "ymax")
        try:
            x0 = float(_first(raw, *keys_x0, default=0))
            y0 = float(_first(raw, *keys_y0, default=0))
            x1 = float(_first(raw, *keys_x1, default=x0))
            y1 = float(_first(raw, *keys_y1, default=y0))
        except (TypeError, ValueError):
            return None
        return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
    try:
        flat = list(raw)
    except TypeError:
        return None
    if not flat:
        return None
    first = flat[0]
    if hasattr(first, "__len__") and not isinstance(first, (str, bytes)):
        # 四边形点列 [[x, y], ...]（含 numpy 的行）：取轴向包围盒
        try:
            pts = [(float(p[0]), float(p[1])) for p in flat]
        except (TypeError, ValueError, IndexError):
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]
    if len(flat) >= 4:
        try:
            vals = [float(v) for v in flat[:4]]
        except (TypeError, ValueError):
            return None
        xs = vals[0::2]
        ys = vals[1::2]
        return [min(xs), min(ys), max(xs), max(ys)]
    return None


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _center_inside(box: List[float], region: List[float]) -> bool:
    cx = (box[0] + box[2]) / 2.0
    cy = (box[1] + box[3]) / 2.0
    return region[0] <= cx <= region[2] and region[1] <= cy <= region[3]


def _union_area(boxes: List[List[float]], page_w: float, page_h: float) -> float:
    """Exact union area of axis-aligned boxes (coordinate-compressed sweep).

    The sweep grid is built from the boxes' own x/y edges, so every cell is
    entirely inside or outside each rectangle — the result is exact, unlike a
    fixed-resolution grid that undercounts small boxes. Boxes are clipped to
    the page first; dozens of rectangles per page keep this cheap.
    """
    clipped = []
    for b in boxes:
        x0 = max(0.0, min(b[0], page_w))
        y0 = max(0.0, min(b[1], page_h))
        x1 = max(0.0, min(b[2], page_w))
        y1 = max(0.0, min(b[3], page_h))
        if x1 > x0 and y1 > y0:
            clipped.append([x0, y0, x1, y1])
    if not clipped:
        return 0.0
    xs = sorted({v for b in clipped for v in (b[0], b[2])})
    ys = sorted({v for b in clipped for v in (b[1], b[3])})
    area = 0.0
    for i in range(len(xs) - 1):
        cx = (xs[i] + xs[i + 1]) / 2.0
        for j in range(len(ys) - 1):
            cy = (ys[j] + ys[j + 1]) / 2.0
            if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in clipped):
                area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j])
    return area


# ── Compute path (oneDNN compatibility) ─────────────────────────────────────

# 推理模式：默认走 PaddleX 的 mkldnn 加速；兼容模式关掉它。为什么需要兼容
# 模式：oneDNN 的融合指令在部分处理器上把 PIR 属性转成运行时属性时报未实现
# （见 _ONEDNN_SIGNATURE），引擎照常建成、页面却全空——真机实测 2026-11-23
# （Windows + paddlepaddle 3.3.1 + oneDNN 3.6.2 + i7-10510U）文字检测与版面
# 分析两条推理路径都撞它，且关新 IR 无效（新执行器仍会把程序转成 PIR），
# 只有关 mkldnn 能通（同机复测：一页 28 行文字正常认出）。
INFERENCE_DEFAULT = "default"
INFERENCE_NO_MKLDNN = "no-mkldnn"

# 兼容模式下结构阶段的长边上限（像素）。为什么需要它：关掉 mkldnn 之后，
# 结构管线跑全尺寸页面会在文字检测模型的 predictor.run() 里段错误——硬崩，
# 接不住也兜不了（真机实测 2026-11-23：200 DPI 的 A4 页 1653x2339 必崩，
# 半分辨率 826x1169、0.75 档 1239x1754 均正常，四例全尺寸全崩）。识别管线
# （PaddleOCR，产出文字行的那条）不受尺寸影响，全尺寸正常，所以只缩放结构
# 阶段的输入，版面块坐标按比例映回，与文字行框同空间。
COMPAT_STRUCTURE_MAX_SIDE = 1600

# ── Model tiers ──────────────────────────────────────────────────────────────
# 模型档位。缺省（accurate）用 PaddleX 各子模型的最高档，共 12 个模型
# （2026-11-24 从 models/ 实测的解包后磁盘占用）：
#   结构管线（10 个，1726 MB）：版面 PP-DocLayout_plus-L 125、结构内文字检测
#     PP-OCRv5_server_det 85、结构内文字识别 PP-OCRv5_server_rec 82、表格分类
#     PP-LCNet_x1_0_table_cls 7、表格结构 SLANeXt_wired 349 + SLANet_plus 8、
#     单元格检测 RT-DETR-L_wired / wireless 各 124、公式 PP-FormulaNet_plus-L
#     702、区域检测 PP-DocBlockLayout 124。
#   行级文字（2 个，133 MB）：PaddleOCR 3.7 自带的 PP-OCRv6_medium_det 60 +
#     PP-OCRv6_medium_rec 74。
# 合计约 1.86 GB，两页一批要跑十几分钟。
#
# light 档把每个模型都压到 100 MB 以内（体积同为 models/ 实测）：
#   版面   PP-DocLayout-M       22.7 MB（缺省 plus-L 125 MB）
#   检测   PP-OCRv6_small_det    9.6 MB（缺省 PP-OCRv5_server_det 85 MB）
#   识别   PP-OCRv6_small_rec   20.5 MB（缺省 PP-OCRv5_server_rec 82 MB）
# 只下载这三个，磁盘合计 52.7 MB。同机同图实测：文字行数与文字内容和缺省档
# 完全一致（28 行同文），结构+OCR 从 353 秒降到 51 秒（快约 7 倍）。
#
# 代价，也是为什么 accurate 仍是缺省：公式、表格、区域检测在 100 MB 以内没有
# 可用模型，light 档只能把这三个子管线整个关掉——
#   - 公式：PP-FormulaNet_plus-S（247 MB）数得出公式但 LaTeX 是坏的（6 条公式
#     A/B：\int 认成 int、\log 变成 \mathrm{l o g}、下标丢失）；LaTeX_OCR_rec
#     （98 MB，唯一压线的）在真实公式图上直接抛广播维度不匹配，跑不完一页。
#   - 表格：结构识别 SLANet_plus 只有 8 MB，但同一子管线的 SLANeXt_wired 349 MB、
#     单元格检测 RT-DETR-L 两个各 124 MB 没有更小档；use_table_recognition 是
#     整条子管线的开关，没有更细的粒度。
#   - 区域检测：PP-DocBlockLayout 124 MB 一档，且侧车并不消费它的输出
#     （region_det_res），关掉不改变识别结果。
# 版面块粒度也会变粗（同图 10 块对 15 块）：阅读顺序与字号估算粗一档，文字
# 内容不变。
MODELS_ACCURATE = "accurate"
MODELS_LIGHT = "light"
MODEL_TIERS = (MODELS_ACCURATE, MODELS_LIGHT)

# light 档的模型名。PP-OCRv6 的 small 档与 medium 同族而更新一代，同尺寸下
# 精度不低于 v5 的 mobile 档，且识别模型覆盖中文与拉丁语系（mobile 的识别
# 模型按语言分型号，中文没有 mobile 版）。
#
# 两套参数必须分开：use_formula_recognition / use_table_recognition /
# use_region_detection 只有 PPStructureV3 认，行级 PaddleOCR 见到未知参数
# 直接以 "Unknown argument" 失败（真机实测 2026-11-24：合成一套参数同时喂
# 两条管线，自检第一步就挂）。模型名两边都认，但 PaddleOCR 只吃文字检测与
# 识别两个，版面模型名给它也是未知参数。
_LIGHT_MODEL_NAMES: Dict[str, Any] = {
    "text_detection_model_name": "PP-OCRv6_small_det",
    "text_recognition_model_name": "PP-OCRv6_small_rec",
}
_LIGHT_STRUCTURE_MODELS: Dict[str, Any] = {
    "layout_detection_model_name": "PP-DocLayout-M",
    **_LIGHT_MODEL_NAMES,
    # 三个子管线整条关掉：100 MB 以内没有可用模型（见上面的说明）。关掉之后
    # 公式走行级文字（内容在、LaTeX 不在），表格只登记区域，版面块照常产出。
    "use_formula_recognition": False,
    "use_table_recognition": False,
    "use_region_detection": False,
}


def _structure_model_kwargs(tier: str) -> Dict[str, Any]:
    """模型档位 → PPStructureV3 的构造参数（叠加在推理模式参数之上）。"""
    if tier == MODELS_LIGHT:
        return dict(_LIGHT_STRUCTURE_MODELS)
    return {}


def _ocr_model_kwargs(tier: str) -> Dict[str, Any]:
    """模型档位 → PaddleOCR（行级文字）的构造参数。"""
    if tier == MODELS_LIGHT:
        return dict(_LIGHT_MODEL_NAMES)
    return {}


# oneDNN 融合指令的 PIR 属性转换缺陷签名。只认这一条：别的错误照旧上报，
# 不用兼容模式掩盖——掩盖会让真正的病因消失在"兼容模式已启用"里。
_ONEDNN_SIGNATURE = "ConvertPirAttribute2RuntimeAttribute"


class _OneDnnIncompatible(Exception):
    """默认计算路径撞上 oneDNN 缺陷：通知调用方换兼容模式重建引擎。"""


def _engine_kwargs(inference_mode: str) -> Dict[str, Any]:
    """推理模式 → 引擎构造参数。

    "no-mkldnn" 关掉 mkldnn 加速（PaddleOCR 与 PPStructureV3 共有的公共
    参数，两条管线都吃）。纯计算路径开关：识别结果不变，只是不走 oneDNN
    的加速融合。
    """
    if inference_mode == INFERENCE_NO_MKLDNN:
        return {"enable_mkldnn": False}
    return {}


def read_inference_mode() -> str:
    """从同目录的 env.json 读安装时探测到的推理模式。

    一键安装把 ``--selftest`` 探到的模式写进 env.json，本进程直接按它建
    引擎，不必每批都先失败一次再切换。读不到（手动运行、旧版安装、标记
    损坏）按默认模式——届时由页面循环里的运行时兜底负责切换。
    """
    try:
        marker = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "env.json"
        )
        with open(marker, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        mode = data.get("inference")
        if mode in (INFERENCE_DEFAULT, INFERENCE_NO_MKLDNN):
            return mode
    except Exception:
        # 标记缺失或损坏都不是致命错误：默认模式 + 运行时兜底兜着
        pass
    return INFERENCE_DEFAULT


def structure_input(image: Any, inference_mode: str):
    """结构阶段的输入图与坐标回乘系数。

    兼容模式下把长边收到 COMPAT_STRUCTURE_MAX_SIDE 以内（原因见该常量的
    注释：全尺寸会段错误）。返回 (图, 系数)——版面块的坐标乘系数映回全
    尺寸空间，与识别管线产出的行框同空间，后面的"行归块"与覆盖率计算都
    不用改。默认模式原图返回，系数 1.0。
    """
    if inference_mode != INFERENCE_NO_MKLDNN:
        return image, 1.0
    long_side = max(image.width, image.height)
    if long_side <= COMPAT_STRUCTURE_MAX_SIDE:
        return image, 1.0
    scale = COMPAT_STRUCTURE_MAX_SIDE / float(long_side)
    small = image.resize(
        (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
    )
    return small, 1.0 / scale


# ── Engines ───────────────────────────────────────────────────────────────────

class Engines:
    """Lazily-built recognizer set. Import failures surface as one clear
    fatal diagnostic instead of a stack trace per page.

    Once construction has failed, every later call raises the same error. An
    earlier version returned the still-None engine after the first failure,
    which turned page 1 into a real failure and every later page into a
    confusing "'NoneType' object has no attribute 'predict'" warning — the
    real cause was visible only on the first page.

    ``inference_mode`` selects the compute path (see ``_engine_kwargs``);
    it is exposed as an attribute so the runtime fallback can tell whether
    a rebuild would actually change anything.

    ``model_tier`` selects the model sizes (see ``MODEL_TIERS``); it is
    exposed for the same reason — the tier is reported per page so a run's
    output can always be traced back to the models that produced it.
    """

    def __init__(
        self,
        inference_mode: str = INFERENCE_DEFAULT,
        model_tier: str = MODELS_ACCURATE,
    ) -> None:
        self._structure = None
        self._ocr = None
        self._import_error: Optional[str] = None
        self.inference_mode = inference_mode
        self.model_tier = model_tier
        self._kwargs = _engine_kwargs(inference_mode)
        self._structure_models = _structure_model_kwargs(model_tier)
        self._ocr_models = _ocr_model_kwargs(model_tier)

    def structure(self):
        if self._structure is not None:
            return self._structure
        if self._import_error is not None:
            raise RuntimeError(self._import_error)
        try:
            from paddleocr import PPStructureV3

            self._structure = PPStructureV3(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                **self._structure_models,
                **self._kwargs,
            )
        except Exception as exc:  # pragma: no cover - environment dependent
            self._import_error = _describe_engine_failure(
                "PPStructureV3", exc
            )
            raise RuntimeError(self._import_error)
        return self._structure

    def ocr(self):
        if self._ocr is not None:
            return self._ocr
        if self._import_error is not None:
            raise RuntimeError(self._import_error)
        try:
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                **self._ocr_models,
                **self._kwargs,
            )
        except Exception as exc:  # pragma: no cover - environment dependent
            self._import_error = _describe_engine_failure("PaddleOCR", exc)
            raise RuntimeError(self._import_error)
        return self._ocr

    def close(self) -> None:
        """显式释放两条管线的原生资源。

        切换计算路径之前先释放：自检里换模式重建、运行时重启前，旧管线的
        预测器占几百兆到几个 G，不还回去就让新的叠加着建，峰值内存直接
        翻倍。PaddleX 的 close 会逐级关闭子管线。
        """
        for attr in ("_structure", "_ocr"):
            engine = getattr(self, attr, None)
            if engine is None:
                continue
            try:
                engine.close()
            except Exception:
                # 释放失败不该卡住切换：旧对象随后被 GC，尽力而为
                pass
            setattr(self, attr, None)
        self._import_error = None


def probe_inference(engines: "Engines") -> None:
    """跑一张合成小图穿过两条推理路径，确认计算路径真的能推理。

    只建引擎证明不了任何事：oneDNN 缺陷在 predict 时才炸，建引擎一路正常
    （实测：构造两条管线都成功，第一次 predict 就抛
    NotImplementedError）。合成图带几行文字，检测阶段就会走到；撞上签名错误时
    抛 _OneDnnIncompatible，调用方换兼容模式重建再探。
    """
    import numpy as np
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (640, 320), "white")
    draw = ImageDraw.Draw(image)
    y = 32
    for line in ("The quick brown fox", "jumps over the lazy dog", "0123456789"):
        draw.text((24, y), line, fill="black")
        y += 48
    arr = np.ascontiguousarray(np.asarray(image))
    # 两条管线都探：文字检测与版面分析在缺陷机器上分别炸在不同模型上
    for name, engine in (("ocr", engines.ocr()), ("structure", engines.structure())):
        try:
            engine.predict(arr)
        except Exception as exc:
            if _ONEDNN_SIGNATURE in str(exc):
                raise _OneDnnIncompatible(f"{name} path: {exc}") from exc
            raise


def _hit_onednn(warnings: List[str], since: int) -> bool:
    """since 之后新增的警告里有没有 oneDNN 缺陷签名。"""
    return any(_ONEDNN_SIGNATURE in w for w in warnings[since:])


def persist_inference_mode(mode: str) -> None:
    """把运行时发现的推理模式写回同目录的 env.json（只改 inference 字段）。

    只在标记已存在时更新：凭空造一份缺字段的标记，会让插件的状态查询把
    环境误判成"依赖缺失"。手动运行（没有标记）时跳过——那一轮的成本是
    下次重新发现一次，正确性不受影响。
    """
    marker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "env.json")
    try:
        with open(marker, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return
    if not isinstance(data, dict) or data.get("inference") == mode:
        return
    data["inference"] = mode
    try:
        with open(marker, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    except Exception as exc:
        _diag("onednn-incompatible", f"could not persist inference mode: {exc}")


def _restart_in_compat(engines: "Engines") -> int:
    """以兼容模式重启本进程跑完本批，返回子进程的出口码。

    为什么是重启而不是在进程内重建引擎：进程内重建确实能活（真机实测
    2026-11-23：ocr 与 structure 两条都跑过失败的 predict 之后再建引擎，
    单独失败、双双失败四种组合都正常）——但一个侧车进程就是一个批次，
    标记缺失或过期时每批都要重新发现一次：首页先失败一轮，几百兆模型
    白加载一遍才重建。重启把模式写回 env.json，后续批次直接按兼容模式
    启动，发现成本只付一次；顺带拿到一个干净的进程映像跑兼容模式。

    用子进程而不是 execv：Windows 上 execv 换掉进程映像的语义，与插件
    "按启动时的 PID 等待、按同一根管道收输出"的约定不好论证；子进程方式
    父进程原样等着，输出继承同一根管道，出口码原样转出。
    """
    persist_inference_mode(INFERENCE_NO_MKLDNN)
    # 旧引擎先释放：子进程起来之前把几百兆到几个 G 还回去
    engines.close()
    script = os.path.abspath(sys.argv[0])
    args: List[str] = []
    skip_next = False
    for arg in sys.argv[1:]:
        if skip_next:
            skip_next = False
            continue
        if arg == "--inference":
            skip_next = True
            continue
        args.append(arg)
    args += ["--inference", INFERENCE_NO_MKLDNN]
    _diag(
        "onednn-incompatible",
        "oneDNN path unusable; restarting in compatibility mode (no mkldnn)",
    )
    sys.stdout.flush()
    sys.stderr.flush()
    # 不设 timeout：批次超时由插件的侧车超时统一管（默认 10 分钟）
    proc = subprocess.run([sys.executable, script, *args])
    return proc.returncode


def _describe_engine_failure(engine: str, exc: Exception) -> str:
    """把引擎构造失败翻译成"缺哪个包"。

    PaddleX 把缺依赖包在一句通用文案里（"A dependency error occurred during
    pipeline creation. Please refer to the installation documentation..."），
    真正的原因在 __cause__ 里：缺附加依赖时报 DependencyError 并给出该装的
    extra，缺推理引擎时报 "dependency 'paddlepaddle' is not installed"。

    真机实测（2026-11-19，Windows + Python 3.13）：只装 paddleocr 时连撞两种
    失败，而侧车原来只回显那句通用文案，指不到缺哪个包，只能靠手工 import 才
    查出根因。这里把因果链摊开，让 --selftest 的诊断直接可用。
    """
    chain = []
    node = exc
    depth = 0
    while node is not None and depth < 6:
        text = str(node).strip()
        if text:
            chain.append(text)
        node = getattr(node, "__cause__", None)
        depth += 1
    detail = " | ".join(chain) if chain else exc.__class__.__name__
    return f"{engine} unavailable: {detail}"


def _iter_results(result: Any) -> List[Any]:
    """PP-StructureV3/PaddleOCR `predict` may return a list or a generator."""
    if result is None:
        return []
    return list(result)


def _result_payload(res: Any) -> Dict[str, Any]:
    """Pull the dict payload out of a result object across versions.

    PaddleX 3.x 的结果对象本身就是字典（OCRResult、结构结果都是），字段就在
    它自己上面——``result["rec_texts"]`` 直接读得到。它的 ``.json`` 属性反而
    多包一层（``{"res": {...}}``）。所以优先用对象自身；只有对象不是映射时
    才按属性找，并且把单层 ``{"res": ...}`` 包装拆开。

    真机实测 2026-11-23：只按 ``.json`` 取会拿到外层包装，``rec_texts`` 与
    ``parsing_res_list`` 全都读不到——predict 明明是成功的，页面却"识别"出
    0 行，比抛异常更难发现。这条提取路径在 mkldnn 缺陷修好之前从未跑通过
    （predict 先抛异常），所以这个 schema 错位一直藏着。
    """
    if isinstance(res, dict):
        return res
    if hasattr(res, "keys") and hasattr(res, "__getitem__"):
        try:
            return dict(res)
        except Exception:
            pass
    for attr in ("json", "res", "to_dict"):
        if not hasattr(res, attr):
            continue
        value = getattr(res, attr)
        if callable(value):
            try:
                value = value()
            except Exception:
                continue
        if isinstance(value, dict):
            # 单层 {"res": {...}} 包装：PaddleX 的 .json 属性就是这个形状
            if list(value.keys()) == ["res"] and isinstance(value["res"], dict):
                return value["res"]
            return value
    return {}


def _field(obj: Any, *names: str, default: Any = None) -> Any:
    """按顺序从结果对象或字典里取一个字段，两种形状都认。

    PaddleX 3.x 的版面块是 LayoutBlock 对象（``label`` / ``bbox`` /
    ``content`` 是属性），2.x 与部分管线给的是字典（``block_label`` /
    ``block_bbox`` / ``block_content`` 是键）。只认字典会让 3.x 的版面块
    全部读不出来——真机实测 2026-11-23：15 个块一个都取不到，而 predict
    是成功的。
    """
    for name in names:
        if isinstance(obj, dict):
            if name in obj and obj[name] is not None:
                return obj[name]
        else:
            try:
                value = getattr(obj, name)
            except Exception:
                value = None
            if value is not None:
                return value
    return default


# ── Per-page recognition ──────────────────────────────────────────────────────

TEXT_LABELS = {"text", "plain_text", "paragraph", "body"}
TITLE_LABELS = {"title", "heading", "section_header", "doc_title"}
FORMULA_LABELS = {"formula", "isolate_formula", "display_formula"}
TABLE_LABELS = {"table"}
FIGURE_LABELS = {"figure", "image", "chart", "figure_graph"}
CAPTION_LABELS = {"figure_caption", "table_caption", "caption", "formula_caption"}


def _as_engine_input(image):
    """PIL 图像 → numpy 数组，交给识别引擎。

    PaddleX 3.x 的 predict 只接受 numpy.ndarray 或文件路径。传 PIL 图像不会
    抛异常，而是打一条 "Not supported input data type! ... So has been
    ignored" 然后把这一页整个跳过——真机实测 2026-11-19（paddleocr 3.7.0 /
    paddlex 3.7.2）：每页 lines/formulas/tables/figures 全空、coverage 0，
    侧车却报告 "recognized 2 page(s)"，因为一条异常都没抛。转成数组这条
    静默失败才会消失。

    顺带处理 alpha 通道：引擎要三通道 RGB，四通道位图直接喂会因通道数不符
    被拒。

    还要保证数组可写：PIL 的缓冲区可能是只读的，而 ascontiguousarray 对
    已连续的数组原样返回（只读的照旧只读）。结构管线的某些分支要就地写
    输入图（给检测到的区域涂白），只读数组会让它在 predict 里报
    "assignment destination is read-only"——真机实测 2026-11-23，只有带
    这类区域的页面会走到那条分支，所以它藏得很深。
    """
    import numpy as np

    arr = np.asarray(image)
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[:, :, :3]
    arr = np.ascontiguousarray(arr)
    if not arr.flags.writeable:
        arr = arr.copy()
    return arr


def recognize_page(
    engines: Engines, image, warnings: List[str], page_number: int
) -> Dict[str, Any]:
    """Run the engine set over one rendered page; return the protocol dict."""
    # Inside the caller's per-page try: an engine that cannot be built (import
    # failure, architecture mismatch) is a clear per-page reason, and the
    # "degrade to text-only" promise still holds for a layout-only failure.
    structure = engines.structure()
    ocr = engines.ocr()
    engine_input = _as_engine_input(image)

    height_px, width_px = image.height, image.width

    # 1) Page-level OCR: line boxes with text. These carry the line-level
    #    geometry the renderer needs (font size is estimated from line height).
    lines: List[Dict[str, Any]] = []
    try:
        for res in _iter_results(ocr.predict(engine_input)):
            payload = _result_payload(res)
            rec_texts = _first(payload, "rec_texts", "texts", default=None)
            if rec_texts is None:
                # 字段名漂移：读不到文本列表时记一条 warning，别静默交出空页
                # （README 承诺"读不到的字段进 diagnostics.warnings"）。
                warnings.append("page OCR result carries no text field (rec_texts)")
                continue
            rec_boxes = _first(payload, "rec_boxes", "dt_polys", "boxes", default=[])
            rec_scores = _first(payload, "rec_scores", "scores", default=[])
            for idx, text in enumerate(rec_texts):
                box = _as_bbox(rec_boxes[idx]) if idx < len(rec_boxes) else None
                if box is None or not str(text).strip():
                    continue
                entry: Dict[str, Any] = {
                    "bbox": box,
                    "text": str(text),
                    "blockId": 0,
                }
                if idx < len(rec_scores):
                    try:
                        entry["score"] = float(rec_scores[idx])
                    except (TypeError, ValueError):
                        pass
                lines.append(entry)
    except Exception as exc:
        warnings.append(f"page OCR failed ({exc}); falling back to layout blocks")

    # 2) Layout + formula + table via the structure pipeline. In compatibility
    #    mode the pipeline gets a downscaled copy (full-size pages segfault it)
    #    and its block boxes are mapped back to full-resolution space, so the
    #    line-to-block assignment and the coverage math below stay unchanged.
    regions: List[Dict[str, Any]] = []
    structure_image, structure_factor = structure_input(image, engines.inference_mode)
    try:
        for res in _iter_results(
            structure.predict(_as_engine_input(structure_image))
        ):
            payload = _result_payload(res)
            items = _first(payload, "parsing_res_list", "res_list", default=None)
            if items is None:
                warnings.append("layout result carries no block list (parsing_res_list)")
                continue
            for item in items:
                # 块可能是字典（2.x 形状）或 LayoutBlock 对象（3.x 形状），
                # _field 两种都认；形状不明的项 bbox 取不到，自然被跳过。
                bbox = _as_bbox(_field(item, "block_bbox", "bbox"))
                label = str(_field(item, "block_label", "label", default="")).lower()
                content = _field(item, "block_content", "content", default="")
                if bbox is None:
                    continue
                if structure_factor != 1.0:
                    bbox = [v * structure_factor for v in bbox]
                regions.append({"bbox": bbox, "label": label, "content": content or ""})
    except Exception as exc:
        warnings.append(f"layout recognition failed ({exc}); text-only output")

    # 3) Assign each OCR line to its containing text/title/caption block.
    #    Reading order = the order the layout model emitted the blocks.
    text_regions = [r for r in regions if r["label"] in TEXT_LABELS | TITLE_LABELS | CAPTION_LABELS]
    assigned: Dict[int, List[Dict[str, Any]]] = {i: [] for i in range(len(text_regions))}
    orphans: List[Dict[str, Any]] = []
    for line in lines:
        target = None
        for idx, region in enumerate(text_regions):
            if _center_inside(line["bbox"], region["bbox"]):
                target = idx
                break
        if target is None:
            orphans.append(line)
            continue
        line["blockId"] = target
        line["blockType"] = text_regions[target]["label"]
        assigned[target].append(line)

    # Orphan lines (outside every text block — margins, strays) become their
    # own block after the layout blocks; they are content, never dropped.
    next_block = len(text_regions)
    for line in orphans:
        line["blockId"] = next_block
        next_block += 1

    out_lines: List[Dict[str, Any]] = []
    for idx, region in enumerate(text_regions):
        block_lines = sorted(
            assigned[idx],
            key=lambda l: (round(l["bbox"][1], 1), l["bbox"][0]),
        )
        if block_lines:
            out_lines.extend(block_lines)
        elif region["content"].strip():
            # Layout block with content but no matching OCR lines: emit the
            # block as a single line so its text survives.
            out_lines.append(
                {
                    "bbox": region["bbox"],
                    "text": region["content"],
                    "blockId": idx,
                    "blockType": region["label"],
                }
            )
    out_lines.extend(orphans)

    # 4) Formula / table / figure regions.
    formulas: List[Dict[str, Any]] = []
    tables: List[Dict[str, Any]] = []
    figures: List[Dict[str, Any]] = []
    for region in regions:
        label = region["label"]
        if label in FORMULA_LABELS:
            latex = str(region["content"]).strip()
            if latex:
                formulas.append(
                    {
                        "bbox": region["bbox"],
                        "latex": latex,
                        "isDisplay": True,
                    }
                )
        elif label in TABLE_LABELS:
            entry = {"bbox": region["bbox"]}
            if str(region["content"]).strip():
                entry["html"] = str(region["content"])
            tables.append(entry)
        elif label in FIGURE_LABELS:
            figures.append({"bbox": region["bbox"]})

    # 5) Coverage: union of every detected region over the page area.
    region_boxes = [r["bbox"] for r in regions] + [l["bbox"] for l in lines]
    page_area = float(width_px) * float(height_px)
    coverage = 0.0 if page_area <= 0 else min(1.0, _union_area(region_boxes, width_px, height_px) / page_area)

    # 空页必须说出来。PaddleX 对不支持的输入是"打一条 warning 然后跳过"，
    # 不抛异常——真机实测 2026-11-19 因此出现过每页全空、coverage 0，而侧车
    # 仍报告 "recognized N page(s)"，插件侧只能看到一堆可疑页重试。这里把
    # "这一页什么都没认到"显式写进 diagnostics.warnings（README 承诺读不到的
    # 东西都进 warnings），调用方不必靠覆盖率反推。
    if not out_lines and not regions:
        warnings.append(
            f"page {page_number} recognized nothing: no text lines and no layout "
            "blocks (check the engine input type and the rendered image)"
        )

    return {
        "lines": out_lines,
        "formulas": formulas,
        "tables": tables,
        "figures": figures,
        "coverage": round(coverage, 4),
        "renderSizePx": {"width": width_px, "height": height_px},
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def selftest(model_tier: str = MODELS_ACCURATE) -> int:
    """Build the recognition engines once and report readiness as one JSON
    line on stdout.

    The plugin runs this right after installing dependencies: constructing
    the pipeline is what downloads the model weights, so a successful
    selftest means the first real recognition won't stall mid-document —
    and a broken environment surfaces here, at setup time, with a clear
    reason instead of a per-page failure during translation.

    The check covers every third-party wheel the recognition path imports:
    both engines *and* pypdfium2, which is a separate package that fails on
    its own (missing VC++ runtime on Windows, wrong wheel architecture).
    Checking only the engines would let a pypdfium2 breakage through to the
    first real translation.

    建好引擎还不够，必须真跑一次推理（probe_inference）：oneDNN 缺陷只在
    predict 时暴露。默认计算路径撞上它就换兼容模式重建再探，探通哪个模式
    就在输出里报告哪个——插件据此写进 env.json，运行时直接按它建引擎。
    """
    last_error = ""
    engines: Optional["Engines"] = None
    for inference in (INFERENCE_DEFAULT, INFERENCE_NO_MKLDNN):
        # 上一轮（撞缺陷的默认模式）的引擎先释放：两套模型同时在内存里会
        # 把进程压爆（见 Engines.close）。
        if engines is not None:
            engines.close()
        engines = Engines(inference_mode=inference, model_tier=model_tier)
        try:
            engines.structure()
            engines.ocr()
            _render_probe()
            probe_inference(engines)
        except _OneDnnIncompatible as exc:
            # 默认计算路径不可用：换下一个候选（关 mkldnn）再探。别的错误
            # 不进这个分支——不拿兼容模式掩盖真实病因。
            _diag("onednn-incompatible", f"{exc}; retrying without mkldnn")
            last_error = str(exc)
            continue
        except Exception as exc:
            _diag("fatal", f"selftest failed: {exc}")
            return 1
        engine_version = ""
        try:
            import paddleocr

            engine_version = getattr(paddleocr, "__version__", "")
        except Exception:
            pass
        _diag(
            "selftest-ok",
            f"engines ready (paddleocr {engine_version or 'version unknown'}, "
            f"inference {inference}, models {model_tier} tier at {MODEL_CACHE_DIR})",
        )
        print(
            json.dumps(
                {
                    "selftest": "ok",
                    "engineVersion": engine_version,
                    "inference": inference,
                    "modelDir": MODEL_CACHE_DIR,
                    "modelTier": model_tier,
                },
                ensure_ascii=False,
            )
        )
        return 0
    _diag("fatal", f"selftest failed in every compute mode (last: {last_error})")
    return 1


def _render_probe() -> None:
    """Render one tiny blank page: proves pypdfium2 imports, creates a
    document, rasterizes and hands back a PIL image (the exact calls the
    recognition path makes)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(8, 8)
    image = page.render(scale=1.0, rotation=0).to_pil()
    if image.width <= 0 or image.height <= 0:
        raise RuntimeError("render probe produced an empty bitmap")
    page.close()
    pdf.close()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Scanned-page recognition sidecar")
    parser.add_argument("--pdf", help="source PDF path")
    parser.add_argument("--pages", help='1-based page spec, e.g. "1-5,7"')
    parser.add_argument("--out", help="output directory for result.json")
    parser.add_argument("--dpi", type=int, default=200, help="render resolution (72-600)")
    parser.add_argument(
        "--inference",
        choices=[INFERENCE_DEFAULT, INFERENCE_NO_MKLDNN],
        default=None,
        help="compute path override; default is the mode recorded in env.json",
    )
    parser.add_argument(
        "--models",
        choices=list(MODEL_TIERS),
        default=None,
        help="model size tier; default is accurate (see MODEL_TIERS)",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="build the engines and exit (pre-downloads model weights)",
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest(args.models or MODELS_ACCURATE)

    missing = [name for name, value in (
        ("--pdf", args.pdf), ("--pages", args.pages), ("--out", args.out),
    ) if not value]
    if missing:
        # 退出码 1（致命），与文档一致：argparse 的 parser.error 给的是 2，
        # 而 2 在契约里表示"部分成功"，插件会把参数错读成部分失败。
        _diag("fatal", "missing required arguments: " + ", ".join(missing))
        return 1

    warnings: List[str] = []
    dpi = max(72, min(600, int(args.dpi)))

    try:
        import pypdfium2 as pdfium
    except Exception as exc:
        _diag("fatal", f"pypdfium2 unavailable: {exc}")
        return 1

    if not os.path.isfile(args.pdf):
        _diag("fatal", f"PDF not found: {args.pdf}")
        return 1

    try:
        pdf = pdfium.PdfDocument(args.pdf)
    except Exception as exc:
        _diag("fatal", f"cannot open PDF: {exc}")
        return 1

    try:
        pages = parse_pages(args.pages)
    except ValueError as exc:
        _diag("fatal", f"bad --pages spec: {exc}")
        return 1

    if not pages:
        # 空规格（"--pages 0"、"--pages ''"）：一个页面都没请求。0 在契约里
        # 表示"全部成功"，不能拿它收场——按致命处理。
        _diag("fatal", f"no valid pages in --pages spec: {args.pages!r}")
        return 1

    # 按安装时探测到的推理模式建引擎；--inference 可覆盖（兼容模式重启出来
    # 的子进程用它）。标记里没有时按默认模式，届时由页面循环里的运行时
    # 兜底负责切换。
    engines = Engines(
        inference_mode=args.inference or read_inference_mode(),
        model_tier=args.models or MODELS_ACCURATE,
    )
    engine_version = ""
    try:
        import paddleocr

        engine_version = getattr(paddleocr, "__version__", "")
    except Exception:
        warnings.append("paddleocr not importable yet; failure surfaces on first page")

    results: List[Dict[str, Any]] = []
    failed = 0
    for page_number in pages:
        index = page_number - 1
        if index < 0 or index >= len(pdf):
            failed += 1
            warnings.append(f"page {page_number} out of range")
            # 越界页也进 stderr：整批越界时只有 warnings 的话，stderr 上
            # 看不到页码与文档总页数，排障要靠翻 result.json。
            _diag(
                "page-out-of-range",
                f"page {page_number} out of range (document has {len(pdf)} page(s))",
                page=page_number,
            )
            continue
        try:
            page = pdf[index]
            rotation = page.get_rotation()
            size_pt = page.get_size()
            if rotation != 0:
                # The plugin's overlay renderer refuses rotated pages; keep
                # the source page instead of recognizing a rotated bitmap.
                results.append(
                    {
                        "pageNumber": page_number,
                        "pageSizePt": {"width": size_pt[0], "height": size_pt[1]},
                        "renderSizePx": {"width": 0, "height": 0},
                        "dpi": dpi,
                        "rotation": rotation,
                        "skipReason": "rotated",
                        "lines": [],
                        "formulas": [],
                        "tables": [],
                        "figures": [],
                        "coverage": 0.0,
                    }
                )
                continue
            bitmap = page.render(scale=dpi / 72.0, rotation=0)
            image = bitmap.to_pil()
            before = len(warnings)
            payload = recognize_page(engines, image, warnings, page_number)
            if (
                engines.inference_mode != INFERENCE_NO_MKLDNN
                and _hit_onednn(warnings, before)
            ):
                # 运行时兜底：标记说默认路径可用，这一页却撞上 oneDNN 缺陷
                # （标记缺失、旧版安装、或装完之后环境变了）。以兼容模式重启
                # 本进程重跑整批，重启前把模式写回 env.json——后续批次直接
                # 走兼容模式，不必每批都重新发现一次（见 _restart_in_compat）。
                # 父进程这里收手，出口码由子进程转出。
                return _restart_in_compat(engines)
            payload.update(
                {
                    "pageNumber": page_number,
                    "pageSizePt": {"width": size_pt[0], "height": size_pt[1]},
                    "dpi": dpi,
                    "rotation": rotation,
                }
            )
            results.append(payload)
        except Exception as exc:
            failed += 1
            warnings.append(f"page {page_number} failed: {exc}")
            _diag("page-failed", f"page {page_number}: {exc}", page=page_number)

    os.makedirs(args.out, exist_ok=True)
    output = {
        "pages": results,
        "diagnostics": {
            "engine": "pp-structurev3+pp-ocrv6",
            "engineVersion": engine_version,
            # 档位跟着结果走：事后翻 result.json 时能认出这批字是哪套模型产出
            # 的（档位是进程级参数，逐页写一遍只会把文件撑大，放 diagnostics 即
            # 可——同一个进程里不会换档）。
            "modelTier": engines.model_tier,
            "warnings": warnings,
        },
    }
    out_path = os.path.join(args.out, "result.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False)

    if failed == 0:
        _diag("done", f"recognized {len(results)} page(s)")
        return 0
    if results:
        _diag("partial", f"{failed} page(s) failed, {len(results)} kept")
        return 2
    _diag("fatal", "every page failed")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # pragma: no cover - last-resort diagnostics
        traceback.print_exc()
        _diag("fatal", "unhandled exception")
        sys.exit(1)
