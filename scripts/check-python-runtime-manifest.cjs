#!/usr/bin/env node
/**
 * check-python-runtime-manifest — 对账随包的 Python 运行时构件清单。
 *
 * 清单（src/core/pdf/lib/PYTHON-RUNTIME.json）是分发的第一环：选错平台、
 * 漏一个平台、文件名与上游对不上，都会在用户的下载里才爆炸，因此随包数据
 * 必须过结构化对账。本脚本查的是"数据卫生"，与运行期解析器
 * （src/core/pdf/scan/pythonRuntimeManifest.ts）的分工：解析器保证插件拿到
 * 的结构一定合法（不合法就拒绝安装），本脚本保证随包的那份数据本身没写错。
 *
 * 结构检查（默认，离线）：
 *   - schema 版本、必填字段、https 地址；
 *   - 六个平台必须齐且不重复——漏一个，该平台用户装不上，且失败点在后半夜
 *     的下载里；
 *   - 文件名不带路径分隔符（拼 URL 不会越界）、含发行标签；
 *   - 可执行路径按平台约定（Windows 是 python/python.exe，Unix 是
 *     python/bin/python3）——与实测的 install_only 构件布局一致；
 *   - 镜像条目唯一且为 https；更新说明必须随数据一起带（否则下一个人不敢动）。
 *
 * 联网核对（--online，默认不跑：门禁不能依赖外网）：
 *   - 取上游 SHA256SUMS，逐个构件名核对存在；顺带报出每个构件的体积。
 *
 * 用法：
 *   node scripts/check-python-runtime-manifest.cjs [--online]
 */

const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = path.resolve(
  __dirname,
  "..",
  "src",
  "core",
  "pdf",
  "lib",
  "PYTHON-RUNTIME.json",
);

const SCHEMA = "ztransplit-python-runtime/1";
const PLATFORMS = [
  "win-x64",
  "win-arm64",
  "mac-x64",
  "mac-arm64",
  "linux-x64",
  "linux-arm64",
];
const REQUIRED_STRINGS = [
  "name",
  "upstream",
  "license",
  "release",
  "pythonVersion",
  "verifiedAt",
  "sha256Sums",
  "consumedBy",
];

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

