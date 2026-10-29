/**
 * mergeTranslatedPages — page-swap merge for repeated page-range translations.
 *
 * Repeated range runs used to accumulate one translated attachment per run.
 * Both artifacts preserve the source's full page list in order (the pipeline
 * never adds, drops or reorders pages — untranslated pages are carried
 * verbatim), so page i of the fresh artifact corresponds to page i of the
 * existing one. Merging is a pure positional replacement: the pages
 * translated THIS run take over the same positions in the existing
 * attachment; every other page stays exactly as the existing attachment had
 * it. The union of translated pages accumulates in the file content itself —
 * no side ledger of "which pages are translated" exists or is needed.
 *
 * The pure function returns null (NEVER throws) for any precondition
 * failure — page-count mismatch, out-of-range indices, unparseable bytes.
 * Callers fall back to importing a separate attachment instead, so the
 * existing translation is never at risk: the merged bytes are fully built
 * in memory before anything touches the disk.
 *
 * @module core/pdf/translation/mergeTranslatedPages
 */

import { PDFDocument } from "pdf-lib";
import { safeDebug } from "../../../utils/logger";

/**
 * Replace the pages at `selectedPages` (0-based) of `existingBytes` with the
 * pages at the same positions of `newBytes`. Returns the merged PDF bytes,
 * or null when the operation is impossible (see above) or fails.
 */
export async function mergeTranslatedPages(
  existingBytes: Uint8Array,
  newBytes: Uint8Array,
  selectedPages: number[],
): Promise<Uint8Array | null> {
  try {
    // Content-copy normalization: cross-realm typed arrays (IOUtils.read)
    // and byteOffset views both confuse pdf-lib's instanceof type checks.
    const existing = await PDFDocument.load(new Uint8Array(existingBytes));
    const fresh = await PDFDocument.load(new Uint8Array(newBytes));
    const pageCount = existing.getPageCount();
    const pages = [...new Set(selectedPages)].sort((a, b) => a - b);
    if (pageCount === 0 || pages.length === 0) return null;
    if (fresh.getPageCount() !== pageCount) return null;
    if (pages[0] < 0 || pages[pages.length - 1] >= pageCount) return null;

    // Copy first, then mutate: the copied pages belong to `existing` and
    // survive its page-list surgery untouched.
    const copied = await existing.copyPages(fresh, pages);
    for (let i = pages.length - 1; i >= 0; i--) {
      existing.removePage(pages[i]);
    }
    pages.forEach((position, i) => existing.insertPage(position, copied[i]));
    return await existing.save();
  } catch (e) {
    safeDebug("[Z-Transplit] mergeTranslatedPages: " + e);
    return null;
  }
}

/**
 * Zotero-side glue: read the existing translation attachment's storage file,
 * merge this run's pages into it, and write the result back in place. The
 * attachment ITEM is kept (same id, same title, same dc:relation link) — the
 * library neither gains an entry nor loses the old one's identity.
 *
 * Returns the attachment on success, null on ANY failure (no path, no
 * IOUtils, unreadable or mismatched content) — the caller then imports a
 * separate attachment exactly like before. A failure here must never leave
 * the storage file half-written: the merge completes in memory before the
 * single write.
 */
export async function mergeIntoExistingTranslation(
  att: any,
  newBytes: Uint8Array,
  selectedPages: number[],
): Promise<any | null> {
  try {
    const path = att?.getFilePath?.();
    if (!path) return null;
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils?.read || !IOUtils?.write) return null;
    const raw = await IOUtils.read(path);
    const merged = await mergeTranslatedPages(
      raw instanceof Uint8Array ? raw : new Uint8Array(raw),
      newBytes,
      selectedPages,
    );
    if (!merged) return null;
    await IOUtils.write(path, merged);
    return att;
  } catch (e) {
    safeDebug("[Z-Transplit] mergeIntoExistingTranslation: " + e);
    return null;
  }
}
