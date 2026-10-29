/**
 * 术语表契约（glossary.ts）。
 *
 * 几条硬约束：
 *   1. 宽松解析（parseGlossary）与严格校验（validateGlossary）分离——解析层
 *      服务注入（跳过坏行），校验层服务面板（坏行整体拒绝）；
 *   2. 分隔符兼容 =、全角冒号、半角冒号，值两侧空白修剪，同源术语最后一个
 *      值生效；
 *   3. 条目上限 200；空术语表不得产生提示块（追加必须是纯无操作）。
 */
import { describe, expect, it } from "vitest";

import {
  GLOSSARY_MAX_ENTRIES,
  appendGlossary,
  glossaryPromptBlock,
  parseGlossary,
  splitGlossaryLine,
  validateGlossary,
} from "../../../../src/core/translation/glossary";

describe("splitGlossaryLine — 行切分", () => {
  it("三种分隔符都能成对，两侧空白修剪", () => {
    expect(splitGlossaryLine("transformer=变换器")).toEqual({
      source: "transformer",
      target: "变换器",
    });
    expect(splitGlossaryLine("transformer：变换器")).toEqual({
      source: "transformer",
      target: "变换器",
    });
    expect(splitGlossaryLine("transformer: 变换器")).toEqual({
      source: "transformer",
      target: "变换器",
    });
    expect(splitGlossaryLine("  transformer = 变换器  ")).toEqual({
      source: "transformer",
      target: "变换器",
    });
  });

  it("缺分隔符、空侧、空行都返回 null", () => {
    expect(splitGlossaryLine("no separator here")).toBeNull();
    expect(splitGlossaryLine("= empty-source")).toBeNull();
    expect(splitGlossaryLine("empty-target= ")).toBeNull();
    expect(splitGlossaryLine("   ")).toBeNull();
    expect(splitGlossaryLine("")).toBeNull();
  });
});

describe("parseGlossary — 宽松解析（注入层）", () => {
  it("坏行跳过，合法行保留", () => {
    expect(parseGlossary("transformer=变换器\nbroken line")).toEqual([
      { source: "transformer", target: "变换器" },
    ]);
  });

  it("同一术语重复时最后一个值生效", () => {
    expect(parseGlossary("LLM=大模型\nLLM=语言模型")).toEqual([
      { source: "LLM", target: "语言模型" },
    ]);
  });

  it("空输入与非字符串输入返回空数组", () => {
    expect(parseGlossary("")).toEqual([]);
    expect(parseGlossary(undefined as any)).toEqual([]);
  });

  it("条目数到达上限即停止接收", () => {
    const raw = Array.from(
      { length: GLOSSARY_MAX_ENTRIES + 10 },
      (_, i) => `term${i}=译${i}`,
    ).join("\n");
    const parsed = parseGlossary(raw);
    expect(parsed).toHaveLength(GLOSSARY_MAX_ENTRIES);
    expect(parsed[0]).toEqual({ source: "term0", target: "译0" });
  });
});

describe("validateGlossary — 严格校验（面板层）", () => {
  it("合法：空串、纯空白、多行成对", () => {
    expect(validateGlossary("")).toEqual({ ok: true });
    expect(validateGlossary("  \n ")).toEqual({ ok: true });
    expect(validateGlossary("a=1\nb：2\nc: 3")).toEqual({ ok: true });
  });

  it("任一坏行整体拒绝", () => {
    expect(validateGlossary("a=1\nbroken")).toEqual({
      ok: false,
      reason: "bad-line",
    });
    expect(validateGlossary("a=1\n=empty")).toEqual({
      ok: false,
      reason: "bad-line",
    });
  });

  it("超过 200 条拒绝并给出原因", () => {
    const raw = Array.from({ length: GLOSSARY_MAX_ENTRIES + 1 }, (_, i) => `t${i}=译${i}`).join("\n");
    expect(validateGlossary(raw)).toEqual({ ok: false, reason: "too-many" });
  });
});

describe("glossaryPromptBlock / appendGlossary — 提示注入", () => {
  it("空术语表不产生块，追加是无操作", () => {
    expect(glossaryPromptBlock([])).toBeNull();
    const base = "translate this.";
    expect(appendGlossary(base, [])).toBe(base);
  });

  it("块里逐条列出术语并带约束语", () => {
    const block = glossaryPromptBlock([
      { source: "transformer", target: "变换器" },
      { source: "embedding", target: "嵌入" },
    ])!;
    expect(block).toContain("- transformer = 变换器");
    expect(block).toContain("- embedding = 嵌入");
    expect(block).toContain("GLOSSARY");
  });

  it("appendGlossary 把块接在基础提示之后", () => {
    const out = appendGlossary("BASE", [
      { source: "a", target: "甲" },
    ]);
    expect(out.startsWith("BASE\n\n")).toBe(true);
    expect(out).toContain("- a = 甲");
  });
});
