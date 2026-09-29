/**
 * Clipboard helper — three-tier copy chain.
 *
 * Extracted verbatim from translatePane.ts (which had inlined leadero's
 * src/react/utils/clipboard.ts) so the word-cards tab's detail view shares it.
 */

import { toErrorMessage } from "./error";
import { safeDebug } from "./logger";
import { el } from "./dom";

/**
 * Copy text through Zotero's own clipboard helper first (works in every chrome
 * context, no secure-context requirement), then the async Clipboard API, then
 * a hidden textarea.
 *
 * @returns an empty string on success, otherwise the reason the copy failed.
 */
export async function copyText(doc: Document, text: string): Promise<string> {
  try {
    const zotero: any =
      (typeof Zotero === "undefined" ? undefined : (Zotero as any)) ??
      (doc?.defaultView as any)?.Zotero;
    if (zotero?.Utilities?.Internal?.copyTextToClipboard) {
      zotero.Utilities.Internal.copyTextToClipboard(text);
      return "";
    }
  } catch (e) {
    safeDebug("[Z-Transplit] clipboard: Zotero helper failed: " + e);
  }

  try {
    const nav = (doc?.defaultView as any)?.navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return "";
    }
  } catch (e) {
    safeDebug("[Z-Transplit] clipboard: navigator.clipboard failed: " + e);
  }

  try {
    const textarea = el(doc, "textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    doc.body?.appendChild(textarea);
    textarea.select();
    const ok = (doc as any).execCommand?.("copy");
    textarea.remove();
    if (ok) return "";
    return "execCommand('copy') returned false";
  } catch (e) {
    return toErrorMessage(e);
  }
}
