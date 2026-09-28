/**
 * abort — AbortController/AbortSignal access for the plugin bundle scope.
 *
 * The bundle runs in Zotero's shared plugin scope, where the WEB PLATFORM
 * globals `AbortController` and `AbortSignal` are NOT defined (found in the
 * 10.0.3 manual verification: `ReferenceError: AbortController is not
 * defined`, while fetch/TextEncoder/XMLHttpRequest ARE). They live on the main
 * window — so resolve the constructors from there, falling back to the bare
 * global for hosts that do expose them.
 *
 * @module utils/abort
 */

/** The AbortController constructor from the main window (undefined if absent). */
export function getAbortControllerCtor(): any {
  const g = globalThis as any;
  if (typeof g.AbortController === "function") return g.AbortController;
  try {
    const win = (globalThis as any).Zotero?.getMainWindow?.();
    if (win && typeof win.AbortController === "function") return win.AbortController;
  } catch {
    /* no Zotero (node tests) — fall through */
  }
  return undefined;
}

/**
 * Create an AbortController. Throws only when no host provides the
 * constructor at all — callers treat that as "cancellation unsupported".
 */
export function createAbortController(): any {
  const AC = getAbortControllerCtor();
  if (!AC) throw new Error("AbortController unavailable in this host");
  return new AC();
}

/**
 * `AbortSignal.timeout(ms)` equivalent for the bundle scope: prefers the
 * platform static, falls back to a controller + window timer.
 */
export function abortSignalTimeout(ms: number): any {
  const g = globalThis as any;
  if (typeof g.AbortSignal?.timeout === "function") {
    return g.AbortSignal.timeout(ms);
  }
  const AC = getAbortControllerCtor();
  if (!AC) return undefined;
  const controller = new AC();
  try {
    (globalThis as any).Zotero?.getMainWindow?.().setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, ms);
  } catch {
    /* without a timer the signal simply never fires — same as no timeout */
  }
  return controller.signal;
}
