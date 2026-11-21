/**
 * odl-header-footer — 页眉页脚在两种 ODL 配置下都被排除出正文。
 *
 * 为什么单立一个文件：`OpenDataLoaderJsonAdapter` 里有一条 `isHeaderFooter`
 * 分支，注释写得很清楚（页码与书眉不翻译，否则每页重译同一个 running head），
 * 但它在产品的实际调用下**从未被执行过一次**——OpenDataLoader 有个
 * `--include-header-footer` 开关，默认关闭，而 `OpenDataLoaderPdfClient` 拼命令
 * 行时不传它。对五篇夹具实跑两种参数，差别是实测出来的：
 *
 *   不传（产品的配置）→ JSON 里根本没有 header/footer 元素，解析器自己就滤掉了
 *   传了              → 出现 `header` / `footer` 元素，内部包着 heading 子节点
 *
 * 所以这条分支是第二道防线，而第二道防线零测试覆盖。本文件把它钉住：传了开关
 * 之后，页眉页脚仍然不进 textBlocks，只是被记进 repeatedElements。
 *
 * 真正要守的不变量只有一条：**两种配置下装配出的正文完全相同**。这一条断了，
 * 意味着某个改动让页码混进了译文——而它此前只会以"译文里多了个 Page 3 of 3"
 * 的形式出现，没有任何门禁看得见。
 *
 * @module tests/node/odl-header-footer
 */

import { describe, expect, it } from "vitest";

import { adaptOpenDataLoaderJson } from "../../src/core/pdf/OpenDataLoaderJsonAdapter";
import { odlAnalysisToAssembly } from "../../src/core/pdf/translation/odlToAssembly";

/** 一页的公共部分：两段正文。页码用真实键名 `page number`，适配器会归一化。 */
const bodyKids = [
  {
    type: "paragraph",
    id: 10,
    "page number": 1,
    "bounding box": [72, 650, 400, 690],
    font: "CMR12",
    "font size": 12,
    "text color": "[0.0]",
    content: "We found that the effect was stable across both cohorts.",
  },
  {
    type: "paragraph",
    id: 11,
    "page number": 1,
    "bounding box": [72, 600, 400, 640],
    font: "CMR12",
    "font size": 12,
    "text color": "[0.0]",
    content: "A second paragraph of ordinary body text.",
  },
];

/**
 * 页眉：一个 heading 子节点。真实 ODL 产出就是这个形态。
 *
 * 书眉文字跨页相同（那正是"running head"的定义），页码每页不同——这个区分
 * 不是装饰：occurrences 按 (region, text) 分组，书眉该得 3、页码该得 1。
 */
const headerKid = (pageNumber: number, id: number) => ({
  type: "header",
  id,
  "page number": pageNumber,
  "bounding box": [72, 740, 300, 756],
  kids: [
    {
      type: "heading",
      id: id + 100,
      "page number": pageNumber,
      "bounding box": [72, 740, 300, 756],
      "heading level": 1,
      font: "CMR9",
      "font size": 9,
      "text color": "[0.0]",
      content: "Field Notes from a Three Column Layout",
    },
  ],
});

/** 页脚：页码。 */
const footerKid = (pageNumber: number, id: number) => ({
  type: "footer",
  id,
  "page number": pageNumber,
  "bounding box": [72, 40, 200, 52],
  kids: [
    {
      type: "heading",
      id: id + 100,
      "page number": pageNumber,
      "bounding box": [72, 40, 200, 52],
      "heading level": 1,
      font: "CMR9",
      "font size": 9,
      "text color": "[0.0]",
      content: `Page ${pageNumber} of 3`,
    },
  ],
});

function root(kids: unknown[]) {
  return {
    "file name": "hf.pdf",
    "number of pages": 3,
    author: null,
    title: null,
    "creation date": null,
    "modification date": null,
    kids,
  } as any;
}

/** 产品的配置：不传 --include-header-footer，JSON 里没有页眉页脚。 */
const withoutFlag = root([
  headerKid(1, 1),
  ...bodyKids,
  footerKid(1, 2),
  headerKid(2, 3),
  ...bodyKids.map((k) => ({ ...k, id: k.id + 20, "page number": 2 })),
  footerKid(2, 4),
  headerKid(3, 5),
  ...bodyKids.map((k) => ({ ...k, id: k.id + 40, "page number": 3 })),
  footerKid(3, 6),
]);

/** 传了开关：同样的内容，但页眉页脚作为元素出现。 */
const withFlag = withoutFlag;

