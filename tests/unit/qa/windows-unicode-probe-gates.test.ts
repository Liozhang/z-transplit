/**
 * Permanent self-tests for the Issue #1 probe's fail-closed decision logic
 * (Round 1 review findings R1–R4). Everything runs against fake process
 * inventories and fake command executors — no real process is listed, started
 * or killed, so the negative cases can never touch an unrelated PID.
 */
import { describe, expect, it } from "vitest";
import {
  SCENARIO_IDS,
  buildLaunchEnv,
  evaluateRun,
  interpretProcessQuery,
  stopOwnProcesses,
  waitForPidGone,
} from "../../../scripts/qa/windows-unicode-probe-gates.mjs";
import type { ProcessSnapshot, QueryPayload } from "../../../scripts/qa/windows-unicode-probe-gates.d.mts";

const PROFILE = "D:\\runs\\gui-x\\profile";

function ownProc(pid: number) {
  return {
    pid,
    name: "zotero.exe",
    commandLine: `C:\\Program Files\\Zotero\\zotero.exe -no-remote -profile ${PROFILE}`,
    creationDate: "2026-10-16T00:00:00Z",
  };
}

function snapshot(processes: ProcessSnapshot["processes"]): ProcessSnapshot {
  return { ok: true, processes };
}

function recorder() {
  const killed: number[] = [];
  return {
    killed,
    killTree: (pid: number) => {
      killed.push(pid);
    },
  };
}

function fullResults(over: Record<string, unknown> = {}) {
  return {
    complete: true,
    mode: "gui",
    outDir: PROFILE.replace(/\\profile$/, ""),
    results: SCENARIO_IDS.map((id) => ({ id, ok: true, details: {} })),
    ...over,
  };
}

// ─── R1: cleanup only kills identity-verified processes ──────────────────────

