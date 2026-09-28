/**
 * opendataloader-pdf-parser — item-level wrapper around the OpenDataLoader JVM
 * client.
 *
 * Checks preferences, resolves the PDF attachment path, then delegates to
 * OpenDataLoaderPdfClient. This is the direct upstream of
 * OpenDataLoaderJsonAdapter.analyzePdfFromOpenDataLoader.
 *
 * Ported from leadero's src/core/tool/builtin/atomic/opendataloader-pdf-parser.ts.
 * leadero kept this file under its tool/builtin capability layer; z-transplit has
 * no tool registry, so it moved next to the rest of the PDF pipeline
 * (src/core/pdf/).
 *
 * One behavioral deviation from leadero: the `pdfParser.opendataloader.enabled`
 * gate only disables parsing on an explicit `false`; an unset pref falls back
 * to enabled. This keeps the parse path alive for users upgrading from a build
 * whose defaults predate the pref (the key is now declared in addon/prefs.js
 * and exposed in the settings pane, so fresh installs always have it). The
 * remaining parser options fall back to code defaults (matching loadConfig's
 * own fallbacks).
 */

import { getPref } from "../../utils/prefs";
import {
  parsePdfToMarkdown,
  parsePdfToJson,
  checkHealth,
  type OpenDataLoaderPdfParseResult,
  type OpenDataLoaderJsonParseResult,
} from "./OpenDataLoaderPdfClient";

/**
 * Parse a Zotero item's PDF attachment to structured Markdown via opendataloader-pdf.
 *
 * @param itemId - Zotero item ID (parent item, not attachment)
 * @param options - Optional page range (1-indexed, converted to the jar's
 *                  `--pages "start-end"` flag).
 * @returns Parsed markdown result or error
 */
export async function parseItemPdfToMarkdown(
  itemId: number,
  options?: { startPage?: number; endPage?: number; signal?: AbortSignal },
): Promise<OpenDataLoaderPdfParseResult> {
  const enabled = getPref("pdfParser.opendataloader.enabled");
  if (enabled === false) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error:
        "OpenDataLoader PDF is not enabled. Enable it in Z-Transplit preferences.",
    };
  }

  const item = await Zotero.Items.getAsync(itemId);
  if (!item) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: `Item ${itemId} not found`,
    };
  }

  const attachmentIds = item.getAttachments().filter((id: number) => {
    const att = Zotero.Items.get(id);
    return att && att.isPDFAttachment();
  });

  if (attachmentIds.length === 0) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: "No PDF attachment found for this item",
    };
  }

  const attachment = Zotero.Items.get(attachmentIds[0]);
  if (!attachment) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: "PDF attachment inaccessible",
    };
  }

  const filePath = attachment.getFilePath();
  if (!filePath) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: "PDF file path not available",
    };
  }

  try {
    // opendataloader-pdf uses 1-indexed pages with --pages "start-end"
    return await parsePdfToMarkdown(filePath, options);
  } catch (e: any) {
    return {
      success: false,
      markdown: "",
      images: {},
      source: "opendataloader-pdf",
      error: e.message || "Unknown error during OpenDataLoader PDF parsing",
    };
  }
}

/**
 * Parse a Zotero item's PDF attachment to structured JSON via opendataloader-pdf.
 *
 * @param itemId - Zotero item ID (parent item, not attachment)
 * @param options - Optional page range (1-indexed).
 * @returns Parsed JSON result or error
 */
export async function parseItemPdfToJson(
  itemId: number,
  options?: { startPage?: number; endPage?: number; signal?: AbortSignal },
): Promise<OpenDataLoaderJsonParseResult> {
  const enabled = getPref("pdfParser.opendataloader.enabled");
  if (enabled === false) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error:
        "OpenDataLoader PDF is not enabled. Enable it in Z-Transplit preferences.",
    };
  }

  const item = await Zotero.Items.getAsync(itemId);
  if (!item) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: `Item ${itemId} not found`,
    };
  }

  const attachmentIds = item.getAttachments().filter((id: number) => {
    const att = Zotero.Items.get(id);
    return att && att.isPDFAttachment();
  });

  if (attachmentIds.length === 0) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: "No PDF attachment found for this item",
    };
  }

  const attachment = Zotero.Items.get(attachmentIds[0]);
  if (!attachment) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: "PDF attachment inaccessible",
    };
  }

  const filePath = attachment.getFilePath();
  if (!filePath) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: "PDF file path not available",
    };
  }

  try {
    return await parsePdfToJson(filePath, options);
  } catch (e: any) {
    return {
      success: false,
      data: null,
      source: "opendataloader-pdf",
      error: e.message || "Unknown error during OpenDataLoader PDF JSON parsing",
    };
  }
}

/**
 * Test opendataloader-pdf connection (for preferences UI).
 * Checks that Java is available and the JAR is present.
 */
export { checkHealth };
