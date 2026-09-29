#!/usr/bin/env node
/**
 * 构建 Z-Transplit 原文删除器 fat jar 并生成溯源清单。
 *
 * 用法: node scripts/build-region-text-remover.cjs
 * 要求: PATH 上有 JDK 17+（javac 与 jar 工具）。
 *
 * 步骤:
 *   1. javac 编译 java/region-text-remover/src/*.java（classpath = lib 下三个依赖 jar）
 *   2. 把依赖 jar 解包进同一 classes 目录（fat jar，免去跨平台 classpath 分隔符问题）
 *   3. 打包为 src/core/pdf/lib/ztransplit-region-text-remover.jar（Main-Class: RegionTextRemover）
 *   4. 实测字节数与 sha256，写 src/core/pdf/lib/PROVENANCE-region-text-remover.json
 *   5. 冒烟验证: java -jar 输出 usage（退出码 2）
 */
"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "java", "region-text-remover", "src");
const LIB_DIR = path.join(ROOT, "java", "region-text-remover", "lib");
const OUT_DIR = path.join(ROOT, "src", "core", "pdf", "lib");
const JAR_NAME = "ztransplit-region-text-remover.jar";
const JAR_PATH = path.join(OUT_DIR, JAR_NAME);
const PROVENANCE_PATH = path.join(OUT_DIR, "PROVENANCE-region-text-remover.json");
const BUILD_DIR = path.join(ROOT, ".scaffold", "build", "region-text-remover");

function fail(message) {
  console.error("[build-region-text-remover] " + message);
  process.exit(1);
}

function run(cmd, args, options) {
  try {
    return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...options });
  } catch (e) {
    fail(`命令失败: ${cmd} ${args.join(" ")}\n${e.stdout || ""}\n${e.stderr || e.message}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ── 1. 环境检查 ────────────────────────────────────────────────
if (!fs.existsSync(SRC_DIR)) fail(`缺少源码目录: ${SRC_DIR}`);
if (!fs.existsSync(LIB_DIR)) fail(`缺少依赖目录: ${LIB_DIR}`);
const depJars = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".jar"));
if (depJars.length === 0) fail(`依赖目录没有 jar: ${LIB_DIR}`);

// ── 2. 编译 ────────────────────────────────────────────────────
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD_DIR, "classes"), { recursive: true });
const classpath = depJars.map((j) => path.join(LIB_DIR, j)).join(path.delimiter);
const sources = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".java")).map((f) => path.join(SRC_DIR, f));
run("javac", [
  "-encoding", "UTF-8",
  "-source", "17",
  "-target", "17",
  "-cp", classpath,
  "-d", path.join(BUILD_DIR, "classes"),
  ...sources,
]);
console.log(`[build-region-text-remover] compiled ${sources.length} source file(s)`);

// ── 3. 解包依赖（fat jar）─────────────────────────────────────
// JDK 17 的 jar 工具解包只能输出到当前目录，因此以 classes 目录为工作目录执行
for (const jar of depJars) {
  run("jar", ["--extract", "--file", path.join(LIB_DIR, jar)], { cwd: path.join(BUILD_DIR, "classes") });
}
// 依赖自带签名文件与 fat jar 不兼容（安全校验会失败），剥掉
const metaInf = path.join(BUILD_DIR, "classes", "META-INF");
if (fs.existsSync(metaInf)) {
  for (const entry of fs.readdirSync(metaInf)) {
    if (entry.endsWith(".SF") || entry.endsWith(".DSA") || entry.endsWith(".RSA")) {
      fs.rmSync(path.join(metaInf, entry));
    }
  }
}

// ── 4. 打包 ────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const manifestPath = path.join(BUILD_DIR, "manifest.mf");
fs.writeFileSync(manifestPath, "Main-Class: RegionTextRemover\r\n");
if (fs.existsSync(JAR_PATH)) fs.rmSync(JAR_PATH);
run("jar", [
  "--create",
  "--file", JAR_PATH,
  "--manifest", manifestPath,
  "-C", path.join(BUILD_DIR, "classes"), ".",
]);
console.log(`[build-region-text-remover] jar written: ${JAR_PATH}`);

// ── 5. 冒烟验证 ────────────────────────────────────────────────
let smokeCode = 0;
try {
  execFileSync("java", ["-jar", JAR_PATH], { stdio: "pipe" });
} catch (e) {
  smokeCode = e.status === undefined ? -1 : e.status;
}
if (smokeCode !== 2) {
  fail(`冒烟验证失败: java -jar 应以退出码 2 输出 usage，实际 ${smokeCode}`);
}
console.log("[build-region-text-remover] smoke ok (usage exit=2)");

// ── 6. 溯源清单 ────────────────────────────────────────────────
const bytes = fs.statSync(JAR_PATH).size;
const sha256 = sha256File(JAR_PATH);
const provenance = {
  artifact: "org.ztransplit:region-text-remover:1.0.0",
  name: "Z-Transplit Original-Text Remover",
  version: "1.0.0",
  file: JAR_NAME,
  sha256,
  bytes,
  mainClass: "RegionTextRemover",
  jarRequiresJava: 17,
  builtWithJdk: 17,
  bundledLicenses: [
    "Apache-2.0 (Apache PDFBox, Apache FontKit)",
    "Apache-2.0 (commons-logging)",
    "MIT (Z-Transplit 自有代码)",
  ],
  licenseSource: "构建脚本 java/region-text-remover/lib/ 内的依赖 jar 与 java/region-text-remover/src/ 自有源码",
  consumedBy: "src/core/pdf/OriginalTextRemovalClient.ts（java -jar 子进程，翻译前删除页面层原文）",
  whyInSourceTree: "运行期真实依赖：删除原文时必须能在磁盘上找到这个 jar。由 git 直接承载（约 4.5MB）。",
  howToUpdate: [
    "1. 修改 java/region-text-remover/src/ 后运行 node scripts/build-region-text-remover.cjs",
    "2. 脚本自动重算 sha256 与字节数并更新本文件",
    "3. 跑 node scripts/check-jar-provenance.cjs 对账",
  ],
  sourceOfTruth: "java/region-text-remover/src（本 jar 由构建脚本生成，勿手改）",
};
fs.writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2) + "\n");
console.log(`[build-region-text-remover] provenance written: ${PROVENANCE_PATH} (bytes=${bytes})`);
console.log("[build-region-text-remover] OK");
