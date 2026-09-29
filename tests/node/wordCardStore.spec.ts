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
  upsertWordCard,
  getWordCard,
  listWordCards,
  recentWordCards,
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ztransplit-wordcards-"));
  installIOUTilsShim();
  setWordCardDirForTests(tmp);
});

afterEach(() => {
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
