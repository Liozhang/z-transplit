/**
 * platform-font.spec — Unit tests for per-language font resolution helpers.
 *
 * Covers the pure functions in core/pdf/platform.ts that map a translation
 * target-language code to a font script (zh/ja/ko/latin) and decide whether a
 * CJK font is needed. These are the contract the translation pipeline relies on
 * to pick the right system font; a regression here means the wrong script's
 * font gets embedded (e.g. Korean text rendered with a Chinese font → all '?').
 *
 * The OS-dependent functions (isWindows, systemFontPathsForLang, readFontBytes*)
 * are NOT tested here — they need a real Zotero/IOUtils runtime.
 *
 * Ported from leadero's tests/node/platform-font.spec.ts (import paths
 * unchanged). Run: npm run test:unit -- platform-font
 */

import { describe, it, expect } from "vitest";
import { fontLangForTarget, isCjkTarget } from "../../src/core/pdf/platform";

describe("fontLangForTarget", () => {
  it("maps Chinese codes to 'zh'", () => {
    expect(fontLangForTarget("zh-CN")).toBe("zh");
    expect(fontLangForTarget("zh-TW")).toBe("zh");
    expect(fontLangForTarget("zh-Hans")).toBe("zh");
    expect(fontLangForTarget("zh")).toBe("zh");
  });

  it("maps Japanese codes to 'ja'", () => {
    expect(fontLangForTarget("ja")).toBe("ja");
    expect(fontLangForTarget("ja-JP")).toBe("ja");
    expect(fontLangForTarget("JA-jp")).toBe("ja"); // case-insensitive
  });

  it("maps Korean codes to 'ko'", () => {
    expect(fontLangForTarget("ko")).toBe("ko");
    expect(fontLangForTarget("ko-KR")).toBe("ko");
  });

  it("maps Latin/other codes to 'latin'", () => {
    expect(fontLangForTarget("en")).toBe("latin");
    expect(fontLangForTarget("en-US")).toBe("latin");
    expect(fontLangForTarget("fr-FR")).toBe("latin");
    expect(fontLangForTarget("de-DE")).toBe("latin");
    expect(fontLangForTarget("es-ES")).toBe("latin");
    expect(fontLangForTarget("ru-RU")).toBe("latin"); // Cyrillic not a CJK script here
  });

  it("handles empty / null / undefined gracefully (defaults to latin)", () => {
    expect(fontLangForTarget("")).toBe("latin");
    expect(fontLangForTarget(undefined)).toBe("latin");
    expect(fontLangForTarget(null)).toBe("latin");
  });
});

describe("isCjkTarget", () => {
  it("is true for zh/ja/ko", () => {
    expect(isCjkTarget("zh-CN")).toBe(true);
    expect(isCjkTarget("ja-JP")).toBe(true);
    expect(isCjkTarget("ko-KR")).toBe(true);
  });

  it("is false for Latin and other scripts", () => {
    expect(isCjkTarget("en-US")).toBe(false);
    expect(isCjkTarget("fr-FR")).toBe(false);
    expect(isCjkTarget("ru-RU")).toBe(false);
  });

  it("is false for empty / null / undefined", () => {
    expect(isCjkTarget("")).toBe(false);
    expect(isCjkTarget(undefined)).toBe(false);
    expect(isCjkTarget(null)).toBe(false);
  });
});
