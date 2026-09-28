/**
 * sentenceSplitter tests — both implementations (Intl.Segmenter when present
 * in the host, regex fallback) must uphold the same contract: spans aligned to
 * the input, sentence boundaries on terminators, abbreviation guards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { splitSentences, type SentenceSpan } from "../../../src/core/readAloud/sentenceSplitter";

function withSegmenter<T>(enabled: boolean, fn: () => T): T {
  const Intl_ = globalThis as any;
  const original = Intl_.Intl.Segmenter;
  Intl_.Intl.Segmenter = enabled ? original : undefined;
  try {
    return fn();
  } finally {
    Intl_.Intl.Segmenter = original;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sentenceSplitter", () => {
  const text =
    "Reading is a complex activity. It engages many brain regions! " +
    "Does it help memory? Prof. Smith et al. showed that it does.";

  it("splits English text into sentences (segmenter path)", () => {
    withSegmenter(true, () => {
      const spans = splitSentences(text);
      expect(spans.length).toBeGreaterThanOrEqual(3);
      expect(spans[0].text).toContain("Reading is a complex activity");
      // Spans must align with the input string.
      for (const s of spans as SentenceSpan[]) {
        expect(text.slice(s.start, s.end)).toBe(s.text);
      }
    });
  });

  it("splits Chinese text on 。！(segmenter path)", () => {
    withSegmenter(true, () => {
      const spans = splitSentences("这是第一句。这是第二句！这是第三句？");
      expect(spans.length).toBe(3);
    });
  });

  it("regex fallback splits English sentences", () => {
    withSegmenter(false, () => {
      const spans = splitSentences(text);
      expect(spans.length).toBeGreaterThanOrEqual(3);
      for (const s of spans) {
        expect(text.slice(s.start, s.end)).toBe(s.text);
      }
    });
  });

  it("regex fallback does not break on abbreviations (e.g., et al.)", () => {
    withSegmenter(false, () => {
      const spans = splitSentences(
        "Participants read daily, e.g. thirty minutes. They improved, et al. reported. Fig. 1 shows scores.",
      );
      const joined = spans.map((s) => s.text).join("|");
      // "e.g." must not terminate a sentence — the span containing it
      // continues past the abbreviation.
      expect(joined).toContain("e.g. thirty minutes.");
      expect(spans.length).toBe(3);
    });
  });

  it("regex fallback splits Chinese terminators", () => {
    withSegmenter(false, () => {
      const spans = splitSentences("这是第一句。这是第二句！这是第三句？");
      expect(spans.length).toBe(3);
    });
  });

  it("returns [] for empty or whitespace-only input", () => {
    withSegmenter(true, () => expect(splitSentences("   ")).toEqual([]));
    withSegmenter(false, () => expect(splitSentences("")).toEqual([]));
  });

  it("handles a single sentence without a terminator", () => {
    withSegmenter(false, () => {
      const spans = splitSentences("No terminator here");
      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("No terminator here");
    });
  });
});