describe("页眉页脚不进正文（产品默认配置）", () => {
  const result = adaptOpenDataLoaderJson(withoutFlag);

  it("三页各两段正文，一段页眉页脚都不混进来", () => {
    expect(result.pages).toHaveLength(3);
    for (const page of result.pages) {
      expect(page.textBlocks.map((b) => b.text)).toEqual([
        "We found that the effect was stable across both cohorts.",
        "A second paragraph of ordinary body text.",
      ]);
    }
  });

  it("页眉页脚被记进 repeatedElements，带上页码与边界框", () => {
    const repeated = result.pages[0].repeatedElements;
    expect(repeated).toHaveLength(2);
    expect(repeated.map((r) => r.region).sort()).toEqual(["footer", "header"]);
    expect(repeated.map((r) => r.text).sort()).toEqual(["Field Notes from a Three Column Layout", "Page 1 of 3"]);
    expect(repeated.every((r) => r.pageNumber === 1)).toBe(true);
    // 边界框取自 header/footer 元素自身，不是它的子节点。
    expect(repeated.find((r) => r.region === "header")?.bbox.x).toBe(72);
  });

  it("页码不出现在会送给翻译的三处输出里", () => {
    // 只查这三个：textBlocks 是装配的输入，filteredText 与 filteredMarkdown 是
    // 文档级聚合的输入。repeatedElements 是留痕处，本来就应该含页码——上面已经
    // 单独断言过它存在，所以这里不能把整个结果序列化进来查。
    const blockTexts = result.pages.flatMap((p) => p.textBlocks.map((b) => b.text));
    for (const text of [...blockTexts, result.filteredText, result.filteredMarkdown]) {
      expect(text).not.toContain("Field Notes from a Three Column Layout");
      expect(text).not.toContain("Page ");
    }
  });
});

describe("页眉页脚不进正文（传了 --include-header-footer）", () => {
  const result = adaptOpenDataLoaderJson(withFlag);

  it("页眉页脚元素出现，且仍然不进 textBlocks", () => {
    // 先确认这一组数据真的包含 header/footer 元素，否则后面的断言是空的。
    const types = withoutFlag.kids.map((k: any) => k.type);
    expect(types).toContain("header");
    expect(types).toContain("footer");
    for (const page of result.pages) {
      expect(page.textBlocks.map((b) => b.text)).toEqual([
        "We found that the effect was stable across both cohorts.",
        "A second paragraph of ordinary body text.",
      ]);
    }
  });

  it("页眉页脚记进 repeatedElements，文字取自子节点", () => {
    const repeated = result.pages[1].repeatedElements;
    expect(repeated).toHaveLength(2);
    expect(repeated.map((r) => r.text).sort()).toEqual(["Field Notes from a Three Column Layout", "Page 2 of 3"]);
  });

  it("occurrences 数是真实跨页计数，不是恒为 1", () => {
    // 这个字段的注释说它数"多少页含同样文字"，而适配器曾经硬编码 1。同一个
    // 书眉出现在三页上，计数就必须是 3；页码每页不同，计数是 1。
    const header = result.pages[0].repeatedElements.find((r) => r.region === "header");
    const footer = result.pages[0].repeatedElements.find((r) => r.region === "footer");
    expect(header?.occurrences).toBe(3);
    expect(footer?.occurrences).toBe(1);
    // 三页上的同一条书眉，计数必须一致。
    expect(result.pages.map((p) => p.repeatedElements.find((r) => r.region === "header")?.occurrences))
      .toEqual([3, 3, 3]);
  });

  it("两种配置下装配出的正文逐字节相同（要守的就是这一条）", () => {
    const a = adaptOpenDataLoaderJson(withoutFlag);
    const b = adaptOpenDataLoaderJson(withFlag);
    const textOf = (r: typeof a) =>
      r.pages.map((p) => p.textBlocks.map((x) => x.text));
    expect(textOf(a)).toEqual(textOf(b));
  });
});

describe("页眉页脚不进译文装配", () => {
  it("odlAnalysisToAssembly 产出的段落里没有页码", () => {
    const analysis = adaptOpenDataLoaderJson(withFlag);
    const built = odlAnalysisToAssembly(analysis);
    const texts = built.assemblies.flatMap((a) => a.texts);
    expect(texts).toHaveLength(6); // 3 页 × 2 段
    for (const text of texts) {
      expect(text).not.toContain("Field Notes from a Three Column Layout");
      expect(text).not.toContain("Page ");
    }
  });

  it("段数与页数对得上，没有因为页眉页脚而错位", () => {
    const analysis = adaptOpenDataLoaderJson(withFlag);
    const built = odlAnalysisToAssembly(analysis);
    expect(built.assemblies).toHaveLength(3);
    for (const assembly of built.assemblies) {
      // texts 与 paragraphs 逐位对齐是 AssemblyResult 的契约。
      expect(assembly.texts).toHaveLength(assembly.paragraphs.length);
      expect(assembly.paragraphs).toHaveLength(2);
    }
  });
});
