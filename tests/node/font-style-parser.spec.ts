/**
 * fontStyleParser — 字体名里的粗体/斜体信号与文字颜色字符串。
 *
 * 为什么补这一组：这是全仓最大的「纯函数却零测试」模块。文件头自己写着
 * "Pure functions — safe to unit-test in Node without Zotero/PDF deps"，
 * 而它在产品里决定渲染端选哪个字体变体、用什么填充色——判错了的后果是译文
 * 拿错字重或拿错颜色，肉眼看得见，却没有任何测试守着。
 *
 * 三处实现细节值得单独钉住，都是踩过的坑：
 *
 * 1. **不能给正则加 `/i`。** `/i` 会让字符类也变成大小写不敏感，
 *    `[-A-Z]` 与 `[^a-z]` 会静默连小写一起匹配，边界判定整体失效。所以匹配
 *    用的是显式的大小写交替加代码里的邻居字符检查。测试里 `Blackboard` 与
 *    `Boldface` 两条就是照这个边界写的。
 *
 * 2. **短后缀 token 要左边界，长后缀不要。** `mi`/`it`/`bx` 这类两字符的
 *    要求前一个字符是大写、连字符、数字或开头（否则 `family` 里的 `mi` 会误
 *    命中）；`medi`/`ital` 这类三字符以上的够specific，左侧不设限。测试里
 *    `family`（不命中）与 `NimbusRomNo9L-Medi`（命中）是一对。
 *
 * 3. **颜色有三种量纲混用。** ODL 实际发的是方括号数组形式（`[0.7]`、
 *    `[0.0, 0.0, 1.0]`），而 CSS 的 `rgb()` 与裸三元组用 0–255 或百分比，
 *    0–1 又原样保留。判据是"大于 1 就除以 255"。测试里 255 与 1.0 都给。
 *
 * @module tests/node/font-style-parser
 */

import { describe, expect, it } from "vitest";

import {
  parseFontStyle,
  parseTextColor,
} from "../../src/core/pdf/translation/fontStyleParser";

describe("parseFontStyle — PostScript 字体名", () => {
  it("连字符后缀：-Bold / -Italic / -BoldItalic", () => {
    expect(parseFontStyle("TimesNewRomanPS-BoldMT")).toEqual({ bold: true, italic: false });
    expect(parseFontStyle("Arial-ItalicMT")).toEqual({ bold: false, italic: true });
    expect(parseFontStyle("Arial-BoldItalicMT")).toEqual({ bold: true, italic: true });
  });

  it("无样式标记的普通字体名", () => {
    expect(parseFontStyle("Helvetica")).toEqual({ bold: false, italic: false });
    expect(parseFontStyle("TimesNewRomanPSMT")).toEqual({ bold: false, italic: false });
    expect(parseFontStyle("CMSY10")).toEqual({ bold: false, italic: false });
  });

  it("空值与 null 走默认，不抛错", () => {
    expect(parseFontStyle("")).toEqual({ bold: false, italic: false });
    expect(parseFontStyle(undefined)).toEqual({ bold: false, italic: false });
    expect(parseFontStyle(null)).toEqual({ bold: false, italic: false });
  });

  it("Blackboard 与 Boldface 不算粗体（右边界必须是非小写）", () => {
    // 这是不加 /i 的原因：边界判定要靠邻居字符，而 /i 会让字符类连小写一起
    // 匹配，把这两个反例整个判错。
    expect(parseFontStyle("Blackboard").bold).toBe(false);
    expect(parseFontStyle("Boldface").bold).toBe(false);
    // 对照：同一个 token 出现在合法边界上就算。
    expect(parseFontStyle("Black").bold).toBe(true);
    expect(parseFontStyle("BoldMT").bold).toBe(true);
  });

  it("capitalist 不算斜体（ital 后面跟着小写 ist）", () => {
    expect(parseFontStyle("capitalist").italic).toBe(false);
    // 对照：italic 作为完整词算。
    expect(parseFontStyle("Italic").italic).toBe(true);
  });

  it("family 不算粗体（两字符短后缀 mi 要求左侧是非小写）", () => {
    expect(parseFontStyle("family").bold).toBe(false);
    // 对照：CMBX10 里的 bx 左侧是大写 M。
    expect(parseFontStyle("CMBX10").bold).toBe(true);
  });

  it("Nimbus 的 Medi / ReguItal 后缀", () => {
    // 真实字体名：-Medi 表示 Medium 字重，-ReguItal 表示 Regular Italic。
    expect(parseFontStyle("NimbusRomNo9L-Medi")).toEqual({ bold: true, italic: false });
    expect(parseFontStyle("NimbusRomNo9L-ReguItal")).toEqual({ bold: false, italic: true });
  });

  it("Computer Modern 的缩写：CMBX / CMMI / CMTI", () => {
    expect(parseFontStyle("CMBX10")).toEqual({ bold: true, italic: false });
    expect(parseFontStyle("CMMI10")).toEqual({ bold: false, italic: true });
    expect(parseFontStyle("CMTI10")).toEqual({ bold: false, italic: true });
  });

  it("Bold 与 Italic 直接相连（无连字符无大小写接缝）也能两个都认出来", () => {
    // hasConcat 那条支路：第二个 token 的左邻居是第一个 token 的结尾小写字母，
    // 严格匹配会以"非边界"为由拒绝。
    const style = parseFontStyle("Foo-Bolditalic");
    expect(style.bold).toBe(true);
    expect(style.italic).toBe(true);
  });

  it("粗体词与斜体词互换顺序同样两个都认", () => {
    const style = parseFontStyle("Foo-ItalicBold");
    expect(style.bold).toBe(true);
    expect(style.italic).toBe(true);
  });
});

