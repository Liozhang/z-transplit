/**
 * sourceFixture — 解析 Node 测试要用的源 PDF 与中文字体。
 *
 * Why this exists: two overlay tests used to point at
 * `tests/zotero/fixtures/a.pdf` and `NotoSansSC.ttf`, paths that do not exist in
 * this repository. Both guarded themselves with `if (!fs.existsSync(...)) return`,
 * so they silently passed on every run while asserting nothing. That is worse
 * than a failing test — it reports green coverage that was never exercised.
 *
 * The fix is to point at fixtures that ARE in the repo (`scripts/qa/fixtures/`,
 * the same set the benchmark uses) and to make the font genuinely optional: a
 * missing font only degrades CJK glyphs to `?`, and these tests assert on
 * geometry and stats, not on glyph shapes. If the PDF itself is missing the
 * tests now FAIL rather than skip, because a missing source fixture is a broken
 * repository, not an environment detail.
 *
 * @module tests/node/helpers/sourceFixture
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** tests/node/helpers → repo root. */
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/**
 * Single-page A4 PDF with ordinary prose. Chosen over reading-brain.pdf (two
 * pages) because the overlay tests assert `getPageCount() === 1`.
 */
export const SOURCE_PDF = path.join(
  REPO_ROOT,
  "scripts",
  "qa",
  "fixtures",
  "formula-dense.pdf",
);

/** Candidate CJK fonts, best first. None of them is required. */
const CJK_FONT_CANDIDATES = [
  "tests/node/fixtures/NotoSansSC.ttf",
  "assets/fonts/NotoSansSC.ttf",
  // Windows
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/simhei.ttf",
  // macOS
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/Songti.ttc",
  // Linux
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
];

export function sourcePdfBytes(): Uint8Array {
  if (!fs.existsSync(SOURCE_PDF)) {
    throw new Error(
      `源 PDF 夹具缺失：${SOURCE_PDF}。它是 benchmark 的必需输入，缺失说明仓库不完整。`,
    );
  }
  return fs.readFileSync(SOURCE_PDF);
}

/**
 * CJK font bytes, or undefined when no candidate exists. Tests that need real
 * CJK glyphs must assert conditionally; tests that assert geometry can ignore
 * the return value entirely.
 */
export function cjkFontBytes(): Uint8Array | undefined {
  for (const rel of CJK_FONT_CANDIDATES) {
    const abs = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) {
      try {
        return fs.readFileSync(abs);
      } catch {
        /* try the next candidate */
      }
    }
  }
  return undefined;
}
