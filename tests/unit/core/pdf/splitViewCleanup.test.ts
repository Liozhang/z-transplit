/**
 * B15 — 分屏翻译查重（src/core/pdf/splitview/splitViewCleanup.ts#findLatestTranslation）。
 *
 * 行为契约（同 leadero）：同一父条目下优先返回**已有的译文附件**（标题
 * `译文 (...)` / `Translated (...)`），没有译文时回退到最新的 PDF 兄弟附件；
 * 排除当前源 PDF；非 PDF 附件不参与。这是「翻译并分屏」不重复翻译的关键：
 * splitViewFactory 靠它复用已有译文。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findLatestTranslation } from "../../../../src/core/pdf/splitview/splitViewCleanup";
import { createZoteroMock } from "../../../qa/harness/zotero-mock";

interface FakeItem {
  id: number;
  contentType?: string;
  title?: string;
  dateAdded?: string;
  attachments?: number[];
}

function item(f: FakeItem): any {
  return {
    id: f.id,
    attachmentContentType: f.contentType,
    getField: (name: string) => (name === "title" ? f.title ?? "" : ""),
    dateAdded: f.dateAdded,
    getAttachments: () => f.attachments ?? [],
  };
}

describe("B15 findLatestTranslation：译文查重与回退", () => {
  let z: ReturnType<typeof createZoteroMock>;

  beforeEach(() => {
    z = createZoteroMock();
    z.install();
  });

  afterEach(() => {
    z.uninstall();
  });

  it("有译文附件时返回译文（而非源 PDF）——重复翻译被挡住", () => {
    const source = item({ id: 10, contentType: "application/pdf", title: "paper.pdf", dateAdded: "2026-01-01" });
    const translated = item({ id: 11, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-02" });
    const parent = item({ id: 1, attachments: [10, 11] });
    z.items.set(1, parent);
    z.items.set(10, source);
    z.items.set(11, translated);

    const found = findLatestTranslation(1, 10);
    expect(found).not.toBeNull();
    expect(found.id).toBe(11);
  });

  it("没有译文时回退到最新的 PDF 兄弟附件", () => {
    const old = item({ id: 20, contentType: "application/pdf", title: "a.pdf", dateAdded: "2026-01-01" });
    const newer = item({ id: 21, contentType: "application/pdf", title: "b.pdf", dateAdded: "2026-02-01" });
    z.items.set(1, item({ id: 1, attachments: [20, 21] }));
    z.items.set(20, old);
    z.items.set(21, newer);

    const found = findLatestTranslation(1, 999);
    expect(found.id).toBe(21);
  });

  it("Translated (...) 英文标题同样识别为译文", () => {
    const source = item({ id: 30, contentType: "application/pdf", title: "paper.pdf", dateAdded: "2026-01-01" });
    const translated = item({ id: 31, contentType: "application/pdf", title: "Translated (zh-CN)", dateAdded: "2026-01-05" });
    z.items.set(1, item({ id: 1, attachments: [30, 31] }));
    z.items.set(30, source);
    z.items.set(31, translated);

    expect(findLatestTranslation(1, 30).id).toBe(31);
  });

  it("多个译文时取最新（dateAdded 最大）", () => {
    const t1 = item({ id: 41, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-01" });
    const t2 = item({ id: 42, contentType: "application/pdf", title: "译文 (en-US)", dateAdded: "2026-03-01" });
    z.items.set(1, item({ id: 1, attachments: [41, 42] }));
    z.items.set(41, t1);
    z.items.set(42, t2);

    expect(findLatestTranslation(1, 0).id).toBe(42);
  });

  it("非 PDF 附件（快照/笔记）不参与候选", () => {
    const snapshot = item({ id: 50, contentType: "image/png", title: "译文 (zh-CN)", dateAdded: "2026-05-01" });
    const pdf = item({ id: 51, contentType: "application/pdf", title: "paper.pdf", dateAdded: "2026-01-01" });
    z.items.set(1, item({ id: 1, attachments: [50, 51] }));
    z.items.set(50, snapshot);
    z.items.set(51, pdf);

    expect(findLatestTranslation(1, 999).id).toBe(51);
  });

  it("excludeItemID 排除当前源 PDF（只剩译文时仍返回译文）", () => {
    const source = item({ id: 60, contentType: "application/pdf", title: "paper.pdf", dateAdded: "2026-01-01" });
    const translated = item({ id: 61, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-02" });
    z.items.set(1, item({ id: 1, attachments: [60, 61] }));
    z.items.set(60, source);
    z.items.set(61, translated);

    expect(findLatestTranslation(1, 60).id).toBe(61);
  });

  it("父条目不存在 / 无附件 / getAttachments 缺失 → null，不抛", () => {
    z.items.set(1, item({ id: 1, attachments: [] }));
    expect(findLatestTranslation(1, 0)).toBeNull();
    expect(findLatestTranslation(404, 0)).toBeNull();
    z.items.set(2, { id: 2 }); // 没有 getAttachments 方法
    expect(findLatestTranslation(2, 0)).toBeNull();
  });
});