describe("stopOwnProcesses (R1: no kill without identity evidence)", () => {
  it("root already exited: nothing is killed, root is recorded as gone", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () => snapshot([]),
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([]);
    expect(result.observationError).toBeNull();
    expect(result.killed).toEqual([]);
    expect(result.skipped).toContainEqual({ pid: 111, reason: "gone" });
  });

  it("root PID reused by a foreign process: nothing is killed", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () =>
        snapshot([
          { pid: 111, name: "notepad.exe", commandLine: "C:\\Windows\\notepad.exe", creationDate: null },
        ]),
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([]);
    expect(result.killed).toEqual([]);
    expect(result.skipped).toContainEqual({ pid: 111, reason: "identity-mismatch" });
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ pid: 111, reason: "identity-mismatch" })]),
    );
  });

  it("root PID reused by a zotero.exe under a foreign profile: nothing is killed", async () => {
    const rec = recorder();
    const foreign = {
      pid: 111,
      name: "zotero.exe",
      commandLine: "C:\\Program Files\\Zotero\\zotero.exe -profile C:\\Users\\other\\profile",
      creationDate: null,
    };
    const result = await stopOwnProcesses({
      listProcesses: () => snapshot([foreign]),
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([]);
    expect(result.killed).toEqual([]);
    // Root PID gets exactly one skip record (identity-mismatch); the
    // not-this-run sweep is for foreign zotero.exe processes that are NOT
    // the historical root.
    expect(result.skipped).toContainEqual({ pid: 111, reason: "identity-mismatch" });
    expect(result.skipped).not.toContainEqual({ pid: 111, reason: "not-this-run" });
  });

  it("observation failure (query throws): nothing is killed", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () => {
        throw new Error("tasklist unavailable");
      },
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([]);
    expect(result.observationError).toMatch(/tasklist unavailable/);
  });

  it("observation failure (inventory not ok): nothing is killed", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () => ({ ok: false, processes: [], error: "cim query failed" }),
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([]);
    expect(result.observationError).toMatch(/cim query failed/);
  });

  it("still-own process: only the verified PID tree is killed", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () => snapshot([ownProc(222)]),
      killTree: rec.killTree,
      rootPid: 222,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([222]);
    expect(result.killed.map((k) => k.pid)).toEqual([222]);
    expect(result.observationError).toBeNull();
  });

  it("root handed off to a new own PID: only the verified PID is killed", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () => snapshot([ownProc(333)]),
      killTree: rec.killTree,
      rootPid: 111,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([333]);
    expect(result.killed.map((k) => k.pid)).toEqual([333]);
    expect(result.skipped).toContainEqual({ pid: 111, reason: "gone" });
  });

  it("foreign zotero.exe is never killed and is recorded as not-this-run", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () =>
        snapshot([ownProc(222), {
          pid: 444,
          name: "zotero.exe",
          commandLine: `C:\\Program Files\\Zotero\\zotero.exe -profile C:\\elsewhere\\p`,
          creationDate: null,
        }]),
      killTree: rec.killTree,
      rootPid: 222,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([222]);
    expect(result.skipped).toContainEqual({ pid: 444, reason: "not-this-run" });
  });

  it("kill failure is recorded as skipped, never reported as killed", async () => {
    const result = await stopOwnProcesses({
      listProcesses: () => snapshot([ownProc(222)]),
      killTree: () => {
        throw new Error("access denied");
      },
      rootPid: 222,
      profileDir: PROFILE,
    });
    expect(result.killed).toEqual([]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ pid: 222, reason: expect.stringContaining("kill-failed") }),
    );
  });

  it("profile matching is case-insensitive and separator-tolerant", async () => {
    const rec = recorder();
    const result = await stopOwnProcesses({
      listProcesses: () =>
        snapshot([{
          pid: 555,
          name: "zotero.exe",
          commandLine: `C:\\Program Files\\Zotero\\zotero.exe -profile d:/runs/gui-x/PROFILE`,
          creationDate: null,
        }]),
      killTree: rec.killTree,
      rootPid: 555,
      profileDir: PROFILE,
    });
    expect(rec.killed).toEqual([555]);
    expect(result.observationError).toBeNull();
  });

  // The -profile argument value must match exactly. A path substring anywhere
  // else in the command line, or a profile that merely extends the target
  // path, identifies a foreign process and must produce zero kills.
  describe("exact -profile argument matching (R1: no substring ownership)", () => {
    async function killsFor(commandLine: string, profileDir = PROFILE) {
      const rec = recorder();
      const result = await stopOwnProcesses({
        listProcesses: () =>
          snapshot([{ pid: 12345, name: "zotero.exe", commandLine, creationDate: null }]),
        killTree: rec.killTree,
        rootPid: 111,
        profileDir,
      });
      return { killed: rec.killed, result };
    }

    it("profile-other (target path as prefix) is not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -profile "D:\\runs\\gui-x\\profile-other"`,
      );
      expect(killed).toEqual([]);
    });

    it("subdirectory of the target profile is not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -profile "D:\\runs\\gui-x\\profile\\sub"`,
      );
      expect(killed).toEqual([]);
    });

    it("target path referenced outside the -profile argument is not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -profile "D:\\foreign" -url "file:///D:\\runs\\gui-x\\profile"`,
      );
      expect(killed).toEqual([]);
    });

    it("target path as plain substring without any -profile argument is not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -url "D:\\runs\\gui-x\\profile"`,
      );
      expect(killed).toEqual([]);
    });

    it("-profile without a value is not owned", async () => {
      const { killed, result } = await killsFor(`"C:\\Zotero\\zotero.exe" -profile`);
      expect(killed).toEqual([]);
      expect(result.skipped).toContainEqual({ pid: 12345, reason: "profile-unparseable" });
    });

    it("empty command line is not owned", async () => {
      const { killed, result } = await killsFor("");
      expect(killed).toEqual([]);
      expect(result.skipped).toContainEqual({ pid: 12345, reason: "profile-unparseable" });
    });

    it("unterminated quote is not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -profile "D:\\runs\\gui-x\\profile`,
      );
      expect(killed).toEqual([]);
    });

    it("ambiguous duplicate -profile arguments are not owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -profile "D:\\runs\\gui-x\\profile" -profile "D:\\other"`,
      );
      expect(killed).toEqual([]);
    });

    it("exact quoted profile path with spaces is owned (real launcher form)", async () => {
      const spaced = "D:\\Develop\\Misc Workspace\\runs\\gui-x profile\\profile";
      const rec = recorder();
      const result = await stopOwnProcesses({
        listProcesses: () =>
          snapshot([{
            pid: 12345,
            name: "zotero.exe",
            commandLine:
              `"D:\\Tool\\Zotero\\zotero.exe" -no-remote -profile "${spaced}" -ZoteroDebugText`,
            creationDate: null,
          }]),
        killTree: rec.killTree,
        rootPid: 12345,
        profileDir: spaced,
      });
      expect(rec.killed).toEqual([12345]);
      expect(result.observationError).toBeNull();
    });

    it("exact unquoted profile path without spaces is owned", async () => {
      const { killed } = await killsFor(
        `"C:\\Zotero\\zotero.exe" -no-remote -profile D:\\runs\\gui-x\\profile -ZoteroDebugText`,
      );
      expect(killed).toEqual([12345]);
    });
  });
});

