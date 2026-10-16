/**
 * windows-unicode-probe.mjs — minimal reusable launcher for the Issue #1
 * real-host regression (Windows Unicode Java invocation + failure diagnostics).
 *
 * Builds an isolated diagnostic addon that embeds the PRODUCTION runner
 * (scripts/qa/windows-unicode-probe-entry.ts bundled with the project's
 * esbuild), installs it into a fresh profile + data directory, and starts a
 * real Zotero instance (GUI or headless) whose bootstrap auto-runs the
 * scenarios and writes results.json. Nothing outside the output root is
 * written; only the launcher's own PID tree is ever stopped.
 *
 * Usage:
 *   node scripts/qa/windows-unicode-probe.mjs --mode gui
 *   node scripts/qa/windows-unicode-probe.mjs --mode headless
 *   node scripts/qa/windows-unicode-probe.mjs --mode both \
 *     [--zotero <zotero.exe>] [--java <java.exe>] [--jar <odl.jar>] \
 *     [--remover-jar <remover.jar>] [--out <root>] [--javac <javac>]
 *
 * Defaults: zotero = D:\Tool\Zotero\zotero.exe (or %ZOTERO_BIN%);
 *           java   = %ODL_JAVA% or the managed JRE under the Zotero data dir;
 *           jar    = src/core/pdf/lib/opendataloader-pdf-cli.jar (repo copy);
 *           out    = D:\Develop\Misc Workspace\archive\z-transplit-issue-1-regression.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_IDS,
  buildLaunchEnv,
  stopOwnProcesses,
  evaluateRun,
} from "./windows-unicode-probe-gates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = "D:\\Develop\\Misc Workspace\\archive\\z-transplit-issue-1-regression";
const EXPECTED_SHA256 =
  "80a0196f1bdfe33f3b16a0bdca5c49072b2947ccae93af7a41153cfc5c41d8d6";

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    mode: "both",
    zotero: process.env.ZOTERO_BIN || "D:\\Tool\\Zotero\\zotero.exe",
    java: process.env.ODL_JAVA || "",
    jar: path.join(ROOT, "src", "core", "pdf", "lib", "opendataloader-pdf-cli.jar"),
    removerJar: path.join(ROOT, "src", "core", "pdf", "lib", "ztransplit-region-text-remover.jar"),
    out: DEFAULT_OUT,
    javac: process.env.JAVAC || "",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") opts.mode = next();
    else if (a === "--zotero") opts.zotero = next();
    else if (a === "--java") opts.java = next();
    else if (a === "--jar") opts.jar = next();
    else if (a === "--remover-jar") opts.removerJar = next();
    else if (a === "--out") opts.out = next();
    else if (a === "--javac") opts.javac = next();
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!["gui", "headless", "both"].includes(opts.mode)) {
    console.error(`--mode must be gui|headless|both, got ${opts.mode}`);
    process.exit(2);
  }
  return opts;
}

function log(...m) {
  console.log("[unicode-probe]", ...m);
}

function die(msg) {
  console.error("[unicode-probe] FATAL:", msg);
  process.exit(1);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function findManagedJava() {
  // Same layout JavaRuntimeManager uses: {ZoteroDataDir}/ztransplit/java-runtime/*/bin/java.exe
  const candidates = [
    path.join(os.homedir(), "Zotero", "ztransplit", "java-runtime"),
    path.join(os.homedir(), "Zotero", "zotero", "ztransplit", "java-runtime"),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^(jdk|jre)-/i.test(name)) continue;
      for (const tail of [
        ["bin", "java.exe"],
        ["Contents", "Home", "bin", "java.exe"],
      ]) {
        const p = path.join(dir, name, ...tail);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return "";
}

function findJavac(opts) {
  if (opts.javac) return opts.javac;
  // PATH first…
  try {
    const out = execFileSync("where", ["javac"], { encoding: "utf8" }).trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    /* not on PATH */
  }
  // …then a known JetBrains Runtime install (present on the dev machine).
  const jbrGlob = path.join("D:\\Develop", "PyCharm 2026.2.3", "jbr", "bin", "javac.exe");
  if (fs.existsSync(jbrGlob)) return jbrGlob;
  return "";
}

