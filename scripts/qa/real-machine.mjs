/**
 * real-machine.mjs — real-machine (实机) test launcher for z-transplit.
 *
 * Spawns a genuine, unmodified Zotero 10 with:
 *   - an isolated profile + data directory (never touches the user's library),
 *   - the built addon installed as a proxy addon (the same pattern
 *     `zotero-plugin serve` uses),
 *   - a QA driver addon that runs handlers with full chrome privileges.
 *
 * Commands are sent by writing D:\zt-qa\command.json; results land in
 * D:\zt-qa\result.json.
 *
 * Usage:
 *   node scripts/qa/real-machine.mjs boot                  # boot & wait until ready
 *   node scripts/qa/real-machine.mjs send <action> [arg]   # send a command
 *   node scripts/qa/real-machine.mjs shoot                 # close Zotero
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// QA 通道根目录，可用 QA_ROOT 环境变量覆盖以实现多会话隔离。真机测试台的
// 路径原本是硬编码的，本仓库与上游 leadero 共用同一套默认路径时，两个会话的
// command.json / result.json 会互相踩（实测：命令发出后返回的是对方会话的
// 结果）。私有根目录名请避开 "zt-qa" 子串——其他会话的 shoot 按 '*zt-qa*'
// 匹配进程，不含该子串的实例不会被误杀；本文件的 shoot 也只匹配当前
// QA_ROOT，不会碰别人的实例。
const QA_ROOT = process.env.QA_ROOT || "D:\\zt-qa";
const PROBE_ID = "ztransplit-qa-probe@zotero.org";
const ADDON_ID = "ztransplit@zotero.org";
const ZOTERO_BIN = process.env.ZOTERO_BIN || "D:\\zotero10\\zotero.exe";

const cmdDir = QA_ROOT;
const readyFile = path.join(cmdDir, "probe-ready.json");
const cmdFile = path.join(cmdDir, "command.json");
const resultFile = path.join(cmdDir, "result.json");
const zoteroLog = path.join(cmdDir, "zotero-stdout.log");
const pidFile = path.join(cmdDir, "qa-zotero.pid");

const profileDir = path.join(cmdDir, "profile");
const dataDir = path.join(cmdDir, "data");
const extensionsDir = path.join(profileDir, "extensions");

function log(...m) {
  console.log("[real-machine]", ...m);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stopZotero() {
  try {
    execSync("taskkill /f /im zotero.exe", { stdio: "ignore" });
  } catch {
    /* not running */
  }
}

/** Kill only the QA instance(s): every Zotero whose command line points at
 *  the QA profile/data dir. A tree-kill from the recorded root pid misses
 *  content processes that were (re)spawned after the root died. Matched on
 *  the CURRENT QA_ROOT so an isolated run never kills another session's
 *  instance (and vice versa). */
