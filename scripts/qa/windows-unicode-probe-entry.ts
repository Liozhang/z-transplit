/**
 * windows-unicode-probe-entry — in-host regression probe for Issue #1
 * (Windows Unicode Java invocation and failure diagnostics).
 *
 * Bundled by scripts/qa/windows-unicode-probe.mjs into an isolated diagnostic
 * addon and loaded inside a REAL Zotero instance. Every scenario drives the
 * production exports (runProcess / execJar / parsePdfToJson / checkHealth /
 * formatJavaExitError) — nothing here re-implements the runner.
 *
 * Results are written progressively to <outDir>/results.json so an interrupted
 * run still leaves evidence behind.
 */

import {
  runProcess,
  execJar,
  parsePdfToJson,
  checkHealth,
  formatJavaExitError,
} from "../../src/core/pdf/OpenDataLoaderPdfClient";
import { classifyOdlRuntimeError } from "../../src/core/pdf/backendSelector";
import { PdfParseError } from "../../src/core/pdf/PdfParseError";
import { createAbortController } from "../../src/utils/abort";
import {
  SCENARIO_IDS,
  waitForPidGone,
} from "./windows-unicode-probe-gates.mjs";

export interface ProbeConfig {
  mode: "gui" | "headless";
  outDir: string;
  javaExe: string;
  odlJar: string;
  removerJar: string;
  fixturesClassDir: string;
  pdfCn: string;
  pdfEn: string;
  pdfSpecial: string;
  cnJavaExe: string;
  cnJar: string;
  expectedSha256: string;
  bigKb: number;
}

interface ScenarioResult {
  id: string;
  ok: boolean;
  details: Record<string, unknown>;
  note?: string;
}

const results: ScenarioResult[] = [];
let config: ProbeConfig;

// ─── host helpers (environment observation only — not the runner under test) ─

function getSubprocess(): any {
  const { Subprocess } = (globalThis as any).ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  return Subprocess;
}

async function readAll(pipe: any): Promise<string> {
  const parts: string[] = [];
  if (!pipe) return "";
  for (;;) {
    const chunk = await pipe.readString();
    if (!chunk) break;
    parts.push(chunk);
  }
  return parts.join("");
}

/**
 * Run a bare command via Subprocess (no JVM flags) and return streams + code.
 * QA-internal export (not a product API) so permanent tests can drive this
 * exact executor with a fake Subprocess.
 *
 * Lifecycle (mirrors the production Windows runner's stop-intent discipline
 * without JVM flags): the termination deadline is registered BEFORE the first
 * async startup op, so it covers Subprocess.call and any stdin work. Expiry
 * records the stop intent and initiates the kill — immediately if the handle
 * exists, otherwise the moment it arrives. The call does not return before
 * the owned process is terminated and reaped (wait() + both pipes at EOF).
 * The deadline marks when termination is initiated; reaping may finish a
 * moment later — never return at the millisecond mark with the process still
 * running. stdin.close is fire-and-note (kill tears it down; a hung close
 * must not block reaping). Capture/kill failures are recorded honestly in
 * cleanupNotes — "reaped" is never claimed without confirmation.
 */