function sha256File(p) {
  return (
    "sha256:" +
    execFileSync("certutil", ["-hashfile", p, "SHA256"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^[0-9a-f]{64}$/i.test(l))
      .toLowerCase()
  );
}

function sha256Hex(p) {
  return sha256File(p).replace("sha256:", "");
}

const FIXTURE_SOURCE = `import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

/**
 * Issue #1 real-host QA fixture. Modes:
 *   both <exitCode> [tag]      — UTF-8 marker lines on stdout+stderr, exit N
 *   argv                       — echo each argv entry as "ARG:<raw>"
 *   big <kbOut> <kbErr>        — large dual-stream output
 *   sleep <ms>                 — print PID=..., flush, sleep
 *   sleep-child <ms>           — spawn a child (ping loop), print PID=/CHILD=, sleep
 */
public class QaFixture {
  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    PrintStream err = new PrintStream(System.err, true, StandardCharsets.UTF_8);
    String mode = args.length > 0 ? args[0] : "";

    switch (mode) {
      case "both": {
        int code = args.length > 1 ? Integer.parseInt(args[1]) : 0;
        String tag = args.length > 2 ? args[2] : "";
        out.println("STDOUT-中文-OK " + tag);
        err.println("STDERR-中文-OK " + tag);
        System.exit(code);
        break;
      }
      case "argv": {
        for (int i = 1; i < args.length; i++) {
          out.println("ARG:" + args[i]);
        }
        break;
      }
      case "big": {
        int kbOut = args.length > 1 ? Integer.parseInt(args[1]) : 64;
        int kbErr = args.length > 2 ? Integer.parseInt(args[2]) : 64;
        byte[] outUnit = "x-中文-out\\n".getBytes(StandardCharsets.UTF_8);
        byte[] errUnit = "y-中文-err\\n".getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < (kbOut * 1024 + outUnit.length - 1) / outUnit.length; i++) {
          System.out.write(outUnit);
        }
        for (int i = 0; i < (kbErr * 1024 + errUnit.length - 1) / errUnit.length; i++) {
          System.err.write(errUnit);
        }
        System.out.flush();
        System.err.flush();
        break;
      }
      case "sleep": {
        long ms = args.length > 1 ? Long.parseLong(args[1]) : 60000;
        out.println("PID=" + ProcessHandle.current().pid());
        out.flush();
        Thread.sleep(ms);
        break;
      }
      case "sleep-child": {
        long ms = args.length > 1 ? Long.parseLong(args[1]) : 60000;
        ProcessBuilder pb = new ProcessBuilder(
            "cmd.exe", "/c", "ping -n 300 127.0.0.1 >NUL");
        pb.redirectErrorStream(true);
        Process child = pb.start();
        out.println("PID=" + ProcessHandle.current().pid());
        out.println("CHILD=" + child.pid());
        out.flush();
        Thread.sleep(ms);
        break;
      }
      default:
        err.println("unknown mode: " + mode);
        System.exit(2);
    }
    System.exit(0);
  }
}
`;

// ─── preparation ────────────────────────────────────────────────────────────

function prepareShared(opts, shared) {
  fs.mkdirSync(shared, { recursive: true });

  // 1) Input PDFs — read-only copies of the two evidence 14-page files plus a
  //    special-character name of identical content.
  const cnSrc = path.join(
    "D:\\Develop\\Misc Workspace\\archive\\z-transplit-issue-1-plan",
    "中文目录",
    "Ji 等 - paper.pdf",
  );
  const enSrc = path.join(
    "D:\\Develop\\Misc Workspace\\archive\\z-transplit-launch-diagnosis",
    "reproduction",
    "paper-english.pdf",
  );
  const cnDir = path.join(shared, "输入 中文目录");
  fs.mkdirSync(cnDir, { recursive: true });
  const pdfCn = path.join(cnDir, "Ji 等 - paper.pdf");
  const pdfEn = path.join(shared, "paper-english.pdf");
  const pdfSpecial = path.join(cnDir, "名& % ! ( ) 等.pdf");
  for (const [src, dst] of [
    [cnSrc, pdfCn],
    [enSrc, pdfEn],
    [cnSrc, pdfSpecial],
  ]) {
    if (!fs.existsSync(dst)) {
      if (!fs.existsSync(src)) die(`evidence PDF missing: ${src}`);
      fs.copyFileSync(src, dst);
    }
  }
  for (const p of [pdfCn, pdfEn, pdfSpecial]) {
    const h = sha256Hex(p);
    if (h !== EXPECTED_SHA256) die(`hash mismatch for ${p}: ${h}`);
  }

  // 2) Java runtime + ODL jar under Chinese+space directories (copies only —
  //    the originals are never moved or modified).
  const cnJavaHome = path.join(shared, "中文 java 目录 等");
  const cnJavaExe = path.join(
    cnJavaHome,
    path.basename(path.dirname(path.dirname(opts.java))),
    "bin",
    "java.exe",
  );
  if (!fs.existsSync(cnJavaExe)) {
    const runtimeSrc = path.dirname(path.dirname(opts.java)); // …/jdk-x.y/bin/java.exe → runtime root
    log(`copying Java runtime → ${cnJavaHome}`);
    fs.mkdirSync(cnJavaHome, { recursive: true });
    fs.cpSync(runtimeSrc, path.join(cnJavaHome, path.basename(runtimeSrc)), {
      recursive: true,
    });
  }
  const cnJarDir = path.join(shared, "中文 jar 目录 等");
  const cnJar = path.join(cnJarDir, "odl & cli ! ( ) 等.jar");
  if (!fs.existsSync(cnJar)) {
    fs.mkdirSync(cnJarDir, { recursive: true });
    fs.copyFileSync(opts.jar, cnJar);
  }

  // 3) Diagnostic Java fixture (source + classes stay in the output root).
  const fixturesSrc = path.join(shared, "fixtures-src");
  const fixturesClasses = path.join(shared, "fixtures-classes");
  fs.mkdirSync(fixturesSrc, { recursive: true });
  const fixtureJava = path.join(fixturesSrc, "QaFixture.java");
  fs.writeFileSync(fixtureJava, FIXTURE_SOURCE, "utf8");
  const javac = findJavac(opts);
  if (!javac) {
    die(
      "no javac found (needed to compile the diagnostic fixture). " +
        "Pass --javac <path> or set JAVAC. Fixture source is kept at " +
        fixtureJava,
    );
  }
  const stamp = path.join(fixturesClasses, "QaFixture.class");
  if (
    !fs.existsSync(stamp) ||
    fs.statSync(stamp).mtimeMs < fs.statSync(fixtureJava).mtimeMs
  ) {
    log(`compiling fixture with ${javac}`);
    fs.mkdirSync(fixturesClasses, { recursive: true });
    execFileSync(
      javac,
      ["--release", "17", "-encoding", "UTF-8", "-d", fixturesClasses, fixtureJava],
      { stdio: "inherit" },
    );
  }

  return { pdfCn, pdfEn, pdfSpecial, cnJavaExe, cnJar, fixturesClasses };
}

function buildAddon(runDir, opts, sharedPaths, mode) {
  const addonDir = path.join(runDir, "addon");
  fs.mkdirSync(path.join(addonDir, "core", "pdf", "lib"), { recursive: true });

  // Probe bundle: the production runner + scenario driver, one IIFE.
  const bundlePath = path.join(addonDir, "probe-bundle.js");
  const esbuildJs = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
  if (!fs.existsSync(esbuildJs)) {
    die(`esbuild not found at ${esbuildJs} — run npm ci first`);
  }
  execFileSync(
    process.execPath,
    [
      esbuildJs,
      "--bundle",
      "--format=iife",
      "--global-name=ZtUnicodeProbe",
      "--target=es2022",
      "--define:__env__=\"production\"",
      "--outfile=" + bundlePath,
      path.join(ROOT, "scripts", "qa", "windows-unicode-probe-entry.ts"),
    ],
    { stdio: "inherit", cwd: ROOT },
  );

  // Manifest: must be the BUILT manifest — the source one carries
  // __addonID__/__buildVersion__ placeholders the scaffold replaces at build
  // time, and AddonManager silently drops addons with unresolved ids.
  const builtManifest = path.join(ROOT, ".scaffold", "build", "addon", "manifest.json");
  const srcManifest = path.join(ROOT, "addon", "manifest.json");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (fs.existsSync(builtManifest)) {
    fs.copyFileSync(builtManifest, path.join(addonDir, "manifest.json"));
  } else {
    const text = fs
      .readFileSync(srcManifest, "utf8")
      .replaceAll("__addonName__", pkg.config.addonName)
      .replaceAll("__buildVersion__", pkg.version)
      .replaceAll("__description__", pkg.description)
      .replaceAll("__homepage__", pkg.homepage || "")
      .replaceAll("__author__", pkg.author)
      .replaceAll("__addonID__", pkg.config.addonID)
      .replaceAll(
        "__updateURL__",
        `https://github.com/Liozhang/z-transplit/releases/download/release/update.json`,
      );
    fs.writeFileSync(path.join(addonDir, "manifest.json"), text, "utf8");
  }
  fs.writeFileSync(path.join(addonDir, "prefs.js"), "", "utf8");

  // Jars + provenance so getJarPath can extract/verify from the packed XPI.
  for (const f of fs.readdirSync(path.join(ROOT, "src", "core", "pdf", "lib"))) {
    fs.copyFileSync(
      path.join(ROOT, "src", "core", "pdf", "lib", f),
      path.join(addonDir, "core", "pdf", "lib", f),
    );
  }

  const config = {
    outDir: runDir,
    mode,
    javaExe: opts.java,
    odlJar: opts.jar,
    removerJar: opts.removerJar,
    fixturesClassDir: sharedPaths.fixturesClasses,
    pdfCn: sharedPaths.pdfCn,
    pdfEn: sharedPaths.pdfEn,
    pdfSpecial: sharedPaths.pdfSpecial,
    cnJavaExe: sharedPaths.cnJavaExe,
    cnJar: sharedPaths.cnJar,
    expectedSha256: EXPECTED_SHA256,
    bigKb: 256,
  };

  const bootstrap = `/* generated by windows-unicode-probe.mjs — diagnostic probe bootstrap */
var PROBE_CONFIG = ${JSON.stringify(config, null, 2)};
function install() {}
function uninstall() {}
function shutdown() {}
async function startup(data, reason) {
  try {
    var ctx = { rootURI: data.rootURI };
    ctx._globalThis = ctx;
    Services.scriptloader.loadSubScript(data.rootURI + "probe-bundle.js", ctx);
    var api = ctx.ZtUnicodeProbe;
    if (!api || typeof api.runUnicodeProbe !== "function") {
      throw new Error("probe bundle did not expose runUnicodeProbe");
    }
    await api.runUnicodeProbe(PROBE_CONFIG);
  } catch (e) {
    try {
      await IOUtils.writeUTF8(
        PROBE_CONFIG.outDir + "\\\\probe-fatal.txt",
        String((e && e.stack) || e),
      );
    } catch (e2) {}
  }
  Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
}
`;
  fs.writeFileSync(path.join(addonDir, "bootstrap.js"), bootstrap, "utf8");

  // Pack as XPI (zip). Explicit System32 tar (bsdtar): `tar` on PATH may be
  // GNU tar from Git, which cannot write zip and misreads "D:\…" as host:path.
  // `tar -a` then picks the zip filter from the .zip extension; -f must get a
  // relative name for the same host:path reason.
  const xpi = path.join(runDir, "ztransplit@zotero.org.xpi");
  execFileSync(
    "C:\\Windows\\System32\\tar.exe",
    [
      "-a",
      "-c",
      "-f",
      "probe-tmp.zip",
      "-C",
      "addon",
      "manifest.json",
      "bootstrap.js",
      "probe-bundle.js",
      "prefs.js",
      "core",
    ],
    { stdio: "inherit", cwd: runDir },
  );
  fs.renameSync(path.join(runDir, "probe-tmp.zip"), xpi);
  return { xpi, config };
}

function prepareProfile(runDir, xpi, opts) {
  const profileDir = path.join(runDir, "profile");
  const dataDir = path.join(runDir, "data");
  fs.mkdirSync(path.join(profileDir, "extensions"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(xpi, path.join(profileDir, "extensions", "ztransplit@zotero.org.xpi"));

  const prefs = {
    "extensions.zotero.dataDir": dataDir,
    "extensions.zotero.useDataDir": true,
    "extensions.zotero.firstRun": false,
    "extensions.zotero.firstRun2": false,
    "extensions.zotero.httpServer.enabled": false,
    "extensions.zotero.automaticScraperUpdates": false,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "extensions.startupScanScopes": 15,
    "extensions.update.enabled": false,
    "extensions.systemAddon.update.enabled": false,
    "xpinstall.signatures.required": false,
    "extensions.logging.enabled": true,
    "extensions.lastAppBuildId": "",
    "extensions.lastAppVersion": "",
    "app.update.auto": false,
    "app.update.disabledForTesting": true,
    "browser.shell.checkDefaultBrowser": false,
  };
  fs.writeFileSync(
    path.join(profileDir, "user.js"),
    Object.entries(prefs)
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join("\n"),
    "utf8",
  );
  return { profileDir, dataDir };
}

// ─── execution ──────────────────────────────────────────────────────────────

/**
 * Structured process inventory via PowerShell CIM JSON (never localized
 * tasklist text, never a wildcard substring match on a spliced path). Only
 * zotero.exe rows are returned — identity/profile matching happens in the
 * gates module on the full command line. Any query failure is reported as
 * { ok:false, error } and must never be treated as "nothing running".
 */
function listProcesses() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | " +
          "Select-Object ProcessId,Name,CommandLine,CreationDate | " +
          "ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const text = String(out || "").trim();
    let rows = [];
    if (text && text !== "null") {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    }
    return {
      ok: true,
      processes: rows.map((r) => ({
        pid: Number(r.ProcessId),
        name: String(r.Name ?? ""),
        commandLine: String(r.CommandLine ?? ""),
        creationDate: r.CreationDate ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, processes: [], error: String((e && e.message) || e) };
  }
}

/** Kill one verified PID's tree. Only ever called with identity-checked PIDs. */
function killTree(pid) {
  return new Promise((resolve, reject) => {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 30000,
        windowsHide: true,
      });
      resolve();
    } catch (e) {
      reject(new Error(String((e && e.message) || e)));
    }
  });
}

/**
 * Build the child launch args + environment. MOZ_HEADLESS is explicit per
 * mode through buildLaunchEnv: headless sets it, GUI removes any inherited
 * value. `recorded` is the filtered, secret-free subset written to the run
 * manifest — never the whole environment.
 */
function buildLaunch(opts, mode, profileDir) {
  const javaBin = path.dirname(opts.java);
  const baseEnv = {
    ...process.env,
    PATH: `${javaBin};${process.env.PATH || ""}`,
    MOZ_CRASHREPORTER_DISABLE: "1",
  };
  const env = buildLaunchEnv(baseEnv, mode);
  const args = [
    "-no-remote",
    "-profile",
    profileDir,
    "-ZoteroDebugText",
    ...(mode === "headless" ? ["-headless"] : []),
  ];
  const recorded = {
    command: opts.zotero,
    args,
    mode,
    envFiltered: {
      MOZ_HEADLESS: env.MOZ_HEADLESS ?? null,
      MOZ_CRASHREPORTER_DISABLE: env.MOZ_CRASHREPORTER_DISABLE ?? null,
      javaBinPrependedToPath: javaBin,
    },
  };
  return { args, env, recorded };
}

async function runInstance(runDir, opts, mode, profileDir, launch) {
  return new Promise((resolve) => {
    const resultsFile = path.join(runDir, "results.json");
    const stdoutLog = path.join(runDir, "zotero.stdout.log");
    const stderrLog = path.join(runDir, "zotero.stderr.log");
    const out = fs.openSync(stdoutLog, "w");
    const err = fs.openSync(stderrLog, "w");

    log(`starting Zotero (${mode}): ${opts.zotero} ${launch.args.join(" ")}`);
    const child = spawn(opts.zotero, launch.args, {
      env: launch.env,
      stdio: ["ignore", out, err],
      windowsHide: mode === "headless",
    });
    fs.writeFileSync(path.join(runDir, "zotero.pid"), String(child.pid ?? ""));

    let settled = false;
    const finish = async (outcome) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      const cleanup = await stopOwnProcesses({
        listProcesses,
        killTree,
        rootPid: child.pid,
        profileDir,
      });
      fs.writeFileSync(
        path.join(runDir, "cleanup-report.json"),
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            rootPid: child.pid ?? null,
            profileDir,
            ...cleanup,
          },
          null,
          2,
        ),
        "utf8",
      );
      resolve({ mode, childExited, rootPid: child.pid ?? null, cleanup, ...outcome });
    };

    // Spawn failure (missing binary, access denied) is a launch error — not a
    // run that can produce results.
    child.on("error", (e) => {
      log(`zotero spawn failed: ${e && e.message}`);
      finish({ timedOut: false, launchError: String((e && e.message) || e) });
    });

    // zotero.exe's spawned root can hand off and exit while the real UI
    // process continues under a new PID — child exit is NOT the end of the
    // run. Only results.json (written by the probe) or the deadline end it.
    let childExited = false;
    child.on("exit", () => {
      childExited = true;
      log(`spawned root exited (pid ${child.pid}); waiting for probe results`);
    });

    const started = Date.now();
    const TIMEOUT_MS = 20 * 60 * 1000;
    const timer = setInterval(() => {
      let done = false;
      try {
        const r = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
        done = r.complete === true;
      } catch {
        /* not written yet */
      }
      if (done) {
        // The probe quits Zotero itself; give it a moment, then make sure.
        setTimeout(() => finish({ timedOut: false, launchError: null }), 3000);
      } else if (Date.now() - started > TIMEOUT_MS) {
        log(`timeout — stopping instances of this run only`);
        finish({ timedOut: true, launchError: null });
      }
    }, 2000);
  });
}

