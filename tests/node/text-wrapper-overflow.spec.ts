/**
 * text-wrapper-overflow — 极窄宽度下折行行为的回归。
 *
 * 为什么单立一个文件：`LayoutPreservingRenderer.renderParagraph` 的折行宽度是
 * `Math.max(10, p.x1 - p.x0)`，那个 10 磅地板对窄段落（坐标轴刻度、图例标签，实测
 * 宽 3 到 6 磅）会把折行宽度抬到 10 磅，画出来右溢 3 磅——而渲染端此前只判纵向，
 * 一次都没报过。
 *
 * 曾经想去掉这个地板，实测证明不能去，所以这组测试的立场也随之定下来：**地板保留，
 * 极窄宽度下的折行行为仍要被钉住**。去掉地板的实测后果是——窄段每行只放一个字，
 * 行数暴涨，字号被两条杠杆砍到 4 磅地板、内容被截断，五篇的 boxRecall 全线下降、
 * fontSize.below06Ratio 从 0 涨到 0.208。对读者那是净损害：右溢 3 磅但字号正常且
 * 内容较完整，好过塞进框内但字极小且丢内容。
 *
 * 这组测试因此有两个作用：一是证明极窄宽度下 `wrapTextMixed` 不会死循环、不会丢
 * 字符（将来若改主意去掉地板，它是安全网）；二是记录那次实测的结论——下面的
 * "宽度小于一个字也强制输出"一条，正是去掉地板后窄段会走到的路径。
 *
 * @module tests/node/text-wrapper-overflow
 */

import { describe, expect, it } from "vitest";
import { wrapTextMixed } from "../../src/core/pdf/translation/TextWrapper";

/** 字符数即宽度：每个字符算 1 个单位。 */
const perChar = (s: string) => [...s].length;

describe("wrapTextMixed — 宽度小于一个汉字宽", () => {
  it("每行恰好一个字，不死循环", () => {
    // 宽度 1、每字宽 1：一行放得下一个字，于是每行一字。
    const lines = wrapTextMixed("坐标刻度", 1, perChar);
    expect(lines).toEqual(["坐", "标", "刻", "度"]);
  });

  it("宽度小于一个字也强制输出，行数等于字数", () => {
    // 宽度 0：Case A——当前行为空且单字已超宽，强制输出该字保证进度。
    const lines = wrapTextMixed("刻度", 0, perChar);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe("刻度");
  });

  it("负宽度同样不死循环", () => {
    const lines = wrapTextMixed("ab", -5, perChar);
    expect(lines.join("")).toBe("ab");
  });

  it("空文本返回原样", () => {
    expect(wrapTextMixed("", 0, perChar)).toEqual([""]);
  });

  it("所有行的字符拼回去一个不少", () => {
    const text = "结果支持注意力资源重组的解释";
    for (const width of [0, 1, 2, 3, 5]) {
      const lines = wrapTextMixed(text, width, perChar);
      expect(lines.join(""), `宽度 ${width}`).toBe(text);
    }
  });
});

describe("wrapTextMixed — 禁则字符在极窄宽度下", () => {
  it("句号不出现在行首", () => {
    // 宽度 2：一行两字。句号是 NO_LINE_START，必须粘在前一行。
    const lines = wrapTextMixed("内容。结束", 2, perChar);
    for (const line of lines) {
      expect(line.startsWith("。")).toBe(false);
    }
    expect(lines.join("")).toBe("内容。结束");
  });

  it("开括号不出现在行尾", () => {
    const lines = wrapTextMixed("参数（取值）表", 2, perChar);
    for (const line of lines) {
      expect(line.endsWith("（")).toBe(false);
    }
    expect(lines.join("")).toBe("参数（取值）表");
  });
});

describe("wrapTextMixed — 宽度测量走回调", () => {
  it("整段能放下时走快速路径，原样返回", () => {
    expect(wrapTextMixed("短文本", 100, perChar)).toEqual(["短文本"]);
  });

  it("回调被反复调用且结果一致", () => {
    let calls = 0;
    const counting = (s: string) => {
      calls += 1;
      return [...s].length;
    };
    const lines = wrapTextMixed("一二三四五", 2, counting);
    expect(calls).toBeGreaterThan(0);
    expect(lines.join("")).toBe("一二三四五");
  });

  it("不同宽度的折行结果都满足：每行宽度不超过宽度上限，除非单字超宽", () => {
    for (const width of [1, 2, 4, 8]) {
      const lines = wrapTextMixed("这是用于测试折行宽度的一段中文内容", width, perChar);
      for (const line of lines) {
        const w = [...line].length;
        // 要么放得下，要么是单字超宽被迫成行。
        expect(w <= width || w === 1, `宽度 ${width} 行 ${line} 宽 ${w}`).toBe(true);
      }
    }
  });
});
