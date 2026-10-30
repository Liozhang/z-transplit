/**
 * Word card store tests (wordCardStore.ts) — Node environment with the IOUtils
 * shim over node:fs and an injected store directory, mirroring
 * translationCache.spec.ts.
 *
 * The store keeps an in-memory index over the disk files; re-setting the test
 * directory invalidates that index, which doubles as a restart simulation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setWordCardDirForTests,
  setWordCardClockForTests,
  upsertWordCard,
  getWordCard,
  listWordCards,
  recentWordCards,
  recentWordCardsForItem,
  deleteWordCard,
  clearAllWordCards,
} from "../../src/core/wordcards/wordCardStore";
import { installIOUTilsShim, uninstallIOUTilsShim } from "./helpers/ioutils-shim";

/** Minimal valid card content (passes the shared zod schema). */
function card(word: string, meaning: string) {
  return {
    word,
    phonetic: "/tɛst/",
    senses: [{ pos: "n.", meaning }],
    source: "youdao" as const,
  };
}

let tmp: string;
/** Monotonic test clock: consecutive upserts land in the same millisecond on
 *  Linux CI, so ordering assertions must not depend on Date.now() granularity. */
let tick: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ztransplit-wordcards-"));
  installIOUTilsShim();
  setWordCardDirForTests(tmp);
  tick = 1_700_000_000_000;
  setWordCardClockForTests(() => (tick += 10));
});