/**
 * Print the scenario table and return the fail-closed verdict for one run.
 * Every failure class feeds the verdict: launch error, probe-fatal file,
 * deadline, incomplete/malformed/missing/duplicate scenarios, mode/run
 * mismatch, ok!==true entries, and unverified or failed cleanup.
 */
function evaluateRunDir(runDir, mode, outcome) {
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
  } catch (e) {
    parseError = String((e && e.message) || e);
  }
  let fatal = null;
  try {
    fatal = fs.readFileSync(path.join(runDir, "probe-fatal.txt"), "utf8");
  } catch {
    /* no fatal file */
  }

  const verdict = evaluateRun({
    parsed,
    parseError,
    expectedMode: mode,
    expectedRunDir: runDir,
    timedOut: !!outcome.timedOut,
    fatal,
    expectedIds: SCENARIO_IDS,
  });
  const failures = [...verdict.failures];

  if (outcome.launchError) {
    failures.push(`zotero launch failed: ${outcome.launchError}`);
  }

  const cleanup = outcome.cleanup || {};
  if (cleanup.observationError) {
    failures.push(`cleanup observation failed: ${cleanup.observationError}`);
  }
  for (const s of cleanup.skipped || []) {
    if (String(s.reason || "").startsWith("kill-failed")) {
      failures.push(`cleanup kill failed for pid ${s.pid}: ${s.reason}`);
    }
  }

  // Per-scenario table (informational; the verdict above is authoritative).
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : [];
  const okCount = results.filter((r) => r && r.ok === true).length;
  log(`── ${mode} mode: ${okCount}/${results.length} ok`);
  for (const r of results) {
    if (!r || typeof r.id !== "string") {
      log(`   FAIL <malformed entry>`);
      continue;
    }
    log(`   ${r.ok === true ? "PASS" : "FAIL"} ${r.id}${r.note ? ` (${r.note})` : ""}`);
    if (r.ok !== true) log(`        details: ${JSON.stringify(r.details).slice(0, 400)}`);
  }
  log(`   cleanup: killed=${(cleanup.killed || []).length} skipped=${(cleanup.skipped || []).length} observationError=${cleanup.observationError ?? "none"}`);

  return { ok: failures.length === 0, failures };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.java) {
    opts.java = findManagedJava();
    if (!opts.java) die("no --java given and no managed JRE found");
  }
  for (const [label, p] of [
    ["zotero", opts.zotero],
    ["java", opts.java],
    ["jar", opts.jar],
    ["remover-jar", opts.removerJar],
  ]) {
    if (!fs.existsSync(p)) die(`${label} not found: ${p}`);
  }

  log(`zotero   = ${opts.zotero}`);
  log(`java     = ${opts.java}`);
  log(`odl jar  = ${opts.jar}`);
  log(`remover  = ${opts.removerJar}`);
  log(`out root = ${opts.out}`);
  log(`modes    = ${opts.mode}`);

  // Record environment evidence (metadata only — the tests run inside Zotero).
  let chcp = "";
  try {
    chcp = execFileSync("cmd.exe", ["/d", "/c", "chcp"], { encoding: "utf8" }).trim();
  } catch {
    /* recorded as empty */
  }
  let javaVersion = "";
  try {
    // java -version writes to STDERR.
    javaVersion = execFileSync(opts.java, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    javaVersion = String((e.stdout || "") + (e.stderr || "") || e.message);
  }
  const provenance = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src", "core", "pdf", "lib", "PROVENANCE.json"), "utf8"),
  );

  const shared = path.join(opts.out, "shared");
  const sharedPaths = prepareShared(opts, shared);
  log(`fixture classes: ${sharedPaths.fixturesClasses}`);

  const modes = opts.mode === "both" ? ["gui", "headless"] : [opts.mode];
  const runFailures = [];
  for (const mode of modes) {
    const runDir = path.join(
      opts.out,
      "runs",
      `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    fs.mkdirSync(runDir, { recursive: true });
    log(`── run dir: ${runDir}`);

    const { xpi } = buildAddon(runDir, opts, sharedPaths, mode);
    const { profileDir } = prepareProfile(runDir, xpi, opts);
    const launch = buildLaunch(opts, mode, profileDir);

    const manifest = {
      recordedAt: new Date().toISOString(),
      mode,
      host: {
        chcp,
        zoteroExe: opts.zotero,
        javaExe: opts.java,
        javaVersion: String(javaVersion).split(/\r?\n/)[0],
        odlJar: opts.jar,
        odlJarProvenance: provenance,
        removerJar: opts.removerJar,
      },
      // Filtered launch record (R4): only the args and the mode-relevant env
      // keys — never the full environment (may contain secrets).
      launch: launch.recorded,
      source: {
        head: (() => {
          try {
            return execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: ROOT,
              encoding: "utf8",
            }).trim();
          } catch {
            return "unknown";
          }
        })(),
        status: (() => {
          try {
            return execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
              cwd: ROOT,
              encoding: "utf8",
            }).trim();
          } catch {
            return "unknown";
          }
        })(),
      },
      bundleSha256: sha256File(path.join(runDir, "addon", "probe-bundle.js")),
    };
    fs.writeFileSync(
      path.join(runDir, "run-manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    const outcome = await runInstance(runDir, opts, mode, profileDir, launch);
    const verdict = evaluateRunDir(runDir, mode, outcome);
    if (!verdict.ok) {
      for (const f of verdict.failures) {
        log(`   RUN FAIL: ${f}`);
        runFailures.push(`[${mode}] ${f}`);
      }
    }
  }

  if (runFailures.length > 0) {
    log(`total run failures: ${runFailures.length}`);
    for (const f of runFailures) log(`  - ${f}`);
    process.exit(1);
  }
  log(`all runs passed (${SCENARIO_IDS.length} scenarios each)`);
  process.exit(0);
}

main().catch((e) => die(String((e && e.stack) || e)));
