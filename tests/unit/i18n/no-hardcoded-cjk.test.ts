/**
 * 中英双语回归守卫：源码里不允许出现硬编码中文界面文案
 * （自 z-search 的 no-hardcoded-cjk 测试移植）。
 *
 * 插件的用户可见文案必须走 FTL（zh-CN / en-US 两份），否则切到英文 Zotero
 * 时会露出中文。这类漏网之鱼肉眼很难发现，故把「字符串字面量 / 模板串
 * 含 CJK 汉字」设为红灯。
 *
 * 用 TypeScript 扫描器而非正则：源码注释里大量出现中文与引号样例，朴素的
 * 注释剥离或整行正则会制造大量误报；扫描器只看字符串字面量与模板串文本，
 * 注释天然不在扫描范围。
 *
 * 白名单（file -> 理由）：
 *  - src/core/pdf/platform.ts：macOS 字体文件路径（ヒラギノ角ゴシック W3.ttc
 *    等）是文件系统数据，不是界面文案。
 *  - src/core/pdf/splitViewFactory.ts：Java 缺失与网络错误的跨平台签名判定
 *    （匹配 Java 报错原文与简体/繁体系统文案），是分类用的数据，不是展示。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

const ALLOWLIST: Readonly<Record<string, string>> = {
  "src/core/pdf/platform.ts": "font file paths on macOS (filesystem data)",
  "src/core/pdf/splitview/splitViewFactory.ts":
    "cross-platform error-signature match patterns (simplified/traditional system messages), not UI text",
};

/** CJK 统一表意符号基本区（简体/繁体/日本汉字都在内）。 */
const CJK = /[一-鿿]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", ".git", ".scaffold", "locale"].includes(entry)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js)$/.test(entry)) out.push(p);
  }
  return out;
}

interface Offender {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/** 用 TS 扫描器收集「字符串字面量 / 模板串文本」里的 CJK。 */
function scan(file: string, src: string): Offender[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Offender[] = [];
  const check = (text: string, kind: string, node: ts.Node) => {
    if (!CJK.test(text)) return;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({
      file,
      line: pos.line + 1,
      kind,
      text: text.trim().slice(0, 60),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) check(node.text, "string", node);
    else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node.text, "template", node);
    } else if (ts.isTemplateExpression(node)) {
      check(node.head.text, "template", node);
      for (const span of node.templateSpans)
        check(span.literal.text, "template", span);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("i18n：源码字符串字面量不得硬编码 CJK 文案", () => {
  it("白名单之外没有任何 CJK 字面量", () => {
    const roots = [join(REPO, "src"), join(REPO, "addon")];
    const offenders: Offender[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const rel = relative(REPO, file).split("\\").join("/");
        if (ALLOWLIST[rel]) continue;
        offenders.push(...scan(rel, readFileSync(file, "utf-8")));
      }
    }
    expect(
      offenders.map(
        (o) => `${o.file}:${o.line} [${o.kind}] ${JSON.stringify(o.text)}`,
      ),
      "界面文案必须移入 FTL（zh-CN / en-US）——见本文件头注",
    ).toEqual([]);
  });

  it("白名单条目必须附理由且文件真实存在", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${file} 需要登记理由`).toBeGreaterThan(10);
      expect(statSync(join(REPO, file)).isFile(), `${file} 仍应存在`).toBe(
        true,
      );
    }
  });
});
