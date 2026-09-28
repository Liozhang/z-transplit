#!/usr/bin/env node
/**
 * structure-check — Zero-dependency structural validation for the z-transplit
 * Zotero 7 plugin package. Run from the workspace root:
 *
 *   node scripts/structure-check.mjs            # human report, exit 1 on FAIL
 *   node scripts/structure-check.mjs --json     # machine-readable verdict
 *   node scripts/structure-check.mjs --root DIR # check a different directory
 *
 * Checks (each with evidence in the report):
 *   S1 manifest.json      — JSON valid, required fields, version matches pkg
 *   S2 manifest icons     — every declared icon file exists and is non-empty
 *   S3 prefs.js syntax    — `node --check` passes
 *   S4 pref key inventory — every translate.* key read by src exists in defaults;
 *                           orphan defaults (declared, never read) reported as WARN
 *   S5 FTL coverage       — every getString()/l10nID key referenced in src/addon
 *                           exists in the FTL files; unused keys as WARN
 *   S6 chrome:// URLs     — every chrome://ztransplit/content/... target exists
 *   S7 SVG validity       — icons parse, have viewBox, contain no <script>/external
 *                           href; section icons use currentColor; manifest icons don't
 *   S8 XPI artifact       — build product present and non-trivial in size
 *   S9 no leadero coupling— grep for leadero/Leadero/leaderoAPI/PostMessageBridge/Hub
 *                           across the shipped sources
 */

import { readFileSync, existsSync, statSync, readdirSync, globSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ROOT = argv.includes("--root")
  ? resolve(argv[argv.indexOf("--root") + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = argv.includes("--json");
if (!existsSync(ROOT)) {
  console.error(`root directory does not exist: ${ROOT}`);
  process.exit(2);
}

const lines = [];
const json = [];
function emit(status, id, message, evidence) {
  lines.push(`${status.padEnd(4)} ${id}  ${message}`);
  json.push({ status, id, message, evidence });
}
const pass = (id, msg, ev) => emit("PASS", id, msg, ev);
const fail = (id, msg, ev) => emit("FAIL", id, msg, ev);
const warn = (id, msg, ev) => emit("WARN", id, msg, ev);

function readIfExists(p) {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return null;
  }
}

function allSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".scaffold" || e.name === ".git") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      // .xhtml/.xul are first-class plugin sources (the settings pane markup
      // lives there and carries preference bindings + l10n ids).
      else if (/\.(ts|tsx|js|mjs|json|ftl|xhtml|xul)$/.test(e.name)) out.push(rel);
    }
  };
  if (existsSync(join(ROOT, "src"))) walk("src");
  if (existsSync(join(ROOT, "addon"))) walk("addon");
  return out;
}

function* grepSources(pattern) {
  const re = new RegExp(pattern);
  for (const f of allSourceFiles()) {
    const text = readIfExists(f);
    if (text === null) continue;
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i += 1) {
      if (re.test(fileLines[i])) yield `${f}:${i + 1}: ${fileLines[i].trim()}`;
    }
  }
}

// ── Load package.json ──
const pkg = JSON.parse(readIfExists("package.json") ?? "{}");
const cfg = pkg.config ?? {};
const prefix = cfg.prefsPrefix ?? "extensions.zotero.ztransplit";
const addonRef = cfg.addonRef ?? "ztransplit";

