"""Generate a minimal valid EPUB 3 fixture for real-machine reader-kind tests.

The fixture exercises the same code path a real ebook attachment takes:
Zotero's EPUB reader (epub.js) parses the container, renders the spine, and
the reader instance reports type "epub". Content is bilingual prose so a
human reviewer sees readable text in screenshots.

Run:  python -I make_epub_fixture.py <output.epub>
"""
import sys
import zipfile

MIMETYPE = "application/epub+zip"

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:ztransplit-qa-epub-0001</dc:identifier>
    <dc:title>QA Reader-Kind Sample</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>z-transplit QA</dc:creator>
    <meta property="dcterms:modified">2026-11-09T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc"><h1>Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Reading in Translation</a></li>
      <li><a href="chapter2.xhtml">Layout and Structure</a></li>
    </ol>
  </nav>
</body>
</html>
"""

CHAPTER1 = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Reading in Translation</title></head>
<body>
  <h1>Reading in Translation</h1>
  <p>Reading foreign-language literature inside a reference manager works best
  when the translation preserves the structure of the original document. A
  paragraph that keeps its position on the page lets the reader compare the
  source and the translation without losing the thread of the argument.</p>
  <p>This chapter introduces the sample used by the real-machine test bench.
  It is deliberately short: two chapters of plain prose are enough to open the
  reader, render the spine, and report a stable reader type.</p>
</body>
</html>
"""

CHAPTER2 = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Layout and Structure</title></head>
<body>
  <h1>Layout and Structure</h1>
  <p>An EPUB stores its content as XHTML files listed in a spine. The reader
  reflows the text to the available width, so there are no fixed pages and no
  page coordinates to map. Any feature that depends on page geometry therefore
  cannot apply to this format.</p>
  <p>The second chapter exists so the table of contents and the spine have
  something to point at, and so a screenshot shows a rendered document rather
  than an error page.</p>
</body>
</html>
"""


def build(out_path: str) -> None:
    # The mimetype entry must be the FIRST entry and STORED uncompressed,
    # with no extra fields — that is what makes the archive an EPUB.
    with zipfile.ZipFile(out_path, "w") as zf:
        zi = zipfile.ZipInfo("mimetype")
        zi.compress_type = zipfile.ZIP_STORED
        zf.writestr(zi, MIMETYPE)
        zf.writestr("META-INF/container.xml", CONTAINER, zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/content.opf", OPF, zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/nav.xhtml", NAV, zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/chapter1.xhtml", CHAPTER1, zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/chapter2.xhtml", CHAPTER2, zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "qa-reader-kind.epub"
    build(target)
    print("wrote", target)
