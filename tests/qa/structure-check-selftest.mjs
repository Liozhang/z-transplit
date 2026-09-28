#!/usr/bin/env node
/**
 * structure-check-selftest.mjs — Positive controls for structure-check.mjs.
 *
 * A checker that has only ever been run against an empty (or clean) directory
 * has NOT been shown to catch anything. This builds synthetic plugin fixtures —
 * one good, and one per failure mode — and asserts the checker reports exactly
 * the expected status for each check id. That is what makes a green run of
 * structure-check meaningful on the real plugin later.
 *
 *   node structure-check-selftest.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "..", "..", "scripts", "structure-check.mjs");
const FIXTURES = join(HERE, "fixtures");

const PKG = JSON.stringify(
  {
    name: "z-transplit",
    version: "0.1.0",
    config: {
      addonName: "Z-Transplit",
      addonID: "ztransplit@zotero.org",
      addonRef: "ztransplit",
      addonInstance: "ZTransplit",
      prefsPrefix: "extensions.zotero.ztransplit",
    },
  },
  null,
  2,
);

const MANIFEST = (icons, opts = {}) =>
  JSON.stringify(
    {
      manifest_version: 2,
      name: "Z-Transplit",
      version: opts.version ?? "0.1.0",
      description: "translate + split",
      author: "qa",
      applications: {
        zotero: {
          // Zotero 7: the addon id lives HERE, not at the manifest top level.
          ...(opts.omitAppId ? {} : { id: "ztransplit@zotero.org" }),
          strict_min_version: "7.0",
          strict_max_version: "7.*",
        },
      },
      ...(icons ? { icons } : {}),
    },
    null,
    2,
  );

const PREFS_OK = `// defaults
pref("extensions.zotero.ztransplit.translate.enabled", false);
pref("extensions.zotero.ztransplit.translate.auto", false);
pref("extensions.zotero.ztransplit.translate.maxChars", 10000);
pref("extensions.zotero.ztransplit.translate.engineType", "google");
pref("extensions.zotero.ztransplit.translate.google.apiKey", "");
`;

const SRC_OK = `import { getString } from "../utils/locale";
import { getPref, getPrefDynamic } from "../utils/prefs";
export const LABEL = getString("pane-translate-action");
export const ON = getPref("translate.enabled");
export const AUTO = getPref("translate.auto");
export const MAX = getPrefDynamic("translate.maxChars");
export const ENGINE = getPrefDynamic("translate.engineType");
export const GKEY = getPrefDynamic("translate.google.apiKey");
export const ICON = "chrome://ztransplit/content/icons/translate.svg";
`;

const FTL_OK = `pane-translate-action = 翻译
translate-error-generic = 翻译失败
`;

const SVG_EXPLICIT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#4f46e5"/></svg>`;
const SVG_CURRENT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-width="2"/></svg>`;
const SVG_BRAND = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#f59e0b"/></svg>`;

function write(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Build a complete, clean plugin at `root`. Returns an override hook. */
function buildGoodPlugin(root, opts = {}) {
  const { manifest, prefs, src, ftl, skipIcons = false, skipXpi = false, leaderoTouch = false } = opts;
  write(root, "package.json", PKG);
  write(
    root,
    "addon/manifest.json",
    manifest ??
      MANIFEST({
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      }),
  );
  write(root, "addon/prefs.js", prefs ?? PREFS_OK);
  write(root, "src/core/translation/engine.ts", src ?? SRC_OK);
  write(root, "addon/locale/en-US/ztransplit.ftl", ftl ?? FTL_OK);
  if (!skipIcons) {
    write(root, "addon/content/icons/ztransplit-light.svg", SVG_EXPLICIT);
    write(root, "addon/content/icons/ztransplit-dark.svg", SVG_EXPLICIT);
    write(root, "addon/content/icons/translate.svg", SVG_CURRENT);
    write(root, "addon/content/icons/logo.svg", SVG_BRAND);
  }
  if (!skipXpi) {
    write(root, ".scaffold/build/z-transplit-0.1.0.xpi", Buffer.alloc(120 * 1024, 1));
  }
  if (leaderoTouch) {
    write(root, "src/legacy.ts", `// ported from leadero src/core/translation/translationEngines.ts\n`);
  }
}

function runChecker(root) {
  // spawnSync, not execFileSync: the checker exits 1 whenever a check FAILs,
  // which is exactly the signal we want to read — execFileSync would throw and
  // hide the JSON report inside the error object.
  const proc = spawnSync(process.execPath, [CHECKER, "--root", root, "--json"], {
    encoding: "utf8",
  });
  if (proc.error) throw proc.error;
  const statuses = {};
  for (const c of JSON.parse(proc.stdout).checks) statuses[c.id] = c.status;
  return statuses;
}

