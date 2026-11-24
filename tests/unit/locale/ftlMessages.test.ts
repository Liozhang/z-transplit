/**
 * FTL 文案守卫 — 锁住两类真实发生过的文案缺陷。
 *
 *   - 占位符少写 $：`{detail}` 会被 Fluent 当成字面量，用户看到原始花括号
 *     （真机实测 2026-11-24：六条消息中英文同时受影响，例如「安装失败：
 *     {ztransplit-detail}」）。
 *   - 同一 id 在多份文件里重复定义：err-jar-load 曾同时存在于两份文件且
 *     文案不同，哪份生效取决于加载顺序，坏的那份永远不会被发现。
 *
 * 顺带锁住每个文件在 zh-CN 与 en-US 之间的键集合一致——Zotero 按文件粒度
 * 选择 locale，缺一个键就会静默回落英文。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const LOCALE_ROOT = path.resolve(__dirname, "../../../addon/locale");
const LOCALES = ["zh-CN", "en-US"] as const;

/** 解析一份 FTL 里的全部消息 id（含重复）。 */
function parseIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * 找出写错形态的占位符。合法形态：变量 { $name }、函数调用 { NUMBER($x) }、
 * 字面量转义 {"..."}。除此之外的标识符形态（{detail}、{count}）一律算错。
 */
function badPlaceholders(text: string): string[] {
  const bad: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 注释行（## 开头）不参与：头部说明里的 `${namespace}-` 之类是文档，不是文案。
    if (/^\s*#/.test(line)) return;
    // 先去掉 {"..."} 转义（模板文档里的花括号示例），再找占位符。
    const cleaned = line.replace(/\{"[^"]*"\}/g, "");
    const re = /\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) {
      const inner = m[1].trim();
      if (inner.startsWith("$")) continue;
      if (/^[A-Za-z][A-Za-z0-9_-]*\(/.test(inner)) continue;
      if (/^-?[A-Za-z][A-Za-z0-9_-]*$/.test(inner)) {
        bad.push(`第 ${i + 1} 行：{${inner}}`);
      }
    }
  });
  return bad;
}

describe.each(LOCALES)("FTL 文案（%s）", (locale) => {
  const dir = path.join(LOCALE_ROOT, locale);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ftl"));

  it("目录里存在 FTL 文件", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s 没有少写 $ 的占位符", (file) => {
    const text = readFileSync(path.join(dir, file), "utf8");
    expect(badPlaceholders(text)).toEqual([]);
  });

  it("同一 id 不在多份文件里重复定义", () => {
    const seen = new Map<string, string[]>();
    for (const file of files) {
      for (const id of parseIds(readFileSync(path.join(dir, file), "utf8"))) {
        const list = seen.get(id) ?? [];
        list.push(file);
        seen.set(id, list);
      }
    }
    const duplicates = [...seen.entries()].filter(([, fs]) => fs.length > 1);
    expect(
      duplicates.map(([id, fs]) => `${id} -> ${fs.join(", ")}`),
    ).toEqual([]);
  });

  it("每个文件与另一语言的同名文件键集合一致", () => {
    for (const file of files) {
      const other = path.join(LOCALE_ROOT, locale === "zh-CN" ? "en-US" : "zh-CN", file);
      const mine = new Set(parseIds(readFileSync(path.join(dir, file), "utf8")));
      const theirs = new Set(parseIds(readFileSync(other, "utf8")));
      const missing = [...theirs].filter((id) => !mine.has(id));
      const extra = [...mine].filter((id) => !theirs.has(id));
      expect(`${file} 缺少: ${missing.join(", ")}`).toBe(`${file} 缺少: `);
      expect(`${file} 多出: ${extra.join(", ")}`).toBe(`${file} 多出: `);
    }
  });
});
