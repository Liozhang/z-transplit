/**
 * translationStyle（src/core/pdf/sdt/translationStyle.ts）的单元测试：像素解
 * 析、字号派生与上限、颜色解析、对比度下限、派生结果的维度独立性。
 *
 * 对比度期望值按 WCAG 2.x 相对亮度公式手算，因此钉住的是「什么颜色够读」这
 * 条规则本身，而不是某个实现的自洽性。
 */
import { describe, it, expect } from "vitest";
import {
  MIN_CONTRAST_AGAINST_WHITE,
  TRANSLATION_SIZE_CAP_PX,
  contrastRatioAgainstWhite,
  deriveTranslationFontSize,
  deriveTranslationStyle,
  isReadableColor,
  parseColor,
  parsePx,
} from "../../../../../src/core/pdf/sdt/translationStyle";

function rgb(r: number, g: number, b: number, a = 1) {
  return { r, g, b, a };
}

describe("parsePx — 只认像素长度", () => {
  it("整数与小数像素", () => {
    expect(parsePx("16px")).toBe(16);
    expect(parsePx("16.5px")).toBe(16.5);
    expect(parsePx(" 12px ")).toBe(12);
  });

  it("其它单位、关键字与空值返回 null（调用方据此不动字号）", () => {
    expect(parsePx("1em")).toBeNull();
    expect(parsePx("larger")).toBeNull();
    expect(parsePx("")).toBeNull();
    expect(parsePx(undefined)).toBeNull();
    expect(parsePx("16")).toBeNull();
  });
});

describe("deriveTranslationFontSize — 原字号乘比例并设上限", () => {
  it("正文字号按比例收窄", () => {
    expect(deriveTranslationFontSize(20)).toBe("18.4px");
    expect(deriveTranslationFontSize(16)).toBe("14.7px");
  });

  it("超大字号被截到上限，不会变成第二个标题", () => {
    expect(TRANSLATION_SIZE_CAP_PX).toBe(24);
    expect(deriveTranslationFontSize(64)).toBe("24px");
    // 26.1px 会越过上限，因此取上限值本身
    expect(deriveTranslationFontSize(28.4)).toBe("24px");
  });

  it("上限之内的值不被截", () => {
    // 26 × 0.92 = 23.92，四舍五入到一位小数
    expect(deriveTranslationFontSize(26)).toBe("23.9px");
  });

  it("非正数与非有限值返回 null", () => {
    expect(deriveTranslationFontSize(0)).toBeNull();
    expect(deriveTranslationFontSize(-4)).toBeNull();
    expect(deriveTranslationFontSize(Number.NaN)).toBeNull();
  });
});

describe("parseColor — 只认计算样式真会返回的形式", () => {
  it("rgb 与 rgba", () => {
    expect(parseColor("rgb(0, 0, 0)")).toEqual(rgb(0, 0, 0));
    expect(parseColor("rgba(17, 34, 51, 0.5)")).toEqual(rgb(17, 34, 51, 0.5));
    // 现代空格分隔形式
    expect(parseColor("rgb(17 34 51)")).toEqual(rgb(17, 34, 51));
  });

  it("transparent 是透明黑", () => {
    expect(parseColor("transparent")).toEqual(rgb(0, 0, 0, 0));
  });

  it("命名颜色与无法解析的形式返回 null", () => {
    expect(parseColor("red")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });

  it("通道值被夹到 0–255", () => {
    expect(parseColor("rgb(-5, 300, 128)")).toEqual(rgb(0, 255, 128));
  });
});

describe("contrastRatioAgainstWhite — 手算期望值", () => {
  it("黑为最高、白为最低", () => {
    expect(contrastRatioAgainstWhite(rgb(0, 0, 0))).toBeCloseTo(21, 5);
    expect(contrastRatioAgainstWhite(rgb(255, 255, 255))).toBeCloseTo(1, 5);
  });

  it("中灰 #777 低于 4.5（正是「不够读」的那一档）", () => {
    // 119/255 → 相对亮度约 0.1845 → 1.05/0.2345 ≈ 4.477
    expect(contrastRatioAgainstWhite(rgb(119, 119, 119))).toBeCloseTo(4.477, 2);
    expect(contrastRatioAgainstWhite(rgb(119, 119, 119))).toBeLessThan(
      MIN_CONTRAST_AGAINST_WHITE,
    );
  });

  it("#555 高于 4.5", () => {
    expect(contrastRatioAgainstWhite(rgb(85, 85, 85))).toBeGreaterThan(
      MIN_CONTRAST_AGAINST_WHITE,
    );
  });

  it("链接蓝通常够读（真正被挡掉的是浅灰一档）", () => {
    expect(contrastRatioAgainstWhite(rgb(6, 69, 173))).toBeGreaterThan(
      MIN_CONTRAST_AGAINST_WHITE,
    );
  });
});

describe("isReadableColor — 继承颜色的准入", () => {
  it("不透明的深色通过", () => {
    expect(isReadableColor("rgb(0, 0, 0)")).toBe(true);
    expect(isReadableColor("rgb(33, 37, 41)")).toBe(true);
  });

  it("浅灰被挡下：对照层还有一层不透明度，会叠成读不了", () => {
    expect(isReadableColor("rgb(200, 200, 200)")).toBe(false);
    expect(isReadableColor("rgb(119, 119, 119)")).toBe(false);
  });

  it("任何透明度不足一的颜色都被挡下", () => {
    expect(isReadableColor("rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(isReadableColor("transparent")).toBe(false);
  });

  it("解析不了的颜色被挡下（保持继承墨色永远安全）", () => {
    expect(isReadableColor("red")).toBe(false);
    expect(isReadableColor("")).toBe(false);
  });
});

describe("deriveTranslationStyle — 各维度互不牵连", () => {
  it("齐全时全部派生：字号收窄、字重、倾斜、墨色", () => {
    expect(
      deriveTranslationStyle({
        fontSize: "20px",
        fontWeight: "700",
        fontStyle: "italic",
        color: "rgb(20, 20, 20)",
      }),
    ).toEqual({
      fontSize: "18.4px",
      fontWeight: "700",
      fontStyle: "italic",
      color: "rgb(20, 20, 20)",
    });
  });

  it("等于基线值的字重不写（行内声明会压过样式表层）", () => {
    expect(deriveTranslationStyle({ fontWeight: "normal" })).toEqual({});
    expect(deriveTranslationStyle({ fontWeight: "400" })).toEqual({});
  });

  it("颜色不够读只丢颜色，字号照旧派生", () => {
    expect(
      deriveTranslationStyle({
        fontSize: "20px",
        fontWeight: "400",
        color: "rgb(200, 200, 200)",
      }),
    ).toEqual({ fontSize: "18.4px" });
  });

  it("字号不是像素长度只丢字号，其余照旧", () => {
    expect(
      deriveTranslationStyle({ fontSize: "1.2em", fontStyle: "italic" }),
    ).toEqual({ fontStyle: "italic" });
  });

  it("font-style: normal 不写（写了也是基线值）", () => {
    expect(deriveTranslationStyle({ fontStyle: "normal" })).toEqual({});
  });

  it("全部取不到时返回空对象", () => {
    expect(deriveTranslationStyle({})).toEqual({});
  });
});
