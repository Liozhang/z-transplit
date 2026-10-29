/**
 * 页码范围解析契约（pageRange.ts）。
 *
 * 两条硬约束：
 *   1. 任何不合法的输入（坏 token、空段、倒序范围、非正数）整体拒绝——
 *      打错字绝不能悄悄翻译错误的页面；
 *   2. 输出是去重、升序的 1 基页码数组；对文档边界（总页数）的校验由
 *      调用方负责，这里只做词法层。
 */
import { describe, expect, it } from "vitest";

import { parsePageRangeSpec } from "../../../../../src/core/pdf/translation/pageRange";

describe("parsePageRangeSpec — 合法输入", () => {
  it("单页、闭区间、逗号混排", () => {
    expect(parsePageRangeSpec("3")).toEqual([3]);
    expect(parsePageRangeSpec("1-3")).toEqual([1, 2, 3]);
    expect(parsePageRangeSpec("1-3,7,10-12")).toEqual([
      1, 2, 3, 7, 10, 11, 12,
    ]);
  });

  it("空白、全角逗号、顿号与各种破折号都能容忍", () => {
    expect(parsePageRangeSpec(" 1 - 3 , 7 ")).toEqual([1, 2, 3, 7]);
    expect(parsePageRangeSpec("1-3，7")).toEqual([1, 2, 3, 7]);
    expect(parsePageRangeSpec("1-3、7")).toEqual([1, 2, 3, 7]);
    expect(parsePageRangeSpec("1–3")).toEqual([1, 2, 3]); // en dash
    expect(parsePageRangeSpec("1—3")).toEqual([1, 2, 3]); // em dash
    expect(parsePageRangeSpec("1－3")).toEqual([1, 2, 3]); // 全角连字符
  });

  it("去重并升序输出（顺序无关、重叠范围合并）", () => {
    expect(parsePageRangeSpec("7,1-3,2")).toEqual([1, 2, 3, 7]);
    expect(parsePageRangeSpec("1-5,3-4")).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("parsePageRangeSpec — 非法输入整体拒绝", () => {
  it.each([
    ["空串", ""],
    ["纯空白", "   "],
    ["空段", "1,,3"],
    ["尾逗号", "1-3,"],
    ["倒序范围", "5-2"],
    ["零页码", "0"],
    ["负数", "-3"],
    ["非数字 token", "1-3,七"],
    ["半个范围", "1-"],
    ["前缀文字", "页1"],
    ["超大页码", "100001"],
    ["超大范围终点", "1-100001"],
  ])("%s → null", (_label, raw) => {
    expect(parsePageRangeSpec(raw)).toBeNull();
  });
});
