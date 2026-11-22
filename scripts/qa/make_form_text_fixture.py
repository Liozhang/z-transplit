"""生成一份页面文字全部写在表单（Form XObject）里的 PDF。

为什么需要它：原文删除器按设计只处理页面内容流（第 0 层），表单与内联图像内部的
文字一律保留，那种文档上它报 opsRemoved=0、产出的 PDF 文本层与原文逐字节相同。
产品据此回落遮罩（opendataloaderSplitAdapter 的 isRemovalEffective 分支），而那条
编排在真机上一直没有覆盖——没有一份"删除器必然无效"的夹具就点不到它。

这份夹具就是为点那条分支造的：页面内容流只有一个 `/Fm0 Do`，全部文字在表单里。
删除器对页面层无从下手，opsRemoved 必然是 0。

用法：
    python -I scripts/qa/make_form_text_fixture.py scripts/qa/fixtures/form-text.pdf
"""

import sys


def build() -> bytes:
    # 五六个对象，手写即可。关键是内容流里只有一次 Do，文字全在 5 号表单对象里。
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>"
        ),
        5: None,  # 表单对象，流内容在下面填
        6: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    page_stream = b"q 1 0 0 1 0 0 cm /Fm0 Do Q\n"
    form_stream = (
        b"BT /F1 22 Tf 72 700 Td (Structured reading practice) Tj ET\n"
        b"BT /F1 22 Tf 72 660 Td (improves comprehension scores.) Tj ET\n"
        b"BT /F1 22 Tf 72 620 Td (All of this text lives inside a form.) Tj ET\n"
    )
    objects[4] = b"<< /Length %d >>\nstream\n" % len(page_stream) + page_stream + b"endstream"
    objects[5] = (
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] "
        b"/Resources << /Font << /F1 6 0 R >> >> /Length %d >>\nstream\n" % len(form_stream)
        + form_stream
        + b"endstream"
    )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"

    xref_at = len(out)
    highest = max(objects) + 1
    out += b"xref\n0 %d\n" % highest
    out += b"0000000000 65535 f \n"
    for number in range(1, highest):
        out += b"%010d 00000 n \n" % offsets[number]
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (highest, xref_at)
    )
    return bytes(out)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = sys.argv[1]
    data = build()
    with open(path, "wb") as handle:
        handle.write(data)
    print(f"写出 {path}（{len(data)} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