function isHttps(v) {
  return typeof v === "string" && /^https:\/\//i.test(v.trim());
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function checkStructure(m) {
  if (m.schema !== SCHEMA) {
    fail(`schema 应为 ${SCHEMA}，实际 ${JSON.stringify(m.schema)}`);
  }
  for (const key of REQUIRED_STRINGS) {
    if (!isNonEmptyString(m[key])) fail(`缺少必填字段 ${key}`);
  }
  if (!isHttps(m.sha256Sums)) fail("sha256Sums 必须是 https 地址");
  if (m.sha256Sums && !m.sha256Sums.endsWith("/SHA256SUMS")) {
    fail("sha256Sums 应指向发行版的 SHA256SUMS 文件（信任锚）");
  }

  if (!Array.isArray(m.mirrors)) {
    fail("mirrors 必须是数组（可为空）");
  } else {
    const ids = new Set();
    for (const mirror of m.mirrors) {
      if (!isNonEmptyString(mirror?.id)) fail("mirrors 有条目缺 id");
      if (!isHttps(mirror?.base)) fail(`镜像 ${mirror?.id} 的 base 必须是 https`);
      if (mirror?.id && ids.has(mirror.id)) fail(`镜像 id 重复：${mirror.id}`);
      ids.add(mirror?.id);
    }
  }

  if (!Array.isArray(m.artifacts)) {
    fail("artifacts 必须是数组");
    return;
  }
  const seen = new Set();
  for (const a of m.artifacts) {
    if (!PLATFORMS.includes(a?.platform)) {
      fail(`平台不在覆盖表内：${JSON.stringify(a?.platform)}`);
      continue;
    }
    if (seen.has(a.platform)) fail(`平台重复：${a.platform}`);
    seen.add(a.platform);
    if (!isNonEmptyString(a.file)) fail(`${a.platform} 缺文件名`);
    else if (/[\\/]/.test(a.file)) fail(`${a.platform} 文件名不能带路径分隔符：${a.file}`);
    else if (m.release && !a.file.includes(m.release)) {
      fail(`${a.platform} 文件名不含发行标签 ${m.release}：${a.file}`);
    }
    if (!isNonEmptyString(a.executable)) fail(`${a.platform} 缺可执行路径`);
    else if (a.executable.includes("..")) fail(`${a.platform} 可执行路径含 ..：${a.executable}`);
    else {
      const isWin = a.platform.startsWith("win-");
      const expected = isWin ? "python/python.exe" : "python/bin/python3";
      if (a.executable !== expected) {
        fail(`${a.platform} 可执行路径应为 ${expected}，实际 ${a.executable}`);
      }
    }
  }
  for (const p of PLATFORMS) {
    if (!seen.has(p)) fail(`缺少平台 ${p}——该平台用户装不上，且失败点在下载里`);
  }

  if (!Array.isArray(m.howToUpdate) || m.howToUpdate.length === 0) {
    fail("howToUpdate 必须随数据一起带（否则下一个人不敢动这份清单）");
  }
  if (!isNonEmptyString(m.consumedBy)) fail("consumedBy 必须指明消费方源码");
}

/** SHA256SUMS 行 → Map<文件名, 指纹>。 */
function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

async function checkOnline(m) {
  const resp = await fetch(m.sha256Sums, {
    headers: { "User-Agent": "z-transplit-manifest-check" },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    fail(`SHA256SUMS 取不到：HTTP ${resp.status} ${m.sha256Sums}`);
    return;
  }
  const sums = parseSums(await resp.text());
  if (sums.size === 0) {
    fail("SHA256SUMS 内容为空或格式不符");
    return;
  }
  for (const a of m.artifacts) {
    const sha = sums.get(a.file);
    if (!sha) {
      fail(`SHA256SUMS 里没有 ${a.platform} 的构件：${a.file}`);
      continue;
    }
    notes.push(`OK   ${a.platform}  ${a.file}  ${sha.slice(0, 16)}…`);
  }

  // 镜像只送字节、不承担信任：逐个确认构件可达（区间请求即可）。
  for (const mirror of m.mirrors || []) {
    for (const a of m.artifacts) {
      const url = `${mirror.base.replace(/\/+$/, "")}/${encodeURIComponent(
        m.release,
      )}/${encodeURIComponent(a.file)}`;
      try {
        const head = await fetch(url, {
          method: "GET",
          headers: { Range: "bytes=0-0", "User-Agent": "z-transplit-manifest-check" },
          signal: AbortSignal.timeout(30000),
        });
        if (head.status !== 206 && head.status !== 200) {
          fail(`镜像 ${mirror.id} 取不到 ${a.platform}：HTTP ${head.status}`);
        }
      } catch (e) {
        fail(`镜像 ${mirror.id} 取不到 ${a.platform}：${e.message}`);
      }
    }
    notes.push(`OK   镜像 ${mirror.id} 六个构件全部可达`);
  }
}

async function main() {
  const online = process.argv.includes("--online");
  if (!fs.existsSync(MANIFEST)) {
    console.error(`FAIL: 清单不存在：${MANIFEST}`);
    process.exit(1);
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
  } catch (e) {
    console.error(`FAIL: 清单不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  checkStructure(m);
  if (online && problems.length === 0) {
    try {
      await checkOnline(m);
    } catch (e) {
      // 代理环境里 Node 的 fetch 可能根本连不上（curl 却可以）——在线模式
      // 本来就不进门禁，失败时说清楚是网络不可达，别让人以为清单坏了。
      fail(`联网核对失败（网络不可达？）：${e.cause?.message || e.message}`);
    }
  }

  for (const n of notes) console.log(n);
  for (const p of problems) console.error(`FAIL: ${p}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} 个问题`);
    process.exit(1);
  }
  console.log(
    `OK: PYTHON-RUNTIME.json（发行 ${m.release}，CPython ${m.pythonVersion}，` +
      `${m.artifacts.length} 个平台构件${online ? "，联网核对通过" : ""}）`,
  );
}

main();