export async function rawExec(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
  cleanupNotes: string[];
}> {
  const cleanupNotes: string[] = [];
  let proc: any = null;
  let killPromise: Promise<void> | null = null;
  // First terminal intent wins: "exit" | "timeout" | "failure" | "startup-failure".
  const state: { outcome: string | null } = { outcome: null };
  const claim = (kind: string): boolean => {
    if (state.outcome !== null) return false;
    state.outcome = kind;
    return true;
  };

  const triggerKill = (): Promise<void> => {
    // No handle yet → no-op; the late-handle path re-invokes once it arrives.
    // Memoized only when a handle exists, so a pre-handle call never swallows
    // the real kill.
    if (!proc) return Promise.resolve();
    if (!killPromise) {
      killPromise = (async () => {
        try {
          await proc.kill(0);
          cleanupNotes.push("kill issued");
        } catch (e) {
          cleanupNotes.push("kill failed: " + String((e as any)?.message || e));
        }
      })();
    }
    return killPromise;
  };

  // 1. Termination deadline first — covers the whole startup window.
  let timer: any;
  let resolveDeadline: () => void = () => {};
  const deadline = new Promise<void>((r) => {
    resolveDeadline = r;
  });
  timer = setTimeout(() => {
    if (!claim("timeout")) {
      resolveDeadline();
      return;
    }
    void triggerKill().then(() => resolveDeadline());
  }, timeoutMs);

  // 2. Startup: the handle promise is always awaited to completion.
  try {
    proc = await getSubprocess().call({
      command,
      arguments: args,
      stderr: "pipe",
    });
  } catch (e) {
    clearTimeout(timer);
    claim("startup-failure");
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: "startup failed: " + String((e as any)?.message || e),
      cleanupNotes,
    };
  }

  // Late handle: the deadline may have expired while starting — kill on arrival
  // before doing anything else with the process.
  if (state.outcome === "timeout") {
    await triggerKill();
    resolveDeadline();
  }

  // 3. stdin close: fire-and-note. A hung close must not block reaping.
  void Promise.resolve()
    .then(() => proc.stdin.close())
    .then(
      () => {},
      (e) => {
        cleanupNotes.push("stdin close failed: " + String((e as any)?.message || e));
      },
    );

  // 4. Three independent completion promises — kept separate so the failure
  //    path can still await every one of them. Promise.all rejects at the
  //    first failure and would abandon the other readers and wait().
  const stdoutDone = readAll(proc.stdout);
  const stderrDone = readAll(proc.stderr);
  const waitDone = Promise.resolve(proc.wait()) as Promise<{ exitCode: number }>;

  const streams = (async () => {
    const [out, err, wait] = await Promise.all([stdoutDone, stderrDone, waitDone]);
    claim("exit");
    return { exitCode: wait.exitCode, stdout: out, stderr: err };
  })();

  // 5. Await natural completion or the deadline; NEVER return before the
  //    streams (wait + both pipes) have settled post-termination.
  try {
    await Promise.race([streams, deadline]);
    clearTimeout(timer);
    const result = await streams;
    return {
      ...result,
      timedOut: state.outcome === "timeout",
      cleanupNotes,
    };
  } catch (e) {
    clearTimeout(timer);
    claim("failure");
    // Attempt and await our own kill first (its failure is noted, not fatal —
    // the process may already be dying on its own), then reap EVERYTHING we
    // own: Promise.allSettled on the three independent promises. Re-awaiting
    // the rejected aggregate would not wait for the other reader or wait(),
    // and a noted kill failure must not leave a live process with the caller.
    await triggerKill();
    await Promise.allSettled([stdoutDone, stderrDone, waitDone]);
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: state.outcome === "timeout",
      error: "stream capture failed: " + String((e as any)?.message || e),
      cleanupNotes,
    };
  }
}

/**
 * Structured process query: PowerShell CIM returns a JSON row (or "null")
 * for the exact PID — no localized tasklist text and no image-name heuristics.
 * Bounded by `opts.timeoutMs` (the wait helper passes its remaining budget).
 * A timed-out or failed query is a failed observation; the raw outcome and
 * the executor's cleanup notes are kept as evidence — a timeout message only
 * reports what cleanup actually observed (kill issued / kill failed).
 * QA-internal export (not a product API).
 */
