/**
 * translatedAttachment — Save translated PDF bytes as a Zotero attachment.
 *
 * Zotero.Attachments has no "import from bytes" API — only importFromFile (which
 * takes an nsIFile). So we write the bytes to a temp file, import it, then delete
 * the temp.
 *
 * The attachment is attached to the ORIGINAL's parent item, so the split-view's
 * sibling-PDF lookup (splitViewCleanup.findLatestTranslation) finds it as the
 * right pane, and the manual "Split View" menu works too.
 *
 * Ported from leadero's src/core/pdf/translation/translatedAttachment.ts (temp
 * file prefix renamed to the z-transplit addon).
 *
 * @module core/pdf/translation/translatedAttachment
 */

/**
 * Save `bytes` as a Zotero PDF attachment.
 *
 * When `parentItemID` is set the translation is attached next to the source
 * under the same parent item (so split-view's sibling-PDF lookup
 * splitViewCleanup.findLatestTranslation finds it). When the source PDF is a
 * STANDALONE attachment (no parent — TransLift fixed the same gap in 2.7.0),
 * the translation is imported as a new top-level attachment item instead of
 * silently failing.
 *
 * @param bytes Translated PDF bytes (already merged across pages).
 * @param parentItemID The original attachment's parentItemID (the journal
 *   article etc.), or null/undefined for a standalone source.
 * @param title Display title for the new attachment (e.g. "Translated (zh-CN)").
 * @param sourceItem The source PDF attachment, when known — used to link the
 *   translation back via dc:relation so the dedup lookups also work for
 *   top-level sources.
 * @returns The created Zotero.Item (attachment).
 */
import { safeDebug } from "../../../utils/logger";

/** Merge `uri` into the item's dc:relation list (keeps other predicates). */
function addDcRelation(item: any, uri: string): void {
  const relations: Record<string, unknown> = { ...(item.getRelations?.() || {}) };
  const prev = relations["dc:relation"];
  const list: string[] = Array.isArray(prev)
    ? prev.slice()
    : prev
      ? [String(prev)]
      : [];
  if (!list.includes(uri)) list.push(uri);
  relations["dc:relation"] = list;
  item.setRelations(relations);
}

export async function importTranslatedBytes(
  bytes: Uint8Array,
  parentItemID: number | null | undefined,
  title: string,
  sourceItem?: any,
): Promise<any> {
  const tmpDir = (Zotero as any).getTempDirectory();
  const tmpFile = tmpDir.clone();
  tmpFile.append(`ztransplit-translated-${Date.now()}.pdf`);

  try {
    const IOUtils = (globalThis as any).IOUtils;
    if (!IOUtils || typeof IOUtils.write !== "function") {
      throw new Error("IOUtils.write unavailable — cannot write temp PDF");
    }
    await IOUtils.write(tmpFile.path, bytes);

    // importFromFile without parentItemID creates a top-level attachment item.
    const importOptions: Record<string, unknown> = { file: tmpFile };
    if (parentItemID != null) importOptions.parentItemID = parentItemID;
    const attachment = await (Zotero as any).Attachments.importFromFile(importOptions);

    // Give it a recognizable title so it's distinguishable from the source PDF
    // and so future re-translations could detect an existing translation.
    // Also link translation ↔ source via dc:relation (both directions, like
    // Zotero's Related pane) — the only way dedup finds translations of
    // top-level sources, which have no parent item to scan. Best-effort: a
    // failed link only costs dedup, never the translation itself.
    try {
      attachment.setField("title", title);
      const URI = (Zotero as any).URI;
      const sourceURI = sourceItem ? URI?.getItemURI?.(sourceItem) : null;
      if (sourceURI) {
        addDcRelation(attachment, sourceURI);
        const translationURI = URI?.getItemURI?.(attachment);
        if (translationURI) addDcRelation(sourceItem, translationURI);
      }
      await attachment.saveTx();
      if (sourceURI) await sourceItem.saveTx();
    } catch (e) {
      safeDebug("[Z-Transplit] translatedAttachment: " + e);
      /* best-effort — title/relation are cosmetic */
    }

    return attachment;
  } finally {
    try {
      if (tmpFile.exists()) tmpFile.remove(false);
    } catch (e) {
      safeDebug("[Z-Transplit] translatedAttachment: " + e);
      /* best-effort cleanup */
    }
  }
}
