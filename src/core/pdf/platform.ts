/**
 * platform — Cross-platform OS detection + per-language system font discovery,
 * safe for Zotero's chrome realm.
 *
 * WHY THIS EXISTS: the translation pipeline needs "find a CJK font on disk".
 * An earlier copy of this logic used `process.platform` to pick the OS. In
 * Zotero's chrome realm `process` is a polyfill whose `.platform` is NOT
 * reliably "win32"/"darwin" — so on Windows the system-font branch was silently
 * skipped, no CJK font was found, and the translated PDF rendered every Chinese
 * glyph as '?'. Centralising the logic here means that bug class can't recur:
 * there is one OS check (triple-fallback) and one font list, shared by every
 * caller.
 *
 * WHY HARDCODED PATHS (not nsIFontEnumerator): Gecko's font enumerator returns
 * only font FAMILY NAMES (e.g. "Microsoft YaHei"), never file paths. There's no
 * public XPCOM API to map a family name → file on disk, which is what pdf-lib
 * needs to embed the font. So we enumerate well-known system-default font paths
 * per language + per OS. This is reliable because CJK system defaults are
 * remarkably stable across OS versions (YaHei since Vista, PingFang since 10.11,
 * Malgun since Vista, etc.). The caller's `IOUtils.exists` picks whichever one
 * is actually present on this machine.
 *
 * OS detection uses three layered sources (mirrors JavaRuntimeManager.ts, the
 * most robust version in the codebase):
 *   1. Zotero.isWin / Zotero.isMac  (set by Zotero itself)
 *   2. Zotero.platform              ("win32" | "macosx" | "linux")
 *   3. nsIXULRuntime.OS             ("WINNT" | "Darwin" | "Linux")
 * Never `process.platform`.
 *
 * Ported from leadero's src/core/pdf/platform.ts. The pure functions
 * (fontLangForTarget / isCjkTarget) are covered by tests/node/platform-font.spec.ts.
 *
 * @module core/pdf/platform
 */


/** True on Windows. Triple-fallback so it's correct even if one source is off. */
import { safeDebug } from "../../utils/logger";

export function isWindows(): boolean {
  const Z = Zotero as any;
  if (Z.isWin) return true;
  if (Z.platform === "win32" || Z.platform === "win") return true;
  try {
    const appinfo = (Components as any).classes[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIXULRuntime);
    if (appinfo?.OS === "WINNT") return true;
  } catch (e) {
    safeDebug("[Z-Transplit] platform: " + e);
    /* ignore */
  }
  return false;
}

/** True on macOS. */
export function isMac(): boolean {
  const Z = Zotero as any;
  if (Z.isMac) return true;
  if (Z.platform === "macosx" || Z.platform === "mac") return true;
  try {
    const appinfo = (Components as any).classes[
      "@mozilla.org/xre/app-info;1"
    ]?.getService?.((Components as any).interfaces?.nsIXULRuntime);
    if (appinfo?.OS === "Darwin") return true;
  } catch (e) {
    safeDebug("[Z-Transplit] platform: " + e);
    /* ignore */
  }
  return false;
}

/** True on Linux (anything that isn't Windows or macOS). */
export function isLinux(): boolean {
  return !isWindows() && !isMac();
}

/**
 * The Windows directory (where Fonts\ lives), e.g. "C:\Windows". Windows-only.
 *
 * Resolved through the XPCOM directory service's "WinD" key — `process` is not
 * defined in the chrome realm, so reading `process.env.WINDIR` here only
 * produced a ReferenceError on every call (caught, but it logged a lie and
 * skipped this lookup entirely).
 */
function windowsDir(): string {
  try {
    const dirSvc = (Components as any).classes[
      "@mozilla.org/file/directory-service;1"
    ].getService((Components as any).interfaces.nsIProperties);
    const winD = dirSvc.get("WinD", (Components as any).interfaces.nsIFile);
    if (winD?.path) return winD.path;
  } catch (e) {
    safeDebug("[Z-Transplit] platform: " + e);
    /* ignore */
  }
  return "C:\\Windows";
}


/**
 * Language/script category used to pick the right system font family.
 * - "zh"/"ja"/"ko": the CJK target script (Chinese, Japanese, Korean).
 * - "latin": Latin-script text (English, French, German, ...). Used for the
 *   Latin "run" in mixed CJK+Latin paragraphs, and as the sole font when the
 *   target language is itself Latin.
 */
export type FontLang = "zh" | "ja" | "ko" | "latin";

/**
 * Map a translation target-language code (e.g. "zh-CN", "ja-JP", "en-US") to
 * the FontLang whose system font should be embedded for the target script.
 * Returns "latin" for any non-CJK language, and null only if the input is empty.
 */
export function fontLangForTarget(targetLanguage: string | undefined | null): FontLang {
  const t = (targetLanguage || "").toLowerCase();
  if (t.startsWith("zh")) return "zh";
  if (t.startsWith("ja")) return "ja";
  if (t.startsWith("ko")) return "ko";
  return "latin";
}

/**
 * True when the target language needs a CJK font (vs a pure-Latin font).
 */
export function isCjkTarget(targetLanguage: string | undefined | null): boolean {
  const f = fontLangForTarget(targetLanguage);
  return f === "zh" || f === "ja" || f === "ko";
}

