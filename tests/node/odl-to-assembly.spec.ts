 
/**
 * odl-to-assembly.spec — Unit tests for the OpenDataLoader → AssemblyResult adapter.
 *
 * Pure-function tests (no JVM, no Zotero): construct a synthetic
 * `PdfDocumentAnalysis` (the shape `analyzePdfFromOpenDataLoader` produces) and
 * verify `odlAnalysisToAssembly` maps every field into the geometry the renderer
 * expects, in the correct coordinate space (PDF user space, origin bottom-left,
 * y up, points — same as ODL's boundingBox).
 *
 * Also verifies the renderer's image-composite path: when an AssemblyResult
 * carries `images`, the produced PDF bytes contain an image XObject.
 *
 * Ported from leadero's tests/node/odl-to-assembly.spec.ts (import paths are
 * unchanged — the port mirrors leadero's src/ layout). The overlay case reads
 * tests/zotero/fixtures/a.pdf + NotoSansSC.ttf and self-skips when those
 * fixtures are absent (z-transplit did not port them; see port notes).
 *
 * Run: npm run test:unit -- odl-to-assembly
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  odlAnalysisToAssembly,
} from "../../src/core/pdf/translation/odlToAssembly";
import type { PdfDocumentAnalysis } from "../../src/core/pdf/PdfIR";
import {
  renderLayoutPreserving,
  renderOverlayTranslated,
} from "../../src/core/pdf/translation/LayoutPreservingRenderer";

// ─── Fixtures ────────────────────────────────────────────────────────

/** Build a minimal PdfDocumentAnalysis with the given pages of text blocks. */
function buildAnalysis(
  pages: Array<{
    width?: number;
    height?: number;
    blocks: Array<{
      text: string;
      x: number;
      y: number;
      width: number;
      height: number;
      fontSize?: number;
      fontName?: string;
      textColor?: string;
    }>;
    chartAreas?: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      imageDataUri?: string;
    }>;
    tables?: Array<{
      x: number;
      y: number;
      cells: Array<{ text: string; x: number; y: number; width: number; height: number }>;
    }>;
  }>,
): PdfDocumentAnalysis {
  return {
    source: "tier2-opendataloader-pdf",
    totalPages: pages.length,
    pages: pages.map((pg, i) => ({
      pageNumber: i + 1,
      width: pg.width ?? 612,
      height: pg.height ?? 792,
      textBlocks: pg.blocks.map((b) => ({
        text: b.text,
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        fontSize: b.fontSize ?? 10,
        fontName: b.fontName ?? "Helvetica",
        hasEOL: false,
        ...(b.textColor != null ? { textColor: b.textColor } : {}),
      })),
      regions: [],
      tables: (pg.tables ?? []).map((t) => ({
        pageNumber: i + 1,
        bbox: { x: t.x, y: t.y, width: 400, height: 60 },
        rows: [
          {
            cells: t.cells.map((c) => ({
              text: c.text,
              colspan: 1,
              rowspan: 1,
              bbox: { x: c.x, y: c.y, width: c.width, height: c.height },
            })),
          },
        ],
        confidence: 1,
      })),
      chartAreas: (pg.chartAreas ?? []).map((c) => ({
        pageNumber: i + 1,
        bbox: { x: c.x, y: c.y, width: c.width, height: c.height },
        detectedType: "unknown" as const,
        hasAxes: false,
        hasLegend: false,
        confidence: 0.6,
        ...(c.imageDataUri ? { imageDataUri: c.imageDataUri } : {}),
      })),
      formulas: [],
      repeatedElements: [],
      citations: [],
    })),
    allTables: [],
    allFormulas: [],
    allChartAreas: [],
    allCitations: [],
    filteredText: "",
    filteredMarkdown: "",
    confidence: 0.9,
    processingMs: 0,
  };
}

// ─── Adapter tests ───────────────────────────────────────────────────