let passed = 0;
const failures = [];
function expect(name, actual, expected) {
  const ok = Object.entries(expected).every(([id, s]) => actual[id] === s);
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    const diff = Object.entries(expected)
      .filter(([id, s]) => actual[id] !== s)
      .map(([id, s]) => `${id}: expected ${s}, got ${actual[id] ?? "missing"}`)
      .join("; ");
    console.error(`FAIL  ${name}\n      ${diff}`);
  }
}

rmSync(FIXTURES, { recursive: true, force: true });
const ALL_PASS = { S1: "PASS", S2: "PASS", S3: "PASS", S4: "PASS", S5: "PASS", S6: "PASS", S7: "PASS", S8: "PASS", S9: "PASS" };

// 1. Clean plugin: everything passes.
{
  const root = join(FIXTURES, "good");
  buildGoodPlugin(root);
  expect("干净插件：S1-S9 全 PASS", runChecker(root), ALL_PASS);
}

// 2. Missing manifest → S1 FAIL, and S2 WARNs because no icons can be declared.
{
  const root = join(FIXTURES, "no-manifest");
  buildGoodPlugin(root);
  rmSync(join(root, "addon/manifest.json"));
  expect("缺 manifest → S1 FAIL + S2 WARN", runChecker(root), {
    ...ALL_PASS,
    S1: "FAIL",
    S2: "WARN",
  });
}

// 3. Manifest icon file absent → S2 FAIL; S6 also flags the manifest's own
// chrome:// URL (it scans addon/**.json too, which is harmless double coverage).
{
  const root = join(FIXTURES, "missing-icon");
  buildGoodPlugin(root, {
    manifest: MANIFEST({ 48: "chrome://ztransplit/content/icons/does-not-exist.svg" }),
  });
  expect("manifest 图标文件缺失 → S2 FAIL", runChecker(root), {
    ...ALL_PASS,
    S2: "FAIL",
    S6: "FAIL",
  });
}

// 4. prefs.js syntax error → S3 FAIL, and S4 FAILs because defaults are unparseable.
{
  const root = join(FIXTURES, "bad-prefs-syntax");
  buildGoodPlugin(root, { prefs: `pref("extensions.zotero.ztransplit.translate.enabled", false)\nthis is not javascript` });
  expect("prefs.js 语法错误 → S3 FAIL（S4 连带）", runChecker(root), {
    ...ALL_PASS,
    S3: "FAIL",
    S4: "FAIL",
  });
}

// 5. Code reads an undeclared pref key → S4 FAIL.
{
  const root = join(FIXTURES, "undeclared-pref");
  buildGoodPlugin(root, {
    src: SRC_OK + `export const X = getPrefDynamic("translate.custom.apiUrl");\n`,
  });
  expect("读取未声明的偏好键 → S4 FAIL", runChecker(root), { ...ALL_PASS, S4: "FAIL" });
}

// 6. Code references an undefined FTL key → S5 FAIL.
{
  const root = join(FIXTURES, "missing-ftl-key");
  buildGoodPlugin(root, {
    src: SRC_OK + `export const L = getString("pane-translate-nonexistent");\n`,
  });
  expect("引用未定义的 FTL 键 → S5 FAIL", runChecker(root), { ...ALL_PASS, S5: "FAIL" });
}

// 7. chrome:// URL pointing at a missing file → S6 FAIL.
{
  const root = join(FIXTURES, "broken-chrome-url");
  buildGoodPlugin(root, {
    src: SRC_OK + `export const I = "chrome://ztransplit/content/icons/ghost.svg";\n`,
  });
  expect("chrome:// URL 指向缺失文件 → S6 FAIL", runChecker(root), { ...ALL_PASS, S6: "FAIL" });
}

// 8a. Manifest icon uses currentColor → S7 FAIL.
{
  const root = join(FIXTURES, "manifest-icon-currentcolor");
  buildGoodPlugin(root);
  write(root, "addon/content/icons/ztransplit-light.svg", SVG_CURRENT);
  expect("manifest 图标误用 currentColor → S7 FAIL", runChecker(root), { ...ALL_PASS, S7: "FAIL" });
}

