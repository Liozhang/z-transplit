/**
 * windows-unicode-probe-gates — pure decision logic for the Issue #1 real-host
 * probe launcher and in-host scenario driver. No imports, no side effects: the
 * launcher injects real process inventory / command executors, tests inject
 * fakes. Every function fails closed: unobservable state is never treated as
 * success and no process is stopped without matching identity evidence.
 */

/** Authoritative ordered scenario set. The in-host driver and the launcher-side
 *  completeness check both read this list — never maintain a second copy. */
export const SCENARIO_IDS = [
  "env",
  "input-hashes",
  "run-cn-14p",
  "run-en-14p",
  "parse-entry-14p",
  "run-special-filename",
  "run-cn-java-jar",
  "fail-missing-cn-path",
  "error-propagation",
  "fixture-nonzero-exit7",
  "fixture-argv-raw",
  "fixture-big-dual-stream",
  "fixture-timeout",
  "fixture-cancel",
  "fixture-cancel-startup",
  "fixture-child-tree-kill",
  "concurrent-two-calls",
  "next-task-after-kills",
  "launch-failure-distinguishable",
  "check-health-version",
  "remover-inspect-and-noop",
];

/**
 * Child environment for a Zotero instance. MOZ_HEADLESS must be explicit per
 * mode: headless sets it, GUI removes any inherited value so a parent
 * MOZ_HEADLESS=1 can never silently turn a GUI run into a headless run.
 */
export function buildLaunchEnv(parentEnv, mode) {
  const env = { ...parentEnv };
  if (mode === "headless") {
    env.MOZ_HEADLESS = "1";
  } else {
    delete env.MOZ_HEADLESS;
  }
  return env;
}

function normalizePath(p) {
  return String(p ?? "")
    .replace(/\//g, "\\")
    .toLowerCase()
    .replace(/\\+$/, "");
}

/**
 * Extract the exact `-profile <value>` argument from a Zotero command line.
 * Tokenizes with double-quote grouping (the form Node's spawn produces for
 * paths containing spaces). Only this one form is recognized — it is what
 * this verifier's launcher generates. Returns { ok:true, value } only when
 * exactly one -profile flag has a non-empty value; missing, empty, ambiguous
 * or unparseable command lines are { ok:false } and must never be treated as
 * owned. Path substring anywhere else in the command line is irrelevant.
 */
function extractProfileArg(commandLine) {
  const text = String(commandLine ?? "");
  const tokens = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (inQuotes) return { ok: false, reason: "unterminated quote" };
  if (hasToken) tokens.push(current);

  const profileFlags = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() === "-profile") profileFlags.push(i);
  }
  if (profileFlags.length === 0) return { ok: false, reason: "no -profile argument" };
  if (profileFlags.length > 1) return { ok: false, reason: "ambiguous -profile arguments" };
  const value = tokens[profileFlags[0] + 1];
  if (typeof value !== "string" || value === "") {
    return { ok: false, reason: "missing -profile value" };
  }
  return { ok: true, value };
}

/**
 * Own-instance identity: executable must be zotero.exe AND the command line's
 * exact -profile argument value must equal this run's profileDir after
 * normalization. A matching substring elsewhere (profile-prefix dirs, other
 * arguments referencing the path) is a foreign process.
 */
function matchOwn(proc, profileDir) {
  if (typeof proc?.name !== "string" || proc.name.toLowerCase() !== "zotero.exe") {
    return { own: false, reason: "not-zotero" };
  }
  const parsed = extractProfileArg(proc.commandLine);
  if (!parsed.ok) return { own: false, reason: "profile-unparseable" };
  if (normalizePath(parsed.value) !== normalizePath(profileDir)) {
    return { own: false, reason: "not-this-run" };
  }
  return { own: true, reason: null };
}

/**
 * Stop only processes proven to belong to this run. `listProcesses` returns
 * { ok, processes: [{pid, name, commandLine, creationDate}], error? }; on any
 * observation failure nothing is killed. A PID is killed only when its current
 * executable and command line (exact isolated profile argument) match; the
 * historical root PID alone is never sufficient — it may have exited and been
 * reused. `killTree(pid)` is invoked only for verified PIDs.
 */
