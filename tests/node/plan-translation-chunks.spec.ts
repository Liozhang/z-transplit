/**
 * planTranslationChunks — the merged-batch packing contract.
 *
 * Pins the user-facing rule that a batch closes BEFORE the paragraph that
 * would overflow the input budget ("超过预设 token 数则段落减一"): the
 * overflowing paragraph starts the next batch, so an over-budget batch ships
 * one paragraph short instead of exceeding the cap. An oversized single
 * paragraph gets its own batch (it can never be skipped).
 */
import { describe, expect, it } from "vitest";

import { planTranslationChunks } from "../../src/core/pdf/translation/translateParagraphs";

interface FlatTask {
  pageIdx: number;
  paraIdx: number;
  text: string;
}

function task(text: string): FlatTask {
  return { pageIdx: 0, paraIdx: 0, text };
}

describe("planTranslationChunks", () => {
  it("closes a batch before the paragraph that would overflow the input budget", () => {
    const chunks = planTranslationChunks(
      [task("a".repeat(100)), task("b".repeat(100)), task("c".repeat(100))],
      250, // inputBudgetChars — two 100-char paragraphs fit, three do not
      100000, // outputBudgetChars — not the binding constraint here
      1,
    );
    expect(chunks.map((c) => c.map((t) => t.text.length))).toEqual([
      [100, 100],
      [100],
    ]);
  });

  it("gives a single oversized paragraph its own batch", () => {
    const chunks = planTranslationChunks(
      [task("x".repeat(50)), task("y".repeat(900)), task("z".repeat(50))],
      200,
      300, // outputBudgetChars — the 900-char paragraph exceeds it
      1,
    );
    expect(chunks.map((c) => c.map((t) => t.text.length))).toEqual([
      [50],
      [900],
      [50],
    ]);
  });

  it("keeps everything in one batch when the budget is not reached", () => {
    const chunks = planTranslationChunks(
      [task("a".repeat(10)), task("b".repeat(10)), task("c".repeat(10))],
      1000,
      100000,
      1,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });
});
