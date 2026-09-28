#!/usr/bin/env node
/**
 * check-jar-provenance — 把 src/core/pdf/lib/opendataloader-pdf-cli.jar 与同目录
 * PROVENANCE.json 记录的 sha256 + 字节数对账，不一致即退出码 1。
 *
 * PROVENANCE.json 的 howToUpdate 引用本脚本：换入新 jar 后，先从新 jar 的
 * META-INF 更新 version / sha256 / bytes / jarRequiresJava / builtWithJdk /
 * bundledLicenses（别手抄，从 jar 里读），再跑本脚本确认对上了。
 *
 * 用法：node scripts/check-jar-provenance.cjs
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "src", "core", "pdf", "lib");
const manifestPath = path.join(dir, "PROVENANCE.json");
const jarPath = path.join(dir, "opendataloader-pdf-cli.jar");

let provenance;
try {
  provenance = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(
    `FAIL: cannot read ${path.relative(root, manifestPath)}: ${e.message}`,
  );
  process.exit(1);
}

const rel = path.relative(root, jarPath);
if (!fs.existsSync(jarPath)) {
  console.error(`FAIL: ${rel} not found`);
  process.exit(1);
}

const bytes = fs.statSync(jarPath).size;
const sha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(jarPath))
  .digest("hex");

const problems = [];
if (provenance.file && path.basename(jarPath) !== provenance.file) {
  problems.push(
    `file: manifest says ${provenance.file}, found ${path.basename(jarPath)}`,
  );
}
if (provenance.bytes !== bytes) {
  problems.push(`bytes: manifest says ${provenance.bytes}, actual ${bytes}`);
}
if (provenance.sha256 !== sha256) {
  problems.push(`sha256: manifest says ${provenance.sha256}, actual ${sha256}`);
}

if (problems.length > 0) {
  console.error(
    `FAIL: ${rel} does not match ${path.relative(root, manifestPath)}:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "Update PROVENANCE.json from the new jar's META-INF (see howToUpdate), or restore the recorded jar.",
  );
  process.exit(1);
}

console.log(`OK: ${rel}`);
console.log(`  bytes  = ${bytes}`);
console.log(`  sha256 = ${sha256}`);
