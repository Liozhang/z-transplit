/**
 * capabilities — runtime feature detection for version- and host-dependent
 * capabilities.
 *
 * z-transplit now spans Zotero 7 (Gecko 115) and 10 (Gecko 140). Several
 * features degrade across that boundary, and the SDT (structured document
 * text) reading mode only exists on Zotero 10 — and even there, only when the
 * SDT pack is available for the document. Every check here is a defensive
 * `typeof` probe: no internal API is ever called blindly (see the
 * capability-disclosure pattern in src/ui/translatePane.ts#readSelection).
 *
 * @module core/capabilities
 */

import { safeDebug } from "../utils/logger";

export interface ReaderCapabilities {
  /** Zotero major version (7, 10, …). 0 when unknown. */
  zoteroMajor: number;
  /** Zotero 10 reader SDT reading mode reachable on this reader instance. */
  sdtModeAvailable: boolean;
  /** Web Speech API present (read-aloud TTS). */
  speechSynthesis: boolean;
  /** Intl.Segmenter present (Gecko 125+; used before the regex fallback). */
  intlSegmenter: boolean;
}

function zoteroMajor(): number {
  try {
    const version = String((globalThis as any)?.Zotero?.version || "");
    const major = Number.parseInt(version.split(".")[0] || "0", 10);
    return Number.isFinite(major) ? major : 0;
  } catch {
    return 0;
  }
}

/**
 * Probe the SDT reading mode on a reader instance.
 *
 * Zotero 10's reader exposes `_setReadingMode` / `_loadSDT` / `_primarySDTView`
 * on the internal reader (reader/src/common/reader.js). On Zotero 7 these are
 * absent. Presence is necessary but not sufficient — the SDT pack may still
 * fail to load per document (see enterBilingualSession's three-state handling).
 */
export function probeReaderCapabilities(reader: any): ReaderCapabilities {
  const internal = reader?._internalReader ?? reader;
  const sdtModeAvailable =
    !!internal &&
    typeof internal._setReadingMode === "function" &&
    typeof internal._loadSDT === "function";
  const caps: ReaderCapabilities = {
    zoteroMajor: zoteroMajor(),
    sdtModeAvailable,
    speechSynthesis:
      typeof (globalThis as any).speechSynthesis !== "undefined" ||
      typeof (globalThis as any).Zotero?.getMainWindow?.()?.speechSynthesis !==
        "undefined",
    intlSegmenter: typeof (globalThis as any).Intl?.Segmenter === "function",
  };
  safeDebug(
    `[Z-Transplit] capabilities: zotero=${caps.zoteroMajor} sdt=${caps.sdtModeAvailable} ` +
      `tts=${caps.speechSynthesis} segmenter=${caps.intlSegmenter}`,
  );
  return caps;
}
