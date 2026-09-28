import { config } from "../../package.json";
import { safeDebug } from "./logger";

const PREFS_PREFIX = config.prefsPrefix;

export type PrefValue = boolean | string | number;

/**
 * Preferences live on the `extensions.zotero.ztransplit.*` branch, declared as
 * defaults in addon/prefs.js. Every read is defensive: the Zotero global is not
 * present when these modules are imported outside Zotero (vitest), and a pref
 * read must never be able to break the caller.
 */
function prefs(): any {
  if (typeof Zotero === "undefined") return undefined;
  return (Zotero as any).Prefs;
}

function readPref(key: string): PrefValue | undefined {
  const branch = prefs();
  if (!branch) return undefined;
  try {
    return branch.get(`${PREFS_PREFIX}.${key}`, true) as PrefValue | undefined;
  } catch (e) {
    safeDebug(`[Z-Transplit] getPref('${key}') failed: ${String(e)}`);
    return undefined;
  }
}

/**
 * Read a preference declared in addon/prefs.js.
 *
 * Kept separate from {@link getPrefDynamic} so callers can tell "a key the
 * addon declares as a default" apart from "a runtime/string key"; both read the
 * same prefixed branch and neither throws.
 */
export function getPref(key: string): PrefValue | undefined {
  return readPref(key);
}

/**
 * Read a dynamically keyed preference (string keys built at runtime).
 *
 * Unlike {@link getPref} this short-circuits when `Zotero.Prefs` is missing
 * instead of relying on the error path, which is the common case for hosts that
 * import addon modules without a Zotero global.
 */
export function getPrefDynamic(key: string): PrefValue | undefined {
  if (!prefs()) return undefined;
  return readPref(key);
}
