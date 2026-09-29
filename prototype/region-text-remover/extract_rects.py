"""从 OpenDataLoader 输出 JSON 提取文本块边界框，生成删除区域文件。

用法: python extract_rects.py <odl输出.json> <区域文件.rects>
只提取段落、标题、列表三类（即可翻译文本），图表与题注保留作对照。
"""
import json
import sys

def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    lines = ["# page x0 y0 x1 y1"]
    count = 0
    for block in data.get("kids", []):
        if block.get("type") not in ("paragraph", "heading", "list"):
            continue
        box = block.get("bounding box")
        if not box or len(box) != 4:
            continue
        page = block["page number"]
        x0, y0, x1, y1 = box
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        lines.append(f"{page} {x0:.2f} {y0:.2f} {x1:.2f} {y1:.2f}")
        count += 1
    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"rects: {count}")

if __name__ == "__main__":
    main()
