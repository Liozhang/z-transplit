#!/usr/bin/env node
/**
 * check-jar-provenance — 把 src/core/pdf/lib/ 下的 jar 与各自的 PROVENANCE 清单
 * 记录的 sha256 + 字节数对账，不一致即退出码 1。
 *
 * 清单文件（与 jar 同目录）：
 *   - PROVENANCE.json                        → opendataloader-pdf-cli.jar
 *   - PROVENANCE-region-text-remover.json    → ztransplit-region-text-remover.jar
 *
 * 清单的 howToUpdate 引用本脚本：换入新 jar 后，先从新 jar 的 META-INF 更新
 * version / sha256 / bytes 等字段（别手抄，从 jar 里读），再跑本脚本确认对上了。
 *
 * 用法：node scripts/check-jar-provenance.cjs
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "src", "core", "pdf", "lib");

// 清单文件 → 对应 jar 文件名
const MANIFESTS = [
  { manifest: "PROVENANCE.json", jar: "opendataloader-pdf-cli.jar" },
  { manifest: "PROVENANCE-region-text-remover.json", jar: "ztransplit-region-text-remover.jar" },
];

let failed = false;

for (const { manifest, jar: jarName } of MANIFESTS) {
  const manifestPath = path.join(dir, manifest);
  const jarPath = path.join(dir, jarName);
  const relJar = path.relative(root, jarPath);
  const relManifest = path.relative(root, manifestPath);

  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`FAIL: cannot read ${relManifest}: ${e.message}`);
    failed = true;
    continue;
  }

  if (!fs.existsSync(jarPath)) {
    console.error(`FAIL: ${relJar} not found`);
    failed = true;
    continue;
  }

  const bytes = fs.statSync(jarPath).size;
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(jarPath))
    .digest("hex");

  const problems = [];
  if (provenance.file && jarName !== provenance.file) {
    problems.push(`file: manifest says ${provenance.file}, found ${jarName}`);
  }
  if (provenance.bytes !== bytes) {
    problems.push(`bytes: manifest says ${provenance.bytes}, actual ${bytes}`);
  }
  if (provenance.sha256 !== sha256) {
    problems.push(`sha256: manifest says ${provenance.sha256}, actual ${sha256}`);
  }

  if (problems.length > 0) {
    console.error(`FAIL: ${relJar} does not match ${relManifest}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "Update the provenance manifest from the new jar's META-INF (see howToUpdate), or restore the recorded jar.",
    );
    failed = true;
    continue;
  }

  console.log(`OK: ${relJar}`);
  console.log(`  bytes  = ${bytes}`);
  console.log(`  sha256 = ${sha256}`);
}

process.exit(failed ? 1 : 0);
