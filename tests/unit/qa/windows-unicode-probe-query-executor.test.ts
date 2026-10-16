/**
 * Lifecycle tests for the REAL QA query executor exported from
 * windows-unicode-probe-entry.ts (rawExec/queryPid — QA-internal, not a
 * product API). A fake ChromeUtils/Subprocess drives the actual functions:
 * no executor code is copied here. The contract under test: the termination
 * deadline covers the startup window; kill/wait/stream reaping complete
 * before the executor (and waitForPidGone above it) ever resolve; each path
 * has exactly one terminal outcome; timers are cleared; kill/capture failures
 * are recorded honestly instead of claiming "reaped".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  queryPid,
  rawExec,
} from "../../../scripts/qa/windows-unicode-probe-entry";
import { waitForPidGone } from "../../../scripts/qa/windows-unicode-probe-gates.mjs";

// ─── deferred-driven fake Subprocess ─────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePipe(chunks: string[], throwOnRead: boolean) {
  let i = 0;
  let eof = false;
  const waiters: Array<() => void> = [];
  return {
    readString(): Promise<string> {
      if (throwOnRead) return Promise.reject(new Error("read failed"));
      if (i < chunks.length) return Promise.resolve(chunks[i++]);
      if (eof) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(() => resolve("")));
    },
    closeEof() {
      eof = true;
      while (waiters.length) waiters.shift()!();
    },
  };
}

interface FakeCall {
  spec: unknown;
  killCalls: number;
  startup: ReturnType<typeof deferred<unknown>>;
  stdinClose: ReturnType<typeof deferred<void>>;
  waitGate: ReturnType<typeof deferred<number>>;
  killGate: ReturnType<typeof deferred<void>>;
  stdout: ReturnType<typeof makePipe>;
  stderr: ReturnType<typeof makePipe>;
  proc: Record<string, unknown>;
}

function installFakeSubprocess(
  options: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    autoDeath?: boolean;
    autoExit?: boolean;
    hangStdinClose?: boolean;
    throwOnStdoutRead?: boolean;
    startupPending?: boolean;
  } = {},
) {
  const {
    stdoutChunks = [],
    stderrChunks = [],
    autoDeath = true,
    autoExit = false,
    hangStdinClose = false,
    throwOnStdoutRead = false,
    startupPending = false,
  } = options;
  const calls: FakeCall[] = [];

  const Subprocess = {
    call(spec: unknown): Promise<unknown> {
      const c: FakeCall = {
        spec,
        killCalls: 0,
        startup: deferred<unknown>(),
        stdinClose: deferred<void>(),
        waitGate: deferred<number>(),
        killGate: deferred<void>(),
        stdout: makePipe(stdoutChunks, throwOnStdoutRead),
        stderr: makePipe(stderrChunks, false),
        proc: {},
      };
      c.proc = {
        stdin: { close: () => c.stdinClose.promise },
        stdout: c.stdout,
        stderr: c.stderr,
        wait: () => c.waitGate.promise.then((exitCode) => ({ exitCode })),
        kill: () => {
          c.killCalls += 1;
          return c.killGate.promise.then(() => {
            if (autoDeath) {
              c.waitGate.resolve(-9);
              c.stdout.closeEof();
              c.stderr.closeEof();
            }
          });
        },
      };
      calls.push(c);
      if (!startupPending) {
        queueMicrotask(() => {
          c.startup.resolve(c.proc);
          if (autoExit) {
            c.waitGate.resolve(0);
            c.stdout.closeEof();
            c.stderr.closeEof();
          }
        });
      }
      return c.startup.promise;
    },
  };

  (globalThis as any).ChromeUtils = {
    importESModule: () => ({ Subprocess }),
  };
  if (!hangStdinClose) {
    // stdin.close resolves as soon as a call exists
    const orig = Subprocess.call.bind(Subprocess);
    Subprocess.call = (spec: unknown) => {
      const p = orig(spec) as Promise<unknown>;
      const c = calls[calls.length - 1];
      queueMicrotask(() => c.stdinClose.resolve());
      return p;
    };
  }
  return { calls };
}

async function waitUntil(cond: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  delete (globalThis as any).ChromeUtils;
  vi.restoreAllMocks();
});

// ─── rawExec lifecycle ───────────────────────────────────────────────────────

describe("rawExec (real QA executor over fake Subprocess)", () => {
  it("natural completion: streams and exit code returned, no kill", async () => {
    installFakeSubprocess({ stdoutChunks: ["out", "put"], stderrChunks: ["err"], autoExit: true });
    const r = await rawExec("cmd.exe", ["arg"], 5000);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("output");
    expect(r.stderr).toBe("err");
    expect(r.timedOut).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.cleanupNotes).toEqual([]);
  });

  it("runtime timeout: neither this promise nor cleanup completes until kill is released, then wait+streams reaped", async () => {
    const host = installFakeSubprocess({ autoDeath: true });
    let settled = false;
    const p = rawExec("cmd.exe", ["arg"], 20).then((r) => {
      settled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    await sleep(30);
    expect(settled).toBe(false); // kill not released → executor must not resolve
    host.calls[0].killGate.resolve();
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-9);
    expect(r.cleanupNotes).toContain("kill issued");
    expect(host.calls[0].killCalls).toBe(1);
  });

  it("kill/wait/stream gates held: the executor and waitForPidGone both stay pending, then complete after reaping", async () => {
    const host = installFakeSubprocess({ autoDeath: false });
    let layerSettled = false;
    const p = waitForPidGone(7, "java.exe", {
      query: (pid, opts) => queryPid(pid, opts),
      timeoutMs: 25,
      pollMs: 5,
      sleep: async () => {},
    }).then((r) => {
      layerSettled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    await sleep(30);
    expect(layerSettled).toBe(false); // kill released? no — both layers pending
    // release kill, but keep wait/streams gated: still must not resolve
    host.calls[0].killGate.resolve();
    await sleep(30);
    expect(layerSettled).toBe(false);
    host.calls[0].waitGate.resolve(-9);
    host.calls[0].stdout.closeEof();
    host.calls[0].stderr.closeEof();
    const res = await p;
    expect(layerSettled).toBe(true);
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/timed out/);
  });

  it("late startup handle: deadline expires first, handle is killed on arrival before return", async () => {
    const host = installFakeSubprocess({ startupPending: true, autoDeath: true });
    let settled = false;
    const p = rawExec("cmd.exe", ["arg"], 20).then((r) => {
      settled = true;
      return r;
    });
    await sleep(40); // deadline passes while Subprocess.call is pending
    expect(host.calls.length).toBe(1);
    expect(host.calls[0].killCalls).toBe(0); // no handle yet
    expect(settled).toBe(false);
    host.calls[0].startup.resolve(host.calls[0].proc);
    await waitUntil(() => host.calls[0].killCalls === 1); // killed on arrival
    await sleep(20);
    expect(settled).toBe(false); // kill gate still held → must not resolve
    host.calls[0].killGate.resolve();
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.cleanupNotes).toContain("kill issued");
  });

  it("stdin.close hung: does not block reaping or push termination past the return", async () => {
    const host = installFakeSubprocess({ hangStdinClose: true, autoDeath: true });
    const p = rawExec("cmd.exe", ["arg"], 20);
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    host.calls[0].killGate.resolve();
    const r = await p; // resolves while stdin.close is still pending
    expect(r.timedOut).toBe(true);
    expect(r.cleanupNotes).toContain("kill issued");
    // The hung close never blocked the return; its late failure is noted
    // asynchronously into the same honest cleanup record, never thrown.
    host.calls[0].stdinClose.reject(new Error("close hung"));
    await sleep(10);
    expect(r.cleanupNotes.some((n) => n.includes("stdin close failed"))).toBe(true);
  });

  it("read failure + kill success: both layers wait for the surviving reader and wait() before returning", async () => {
    // Fake kill does NOT release any resource (autoDeath off): the executor
    // itself must keep awaiting the other pipe and wait() — a rejected
    // Promise.all is not resource reaping.
    const host = installFakeSubprocess({ throwOnStdoutRead: true, autoDeath: false });
    let settled = false;
    const p = waitForPidGone(7, "java.exe", {
      query: (pid, opts) => queryPid(pid, opts),
      timeoutMs: 5000,
      pollMs: 5,
      sleep: async () => {},
    }).then((r) => {
      settled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    host.calls[0].killGate.resolve(); // kill succeeded; wait/EOFs still gated
    await sleep(30);
    expect(settled).toBe(false); // stderr + wait pending → neither layer may complete
    host.calls[0].stderr.closeEof();
    await sleep(10);
    expect(settled).toBe(false); // wait() still pending
    host.calls[0].waitGate.resolve(1);
    const res = await p;
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/stream capture failed/);
    expect(res.error).toMatch(/cleanup: kill issued/);
  });

  it("read failure + kill failure: still waits for wait() and the surviving reader; honest notes", async () => {
    const host = installFakeSubprocess({ throwOnStdoutRead: true, autoDeath: false });
    let settled = false;
    const p = rawExec("cmd.exe", ["arg"], 5000).then((r) => {
      settled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    host.calls[0].killGate.reject(new Error("access denied"));
    await sleep(30);
    expect(settled).toBe(false); // kill failed, but the process may still be alive → must wait
    host.calls[0].stderr.closeEof();
    await sleep(10);
    expect(settled).toBe(false);
    host.calls[0].waitGate.resolve(1);
    const r = await p;
    expect(r.error).toMatch(/stream capture failed/);
    expect(r.cleanupNotes).toContain("kill failed: access denied");
    expect(r.cleanupNotes).not.toContain("kill issued");
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(false);
  });

  it("startup failure: returns a failed observation without killing anything", async () => {
    (globalThis as any).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: () => Promise.reject(new Error("CreateProcess failed")),
        },
      }),
    };
    const r = await rawExec("missing.exe", ["arg"], 5000);
    expect(r.error).toMatch(/startup failed: CreateProcess failed/);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(-1);
    expect(r.cleanupNotes).toEqual([]);
  });

  it("kill failure is recorded honestly (no claim of reaping)", async () => {
    const host = installFakeSubprocess({ autoDeath: true });
    let settled = false;
    const p = rawExec("cmd.exe", ["arg"], 20).then((r) => {
      settled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    host.calls[0].killGate.reject(new Error("access denied"));
    await sleep(20);
    expect(settled).toBe(false); // wait/EOFs not released yet → must not return
    host.calls[0].waitGate.resolve(1);
    host.calls[0].stdout.closeEof();
    host.calls[0].stderr.closeEof();
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.cleanupNotes).toContain("kill failed: access denied");
    expect(r.cleanupNotes).not.toContain("kill issued");
    expect(r.exitCode).toBe(1);
  });

  it("clears its deadline timer on the natural path", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    installFakeSubprocess({ stdoutChunks: ["ok"], autoExit: true });
    const r = await rawExec("cmd.exe", [], 5000);
    expect(r.timedOut).toBe(false);
    expect(clearSpy).toHaveBeenCalled();
  });
});

// ─── queryPid + waitForPidGone integration ──────────────────────────────────

describe("queryPid over the real executor, driven through waitForPidGone", () => {
  it("well-formed empty result confirms gone after full completion", async () => {
    installFakeSubprocess({ stdoutChunks: ["null"], autoExit: true });
    const res = await waitForPidGone(7, "java.exe", {
      query: (pid, opts) => queryPid(pid, opts),
      timeoutMs: 5000,
      pollMs: 10,
      sleep: async () => {},
    });
    expect(res.gone).toBe(true);
    expect(res.state).toBe("gone");
  });

  it("timed-out query surfaces the executor's post-cleanup evidence as a failed observation", async () => {
    const host = installFakeSubprocess({ autoDeath: true });
    let settled = false;
    const p = waitForPidGone(7, "java.exe", {
      query: (pid, opts) => queryPid(pid, opts),
      timeoutMs: 25,
      pollMs: 5,
      sleep: async () => {},
    }).then((r) => {
      settled = true;
      return r;
    });
    await waitUntil(() => host.calls.length === 1 && host.calls[0].killCalls === 1);
    await sleep(20);
    expect(settled).toBe(false); // kill gate held: neither layer may complete
    host.calls[0].killGate.resolve();
    const res = await p;
    expect(res.gone).toBe(false);
    expect(res.state).toBe("error");
    expect(res.error).toMatch(/timed out after \d+ms/);
    expect(res.error).toMatch(/cleanup: kill issued/);
  });
});