// 8b. chrome://-referenced UI icon lacks currentColor → S7 FAIL.
{
  const root = join(FIXTURES, "ui-icon-not-currentcolor");
  buildGoodPlugin(root);
  write(root, "addon/content/icons/translate.svg", SVG_EXPLICIT);
  expect("UI 图标缺 currentColor → S7 FAIL", runChecker(root), { ...ALL_PASS, S7: "FAIL" });
}

// 8c. Brand logo (not in manifest, no chrome:// ref) may be full-color.
{
  const root = join(FIXTURES, "brand-logo-fullcolor");
  buildGoodPlugin(root);
  expect("品牌 logo 全彩不违规 → S7 PASS", runChecker(root), { ...ALL_PASS, S7: "PASS" });
}

// 9. leadero EXECUTABLE reference in src → S9 FAIL (comment mentions are fine,
//    see group 15 which pins that distinction).
{
  const root = join(FIXTURES, "leadero-residue");
  buildGoodPlugin(root);
  write(
    root,
    "src/legacy.ts",
    `import { helper } from "../../leadero/src/utils/helper";\nexport const X = helper();\n`,
  );
  expect("leadero 可执行引用 → S9 FAIL", runChecker(root), { ...ALL_PASS, S9: "FAIL" });
}

// 10. No XPI → S8 WARN (not a hard failure: build may not have run).
{
  const root = join(FIXTURES, "no-xpi");
  buildGoodPlugin(root, { skipXpi: true });
  expect("无 XPI 产物 → S8 WARN", runChecker(root), { ...ALL_PASS, S8: "WARN" });
}

// 10b. XPI at workspace ROOT (scaffold variants differ) still resolves — the
// old build-dir join produced a nonexistent path for this case.
{
  const root = join(FIXTURES, "root-xpi");
  buildGoodPlugin(root, { skipXpi: true });
  write(root, "z-transplit-0.1.0.xpi", Buffer.alloc(120 * 1024, 1));
  expect("根目录 XPI 产物 → S8 PASS", runChecker(root), ALL_PASS);
}

// 11. Version mismatch manifest vs package.json → S1 FAIL.
{
  const root = join(FIXTURES, "version-mismatch");
  buildGoodPlugin(root, {
    manifest: MANIFEST(
      {
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      },
      { version: "9.9.9" },
    ),
  });
  expect("版本号不一致 → S1 FAIL", runChecker(root), { ...ALL_PASS, S1: "FAIL" });
}

// 12. applications.zotero.id missing (the Zotero 7 id location) → S1 FAIL.
{
  const root = join(FIXTURES, "app-id-missing");
  buildGoodPlugin(root, {
    manifest: MANIFEST(
      {
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      },
      { omitAppId: true },
    ),
  });
  expect("applications.zotero 缺 id → S1 FAIL", runChecker(root), { ...ALL_PASS, S1: "FAIL" });
}

// 13. Relative icon paths in the manifest (content/icons/...) resolve under
// addon/ — the chrome://-only resolver used to miss these.
{
  const root = join(FIXTURES, "relative-icon-paths");
  buildGoodPlugin(root, {
    manifest: MANIFEST({
      "48": "content/icons/ztransplit-light.svg",
      "48_dark": "content/icons/ztransplit-dark.svg",
    }),
  });
  expect("manifest 相对图标路径 → S2 PASS", runChecker(root), ALL_PASS);
}

// 14. A debug line containing getPref('${key}') is not a pref read — the
// template-literal capture must not pollute the S4 key set.
{
  const root = join(FIXTURES, "debug-template-pref");
  buildGoodPlugin(root, {
    src:
      SRC_OK +
      `function logMiss(key: string) {\n  safeDebug(\`getPref('\${key}') missing\`);\n}\n`,
  });
  expect("调试日志里的模板插值不算键读取 → S4 PASS", runChecker(root), ALL_PASS);
}

// 16. Build-time placeholder version in the SOURCE manifest is expected
// (scaffold substitutes __buildVersion__ at build): no built copy → PASS.
{
  const root = join(FIXTURES, "placeholder-version-no-build");
  buildGoodPlugin(root, {
    manifest: MANIFEST(
      {
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      },
      { version: "__buildVersion__" },
    ),
  });
  expect("源 manifest 占位符版本（无构建产物）→ S1 PASS", runChecker(root), ALL_PASS);
}

// 17. Same, with a BUILT manifest whose version matches package.json → PASS.
{
  const root = join(FIXTURES, "placeholder-version-built-ok");
  buildGoodPlugin(root, {
    manifest: MANIFEST(
      {
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      },
      { version: "__buildVersion__" },
    ),
  });
  write(
    root,
    ".scaffold/build/addon/manifest.json",
    MANIFEST({
      "48": "content/icons/ztransplit-light.svg",
      "48_dark": "content/icons/ztransplit-dark.svg",
    }),
  );
  expect("源 manifest 占位符 + 构建产物版本一致 → S1 PASS", runChecker(root), ALL_PASS);
}

