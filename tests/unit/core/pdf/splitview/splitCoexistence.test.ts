/**
 * 分屏共存看护（splitViewCleanup 查重 / 关系回退）。
 *
 * 真实文献库里不可能只有「一个源 PDF + 一个译文」：同一条目下常有快照、
 * 笔记、讲义等其他附件，库里同时存在多篇文献各自的译文，顶层附件（无父
 * 条目）靠 dc:relation 回退。看护钉住四条共存契约：
 *
 *   1. 同父条目噪声：快照（text/html）、无类型笔记、无关 PDF 都不参与
 *      候选；新旧两个译文并存时取最新（dateAdded）；
 *   2. 跨条目隔离：文献 A 的兄弟扫描永远不返回文献 B 的译文，哪怕 B 的
 *      译文更新；
 *   3. 关系回退只跟随本条目的 dc:relation，指向快照或无关 PDF 的关系
 *      被过滤，多条关系取最新的译文；
 *   4. 复用入口的组合顺序：先兄弟扫描，后关系回退，两路都空返回 null。
 *
 * 已有覆盖（splitViewCleanup.test.ts）钉住单条目基本形状；本文件把
 * 「多文献多附件同库共存」这一真实形态钉住。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findLatestTranslation,
  findTranslationByRelation,
  findExistingTranslation,
} from "../../../../../src/core/pdf/splitview/splitViewCleanup";
import { createZoteroMock } from "../../../../qa/harness/zotero-mock";

interface FakeItem {
  id: number;
  contentType?: string;
  title?: string;
  dateAdded?: string;
  attachments?: number[];
  relations?: Record<string, unknown>;
}

function item(f: FakeItem): any {
  return {
    id: f.id,
    attachmentContentType: f.contentType,
    getField: (name: string) => (name === "title" ? f.title ?? "" : ""),
    dateAdded: f.dateAdded,
    getAttachments: () => f.attachments ?? [],
    getRelations: () => f.relations ?? {},
    parentItemID: null,
  };
}

describe("分屏共存：多文献多附件同库时的查重", () => {
  let z: ReturnType<typeof createZoteroMock>;

  beforeEach(() => {
    z = createZoteroMock();
    z.install();
  });

  afterEach(() => {
    z.uninstall();
    delete (globalThis as any).Zotero?.URI;
  });

  it("同父条目噪声共存：只有 PDF 译文参与候选，新旧译文取最新", () => {
    const parent = item({ id: 1, attachments: [10, 11, 12, 13, 14] });
    const source = item({ id: 10, contentType: "application/pdf", title: "paper.pdf", dateAdded: "2026-01-01" });
    const oldTranslation = item({ id: 11, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-02" });
    const snapshot = item({ id: 12, contentType: "text/html", title: "译文 (zh-CN)", dateAdded: "2026-01-09" });
    const unrelatedPdf = item({ id: 13, contentType: "application/pdf", title: "slides.pdf", dateAdded: "2026-01-08" });
    const note = item({ id: 14, title: "译文 (zh-CN)", dateAdded: "2026-01-07" });
    installItems([parent, source, oldTranslation, snapshot, unrelatedPdf, note]);

    // 快照 title 虽像译文但不是 PDF；笔记没有内容类型也没有 PDF 文件名；
    // 无关 PDF 是 PDF 但标题不像译文。译文存在时它们全部出局，新旧译文
    // 取 dateAdded 更新的那篇。
    const best = findLatestTranslation(1, 10);
    expect(best?.id).toBe(11);
  });

  it("跨条目隔离：文献 A 的兄弟扫描不返回文献 B 的译文", () => {
    const parentA = item({ id: 1, attachments: [10, 11] });
    const sourceA = item({ id: 10, contentType: "application/pdf", title: "a.pdf", dateAdded: "2026-01-01" });
    const transA = item({ id: 11, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-02" });
    const parentB = item({ id: 2, attachments: [20, 21] });
    const sourceB = item({ id: 20, contentType: "application/pdf", title: "b.pdf", dateAdded: "2026-01-01" });
    const transB = item({ id: 21, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-06-01" });
    const items = [parentA, sourceA, transA, parentB, sourceB, transB];
    installItems(items);

    expect(findLatestTranslation(1, 10)?.id).toBe(11);
    expect(findLatestTranslation(2, 20)?.id).toBe(21);
  });

  it("关系回退只跟随本条目的关系：噪声关系被过滤，多条关系取最新译文", () => {
    const source = item({
      id: 10,
      contentType: "application/pdf",
      title: "top.pdf",
      dateAdded: "2026-01-01",
      relations: {
        "dc:relation": [
          "zotero://select/library/items/OLDNOTTRANS",
          "zotero://select/library/items/SNAPSHOT",
          "zotero://select/library/items/OLDCAND",
          "zotero://select/library/items/NEWCAND",
        ],
      },
    });
    const oldCand = item({ id: 31, contentType: "application/pdf", title: "Translated (zh-CN)", dateAdded: "2026-01-02" });
    const newCand = item({ id: 32, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-03" });
    const notTrans = item({ id: 33, contentType: "application/pdf", title: "related-paper.pdf", dateAdded: "2026-01-04" });
    const snapshot = item({ id: 34, contentType: "text/html", title: "Translated (zh-CN)", dateAdded: "2026-01-09" });
    installItems([source, oldCand, newCand, notTrans, snapshot]);

    const best = findTranslationByRelation(source);
    expect(best?.id).toBe(32);
  });

  it("复用入口组合顺序：先兄弟扫描，后关系回退，两路皆空返回 null", () => {
    // 顶层附件（无父条目）：兄弟扫描无路可走，关系回退接管
    const topLevel = item({
      id: 10,
      contentType: "application/pdf",
      title: "top.pdf",
      dateAdded: "2026-01-01",
      relations: { "dc:relation": "zotero://select/library/items/CAND" },
    });
    const cand = item({ id: 11, contentType: "application/pdf", title: "译文 (zh-CN)", dateAdded: "2026-01-02" });
    installItems([topLevel, cand]);
    expect(findExistingTranslation(topLevel)?.id).toBe(11);

    // 孤儿源（无父条目、无关系）：返回 null 而不是抛错
    const orphan = item({ id: 40, contentType: "application/pdf", title: "orphan.pdf", dateAdded: "2026-01-01" });
    installItems([orphan]);
    expect(findExistingTranslation(orphan)).toBeNull();
  });
});

/** 把条目装进 Zotero mock，并接好关系回退要用的 Zotero.URI。 */
function installItems(items: any[]): void {
  const Z = (globalThis as any).Zotero;
  const byId = new Map<number, any>(items.map((it) => [it.id, it]));
  Z.Items = { get: (id: number) => byId.get(id) ?? null };
  Z.URI = {
    URItoItemID: (uri: string) => {
      const m = /items\/([A-Z]+)$/.exec(uri);
      if (!m) return null;
      const byTag: Record<string, number> = {
        OLDCAND: 31,
        NEWCAND: 32,
        OLDNOTTRANS: 33,
        SNAPSHOT: 34,
        CAND: 11,
      };
      return byTag[m[1]] ?? null;
    },
  };
}
