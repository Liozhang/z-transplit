/* eslint-disable */
var chromeHandle;

/**
 * Preference pane registration (编辑 → 设置 → Z-Transplit).
 *
 * This lives in bootstrap.js, not in addon/prefs.js: Zotero executes prefs.js
 * in a scope whose only global is `pref()` (Zotero.Plugins#setDefaultPrefs),
 * so it cannot reach Zotero.PreferencePanes. bootstrap.js runs in the plugin
 * scope, which has Zotero/Services.
 *
 * The pane markup, script, stylesheet and copy live in:
 *   addon/content/preferences.xhtml
 *   addon/content/preferences.js
 *   addon/content/preferences.css
 *   addon/locale/<locale>/ztransplit-preferences.ftl
 *
 * If src/modules/registerPreferences.ts ever registers the same pane, the
 * fixed pane id makes that a no-op here instead of a duplicate pane.
 */
const PREFS_PANE_ID = "zotero-prefpane-ztransplit";

function registerPreferences(id, rootURI) {
  try {
    const panes = Zotero.PreferencePanes;
    if (!panes || typeof panes.register !== "function") {
      // Zotero < 7 (or a host without the pane API): nothing to register.
      return;
    }
    if ((panes.pluginPanes || []).some((pane) => pane.id === PREFS_PANE_ID)) {
      return;
    }
    // Relative URIs are resolved against the plugin root by
    // Zotero.Plugins.resolveURI; the sidebar label falls back to the plugin
    // name from manifest.json ("Z-Transplit").
    const registered = panes.register({
      pluginID: id,
      id: PREFS_PANE_ID,
      src: "content/preferences.xhtml",
      scripts: ["content/preferences.js"],
      stylesheets: ["content/preferences.css"],
    });
    if (registered && typeof registered.catch === "function") {
      registered.catch((e) => Zotero.logError(
        `Z-Transplit: preference pane registration failed: ${e}`,
      ));
    }
  } catch (e) {
    // A broken settings pane must never keep the addon from starting.
    Zotero.logError(`Z-Transplit: preference pane registration failed: ${e}`);
  }
}

function install(data, reason) {
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "ztransplit", rootURI + "content/"],
  ]);

  // Register the settings pane before the bundle loads, so the pane shows up
  // even if the bundle (or its hooks) fails to start.
  registerPreferences(id, rootURI);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/ztransplit.js`,
    ctx,
  );
  await Zotero.ZTransplit.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.ZTransplit?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.ZTransplit?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.ZTransplit?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {
  // Remove the persistent translation cache directory. Everything else the
  // addon stores lives in the extensions.zotero.ztransplit.* preference
  // branch, which Zotero clears together with the default prefs declared in
  // addon/prefs.js. Best-effort: Zotero may be tearing down already.
  try {
    const IOUtils = globalThis.IOUtils;
    const dir = Zotero.DataDirectory?.dir;
    if (IOUtils?.remove && dir) {
      await IOUtils.remove(
        dir + "/ztransplit/translation-cache",
        { recursive: true, ignoreExisting: true },
      );
    }
  } catch (e) {
    try {
      Zotero.logError("Z-Transplit: cache cleanup failed: " + e);
    } catch { /* ignore */ }
  }
}
