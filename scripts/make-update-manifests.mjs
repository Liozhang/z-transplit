#!/usr/bin/env node
/**
 * 生成 Zotero 自动更新清单 update.json / update-beta.json。
 *
 * 背景：插件的 updateURL 指向 `releases/download/release/update.json`（仓库
 * 的 `release` 标签预发布），Zotero 启动时轮询它决定要不要升级。2026-10 发
 * 现这份清单从 1.9.0 起一直停在 1.8.1——手工发布时忘了更新，自动更新链路
 * 失效了五个版本。本脚本把清单生成固化下来，发布流水线（CI）每次推标签都
 * 重新生成并上传，杜绝复发。
 *
 * 清单内容：当前 package.json 版本、精简版 XPI 的 sha512（update_hash）、
 * 指向 `v<版本>` 发布的 update_link。两个文件内容相同（beta 通道通过版本号
 * 里的连字符区分，见 zotero-plugin.config.ts 的 updateURL）。
 *
 * 用法：
 *   node scripts/make-update-manifests.mjs <slim-xpi-path> [输出目录]
 *
 * 输出目录缺省为 <slim-xpi 同级>/update/。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const { version } = pkg;
// XPI 文件名由 scaffold 按 package.json 的 name 生成（z-transplit.xpi），
// 不是 config.addonName（Z-Transplit，显示名，带大写）。
const xpiName = pkg.name;

const [, , xpiArg, outArg] = process.argv;
if (!xpiArg) {
  console.error("usage: node scripts/make-update-manifests.mjs <slim-xpi-path> [out-dir]");
  process.exit(1);
}
const xpiPath = resolve(xpiArg);
const outDir = resolve(outArg || join(dirname(xpiPath), "update"));

const sha512 = createHash("sha512").update(readFileSync(xpiPath)).digest("base64");
const repo = `https://github.com/${process.env.GITHUB_REPOSITORY || "Liozhang/z-transplit"}`;

const manifest = {
  addons: {
    [pkg.config.addonID]: {
      updates: [
        {
          version,
          update_link: `${repo}/releases/download/v${version}/${xpiName}.xpi`,
          update_hash: `sha512:${sha512}`,
          applications: {
            zotero: { strict_min_version: "10.0", strict_max_version: "10.*" },
          },
        },
      ],
    },
  },
};

mkdirSync(outDir, { recursive: true });
for (const name of ["update.json", "update-beta.json"]) {
  const p = join(outDir, name);
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`wrote ${p}`);
}
console.log(`version=${version} sha512(base64)=${sha512.slice(0, 16)}...`);