describe("odlAnalysisToAssembly", () => {
  it("maps text blocks to paragraphs with correct geometry (no flip/scale)", () => {
    const analysis = buildAnalysis([
      {
        width: 595,
        height: 842,
        blocks: [
          { text: "Hello world", x: 100, y: 700, width: 300, height: 20, fontSize: 12 },
        ],
      },
    ]);

    const { assemblies, pageSizes } = odlAnalysisToAssembly(analysis);

    expect(assemblies).toHaveLength(1);
    expect(pageSizes).toEqual([{ width: 595, height: 842 }]);

    const a = assemblies[0];
    expect(a.paragraphs).toHaveLength(1);
    expect(a.texts).toEqual(["Hello world"]);

    const p = a.paragraphs[0];
    // Direct 1:1 mapping — ODL bbox is already in PDF user space.
    expect(p.x0).toBe(100);
    expect(p.x1).toBe(400); // x + width
    expect(p.y0).toBe(700); // bottom edge
    expect(p.y1).toBe(720); // y + height
    expect(p.y).toBe(700); // baseline region = bottom (matches assembler p.y=child.y0)
    expect(p.size).toBe(12);
    expect(p.brk).toBe(false);
  });

  it("preserves paragraph/text index alignment across multiple blocks", () => {
    const analysis = buildAnalysis([
      {
        blocks: [
          { text: "First paragraph.", x: 50, y: 700, width: 200, height: 15, fontSize: 10 },
          { text: "Second paragraph.", x: 50, y: 650, width: 200, height: 15, fontSize: 10 },
          { text: "Third.", x: 50, y: 600, width: 100, height: 15, fontSize: 14 },
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const a = assemblies[0];

    expect(a.texts).toEqual(["First paragraph.", "Second paragraph.", "Third."]);
    expect(a.paragraphs).toHaveLength(3);
    // texts[i] aligns with paragraphs[i]
    expect(a.paragraphs[2].size).toBe(14);
    expect(a.paragraphs[2].x0).toBe(50);
  });

  it("skips empty/whitespace text blocks (avoid wasting translation calls)", () => {
    const analysis = buildAnalysis([
      {
        blocks: [
          { text: "Real text", x: 50, y: 700, width: 200, height: 15, fontSize: 10 },
          { text: "   ", x: 50, y: 650, width: 200, height: 15, fontSize: 10 },
          { text: "", x: 50, y: 600, width: 200, height: 15, fontSize: 10 },
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const a = assemblies[0];

    expect(a.texts).toEqual(["Real text"]);
    expect(a.paragraphs).toHaveLength(1);
  });

  it("clamps degenerate font sizes (>0 guard) and zero-width boxes", () => {
    const analysis = buildAnalysis([
      {
        blocks: [
          { text: "Bad size", x: 50, y: 700, width: 200, height: 15, fontSize: 0 },
          { text: "Bad width", x: 50, y: 650, width: 0, height: 15, fontSize: 10 },
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const a = assemblies[0];

    // fontSize 0 → clamped to a legible default (10) so the renderer doesn't
    // produce invisible 1pt text. The original clamp-to-1 was a degradation
    // bug; a 1pt glyph is unreadable. See odlToAssembly.ts size clamp.
    expect(a.paragraphs[0].size).toBe(10);
    // The source fontSize is preserved separately for reference.
    expect(a.paragraphs[0].sourceFontSize).toBe(0);
    // width 0 → x1 still > x0 (renderer's Math.max(10, x1-x0) floor is safe either way).
    expect(a.paragraphs[1].x1).toBeGreaterThan(a.paragraphs[1].x0);
  });

  it("extracts chartArea imageDataUri into PlacedImage[] when present", () => {
    const png1x1 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const analysis = buildAnalysis([
      {
        blocks: [
          { text: "caption", x: 50, y: 200, width: 200, height: 12, fontSize: 9 },
        ],
        chartAreas: [
          { x: 100, y: 300, width: 400, height: 300, imageDataUri: png1x1 },
          { x: 100, y: 50, width: 100, height: 100 }, // no imageDataUri → skipped
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const a = assemblies[0];

    expect(a.images).toBeDefined();
    expect(a.images).toHaveLength(1);
    expect(a.images![0].dataUri).toBe(png1x1);
    expect(a.images![0].bbox).toEqual({ x: 100, y: 300, width: 400, height: 300 });
  });

  it("omits images field entirely when no chartAreas carry image data", () => {
    const analysis = buildAnalysis([
      {
        blocks: [{ text: "text", x: 50, y: 700, width: 200, height: 15, fontSize: 10 }],
        chartAreas: [{ x: 100, y: 300, width: 400, height: 300 }], // no imageDataUri
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    expect(assemblies[0].images).toBeUndefined();
  });

  it("handles multiple pages with independent page sizes", () => {
    const analysis = buildAnalysis([
      { width: 612, height: 792, blocks: [{ text: "p1", x: 50, y: 700, width: 50, height: 12, fontSize: 10 }] },
      { width: 842, height: 595, blocks: [{ text: "p2", x: 50, y: 500, width: 50, height: 12, fontSize: 10 }] },
    ]);

    const { assemblies, pageSizes } = odlAnalysisToAssembly(analysis);

    expect(assemblies).toHaveLength(2);
    expect(pageSizes).toEqual([
      { width: 612, height: 792 },
      { width: 842, height: 595 },
    ]);
    expect(assemblies[0].texts).toEqual(["p1"]);
    expect(assemblies[1].texts).toEqual(["p2"]);
  });

  it("returns empty arrays for a page with no text blocks", () => {
    const analysis = buildAnalysis([{ blocks: [] }]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    expect(assemblies[0].paragraphs).toEqual([]);
    expect(assemblies[0].texts).toEqual([]);
  });

  it("fills formulas and globalLines with empty arrays (renderer ignores them)", () => {
    const analysis = buildAnalysis([
      { blocks: [{ text: "x", x: 1, y: 1, width: 1, height: 1, fontSize: 10 }] },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    expect(assemblies[0].formulas).toEqual([]);
    expect(assemblies[0].globalLines).toEqual([]);
  });

  it("SKIPS table cells (tables kept as source, not translated)", () => {
    // Behavior change: tables are now kept as-is in the source PDF rather than
    // having each cell translated. So table cells must NOT appear in the
    // paragraphs/texts arrays — only the body text block does.
    const analysis = buildAnalysis([
      {
        blocks: [{ text: "Intro", x: 50, y: 700, width: 200, height: 15, fontSize: 11 }],
        tables: [
          {
            x: 50,
            y: 600,
            cells: [
              { text: "Gene", x: 50, y: 610, width: 80, height: 14 },
              { text: "P-value", x: 130, y: 610, width: 80, height: 14 },
              { text: "", x: 210, y: 610, width: 80, height: 14 },
            ],
          },
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const a = assemblies[0];

    // Only the body "Intro" paragraph — table cells are intentionally skipped.
    expect(a.paragraphs).toHaveLength(1);
    expect(a.texts).toEqual(["Intro"]);
  });

  it("preserves textColor from ODL text blocks into PdfTextBlock", () => {
    const analysis = buildAnalysis([
      {
        blocks: [
          { text: "red text", x: 50, y: 700, width: 200, height: 15, fontSize: 10, textColor: "#FF0000" },
          { text: "blue text", x: 50, y: 650, width: 200, height: 15, fontSize: 10, textColor: "rgb(0,0,255)" },
          { text: "no color", x: 50, y: 600, width: 200, height: 15, fontSize: 10 },
        ],
      },
    ]);

    const { assemblies } = odlAnalysisToAssembly(analysis);
    const paragraphs = assemblies[0].paragraphs;

    // textColor is parsed into paragraph.color (0-1 RGB) by odlToAssembly.
    expect(paragraphs[0].color).toEqual({ r: 1, g: 0, b: 0 });
    expect(paragraphs[1].color).toEqual({ r: 0, g: 0, b: 1 });
    expect(paragraphs[2].color).toBeUndefined();
  });

  it("table cells are NOT rendered (tables kept as source)", async () => {
    // Behavior change: tables are skipped entirely, so a page with only a
    // table produces no renderable paragraphs.
    const analysis = buildAnalysis([
      {
        blocks: [],
        tables: [
          {
            x: 50,
            y: 600,
            cells: [{ text: "Result", x: 50, y: 610, width: 100, height: 14 }],
          },
        ],
      },
    ]);
    const { assemblies, pageSizes } = odlAnalysisToAssembly(analysis);

    const result = await renderLayoutPreserving(assemblies[0], [], {
      targetLanguage: "zh-CN",
      pageWidth: pageSizes[0].width,
      pageHeight: pageSizes[0].height,
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    // No paragraphs rendered (table cells skipped, no body text).
    expect(result.stats.paragraphsRendered).toBe(0);
  });
});

// ─── Renderer image-composite test ──────────────────────────────────

describe("renderLayoutPreserving with images", () => {
  // 2x2 red PNG (minimal valid PNG with distinct content).
  const RED_PNG_2x2 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8DwnwEPYBtVQwQAAB34BJ7C8r4AAAAASUVORK5CYII=";

  it("embeds image XObject into output PDF when AssemblyResult.images present", async () => {
    const { assemblies, pageSizes } = odlAnalysisToAssembly(
      buildAnalysis([
        {
          blocks: [{ text: "Fig 1", x: 50, y: 700, width: 100, height: 12, fontSize: 10 }],
          chartAreas: [{ x: 100, y: 300, width: 200, height: 200, imageDataUri: RED_PNG_2x2 }],
        },
      ]),
    );

    const result = await renderLayoutPreserving(assemblies[0], ["图 1"], {
      targetLanguage: "zh-CN",
      pageWidth: pageSizes[0].width,
      pageHeight: pageSizes[0].height,
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.stats.imagesRendered).toBe(1);
    expect(result.stats.imagesDropped).toBe(0);
    // The PDF byte stream should reference image data (XObject /Image).
    const pdfText = Buffer.from(result.bytes).toString("latin1");
    expect(pdfText).toMatch(/\/(Image|XObject)/);
    // PNG signature bytes should appear embedded (the IDAT chunk data).
    expect(pdfText.length).toBeGreaterThan(500);
  });

  it("renders text-only page correctly when no images present (common case)", async () => {
    const { assemblies, pageSizes } = odlAnalysisToAssembly(
      buildAnalysis([
        { blocks: [{ text: "Hello", x: 50, y: 700, width: 200, height: 15, fontSize: 12 }] },
      ]),
    );

    const result = await renderLayoutPreserving(assemblies[0], ["你好"], {
      targetLanguage: "zh-CN",
      pageWidth: pageSizes[0].width,
      pageHeight: pageSizes[0].height,
    });

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.stats.imagesRendered).toBe(0);
    expect(result.stats.paragraphsRendered).toBe(1);
  });

  it("counts dropped images on malformed data URIs without aborting", async () => {
    const { assemblies, pageSizes } = odlAnalysisToAssembly(
      buildAnalysis([
        {
          blocks: [{ text: "t", x: 50, y: 700, width: 100, height: 12, fontSize: 10 }],
          chartAreas: [
            { x: 100, y: 300, width: 50, height: 50, imageDataUri: "not-a-valid-uri" },
            { x: 200, y: 300, width: 50, height: 50, imageDataUri: "data:image/gif;base64,R0lGODlh" }, // unsupported format
          ],
        },
      ]),
    );

    const result = await renderLayoutPreserving(assemblies[0], ["t"], {
      targetLanguage: "zh-CN",
      pageWidth: pageSizes[0].width,
      pageHeight: pageSizes[0].height,
    });

    expect(result.stats.imagesRendered).toBe(0);
    expect(result.stats.imagesDropped).toBe(2);
    // Text still rendered despite bad images.
    expect(result.stats.paragraphsRendered).toBe(1);
  });
});

// ─── Overlay mode test (preserve original vector content) ────────────

describe("renderOverlayTranslated (overlay mode)", () => {
  const SOURCE_PDF = path.join(__dirname, "..", "zotero", "fixtures", "a.pdf");
  const CJK_FONT = path.join(
    __dirname,
    "..",
    "zotero",
    "fixtures",
    "NotoSansSC.ttf",
  );

  it("loads the source PDF, overlays translated text, preserves original content", async () => {
    if (!fs.existsSync(SOURCE_PDF)) return; // skip if fixture missing
    const sourceBytes = fs.readFileSync(SOURCE_PDF);
    const cjkBytes = fs.existsSync(CJK_FONT)
      ? fs.readFileSync(CJK_FONT)
      : undefined;

    // Build a 1-page assembly matching a.pdf's page size (612x792).
    const analysis: PdfDocumentAnalysis = {
      source: "tier2-opendataloader-pdf",
      totalPages: 1,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          textBlocks: [
            {
              text: "Hello",
              bbox: { x: 50, y: 700, width: 200, height: 15 },
              fontSize: 12,
              fontName: "Helvetica",
              hasEOL: false,
            },
          ],
          regions: [],
          tables: [],
          chartAreas: [],
          formulas: [],
          repeatedElements: [],
          citations: [],
        },
      ],
      allTables: [],
      allFormulas: [],
      allChartAreas: [],
      allCitations: [],
      filteredText: "",
      filteredMarkdown: "",
      confidence: 0.9,
      processingMs: 0,
    };
    const { assemblies } = odlAnalysisToAssembly(analysis);

    const result = await renderOverlayTranslated(
      sourceBytes,
      assemblies,
      [["你好"]],
      {
        targetLanguage: "zh-CN",
        ...(cjkBytes ? { cjkFontBytes: cjkBytes } : {}),
      },
    );

    // Output should be a valid PDF roughly the size of the source (not bloated
    // by rasterization, since overlay preserves vectors).
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(result.stats.paragraphsRendered).toBe(1);

    // Verify it's a valid PDF with the source's page count (1) by reloading.
    const { PDFDocument } = await import("pdf-lib");
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });
});
