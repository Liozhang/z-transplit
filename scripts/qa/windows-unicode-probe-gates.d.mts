/** Typed surface of windows-unicode-probe-gates.mjs (pure fail-closed logic). */

export type RunMode = "gui" | "headless";

export const SCENARIO_IDS: string[];

export function buildLaunchEnv(
  parentEnv: Record<string, string | undefined>,
  mode: RunMode,
): Record<string, string | undefined>;

export interface ProbeProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
  creationDate?: string | number | null;
}

export interface ProcessSnapshot {
  ok: boolean;
  processes: ProbeProcessInfo[];
  error?: string;
}

export interface StopOwnResult {
  killed: Array<{ pid: number; name: string; creationDate: string | number | null }>;
  skipped: Array<{ pid: number; reason: string }>;
  observationError: string | null;
}

export function stopOwnProcesses(opts: {
  listProcesses: () => Promise<ProcessSnapshot> | ProcessSnapshot;
  killTree: (pid: number) => Promise<void> | void;
  rootPid?: number | null;
  profileDir: string;
}): Promise<StopOwnResult>;

export interface EvaluateRunInput {
  parsed: unknown;
  parseError?: string | null;
  expectedMode: RunMode;
  expectedRunDir: string;
  timedOut?: boolean;
  fatal?: string | null;
  expectedIds?: string[];
}

export function evaluateRun(input: EvaluateRunInput): {
  ok: boolean;
  failures: string[];
};

export interface QueryPayload {
  ok: boolean;
  exitCode?: number | null;
  output?: string | null;
  error?: string | null;
}

export function interpretProcessQuery(
  payload: QueryPayload | null | undefined,
  pid: number,
  expectedImage: string,
): { state: "alive" | "gone" | "error"; evidence: Record<string, unknown> };

export function waitForPidGone(
  pid: number,
  expectedImage: string,
  deps: {
    query: (
      pid: number,
      opts?: { timeoutMs?: number },
    ) => Promise<QueryPayload> | QueryPayload;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<{
  gone: boolean;
  state: "gone" | "error" | "timeout" | "alive";
  evidence: Array<Record<string, unknown>>;
  error: string | null;
}>;
