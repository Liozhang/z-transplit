/**
 * Word-cards tab pure helper tests (filterCards / sortCards / cardDate) —
 * no DOM, no Zotero: the helpers are exported exactly so these stay trivial.
 */
import { describe, it, expect } from "vitest";
import {
  filterCards,
  sortCards,
  cardDate,
} from "../../../src/ui/wordCardsTab";
import type { WordCardRecord } from "../../../src/core/wordcards/wordCardStore";

function record(
  word: string,
  key = word,
  updatedAt = 0,
  latest?: { meanings: string[]; examples?: Array<{ text: string; translation: string }> },
): WordCardRecord {
  return {
    v: 1,
    key,
    word,
    createdAt: updatedAt,
    updatedAt,
    lookups: 1,
    latest: {
      word,
      senses: (latest?.meanings ?? ["义"]).map((meaning) => ({ meaning })),
      examples: latest?.examples,
      source: "youdao",
    },
    history: [],
  };
}

const NOW = 1_700_000_000_000;

describe("filterCards", () => {
  const records = [
    record("resonance", "a", NOW, { meanings: ["共鸣；共振"] }),
    record("大学", "b", NOW - 1, { meanings: ["university"] }),
    record("capture", "c", NOW - 2, {
      meanings: ["捕获"],
      examples: [{ text: "screen capture", translation: "屏幕捕获" }],
    }),
  ];

  it("empty query returns everything (in input order)", () => {
    expect(filterCards(records, "").map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(filterCards(records, "   ").length).toBe(3);
  });

  it("matches the word case-insensitively", () => {
    expect(filterCards(records, "RESON").map((r) => r.key)).toEqual(["a"]);
  });

  it("matches sense meanings", () => {
    expect(filterCards(records, "university").map((r) => r.key)).toEqual(["b"]);
    expect(filterCards(records, "捕获").map((r) => r.key)).toEqual(["c"]);
  });

  it("matches card-level example texts and translations", () => {
    expect(filterCards(records, "screen").map((r) => r.key)).toEqual(["c"]);
  });

  it("returns nothing for a miss", () => {
    expect(filterCards(records, "zzz")).toEqual([]);
  });
});

describe("sortCards", () => {
  const records = [
    record("beta", "b", NOW - 1),
    record("alpha", "a", NOW),
    record("gamma", "c", NOW - 2),
  ];

  it("recent sorts by updatedAt descending without mutating the input", () => {
    const sorted = sortCards(records, "recent");
    expect(sorted.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(records.map((r) => r.key)).toEqual(["b", "a", "c"]);
  });

  it("alpha sorts by word via localeCompare", () => {
    expect(sortCards(records, "alpha").map((r) => r.word)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("cardDate", () => {
  it("formats a timestamp and tolerates junk", () => {
    expect(cardDate(NOW)).not.toBe("");
    expect(cardDate(0)).toBe("");
    expect(cardDate(Number.NaN)).toBe("");
  });
});
