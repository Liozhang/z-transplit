/**
 * splitSources — the item-tree split entry's source resolution.
 *
 * Regression tests for issue #4's second half: an item holding BOTH an
 * original PDF and its translation used to resolve two sources, so the
 * per-source loop opened two split views stacked in the same tab deck. Only
 * the topmost answered the mouse, which the reporter read as "the divider
 * jumps and behaves erratically". The split path must resolve ONE source per
 * item, and that source must be the original — the translation is the right
 * pane's job (runPipeline → findExistingTranslation).
 *
 * Run: npm run test:unit -- splitSources
 */

import { beforeEach, describe, expect, it } from "vitest";

import { resolveSplitSources } from "../../../src/modules/registerItemTreeMenu";

/** Minimal stand-in for a Zotero PDF attachment. */
function pdf(id: number, title: string, dateAdded: string): any {
  return {
    id,
    dateAdded,
    attachmentContentType: "application/pdf",
    attachmentFilename: `${title}.pdf`,
    getField: (f: string) => (f === "title" ? title : undefined),
    isAttachment: () => true,
  };
}

/** A non-PDF attachment, so the resolver has something to skip. */
function note(id: number, title: string, dateAdded: string): any {
  return {
    id,
    dateAdded,
    attachmentContentType: "text/html",
    attachmentFilename: `${title}.html`,
    getField: (f: string) => (f === "title" ? title : undefined),
    isAttachment: () => true,
  };
}

function parentOf(children: any[]): any {
  return {
    id: 1000 + (children[0]?.id ?? 0),
    isAttachment: () => false,
    getAttachments: () => children.map((c) => c.id),
  };
}

let items: Map<number, any>;

beforeEach(() => {
  items = new Map();
  // translationTitleMatcher() reads the name-template pref; an empty value
  // leaves only the built-in 译文 / Translated pattern active.
  (globalThis as any).Zotero = {
    Prefs: { get: () => "" },
    Items: { get: (id: number) => items.get(id) ?? null },
  };
});

/** A regular item whose children are the given attachments. */
function itemWith(...children: any[]): any {
  const p = parentOf(children);
  for (const c of children) items.set(c.id, c);
  return p;
}

describe("resolveSplitSources", () => {
  it("resolves one source from an item holding an original and its translation", () => {
    // The issue #4 repro: [original, Translated (zh-CN)] must not yield two.
    const out = resolveSplitSources([
      itemWith(pdf(1, "Paper", "2026-01-01"), pdf(2, "Translated (zh-CN) Paper", "2026-02-01")),
    ]);
    expect(out.map((i) => i.id)).toEqual([1]);
  });

  it("picks the original even when the translation was added first", () => {
    const out = resolveSplitSources([
      itemWith(pdf(3, "译文 Paper", "2026-01-01"), pdf(4, "Paper", "2026-03-01")),
    ]);
    expect(out.map((i) => i.id)).toEqual([4]);
  });

  it("picks the newest original when there are several", () => {
    const out = resolveSplitSources([
      itemWith(pdf(5, "Paper draft", "2026-01-01"), pdf(6, "Paper final", "2026-05-01")),
    ]);
    expect(out.map((i) => i.id)).toEqual([6]);
  });

  it("falls back to the newest PDF when the item holds only translations", () => {
    const out = resolveSplitSources([
      itemWith(pdf(7, "Translated (zh-CN) A", "2026-01-01"), pdf(8, "Translated (zh-CN) B", "2026-04-01")),
    ]);
    expect(out.map((i) => i.id)).toEqual([8]);
  });

  it("keeps a directly selected PDF attachment as the source", () => {
    // The user picked a file explicitly — no re-resolution, even when it is a
    // translation. The reader-context path behaves the same way.
    const picked = pdf(9, "Translated (zh-CN) Paper", "2026-02-01");
    items.set(picked.id, picked);
    expect(resolveSplitSources([picked]).map((i) => i.id)).toEqual([9]);
  });

  it("resolves one source per selected item", () => {
    const a = itemWith(
      pdf(10, "A", "2026-01-01"),
      pdf(11, "Translated (zh-CN) A", "2026-02-01"),
    );
    const b = itemWith(
      pdf(12, "B", "2026-01-01"),
      pdf(13, "Translated (zh-CN) B", "2026-02-01"),
    );
    expect(resolveSplitSources([a, b]).map((i) => i.id)).toEqual([10, 12]);
  });

  it("drops items with no PDF and never repeats a source", () => {
    const noPdf = parentOf([]);
    const p = itemWith(pdf(14, "C", "2026-01-01"));
    expect(resolveSplitSources([noPdf, p, p]).map((i) => i.id)).toEqual([14]);
  });

  it("ignores non-PDF attachments", () => {
    const p = parentOf([note(20, "Notes", "2026-01-01"), pdf(22, "D", "2026-01-01")]);
    items.set(20, note(20, "Notes", "2026-01-01"));
    items.set(22, pdf(22, "D", "2026-01-01"));
    expect(resolveSplitSources([p]).map((i) => i.id)).toEqual([22]);
  });

  it("survives a selection of nulls and empty input", () => {
    expect(resolveSplitSources([])).toEqual([]);
    expect(resolveSplitSources([null, undefined] as any)).toEqual([]);
  });
});
