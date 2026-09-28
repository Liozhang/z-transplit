/**
 * TextWrapper — CJK 禁則混排行包装的纯逻辑回归
 * （测试补强批：该模块自述「无 pdf-lib 依赖、可独立单测」，本文件钉住这一点）。
 * 宽度测量走回调，测试用「字符数=宽度」的恒等测量。
 *
 * Ported from leadero's tests/unit/core/pdf/textWrapper.test.ts (import path
 * depth unchanged — the port mirrors leadero's src/ layout).
 */
import { describe, it, expect } from "vitest";
import {
  isCJK,
  looksLikeUrlOrToken,
  NO_LINE_START,
  NO_LINE_END,
  wrapTextMixed,
} from "../../../../src/core/pdf/translation/TextWrapper";

const len = (s: string) => [...s].length;

describe("isCJK / looksLikeUrlOrToken", () => {
  it("classifies CJK ideographs, kana, fullwidth punctuation", () => {
    expect(isCJK("中")).toBe(true);
    expect(isCJK("あ")).toBe(true);
    expect(isCJK("。")).toBe(true);
    expect(isCJK("！")).toBe(true); // fullwidth
    expect(isCJK("a")).toBe(false);
    expect(isCJK("1")).toBe(false);
  });

  it("flags URLs and long path tokens, passes plain prose", () => {
    expect(looksLikeUrlOrToken("https://example.com/a/b/c")).toBe(true);
    expect(looksLikeUrlOrToken("doi/10.1109/journal/2026/123")).toBe(true);
    expect(looksLikeUrlOrToken("a/b")).toBe(false); // 太短
    expect(looksLikeUrlOrToken("这是一段没有路径特征的中文句子")).toBe(false);
  });
});

describe("wrapTextMixed", () => {
  it("fast path: text that fits returns a single unchanged line", () => {
    expect(wrapTextMixed("hello", 10, len)).toEqual(["hello"]);
    expect(wrapTextMixed("", 10, len)).toEqual([""]);
  });

  it("wraps CJK text at arbitrary character boundaries", () => {
    // CJK 无空格，任意两字之间都是合法断点
    expect(wrapTextMixed("一二三四五", 2, len)).toEqual(["一二", "三四", "五"]);
  });

  it("kinsoku (避頭點)：closing punctuation never starts a line — it overhangs", () => {
    // 断点落在 "，" 之前时，"，" 被推回上一行（允许轻微溢出）
    const lines = wrapTextMixed("一二，三", 2, len);
    expect(lines).toEqual(["一二，", "三"]);
    for (const line of lines.slice(1)) {
      expect(NO_LINE_START.has(line[0])).toBe(false);
    }
  });

  it("kinsoku (避腳點)：opening bracket never ends a line — it pulls down", () => {
    // "（" 不该停在行尾：拉到下一行与后续字合并
    expect(wrapTextMixed("一（二", 2, len)).toEqual(["一", "（二"]);
    expect(NO_LINE_END.has("（")).toBe(true);
  });

  it("single char wider than maxWidth still makes progress (no infinite loop)", () => {
    expect(wrapTextMixed("一二", 0, len)).toEqual(["一", "二"]);
  });

  it("latin words prefer breaking at spaces over mid-word splits", () => {
    // 宽度容纳 "hello "（含空格）时，断点落在空格处，"world" 整词进第二行
    const lines = wrapTextMixed("hello world", 6, len);
    expect(lines).toEqual(["hello", "world"]);
    // 不产生单字符碎片
    for (const line of lines) expect(line.length).toBeGreaterThan(1);
  });
});