export async function stopOwnProcesses({
  listProcesses,
  killTree,
  rootPid,
  profileDir,
}) {
  const killed = [];
  const skipped = [];
  let snapshot;
  try {
    snapshot = await listProcesses();
  } catch (e) {
    return {
      killed,
      skipped,
      observationError: String((e && e.message) || e),
    };
  }
  if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.processes)) {
    return {
      killed,
      skipped,
      observationError: String(snapshot?.error || "process inventory unavailable"),
    };
  }

  const own = snapshot.processes.filter((p) => matchOwn(p, profileDir).own);
  const ownPids = new Set(own.map((p) => p.pid));

  // The historical root PID is killed only under the same identity rule; a
  // mismatch means the PID was reused by something else and must be left alone.
  if (rootPid !== undefined && rootPid !== null && !ownPids.has(rootPid)) {
    const reused = snapshot.processes.find((p) => p.pid === rootPid);
    skipped.push({
      pid: rootPid,
      reason: reused ? "identity-mismatch" : "gone",
    });
  }

  for (const proc of own) {
    try {
      await killTree(proc.pid);
      killed.push({
        pid: proc.pid,
        name: proc.name,
        creationDate: proc.creationDate ?? null,
      });
    } catch (e) {
      skipped.push({
        pid: proc.pid,
        reason: "kill-failed: " + String((e && e.message) || e),
      });
    }
  }

  // Processes visible under a foreign or unparseable profile are never touched.
  for (const proc of snapshot.processes) {
    if (proc?.pid === rootPid && !ownPids.has(proc.pid)) continue;
    if (!ownPids.has(proc?.pid) && proc?.name?.toLowerCase?.() === "zotero.exe") {
      skipped.push({ pid: proc.pid, reason: matchOwn(proc, profileDir).reason || "not-this-run" });
    }
  }

  return { killed, skipped, observationError: null };
}

/**
 * Decide whether one finished run may pass. Failures accumulate: probe fatal
 * file, deadline, incomplete or malformed results, mode/run mismatch,
 * missing/duplicate/unexpected scenario ids, and any entry whose ok is not
 * strictly true. `parsed` is the results.json object (or null when unreadable);
 * `parseError` carries the read/JSON failure text.
 */
