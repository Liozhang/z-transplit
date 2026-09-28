/**
 * Globals injected by the Zotero bootstrap / esbuild banner.
 *
 * The plugin bundle is loaded by addon/bootstrap.js through
 * `Services.scriptloader.loadSubScript(url, ctx)` where `ctx` is a plain scope
 * object that the esbuild banner aliases to `_globalThis`
 * (see the banner in zotero-plugin.config.ts). None of these names exist outside
 * Zotero, so any code that can also run under Node (vitest) must access them
 * defensively — `src/utils/locale.ts` and `src/utils/logger.ts` show the pattern.
 */

declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  /** The live Addon instance (NOT the class) — see `declare const addon` below. */
  addon: typeof addon;
};

declare const rootURI: string;

declare const addon: import("../src/addon").default;

/**
 * Zotero chrome-realm XPCOM handle. zotero-types types `Components` only as a
 * Window member whose contract-id index covers a fixed set of services, so a
 * dynamic lookup like Components.classes["@mozilla.org/prompt-service;1"] fails
 * to compile. Declaring the bare global as `any` keeps dynamic contract
 * lookups compiling — same convention as the reference implementation
 * (leadero src/types/global.d.ts).
 */
declare const Components: any;

/** Replaced at bundle time by esbuild `define` (zotero-plugin.config.ts). */
declare const __env__: "production" | "development";

/** Replaced at bundle time by esbuild `define` (zotero-plugin.config.ts). */
declare const __buildVersion__: string;
