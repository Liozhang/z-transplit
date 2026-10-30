/**
 * sentenceContext tests — the pure extraction pipeline (line clustering,
 * selection-line matching, paragraph joining, sentence picking) must hold on
 * plain objects; the host bridge (captureSentenceContext) is covered with a
 * fake reader mimicking the pdf.js content realm.
 */

import { describe, expect, it } from "vitest";
import {
  groupItemsIntoLines,
  joinLinesToText,
  linesForSelection,
  normalizeForMatch,
  pickSentence,
  sentenceFromItems,
  captureSentenceContext,
  type PdfTextItem,
  type PdfTextLine,
} from "../../../../src/core/wordcards/sentenceContext";

/** A pdf.js-shaped text item at (x, y) with a width roughly proportional to len. */
function item(str: string, x: number, y: number, width = str.length * 5): PdfTextItem {
  return { str, transform: [1, 0, 0, 1, x, y], width, height: 10 };
}

function line(y: number, xMin: number, xMax: number, text: string): PdfTextLine {
  return { y, xMin, xMax, text };
}

describe("normalizeForMatch", () => {
  it("folds case, apostrophes, ligatures and whitespace", () => {
    expect(normalizeForMatch("Don’t STOP")).toBe("don't stop");
    expect(normalizeForMatch("eﬃcient")).toContain("efficient");
    expect(normalizeForMatch("  a\tb ")).toBe("a b");
  });
});

