/**
 * translationScope — 哪些段落不送翻译、保留原文。
 *
 * 批 3 记在案、由用户拍定的产品决策：**图内文字只翻放得下的**。坐标轴刻度与
 * 图例等图内文字与正文走同一条翻译链路，而其中一部分段落在几何上放不下中文
 * 译文——硬译的结果是译文画出框外，或者字号被压到渲染端下限仍放不下。
 *
 * 两条判据，都是纯几何与纯文本，不依赖图片区域检测：
 *
 *   1. **框宽放不下一个汉字的不翻。** 一个汉字宽约等于字号。框宽 ÷ 字号 < 1
 *      时连一个汉字都放不下；压到渲染端的字号下限 `max(4, 0.4 × 字号)` 也放不下
 *      ——实测 3 磅框配 6 磅字号，下限 4 磅下一个汉字仍要 4 磅，是框宽的 1.3 倍。
 *      这类段落保留原文。
 *   2. **纯数字串不翻。** 坐标轴刻度、年份、页码。数字译成中文数字只会变宽
 *      （「20」→「二十」宽度翻倍），而保持阿拉伯数字宽度不变、放得下。这条不限
 *      于图内：数字在任何地方都不需要翻译。
 *
 * 为什么不复用 figureTextFilter：那个模块靠删除器的 `--inspect` 报出含文字表单
 * 的边界框，而五篇基准夹具上它返回 0 个区域，排除从未生效（度量里记着这一条）。
 * 这里的判据不依赖那条路径，自己就能认出不该译的段。
 *
 * 只在目标语是中日韩时生效：窄框对中文日语是放不下，对拉丁语种的同样宽度却放得
 * 下「20」。未传目标语言时按中文目标算——这个插件的目标语默认就是中文。
 *
 * 纯函数，Host 无关，可进 Node 单测。
 *
 * @module core/pdf/translation/translationScope
 */

import type { Paragraph } from "./translationIR";

/**
 * 纯数字串。允许前导正负号，以及千分位逗号、小数点、百分号与空白；
 * 必须以数字开头，所以 "..."、"—"、"N/A" 都不算。
 */
const NUMERIC_ONLY = /^[+\-]?[0-9][0-9\s.,+\-%]*$/;

/** 目标语是否中日韩。窄框只对这三种文字构成放不下的问题。 */
export function isCjkTargetLanguage(targetLanguage: string | undefined | null): boolean {
  const t = (targetLanguage || "").toLowerCase();
  return t.startsWith("zh") || t.startsWith("ja") || t.startsWith("ko");
}

/** 整段trim 之后只剩数字与数字标点。 */
export function isNumericOnlyText(text: string | undefined | null): boolean {
  const t = (text || "").trim();
  return t.length > 0 && NUMERIC_ONLY.test(t);
}

/** 框宽是否放不下一个当前字号的汉字。退化框（宽或高非正）不判，交给既有护栏。 */
export function paragraphTooNarrowForCjk(p: Paragraph): boolean {
  const width = p.x1 - p.x0;
  const size = p.size;
  if (!(width > 0) || !(size > 0)) return false;
  return width / size < 1;
}

/**
 * 这一段是否保留原文、不送翻译。
 *
 * 纯公式段不在此列：`translateParagraphs` 对纯公式段本来就是直通（不调引擎），
 * 而它的 LaTeX 文本要经 `latexToPlain` 变成读者看得懂的符号画出去。把这类段也
 * 一并清空会让公式从译文里消失。调用方在套用本判据前应先排除公式段。
 */
export function shouldKeepOriginal(
  p: Paragraph,
  text: string | undefined | null,
  cjkTarget: boolean,
): boolean {
  if (!cjkTarget) return false;
  if (isNumericOnlyText(text)) return true;
  return paragraphTooNarrowForCjk(p);
}

/** 逐段算，与 paragraphs / texts 同位。 */
export function computeKeepOriginal(
  paragraphs: Paragraph[],
  texts: string[],
  cjkTarget: boolean,
): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    out.push(shouldKeepOriginal(paragraphs[i], texts[i], cjkTarget));
  }
  return out;
}
