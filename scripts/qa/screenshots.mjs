/**
 * screenshots.mjs — README screenshot driver.
 *
 * Boots the real-machine QA harness (see real-machine.mjs) in a chosen UI
 * language, drives Zotero through the six states the README screenshots show,
 * and captures each with the probe's `shot` command.
 *
 * Translation credentials come from a JSON file (QA_EXTRA_PREFS / --prefs)
 * with `user_pref` values for the AI engine; the file lives outside the repo.
 *
 * Usage:
 *   node scripts/qa/screenshots.mjs --locale en-US --out docs/screenshots \
 *        --prefs D:\zt-qa\qa-shot-prefs.json
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const QA_ROOT = "D:\\zt-qa";
const readyFile = path.join(QA_ROOT, "probe-ready.json");
const cmdFile = path.join(QA_ROOT, "command.json");
const resultFile = path.join(QA_ROOT, "result.json");
const pidFile = path.join(QA_ROOT, "qa-zotero.pid");
const FIXTURE = path.join(ROOT, "scripts", "qa", "fixtures", "reading-brain.pdf");

function log(...m) {
  console.log("[screenshots]", ...m);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── args ────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const locale = arg("locale", "en-US");
const outDir = path.resolve(ROOT, arg("out", locale === "zh-CN" ? "docs/screenshots/zh-CN" : "docs/screenshots"));
const prefsFile = arg("prefs", process.env.QA_EXTRA_PREFS);
if (!prefsFile || !fs.existsSync(prefsFile)) {
  log("missing --prefs JSON (AI engine credentials) — see file header");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// ── harness control (same protocol as real-machine.mjs) ─────────────────────
async function waitReady(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(readyFile)) return true;
    await sleep(500);
  }
  return false;
}

async function boot() {
  execSync("node scripts/qa/real-machine.mjs shoot", { cwd: ROOT, stdio: "ignore" });
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "scripts", "qa", "real-machine.mjs"), "boot"],
    {
      cwd: ROOT,
      env: { ...process.env, QA_LOCALE: locale, QA_EXTRA_PREFS: prefsFile },
      stdio: "inherit",
    },
  );
  const ok = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code === 0 && fs.existsSync(readyFile)));
    child.on("error", () => resolve(false));
  });
  if (!ok) throw new Error("boot failed — see [real-machine] output above");
}

let cmdCounter = 1000;
async function send(action, argValue, timeoutMs = 180000) {
  if (!fs.existsSync(readyFile)) {
    if (!(await waitReady())) throw new Error("driver not ready");
  }
  const id = ++cmdCounter;
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(cmdFile, JSON.stringify({ id, action, arg: argValue }), "utf8");
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        if (parsed.id === id) return parsed;
      } catch {
        /* partial write */
      }
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error("command timed out: " + action);
    }
    await sleep(300);
  }
}

async function run(action, argValue, { must = true, timeoutMs } = {}) {
  log("→", action, typeof argValue === "string" ? argValue : "");
  const res = await send(action, argValue, timeoutMs);
  // The envelope can be ok while the handler reports a soft error inside.
  if (!res.ok || res.result?.error) {
    log("  FAILED:", JSON.stringify(res).slice(0, 600));
    if (must) throw new Error(action + " failed");
    return res;
  }
  log("  ok:", JSON.stringify(res.result).slice(0, 300));
  return res.result;
}

async function shot(name) {
  const file = path.join(outDir, name + ".png");
  await run("shot", { file, win: "main" });
  log("  saved", file);
}

async function shutdown() {
  try {
    execSync("node scripts/qa/real-machine.mjs shoot", { cwd: ROOT, stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

const ABSTRACT =
  "Reading is a complex cognitive activity that involves multiple brain regions. " +
  "In this paper, we review recent evidence from longitudinal studies of children " +
  "and discuss how structured reading practice shapes neural circuits over time. " +
  "We argue that comprehension improves when instruction follows the natural rhythm " +
  "of attention, and we outline a set of classroom experiments that test the claim directly.";

try {
  await boot();

  await run("maximize");
  await run("demoItem", {
    pdf: FIXTURE,
    title: "Reading and the Brain",
    filename: "reading-brain.pdf",
  });

  // 1. Selection translation: stage the abstract, translate to zh-CN.
  const st = await run("selectTranslate", { text: ABSTRACT, targetLang: "zh-CN" });
  if (st.state !== "done") log("  (selection translate state:", st.state, ")");
  await sleep(800);
  await shot("selection-translate");

  // 2. Full-text pipeline through the real item-tree menu entry.
  await run("itemtree", "attachment", { timeoutMs: 300000 });
  // The pipeline keeps running after the menu handler returns; poll for the
  // translated attachment (openTranslated also (re)opens its tab).
  let translated = null;
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    translated = await run("openTranslated", undefined, { must: false });
    if (translated?.opened) break;
  }
  if (!translated?.opened) throw new Error("pipeline never produced the translated attachment");
  // Reader-only framing: the reader fills the window (like a user who opened
  // the produced attachment from the item list).
  await run("frame", { collections: "close", contextPane: "close", itemPane: "close" });
  await sleep(1500);
  await shot("translated-attachment");

  // 3. Split view: reuse the translation, then push the PDFs to the fore —
  //    collections pane and both item panes closed so readers fill the window.
  await run("demoTab");
  await run("menus", "split");
  await sleep(6000);
  await run("frame", { collections: "close", contextPane: "close", itemPane: "close" });
  await sleep(1200);
  await shot("split-view");

  // 4/5. Bilingual interleave + translation-only on the source reader tab.
  await run("demoTab");
  await run("frame", { contextPane: "open" });
  await run("bilingual", undefined, { timeoutMs: 240000 });
  await run("bilingualWait", 240000, { timeoutMs: 260000 });
  await sleep(1500);
  await shot("bilingual-interleave");
  await run("bilingualMode", "only");
  await sleep(1200);
  await shot("translation-only");

  // 6. AI engine settings pane (engine configured via boot prefs).
  await run("prefsOpen");
  await sleep(1000);
  const prefsShot = path.join(outDir, "ai-engine.png");
  await run("shot", { file: prefsShot, win: "prefs" });
  log("  saved", prefsShot);
  await run("prefsClose");

  log("DONE →", outDir);
} finally {
  await shutdown();
}