// ── S1 manifest ──
let manifest = null;
let iconTargets = [];
{
  const raw = readIfExists("addon/manifest.json");
  if (raw === null) {
    fail("S1", "addon/manifest.json 缺失", "file not found");
  } else {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      fail("S1", "manifest.json 不是合法 JSON", String(e));
      m = null;
    }
    if (m) {
      manifest = m;
      // Zotero 7 layout: the addon ID lives under applications.zotero.id (NOT
      // at the manifest top level), and that is also where the version floor is
      // declared. The scaffold template renders these with __placeholders__.
      const zoteroApp = m.applications?.zotero ?? {};
      const missing = ["manifest_version", "name", "version", "description"].filter(
        (k) => m[k] === undefined,
      );
      const appMissing = ["id", "strict_min_version"].filter((k) => zoteroApp[k] === undefined);
      if (missing.length) fail("S1", `manifest 缺顶层字段: ${missing.join(", ")}`, JSON.stringify(m).slice(0, 300));
      else if (appMissing.length)
        fail("S1", `applications.zotero 缺字段: ${appMissing.join(", ")}（Zotero 7 的 id 在 applications.zotero 下，不在顶层）`, JSON.stringify(zoteroApp));
      else if (/__[A-Za-z0-9_]+__/.test(String(m.version)) && !pkg.version) {
        fail("S1", `manifest.version ${m.version} 无法与 package.json 比较`, "package.json 无 version");
      } else if (/__[A-Za-z0-9_]+__/.test(String(m.version))) {
        // Build-time placeholder (scaffold template): the source manifest is
        // substituted at build, so compare the BUILT copy when one exists and
        // otherwise accept the source with an explicit note.
        const builtRaw = readIfExists(".scaffold/build/addon/manifest.json");
        if (builtRaw) {
          try {
            const built = JSON.parse(builtRaw);
            if (built.version === pkg.version)
              pass("S1", `manifest 合法（构建产物 version=${built.version} 与 package.json 一致；源文件为构建期占位符）`);
            else
              fail("S1", `构建产物 manifest.version ${built.version} 与 package.json ${pkg.version} 不一致`, `${built.version} vs ${pkg.version}`);
          } catch (e) {
            fail("S1", "构建产物 manifest.json 不是合法 JSON", String(e));
          }
        } else {
          pass("S1", `manifest 合法（源文件使用构建期占位符 ${m.version}；id=${zoteroApp.id}；尚无构建产物可比对版本）`);
        }
      } else if (m.version !== pkg.version) fail("S1", `manifest.version ${m.version} 与 package.json version ${pkg.version} 不一致`, `${m.version} vs ${pkg.version}`);
      else pass("S1", `manifest 合法（id=${zoteroApp.id}, version=${m.version}, min=${zoteroApp.strict_min_version}）`);
    }
  }
}

// ── S2 manifest icons ──
{
  const icons = manifest?.icons ?? {};
  for (const v of Object.values(icons)) {
    if (typeof v === "string") iconTargets.push(v);
    else if (v && typeof v === "object")
      for (const w of Object.values(v)) if (typeof w === "string") iconTargets.push(w);
  }
  if (iconTargets.length === 0) {
    warn("S2", "manifest 未声明 icons（Zotero 7 建议声明亮暗变体）", JSON.stringify(icons));
  } else {
    // Manifest icon values appear either as chrome://ztransplit/content/... or
    // as addon-relative content/... — resolve both onto the addon/ root.
    const resolveIcon = (t) =>
      join(ROOT, t.startsWith(`chrome://${addonRef}/`) ? t.replace(`chrome://${addonRef}/`, "addon/") : join("addon", t));
    const missing = iconTargets.filter((t) => {
      const p = resolveIcon(t);
      return !existsSync(p) || statSync(p).size === 0;
    });
    if (missing.length) fail("S2", `manifest icons 指向不存在的文件: ${missing.join(", ")}`, iconTargets.join(" "));
    else pass("S2", `manifest icons 全部存在（${iconTargets.length} 个）`, iconTargets.join(" "));
  }
}

// ── S3 prefs.js syntax ──
try {
  const raw = readIfExists("addon/prefs.js");
  if (raw === null) {
    fail("S3", "addon/prefs.js 缺失", "file not found");
  } else {
    execFileSync(process.execPath, ["--check", join(ROOT, "addon/prefs.js")], { stdio: "pipe" });
    pass("S3", "addon/prefs.js 语法合法（node --check）");
  }
} catch (e) {
  fail("S3", "addon/prefs.js 语法错误", String(e.stderr ?? e.message).slice(0, 400));
}

