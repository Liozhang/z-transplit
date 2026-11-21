/**
 * removal-stats — 删除器"成功但什么都没删"必须被识破。
 *
 * 为什么单立一个文件：`removeOriginalText` 此前只返回 PDF 字节，把 jar 打在
 * stderr 上的那行统计整个丢掉了（只有失败路径才把 stderr 拼进错误消息）。于是
 * 调用方无法区分两种都以退出码 0 收场的情形——而这两种情形的读者后果完全相反。
 *
 * 实测（2026-11-22，reading-brain 与一份手写的表单内文字 PDF）：
 *
 *   | 情形                              | 退出码 | stats                          | 删完的原文残留 |
 *   |-----------------------------------|--------|--------------------------------|----------------|
 *   | 正常区域（18 个框）               | 0      | pagesTouched=2 opsRemoved=1997 | 0.000          |
 *   | 区域文件为空                      | 0      | pagesTouched=0 opsRemoved=0    | 1.000          |
 *   | 文字全在表单（Form XObject）里    | 0      | pagesTouched=0 opsRemoved=0    | 1.000          |
 *
 * 第三行是删除器写进 Java 注释的设计边界：只处理页面内容流（第 0 层），表单与
 * 透明组内部的文字一律保留。那种文档上删除器报"一切正常"，而删完的 PDF 文本层
 * 与原文逐字节相同。此前的管线照单全收，随即把 maskOriginalText 关掉——结果是
 * 原文完整保留、译文叠在原文字上、没有任何遮罩盖住原文。
 *
 * 这两个函数（parseRemovalStats / isRemovalEffective）是把那条边界变成可判定
 * 判断的地方。它们在 OriginalTextRemovalClient 里，而那个文件整体是 host 耦合
 * 的（nsIProcess / IOUtils），所以单独导出这两个纯函数由本文件钉住。
 *
 * @module tests/node/removal-stats
 */

import { describe, expect, it } from "vitest";

import {
  isRemovalEffective,
  parseRemovalStats,
} from "../../src/core/pdf/OriginalTextRemovalClient";

/** 删除器实际打在 stderr 上的那一行，前缀照抄。 */
const doneLine =
  "[ztransplit-remover] done pagesTouched=2 opsRemoved=1997 opsKept=0 "
  + "opsRewritten=0 streamsSkippedInlineImage=0";

describe("parseRemovalStats", () => {
  it("从真实 stderr 行解析出五个数字", () => {
    const stats = parseRemovalStats("[ztransplit-remover] rects=18\n" + doneLine + "\n");
    expect(stats).toEqual({
      pagesTouched: 2,
      opsRemoved: 1997,
      opsKept: 0,
      opsRewritten: 0,
      streamsSkippedInlineImage: 0,
    });
  });

  it("跳过流数一并解析（那是表单与内联图像边界的可见信号）", () => {
    const stats = parseRemovalStats(
      "[ztransplit-remover] done pagesTouched=1 opsRemoved=12 opsKept=3 "
        + "opsRewritten=5 streamsSkippedInlineImage=4\n",
    );
    expect(stats.streamsSkippedInlineImage).toBe(4);
    expect(stats.opsRewritten).toBe(5);
    expect(stats.opsKept).toBe(3);
  });

  it("没有 done 行时返回全 0，不抛错", () => {
    // 全 0 会被 isRemovalEffective 判成"没删掉东西"，调用方回落遮罩——
    // 那是安全的方向。为一段统计把一次本来成功的删除判成失败才是反的。
    expect(parseRemovalStats("")).toEqual({
      pagesTouched: 0,
      opsRemoved: 0,
      opsKept: 0,
      opsRewritten: 0,
      streamsSkippedInlineImage: 0,
    });
    expect(parseRemovalStats("[ztransplit-remover] FAILED: boom")).toEqual({
      pagesTouched: 0,
      opsRemoved: 0,
      opsKept: 0,
      opsRewritten: 0,
      streamsSkippedInlineImage: 0,
    });
  });

  it("多个 done 行取第一个，后面的噪声不干扰", () => {
    const stats = parseRemovalStats(doneLine + "\n" + doneLine.replace("1997", "7") + "\n");
    expect(stats.opsRemoved).toBe(1997);
  });

  it("行内有别的等号字段时不串键", () => {
    // rects=18 在前一行，opsKept=0 与 opsRemoved=1997 只差一个前缀，
    // 正则必须锚住完整键名，否则 opsKept 会被误读成 opsRemoved。
    const stats = parseRemovalStats("[ztransplit-remover] rects=18\n" + doneLine + "\n");
    expect(stats.opsRemoved).toBe(1997);
    expect(stats.opsKept).toBe(0);
  });
});

describe("isRemovalEffective", () => {
  it("删掉了算子才算有效", () => {
    expect(isRemovalEffective(parseRemovalStats(doneLine))).toBe(true);
  });

  it("一个算子都没删 = 无效，即使退出码是 0", () => {
    // 这一条就是本次修复的核心：删除器在表单内文字那种文档上报
    // pagesTouched=0 opsRemoved=0，退出码仍是 0，产出的仍是合法 PDF。
    const stats = parseRemovalStats(
      "[ztransplit-remover] done pagesTouched=0 opsRemoved=0 opsKept=0 "
        + "opsRewritten=0 streamsSkippedInlineImage=0\n",
    );
    expect(isRemovalEffective(stats)).toBe(false);
  });

  it("解析失败（全 0）判为无效，方向是安全的", () => {
    expect(isRemovalEffective(parseRemovalStats("garbage"))).toBe(false);
  });

  it("只跳过流、一个算子没删，同样判为无效", () => {
    // 含内联图像的流整条跳过，里面的文字一条都没删。
    const stats = parseRemovalStats(
      "[ztransplit-remover] done pagesTouched=1 opsRemoved=0 opsKept=40 "
        + "opsRewritten=0 streamsSkippedInlineImage=1\n",
    );
    expect(isRemovalEffective(stats)).toBe(false);
  });

  it("部分删除也算有效（有遮罩兜底剩下的）", () => {
    const stats = parseRemovalStats(
      "[ztransplit-remover] done pagesTouched=1 opsRemoved=3 opsKept=97 "
        + "opsRewritten=0 streamsSkippedInlineImage=0\n",
    );
    expect(isRemovalEffective(stats)).toBe(true);
  });
});
