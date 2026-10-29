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
 * @param title Display title for the new attachment (e.g.
 *   "Translated (zh-CN) · paper" — see translatedTitleWithSource).
 * @param sourceItem The source PDF attachment, when known — used to link the
 *   translation back via dc:relation so the dedup lookups also work for
 *   top-level sources.
 * @returns The created Zotero.Item (attachment).
 */
import { getString } from "../../../utils/locale";
import { getPrefDynamic } from "../../../utils/prefs";
import { safeDebug } from "../../../utils/logger";

/** Preference holding the attachment-title template ("" = legacy default). */
const NAME_TEMPLATE_PREF = "translations.nameTemplate";

/**
 * Characters that are illegal in Windows file names (plus control chars).
 * Zotero storage paths are built from the fileBaseName we hand to
 * importFromFile, and source PDFs keep whatever name they were downloaded
 * with — a "论文: v2?.pdf" in the library must not break the disk write
 * (pdf2zh #69 is the same failure class).
 */
const FILENAME_ILLEGAL_RE = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Windows also rejects trailing dots and spaces on a file name. */
const FILENAME_TRAILING_RE = /[. ]+$/;
const FILENAME_MAX = 100;

/**
 * Base name of the source PDF file without extension ("paper" from
 * ".../paper.pdf"). Prefers the attachment's own filename, falls back to its
 * file path, and finally to a constant so a name is always produced. The
 * result is sanitized to a Windows-safe file-name fragment — it feeds both
 * the disk fileBaseName and the display title.
 */
export function translatedSourceBaseName(sourceItem: any): string {
  const raw = String(
    sourceItem?.attachmentFilename ?? sourceItem?.getFilePath?.() ?? "",
  );
  const file = raw.split(/[\\/]/).pop() ?? "";
  let base = file.replace(/\.pdf$/i, "");
  base = base
    .replace(FILENAME_ILLEGAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  base = base.replace(FILENAME_TRAILING_RE, "").trimEnd();
  if (base.length > FILENAME_MAX) base = base.slice(0, FILENAME_MAX).trimEnd();
  return base || "pdf";
}

/**
 * Disk file base name for the translated copy: the original name with a
 * Translated_ prefix, so the two PDFs in the parent's storage area can never
 * be confused (Zotero's default naming would give them identical names).
 */
export function translatedFileBaseName(sourceItem: any): string {
  return `Translated_${translatedSourceBaseName(sourceItem)}`;
}

/**
 * Display title for the translated attachment.
 *
 * Default shape stays `Translated (<lang>) · <base>` — the legacy convention
 * that splitViewCleanup and the item-tree menu have matched since the naming
 * was introduced. When the `translations.nameTemplate` preference is set, the
 * template is rendered instead; placeholders {lang}, {title} and {date}
 * (YYYY-MM-DD) are substituted, unknown placeholders pass through as literal
 * text, and a render that comes out empty falls back to the legacy shape so a
 * title is never blank.
 */
export function translatedTitleWithSource(
  lang: string,
  sourceBaseName: string,
): string {
  const template = String(getPrefDynamic(NAME_TEMPLATE_PREF) || "").trim();
  if (!template) return `Translated (${lang}) · ${sourceBaseName}`;
  const rendered = template
    .replace(/\{lang\}/g, lang)
    .replace(/\{title\}/g, sourceBaseName)
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10))
    .trim();
  return rendered || `Translated (${lang}) · ${sourceBaseName}`;
}

/**
 * Recognizer for translated-attachment titles, shared by every dedup site
 * (split-view sibling scan, item-tree duplicate skip).
 *
 * Matches the legacy `译文 (` / `Translated (` prefix shape AND — when a name
 * template is configured — titles matching the rendered template (literal
 * parts escaped, placeholders as wildcards, {date} pinned to its format).
 * Both checks are case-insensitive on the legacy side, like the original
 * regex. A template change intentionally stops matching titles produced by
 * the previous template: the user opted into a new convention, and the next
 * translation pass simply creates a fresh attachment.
 */
export function translationTitleMatcher(): (title: string) => boolean {
  const legacy = /^(译文|Translated)\s*\(/i;
  const template = String(getPrefDynamic(NAME_TEMPLATE_PREF) || "").trim();
  let templateRe: RegExp | null = null;
  if (template) {
    // Split on placeholders first, escape the literal segments afterwards —
    // escaping the whole template would also escape the placeholder braces
    // and leave stray backslashes around the wildcards.
    const pieces: string[] = [];
    const placeholderRe = /(\{lang\}|\{title\}|\{date\})/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = placeholderRe.exec(template)) !== null) {
      pieces.push(template.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pieces.push(
        m[1].toLowerCase() === "{date}" ? "\\d{4}-\\d{2}-\\d{2}" : ".+",
      );
      last = m.index + m[0].length;
    }
    pieces.push(template.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    try {
      templateRe = new RegExp(`^${pieces.join("")}$`, "i");
    } catch (e) {
      safeDebug("[Z-Transplit] translatedAttachment: bad template RE: " + e);
    }
  }
  return (title: string) => {
    const t = title || "";
    if (legacy.test(t)) return true;
    return templateRe ? templateRe.test(t) : false;
  };
}

/**
 * Is this item a PDF attachment? `attachmentContentType` is the primary
 * signal, but it is derived from the file extension at import time — a file
 * downloaded as `PAPER.PDF` can end up with an empty/unknown content type on
 * some hosts, so the file name (case-insensitive) is the fallback
 * (pdf2zh #368 is the same failure class).
 */
export function isPdfAttachment(att: any): boolean {
  try {
    if (att?.attachmentContentType === "application/pdf") return true;
    return /\.pdf$/i.test(String(att?.attachmentFilename ?? ""));
  } catch (e) {
    return false;
  }
}

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
    // fileBaseName pins the disk name to Translated_<original>.pdf — without
    // it Zotero names both PDFs after the parent item (autoRenameFiles), and
    // the two files in storage become indistinguishable.
    const importOptions: Record<string, unknown> = {
      file: tmpFile,
      fileBaseName: translatedFileBaseName(sourceItem),
    };
    if (parentItemID != null) importOptions.parentItemID = parentItemID;
    const attachment = await (Zotero as any).Attachments.importFromFile(importOptions);

    // Give it a recognizable title so it's distinguishable from the source PDF
    // and so future re-translations could detect an existing translation.
    // Also link translation ↔ source via dc:relation (both directions, like
    // Zotero's Related pane) — the only way dedup finds translations of
    // top-level sources, which have no parent item to scan. The「译文」tag is
    // the at-a-glance library marker (item pane + tags column + tag selector).
    // All best-effort: a failed mark only costs identification, never the
    // translation itself.
    try {
      attachment.setField("title", title);
      const tag = getString("translated-tag");
      if (tag) attachment.addTag(tag);
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
      /* best-effort — title/tag/relation are cosmetic */
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