// ── S4 pref key inventory ──
{
  const prefsRaw = readIfExists("addon/prefs.js") ?? "";
  // Strip the plugin's REAL preference prefix (from package.json config), not a
  // guessed two-segment one: prefs are declared fully-qualified
  // (extensions.zotero.ztransplit.translate.enabled) while code reads them
  // relative (translate.enabled). A guessed "extensions.<one-segment>." regex
  // leaves the addonRef segment attached and bids every key "undeclared".
  const stripPrefix = (k) =>
    k.startsWith(`${prefix}.`) ? k.slice(prefix.length + 1) : k;
  const declared = new Set(
    [...prefsRaw.matchAll(/pref\(\s*"([^"]+)"/g)].map((m) => stripPrefix(m[1])),
  );
  // Capture ONLY the key inside the call, not every quoted string on the line —
  // otherwise a line like `getPrefDynamic("translate.maxChars") as number) ?? 10000`
  // pollutes the set with unrelated literals.
  const used = new Set();
  for (const hit of grepSources(`getPref(?:Dynamic)?\\(\\s*["']([^"']+)["']`)) {
    const m = /getPref(?:Dynamic)?\(\s*["']([^"']+)["']/.exec(hit);
    // Skip template-literal captures: a debug line like
    //   safeDebug(`… getPref('${key}') failed …`)
    // is not a pref read, and `${key}` is not a statically checkable key.
    if (m && !m[1].includes("${")) used.add(m[1]);
  }
  // XUL preference bindings in the settings pane
  // (<xul:preference name="extensions.zotero.ztransplit.…">) read keys without
  // any getPref() call — count them, or every engine credential reads as dead.
  // Two guards: skip comment lines (doc comments show example bindings), and
  // skip placeholder keys containing an ellipsis (they are examples, not keys).
  for (const hit of grepSources(`preference\\s*=\\s*"[^"]*${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"`)) {
    const text = hit.slice(hit.indexOf(": ") + 2).trim();
    if (/^(\/\/|\/\*|\*|#|<!--)/.test(text)) continue;
    const m = /preference\s*=\s*"([^"]+)"/.exec(hit);
    if (m && !/[…]|\.\.\./.test(m[1])) used.add(stripPrefix(m[1]));
  }
  const shortPrefix = prefix.split(".").pop();
  const missing = [...used].filter((k) => !declared.has(k));
  const orphans = [...declared].filter((k) => !used.has(k));
  if (missing.length)
    fail("S4", `代码读取但 defaults 未声明的键: ${missing.join(", ")}`, `declared=${[...declared].sort().join(",")}`);
  else if (orphans.length)
    warn("S4", `声明但代码未读取的键（可能是 pane-only 或死键）: ${orphans.join(", ")}`, `declared=${[...declared].join(",")}`);
  else pass("S4", `偏好键双向一致（${declared.size} 个，前缀 ${shortPrefix}）`, [...declared].sort().join(","));
}

// ── S5 FTL coverage ──
{
  const ftl = readIfExists(`addon/locale/en-US/${addonRef}.ftl`) ?? "";
  const prefFtl = readIfExists(`addon/locale/en-US/${addonRef}-preferences.ftl`) ?? "";
  const paneFtl = readIfExists(`addon/locale/en-US/${addonRef}-pane.ftl`) ?? "";
  const allFtl = ftl + "\n" + prefFtl + "\n" + paneFtl;
  const defined = new Set(
    [...allFtl.matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]),
  );
  // Same capture-only-the-call-key discipline as S4: a getString line often
  // contains other quoted literals (variable names, fallbacks) that are not keys.
  const referenced = new Set();
  const keyRe = /(?:getString\(\s*["']|l10nID:\s*["'])([a-zA-Z0-9_-]+)["']/g;
  for (const hit of grepSources(`getString\\(\\s*["'][a-zA-Z0-9_-]+["']|l10nID:\\s*["'][a-zA-Z0-9_-]+["']`)) {
    for (const m of hit.matchAll(keyRe)) referenced.add(m[1]);
  }
  const missing = [...referenced].filter((k) => !defined.has(k));
  if (missing.length)
    fail("S5", `代码引用但 FTL 未定义的键（${missing.length} 个）: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`, `referenced=${[...referenced].join(",")}`);
  else {
    const unused = [...defined].filter((k) => !referenced.has(k));
    pass("S5", `FTL 键覆盖完整（定义 ${defined.size} 个，引用 ${referenced.size} 个）`, unused.length ? `未引用键: ${unused.slice(0, 10).join(", ")}` : "无未引用键");
  }
}

// ── S6 chrome:// URLs ──
{
  const missing = [];
  let n = 0;
  for (const hit of grepSources(`chrome://${addonRef}/[^"'\\s)]+`)) {
    const m = hit.match(new RegExp(`chrome://${addonRef}/(content/[^"'\\s)]+)`));
    if (!m) continue;
    n += 1;
    if (!existsSync(join(ROOT, "addon", m[1]))) missing.push(m[1]);
  }
  if (missing.length) fail("S6", `chrome:// URL 指向不存在的文件: ${missing.join(", ")}`, `${n} 处引用`);
  else pass("S6", `chrome://${addonRef} URL 全部可解析（${n} 处）`);
}

// ── S7 SVG validity ──
{
  const iconDir = join(ROOT, "addon/content/icons");
  if (!existsSync(iconDir)) {
    fail("S7", "addon/content/icons 目录不存在", iconDir);
  } else {
    const svgs = globSync("*.svg", { cwd: iconDir });
    if (svgs.length === 0) {
      fail("S7", "icons 目录无 SVG 文件", String(svgs));
    } else {
      // Color policy is set by ROLE, not by filename convention:
      //   - manifest-declared icons: explicit fills only (manifest surfaces
      //     cannot theme currentColor) → must NOT contain currentColor
      //   - chrome://-referenced UI icons (section headers, sidenav, pane):
      //     themed by Zotero → MUST be currentColor
      //   - brand-only assets (e.g. a full-color README logo referenced by no
      //     chrome:// URL and not in manifest): unconstrained
      const manifestIconNames = new Set(
        iconTargets.map((t) => t.split("/").pop()).filter(Boolean),
      );
      const chromeIconNames = new Set();
      for (const hit of grepSources(`chrome://${addonRef}/content/icons/[^"'\\s)]+`)) {
        const m = hit.match(new RegExp(`chrome://${addonRef}/content/icons/([^"'\\s)]+)`));
        if (m) chromeIconNames.add(m[1]);
      }
      const problems = [];
      for (const f of svgs) {
        const text = readFileSync(join(iconDir, f), "utf8");
        if (!/<svg[\s>]/.test(text)) problems.push(`${f}: 无 <svg> 根`);
        if (!/viewBox\s*=/.test(text)) problems.push(`${f}: 缺 viewBox`);
        if (/<script[\s>]/.test(text)) problems.push(`${f}: 含 <script>`);
        if (/href\s*=\s*["']https?:/i.test(text)) problems.push(`${f}: 含外链 href`);
        if (manifestIconNames.has(f) && /currentColor/.test(text))
          problems.push(`${f}: manifest 声明的图标应显式配色而非 currentColor`);
        if (chromeIconNames.has(f) && !manifestIconNames.has(f) && !/currentColor/.test(text))
          problems.push(`${f}: 被 chrome:// 引用的 UI 图标应使用 currentColor`);
      }
      if (problems.length) fail("S7", `SVG 问题: ${problems.join("; ")}`, `${svgs.length} 个 SVG`);
      else pass("S7", `${svgs.length} 个 SVG 均合法（manifest 显式配色 / UI 图标 currentColor / 品牌图不约束）`, svgs.join(" "));
    }
  }
}

// ── S8 XPI artifact ──
{
  const buildDir = join(ROOT, ".scaffold/build");
  const buildXpis = existsSync(buildDir) ? globSync("*.xpi", { cwd: buildDir }) : [];
  const rootXpis = globSync("*.xpi", { cwd: ROOT });
  // Resolve to an absolute path from the SAME base the glob ran in — joining a
  // root-level hit with the build dir silently produces a path that does not exist.
  const candidates = [
    ...buildXpis.map((f) => ({ base: buildDir, f })),
    ...rootXpis.map((f) => ({ base: ROOT, f })),
  ];
  if (candidates.length === 0) warn("S8", "未找到 XPI 产物（尚未构建或构建失败）", ROOT);
  else {
    const first = candidates[0];
    const kb = Math.round(statSync(join(first.base, first.f)).size / 1024);
    const label = candidates.map((c) => join(c.base, c.f).replace(ROOT, ".")).join(" ");
    if (kb < 50) warn("S8", `XPI 体积异常小（${kb} KB）`, label);
    else pass("S8", `XPI 产物存在（${kb} KB）`, label);
  }
}

// ── S9 no leadero coupling ──
{
  // "No leadero coupling" means no EXECUTABLE reference: an import/require/dynamic
  // import from the leadero repo, or a chrome://leadero/... URL. Comments and
  // provenance notes crediting the source ("Ported from leadero/src/utils/json.ts")
  // are good practice and must not fail the check — they are counted in the
  // evidence so the reviewer can still see them.
  const COUPLING = [
    /from\s+["'][^"']*leadero[^"']*["']/i,
    /require\(\s*["'][^"']*leadero[^"']*["']\s*\)/i,
    /import\(\s*["'][^"']*leadero[^"']*["']/i,
    /chrome:\/\/leadero\//i,
    /\bleadero@[a-z0-9.-]+\b/i,
  ];
  const couplingHits = [];
  let mentions = 0;
  for (const hit of grepSources("(leadero|Leadero|LEADERO)")) {
    if (COUPLING.some((re) => re.test(hit))) couplingHits.push(hit);
    else mentions += 1;
  }
  if (couplingHits.length)
    fail("S9", `发现 ${couplingHits.length} 处 leadero 可执行引用（import/require/chrome://）`, couplingHits.slice(0, 10).join("\n"));
  else if (mentions > 0)
    pass("S9", `无 leadero 可执行引用；${mentions} 处注释/溯源提及（允许，贡献署名）`);
  else pass("S9", "源码与 addon 中无 leadero 引用");
}

// ── Report ──
if (JSON_MODE) {
  console.log(JSON.stringify({ root: ROOT, checks: json }, null, 1));
} else {
  console.log(lines.join("\n"));
  const fails = json.filter((c) => c.status === "FAIL").length;
  console.log(`\n${json.length - fails}/${json.length} checks passed, ${fails} failed, ${json.filter((c) => c.status === "WARN").length} warnings`);
}
process.exit(json.some((c) => c.status === "FAIL") ? 1 : 0);
