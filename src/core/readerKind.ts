/**
 * readerKind — which reader an item or reader instance runs.
 *
 * Zotero's reader serves exactly three attachment kinds, decided by the
 * item's content type (upstream chrome/content/zotero/xpcom/data/item.js,
 * the `attachmentReaderType` getter):
 *
 *   - application/pdf      → "pdf"       (pdf.js view)
 *   - application/epub+zip → "epub"      (epub.js view)
 *   - text/html            → "snapshot"  (web-page snapshot view)
 *
 * Every other attachment type (docx, images, audio/video, plain text, …) has
 * NO reader at all — it previews in the item pane or opens externally — and
 * notes are standalone items edited in the note editor, not attachments. So
 * the reader-facing entry points only ever see "pdf", "epub", "snapshot", or
 * nothing.
 *
 * This module is the single source of truth for that question. It exists
 * because the plugin's reader features are PDF-bound to different degrees:
 *
 *   - selection translation works on any kind (Zotero's text-selection popup
 *     event carries the selected text uniformly, with viewport-relative
 *     geometry the host positions itself);
 *   - the bilingual session, read-aloud and split view need the SDT reading
 *     mode and the pdf.js internals, which exist on PDF readers only.
 *
 * Entry points therefore gate on the kind instead of assuming a reader is a
 * PDF. An undeterminable kind resolves "none" (fail closed): a detection
 * failure shows up as a missing feature that the debug log explains, never as
 * a button that errors when clicked.
 *
 * Pure: no pref writes, no network, no side effects beyond reading the item.
 *
 * @module core/readerKind
 */

import { safeDebug } from "../utils/logger";

/** Reader kinds Zotero can open; "none" = no reader / undeterminable. */
export type ReaderKind = "pdf" | "epub" | "snapshot" | "none";

const READER_KINDS: readonly ReaderKind[] = ["pdf", "epub", "snapshot"];

/** Narrow an arbitrary value to a ReaderKind, or null when it is not one. */
function asReaderKind(value: unknown): ReaderKind | null {
  return typeof value === "string" && (READER_KINDS as readonly string[]).includes(value)
    ? (value as ReaderKind)
    : null;
}

/**
 * Content-type → reader kind, mirroring Zotero's `attachmentReaderType`
 * getter. Used when the host (or a test) hands us a bare attachment-like
 * object without the computed getter.
 */
function kindFromContentType(contentType: unknown): ReaderKind | null {
  switch (String(contentType ?? "").toLowerCase()) {
    case "application/pdf":
      return "pdf";
    case "application/epub+zip":
      return "epub";
    case "text/html":
      return "snapshot";
    default:
      return null;
  }
}

/**
 * The reader kind of an ITEM (attachment). Resolution order:
 *
 *   1. `attachmentReaderType` — Zotero's own computed getter, authoritative
 *      in production;
 *   2. `attachmentContentType` — the same mapping by hand, for hosts/tests
 *      that hand us a plain object;
 *   3. a `.pdf` filename — mirrors isPdfAttachment's extension fallback
 *      (src/core/pdf/translation/translatedAttachment.ts), PDF-only because
 *      that is the only kind the rest of the plugin infers from filenames.
 *
 * A non-attachment item (a note, a regular item) resolves "none": it never
 * opens in a reader.
 */
export function readerKindFromItem(item: any): ReaderKind {
  if (!item) return "none";

  const computed = asReaderKind(item.attachmentReaderType);
  if (computed) return computed;

  const byType = kindFromContentType(item.attachmentContentType);
  if (byType) return byType;

  if (/\.pdf$/i.test(String(item.attachmentFilename ?? ""))) return "pdf";

  return "none";
}

/**
 * The reader kind of a Zotero reader instance (the object reader events
 * carry as `event.reader`). Resolution order:
 *
 *   1. `reader.type` — the ReaderInstance's public getter, always set for
 *      readers Zotero opened (the constructor rejects attachment types it
 *      cannot serve);
 *   2. `reader._internalReader._type` — the same value on the inner reader
 *      object, for hosts that expose only that layer;
 *   3. the item behind the reader (`_item`, or `Zotero.Items.get(itemID)`)
 *      through readerKindFromItem.
 */
export function getReaderKind(reader: any): ReaderKind {
  if (!reader) return "none";

  const direct = asReaderKind(reader.type);
  if (direct) return direct;

  const internal = asReaderKind(reader._internalReader?._type);
  if (internal) return internal;

  const item = reader._item ?? null;
  if (item) return readerKindFromItem(item);

  const itemID = reader.itemID;
  if (typeof itemID === "number") {
    try {
      const resolved = (globalThis as any)?.Zotero?.Items?.get?.(itemID) ?? null;
      if (resolved) return readerKindFromItem(resolved);
    } catch (e) {
      safeDebug("[Z-Transplit] readerKind: item lookup failed: " + e);
    }
  }

  return "none";
}

/** Whether a reader kind carries the plugin's full feature set. */
export function isPdfReaderKind(kind: ReaderKind): boolean {
  return kind === "pdf";
}

/**
 * Whether a reader kind can serve selection translation: the text-selection
 * popup event carries the selected text on every kind, so HTML snapshots
 * qualify alongside PDFs. EPUB does not — the plugin keeps no reader surface
 * there (see the module docblock).
 */
export function supportsSelectionTranslation(kind: ReaderKind): boolean {
  return kind === "pdf" || kind === "snapshot";
}
