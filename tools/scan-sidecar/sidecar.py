#!/usr/bin/env python3
"""Scanned-page recognition sidecar for Z-Transplit.

Recognizes scanned PDF pages and writes a batch JSON that the plugin's
``src/core/pdf/scan/sidecarProtocol.ts`` consumes. Engine-agnostic by
design: the plugin only reads the JSON contract, so the recognizer can be
swapped without touching the plugin.

Pipeline (composable small models, all CPU-capable):

  pypdfium2            render the page to a bitmap at the requested dpi
  PP-DocLayoutV3       (inside PPStructureV3) layout regions + reading order
  PP-OCRv6             per-line text boxes (det + rec)
  PP-FormulaNet        formula regions -> LaTeX
  SLANet-plus          table regions -> HTML

Usage:
    python sidecar.py --pdf paper.pdf --pages 1-5,7 --out workdir --dpi 200

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
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple


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
    """Normalize a bbox to [x0, y0, x1, y1] from any known shape."""
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
    if isinstance(raw, (list, tuple)) and len(raw) >= 4:
        try:
            vals = [float(v) for v in raw[:4]]
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


# ── Engines ───────────────────────────────────────────────────────────────────

class Engines:
    """Lazily-built recognizer set. Import failures surface as one clear
    fatal diagnostic instead of a stack trace per page."""

    def __init__(self) -> None:
        self._structure = None
        self._ocr = None
        self._import_error: Optional[str] = None

    def structure(self):
        if self._structure is None and self._import_error is None:
            try:
                from paddleocr import PPStructureV3

                self._structure = PPStructureV3(
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
            except Exception as exc:  # pragma: no cover - environment dependent
                self._import_error = f"PPStructureV3 unavailable: {exc}"
                raise RuntimeError(self._import_error)
        return self._structure

    def ocr(self):
        if self._ocr is None and self._import_error is None:
            try:
                from paddleocr import PaddleOCR

                self._ocr = PaddleOCR(
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
            except Exception as exc:  # pragma: no cover - environment dependent
                self._import_error = f"PaddleOCR unavailable: {exc}"
                raise RuntimeError(self._import_error)
        return self._ocr


def _iter_results(result: Any):
    """PP-StructureV3/PaddleOCR `predict` may return a list or a generator."""
    if result is None:
        return []
    if isinstance(result, (list, tuple)):
        return list(result)
    return list(result)


def _result_payload(res: Any) -> Dict[str, Any]:
    """Pull the dict payload out of a result object across versions."""
    for attr in ("json", "res", "to_dict"):
        if hasattr(res, attr):
            value = getattr(res, attr)
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            if isinstance(value, dict):
                return value
    if isinstance(res, dict):
        return res
    return {}


# ── Per-page recognition ──────────────────────────────────────────────────────

TEXT_LABELS = {"text", "plain_text", "paragraph", "body"}
TITLE_LABELS = {"title", "heading", "section_header", "doc_title"}
FORMULA_LABELS = {"formula", "isolate_formula", "display_formula"}
TABLE_LABELS = {"table"}
FIGURE_LABELS = {"figure", "image", "chart", "figure_graph"}
CAPTION_LABELS = {"figure_caption", "table_caption", "caption", "formula_caption"}


def recognize_page(engines: Engines, image, warnings: List[str]) -> Dict[str, Any]:
    """Run the engine set over one rendered page; return the protocol dict."""
    structure = engines.structure()
    ocr = engines.ocr()

    height_px, width_px = image.height, image.width

    # 1) Page-level OCR: line boxes with text. These carry the line-level
    #    geometry the renderer needs (font size is estimated from line height).
    lines: List[Dict[str, Any]] = []
    try:
        for res in _iter_results(ocr.predict(image)):
            payload = _result_payload(res)
            rec_texts = _first(payload, "rec_texts", "texts", default=[])
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

    # 2) Layout + formula + table via the structure pipeline.
    regions: List[Dict[str, Any]] = []
    try:
        for res in _iter_results(structure.predict(image)):
            payload = _result_payload(res)
            items = _first(payload, "parsing_res_list", "res_list", default=[])
            for item in items:
                if not isinstance(item, dict):
                    continue
                bbox = _as_bbox(_first(item, "block_bbox", "bbox"))
                label = str(_first(item, "block_label", "label", default="")).lower()
                content = _first(item, "block_content", "content", default="")
                if bbox is None:
                    continue
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

    return {
        "lines": out_lines,
        "formulas": formulas,
        "tables": tables,
        "figures": figures,
        "coverage": round(coverage, 4),
        "renderSizePx": {"width": width_px, "height": height_px},
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Scanned-page recognition sidecar")
    parser.add_argument("--pdf", required=True, help="source PDF path")
    parser.add_argument("--pages", required=True, help='1-based page spec, e.g. "1-5,7"')
    parser.add_argument("--out", required=True, help="output directory for result.json")
    parser.add_argument("--dpi", type=int, default=200, help="render resolution (72-600)")
    args = parser.parse_args(argv)

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

    engines = Engines()
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
            payload = recognize_page(engines, image, warnings)
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