/**
 * Well-known system-default font file paths for a given language/script, on the
 * three major desktop OSes. The caller's `IOUtils.exists` filter picks the
 * first one actually present on this machine. Ordered best→fallback.
 *
 * `.ttc` (TrueType Collection) files are included — pdf-lib's fontkit reads the
 * first sub-face from a TTC, which is fine for glyph coverage.
 */
export function systemFontPathsForLang(lang: FontLang): string[] {
  const win = isWindows();
  const mac = isMac();
  const wdir = win ? windowsDir() : "";

  if (lang === "zh") {
    // Chinese (Simplified + Traditional covered by these).
    if (win) {
      return [
        `${wdir}\\Fonts\\msyh.ttc`, // Microsoft YaHei (微软雅黑) — default since Vista
        `${wdir}\\Fonts\\msyhbd.ttc`, // YaHei Bold
        `${wdir}\\Fonts\\simsun.ttc`, // SimSun (宋体)
        `${wdir}\\Fonts\\simhei.ttf`, // SimHei (黑体)
      ];
    }
    if (mac) {
      return [
        "/System/Library/Fonts/PingFang.ttc", // default since 10.11
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
      ];
    }
    return [
      "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
      "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
    ];
  }

  if (lang === "ja") {
    // Japanese — Yu Gothic (default since Win10), Hiragino (default on macOS).
    if (win) {
      return [
        `${wdir}\\Fonts\\YuGothR.ttc`, // Yu Gothic Regular — default since Win10
        `${wdir}\\Fonts\\YuGothM.ttc`, // Yu Gothic Medium
        `${wdir}\\Fonts\\meiryo.ttc`, // Meiryo (legacy default)
        `${wdir}\\Fonts\\msgothic.ttc`, // MS Gothic (very old default)
      ];
    }
    if (mac) {
      return [
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", // Hiragino Sans — default
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Osaka.ttf",
      ];
    }
    return [
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf",
      "/usr/share/fonts/truetype/takao/TakaoGothic.ttf",
    ];
  }

  if (lang === "ko") {
    // Korean — Malgun Gothic (default since Vista), AppleGothic on macOS.
    if (win) {
      return [
        `${wdir}\\Fonts\\malgun.ttf`, // Malgun Gothic — default since Vista
        `${wdir}\\Fonts\\malgunbd.ttf`, // Malgun Gothic Bold
        `${wdir}\\Fonts\\gulim.ttc`, // Gulim (legacy default)
        `${wdir}\\Fonts\\batang.ttc`, // Batang
      ];
    }
    if (mac) {
      return [
        "/System/Library/Fonts/AppleGothic.ttf", // default Korean on macOS
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/Library/Fonts/AppleGothic.ttf",
      ];
    }
    return [
      "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.otf",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/truetype/unfonts/UnDotum.ttf",
    ];
  }

  // latin — Arial/Helvetica/Liberation. Used for Latin runs in CJK paragraphs
  // and as the sole font for Latin target languages.
  if (win) {
    return [
      `${wdir}\\Fonts\\arial.ttf`, // Arial — universal Latin default
      `${wdir}\\Fonts\\arialbd.ttf`, // Arial Bold
      `${wdir}\\Fonts\\segoeui.ttf`, // Segoe UI (Win10+ UI default)
      `${wdir}\\Fonts\\calibri.ttf`,
    ];
  }
  if (mac) {
    return [
      "/System/Library/Fonts/Helvetica.ttc", // Helvetica — macOS default
      "/System/Library/Fonts/SFNSMono.ttf",
      "/Library/Fonts/Arial.ttf",
    ];
  }
  return [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
}

/**
 * Back-compat alias for {@link systemFontPathsForLang}("zh"). Older callers
 * referenced `systemChineseFontPaths()` by name.
 */
export function systemChineseFontPaths(): string[] {
  return systemFontPathsForLang("zh");
}


/**
 * Read the first existing font file for a language from the system path list.
 * Returns its bytes (ArrayBuffer), or null if none exists / IOUtils unavailable.
 */
export async function readFontBytesForLang(lang: FontLang): Promise<Uint8Array | null> {
  const IOUtils = (globalThis as any).IOUtils;
  if (!IOUtils) return null;
  for (const p of systemFontPathsForLang(lang)) {
    try {
      if (await IOUtils.exists(p)) {
        // Return a bundle-realm copy, NOT bytes.buffer: a privileged-realm
        // ArrayBuffer fails pdf-lib's `instanceof ArrayBuffer` check (it calls
        // the font "of type NaN" — see opendataloaderSplitAdapter.realmLocalCopy).
        return new Uint8Array(await IOUtils.read(p));
      }
    } catch (e) {
      safeDebug("[Z-Transplit] platform: " + e);
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Resolve both the CJK and Latin font bytes for a translation target language.
 *
 * - For a CJK target (zh/ja/ko): returns the matching CJK system font as `cjk`,
 *   PLUS a Latin font as `latin` (for English runs mixed into CJK paragraphs).
 * - For a Latin target: `cjk` is null, `latin` is the Latin system font.
 *
 * This is the single entry point the translation pipeline should call.
 */
export async function resolveTargetFonts(
  targetLanguage: string | undefined | null,
): Promise<{ cjk: Uint8Array | null; latin: Uint8Array | null }> {
  const cjkLang = fontLangForTarget(targetLanguage);
  const [cjk, latin] = await Promise.all([
    isCjkTarget(targetLanguage) ? readFontBytesForLang(cjkLang) : Promise.resolve(null),
    readFontBytesForLang("latin"),
  ]);
  return { cjk, latin };
}
