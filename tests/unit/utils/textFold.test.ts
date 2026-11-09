/**
 * 共享折叠工具（utils/textFold.ts）的单元测试。
 *
 * 这个折叠从 wordcards/sentenceContext.ts 的 normalizeForMatch 原样迁来，
 * 行为由 sentenceContext.test.ts 的三条既有断言先锁过一遍；这里补一条
 * 自己的钉子，防止迁移后有人改语义时只通过一处测试。
 *
 * 锁定的契约：小写、连字展开（ﬁ→fi、ﬃ→ffi）、撇号统一（’→'）、连续
 * 空白折叠为单空格、去首尾空白。折叠只用于包含判断，绝不做下标数学。
 */
import { describe, expect, it } from "vitest";
import { foldForMatch } from "../../../src/utils/textFold";

describe("foldForMatch — 共享匹配折叠", () => {
  it("大小写折叠", () => {
    expect(foldForMatch("Don’t STOP")).toBe("don't stop");
  });

  it("连字展开，eﬃcient 仍能匹配 efficient", () => {
    expect(foldForMatch("eﬃcient")).toContain("efficient");
    expect(foldForMatch("ﬁgure ﬂow")).toBe("figure flow");
  });

  it("撇号统一为半角", () => {
    expect(foldForMatch("it’s Zotero’s")).toBe("it's zotero's");
  });

  it("连续空白折叠为单空格并去首尾", () => {
    expect(foldForMatch("  a\tb \n c ")).toBe("a b c");
  });

  it("空与非字符串输入不炸", () => {
    expect(foldForMatch("")).toBe("");
    expect(foldForMatch(undefined as any)).toBe("");
  });
});
