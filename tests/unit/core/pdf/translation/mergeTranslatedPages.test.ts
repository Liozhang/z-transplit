/**
 * 页码范围合并契约（mergeTranslatedPages.ts）。
 *
 * 两条产物都保留源文件的全部页面且页序不变，合并因此是纯粹的位置替换：
 * 新一轮翻译的页面接管既有附件的相同位置，其余页面与既有附件逐字一致。
 * 钉死的契约：
 *   1. 替换到位——被选位置出现新文档的页面，未选位置保持旧文档原样，
 *      页数不变；
 *   2. 任何前置条件不满足（页数不一致、越界、空选、坏字节）返回 null 而
 *      不是抛错——调用方据此回退为另存新附件，已有译文绝不暴露在风险里；
 *   3. 存储层胶水：整段合并完成后才写盘，条目对象原样返回；读不到路径
 *      或缺 IOUtils 同样回退 null。
 *
 * 页面内容用页面尺寸做指纹（pdf-lib 的文本流是压缩编码，字节层搜不到），
 * 每页用不同尺寸构造，断言结果页的尺寸序列即可判定替换是否到位。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PDFDocument } from "pdf-lib";

import {
  mergeIntoExistingTranslation,
  mergeTranslatedPages,
} from "../../../../../src/core/pdf/translation/mergeTranslatedPages";
import {
  installIOUTilsShim,
  uninstallIOUTilsShim,
} from "../../../../node/helpers/ioutils-shim";

type Size = [number, number];

async function buildDoc(sizes: Size[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h] of sizes) doc.addPage([w, h]);
  return doc.save();
}

async function pageSizes(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
}

const EXISTING: Size[] = [[200, 300], [220, 310], [240, 320]];
const FRESH: Size[] = [[500, 500], [520, 520], [540, 540]];

describe("mergeTranslatedPages — 按页替换", () => {
  it("替换单页：被选位置换新，其余位置保持旧文档原样", async () => {
    const merged = await mergeTranslatedPages(
      await buildDoc(EXISTING),
      await buildDoc(FRESH),
      [1],
    );
    expect(merged).not.toBeNull();
    expect(await pageSizes(merged!)).toEqual([
      "200x300",
      "520x520",
      "240x320",
    ]);
  });

  it("替换多页与全部页", async () => {
    const merged = await mergeTranslatedPages(
      await buildDoc(EXISTING),
      await buildDoc(FRESH),
      [0, 2],
    );
    expect(await pageSizes(merged!)).toEqual([
      "500x500",
      "220x310",
      "540x540",
    ]);

    const all = await mergeTranslatedPages(
      await buildDoc(EXISTING),
      await buildDoc(FRESH),
      [0, 1, 2],
    );
    expect(await pageSizes(all!)).toEqual([
      "500x500",
      "520x520",
      "540x540",
    ]);
  });

  it("乱序输入按位置对齐：结果位置仍与页码一一对应", async () => {
    const merged = await mergeTranslatedPages(
      await buildDoc(EXISTING),
      await buildDoc(FRESH),
      [2, 0],
    );
    expect(await pageSizes(merged!)).toEqual([
      "500x500",
      "220x310",
      "540x540",
    ]);
  });

  it("重复页码去重：同一位置只替换一次，页数不变", async () => {
    const merged = await mergeTranslatedPages(
      await buildDoc(EXISTING),
      await buildDoc(FRESH),
      [1, 1, 1],
    );
    expect(merged).not.toBeNull();
    expect(await pageSizes(merged!)).toEqual([
      "200x300",
      "520x520",
      "240x320",
    ]);
  });
});

describe("mergeTranslatedPages — 前置条件不满足返回 null", () => {
  it("空选择", async () => {
    expect(
      await mergeTranslatedPages(await buildDoc(EXISTING), await buildDoc(FRESH), []),
    ).toBeNull();
  });

  it("两份文档页数不一致", async () => {
    expect(
      await mergeTranslatedPages(
        await buildDoc(EXISTING),
        await buildDoc([[500, 500]]),
        [0],
      ),
    ).toBeNull();
  });

  it("页码越界（负数或超末页）", async () => {
    expect(
      await mergeTranslatedPages(await buildDoc(EXISTING), await buildDoc(FRESH), [3]),
    ).toBeNull();
    expect(
      await mergeTranslatedPages(await buildDoc(EXISTING), await buildDoc(FRESH), [-1]),
    ).toBeNull();
  });

  it("坏字节（不可解析的既有文档）", async () => {
    expect(
      await mergeTranslatedPages(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]), // "%PDF" + 垃圾
        await buildDoc(FRESH),
        [0],
      ),
    ).toBeNull();
  });
});

describe("mergeIntoExistingTranslation — 存储层胶水", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ztransplit-merge-"));
    filePath = path.join(tmpDir, "Translated_paper.pdf");
    installIOUTilsShim();
  });

  afterEach(() => {
    uninstallIOUTilsShim();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("读旧文件、合并、原地写回，条目对象原样返回", async () => {
    fs.writeFileSync(filePath, await buildDoc(EXISTING));
    const att = { id: 42, getFilePath: () => filePath };

    const result = await mergeIntoExistingTranslation(
      att,
      await buildDoc(FRESH),
      [0],
    );
    expect(result).toBe(att);
    // 磁盘上的文件已被替换为合并结果
    const onDisk = new Uint8Array(fs.readFileSync(filePath));
    expect(await pageSizes(onDisk)).toEqual([
      "500x500",
      "220x310",
      "240x320",
    ]);
  });

  it("读不到路径与缺 IOUtils 都回退 null，不写盘", async () => {
    const att = { id: 1, getFilePath: () => null };
    expect(
      await mergeIntoExistingTranslation(att, await buildDoc(FRESH), [0]),
    ).toBeNull();

    uninstallIOUTilsShim();
    expect(
      await mergeIntoExistingTranslation(
        { id: 2, getFilePath: () => filePath },
        await buildDoc(FRESH),
        [0],
      ),
    ).toBeNull();
  });

  it("页数不一致的既有文件回退 null，原文件保持原样", async () => {
    fs.writeFileSync(filePath, await buildDoc([[1, 1]]));
    const att = { id: 3, getFilePath: () => filePath };

    expect(
      await mergeIntoExistingTranslation(att, await buildDoc(FRESH), [0]),
    ).toBeNull();
    const onDisk = new Uint8Array(fs.readFileSync(filePath));
    expect(await pageSizes(onDisk)).toEqual(["1x1"]);
  });
});