describe("groupItemsIntoLines", () => {
  it("clusters items by baseline y and sorts x within each line, top first", () => {
    const lines = groupItemsIntoLines([
      item("world", 60, 100),
      item("hello", 10, 100),
      item("second", 10, 80),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("hello world");
    expect(lines[0].y).toBe(100);
    expect(lines[1].text).toBe("second");
  });

  it("keeps near-baseline items (≤ tolerance) on one line", () => {
    const lines = groupItemsIntoLines([item("a", 0, 100), item("b", 10, 102.5)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("a b");
  });

  it("skips items without text or without a usable transform", () => {
    const lines = groupItemsIntoLines([
      item("keep", 0, 50),
      { str: "   ", transform: [1, 0, 0, 1, 5, 50] },
      { str: "ghost" },
      { str: "bad", transform: [1, 0, 0, 1, Number.NaN, 40] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("keep");
  });
});

describe("linesForSelection", () => {
  const lines = [
    line(200, 70, 300, "left top"),
    line(180, 70, 300, "left mid"),
    line(180, 320, 550, "right mid"),
    line(160, 70, 300, "left low"),
  ];

  it("keeps lines overlapping the selection rect in y and x (column isolation)", () => {
    const matched = linesForSelection(lines, [[70, 172, 300, 188]]);
    expect(matched.map((l) => l.text)).toEqual(["left mid"]);
  });

  it("normalizes rect axis order", () => {
    const matched = linesForSelection(lines, [[300, 188, 70, 172]]);
    expect(matched.map((l) => l.text)).toEqual(["left mid"]);
  });

  it("matches nothing when rects are missing or malformed", () => {
    expect(linesForSelection(lines)).toEqual([]);
    expect(linesForSelection(lines, [["bad"] as unknown as number[]])).toEqual([]);
  });
});

describe("joinLinesToText", () => {
  it("joins close lines with spaces", () => {
    const text = joinLinesToText([
      line(100, 0, 50, "The first"),
      line(85, 0, 50, "line continues"),
    ]);
    expect(text).toBe("The first line continues");
  });

  it("merges a hyphenated word split across lines", () => {
    const text = joinLinesToText([
      line(100, 0, 50, "the photo-"),
      line(85, 0, 50, "synthesis works"),
    ]);
    expect(text).toBe("the photosynthesis works");
  });

  it("breaks the paragraph on a gap beyond twice the median line gap", () => {
    const text = joinLinesToText([
      line(100, 0, 50, "Paragraph one here"),
      line(85, 0, 50, "still first paragraph"),
      line(40, 0, 50, "second paragraph starts"), // gap 45 vs median 15
    ]);
    expect(text).toBe("Paragraph one here still first paragraph\nsecond paragraph starts");
  });
});

describe("pickSentence", () => {
  const text =
    "Reading is a complex activity. It engages the hippocampus! Does it help?";

  it("returns the sentence containing the word", () => {
    expect(pickSentence(text, "hippocampus")).toBe("It engages the hippocampus!");
  });

  it("matches case-insensitively and through apostrophe variants", () => {
    expect(pickSentence("Students don't agree. Others do.", "Don't")).toBe(
      "Students don't agree.",
    );
  });

  it("returns null when the word is absent", () => {
    expect(pickSentence(text, "missing")).toBeNull();
    expect(pickSentence("", "word")).toBeNull();
  });

  it("handles a CJK word as a substring with CJK terminators", () => {
    const zh = "这是第一句。共振现象很重要。这是第三句！";
    expect(pickSentence(zh, "共振")).toBe("共振现象很重要。");
  });

  it("expands manually when the splitter's spans miss the word", () => {
    // No terminator inside → the whole text is one span; a two-part text
    // where the splitter glue hides the word exercises the raw-scan fallback.
    const tricky = "The first part mentions photosyn thesis in passing, and then it just keeps going without any terminator at all";
    expect(pickSentence(tricky, "photosyn")).toContain("photosyn thesis");
  });
});

describe("sentenceFromItems", () => {
  it("extracts the sentence under the selection, staying inside the column", () => {
    // Two-column page: the word appears in BOTH columns; the selection rect
    // points at the left one.
    const items: PdfTextItem[] = [
      item("Title of the paper", 70, 700),
      item("The left column discusses", 70, 650),
      item("resonance in detail today.", 70, 635),
      item("The right column mentions", 320, 650),
      item("resonance as well here.", 320, 635),
    ];
    const sentence = sentenceFromItems(
      items,
      { pageIndex: 0, rects: [[70, 630, 300, 655]] },
      "resonance",
    );
    expect(sentence).toContain("left column");
    expect(sentence).not.toContain("right column");
  });

  it("prefers the occurrence under the selection when the word repeats on the page", () => {
    // Single column: the word is in the title AND in the body; the rect
    // points at the body line — the title sentence must not win.
    const items: PdfTextItem[] = [
      item("Reading and the Brain", 73, 756),
      item("Jane M. Doe and John Q. Smith", 73, 728),
      item("Abstract", 73, 692),
      item("Reading is a complex cognitive activity that involves", 73, 668),
      item("multiple brain regions over time.", 73, 652),
    ];
    const sentence = sentenceFromItems(
      items,
      { pageIndex: 0, rects: [[70, 662, 520, 674]] },
      "reading",
    );
    expect(sentence).toContain("complex cognitive activity");
    expect(sentence).not.toContain("Brain");
  });

  it("falls back to the whole page when no rect matches any line", () => {
    const items: PdfTextItem[] = [
      item("Somewhere else the word", 70, 650),
      item("hippocampus appears here.", 70, 635),
    ];
    const sentence = sentenceFromItems(items, { pageIndex: 0, rects: [[900, 900, 950, 950]] }, "hippocampus");
    expect(sentence).toBe("Somewhere else the word hippocampus appears here.");
  });

  it("returns null when the word is nowhere on the page", () => {
    const items = [item("nothing relevant", 70, 650)];
    expect(sentenceFromItems(items, { pageIndex: 0, rects: [[70, 645, 200, 655]] }, "absent")).toBeNull();
    expect(sentenceFromItems([], { pageIndex: 0 }, "word")).toBeNull();
  });
});

describe("captureSentenceContext (host bridge)", () => {
  /** Fake reader exposing the pdf.js surface the bridge unwraps. */
  function fakeReader(items: PdfTextItem[], numPages = 5): any {
    const page = {
      getTextContent: async () => ({ items }),
    };
    return {
      _internalReader: {
        _primaryView: {
          _iframeWindow: {
            wrappedJSObject: {
              PDFViewerApplication: {
                pdfViewer: {
                  pdfDocument: { getPage: async () => page, numPages },
                },
              },
            },
          },
        },
      },
    };
  }

  const items = [
    item("The model predicts", 70, 650),
    item("resonance clearly.", 70, 635),
  ];

  it("returns the sentence plus the position for a healthy reader", async () => {
    const captured = await captureSentenceContext(
      fakeReader(items),
      "resonance",
      { pageIndex: 2, rects: [[70, 630, 200, 655]] },
    );
    expect(captured).not.toBeNull();
    expect(captured!.sentence).toBe("The model predicts resonance clearly.");
    expect(captured!.pageIndex).toBe(2);
    expect(captured!.rects).toEqual([[70, 630, 200, 655]]);
  });

  it("resolves null for a missing viewer, bad position, or out-of-range page", async () => {
    expect(await captureSentenceContext(null, "word", { pageIndex: 0 })).toBeNull();
    expect(await captureSentenceContext(fakeReader(items), "", { pageIndex: 0 })).toBeNull();
    expect(await captureSentenceContext(fakeReader(items), "word", null)).toBeNull();
    expect(await captureSentenceContext(fakeReader(items), "word", { pageIndex: -1 })).toBeNull();
    expect(
      await captureSentenceContext(fakeReader(items), "resonance", { pageIndex: 9 }),
    ).toBeNull();
  });

  it("resolves null when the word is not on the page (scan-only text)", async () => {
    expect(
      await captureSentenceContext(fakeReader(items), "absent", { pageIndex: 0 }),
    ).toBeNull();
  });

  it("resolves null when getPage rejects", async () => {
    const reader = fakeReader(items);
    reader._internalReader._primaryView._iframeWindow.wrappedJSObject
      .PDFViewerApplication.pdfViewer.pdfDocument.getPage = async () => {
        throw new Error("boom");
      };
    expect(
      await captureSentenceContext(reader, "resonance", { pageIndex: 0 }),
    ).toBeNull();
  });
});
