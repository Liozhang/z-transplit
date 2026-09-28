/**
 * Lightweight logger over Zotero.debug.
 *
 * Everything is guarded: logging must never throw, and must never crash when the
 * Zotero global is absent (Node/vitest imports these modules directly).
 */

function rawDebug(message: string, stackFrame?: number): void {
  try {
    if (typeof Zotero === "undefined") return;
    if (stackFrame !== undefined) {
      Zotero.debug(message, stackFrame);
    } else {
      Zotero.debug(message);
    }
  } catch {
    /* ignore — logging must never throw */
  }
}

/** True for dev builds. Guarded: `__env__` only exists in the bundle. */
function isDevBuild(): boolean {
  try {
    return typeof __env__ !== "undefined" && __env__ === "development";
  } catch {
    return false;
  }
}

/**
 * Always-on debug log. The safe form: safe to call from anywhere, including
 * error paths where the host environment may be half-broken.
 */
export function safeDebug(message: string): void {
  rawDebug(message);
}

/** DEBUG level — only emitted in dev builds. */
export function debug(message: string): void {
  if (!isDevBuild()) return;
  rawDebug(message);
}

export function info(message: string): void {
  rawDebug(message);
}

export function warn(message: string): void {
  rawDebug(`[Z-Transplit][warn] ${message}`);
}

export function error(message: string): void {
  rawDebug(`[Z-Transplit][error] ${message}`, 2);
}