export function evaluateRun({
  parsed,
  parseError,
  expectedMode,
  expectedRunDir,
  timedOut,
  fatal,
  expectedIds = SCENARIO_IDS,
}) {
  const failures = [];
  if (fatal) {
    failures.push(`probe-fatal.txt present: ${String(fatal).slice(0, 300)}`);
  }
  if (timedOut) {
    failures.push("run reached its deadline (timed out)");
  }
  if (parseError) {
    failures.push(`results.json unreadable: ${String(parseError).slice(0, 300)}`);
    return { ok: false, failures };
  }
  if (!parsed || typeof parsed !== "object") {
    failures.push("results.json missing or not an object");
    return { ok: false, failures };
  }
  if (parsed.complete !== true) {
    failures.push("results incomplete (complete flag not true)");
  }
  if (parsed.mode !== expectedMode) {
    failures.push(`mode mismatch: results=${parsed.mode} expected=${expectedMode}`);
  }
  if (normalizePath(parsed.outDir) !== normalizePath(expectedRunDir)) {
    failures.push(
      `run mismatch: results outDir=${parsed.outDir} expected=${expectedRunDir}`,
    );
  }
  const results = Array.isArray(parsed.results) ? parsed.results : null;
  if (!results) {
    failures.push("results field missing or not an array");
    return { ok: false, failures };
  }

  const seen = new Map();
  for (const entry of results) {
    const id = entry && typeof entry.id === "string" ? entry.id : null;
    if (!id) {
      failures.push(`malformed result entry: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    seen.set(id, (seen.get(id) || 0) + 1);
    if (entry.ok !== true) {
      failures.push(
        `scenario failed: ${id} — ${JSON.stringify(entry.details ?? {}).slice(0, 200)}`,
      );
    }
  }
  for (const [id, count] of seen) {
    if (count > 1) failures.push(`duplicate scenario id: ${id} (${count}x)`);
    if (!expectedIds.includes(id)) failures.push(`unexpected scenario id: ${id}`);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) failures.push(`missing scenario: ${id}`);
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Interpret one structured process query. `payload` is
 * { ok, exitCode, output, error } from the caller's bounded query executor.
 * Returns { state, evidence } where state is "alive" | "gone" | "error":
 * gone is reported only when the query succeeded AND returned a well-formed
 * empty result. A non-empty result must carry well-formed rows (integer
 * ProcessId, non-empty Name); missing fields, wrong types, null rows and
 * rows unrelated to the queried pid are incomplete observations — "error",
 * never absence evidence. Pid reuse (foreign image) is "error" as well.
 */
export function interpretProcessQuery(payload, pid, expectedImage) {
  const evidence = {
    pid,
    expectedImage,
    ok: payload?.ok ?? null,
    exitCode: payload?.exitCode ?? null,
    outputHead: String(payload?.output ?? "").trim().slice(0, 200),
  };
  if (!payload || payload.ok !== true) {
    return {
      state: "error",
      evidence: { ...evidence, reason: String(payload?.error || "query failed") },
    };
  }
  if (payload.exitCode !== 0) {
    return {
      state: "error",
      evidence: { ...evidence, reason: `query exit code ${payload.exitCode}` },
    };
  }
  let rows;
  const text = String(payload.output ?? "").trim();
  if (text === "" || text === "null") {
    rows = [];
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return {
        state: "error",
        evidence: { ...evidence, reason: "unparsable query output" },
      };
    }
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === "object") rows = [parsed];
    else
      return {
        state: "error",
        evidence: { ...evidence, reason: "incomplete query output" },
      };
  }
  for (const row of rows) {
    const wellFormed =
      row &&
      typeof row === "object" &&
      typeof row.ProcessId === "number" &&
      Number.isInteger(row.ProcessId) &&
      typeof row.Name === "string" &&
      row.Name !== "";
    if (!wellFormed) {
      return {
        state: "error",
        evidence: { ...evidence, reason: "malformed query output row", rows: rows.length },
      };
    }
  }
  if (rows.length === 0) {
    return { state: "gone", evidence: { ...evidence, rows: 0 } };
  }
  const hit = rows.find((r) => r.ProcessId === pid);
  if (!hit) {
    // The real query filters by exact PID: rows unrelated to the request can
    // never prove this pid is gone.
    return {
      state: "error",
      evidence: { ...evidence, reason: "result does not contain queried pid", rows: rows.length },
    };
  }
  const image = hit.Name;
  if (image.toLowerCase() !== String(expectedImage).toLowerCase()) {
    return {
      state: "error",
      evidence: {
        ...evidence,
        reason: `pid reused by ${image}`,
        rows: rows.length,
      },
    };
  }
  return {
    state: "alive",
    evidence: { ...evidence, image, rows: rows.length },
  };
}

/**
 * Poll a pid until it is confirmed gone, with a deadline. `deps.query(pid,
 * { timeoutMs })` returns the payload for {@link interpretProcessQuery} and
 * MUST honor the passed budget as a bounded executor: its deadline initiates
 * process termination at budget expiry, and it does not resolve before its
 * owned process is terminated and reaped. This helper passes the remaining
 * time until its deadline on every call and awaits the query's final state —
 * it never races the query to a premature return, so a query's cleanup is
 * always complete before the wait reports anything.
 * `deps.now()` and `deps.sleep(ms)` are injectable clocks. Returns
 * { gone, state, evidence, error }: only gone===true plus state==="gone"
 * proves disappearance; query errors end the wait with gone===false so
 * callers fail instead of passing on unobservability.
 */
export async function waitForPidGone(pid, expectedImage, deps) {
  const {
    query,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = 15000,
    pollMs = 500,
  } = deps;
  const deadline = now() + timeoutMs;
  const evidence = [];
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { gone: false, state: "timeout", evidence, error: null };
    }
    let payload;
    try {
      payload = await query(pid, { timeoutMs: remaining });
    } catch (e) {
      payload = { ok: false, error: String((e && e.message) || e) };
    }
    const verdict = interpretProcessQuery(payload, pid, expectedImage);
    evidence.push(verdict.evidence);
    if (verdict.state === "gone") {
      return { gone: true, state: "gone", evidence, error: null };
    }
    if (verdict.state === "error") {
      return {
        gone: false,
        state: "error",
        evidence,
        error: String(verdict.evidence?.reason || "pid observation failed"),
      };
    }
    if (now() >= deadline) {
      return { gone: false, state: "timeout", evidence, error: null };
    }
    await sleep(pollMs);
  }
}