afterEach(() => {
  setWordCardClockForTests(null);
  setWordCardDirForTests(null);
  uninstallIOUTilsShim();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("wordCardStore upsert", () => {
  it("merges repeat lookups of the same word into one card", async () => {
    await upsertWordCard({
      word: "Resonance",
      targetLang: "zh-CN",
      content: card("resonance", "共鸣"),
    });
    await upsertWordCard({
      word: "resonance",
      targetLang: "en-US",
      content: card("resonance", "résonance"),
    });
    const record = await getWordCard("  resonance ");
    expect(record).not.toBeNull();
    expect(record!.lookups).toBe(2);
    expect(record!.history).toHaveLength(2);
    expect(record!.history[0].targetLang).toBe("en-US"); // newest first
    expect(record!.latest.senses[0].meaning).toBe("résonance");
    expect(record!.word).toBe("Resonance"); // first-seen display form
  });

  it("folds apostrophe and case variants into one card", async () => {
    await upsertWordCard({ word: "don't", targetLang: "zh-CN", content: card("don't", "不要") });
    await upsertWordCard({ word: "Don’t", targetLang: "zh-CN", content: card("Don’t", "不要") });
    expect((await listWordCards()).length).toBe(1);
  });

  it("caps history at 20 entries while keeping the lookup count honest", async () => {
    for (let i = 0; i < 25; i++) {
      await upsertWordCard({ word: "cap", targetLang: "zh-CN", content: card("cap", `义 ${i}`) });
    }
    const record = await getWordCard("cap");
    expect(record!.lookups).toBe(25);
    expect(record!.history).toHaveLength(20);
    expect(record!.history[0].content.senses[0].meaning).toBe("义 24");
  });

  it("rejects cards that fail the shared content schema", async () => {
    await upsertWordCard({
      word: "bad",
      targetLang: "zh-CN",
      content: { word: "bad", senses: [], source: "mt" } as any,
    });
    expect(await getWordCard("bad")).toBeNull();
  });

  it("records sourceItemID when provided", async () => {
    await upsertWordCard({
      word: "origin",
      targetLang: "zh-CN",
      content: card("origin", "起源"),
      sourceItemID: 42,
    });
    expect((await getWordCard("origin"))!.sourceItemID).toBe(42);
  });
});

describe("wordCardStore listing", () => {
  it("lists most recently updated first and honours recentWordCards(n)", async () => {
    await upsertWordCard({ word: "aaa", targetLang: "zh-CN", content: card("aaa", "甲") });
    await upsertWordCard({ word: "bbb", targetLang: "zh-CN", content: card("bbb", "乙") });
    await upsertWordCard({ word: "ccc", targetLang: "zh-CN", content: card("ccc", "丙") });
    await upsertWordCard({ word: "aaa", targetLang: "zh-CN", content: card("aaa", "甲二") });
    const all = await listWordCards();
    expect(all.map((r) => r.word)).toEqual(["aaa", "ccc", "bbb"]);
    expect((await recentWordCards(2)).map((r) => r.word)).toEqual(["aaa", "ccc"]);
  });

  it("recentWordCardsForItem keeps only the cards whose latest lookup came from the item", async () => {
    await upsertWordCard({ word: "alpha", targetLang: "zh-CN", content: card("alpha", "甲"), sourceItemID: 7 });
    await upsertWordCard({ word: "beta", targetLang: "zh-CN", content: card("beta", "乙"), sourceItemID: 9 });
    await upsertWordCard({ word: "gamma", targetLang: "zh-CN", content: card("gamma", "丙"), sourceItemID: 7 });

    const mine = await recentWordCardsForItem(7, 10);
    expect(mine.map((r) => r.word)).toEqual(["gamma", "alpha"]);
    expect((await recentWordCardsForItem(9, 10)).map((r) => r.word)).toEqual(["beta"]);
    expect(await recentWordCardsForItem(1234, 10)).toEqual([]);

    // n caps the strip just like the global variant.
    expect((await recentWordCardsForItem(7, 1)).map((r) => r.word)).toEqual(["gamma"]);
  });

  it("a card re-looked-up from another item moves to that item (sourceItemID overwrite)", async () => {
    await upsertWordCard({ word: "drift", targetLang: "zh-CN", content: card("drift", "漂移"), sourceItemID: 7 });
    await upsertWordCard({ word: "drift", targetLang: "zh-CN", content: card("drift", "漂移二"), sourceItemID: 9 });
    expect((await recentWordCardsForItem(7, 10)).map((r) => r.word)).toEqual([]);
    expect((await recentWordCardsForItem(9, 10)).map((r) => r.word)).toEqual(["drift"]);
  });
});

describe("wordCardStore persistence", () => {
  it("reloads from disk when the index is invalidated (restart simulation)", async () => {
    await upsertWordCard({
      word: "persist",
      targetLang: "zh-CN",
      content: card("persist", "坚持"),
    });
    setWordCardDirForTests(tmp); // same dir — but the index is dropped
    const record = await getWordCard("persist");
    expect(record).not.toBeNull();
    expect(record!.latest.senses[0].meaning).toBe("坚持");
  });

  it("skips corrupt files on load", async () => {
    await upsertWordCard({ word: "good", targetLang: "zh-CN", content: card("good", "好") });
    await upsertWordCard({ word: "bad", targetLang: "zh-CN", content: card("bad", "坏") });
    const root = path.join(tmp, "ztransplit/word-cards/v1");
    for (const bucket of fs.readdirSync(root)) {
      for (const file of fs.readdirSync(path.join(root, bucket))) {
        const filePath = path.join(root, bucket, file);
        if (fs.readFileSync(filePath, "utf8").includes('"word":"bad"')) {
          fs.writeFileSync(filePath, "{ not json");
        }
      }
    }
    setWordCardDirForTests(tmp); // reload from disk
    const all = await listWordCards();
    expect(all.map((r) => r.word)).toEqual(["good"]);
  });
});

describe("wordCardStore deletion", () => {
  it("deletes one card, then everything", async () => {
    await upsertWordCard({ word: "one", targetLang: "zh-CN", content: card("one", "一") });
    await upsertWordCard({ word: "two", targetLang: "zh-CN", content: card("two", "二") });
    expect(await deleteWordCard("one")).toBe(true);
    expect(await deleteWordCard("one")).toBe(false);
    setWordCardDirForTests(tmp); // reload from disk
    expect((await listWordCards()).map((r) => r.word)).toEqual(["two"]);
    await clearAllWordCards();
    setWordCardDirForTests(tmp);
    expect(await listWordCards()).toEqual([]);
  });
});

describe("wordCardStore without a host", () => {
  it("never throws and keeps serving the in-memory index", async () => {
    uninstallIOUTilsShim();
    await expect(
      upsertWordCard({ word: "bare", targetLang: "zh-CN", content: card("bare", "裸") }),
    ).resolves.toBeUndefined();
    expect((await listWordCards()).map((r) => r.word)).toEqual(["bare"]);
  });
});

describe("wordCardStore contexts", () => {
  function context(sentence: string, itemID = 7, pageIndex = 3) {
    return { sentence, itemID, itemTitle: `Paper ${itemID}`, pageIndex, rects: [[10, 20, 30, 40]], at: 1234 };
  }

  it("stores a context on first lookup and keeps the newest first", async () => {
    await upsertWordCard({
      word: "model", targetLang: "zh-CN", content: card("model", "模型"),
      context: context("The model predicts the peak.", 7, 2),
    });
    await upsertWordCard({
      word: "model", targetLang: "zh-CN", content: card("model", "模型"),
      context: context("A different model appears here.", 9, 5),
    });
    const record = await getWordCard("model");
    expect(record!.contexts).toHaveLength(2);
    expect(record!.contexts![0].sentence).toBe("A different model appears here.");
    expect(record!.contexts![0].itemID).toBe(9);
    expect(record!.contexts![1].sentence).toBe("The model predicts the peak.");
    // Contexts do not inflate the lookup count beyond the real lookups.
    expect(record!.lookups).toBe(2);
  });

  it("dedupes the same sentence from the same item (case/apostrophe folded)", async () => {
    const sentence = "The model predicts the peak.";
    await upsertWordCard({
      word: "model", targetLang: "zh-CN", content: card("model", "模型"),
      context: context(sentence, 7),
    });
    await upsertWordCard({
      word: "model", targetLang: "zh-CN", content: card("model", "模型"),
      context: context("  THE MODEL PREDICTS THE PEAK. ", 7),
    });
    // Same sentence from ANOTHER item still accumulates.
    await upsertWordCard({
      word: "model", targetLang: "zh-CN", content: card("model", "模型"),
      context: context(sentence, 9),
    });
    const record = await getWordCard("model");
    expect(record!.contexts).toHaveLength(2);
    expect(record!.contexts!.map((c) => c.itemID)).toEqual([9, 7]);
  });

  it("caps contexts at 20 entries, newest kept", async () => {
    for (let i = 0; i < 25; i++) {
      await upsertWordCard({
        word: "many", targetLang: "zh-CN", content: card("many", "多"),
        context: context(`Sentence number ${i} is here.`, 7, i),
      });
    }
    const record = await getWordCard("many");
    expect(record!.contexts).toHaveLength(20);
    expect(record!.contexts![0].sentence).toContain("24");
  });

  it("drops malformed contexts instead of storing them", async () => {
    await upsertWordCard({
      word: "guard", targetLang: "zh-CN", content: card("guard", "防护"),
      context: { sentence: "   ", at: 1 } as any,
    });
    await upsertWordCard({
      word: "guard", targetLang: "zh-CN", content: card("guard", "防护"),
      context: "not an object" as any,
    });
    await upsertWordCard({
      word: "guard", targetLang: "zh-CN", content: card("guard", "防护"),
      context: context("A valid sentence survives."),
    });
    const record = await getWordCard("guard");
    expect(record!.contexts).toHaveLength(1);
    expect(record!.contexts![0].sentence).toBe("A valid sentence survives.");
  });

  it("persists contexts across an index reload and accepts old records without them", async () => {
    await upsertWordCard({
      word: "older", targetLang: "zh-CN", content: card("older", "更早"),
      context: context("Written before the field existed."),
    });
    await upsertWordCard({
      word: "legacy", targetLang: "zh-CN", content: card("legacy", "旧格式"),
    });
    // Simulate an old-format record on disk: strip the new field.
    const root = path.join(tmp, "ztransplit/word-cards/v1");
    for (const bucket of fs.readdirSync(root)) {
      for (const file of fs.readdirSync(path.join(root, bucket))) {
        const filePath = path.join(root, bucket, file);
        const raw = fs.readFileSync(filePath, "utf8");
        if (raw.includes('"legacy"')) {
          const parsed = JSON.parse(raw);
          delete parsed.contexts;
          fs.writeFileSync(filePath, JSON.stringify(parsed));
        }
      }
    }
    setWordCardDirForTests(tmp); // restart simulation
    const kept = await getWordCard("older");
    expect(kept!.contexts).toHaveLength(1);
    expect(kept!.contexts![0].sentence).toBe("Written before the field existed.");
    const legacy = await getWordCard("legacy");
    expect(legacy).not.toBeNull();
    expect(legacy!.contexts).toBeUndefined();
  });

  it("sanitizeContexts trims, caps and filters entries defensively", async () => {
    const { sanitizeContexts } = await import("../../src/core/wordcards/wordCardStore");
    const cleaned = sanitizeContexts([
      { sentence: "  padded sentence.  ", at: 5 },
      { sentence: "", at: 6 },
      null,
      "junk",
      { sentence: "no timestamp" }, // at defaults, entry kept
      { sentence: "rects kept", at: 7, rects: [[1, 2, 3, 4], ["bad"] as any] },
      { sentence: "x".repeat(3000), at: 8 },
    ]);
    expect(cleaned).toHaveLength(4);
    expect(cleaned[0].sentence).toBe("padded sentence.");
    expect(cleaned[0].at).toBe(5);
    expect(cleaned[1].at).toBeGreaterThan(0); // defaulted
    expect(cleaned[1].itemID).toBeUndefined();
    expect(cleaned[2].rects).toEqual([[1, 2, 3, 4]]);
    expect(cleaned[3].sentence.length).toBe(1000); // defensive cap
    expect(sanitizeContexts("not an array" as any)).toEqual([]);
  });
});
