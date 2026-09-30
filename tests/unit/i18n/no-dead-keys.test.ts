/**
 * no-dead-keys — 多语言字典卫生守卫（自 z-search 的同名测试移植）。
 *
 * FTL 里定义的每个键都必须被代码引用（src/ 或 addon/），否则就是死键：
 * 照抄词汇表既让未来的每次翻译多一份负担，也误导下一个读者对插件实际
 * 渲染内容的判断。结构检查 S5 只验证「代码引用的键都有定义」这一个方向，
 * 本测试补上反方向（定义的键都被引用）与中英键集一致性。
 *
 * 运行时动态键家族（键名由数据拼出，静态扫描必须放过；新增家族在此登记，
 * 否则本守卫会误报）：
 *   - translation-error-ai-prompt-{reason}：promptTemplate 的七种模板拒绝
 *     原因，按规则名拼出键名取文案；
 *   - pane-translate-card-source-{source}：卡片来源标注（youdao/model/mt）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const DYNAMIC_KEY_PREFIXES = [
  "translation-error-ai-prompt-",
  "pane-translate-card-source-",
] as const;

const LOCALES = ["zh-CN", "en-US"] as const;
const FAMILIES = [
  "ztransplit.ftl",
  "ztransplit-preferences.ftl",
  "ztransplit-pane.ftl",
] as const;

function ftlKeys(file: string): Set<string> {
  const keys = new Set<string>();
  for (const m of fs
    .readFileSync(path.join(REPO, file), "utf8")
    .matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*=/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

/** 代码语料：一切可能写出键名的文件，FTL 源文件本身除外。 */
function codeCorpus(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const rel = p.split(path.sep).join("/");
        if (rel.endsWith("addon/locale") || rel.includes("node_modules")) continue;
        walk(p);
      } else if (/\.(ts|tsx|js|mjs|xhtml|html)$/.test(e.name)) {
        out.push(fs.readFileSync(p, "utf8"));
      }
    }
  };
  walk(path.join(REPO, "src"));
  walk(path.join(REPO, "addon"));
  return out.join("\n");
}

describe("多语言字典卫生", () => {
  it("没有死键（每个 FTL 键都被代码引用）", () => {
    const union = new Set<string>();
    for (const loc of LOCALES) {
      for (const fam of FAMILIES) {
        for (const k of ftlKeys(`addon/locale/${loc}/${fam}`)) union.add(k);
      }
    }
    expect(union.size).toBeGreaterThan(0);
    const corpus = codeCorpus();
    const dead = [...union].filter((k) => {
      if (DYNAMIC_KEY_PREFIXES.some((p) => k.startsWith(p))) return false;
      // 键名必须以带引号的形式被引用（getString/l10nID/data-l10n-id）。
      const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp('["\'`]' + escaped + '["\'`]').test(corpus);
    });
    expect(dead, `死键：${dead.slice(0, 40).join(", ")}`).toEqual([]);
  });

  it("中英文两个语言的键集完全一致", () => {
    for (const fam of FAMILIES) {
      const en = ftlKeys(`addon/locale/en-US/${fam}`);
      const zh = ftlKeys(`addon/locale/zh-CN/${fam}`);
      const missingInZh = [...en].filter((k) => !zh.has(k));
      const missingInEn = [...zh].filter((k) => !en.has(k));
      expect(
        { missingInZh, missingInEn },
        `${fam} 的中英键集不一致`,
      ).toEqual({ missingInZh: [], missingInEn: [] });
    }
  });
});