describe("parseTextColor — 颜色字符串", () => {
  it("ODL 实际发的方括号数组形式", () => {
    // 一个分量是灰度，三个分量是 RGB。这是 ODL `text color` 字段的真实形态。
    expect(parseTextColor("[0.7]")).toEqual({ r: 0.7, g: 0.7, b: 0.7 });
    expect(parseTextColor("[0.0]")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseTextColor("[0.0, 0.0, 1.0]")).toEqual({ r: 0, g: 0, b: 1 });
    expect(parseTextColor("[0.7, 0.0, 0.0]")).toEqual({ r: 0.7, g: 0, b: 0 });
  });

  it("CSS 十六进制：#RGB 与 #RRGGBB", () => {
    expect(parseTextColor("#FF0000")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("#F00")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("#0000FF")).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("rgb()/rgba() 函数形式", () => {
    expect(parseTextColor("rgb(0,0,255)")).toEqual({ r: 0, g: 0, b: 1 });
    expect(parseTextColor("rgba(255, 0, 0, 1)")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("rgb(100%, 0%, 0%)")).toEqual({ r: 1, g: 0, b: 0 });
  });

  it("裸三元组，三种量纲各一例", () => {
    expect(parseTextColor("0.8,0.2,0.1")).toEqual({ r: 0.8, g: 0.2, b: 0.1 });
    expect(parseTextColor("255,0,0")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("100%,0%,0%")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("0 0 1")).toEqual({ r: 0, g: 0, b: 1 });
  });

  it("CSS 命名颜色", () => {
    expect(parseTextColor("red")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseTextColor("blue")).toEqual({ r: 0, g: 0, b: 1 });
    expect(parseTextColor("white")).toEqual({ r: 1, g: 1, b: 1 });
    // 大小写不敏感。
    expect(parseTextColor("RED")).toEqual({ r: 1, g: 0, b: 0 });
  });

  it("空值与无法解析的输入返回 null，调用方据此退回黑色", () => {
    expect(parseTextColor("")).toBeNull();
    expect(parseTextColor(undefined)).toBeNull();
    expect(parseTextColor(null)).toBeNull();
    expect(parseTextColor("   ")).toBeNull();
    expect(parseTextColor("notacolor")).toBeNull();
    expect(parseTextColor("#GGG")).toBeNull();
    // 分量数不足的三元组。
    expect(parseTextColor("1,0")).toBeNull();
    // 方括号里只有两个分量。
    expect(parseTextColor("[0.1, 0.2]")).toBeNull();
  });

  it("超出 0–1 但不超过 255 的值按 0–1 量纲原样保留", () => {
    // 判据是"大于 1 就除以 255"，所以 1.0 与 255 是两个不同的量纲端点。
    expect(parseTextColor("1,1,1")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseTextColor("255,255,255")).toEqual({ r: 1, g: 1, b: 1 });
  });
});
