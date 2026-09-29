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
const QA_ROOT = "D:\\zt-qa";
const PROBE_ID = "ztransplit-qa-probe@zotero.org";
const ADDON_ID = "ztransplit@zotero.org";
const ZOTERO_BIN = process.env.ZOTERO_BIN || "D:\\zotero10\\zotero.exe";

const cmdDir = QA_ROOT;
const readyFile = path.join(cmdDir, "probe-ready.json");
const cmdFile = path.join(cmdDir, "command.json");
const resultFile = path.join(cmdDir, "result.json");
const zoteroLog = path.join(cmdDir, "zotero-stdout.log");

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

function rmIfExists(f) {
  try {
    fs.rmSync(f, { force: true });
  } catch {
    /* ignore */
  }
}

/** Proxy-addon file: a text file whose content is the addon source dir. */
function writeProxyAddon(id, sourceDir) {
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, id), sourceDir, "utf8");
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
  const dest = "D:\\zt-qa\\addon-under-test";
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "scripts", "qa", "driver2", "probe.js"),
    path.join(dest, "content", "scripts", "probe.js"),
  );
  // Patch the bootstrap: after the addon's own startup, load the probe.
  const bootPath = path.join(dest, "bootstrap.js");
  const boot = fs.readFileSync(bootPath, "utf8");
  const patched = boot.replace(
    /await Zotero\.ZTransplit\.hooks\.onStartup\(\);/,
    `await Zotero.ZTransplit.hooks.onStartup();\n  try {\n    const probe = ctx._probe = {};\n    Services.scriptloader.loadSubScript(\`\${rootURI}/content/scripts/probe.js\`, probe);\n    probe.startProbe();\n  } catch (e) {\n    Zotero.logError ? Zotero.logError("[Z-Transplit QA] probe failed: " + e) : Zotero.debug("probe failed: " + e);\n  }`,
  );
  if (!patched.includes("startProbe")) {
    throw new Error("bootstrap patch failed — onStartup marker not found");
  }
  fs.writeFileSync(bootPath, patched, "utf8");
  return dest;
}

function boot() {
  stopZotero();
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
      // English UI keeps the QA assertions language-independent.
      `user_pref("general.useragent.locale", "en-US");`,
      `user_pref("intl.locale.requested", "en-US");`,
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
  stopZotero();
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