export async function queryPid(
  pid: number,
  opts?: { timeoutMs?: number },
): Promise<{
  ok: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
}> {
  const budgetMs = Math.max(1, opts?.timeoutMs ?? 5_000);
  try {
    const r = await rawExec(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`,
      ],
      budgetMs,
    );
    const notes = r.cleanupNotes.length ? `; cleanup: ${r.cleanupNotes.join(", ")}` : "";
    if (r.error) {
      return {
        ok: false,
        exitCode: r.exitCode,
        output: r.stdout,
        error: r.error + notes,
      };
    }
    if (r.timedOut) {
      return {
        ok: false,
        exitCode: r.exitCode,
        output: r.stdout,
        error: `query timed out after ${budgetMs}ms${notes}`,
      };
    }
    return { ok: true, exitCode: r.exitCode, output: r.stdout };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Confirm `pid` is gone. Query failures and identity mismatches are verification
 * failures (gone=false + error), never treated as "cleaned up" — the caller must
 * fail the scenario and keep the evidence in its details.
 */
async function verifyPidGone(
  pid: number,
  expectedImage: string,
): Promise<{ gone: boolean; state: string; evidence: unknown[]; error: string | null }> {
  return waitForPidGone(pid, expectedImage, {
    query: queryPid,
    timeoutMs: 15_000,
    pollMs: 500,
  });
}

async function sha256Of(path: string): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  const bytes = await IOUtils.read(path);
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  const digest = await (globalThis as any).crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract the fixture's self-reported PID from captured stdout. */
function pidFromStdout(stdout: string): number | null {
  const m = /^PID=(\d+)/m.exec(stdout);
  return m ? Number(m[1]) : null;
}

function childPidFromStdout(stdout: string): number | null {
  const m = /^CHILD=(\d+)/m.exec(stdout);
  return m ? Number(m[1]) : null;
}

async function saveResults(complete: boolean): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  await IOUtils.writeUTF8(
    (globalThis as any).PathUtils.join(config.outDir, "results.json"),
    JSON.stringify(
      {
        complete,
        mode: config.mode,
        outDir: config.outDir,
        app: {
          name: (globalThis as any).Services?.appinfo?.name,
          version: (globalThis as any).Services?.appinfo?.version,
          os: (globalThis as any).Services?.appinfo?.OS,
          locale: (globalThis as any).Services?.appinfo?.locale,
        },
        results,
      },
      null,
      2,
    ),
  );
}

async function report(
  id: string,
  ok: boolean,
  details: Record<string, unknown>,
  note?: string,
): Promise<void> {
  results.push({ id, ok, details, note });
  await saveResults(false);
}

// ─── scenarios ───────────────────────────────────────────────────────────────

async function scenarioEnv(): Promise<void> {
  const appinfo = (globalThis as any).Services?.appinfo;
  const chcp = await rawExec("C:\\Windows\\System32\\cmd.exe", [
    "/d",
    "/c",
    "chcp",
  ]);
  // Host codepage must be the non-UTF-8 CP936 context this issue targets.
  const cp = chcp.stdout.match(/(\d{3,4})/)?.[1] ?? "";
  // R4: the mode is proven by host-side headless state, not by config.self.
  const hostEnv = (globalThis as any).Services?.env;
  const mozHeadless = hostEnv?.get?.("MOZ_HEADLESS") ?? "";
  const launchArgs = (globalThis as any).Services?.cmdline?.length
    ? Array.from(
        { length: (globalThis as any).Services.cmdline.length },
        (_v, i) => String((globalThis as any).Services.cmdline.getArgument(i)),
      ).join(" ")
    : "";
  const headlessRuntime =
    mozHeadless === "1" || /(^|\s)-headless(\s|$)/.test(launchArgs);
  const modeMatches =
    config.mode === "headless" ? headlessRuntime === true : headlessRuntime === false;
  await report(
    "env",
    appinfo?.name === "Zotero" && cp === "936" && modeMatches,
    {
      appName: appinfo?.name,
      appVersion: appinfo?.version,
      os: appinfo?.OS,
      chcpRaw: chcp.stdout.trim(),
      codepage: cp,
      requestedMode: config.mode,
      mozHeadless,
      headlessRuntime,
      launchArgsHead: launchArgs.slice(0, 200),
    },
    `codepage=${cp} mode=${config.mode} headlessRuntime=${headlessRuntime}`,
  );
}

async function scenarioInputHashes(): Promise<void> {
  const cn = await sha256Of(config.pdfCn);
  const en = await sha256Of(config.pdfEn);
  const sp = await sha256Of(config.pdfSpecial);
  await report(
    "input-hashes",
    cn === config.expectedSha256 &&
      en === config.expectedSha256 &&
      sp === config.expectedSha256,
    { cn, en, special: sp, expected: config.expectedSha256 },
  );
}

const ODL_PARSE_ARGS = [
  "--format",
  "json",
  "--reading-order",
  "xycut",
  "--table-method",
  "default",
  "--image-output",
  "off",
];

async function runOdlOn(
  javaExe: string,
  jar: string,
  pdfPath: string,
  outputDir: string,
  timeoutMs = 180_000,
) {
  const IOUtils = (globalThis as any).IOUtils;
  await IOUtils.makeDirectory(outputDir, { createAncestors: true });
  return runProcess(
    javaExe,
    ["-jar", jar, ...ODL_PARSE_ARGS, "--output-dir", outputDir, pdfPath],
    timeoutMs,
  );
}

async function readPageCount(
  outputDir: string,
  pdfPath: string,
): Promise<{ pages: number | null; jsonPath: string | null; raw: string }> {
  const IOUtils = (globalThis as any).IOUtils;
  const PathUtils = (globalThis as any).PathUtils;
  const base =
    pdfPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "document";
  const jsonPath = PathUtils.join(outputDir, `${base}.json`);
  if (!(await IOUtils.exists(jsonPath))) {
    // ODL names the JSON after the input base name; fall back to a dir scan.
    const children = (await IOUtils.getChildren(outputDir)) as string[];
    const found = children.find((c) => c.toLowerCase().endsWith(".json"));
    if (!found) return { pages: null, jsonPath: null, raw: "" };
    const raw = await IOUtils.readUTF8(found);
    return {
      pages: safePages(raw),
      jsonPath: found,
      raw: raw.slice(0, 200),
    };
  }
  const raw = await IOUtils.readUTF8(jsonPath);
  return { pages: safePages(raw), jsonPath, raw: raw.slice(0, 200) };
}

function safePages(jsonText: string): number | null {
  try {
    const root = JSON.parse(jsonText);
    const n = root["number of pages"] ?? root["number_of_pages"] ?? null;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

async function scenarioRunCn(): Promise<void> {
  const outDir = (globalThis as any).PathUtils.join(
    config.outDir,
    "输出 中文目录",
  );
  const r = await runOdlOn(config.javaExe, config.odlJar, config.pdfCn, outDir);
  const read = await readPageCount(outDir, config.pdfCn);
  await report(
    "run-cn-14p",
    r.exitCode === 0 && read.pages === 14,
    {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      pages: read.pages,
      jsonPath: read.jsonPath,
      stderrHead: r.stderr.slice(0, 300),
      stdoutHead: r.stdout.slice(0, 200),
    },
    `exit=${r.exitCode} pages=${read.pages}`,
  );
}

async function scenarioRunEn(): Promise<void> {
  const outDir = (globalThis as any).PathUtils.join(config.outDir, "output-en");
  const r = await runOdlOn(config.javaExe, config.odlJar, config.pdfEn, outDir);
  const read = await readPageCount(outDir, config.pdfEn);
  await report(
    "run-en-14p",
    r.exitCode === 0 && read.pages === 14,
    {
      exitCode: r.exitCode,
      pages: read.pages,
      jsonPath: read.jsonPath,
    },
    `exit=${r.exitCode} pages=${read.pages}`,
  );
}

async function scenarioParseEntry(): Promise<void> {
  // The production parse entry reads the jar output back via runOpenDataLoader.
  const r = await parsePdfToJson(config.pdfCn);
  const pages =
    r.success && r.data
      ? (r.data["number of pages"] ?? r.data["number_of_pages"] ?? null)
      : null;
  await report(
    "parse-entry-14p",
    r.success === true && pages === 14,
    { success: r.success, pages, error: r.error ?? null },
    `parsePdfToJson pages=${pages}`,
  );
}

async function scenarioSpecialFilename(): Promise<void> {
  const outDir = (globalThis as any).PathUtils.join(
    config.outDir,
    "output & % ! ( )",
  );
  const r = await runOdlOn(
    config.javaExe,
    config.odlJar,
    config.pdfSpecial,
    outDir,
  );
  const read = await readPageCount(outDir, config.pdfSpecial);
  await report(
    "run-special-filename",
    r.exitCode === 0 && read.pages === 14,
    {
      exitCode: r.exitCode,
      pages: read.pages,
      pdf: config.pdfSpecial,
      outDir,
    },
    `exit=${r.exitCode} pages=${read.pages}`,
  );
}

async function scenarioCnJavaJar(): Promise<void> {
  const outDir = (globalThis as any).PathUtils.join(
    config.outDir,
    "output-cn-java-jar",
  );
  const r = await runOdlOn(config.cnJavaExe, config.cnJar, config.pdfCn, outDir);
  const read = await readPageCount(outDir, config.pdfCn);
  await report(
    "run-cn-java-jar",
    r.exitCode === 0 && read.pages === 14,
    {
      exitCode: r.exitCode,
      pages: read.pages,
      javaExe: config.cnJavaExe,
      jar: config.cnJar,
      stderrHead: r.stderr.slice(0, 300),
    },
    `exit=${r.exitCode} pages=${read.pages}`,
  );
}

let missingPathRun: {
  exitCode: number;
  stdout: string;
  stderr: string;
} | null = null;

async function scenarioMissingCnPath(): Promise<void> {
  const missing = (globalThis as any).PathUtils.join(
    config.outDir,
    "中文目录",
    "不存在 等.pdf",
  );
  const r = await runProcess(
    config.javaExe,
    ["-jar", config.odlJar, ...ODL_PARSE_ARGS, missing],
    120_000,
  );
  missingPathRun = r;
  // Real non-zero exit (ODL returns 1), Chinese path intact in stderr, valid
  // UTF-8, and the two streams kept separate.
  let utf8Valid = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(r.stderr),
    );
  } catch {
    utf8Valid = false;
  }
  const hasCnPath = r.stderr.includes("不存在 等.pdf");
  const hasNotFound = /not found|不存在|找不到/i.test(r.stderr);
  await report(
    "fail-missing-cn-path",
    r.exitCode === 1 && hasCnPath && hasNotFound && utf8Valid && !r.timedOut,
    {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      hasCnPath,
      hasNotFound,
      utf8Valid,
      stderr: r.stderr.slice(0, 800),
      stdout: r.stdout.slice(0, 200),
    },
    `exit=${r.exitCode} cnPath=${hasCnPath} notFound=${hasNotFound}`,
  );
}

async function scenarioErrorPropagation(): Promise<void> {
  if (!missingPathRun) {
    await report("error-propagation", false, {}, "missing-path run unavailable");
    return;
  }
  const summary = formatJavaExitError(missingPathRun);
  const err = classifyOdlRuntimeError(summary);
  const keepsCode = summary.startsWith(
    `java exited with code ${missingPathRun.exitCode}`,
  );
  const keepsReason =
    err instanceof PdfParseError &&
    err.reason === "parse-failed" &&
    err.message.includes("不存在 等.pdf");
  const notLaunchFailure = !summary.includes("Process failed to launch");
  await report(
    "error-propagation",
    keepsCode && keepsReason && notLaunchFailure,
    {
      summaryHead: summary.slice(0, 300),
      reason: err instanceof PdfParseError ? err.reason : "not-PdfParseError",
      messageHead: err.message.slice(0, 300),
    },
    `code=${keepsCode} reason=${err instanceof PdfParseError ? err.reason : "?"}`,
  );
}

function fixtureArgs(...rest: string[]): string[] {
  return ["-cp", config.fixturesClassDir, "QaFixture", ...rest];
}

async function scenarioFixtureNonzero(): Promise<void> {
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("both", "7"),
    60_000,
  );
  await report(
    "fixture-nonzero-exit7",
    r.exitCode === 7 &&
      r.stdout.includes("STDOUT-中文-OK") &&
      r.stderr.includes("STDERR-中文-OK"),
    {
      exitCode: r.exitCode,
      stdout: r.stdout.slice(0, 200),
      stderr: r.stderr.slice(0, 200),
    },
    `exit=${r.exitCode}`,
  );
}

/** Raw argv arrival: Unicode, spaces, shell metacharacters — no expansion. */
async function scenarioArgvRaw(): Promise<void> {
  const args = [
    "中文 空格.txt",
    "名& % ! ( ) 等.pdf",
    "a'b\"c",
    "--flag=值",
    "*wild?card*",
  ];
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("argv", ...args),
    60_000,
  );
  const got = r.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ARG:"))
    .map((l) => l.slice(4));
  const exact = JSON.stringify(got) === JSON.stringify(args);
  await report(
    "fixture-argv-raw",
    r.exitCode === 0 && exact,
    { exitCode: r.exitCode, args, got },
    exact ? "argv exact" : "argv MISMATCH",
  );
}

async function scenarioFixtureBig(): Promise<void> {
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("big", String(config.bigKb), String(config.bigKb)),
    120_000,
  );
  // Compare BYTES, not JS chars — the fixture payload is CJK-heavy.
  const outBytes = new TextEncoder().encode(r.stdout).length;
  const errBytes = new TextEncoder().encode(r.stderr).length;
  await report(
    "fixture-big-dual-stream",
    r.exitCode === 0 &&
      outBytes >= config.bigKb * 1024 &&
      errBytes >= config.bigKb * 1024,
    {
      exitCode: r.exitCode,
      outBytes,
      errBytes,
    },
    `out=${outBytes}B err=${errBytes}B`,
  );
}

async function scenarioFixtureTimeout(): Promise<void> {
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("sleep", "120000"),
    3_000,
  );
  const pid = pidFromStdout(r.stdout);
  const obs = pid !== null ? await verifyPidGone(pid, "java.exe") : null;
  await report(
    "fixture-timeout",
    r.timedOut === true &&
      r.exitCode === -1 &&
      r.stderr.includes("Process timed out") &&
      obs?.gone === true &&
      obs.error === null,
    {
      timedOut: r.timedOut,
      exitCode: r.exitCode,
      pid,
      pidGone: obs?.gone ?? null,
      pidState: obs?.state ?? null,
      pidError: obs?.error ?? null,
      pidEvidence: obs?.evidence ?? null,
      stdoutHead: r.stdout.slice(0, 120),
    },
    `pid=${pid} gone=${obs?.gone === true} obs=${obs?.state ?? "n/a"}`,
  );
}

async function scenarioFixtureCancel(): Promise<void> {
  // The plugin sandbox has no global AbortController — use the production
  // resolver (falls back to the main window's constructor).
  const ac = createAbortController();
  const timer = setTimeout(() => ac.abort(), 1_000);
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("sleep", "120000"),
    120_000,
    ac.signal,
  );
  clearTimeout(timer);
  const pid = pidFromStdout(r.stdout);
  const obs = pid !== null ? await verifyPidGone(pid, "java.exe") : null;
  await report(
    "fixture-cancel",
    r.aborted === true &&
      r.exitCode === -1 &&
      r.timedOut === false &&
      obs?.gone === true &&
      obs.error === null,
    {
      aborted: r.aborted,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      pid,
      pidGone: obs?.gone ?? null,
      pidState: obs?.state ?? null,
      pidError: obs?.error ?? null,
      pidEvidence: obs?.evidence ?? null,
    },
    `pid=${pid} gone=${obs?.gone === true} obs=${obs?.state ?? "n/a"}`,
  );
}

async function scenarioFixtureCancelStartup(): Promise<void> {
  const ac = createAbortController();
  const p = runProcess(
    config.javaExe,
    fixtureArgs("sleep", "120000"),
    120_000,
    ac.signal,
  );
  ac.abort(); // fires inside the async startup window or immediately after
  const r = await p;
  await report(
    "fixture-cancel-startup",
    r.aborted === true && r.exitCode === -1 && r.timedOut === false,
    {
      aborted: r.aborted,
      exitCode: r.exitCode,
      stderrHead: r.stderr.slice(0, 150),
    },
    `aborted=${r.aborted}`,
  );
}

async function scenarioFixtureChildKill(): Promise<void> {
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("sleep-child", "120000"),
    3_000,
  );
  const jvmPid = pidFromStdout(r.stdout);
  const childPid = childPidFromStdout(r.stdout);
  const jvmObs =
    jvmPid !== null ? await verifyPidGone(jvmPid, "java.exe") : null;
  // Fixture spawns cmd.exe (which runs ping) — the tree kill must take the
  // descendant too; identity is checked against the image we started.
  const childObs =
    childPid !== null ? await verifyPidGone(childPid, "cmd.exe") : null;
  await report(
    "fixture-child-tree-kill",
    r.timedOut === true &&
      jvmObs?.gone === true &&
      jvmObs.error === null &&
      childObs?.gone === true &&
      childObs.error === null,
    {
      timedOut: r.timedOut,
      jvmPid,
      childPid,
      jvmGone: jvmObs?.gone ?? null,
      jvmState: jvmObs?.state ?? null,
      jvmEvidence: jvmObs?.evidence ?? null,
      childGone: childObs?.gone ?? null,
      childState: childObs?.state ?? null,
      childError: childObs?.error ?? null,
      childEvidence: childObs?.evidence ?? null,
      stdoutHead: r.stdout.slice(0, 200),
    },
    `jvm=${jvmPid}(${jvmObs?.gone === true}) child=${childPid}(${childObs?.gone === true})`,
  );
}

async function scenarioConcurrent(): Promise<void> {
  const p1 = runProcess(
    config.javaExe,
    fixtureArgs("both", "0", "@tag=AAA"),
    60_000,
  );
  const p2 = runProcess(
    config.javaExe,
    fixtureArgs("both", "0", "@tag=BBB"),
    60_000,
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  // Streams must not cross between the two calls.
  const clean =
    r1.stdout.includes("STDOUT-中文-OK") &&
    r2.stdout.includes("STDOUT-中文-OK") &&
    !r1.stdout.includes("BBB") &&
    !r2.stdout.includes("AAA");
  await report(
    "concurrent-two-calls",
    r1.exitCode === 0 && r2.exitCode === 0 && clean,
    {
      exit1: r1.exitCode,
      exit2: r2.exitCode,
      out1: r1.stdout.slice(0, 120),
      out2: r2.stdout.slice(0, 120),
    },
  );
}

async function scenarioLaunchFailure(): Promise<void> {
  const bogus = (globalThis as any).PathUtils.join(
    config.outDir,
    "definitely-not-java.exe",
  );
  const r = await runProcess(bogus, ["-version"], 30_000);
  // A real launch failure carries the real exception text and stays
  // distinguishable from a non-zero runtime exit.
  const distinguishable =
    r.exitCode === -1 &&
    !r.timedOut &&
    r.stderr.length > 0 &&
    !r.stderr.includes("exited with code");
  await report(
    "launch-failure-distinguishable",
    distinguishable,
    {
      exitCode: r.exitCode,
      stderrHead: r.stderr.slice(0, 300),
    },
    `exit=${r.exitCode}`,
  );
}

async function scenarioCheckHealth(): Promise<void> {
  const health = await checkHealth();
  // The point is that `java -version` output is still parsed from stderr
  // through the new runner — any Java 11+ version string proves it.
  await report(
    "check-health-version",
    health.healthy === true && !!health.version,
    {
      healthy: health.healthy,
      version: health.version ?? null,
      error: health.error ?? null,
    },
    `version=${health.version}`,
  );
}

async function scenarioRemover(): Promise<void> {
  const IOUtils = (globalThis as any).IOUtils;
  const PathUtils = (globalThis as any).PathUtils;
  const workDir = PathUtils.join(config.outDir, "remover-work");
  await IOUtils.makeDirectory(workDir, { createAncestors: true });

  // inspect mode: reports text-bearing form regions to an output file.
  const inspectOut = PathUtils.join(workDir, "forms.txt");
  const inspect = await execJar(
    config.removerJar,
    ["--inspect", config.pdfCn, inspectOut],
    120_000,
  );
  const inspectOk =
    inspect.exitCode === 0 && (await IOUtils.exists(inspectOut));

  // Lossless minimal case: empty rect list → nothing removed, valid PDF out.
  const rects = PathUtils.join(workDir, "rects-empty.txt");
  await IOUtils.writeUTF8(rects, "");
  const cleaned = PathUtils.join(workDir, "cleaned.pdf");
  const remove = await execJar(
    config.removerJar,
    [config.pdfCn, rects, cleaned],
    120_000,
  );
  let cleanedHead = "";
  if (await IOUtils.exists(cleaned)) {
    const bytes = (await IOUtils.read(cleaned)) as Uint8Array;
    cleanedHead = String.fromCharCode(...bytes.slice(0, 5));
  }
  await report(
    "remover-inspect-and-noop",
    inspectOk && remove.exitCode === 0 && cleanedHead.startsWith("%PDF"),
    {
      inspectExit: inspect.exitCode,
      inspectOutExists: inspectOk,
      inspectStderr: inspect.stderr.slice(0, 200),
      removeExit: remove.exitCode,
      cleanedHead,
      removeStderr: remove.stderr.slice(0, 200),
    },
    `inspect=${inspect.exitCode} remove=${remove.exitCode}`,
  );
}

/** A clean run right after the kill scenarios — proves the runner recovers. */
async function scenarioNextTaskAfterKills(): Promise<void> {
  const r = await runProcess(
    config.javaExe,
    fixtureArgs("both", "0"),
    60_000,
  );
  await report(
    "next-task-after-kills",
    r.exitCode === 0 && r.stdout.includes("STDOUT-中文-OK"),
    { exitCode: r.exitCode },
  );
}

// ─── entry point (exposed via esbuild --global-name) ─────────────────────────

export async function runUnicodeProbe(
  cfg: ProbeConfig,
): Promise<{ complete: boolean; failed: number }> {
  config = cfg;
  const impl: Record<string, () => Promise<void>> = {
    env: scenarioEnv,
    "input-hashes": scenarioInputHashes,
    "run-cn-14p": scenarioRunCn,
    "run-en-14p": scenarioRunEn,
    "parse-entry-14p": scenarioParseEntry,
    "run-special-filename": scenarioSpecialFilename,
    "run-cn-java-jar": scenarioCnJavaJar,
    "fail-missing-cn-path": scenarioMissingCnPath,
    "error-propagation": scenarioErrorPropagation,
    "fixture-nonzero-exit7": scenarioFixtureNonzero,
    "fixture-argv-raw": scenarioArgvRaw,
    "fixture-big-dual-stream": scenarioFixtureBig,
    "fixture-timeout": scenarioFixtureTimeout,
    "fixture-cancel": scenarioFixtureCancel,
    "fixture-cancel-startup": scenarioFixtureCancelStartup,
    "fixture-child-tree-kill": scenarioFixtureChildKill,
    "concurrent-two-calls": scenarioConcurrent,
    "next-task-after-kills": scenarioNextTaskAfterKills,
    "launch-failure-distinguishable": scenarioLaunchFailure,
    "check-health-version": scenarioCheckHealth,
    "remover-inspect-and-noop": scenarioRemover,
  };

  // Single authoritative scenario order: SCENARIO_IDS from the shared gates
  // module. An id without an implementation is a probe build defect — report
  // it as a failed scenario instead of silently shrinking the set.
  for (const id of SCENARIO_IDS) {
    const fn = impl[id];
    if (!fn) {
      await report(id, false, {}, "no implementation registered");
      continue;
    }
    try {
      await fn();
    } catch (e: any) {
      await report(id, false, { thrown: String(e?.stack || e) }, "threw");
    }
  }
  await saveResults(true);
  return {
    complete: true,
    failed: results.filter((r) => !r.ok).length,
  };
}