// 18. Same, but the BUILT manifest's version drifts → S1 FAIL.
{
  const root = join(FIXTURES, "placeholder-version-built-bad");
  buildGoodPlugin(root, {
    manifest: MANIFEST(
      {
        "48": "chrome://ztransplit/content/icons/ztransplit-light.svg",
        "48_dark": "chrome://ztransplit/content/icons/ztransplit-dark.svg",
      },
      { version: "__buildVersion__" },
    ),
  });
  write(
    root,
    ".scaffold/build/addon/manifest.json",
    MANIFEST(
      {
        "48": "content/icons/ztransplit-light.svg",
        "48_dark": "content/icons/ztransplit-dark.svg",
      },
      { version: "9.9.9" },
    ),
  );
  expect("源 manifest 占位符 + 构建产物版本漂移 → S1 FAIL", runChecker(root), { ...ALL_PASS, S1: "FAIL" });
}
// 21. XUL preference bindings in the settings pane count as reads — engine
// credentials are bound there, not read via getPref(). The fixture's src
// deliberately does NOT read translate.google.apiKey, so the only thing that
// can satisfy S4 is the pane binding itself (a vacuous control would pass even
// if .xhtml were never scanned).
{
  const root = join(FIXTURES, "pane-bound-prefs");
  buildGoodPlugin(root);
  write(
    root,
    "src/core/translation/engine.ts",
    SRC_OK.replace(`export const GKEY = getPrefDynamic("translate.google.apiKey");\n`, ""),
  );
  write(
    root,
    "addon/content/preferences.xhtml",
    `<xul:vbox xmlns:xul="http://www.mozilla.org/zotero">
  <xul:preference id="pref-gkey" preference="extensions.zotero.ztransplit.translate.google.apiKey" type="string"/>
</xul:vbox>
`,
  );
  expect("pane 的 preference 绑定算读取 → S4 PASS", runChecker(root), ALL_PASS);
}

// 21c. Without the pane binding, that same key is a WARN — proves the control
// above actually depends on the xhtml scan.
{
  const root = join(FIXTURES, "pane-binding-absent");
  buildGoodPlugin(root);
  write(
    root,
    "src/core/translation/engine.ts",
    SRC_OK.replace(`export const GKEY = getPrefDynamic("translate.google.apiKey");\n`, ""),
  );
  expect("无 pane 绑定的键 → S4 WARN", runChecker(root), { ...ALL_PASS, S4: "WARN" });
}

// 21b. A doc comment showing an EXAMPLE binding must not count as a read.
{
  const root = join(FIXTURES, "pane-comment-binding");
  buildGoodPlugin(root);
  write(
    root,
    "addon/prefs-pane-note.js",
    `// Example: \`preference="extensions.zotero.ztransplit.…"\` binds a key.\n`,
  );
  expect("注释里的示例绑定不算读取 → S4 PASS", runChecker(root), ALL_PASS);
}

// 22. A declared key bound nowhere (no getPref, no pane binding) stays a WARN.
{
  const root = join(FIXTURES, "orphan-pref");
  buildGoodPlugin(root, {
    prefs:
      PREFS_OK +
      `\npref("extensions.zotero.ztransplit.translate.custom.apiUrl", "");\n`,
  });
  expect("无人读取的声明键 → S4 WARN", runChecker(root), { ...ALL_PASS, S4: "WARN" });
}

// 23. leadero mentioned in comments/provenance (attribution) is allowed;
// 24. an executable import from leadero is not.
{
  const root = join(FIXTURES, "leadero-comment-only");
  buildGoodPlugin(root);
  write(root, "src/utils/text.ts", `// Ported from leadero/src/utils/text.ts (same semantics).\nexport const ID = "text";\n`);
  expect("注释里的 leadero 溯源 → S9 PASS", runChecker(root), ALL_PASS);
}
{
  const root = join(FIXTURES, "leadero-executable");
  buildGoodPlugin(root);
  write(root, "src/utils/bad.ts", `import { helper } from "../leadero/utils/helper";\nexport const X = helper();\n`);
  expect("从 leadero import → S9 FAIL", runChecker(root), { ...ALL_PASS, S9: "FAIL" });
}

console.log(`\n${passed} positive-control groups passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(" | ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