// ─── R2: incomplete / mismatched runs never pass ─────────────────────────────

describe("evaluateRun (R2: deadline, incomplete and missing scenarios fail)", () => {
  const RUN_DIR = "D:\\runs\\gui-x";

  it("valid complete run passes", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
      timedOut: false,
      fatal: null,
    });
    expect(verdict).toEqual({ ok: true, failures: [] });
  });

  it("partial results (complete flag false) fail", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR, complete: false }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/incomplete/i);
  });

  it("empty results fail as missing scenarios", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR, results: [] }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f: string) => f.startsWith("missing scenario:"))).toBe(true);
  });

  it("one successful scenario plus a dead probe still fails", () => {
    const verdict = evaluateRun({
      parsed: {
        complete: false,
        mode: "gui",
        outDir: RUN_DIR,
        results: [{ id: "env", ok: true, details: {} }],
      },
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
      timedOut: true,
    });
    expect(verdict.ok).toBe(false);
    const text = verdict.failures.join("\n");
    expect(text).toMatch(/timed out/);
    expect(text).toMatch(/incomplete/i);
    expect(text).toMatch(/missing scenario:/);
  });

  it("missing, duplicate and unexpected ids all fail", () => {
    const results = SCENARIO_IDS.slice(1).map((id) => ({ id, ok: true, details: {} }));
    results.push({ id: SCENARIO_IDS[1], ok: true, details: {} }); // duplicate
    results.push({ id: SCENARIO_IDS[1], ok: true, details: {} }); // triplicate
    results.push({ id: "not-a-scenario", ok: true, details: {} });
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR, results }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(verdict.ok).toBe(false);
    const text = verdict.failures.join("\n");
    expect(text).toMatch(/missing scenario: env/);
    expect(text).toMatch(/duplicate scenario id/);
    expect(text).toMatch(/unexpected scenario id: not-a-scenario/);
  });

  it("ok !== true entries fail", () => {
    const results = SCENARIO_IDS.map((id) => ({
      id,
      ok: id === "env",
      details: id === "env" ? {} : { reason: "boom" },
    }));
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR, results }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f: string) => f.includes("scenario failed:"))).toBe(true);
  });

  it("malformed entries fail", () => {
    const results = [...SCENARIO_IDS.map((id) => ({ id, ok: true, details: {} })), { noId: 1 }];
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR, results }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/malformed result entry/);
  });

  it("unreadable / missing results.json fails", () => {
    const a = evaluateRun({
      parsed: null,
      parseError: "ENOENT",
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    const b = evaluateRun({
      parsed: null,
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
    });
    expect(a.ok).toBe(false);
    expect(a.failures.join("\n")).toMatch(/unreadable/);
    expect(b.ok).toBe(false);
    expect(b.failures.join("\n")).toMatch(/missing or not an object/);
  });

  it("probe-fatal.txt fails the run even with a full result set", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
      fatal: "TypeError: boom",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/probe-fatal/);
  });

  it("deadline alone fails a fully-green result set", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: RUN_DIR }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
      timedOut: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toMatch(/deadline/);
  });

  it("mode and run-directory mismatch fail", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: "D:\\runs\\gui-x" }),
      parseError: null,
      expectedMode: "headless",
      expectedRunDir: "D:\\runs\\headless-y",
    });
    expect(verdict.ok).toBe(false);
    const text = verdict.failures.join("\n");
    expect(text).toMatch(/mode mismatch/);
    expect(text).toMatch(/run mismatch/);
  });

  it("all failure classes accumulate instead of short-circuiting", () => {
    const verdict = evaluateRun({
      parsed: fullResults({ outDir: "D:\\other", complete: false }),
      parseError: null,
      expectedMode: "gui",
      expectedRunDir: RUN_DIR,
      timedOut: true,
      fatal: "boom",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── R3: observation errors are never reported as gone ───────────────────────

describe("interpretProcessQuery / waitForPidGone (R3: no fake cleaned-up)", () => {
  it("query failure is an observation error, not gone", () => {
    const v = interpretProcessQuery({ ok: false, error: "tasklist unavailable" }, 1, "java.exe");
    expect(v.state).toBe("error");
  });

  it("non-zero query exit is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 1, output: "" },
      1,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("corrupt output is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: "not-json{{" },
      1,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("null payload is an observation error", () => {
    expect(interpretProcessQuery(null, 1, "java.exe").state).toBe("error");
  });

  it("exact pid+image present means alive", () => {
    const payload: QueryPayload = {
      ok: true,
      exitCode: 0,
      output: JSON.stringify([{ ProcessId: 7, Name: "java.exe" }]),
    };
    expect(interpretProcessQuery(payload, 7, "java.exe").state).toBe("alive");
  });

  it("empty result set means gone", () => {
    const v = interpretProcessQuery({ ok: true, exitCode: 0, output: "" }, 7, "java.exe");
    expect(v.state).toBe("gone");
    const w = interpretProcessQuery({ ok: true, exitCode: 0, output: "null" }, 7, "java.exe");
    expect(w.state).toBe("gone");
    const x = interpretProcessQuery({ ok: true, exitCode: 0, output: "[]" }, 7, "java.exe");
    expect(x.state).toBe("gone");
  });

  // A parseable JSON shape is not enough: every returned row must be a
  // well-formed observation, and only a well-formed EMPTY result proves the
  // pid is gone. Corrupt or incomplete structures are observation errors.
  it("row without ProcessId is an observation error, not gone", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: "{}" },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("row with missing ProcessId field is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: JSON.stringify([{ Name: "java.exe" }]) },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("string-typed ProcessId is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: JSON.stringify([{ ProcessId: "7", Name: "java.exe" }]) },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("null row is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: "[null]" },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("rows unrelated to the queried pid are not absence evidence", () => {
    const v = interpretProcessQuery(
      {
        ok: true,
        exitCode: 0,
        output: JSON.stringify([{ ProcessId: 9, Name: "java.exe" }]),
      },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("empty Name is an observation error", () => {
    const v = interpretProcessQuery(
      { ok: true, exitCode: 0, output: JSON.stringify([{ ProcessId: 7, Name: "" }]) },
      7,
      "java.exe",
    );
    expect(v.state).toBe("error");
  });

  it("pid reuse by a foreign image is an error, not gone", () => {
    const payload: QueryPayload = {
      ok: true,
      exitCode: 0,
      output: JSON.stringify([{ ProcessId: 7, Name: "notepad.exe" }]),
    };
    expect(interpretProcessQuery(payload, 7, "java.exe").state).toBe("error");
  });

  it("waitForPidGone: query throw fails immediately (never passes)", async () => {
    const res = await waitForPidGone(7, "java.exe", {
      query: () => {
        throw new Error("cim down");
      },
      sleep: async () => {},
    });
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/cim down/);
  });

  it("waitForPidGone: non-zero and corrupt queries fail immediately", async () => {
    const a = await waitForPidGone(7, "java.exe", {
      query: () => ({ ok: true, exitCode: 2, output: "" }),
      sleep: async () => {},
    });
    const b = await waitForPidGone(7, "java.exe", {
      query: () => ({ ok: true, exitCode: 0, output: "###" }),
      sleep: async () => {},
    });
    expect(a.gone).toBe(false);
    expect(a.state).toBe("error");
    expect(b.gone).toBe(false);
    expect(b.state).toBe("error");
  });

  it("waitForPidGone: alive then gone returns gone with evidence trail", async () => {
    let calls = 0;
    const res = await waitForPidGone(7, "java.exe", {
      query: () => {
        calls += 1;
        return calls === 1
          ? { ok: true, exitCode: 0, output: JSON.stringify([{ ProcessId: 7, Name: "java.exe" }]) }
          : { ok: true, exitCode: 0, output: "" };
      },
      sleep: async () => {},
    });
    expect(res.gone).toBe(true);
    expect(res.state).toBe("gone");
    expect(res.evidence.length).toBe(2);
    expect(res.error).toBeNull();
  });

  it("waitForPidGone: still alive past the deadline is a timeout, not gone", async () => {
    let t = 0;
    const res = await waitForPidGone(7, "java.exe", {
      query: () => ({ ok: true, exitCode: 0, output: JSON.stringify([{ ProcessId: 7, Name: "java.exe" }]) }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollMs: 500,
    });
    expect(res.gone).toBe(false);
    expect(res.state).toBe("timeout");
  });

  it("waitForPidGone: passes the remaining budget to each bounded query call", async () => {
    const seenBudgets: number[] = [];
    const res = await waitForPidGone(7, "java.exe", {
      query: (_pid, opts) => {
        seenBudgets.push(opts?.timeoutMs ?? NaN);
        return { ok: true, exitCode: 0, output: "" };
      },
      timeoutMs: 200,
      pollMs: 50,
      sleep: async () => {},
    });
    expect(res.gone).toBe(true);
    expect(seenBudgets.length).toBe(1);
    expect(seenBudgets[0]).toBeGreaterThan(0);
    expect(seenBudgets[0]).toBeLessThanOrEqual(200);
  });

  it("waitForPidGone: awaits the bounded query's final state without racing it", async () => {
    // A compliant bounded query resolves after its own deadline-initiated
    // cleanup (which may land past the poll budget's millisecond mark). The
    // helper must surface that terminal outcome, not an outer-race verdict
    // that abandons the query mid-cleanup.
    const res = await waitForPidGone(7, "java.exe", {
      query: async (_pid, opts) => {
        await new Promise((r) => setTimeout(r, Math.max(30, (opts?.timeoutMs ?? 30) + 20)));
        return { ok: false, error: "query timed out after its budget; cleanup: kill issued" };
      },
      timeoutMs: 15,
      pollMs: 5,
      sleep: async () => {},
    });
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/timed out after its budget/);
    expect(res.error).not.toMatch(/did not complete within/);
  });

  it("waitForPidGone: query timeout payload is a failed observation, not gone", async () => {
    const res = await waitForPidGone(7, "java.exe", {
      query: () => ({
        ok: false,
        error: "query timed out after 20ms; cleanup: kill issued",
      }),
      sleep: async () => {},
    });
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/timed out/);
  });
});

// ─── R4: MOZ_HEADLESS is explicit per mode ───────────────────────────────────

describe("buildLaunchEnv (R4: GUI clears inherited MOZ_HEADLESS)", () => {
  it("gui clears an inherited MOZ_HEADLESS=1", () => {
    const env = buildLaunchEnv({ MOZ_HEADLESS: "1", PATH: "C:\\bin" }, "gui");
    expect(env.MOZ_HEADLESS).toBeUndefined();
    expect(env.PATH).toBe("C:\\bin");
  });

  it("headless explicitly sets MOZ_HEADLESS even if unset", () => {
    const env = buildLaunchEnv({ PATH: "C:\\bin" }, "headless");
    expect(env.MOZ_HEADLESS).toBe("1");
  });

  it("headless overrides a bogus inherited value", () => {
    const env = buildLaunchEnv({ MOZ_HEADLESS: "0" }, "headless");
    expect(env.MOZ_HEADLESS).toBe("1");
  });

  it("gui leaves MOZ_HEADLESS absent when the parent has none", () => {
    const env = buildLaunchEnv({ PATH: "C:\\bin" }, "gui");
    expect("MOZ_HEADLESS" in env).toBe(false);
  });

  it("does not mutate the parent environment object", () => {
    const parent: Record<string, string | undefined> = { MOZ_HEADLESS: "1" };
    buildLaunchEnv(parent, "gui");
    expect(parent.MOZ_HEADLESS).toBe("1");
    buildLaunchEnv(parent, "headless");
    expect(parent.MOZ_HEADLESS).toBe("1");
  });
});

// ─── scenario set integrity (R2: one authoritative list) ─────────────────────

describe("SCENARIO_IDS", () => {
  it("has no duplicate ids", () => {
    expect(new Set(SCENARIO_IDS).size).toBe(SCENARIO_IDS.length);
  });
  it("covers the full acceptance surface", () => {
    for (const id of [
      "run-cn-14p",
      "run-en-14p",
      "fail-missing-cn-path",
      "error-propagation",
      "fixture-timeout",
      "fixture-cancel",
      "fixture-child-tree-kill",
      "launch-failure-distinguishable",
    ]) {
      expect(SCENARIO_IDS).toContain(id);
    }
  });
});
