import { config } from "../../package.json";
import { safeDebug } from "./logger";

const FTL_PREFIX = `${config.addonRef}-`;

/**
 * Fluent sources registered by initLocale(). They live in
 * addon/locale/<locale>/ and are auto-registered by Zotero (see
 * Zotero.Plugins#registerLocales), so this only wires up the in-process
 * Localization instance used by getString().
 */
const FTL_FILES = [
  `${config.addonRef}.ftl`,
  `${config.addonRef}-preferences.ftl`,
  `${config.addonRef}-pane.ftl`,
];

/**
 * Read `_globalThis.addon.data` without touching the `_globalThis` name
 * directly. The bootstrap scope provides it (see the esbuild banner), but the
 * same file is importable from Node (vitest), where it does not exist.
 *
 * Two access paths are needed: under vitest the tests stub
 * `globalThis._globalThis`, while in the real plugin bundle the banner makes
 * `_globalThis` an alias OF `globalThis` (verified in Zotero 7.0.15:
 * `_globalThis === globalThis`, so the `_globalThis` property is undefined and
 * the addon — assigned by src/index.ts through the scope binding — sits
 * directly on `globalThis`).
 */
function getAddonData(): any {
  try {
    const g = globalThis as any;
    return g?._globalThis?.addon?.data ?? g?.addon?.data;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Localization constructor. It is injected into the bootstrap
 * scope by Zotero (see the scope built in Zotero.Plugins#_loadScope) but is not
 * present in the plugin bundle's own scope, so ask Zotero for it.
 */
function resolveLocalizationCtor(): any {
  try {
    const g = globalThis as any;
    if (g?.Localization) return g.Localization;
    if (typeof Zotero !== "undefined" && (Zotero as any).getGlobal) {
      return (Zotero as any).getGlobal("Localization");
    }
  } catch (e) {
    safeDebug(`[Z-Transplit] resolveLocalizationCtor failed: ${String(e)}`);
  }
  return undefined;
}

export function initLocale() {
  const Ctor = resolveLocalizationCtor();
  if (!Ctor) {
    safeDebug("[Z-Transplit] initLocale: Localization unavailable, skipped");
    return;
  }
  try {
    const l10n = new Ctor(FTL_FILES, true);
    const data = getAddonData();
    if (data) {
      data.locale = { current: l10n };
    }
  } catch (e) {
    safeDebug(`[Z-Transplit] initLocale failed: ${String(e)}`);
  }
}

/** Fully qualified Fluent id for a bare message id (build prefixes with `ztransplit-`). */
export function getLocaleID(localeString: string): string {
  return `${FTL_PREFIX}${localeString}`;
}

/**
 * Look up a message. Falls back to the fully qualified id when the locale is
 * not initialized or the message is missing — never throws.
 */
export function getString(
  localeString: string,
  args?: Record<string, unknown>,
): string {
  const id = getLocaleID(localeString);
  const current = getAddonData()?.locale?.current;
  if (!current) return id;
  try {
    const pattern = current.formatMessagesSync([{ id, args }])[0];
    if (pattern?.value) return pattern.value;
    if (pattern) {
      for (const attr of pattern.attributes ?? []) {
        if (attr.name === "placeholder") return attr.value;
      }
    }
    return id;
  } catch (e) {
    safeDebug(`[Z-Transplit] getString('${id}') failed: ${String(e)}`);
    return id;
  }
}
