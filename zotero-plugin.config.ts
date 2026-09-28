import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*", "src/core/pdf/lib/*.jar"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage || "https://github.com/example/z-transplit",
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    fluent: {
      // The FTL sources already carry the `ztransplit-` prefix in their file
      // names (addon/locale/en-US/ztransplit-preferences.ftl, …), and the
      // scaffold's default prefixLocaleFiles would turn them into
      // `ztransplit-ztransplit-preferences.ftl`. Keep the names as authored —
      // they are what src/utils/locale.ts registers. Message ids are still
      // prefixed (prefixFluentMessages stays at its default of true), which is
      // why the .ftl sources write ids WITHOUT the leading `ztransplit-`.
      prefixLocaleFiles: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          __buildVersion__: JSON.stringify(pkg.version),
        },
        banner: {
          js: `
// Expose globalThis as _globalThis — used throughout the codebase.
// Zotero loads the bundle via Services.scriptloader.loadSubScript(url, ctx),
// where ctx is a plain scope object; without this alias every reference to
// _globalThis (and therefore to _globalThis.addon) throws.
var _globalThis = globalThis;
// Polyfill console for Zotero SpiderMonkey environment
if (typeof console === 'undefined') {
  const logToZotero = (prefix, args) => {
    const msg = Array.from(args).map(a => {
      if (typeof a === 'string') return a;
      if (typeof a === 'number' || typeof a === 'boolean') return String(a);
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a, function(key, value) {
            if (typeof value === 'object' && value !== null) {
              if (value.nodeType) return '[DOM Node]';
              if (typeof value[Symbol.iterator] === 'function') return '[Iterable]';
            }
            return value;
          });
        } catch (e) {
          return '[Object]';
        }
      }
      return String(a);
    }).join(' ');
    if (typeof Zotero !== 'undefined' && Zotero.debug) {
      Zotero.debug(prefix + ' ' + msg);
    }
  };
  this.console = {
    log: function(...args) { logToZotero('[console.log]', args); },
    error: function(...args) { logToZotero('[console.error]', args); },
    warn: function(...args) { logToZotero('[console.warn]', args); },
    info: function(...args) { logToZotero('[console.info]', args); },
    debug: function(...args) { logToZotero('[console.debug]', args); },
    group: function() {},
    groupCollapsed: function() {},
    groupEnd: function() {},
    trace: function() {},
    table: function() {},
    time: function() {},
    timeLog: function() {},
    timeEnd: function() {},
    clear: function() {},
    count: function() {},
    assert: function() {},
    dir: function() {},
    dirxml: function() {}
  };
}
// Global console reference
var console = this.console;
// Polyfill Buffer for jszip (and other libs that expect it) in the Zotero
// SpiderMonkey environment
if (typeof Buffer === "undefined") {
  this.Buffer = {
    from: function(d, e) {
      if (typeof d === "string") return new TextEncoder().encode(e || "utf-8");
      if (d instanceof Uint8Array || d instanceof ArrayBuffer) return new Uint8Array(d);
      return d;
    },
    isBuffer: function() { return false; },
    alloc: function(s) { return new Uint8Array(s); },
    concat: function(a, b) {
      var r = new Uint8Array(a.length + b.length);
      r.set(a);
      r.set(b, a.length);
      return r;
    },
  };
}
`,
        },
        // Drop console in production to reduce bundle noise
        drop: process.env.NODE_ENV === "development" ? [] : ["console"],
        // Post-build: replace problematic console calls
        write: true,
        bundle: true,
        target: "firefox140",
        plugins: [],
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
});
