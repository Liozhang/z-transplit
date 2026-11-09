/**
 * readerKind — reader-kind resolution tests (src/core/readerKind.ts).
 *
 * The kind gates every reader-facing entry point (translate pane section,
 * bilingual block, reader toolbar button, reader context menu), so its
 * resolution order is pinned here rather than inferred from those gates:
 *
 *   - items: Zotero's computed `attachmentReaderType` wins, then the
 *     contentType map, then the `.pdf` filename fallback (mirroring
 *     isPdfAttachment), else "none";
 *   - readers: `type` (the ReaderInstance getter) wins, then the inner
 *     reader's `_type`, then the item behind the reader, else "none".
 *
 * The Zotero global is stubbed where the item-lookup fallback runs; the
 * restore-after pattern follows featureReadiness.test.ts because these
 * modules also run under plain Node (vitest).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  getReaderKind,
  isPdfReaderKind,
  readerKindFromItem,
  supportsSelectionTranslation,
} from "../../../src/core/readerKind";

const savedZotero = (globalThis as any).Zotero;
const hadZotero = "Zotero" in (globalThis as any);

afterEach(() => {
  if (hadZotero) (globalThis as any).Zotero = savedZotero;
  else delete (globalThis as any).Zotero;
});

/** An attachment-like item as Zotero hands it to the item pane. */
function item(fields: Record<string, unknown>): any {
  return { id: 1, isAttachment: () => true, ...fields };
}

describe("readerKindFromItem", () => {
  it("reads Zotero's computed attachmentReaderType first", () => {
    expect(readerKindFromItem(item({ attachmentReaderType: "pdf" }))).toBe("pdf");
    expect(readerKindFromItem(item({ attachmentReaderType: "epub" }))).toBe("epub");
    expect(
      readerKindFromItem(item({ attachmentReaderType: "snapshot" })),
    ).toBe("snapshot");
  });

  it("falls back to the contentType map without the computed getter", () => {
    expect(
      readerKindFromItem(item({ attachmentContentType: "application/pdf" })),
    ).toBe("pdf");
    expect(
      readerKindFromItem(item({ attachmentContentType: "application/epub+zip" })),
    ).toBe("epub");
    expect(
      readerKindFromItem(item({ attachmentContentType: "text/html" })),
    ).toBe("snapshot");
  });

  it("contentType wins over the filename, and the getter wins over both", () => {
    expect(
      readerKindFromItem(
        item({
          attachmentContentType: "text/html",
          attachmentFilename: "paper.pdf",
        }),
      ),
    ).toBe("snapshot");
    expect(
      readerKindFromItem(
        item({
          attachmentReaderType: "epub",
          attachmentContentType: "application/pdf",
        }),
      ),
    ).toBe("epub");
  });

  it("uses the .pdf filename fallback when nothing else resolves", () => {
    expect(
      readerKindFromItem(item({ attachmentFilename: "Paper.PDF" })),
    ).toBe("pdf");
  });

  it("resolves none for non-reader attachments, notes and missing items", () => {
    expect(readerKindFromItem(item({ attachmentContentType: "image/png" }))).toBe(
      "none",
    );
    expect(
      readerKindFromItem(item({ attachmentFilename: "manuscript.docx" })),
    ).toBe("none");
    // A note item: no attachment fields at all.
    expect(readerKindFromItem({ id: 2, isNote: () => true })).toBe("none");
    expect(readerKindFromItem(null)).toBe("none");
    expect(readerKindFromItem(undefined)).toBe("none");
  });
});

describe("getReaderKind", () => {
  it("reads the ReaderInstance type getter first", () => {
    expect(getReaderKind({ type: "pdf" })).toBe("pdf");
    expect(getReaderKind({ type: "epub" })).toBe("epub");
    expect(getReaderKind({ type: "snapshot" })).toBe("snapshot");
  });

  it("falls back to the inner reader's _type", () => {
    expect(
      getReaderKind({ type: undefined, _internalReader: { _type: "epub" } }),
    ).toBe("epub");
  });

  it("falls back to the item behind the reader", () => {
    expect(
      getReaderKind({
        _item: { attachmentContentType: "application/pdf" },
      }),
    ).toBe("pdf");
    expect(
      getReaderKind({
        itemID: 7,
        _item: null,
      }),
    ).toBe("none");
  });

  it("looks the item up through Zotero.Items when the reader carries none", () => {
    (globalThis as any).Zotero = {
      Items: {
        get: (id: number) =>
          id === 7 ? { attachmentContentType: "text/html" } : null,
      },
    };
    expect(getReaderKind({ itemID: 7 })).toBe("snapshot");
    expect(getReaderKind({ itemID: 8 })).toBe("none");
  });

  it("survives a throwing Zotero.Items.get and a missing global", () => {
    (globalThis as any).Zotero = {
      Items: {
        get: () => {
          throw new Error("db closed");
        },
      },
    };
    expect(getReaderKind({ itemID: 7 })).toBe("none");
    delete (globalThis as any).Zotero;
    expect(getReaderKind({ itemID: 7 })).toBe("none");
  });

  it("resolves none for null readers and unknown type strings", () => {
    expect(getReaderKind(null)).toBe("none");
    expect(getReaderKind({ type: "video" })).toBe("none");
    expect(getReaderKind({})).toBe("none");
  });
});

describe("kind predicates", () => {
  it("isPdfReaderKind is true only for pdf", () => {
    expect(isPdfReaderKind("pdf")).toBe(true);
    expect(isPdfReaderKind("snapshot")).toBe(false);
    expect(isPdfReaderKind("epub")).toBe(false);
    expect(isPdfReaderKind("none")).toBe(false);
  });

  it("supportsSelectionTranslation covers pdf and snapshot only", () => {
    expect(supportsSelectionTranslation("pdf")).toBe(true);
    expect(supportsSelectionTranslation("snapshot")).toBe(true);
    expect(supportsSelectionTranslation("epub")).toBe(false);
    expect(supportsSelectionTranslation("none")).toBe(false);
  });
});
