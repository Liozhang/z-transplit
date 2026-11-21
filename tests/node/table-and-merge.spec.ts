/**
 * table-and-merge — 表格转 Markdown、SHA-256、逐页 PDF 合并。
 *
 * 为什么把三个不相干的模块放进一个文件：它们各自小（33 / 93 / 42 行）、各自纯，
 * 而且是同一批补测的对象。分三个文件会有三个几乎一样的头部注释，读起来比合在
 * 一起更累。
 *
 * 三者的共同点：都被生产代码调用、都被文档级聚合或分发路径依赖，却都没有直接
 * 测试。`tableToMarkdown` 只有一条注释提到它；`sha256Hex` 是 JRE 与 jar 两个
 * 校验方共用的唯一实现；`mergePageBytes` 是白底模式产出整篇译文的那一步。
 *
 * @module tests/node/table-and-merge
 */

import { describe, expect, it } from "vitest";

import { tableToMarkdown } from "../../src/core/pdf/tableMarkdown";
import { mergePageBytes } from "../../src/core/pdf/translation/pdfMerge";
import { sha256Hex, sha256HexOfString } from "../../src/utils/hash";
import type { PdfTable } from "../../src/core/pdf/PdfIR";

/** 造一张表。行与单元格直接给，列数由各行自己决定。 */
function table(rows: string[][]): PdfTable {
  return {
    rows: rows.map((cells) => ({
      cells: cells.map((text) => ({
        text,
        rowSpan: 1,
        colSpan: 1,
      })),
    })),
    pageNumber: 1,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    confidence: 1,
  } as unknown as PdfTable;
}

describe("tableToMarkdown", () => {
  it("空表返回空串（调用方按无内容跳过）", () => {
    expect(tableToMarkdown(table([]))).toBe("");
  });

  it("标准表格：数据行 + 表头分隔行 + 尾行", () => {
    const md = tableToMarkdown(
      table([
        ["Block", "Activity", "Minutes"],
        ["1", "Choral reading", "10"],
        ["2", "Timed passage", "15"],
      ]),
    );
    expect(md.split("\n")).toEqual([
      "| Block | Activity | Minutes |",
      "| --- | --- | --- |",
      "| 1 | Choral reading | 10 |",
      "| 2 | Timed passage | 15 |",
    ]);
  });

  it("单元格文本去首尾空白，内部空白保留", () => {
    const md = tableToMarkdown(table([["  a  b  ", " c "], ["d", "e"]]));
    expect(md.split("\n")[0]).toBe("| a  b | c |");
  });

  it("只有一行时仍插表头分隔行（那一行被当作表头）", () => {
    const md = tableToMarkdown(table([["only"]]));
    expect(md.split("\n")).toEqual(["| only |", "| --- |"]);
  });

  it("后续行列数少于表头时不补占位（共有的近似，不做猜测性填充）", () => {
    // 这个行为是文件头注释点名的局限：HTML/JSON 不记录单元格的列起点，
    // 跨行单元格无法补占位。测试把它钉住，避免将来有人"顺手"补出错的列。
    const md = tableToMarkdown(table([["a", "b", "c"], ["d"]]));
    expect(md.split("\n")).toEqual(["| a | b | c |", "| --- | --- | --- |", "| d |"]);
  });
});

describe("sha256Hex / sha256HexOfString", () => {
  it("空输入的摘要与公开值一致", async () => {
    // SHA-256("") 的十六进制是公开常量，拿它当锚点：算法选错、编码错、
    // 十六进制补零错，都会在这一条上现形。
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256HexOfString("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("字符串摘要是其 UTF-8 字节的摘要", async () => {
    // 两个入口必须给同一个答案，否则 JRE 校验与 jar 校验会漂移——
    // 这正是 hash.ts 存在的原因（"single implementation so the two callers
    // can never drift"）。
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256HexOfString("abc")).toBe(await sha256Hex(bytes));
    // 公开常量再钉一层。
    expect(await sha256HexOfString("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("非 ASCII 走 UTF-8 编码", async () => {
    // 中文按 UTF-8 是三字节一字。用 TextEncoder 自己算一遍期望值，
    // 不手抄常量——手抄的常量本身可能是错的。
    const expected = await sha256Hex(new TextEncoder().encode("中文"));
    expect(await sha256HexOfString("中文")).toBe(expected);
    expect(expected).not.toBeNull();
  });

  it("摘要长度为 64 且全小写十六进制", async () => {
    const hex = await sha256HexOfString("z-transplit");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("十六进制不足两位的字节要补零", async () => {
    // 找一个能让首字节小于 0x10 的输入。补零漏了的话，长度会是 63 或更短，
    // 而上一条的长度断言正好能抓到——这里再单独钉一次语义。
    for (const input of ["a", "b", "c", "d", "e", "f", "0", "1"]) {
      const hex = await sha256HexOfString(input);
      expect(hex, input).toHaveLength(64);
    }
  });
});

describe("mergePageBytes", () => {
  /** 造一份 n 页的 PDF 字节。 */
  async function makePdf(pages: number, title?: string): Promise<Uint8Array> {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 300]);
    if (title) doc.setTitle(title);
    return doc.save();
  }

  it("按顺序合并多份单页 PDF", async () => {
    const a = await makePdf(1);
    const b = await makePdf(2);
    const c = await makePdf(1);
    const merged = await mergePageBytes([a, b, c]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(4);
  });

  it("空输入不是零页 PDF，而是保存加载后多出一页空白", async () => {
    // 这一条是补测时抓出来的：注释原话说"Empty input → an empty (zero-page)
    // PDF, so callers don't need a special case"，两半都不成立。
    //
    //   PDFDocument.create()            报 0 页
    //   create() → save() → load()      变成 1 页
    //
    // 是 pdf-lib 的往返行为。所以"空进空出"是个假承诺，而调用方
    // （opendataloaderSplitAdapter）其实有一道 pageBytes.length === 0 的显式
    // 特判。把真实行为钉在这里，免得下一个人凭那句注释把特判删掉。
    const merged = await mergePageBytes([]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(1);
    // 那一页是空白的：没有任何内容流可画。
    expect(doc.getPage(0).getWidth()).toBeGreaterThan(0);
  });

  it("零长度条目被跳过，不当成一份坏 PDF", async () => {
    const a = await makePdf(1);
    const merged = await mergePageBytes([new Uint8Array(0), a, new Uint8Array(0)]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(merged);
    expect(doc.getPageCount()).toBe(1);
  });

  it("给了标题就写进合并后文档的 Title 元数据", async () => {
    // 白底路径与叠加路径应当产出同样的文档元数据，否则同一篇译文在两种模式下
    // 的标题不一样。
    const a = await makePdf(1);
    const merged = await mergePageBytes([a], "译文标题");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(merged);
    expect(doc.getTitle()).toBe("译文标题");
  });

  it("不传标题时不写 Title", async () => {
    const a = await makePdf(1, "原始标题");
    const merged = await mergePageBytes([a]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(merged);
    // 各页自己的 Title 元数据不会被带进合并文档。
    expect(doc.getTitle()).toBeUndefined();
  });
});