function stopQaZotero() {
  try {
    const ps =
      `Get-CimInstance Win32_Process -Filter "name='zotero.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${QA_ROOT}*' } | ForEach-Object { $_.ProcessId }`;
    const out = execSync(
      `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
      { encoding: "utf8" },
    );
    for (const token of out.split(/\s+/)) {
      const pid = parseInt(token, 10);
      if (pid) {
        try {
          execSync(`taskkill /f /t /pid ${pid}`, { stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* no matching process */
  }
  rmIfExists(pidFile);
}

function rmIfExists(f) {
  // A force-killed Zotero can hold handles for a moment; retry instead of
  // silently leaving a stale profile (a stale extensions.json skips the addon).
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(f, { force: true, recursive: true });
      if (!fs.existsSync(f)) return;
    } catch {
      /* retry */
    }
    sleepSync(500);
  }
  throw new Error("could not remove " + f + " after 10 attempts");
}

function sleepSync(ms) {
  const at = Date.now() + ms;
  // Atomics.wait is the only synchronous sleep that doesn't spin the CPU.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    while (Date.now() < at) {
      /* spin */
    }
  }
}

/** Proxy-addon file: a text file whose content is the addon source dir. */
function writeProxyAddon(id, sourceDir) {
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, id), sourceDir, "utf8");
}

/**
 * Rewrite the hardcoded default QA root ("D:\\zt-qa", source-escaped) inside a
 * probe copy to the current QA_ROOT. No-op when QA_ROOT IS the default — the
 * replacement is then the identity, so shared-channel runs are unaffected.
 */
function patchProbePaths(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const escaped = QA_ROOT.replace(/\\/g, "\\\\");
  fs.writeFileSync(file, text.split("D:\\\\zt-qa").join(escaped), "utf8");
}

/** Directory install: a real copy at extensions/<id>/ (as a user install is). */
function writeDirAddon(id, sourceDir) {
  const dest = path.join(extensionsDir, id);
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(sourceDir, dest, { recursive: true });
}

/**
 * Build the addon-under-test: a copy of the build output whose bootstrap loads
 * the real-machine probe. The shipped build dir is never modified.
 *
 * The addon is installed (unmodified) so we test the artifact users get, and a
 * *second* copy — the probe — is what the launcher drives.
 */
function buildProbeCopy() {
  const src = path.join(ROOT, ".scaffold", "build", "addon");
  const dest = path.join(QA_ROOT, "addon-under-test");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "scripts", "qa", "driver2", "probe.js"),
    path.join(dest, "content", "scripts", "probe.js"),
  );
  // 追加探针（可选存在）：与 probe.js 同一个 scope 对象加载，只往 PROBE_CMDS
  // 上挂额外命令。单独一个文件，避免改动 probe.js 本体——它可能带着其他
  // QA 轮次未提交的改动，混进来会让 diff 分不清归属。
  const extraProbe = path.join(ROOT, "scripts", "qa", "driver2", "probe-extra.js");
  if (fs.existsSync(extraProbe)) {
    fs.copyFileSync(
      extraProbe,
      path.join(dest, "content", "scripts", "probe-extra.js"),
    );
  }
  // 隔离模式收尾：探针副本里硬编码的 D:\zt-qa 改写为当前 QA_ROOT。探针自己
  // 轮询 command.json、落盘 result.json 用的就是硬编码路径，只改启动器不够。
  // 改的是这份 QA 产物副本，scripts/qa/driver2 下的本体不动；QA_ROOT 为默认
  // 值时替换是恒等的，行为零变化。
  patchProbePaths(path.join(dest, "content", "scripts", "probe.js"));
  patchProbePaths(path.join(dest, "content", "scripts", "probe-extra.js"));
  // Patch the bootstrap: after the addon's own startup, load the probe.
  const bootPath = path.join(dest, "bootstrap.js");
  const boot = fs.readFileSync(bootPath, "utf8");
  const patched = boot.replace(
    /await Zotero\.ZTransplit\.hooks\.onStartup\(\);/,
    `await Zotero.ZTransplit.hooks.onStartup();\n  try {\n    const probe = ctx._probe = {};\n    Services.scriptloader.loadSubScript(\`\${rootURI}/content/scripts/probe.js\`, probe);\n    Services.scriptloader.loadSubScript(\`\${rootURI}/content/scripts/probe-extra.js\`, probe);\n    probe.startProbe();\n  } catch (e) {\n    Zotero.logError ? Zotero.logError("[Z-Transplit QA] probe failed: " + e) : Zotero.debug("probe failed: " + e);\n  }`,
  );
  if (!patched.includes("startProbe")) {
    throw new Error("bootstrap patch failed — onStartup marker not found");
  }
  fs.writeFileSync(bootPath, patched, "utf8");
  return dest;
}

function boot() {
  // Kill only OUR previous instance by default; a full machine-wide kill is
  // opt-in (QA_KILL_ALL=1) so the user's own Zotero session survives a QA boot.
  stopQaZotero();
  if (process.env.QA_KILL_ALL) stopZotero();
  sleepSync(1000);
  // A fresh profile each boot: Zotero caches extensions.json and a stale
  // entry would silently skip our addon. The data dir is wiped too unless
  // QA_KEEP_DATA=1, so a pipeline run can be inspected afterwards.
  rmIfExists(profileDir);
  if (!process.env.QA_KEEP_DATA) rmIfExists(dataDir);
  rmIfExists(readyFile);
  rmIfExists(resultFile);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // Zotero discovers exactly one addon per proxy-file install, so the addon
  // under test is the probe copy: the shipped addon, byte-identical except
  // that its bootstrap also loads probe.js. The shipped build dir in
  // .scaffold/build is never touched.
  writeProxyAddon(ADDON_ID, buildProbeCopy());
  log("installed:", fs.readdirSync(extensionsDir).join(", "));

  // QA_LOCALE picks the UI language (default en-US, matching the repo's
  // language-independent QA assertions); QA_EXTRA_PREFS points at a JSON
  // object of extra user_pref values (engine credentials for a shot run —
  // the file lives outside the repo and is never committed).
  const locale = process.env.QA_LOCALE || "en-US";
  const extraPrefs = [];
  if (process.env.QA_EXTRA_PREFS && fs.existsSync(process.env.QA_EXTRA_PREFS)) {
    const parsed = JSON.parse(fs.readFileSync(process.env.QA_EXTRA_PREFS, "utf8"));
    for (const [name, value] of Object.entries(parsed)) {
      extraPrefs.push(
        `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
      );
    }
    log("extra prefs:", Object.keys(parsed).join(", "));
  }

  fs.writeFileSync(
    path.join(profileDir, "prefs.js"),
    [
      `user_pref("extensions.zotero.debug", true);`,
      `user_pref("extensions.zotero.debug.time", true);`,
      `user_pref("extensions.autoDisableScopes", 0);`,
      `user_pref("extensions.lastAppBuildId", "");`,
      `user_pref("extensions.lastAppVersion", "");`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("toolkit.telemetry.enabled", false);`,
      // The UI language under test (en-US keeps QA assertions language-
      // independent; zh-CN exercises the Chinese strings).
      `user_pref("general.useragent.locale", "${locale}");`,
      `user_pref("intl.locale.requested", "${locale}");`,
      ...extraPrefs,
    ].join("\n") + "\n",
    "utf8",
  );

  const out = fs.openSync(zoteroLog, "w");
  log("spawning", ZOTERO_BIN);
  const child = spawn(
    ZOTERO_BIN,
    [
      "--purgecaches",
      "no-remote",
      "-profile",
      profileDir,
      "--dataDir",
      dataDir,
      "-ZoteroDebugText",
    ],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(pidFile, String(child.pid), "utf8");

  return child.pid;
}

async function waitReady(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(readyFile)) {
      log("ready after", Date.now() - t0, "ms");
      return true;
    }
    await sleep(500);
  }
  return false;
}

let cmdCounter = 100;
async function send(action, arg) {
  if (!fs.existsSync(readyFile)) {
    log("waiting for driver ready…");
    if (!(await waitReady())) throw new Error("driver never became ready");
  }
  const id = ++cmdCounter;
  rmIfExists(resultFile);
  fs.writeFileSync(cmdFile, JSON.stringify({ id, action, arg }), "utf8");
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(resultFile)) {
      const raw = fs.readFileSync(resultFile, "utf8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed.id === id) return parsed;
      } catch {
        /* partial write */
      }
    }
    if (Date.now() - t0 > (Number(process.env.QA_CMD_TIMEOUT) || 180000)) {
      throw new Error("command timed out: " + action);
    }
    await sleep(300);
  }
}

const main = process.argv[2];

if (main === "boot") {
  const pid = boot();
  log("pid", pid, "→ log:", zoteroLog);
  const ok = await waitReady();
  log(ok ? "READY" : "TIMEOUT (check zotero-stdout.log / driver.log)");
  process.exit(ok ? 0 : 2);
} else if (main === "wait") {
  const ok = await waitReady();
  log(ok ? "READY" : "TIMEOUT");
  process.exit(ok ? 0 : 2);
} else if (main === "send") {
  const action = process.argv[3];
  const arg = process.argv[4];
  if (!action) {
    log("usage: send <action> [arg]");
    process.exit(1);
  }
  const res = await send(action, arg);
  console.log(JSON.stringify(res, null, 2));
} else if (main === "shoot") {
  // Default: close only the QA instance. QA_KILL_ALL=1 keeps the old
  // machine-wide behaviour for CI-style runs.
  if (process.env.QA_KILL_ALL) stopZotero();
  else stopQaZotero();
  log("zotero stopped");
} else if (main === "log") {
  const which = process.argv[3] === "zotero" ? zoteroLog : zoteroLog;
  const text = fs.existsSync(which) ? fs.readFileSync(which, "utf8") : "(no log)";
  const lines = text.split("\n");
  console.log(
    lines.length > 200
      ? lines.slice(-200).join("\n") + "\n… (showing last 200 of " + lines.length + ")"
      : text,
  );
} else {
  log(`Commands:
  boot     launch Zotero with the QA profile and wait until the driver is ready
  wait     wait for the driver to become ready
  send <action> [arg]   run a driver handler and print its JSON result
  shoot    kill Zotero
  log [driver|zotero]   tail the logs`);
  process.exit(1);
}
