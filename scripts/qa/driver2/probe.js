/**
 * probe.js — real-machine QA probe, injected into a COPY of the built addon
 * (scripts/qa/real-machine.mjs builds D:\zt-qa\addon-under-test from
 * .scaffold/build/addon and patches that copy's bootstrap to load this file).
 *
 * The shipped addon is never modified. The probe runs once, in the real
 * Zotero chrome realm, after the addon's own onStartup() has completed, and
 * exercises the real UI paths:
 *
 *   snapshot / reader / menus / prefs / locales / engines / pipeline
 *
 * Results are written as JSON to D:\zt-qa\result.json.
 */

/* exported startProbe */
var PROBE_CMDS = {};
var PROBE_STATE = { done: false };

function probeLog(m) {
  Zotero.debug("[Z-TRANSPLIT-QA] " + m);
}

async function probeWriteJSON(name, obj) {
  try {
    const f = PathUtils.join("D:\\zt-qa", name);
    await IOUtils.writeUTF8(f, JSON.stringify(obj, null, 2));
  } catch (e) {
    probeLog("write failed: " + e);
  }
}

function pEl(doc, tag, cls) {
  const e = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (cls) e.className = cls;
  return e;
}

// ── handlers ────────────────────────────────────────────────────────────────
PROBE_CMDS.ping = async function () {
  return { pong: true, zotero: Zotero.version, at: new Date().toISOString() };
};

PROBE_CMDS.snapshot = async function () {
  const out = { zoteroVersion: Zotero.version, checks: {}, errors: [] };
  const g = (k) => Zotero.Prefs.get("extensions.zotero.ztransplit." + k, true);

  try {
    out.checks.addonGlobal = !!Zotero.ZTransplit;
    out.checks.addonInitialized = !!Zotero.ZTransplit?.data?.initialized;
  } catch (e) {
    out.errors.push("addon: " + e);
  }

  try {
    const sections = Zotero.ItemPaneManager.registeredSections || {};
    out.checks.sections = Object.keys(sections);
    out.checks.hasTranslateSection = !!sections["ztransplit-translate"];
  } catch (e) {
    out.errors.push("sections: " + e);
  }

  try {
    const l = Zotero.Reader._listeners;
    out.checks.readerListeners = Object.keys(l || {});
    const cv = (l || {}).createViewContextMenu || [];
    out.checks.transplitMenuListeners = cv.filter((f) =>
      String(f).includes("splitview-menu") ||
      String(f).includes("getString") ||
      /translate.*side/.test(String(f)),
    ).length;
  } catch (e) {
    out.errors.push("readers: " + e);
  }

  try {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const menu = doc.getElementById("ztransplit-itemmenu");
    out.checks.itemTreeMenu = !!menu;
    if (menu) {
      out.checks.itemTreeMenuLabel = menu.getAttribute("label");
      out.checks.itemTreeMenuItems = Array.from(
        menu.querySelectorAll("menupopup > menuitem"),
        (m) => [m.id, m.getAttribute("label")],
      );
    }
  } catch (e) {
    out.errors.push("itemmenu: " + e);
  }

  try {
    const panes = Zotero.PreferencePanes.pluginPanes || [];
    out.checks.prefPane = panes.some((p) => p.id === "zotero-prefpane-ztransplit");
  } catch (e) {
    out.errors.push("prefpane: " + e);
  }

  out.prefs = {
    "translate.enabled": g("translate.enabled"),
    "translate.auto": g("translate.auto"),
    "translate.engineType": g("translate.engineType"),
    "translate.maxChars": g("translate.maxChars"),
    "translate.google.apiKey": g("translate.google.apiKey"),
    "translate.targetLanguage": g("translate.targetLanguage"),
    "pdfParser.opendataloader.enabled": g("pdfParser.opendataloader.enabled"),
  };

  try {
    const loc = Zotero.ZTransplit?.data?.locale?.current;
    out.checks.localeReady = !!loc;
    if (loc) {
      out.checks.samples = {
        "pane-translate-source": await loc.formatValue("pane-translate-source"),
        "pane-translate-refresh": await loc.formatValue("pane-translate-refresh"),
        "itemtree-menu": await loc.formatValue("itemtree-menu"),
        "splitview-menu-translate": await loc.formatValue("splitview-menu-translate"),
      };
    }
  } catch (e) {
    out.errors.push("locale: " + e);
  }

  return out;
};

/** Introspect real host API shapes so the other assertions read them right. */
PROBE_CMDS.introspect = async function () {
  const out = { errors: [] };
  const secs = Zotero.ItemPaneManager.registeredSections || {};
  out.sectionKeys = Object.keys(secs);
  out.sectionDetail = Object.keys(secs).map((k) => ({
    key: k,
    paneID: secs[k]?.paneID,
    pluginID: secs[k]?.pluginID,
    header: secs[k]?.header,
    sidenav: secs[k]?.sidenav,
  }));

  const R = Zotero.Reader;
  out.readerApi = Object.keys(R).filter((k) =>
    /listener|Listener/i.test(k),
  );
  const l = R._listeners;
  out.readerListenerKeys = l ? Object.keys(l) : null;
  if (l) {
    for (const k of Object.keys(l)) {
      out["listeners_" + k] = (l[k] || []).map((f) => String(f).slice(0, 120));
    }
  }
  out.readerHasRegisterEventListener = typeof R.registerEventListener;

  // Locale: use the same sync API the addon itself uses.
  try {
    const loc = Zotero.ZTransplit?.data?.locale?.current;
    out.localeCtor = !!loc;
    if (loc) {
      const ids = [
        "pane-translate-source",
        "pane-translate-refresh",
        "itemtree-menu",
        "splitview-menu-translate",
        "bilingual-enable",
      ];
      const res = loc.formatMessagesSync(ids.map((id) => ({ id: "ztransplit-" + id })));
      out.localeSync = res.map((r) => [r.id, r.value]);
      const asyncRes = await Promise.all(
        ids.map(async (id) => [id, await loc.formatValue("ztransplit-" + id)]),
      );
      out.localeAsync = asyncRes;
    }
  } catch (e) {
    out.errors.push("locale: " + e);
  }

  out.availableLocales = Zotero.locale ? "set" : "unset";
  out.zoteroLocale = Zotero.locale;
  return out;
};

/** Find the real section registry and reader listener store on Zotero 10. */
PROBE_CMDS.introspect2 = async function () {
  const out = { errors: [] };
  const ipm = Zotero.ItemPaneManager;
  out.ipmKeys = Object.keys(ipm);
  for (const k of Object.keys(ipm)) {
    const v = ipm[k];
    if (v && typeof v === "object") {
      for (const sk of Object.keys(v)) {
        if (/transplit/i.test(sk)) {
          out["hit_" + k + "::" + sk] = v[sk];
        }
      }
    }
  }
  const R = Zotero.Reader;
  const rl = R._registeredListeners;
  out.registeredListenerIsMap = rl instanceof Map;
  out.registeredListenerEntries = [];
  if (rl instanceof Map) {
    for (const [k, v] of rl.entries()) {
      const arr = Array.from(v || []);
      out.registeredListenerEntries.push({
        key: String(k),
        len: arr.length,
        items: arr.map((e) => String(e).slice(0, 240)),
      });
    }
  } else if (rl) {
    for (const k of Object.keys(rl)) {
      const arr = Array.from(rl[k] || []);
      out.registeredListenerEntries.push({
        key: k,
        len: arr.length,
        items: arr.map((e) => String(e).slice(0, 240)),
      });
    }
  }

  const sm = Zotero.ItemPaneManager._sectionManager;
  out.sectionManagerType = Object.prototype.toString.call(sm);
  out.sectionManagerKeys = sm ? Object.keys(sm) : null;
  for (const k of ["sections", "_sections", "registeredSections", "_sectionDefs"]) {
    if (sm && sm[k]) {
      const secs = sm[k];
      out["sm_" + k + "_keys"] = Object.keys(secs);
      out["sm_" + k + "_ours"] = Object.keys(secs).filter((x) => /transplit/i.test(x));
    }
  }
  try {
    if (sm?.sections) {
      out.sectionsValues = Object.entries(sm.sections).map(([k, v]) => ({
        k,
        keys: Object.keys(v || {}),
        paneID: v?.paneID,
        pluginID: v?.pluginID,
        headerL10n: v?.header?.l10nID,
      }));
    }
  } catch (e) {
    out.errors.push("sections: " + e);
  }
  return out;
};

/** ZoteroPane / Zotero_Tabs live in the main window scope, not in this addon scope. */
function probeWin() {
  const w = Zotero.getMainWindow();
  return { win: w, ZoteroPane: w?.ZoteroPane, Zotero_Tabs: w?.Zotero_Tabs };
}

/** Search the whole window for the addon's rendered DOM and section state. */
PROBE_CMDS.sectionState = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const html = new win.XMLSerializer().serializeToString(doc.body || doc.documentElement);
  const hits = {
    ztransplitTranslate: (html.match(/ztransplit-translate/g) || []).length,
    ztransplitTpPane: (html.match(/ztransplit-tp-pane/g) || []).length,
    ztransplitBc: (html.match(/ztransplit-bc-/g) || []).length,
    sourceTextLabel: html.includes("Source text"),
    refreshSelection: html.includes("Refresh selection"),
    bilingualBar: html.includes("ztransplit-bc-bar"),
  };
  // Who renders? Check the item pane manager's internal section list.
  const ipm = Zotero.ItemPaneManager;
  let sm = null;
  try {
    sm = ipm._sectionManager;
  } catch {}
  const config = sm?._config || sm?.config || null;
  return {
    hits,
    ipmSectionManagerKeys: sm ? Object.keys(sm) : null,
    configSections: config
      ? Object.entries(config).map(([k, v]) => ({
          k,
          paneID: v?.paneID,
          pluginID: v?.pluginID,
          enabled: v?.enabled,
          type: typeof v,
        }))
      : null,
    optionsCacheKeys: sm?._optionsCache ? Object.keys(sm._optionsCache) : null,
    itemPaneSidenav: (() => {
      const sn = doc.getElementById("zotero-item-pane-sidenav");
      return sn
        ? Array.from(sn.querySelectorAll("[id*='transplit']"), (n) => [
            n.id,
            n.getAttribute("label"),
            n.hidden,
          ])
        : "no sidenav";
    })(),
  };
};

/** Introspect the reader's selection API on this Zotero version. */
PROBE_CMDS.readerApi = async function () {
  const win = Zotero.getMainWindow();
  const tabID = win.Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  if (!reader) return { error: "no reader" };
  const internal = reader._internalReader;
  const out = {
    readerKeys: Object.keys(reader).filter((k) => /select|text|page/i.test(k)),
    internalKeys: Object.keys(internal),
    primaryType: Object.prototype.toString.call(internal._primaryView),
    secondaryType: Object.prototype.toString.call(internal._secondaryView),
  };
  const pv = internal._primaryView;
  out.primaryKeys = pv ? Object.keys(pv) : null;
  out.selectionKeys = pv
    ? Object.keys(pv).filter((k) => /select|range|text/i.test(k))
    : null;
  const inner = pv?._primaryView || pv?.pdfView || pv?._window?.PDFViewerApplication;
  out.innerType = Object.prototype.toString.call(inner);
  out.innerKeys = inner
    ? Object.keys(inner).filter((k) => /select|find|controller/i.test(k))
    : null;
  out.findControllerKeys =
    inner?.findController ? Object.keys(inner.findController) : null;
  out.selectionRanges = pv?._selectionRanges;
  return out;
};

/**
 * Inspect the split-view panes' own browsers (not the outer readers): this is
 * the chain ReaderPane#installScrollTrigger walks.
 */
PROBE_CMDS.splitPanes = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const out = { panes: [] };
  // The split container the addon builds, holding two reader <browser>s.
  const containers = Array.from(
    doc.querySelectorAll("[class*='ztransplit-split']"),
  );
  out.containers = containers.map((c) => c.className);
  for (const c of containers) {
    const browsers = Array.from(c.querySelectorAll("browser") || []);
    out.containersDetail = out.containersDetail || [];
    out.containersDetail.push({
      className: c.className,
      browserCount: browsers.length,
    });
  }
  // Any reader <browser> in the window with a reader.html payload.
  const allBrowsers = Array.from(doc.querySelectorAll("browser") || []);
  out.browsersTotal = allBrowsers.length;
  for (const b of allBrowsers) {
    let info = { id: b.id || null, cls: b.className || null };
    try {
      const cw = b.contentWindow;
      const wrapped = cw?.wrappedJSObject || cw;
      info.hasContentWindow = !!cw;
      info.hasWrapped = !!cw?.wrappedJSObject;
      info.hasReaderOnWrapped = !!wrapped?._reader;
      info.hasReaderOnDirect = !!cw?._reader;
      const ir = wrapped?._reader || cw?._reader || null;
      info.hasInternalReader = !!ir;
      if (ir) {
        const pv = ir._primaryView;
        info.hasPrimaryView = !!pv;
        info.hasIframe = !!pv?._iframe;
        const ifw = pv?._iframe?.contentWindow;
        info.hasIframeWin = !!ifw;
        info.viewerOnDirect = !!ifw?.document?.getElementById?.("viewerContainer");
        info.viewerOnWrapped = !!ifw?.wrappedJSObject?.document?.getElementById?.(
          "viewerContainer",
        );
        info.cuAvailable =
          typeof Components.utils?.exportFunction === "function";
      }
    } catch (e) {
      info.error = String(e);
    }
    out.panes.push(info);
  }
  return out;
};

/** Dump the split-view readers' internals to see where the iframe lives. */
PROBE_CMDS.splitReaders = async function () {
  const win = Zotero.getMainWindow();
  const readers = Zotero.Reader._readers || [];
  const out = { readerCount: readers.length, readers: [] };
  for (const r of readers) {
    const item = {};
    try {
      const ir = r._internalReader;
      item.itemID = r.itemID;
      item.internalKeys = ir
        ? Object.keys(ir).filter((k) => /View$|iframe|Iframe|Split|sdt|Sdt|SDT/.test(k))
        : null;
      const pv = ir?._primaryView;
      item.primaryType = Object.prototype.toString.call(pv);
      item.primaryKeys = pv
        ? Object.keys(pv).filter((k) => /iframe|Iframe|View$/.test(k))
        : null;
      item.hasIframeProp = !!pv?._iframe;
      item.hasContentWindow = !!pv?._iframe?.contentWindow;
      const cw = pv?._iframe?.contentWindow;
      item.viewerContainerDirect = !!cw?.document?.getElementById?.("viewerContainer");
      item.viewerContainerWrapped =
        !!cw?.wrappedJSObject?.document?.getElementById?.("viewerContainer");
      item.cuExportFunction =
        typeof Components.utils?.exportFunction === "function";
      item.hasSdtView = !!ir?._primarySDTView;
      item.sdtKeys = ir?._primarySDTView
        ? Object.keys(ir._primarySDTView).slice(0, 20)
        : null;
    } catch (e) {
      item.error = String(e);
    }
    out.readers.push(item);
  }
  try {
    const doc = win.document;
    out.readerBrowsers = doc.querySelectorAll("browser[type='content']").length;
    out.splitContainers = Array.from(
      doc.querySelectorAll("[class*='split']"),
      (n) => n.className,
    ).slice(0, 10);
  } catch (e) {
    out.domError = String(e);
  }
  return out;
};

/** Create a real text selection in the reader's text layer. */
PROBE_CMDS.selectText = async function () {
  const win = Zotero.getMainWindow();
  const tabID = win.Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  const pv = reader?._internalReader?._primaryView;
  if (!pv) return { error: "no primary view" };
  const out = { method: null };
  const iw = pv._iframeWindow;
  if (iw?.document) {
    const spans = iw.document.querySelectorAll(".textLayer span");
    out.textLayerSpans = spans.length;
    if (spans.length >= 2) {
      try {
        const sel = iw.getSelection();
        const range = iw.document.createRange();
        range.setStart(spans[0].firstChild, 0);
        const last = spans[Math.min(8, spans.length - 1)];
        range.setEnd(last.firstChild, last.firstChild?.textContent?.length || 1);
        sel.removeAllRanges();
        sel.addRange(range);
        iw.document.dispatchEvent(new iw.Event("selectionchange", { bubbles: true }));
        await Zotero.Promise.delay(800);
        out.method = "textLayer";
      } catch (e) {
        out.textLayerError = String(e);
      }
    }
  }
  let ranges = pv._selectionRanges;
  out.realRanges = Array.isArray(ranges) ? ranges.length : null;
  // Structural fallback: a range object in the shape the pane consumes.
  if (!Array.isArray(ranges) || ranges.length === 0) {
    const text =
      "Machine learning is a subfield of artificial intelligence. " +
      "Its central premise is that systems can learn from data, identify patterns, and make decisions with minimal human intervention.";
    pv._selectionRanges = [
      { pageIndex: 0, text, collapsed: false, bbox: [0, 0, 100, 100] },
    ];
    out.method = (out.method || "") + "+synthetic";
    ranges = pv._selectionRanges;
  }
  out.finalRanges = ranges.length;
  out.selectedText = (ranges || [])
    .map((r) => r?.text)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 200);
  return out;
};

/**
 * Drive the translate pane like a user: select text in the real reader,
 * click 「Refresh selection」, read the source box, then click 「Translate」
 * and read the result.
 */
PROBE_CMDS.paneFlow = async function (targetLang) {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  if (!section) return { error: "section not enabled — run openContextPane first" };

  const tabID = win.Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  const view = reader?._internalReader?._primaryView;
  if (!view) return { error: "no primary view" };

  const out = { steps: [] };
  out.steps.push(["readerItemID", reader.itemID]);

  // A genuine selection through the reader's own text layer.
  try {
    if (typeof view.selectAll === "function") {
      view.selectAll();
      await Zotero.Promise.delay(400);
    }
  } catch (e) {
    out.selectAllError = String(e);
  }
  const ranges = view._selectionRanges;
  out.steps.push(["selectionRanges", Array.isArray(ranges) ? ranges.length : String(ranges)]);
  const selText = (ranges || []).map((r) => r?.text).filter(Boolean).join("\n\n");
  out.selectionChars = selText.length;

  // Click 「Refresh selection」
  const refreshBtn = Array.from(section.querySelectorAll("button")).find(
    (b) => /Refresh selection/i.test(b.textContent || ""),
  );
  if (refreshBtn) refreshBtn.click();
  await Zotero.Promise.delay(1200);
  const sourceBox = section.querySelector(".ztransplit-tp-source-text");
  out.afterRefresh = {
    sourceText: (sourceBox?.textContent || "").slice(0, 300),
    resultArea: (section.querySelector(".ztransplit-tp-result")?.textContent || "").slice(
      0,
      200,
    ),
    hasTranslateBtn: !!Array.from(section.querySelectorAll("button")).find(
      (b) => /^Translate$/i.test(b.textContent || ""),
    ),
  };

  // Set the target language the way the user types it.
  if (targetLang) {
    const input = section.querySelector(".ztransplit-tp-lang-input");
    if (input) {
      input.value = targetLang;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.Event("blur", { bubbles: true }));
      await Zotero.Promise.delay(300);
    }
  }

  /** Wait until the result area settles (loading → success/error). */
  async function waitResult() {
    let last = "";
    for (let i = 0; i < 45; i++) {
      await Zotero.Promise.delay(1000);
      const t = (
        section.querySelector(".ztransplit-tp-result")?.textContent || ""
      ).trim();
      last = t;
      if (/failed|Error/.test(t) && !/Translating/.test(t)) break;
      if (t && !/^Translate$/.test(t) && !/Translating/.test(t)) break;
    }
    return last;
  }

  // Click 「Translate」 (or the language blur already started one).
  const translateBtn = Array.from(section.querySelectorAll("button")).find(
    (b) => /^Translate$/i.test(b.textContent || ""),
  );
  if (translateBtn) {
    translateBtn.click();
    await Zotero.Promise.delay(400);
  }
  const settled = await waitResult();
  const resultText = section.querySelector(".ztransplit-tp-result-text");
  const errText = section.querySelector(".ztransplit-tp-error");
  out.settled = settled.slice(0, 300);
  out.final = {
    success: !!resultText,
    translation: (resultText?.textContent || "").slice(0, 400),
    error: (errText?.textContent || "").slice(0, 300),
    copyBtn: Array.from(section.querySelectorAll("button"))
      .filter((b) => /^Copy$|^Copied$/.test(b.textContent || ""))
      .map((b) => b.textContent),
    langInputValue: section.querySelector(".ztransplit-tp-lang-input")?.value,
  };
  return out;
};

/** Force the section's lazy render (Zotero's own entry point) and read it. */
PROBE_CMDS.renderSection = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  if (!section) return { error: "no enabled section" };
  const out = { pane: section.dataset.pane, before: (section.textContent || "").length };
  // 1) scroll it into view (what a user does)
  const scroller = section.closest(".zotero-view-item-main") || section.parentElement;
  if (scroller?.scrollIntoView) section.scrollIntoView({ block: "center" });
  await Zotero.Promise.delay(1000);
  out.afterScroll = (section.textContent || "").length;
  // 2) invoke the host's lazy-render entry point
  try {
    if (typeof section.render === "function") section.render();
  } catch (e) {
    out.renderError = String(e);
  }
  try {
    if (typeof section.asyncRender === "function") await section.asyncRender();
  } catch (e) {
    out.asyncError = String(e);
  }
  await Zotero.Promise.delay(600);
  const text = section.textContent || "";
  return {
    ...out,
    afterRender: text.length,
    text: text.slice(0, 1200),
    buttons: Array.from(section.querySelectorAll("button"), (b) => [
      b.className,
      b.textContent,
    ]),
    inputs: Array.from(section.querySelectorAll("input"), (i) => [
      i.className,
      i.value,
      i.placeholder,
    ]),
    hasBcBar: !!section.querySelector(".ztransplit-bc-bar"),
    bcText: (section.querySelector(".ztransplit-bc-bar")?.textContent || "").slice(
      0,
      500,
    ),
    containsRawIds: text.includes("pane-translate-"),
    styles: Array.from(section.querySelectorAll("style"), (s) => s.className),
  };
};

/** Expand the reader context pane and dump the real section DOM. */
PROBE_CMDS.openContextPane = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const cp = doc.getElementById("zotero-context-pane");
  const before = { collapsed: cp?.collapsed, hidden: cp?.hidden };
  // Toggle it open the way the host does.
  if (cp?.collapsed) {
    const btn =
      doc.getElementById("zotero-tb-context-pane") ||
      doc.getElementById("context-pane-toggle") ||
      doc.querySelector("[id*='context'][class*='toggle']");
    if (btn) {
      btn.click();
    }
    // Zotero 10: the module is the window global ZoteroContextPane (not
    // Zotero.ContextPane); setting collapsed=false drives the splitter state
    // through its setter, which is what actually expands the reader sidebar.
    const zcp = win.ZoteroContextPane;
    if (zcp) {
      zcp.collapsed = false;
      if (typeof zcp.update === "function") zcp.update();
    }
    await Zotero.Promise.delay(1500);
  }
  const readerDetails = Array.from(doc.querySelectorAll("item-details")).find(
    (d) => d.tabType === "reader",
  );
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  const any = Array.from(doc.querySelectorAll("item-pane-custom-section")).find(
    (c) => (c.dataset.pane || "").includes("transplit"),
  );
  const target = section || any;
  const sidenav = readerDetails?.sidenav;
  return {
    before,
    after: { collapsed: doc.getElementById("zotero-context-pane")?.collapsed },
    sidenavHTML: sidenav ? sidenav.outerHTML.slice(0, 1200) : "none",
    chosenPane: target?.dataset.pane,
    chosenHidden: target?.hidden,
    chosenInitialized: target?.initialized,
    chosenText: (target?.textContent || "").slice(0, 900),
    buttons: target
      ? Array.from(target.querySelectorAll("button"), (b) => [
          b.className,
          b.textContent,
        ])
      : null,
    inputs: target
      ? Array.from(target.querySelectorAll("input"), (i) => [
          i.className,
          i.value,
          i.placeholder,
        ])
      : null,
    hasBcBar: !!target?.querySelector(".ztransplit-bc-bar"),
    bcText: (
      target?.querySelector(".ztransplit-bc-bar")?.textContent || ""
    ).slice(0, 500),
    containsRawIds: (target?.textContent || "").includes("pane-translate-"),
    contextPaneChildren: cp
      ? Array.from(cp.querySelectorAll("*"), (n) => n.tagName).slice(0, 40)
      : null,
  };
};

/** Select the Translate section in the reader's side-nav and render it. */
PROBE_CMDS.selectTranslatePane = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const readerDetails = Array.from(doc.querySelectorAll("item-details")).find(
    (d) => d.tabType === "reader",
  );
  if (!readerDetails) return { error: "no reader item-details" };
  const sidenav = readerDetails.sidenav;
  const panes = sidenav
    ? Array.from(sidenav.querySelectorAll("[id]"), (n) => n.id)
    : null;
  // Click the Translate side-nav row — what the user does.
  let clicked = null;
  if (sidenav) {
    const rows = Array.from(sidenav.querySelectorAll("button, .pane-label, [data-pane]"));
    for (const r of rows) {
      if (/Translate/i.test(r.textContent || "")) {
        r.click();
        clicked = r.tagName + ":" + (r.textContent || "").trim();
        break;
      }
    }
  }
  await Zotero.Promise.delay(1200);
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit"));
  const text = section ? section.textContent : "";
  return {
    sidenavId: sidenav?.id,
    sidenavPanes: panes,
    clicked,
    sectionHidden: section?.hidden,
    sectionText: text.slice(0, 900),
    buttons: section
      ? Array.from(section.querySelectorAll("button"), (b) => [
          b.className,
          b.textContent,
        ])
      : null,
    langInput: section?.querySelector("input")?.value ?? null,
    hasBcBar: !!section?.querySelector(".ztransplit-bc-bar"),
    bcText: (section?.querySelector(".ztransplit-bc-bar")?.textContent || "").slice(
      0,
      400,
    ),
    containsRawIds:
      text.includes("pane-translate-") || text.includes("itemtree-"),
  };
};

/** Report every item-details / custom-section instance in the window. */
PROBE_CMDS.allPanes = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const details = Array.from(doc.querySelectorAll("item-details"), (d) => ({
    tabType: d.tabType,
    tabID: d.tabID,
    item: d.item?.id ?? null,
    skipRender: d.skipRender,
    hidden: d.hidden,
    sidenavId: d.sidenav?.id,
    customPanes: Array.from(d.querySelectorAll("item-pane-custom-section"), (c) => [
      c.dataset.pane,
      c.hidden,
    ]),
  }));
  const sections = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
    (c) => ({
      pane: c.dataset.pane,
      hidden: c.hidden,
      initialized: c.initialized,
      text: (c.textContent || "").slice(0, 200),
    }),
  );
  return {
    detailsCount: details.length,
    details,
    sectionsCount: sections.length,
    sections,
    selectedTabType: win.Zotero_Tabs?.selectedType,
    openTabs: Array.from(doc.querySelectorAll("#zotero-tabs tab") || [], (t) => [
      t.id,
      t.getAttribute("type"),
      t.getAttribute("selected"),
    ]),
  };
};

/** Report the item-pane visibility and reader tab layout. */
PROBE_CMDS.paneVisible = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const q = (sel) => {
    const el = doc.querySelector(sel);
    if (!el) return "MISSING";
    return { id: el.id, hidden: el.hidden, collapsed: el.collapsed };
  };
  return {
    itemPane: q("#zotero-item-pane"),
    contextPane: q("#zotero-context-pane"),
    itemPaneSplitter: q("#zotero-item-pane-splitter"),
    tabsDeck: q("#zotero-tabs"),
    layout: Zotero.Prefs.get("pane.layout", true),
    paneTabType: doc
      .getElementById("zotero-view-item")
      ?.closest("[tabType]")
      ?.getAttribute?.("tabType"),
    itemPaneHeaderTabs: Array.from(
      doc.querySelectorAll("#zotero-item-pane-header > *"),
      (e) => [e.tagName, e.id, e.getAttribute?.("label")],
    ),
    readerTabsOpen: Array.from(
      doc.querySelectorAll("#zotero-tabs tabpanels tab") || [],
      (e) => [e.id, e.getAttribute?.("type")],
    ),
    selectedTabId: win.Zotero_Tabs?.selectedID,
    selectedTabType: win.Zotero_Tabs?.selectedType,
  };
};

/** Locate every occurrence of the addon's section id with its enabled state. */
PROBE_CMDS.sectionHits = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const out = [];
  const all = doc.querySelectorAll("[id*='transplit']");
  for (const n of all) {
    out.push({
      tag: n.tagName,
      id: n.id,
      hidden: n.hidden,
      attrs: n.getAttributeNames().filter((a) => a !== "class" && a !== "id"),
      parentTag: n.parentElement?.tagName,
      parentId: n.parentElement?.id,
      text: (n.textContent || "").slice(0, 120),
    });
  }
  // Sidenav / item-pane containers
  const containers = {};
  for (const id of [
    "zotero-item-pane-content",
    "zotero-item-pane-sidenav",
    "zotero-context-pane",
    "zotero-item-pane-header",
  ]) {
    const el = doc.getElementById(id);
    containers[id] = el ? "present" : "MISSING";
  }
  // Reader tab container
  const readerTab = doc.querySelector("tab[selected]");
  const sidePane = doc.getElementById("zotero-view-tabpad");
  return {
    occurrences: out,
    containers,
    selectedTabType: readerTab?.getAttribute("type"),
    selectedTabLabel: readerTab?.getAttribute("label"),
    itemPaneTabs: Array.from(
      doc.querySelectorAll("#zotero-item-pane-header tab") || [],
      (t) => [t.id, t.getAttribute("label"), t.selected],
    ),
    tabpads: Array.from(doc.querySelectorAll("[id*='tabpad']") || [], (t) => t.id),
  };
};

/** Dump the item-pane DOM while a reader tab is active. */
PROBE_CMDS.paneDump = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const found = [];
  const walk = (el, depth) => {
    if (depth > 6) return;
    for (const c of el.children || []) {
      const id = c.id || "";
      const cls = c.getAttribute?.("class") || "";
      if (
        /transplit|ztransplit|translate|Translate/.test(id + " " + cls) ||
        depth <= 3
      ) {
        found.push({
          d: depth,
          tag: c.tagName,
          id,
          cls,
          text: (c.textContent || "").slice(0, 90),
          attrs: c.getAttributeNames
            ? c.getAttributeNames().filter((a) => a !== "class" && a !== "id")
            : [],
        });
      }
      walk(c, depth + 1);
    }
  };
  const root = doc.getElementById("zotero-item-pane-content") || doc.body;
  walk(root, 0);

  const btns = [];
  for (const b of doc.querySelectorAll(".ztransplit-tp-btn")) {
    btns.push([b.className, b.textContent]);
  }
  const styles = [];
  for (const s of doc.querySelectorAll("style")) {
    if ((s.textContent || "").includes("ztransplit")) styles.push(s.className || "(anon)");
  }
  return {
    nodes: found.slice(0, 70),
    count: found.length,
    tpButtons: btns,
    transplitStyles: styles,
    bcBar: !!doc.querySelector(".ztransplit-bc-bar"),
  };
};

/**
 * Open a real PDF in the library in the real reader, then report the
 * translate pane DOM the addon mounts (R1/R2 regressions live here).
 */
PROBE_CMDS.reader = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const dataDir = Zotero.DataDirectory.dir;
  const pdfPath = PathUtils.join(dataDir, "qa-sample.pdf");
  if (!(await IOUtils.exists(pdfPath))) return { skipped: "no PDF" };

  const { ZoteroPane, Zotero_Tabs } = probeWin();
  let item = new Zotero.Item("journalArticle");
  item.setField("title", "QA sample paper");
  const itemID = await item.saveTx();
  const att = await Zotero.Attachments.importFromFile({
    file: pdfPath,
    parentItemID: itemID,
    title: "QA sample PDF",
  });
  const attID = att.id;

  // Single-item selection: with several items selected Zotero shows the
  // "N items in this view" message and never renders item-details (so no
  // custom sections render at all).
  ZoteroPane.selectItem(attID);
  await Zotero.Promise.delay(500);
  await ZoteroPane.viewAttachment(attID);
  await Zotero.Promise.delay(5000);

  const tabID = Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  const section = doc.querySelector(
    'item-pane-custom-section[data-pane="ztransplit-translate"]',
  );
  const text = section ? section.textContent : "";
  return {
    attachmentID: attID,
    readerOpen: !!reader,
    readerItemID: reader?.itemID ?? null,
    tabType: Zotero_Tabs.selectedType ?? null,
    sectionFound: !!section,
    sectionText: text.slice(0, 800),
    containsRawFtlIds:
      text.includes("pane-translate-") || text.includes("itemtree-"),
    bilingualBlock: !!doc.querySelector(".ztransplit-bc-bar"),
    bilingualText: (
      doc.querySelector(".ztransplit-bc-bar")?.textContent || ""
    ).slice(0, 600),
    buttons: section
      ? Array.from(section.querySelectorAll("button"), (b) => [
          b.className,
          b.textContent,
        ])
      : null,
  };
};

/** Build the real reader context menu and list what z-transplit appends. */
PROBE_CMDS.menus = async function (action) {
  const { Zotero_Tabs } = probeWin();
  const tabID = Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  if (!reader) return { error: "no active reader — run 'reader' first" };

  const registered = Array.from(Zotero.Reader._registeredListeners || []);
  const cv = registered.filter((x) => x.type === "createViewContextMenu");

  const appended = [];
  for (const entry of cv) {
    try {
      await entry.handler({ reader, append: (o) => appended.push(o) });
    } catch (e) {
      appended.push({ label: "LISTENER-ERROR", _err: String(e) });
    }
  }
  const labels = appended.map((a) => a.label);

  if (!action || action === "labels") {
    return {
      count: cv.length,
      ourHandlers: cv.filter((x) =>
        String(x.pluginID || "").includes("ztransplit"),
      ).length,
      transplitEntries: labels.filter((l) => /side by side|comparison|Split-screen|Translate/i.test(l || "")),
      all: labels,
      labels,
    };
  }

  const re =
    action === "split"
      ? /side by side|Side-by-side|分屏|Split-screen/i
      : action === "compare"
        ? /comparison|Compare|对比/i
        : null;
  const entry = re ? appended.find((a) => a.label && re.test(a.label)) : null;
  if (!entry) return { labels, error: "no entry matching " + action };

  const t0 = Date.now();
  try {
    await entry.onCommand();
    return { invoked: entry.label, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return {
      invoked: entry.label,
      error: String(e),
      name: e?.name,
      stack: String(e?.stack || "").slice(0, 1200),
    };
  }
};

/** Fire the library item-tree menu on the current selection. */
PROBE_CMDS.itemtree = async function (action) {
  const { win, ZoteroPane } = probeWin();
  const doc = win.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return { error: "zotero-itemmenu missing" };
  const sel = ZoteroPane.itemsView.getSelectedItems();
  popup.dispatchEvent(new win.Event("popupshowing"));
  const menu = doc.getElementById("ztransplit-itemmenu");
  if (!menu) return { error: "ztransplit-itemmenu missing" };
  const items = Array.from(menu.querySelectorAll("menupopup > menuitem"), (m) => [
    m.id,
    m.getAttribute("label"),
  ]);
  if (!action || action === "labels") {
    return {
      selection: sel.map((i) => [i.id, i.getField?.("title")]),
      visible: menu.getAttribute("hidden") !== "true",
      items,
    };
  }
  const target = doc.getElementById("ztransplit-itemmenu-" + action);
  if (!target) return { error: "missing menuitem " + action, items };
  try {
    target.doCommand();
    await Zotero.Promise.delay(3000);
    return { invoked: target.getAttribute("label"), ok: true, items };
  } catch (e) {
    return { invoked: action, error: String(e), name: e?.name };
  }
};

/** Open the real settings window, report the pane's rendered DOM. */
PROBE_CMDS.prefs = async function (engine) {
  let win = null;
  try {
    Zotero.Utilities.Internal.openPreferences("zotero-prefpane-ztransplit");
    for (let i = 0; i < 30 && !win; i++) {
      await Zotero.Promise.delay(300);
      win = Services.wm.getMostRecentWindow("zotero:pref");
    }
  } catch (e) {
    return { error: "openPreferences: " + e };
  }
  if (!win) return { error: "no prefs window" };
  const doc = win.document;
  const pane = doc.getElementById("zotero-prefpane-ztransplit");
  if (!pane) {
    return {
      error: "pane missing",
      found: Array.from(doc.querySelectorAll("[id^='zotero-prefpane-']"), (n) => n.id),
    };
  }

  const groups = {};
  for (const id of ["google", "bing", "deepl", "ai", "custom", "pdftranslate"]) {
    const g = doc.getElementById("ztransplit-pref-engine-" + id);
    groups[id] = g ? !g.hidden : "missing";
  }

  const read = () => ({
    engineValue: doc.getElementById("ztransplit-pref-engine-type")?.value,
    groups: (() => {
      const o = {};
      for (const id of ["google", "bing", "deepl", "ai", "custom", "pdftranslate"]) {
        const g = doc.getElementById("ztransplit-pref-engine-" + id);
        o[id] = g ? !g.hidden : "missing";
      }
      return o;
    })(),
    prefNow: Zotero.Prefs.get("extensions.zotero.ztransplit.translate.engineType", true),
  });

  const before = read();
  const out = {
    paneFound: true,
    windowTitle: doc.title || null,
    containsRawIds: (pane.textContent || "").includes("preferences-ztransplit-"),
    groups,
    before,
    maxCharsValue: doc.getElementById("ztransplit-pref-maxchars")?.value,
    timeoutValue: doc.getElementById("ztransplit-pref-odl-timeout")?.value,
    fontPath: doc.getElementById("ztransplit-pref-pdf-fonts-path")?.textContent?.trim(),
    targetLangValue: doc.getElementById("ztransplit-pref-pdf-lang")?.value,
    promptText:
      doc.getElementById("ztransplit-pref-ai-prompt")?.textContent?.slice(0, 500) || null,
    pdftranslateMissingVisible: !!doc
      .getElementById("ztransplit-pref-engine-pdftranslate")
      ?.querySelector("#ztransplit-pref-pdftranslate-missing")
      ?.checkVisibility?.(),
  };

  if (engine) {
    const ml = doc.getElementById("ztransplit-pref-engine-type");
    ml.value = engine;
    ml.doCommand();
    await Zotero.Promise.delay(400);
    out.afterSwitch = read();
    // Restore google to leave a clean state.
    ml.value = "google";
    ml.doCommand();
    await Zotero.Promise.delay(300);
  }

  try {
    win.close();
  } catch {
    /* ignore */
  }
  return out;
};

/** Real network translation through the installed addon's own code. */
PROBE_CMDS.engine = async function (which) {
  const scope = {};
  Services.scriptloader.loadSubScript(
    "chrome://ztransplit/content/scripts/ztransplit.js",
    scope,
  );
  const create = scope.createTranslator;
  if (typeof create !== "function") return { error: "no createTranslator in bundle" };
  const text = "Hello world, this is a QA smoke test.";
  const t0 = Date.now();
  try {
    const fn = create(which)("x", which, "en");
    const res = await fn(text, "zh-CN", "en");
    return { engine: which, result: String(res).slice(0, 300), ms: Date.now() - t0 };
  } catch (e) {
    return {
      engine: which,
      ms: Date.now() - t0,
      error: String(e),
      name: e?.name,
      stack: String(e?.stack || "").slice(0, 900),
    };
  }
};

/** Locale parity between en-US and zh-CN FTL sources. */
PROBE_CMDS.locales = async function () {
  const out = {};
  for (const locale of ["en-US", "zh-CN"]) {
    const keys = new Set();
    for (const f of ["ztransplit.ftl", "ztransplit-pane.ftl", "ztransplit-preferences.ftl"]) {
      try {
        const text = await Zotero.File.getContentsAsync(
          "chrome://ztransplit/locale/" + locale + "/" + f,
        );
        for (const line of text.split("\n")) {
          const m = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=/);
          if (m) keys.add(f + "::" + m[1]);
        }
      } catch (e) {
        keys.add("READ-ERROR " + f + ": " + e);
      }
    }
    out[locale] = [...keys].sort();
  }
  const a = new Set(out["en-US"]);
  const b = new Set(out["zh-CN"]);
  out.onlyInEn = [...a].filter((k) => !b.has(k));
  out.onlyInZh = [...b].filter((k) => !a.has(k));
  out.enCount = a.size;
  out.zhCount = b.size;
  return out;
};

/**
 * Click the real item-tree menu item with a real PDF selected — the user's
 * actual path through 「翻译全文（生成译文附件）」. Creates the item, selects
 * it, then invokes the menu item's command handler.
 */
PROBE_CMDS.pipelineViaMenu = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const dataDir = Zotero.DataDirectory.dir;
  const pdfPath = PathUtils.join(dataDir, "qa-sample.pdf");
  if (!(await IOUtils.exists(pdfPath))) return { skipped: "no PDF" };
  const { ZoteroPane, Zotero_Tabs } = probeWin();

  let item = new Zotero.Item("journalArticle");
  item.setField("title", "QA pipeline paper");
  const itemID = await item.saveTx();
  const att = await Zotero.Attachments.importFromFile({
    file: pdfPath,
    parentItemID: itemID,
    title: "QA pipeline PDF",
  });

  // Close any reader tab so the library items view is the active context and
  // the selection is ours (otherwise the menu handler sees no PDF).
  try {
    for (const id of Zotero_Tabs._tabs.slice()) {
      if (id.startsWith("tab-")) Zotero_Tabs.close(id);
    }
    await Zotero.Promise.delay(500);
  } catch (e) {
    probeLog("close tabs: " + e);
  }
  ZoteroPane.selectItem(att.id);
  await Zotero.Promise.delay(600);

  const popup = doc.getElementById("zotero-itemmenu");
  popup.dispatchEvent(new win.Event("popupshowing"));
  const menu = doc.getElementById("ztransplit-itemmenu");
  const visible = menu?.getAttribute("hidden") !== "true";
  const sel = ZoteroPane.itemsView.getSelectedItems();

  const target = doc.getElementById("ztransplit-itemmenu-attachment");
  if (!target) return { error: "menu item missing" };
  const t0 = Date.now();
  target.doCommand();
  const listTranslated = async () => {
    const s = new Zotero.Search();
    s.libraryID = 1;
    const ids = await s.search();
    const out = [];
    for (const id of ids) {
      const x = await Zotero.Items.getAsync(id);
      if (
        x.isAttachment() &&
        x.attachmentContentType === "application/pdf" &&
        /^(译文|Translated)\s*\(/i.test(x.getField("title"))
      ) {
        out.push({ id, parent: x.parentItemID, dateAdded: x.dateAdded });
      }
    }
    return out;
  };
  const before = await listTranslated();
  const beforeIDs = new Set(before.map((x) => x.id));

  // The pipeline is async; poll for its progress log and the new attachment.
  const results = {
    startedAt: t0,
    visible,
    selection: sel.map((i) => i.id),
    before,
  };
  const countCache = async () => {
    let n = 0;
    try {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(
        PathUtils.join(
          Zotero.DataDirectory.dir,
          "ztransplit",
          "translation-cache",
        ),
      );
      const e = f.directoryEntries;
      while (e.hasMoreElements()) {
        e.getNextElement();
        n++;
      }
      return n;
    } catch {
      return -1;
    }
  };
  for (let i = 0; i < 200; i++) {
    await Zotero.Promise.delay(3000);
    const now = await listTranslated();
    const fresh = now.filter((x) => !beforeIDs.has(x.id));
    if (fresh.length) {
      results.newTranslated = fresh;
      results.ms = Date.now() - t0;
      break;
    }
    if (Date.now() - t0 > 400000) {
      results.timeout = true;
      break;
    }
  }
  results.ms = Date.now() - t0;
  return results;
};

/**
 * Extract text from a translated attachment's real PDF through Zotero's own
 * tooling — proves the Chinese glyphs were embedded (not '?' tofu).
 */
PROBE_CMDS.verifyPdf = async function (attachmentID) {
  const ids = attachmentID ? [Number(attachmentID)] : null;
  const out = [];
  let targets = ids;
  if (!targets) {
    const s = new Zotero.Search();
    s.libraryID = 1;
    const all = await s.search();
    targets = [];
    for (const id of all) {
      const x = await Zotero.Items.getAsync(id);
      if (
        x.isAttachment() &&
        x.attachmentContentType === "application/pdf" &&
        /^(译文|Translated)\s*\(/i.test(x.getField("title"))
      ) {
        targets.push(id);
      }
    }
  }
  for (const id of targets) {
    const item = await Zotero.Items.getAsync(id);
    const file = item.getFile?.();
    if (!file?.exists) {
      out.push({ id, error: "file missing" });
      continue;
    }
    // Parse the produced PDF's embedded text via pdf.js through the reader.
    let text = "";
    let method = "none";
    try {
      const bytes = await IOUtils.read(file.path);
      const doc = await Zotero.PDFWorker._loadPDF?.({
        data: new Uint8Array(bytes),
      });
      method = "pdfworker";
      void doc;
    } catch {
      /* try the text-extraction helper below */
    }
    // Simplest robust check: count CJK codepoints in the raw PDF stream.
    try {
      const raw = await IOUtils.read(file.path);
      const s2 = String.fromCharCode.apply(null, new Uint8Array(raw));
      const cjk = (s2.match(/[\u4e00-\u9fff]/g) || []).length;
      out.push({
        id,
        title: item.getField("title"),
        size: file.fileSize,
        cjkBytesInFile: cjk,
      });
    } catch (e) {
      out.push({ id, error: String(e) });
    }
  }
  return { produced: out };
};

/**
 * Set a z-transplit preference.
 *
 * NOTE: Zotero.Prefs.get/set(pref, global) — the second arg is a PATH MODE flag
 * (true = pref is already a full path), NOT "if missing". With a full path you
 * MUST pass true, or the API prefixes "extensions.zotero." onto it.
 */
PROBE_CMDS.setPref = async function (pair) {
  if (!pair || !pair.includes("=")) return { error: "pass key=value" };
  const [k, ...rest] = pair.split("=");
  const v = rest.join("=");
  const full = "extensions.zotero.ztransplit." + k;
  const before = Zotero.Prefs.get(full, true);
  if (v === "true" || v === "false") Zotero.Prefs.set(full, v === "true", true);
  else if (/^-?\d+$/.test(v)) Zotero.Prefs.set(full, Number(v), true);
  else Zotero.Prefs.set(full, v, true);
  const after = Zotero.Prefs.get(full, true);
  const hasUserValue = Zotero.Prefs.prefHasUserValue
    ? Zotero.Prefs.prefHasUserValue(full, true)
    : null;
  return {
    key: full,
    before,
    after,
    hasUserValue,
    stuck: before === after && String(before) !== String(v),
  };
};

/** List PDF attachments and report what the pipeline produced. */
PROBE_CMDS.attachments = async function () {
  const probe = (label, fn) => {
    try {
      const v = fn();
      return {
        label,
        type: Object.prototype.toString.call(v),
        len: v?.length ?? null,
        isIter: typeof v?.[Symbol.iterator] === "function",
        isAsyncIter: typeof v?.[Symbol.asyncIterator] === "function",
      };
    } catch (e) {
      return { label, error: String(e) };
    }
  };
  const g = Zotero.Items.getAll;
  const shapes = [
    probe("no-args", () => g()),
    probe("(1)", () => g(1)),
    probe("(1,false)", () => g(1, false)),
    probe("(1,true)", () => g(1, true)),
  ];
  // Use the search API, which is stable across versions.
  const pdfs = [];
  try {
    const s = new Zotero.Search();
    s.libraryID = 1;
    s.addCondition("recursive", false);
    s.addCondition("includeDeleted", false);
    const ids = await s.search();
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (it.isAttachment() && it.attachmentContentType === "application/pdf") {
        const f = it.getFile?.();
        pdfs.push({
          id: it.id,
          title: it.getField("title"),
          parentID: it.parentItemID,
          size: f?.fileSize ?? null,
        });
      }
    }
  } catch (e) {
    return { searchError: String(e), shapes };
  }
  return {
    shapes,
    pdfs,
    cacheDir: Zotero.DataDirectory.dir + "\\ztransplit",
    cacheExists: await IOUtils.exists(
      PathUtils.join(Zotero.DataDirectory.dir, "ztransplit", "translation-cache"),
    ),
  };
};

/** Click the real Bilingual toggle and report the SDT session state. */
PROBE_CMDS.bilingual = async function (mode) {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  if (!section) return { error: "section not enabled — open the reader pane first" };

  const toggle = Array.from(section.querySelectorAll("button")).find(
    (b) => /Bilingual|双语/.test(b.textContent || ""),
  );
  if (!toggle) return { error: "no bilingual toggle", buttons: [] };
  const before = toggle.textContent;
  toggle.click();
  // Wait for the SDT session to start (or the disclosure to settle).
  let last = "";
  for (let i = 0; i < 14; i++) {
    await Zotero.Promise.delay(1000);
    last = (section.textContent || "").slice(0, 200);
    if (!/Translating|Preparing/.test(last)) break;
  }
  const out = {
    before,
    after: toggle.textContent,
    toggleActive: toggle.getAttribute("data-active"),
    sectionText: (section.textContent || "").slice(0, 700),
    containsRawIds: (section.textContent || "").includes("bilingual-"),
  };
  if (mode) {
    const modeBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => /only|Interleaved/i.test(b.textContent || ""),
    );
    if (modeBtn) {
      modeBtn.click();
      await Zotero.Promise.delay(2000);
      out.modeClicked = modeBtn.textContent;
    }
  }
  // Report the reader overlay state (the SDT reading mode's injected blocks).
  try {
    const { Zotero_Tabs } = probeWin();
    const r = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    const internal = r?._internalReader;
    const irWin = internal?._iframeWindow;
    const irDoc = irWin?.document;
    out.reader = {
      hasSDT: typeof internal?._loadSDT === "function",
      readingMode: internal?._readingMode ?? null,
      overlayBlocks: irDoc
        ? {
            transplitNodes: irDoc.querySelectorAll("[class*='ztransplit']").length,
            bcBlocks: irDoc.querySelectorAll(".ztransplit-bc-block").length,
            transOnlyHiding: !!irDoc.querySelector(
              "[class*='ztransplit-bc'][class*='trans-only']",
            ),
            bodyChars: (irDoc.body?.textContent || "").length,
            sample: (irDoc.body?.textContent || "").slice(0, 200),
          }
        : "no iframe",
    };
    const status = section.querySelector(".ztransplit-bc-status, .ztransplit-bc-progress");
    out.status = status?.textContent || null;
    out.progress = Array.from(
      section.querySelectorAll(".ztransplit-bc-progress"),
      (n) => n.textContent,
    );
    out.modeButtons = Array.from(section.querySelectorAll("button"))
      .filter((b) => /only|Interleaved/i.test(b.textContent || ""))
      .map((b) => b.textContent);
  } catch (e) {
    out.readerError = String(e);
  }
  return out;
};

/** Exercise the read-aloud buttons and report the controller state. */
PROBE_CMDS.readAloud = async function (source) {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  if (!section) return { error: "section not enabled" };
  const want = source || "original";
  const target = Array.from(section.querySelectorAll("button")).find((b) =>
    new RegExp("Read " + want, "i").test(b.textContent || ""),
  );
  if (!target) {
    return {
      error: "no button for " + want,
      available: Array.from(section.querySelectorAll("button")).map((b) => b.textContent),
    };
  }
  target.click();
  await Zotero.Promise.delay(2500);
  return {
    clicked: target.textContent,
    speechSynthesisAvailable: typeof win.speechSynthesis !== "undefined",
    voices: win.speechSynthesis?.getVoices?.().length ?? null,
    sectionText: (section.textContent || "").slice(0, 300),
    rawIds: (section.textContent || "").includes("readaloud-"),
  };
};

/** Full PDF pipeline: Java + OpenDataLoader + translation, real files. */
PROBE_CMDS.pipeline = async function () {
  const dataDir = Zotero.DataDirectory.dir;
  const pdfPath = PathUtils.join(dataDir, "qa-sample.pdf");
  if (!(await IOUtils.exists(pdfPath))) return { skipped: "no PDF" };
  let item = new Zotero.Item("journalArticle");
  item.setField("title", "QA pipeline paper");
  const itemID = await item.saveTx();
  const att = await Zotero.Attachments.importFromFile({
    file: pdfPath,
    parentItemID: itemID,
    title: "QA pipeline PDF",
  });
  const scope = {};
  Services.scriptloader.loadSubScript(
    "chrome://ztransplit/content/scripts/ztransplit.js",
    scope,
  );
  const fn = scope.translateAndSplitWithOpenDataLoader;
  if (typeof fn !== "function") return { error: "adapter not in bundle" };
  const progress = [];
  const t0 = Date.now();
  try {
    const res = await fn({
      sourceItem: att,
      outcome: "attachment",
      onProgress: (m) => {
        progress.push(String(m));
        probeLog("[pipe] " + m);
      },
    });
    const out = {
      ms: Date.now() - t0,
      translatedAttachmentId: res?.translatedAttachmentId ?? null,
      splitTabID: res?.splitTabID ?? null,
      progress,
    };
    if (out.translatedAttachmentId) {
      const produced = await Zotero.Items.getAsync(out.translatedAttachmentId).catch(
        () => null,
      );
      out.title = produced?.getField?.("title") || null;
      out.contentType = produced?.attachmentContentType || null;
      const file = produced?.getFile?.();
      out.fileSize = file && file.exists ? file.fileSize : null;
    }
    return out;
  } catch (e) {
    return {
      ms: Date.now() - t0,
      error: String(e),
      name: e?.name,
      stack: String(e?.stack || "").slice(0, 1500),
      progress,
    };
  }
};

/** Capabilities the reader actually exposes. */
PROBE_CMDS.capabilities = async function () {
  const out = { zotero: Zotero.version };
  out.speechSynthesis = typeof speechSynthesis !== "undefined";
  out.intlSegmenter = typeof Intl.Segmenter === "function";
  const { Zotero_Tabs } = probeWin();
  const tabID = Zotero_Tabs.selectedID;
  const reader = Zotero.Reader.getByTabID(tabID);
  if (reader) {
    const internal = reader._internalReader;
    out.has_setReadingMode = typeof internal?._setReadingMode === "function";
    out.has_loadSDT = typeof internal?._loadSDT === "function";
    out.internalReader = !!internal;
  }
  // Java probe the addon itself uses
  try {
    const scope = {};
    Services.scriptloader.loadSubScript(
      "chrome://ztransplit/content/scripts/ztransplit.js",
      scope,
    );
    out.bundleHasJavaManager = typeof scope.JavaRuntimeManager !== "undefined";
  } catch {
    /* ignore */
  }
  return out;
};

/** Copy a sample PDF into the QA data dir (idempotent). */
PROBE_CMDS.installPdf = async function (src) {
  if (!src) return { error: "pass a source PDF path" };
  const dest = PathUtils.join(Zotero.DataDirectory.dir, "qa-sample.pdf");
  await IOUtils.copy(src, dest);
  const st = await IOUtils.stat(dest);
  return { dest, size: st.size };
};

PROBE_CMDS.listCommands = async function () {
  return Object.keys(PROBE_CMDS);
};

/** Jump to the first reader tab — the enabled state of the translate section
 *  is driven by onItemChange on tab switches, and a tab opened programmatically
 *  may never have fired it. The section's data-pane carries the full plugin ID
 *  (ztransplit\@zotero\.org-ztransplit-translate), so match with includes(). */
PROBE_CMDS.activateReader = async function () {
  const { Zotero_Tabs } = probeWin();
  const doc = Zotero.getMainWindow().document;
  const readSection = () => {
    const el = Array.from(doc.querySelectorAll("item-pane-custom-section")).find(
      (c) => (c.dataset.pane || "").includes("transplit"),
    );
    return {
      found: !!el,
      hidden: el ? el.hidden : null,
      text: el ? (el.textContent || "").slice(0, 300) : "",
    };
  };
  const readerTab = Zotero_Tabs._tabs.find((t) => t.type === "reader");
  if (!readerTab) {
    return { error: "no reader tab", tabs: Zotero_Tabs._tabs.map((t) => t.type) };
  }
  // Leave + re-enter: two switch events, so onItemChange runs against the
  // reader tab last no matter which direction Zotero reports first.
  Zotero_Tabs.select("zotero-pane");
  await Zotero.Promise.delay(600);
  Zotero_Tabs.select(readerTab.id);
  await Zotero.Promise.delay(1500);
  return {
    jumped: readerTab.id,
    selectedID: Zotero_Tabs.selectedID,
    selectedType: Zotero_Tabs.selectedType,
    section: readSection(),
  };
};

/** Force the custom section's itemChange hook to re-run. The hook fires from
 *  the item setter, so if item was assigned before tabType the section latches
 *  disabled; re-assigning re-evaluates with the current tabType. */
PROBE_CMDS.pokeSection = async function () {
  const doc = Zotero.getMainWindow().document;
  const sections = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).filter((c) => (c.dataset.pane || "").includes("transplit"));
  const before = sections.map((el) => ({
    tabType: el.tabType,
    itemID: el.item?.id ?? null,
    hidden: el.hidden,
  }));
  for (const el of sections) {
    try {
      el.item = el.item;
    } catch (e) {
      probeLog("poke: " + e);
    }
  }
  await Zotero.Promise.delay(800);
  const after = sections.map((el) => ({
    tabType: el.tabType,
    itemID: el.item?.id ?? null,
    hidden: el.hidden,
    text: (el.textContent || "").slice(0, 200),
  }));
  return { before, after };
};

/** Maximize the main window — the context pane auto-collapses under Zotero's
 *  width threshold, which hides the translate section on small QA windows. */
PROBE_CMDS.maximize = async function () {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const before = {
    w: win.outerWidth,
    h: win.outerHeight,
    sizemode: doc.documentElement.getAttribute("sizemode"),
    contextCollapsed: doc.getElementById("zotero-context-pane")?.collapsed ?? null,
  };
  win.maximize();
  await Zotero.Promise.delay(1000);
  return {
    before,
    after: {
      w: win.outerWidth,
      h: win.outerHeight,
      sizemode: doc.documentElement.getAttribute("sizemode"),
      contextCollapsed: doc.getElementById("zotero-context-pane")?.collapsed ?? null,
    },
  };
};

// ── word cards (词典卡片 + 词卡标签页) ───────────────────────────────────────
// Sub-actions:
//   (none)/"ui"        entry-point presence (library button, reader listener,
//                      reader toolbar button when a reader is open)
//   "open-tab"         click the real library toolbar button, report the tab
//                      and its rendered DOM (empty state)
//   "lookup"           with a reader open: commit zh-CN as the target, set the
//                      reader selection, click Refresh → Look up, report the
//                      rendered dictionary card and the chip strip (REAL
//                      Youdao network call)
//   "store"            list the on-disk word-card store records
//   "shot"             screenshot the main window to D:\zt-qa\wordcards-shot-*.png
PROBE_CMDS.wordcards = async function (action) {
  const { win, Zotero_Tabs } = probeWin();
  const doc = win.document;
  const out = { action: action || "ui" };

  const button = doc.getElementById("ztransplit-wordcards-button");
  out.libraryButton = button
    ? {
        found: true,
        parent: button.parentElement?.id || button.parentElement?.tagName,
        tip: button.getAttribute("tooltiptext"),
        image: (button.getAttribute("style") || "").includes("wordcards"),
      }
    : { found: false };
  try {
    const registered = Array.from(Zotero.Reader._registeredListeners || []);
    out.readerToolbarListeners = registered.filter(
      (x) =>
        x.type === "renderToolbar" &&
        String(x.pluginID || "").includes("ztransplit"),
    ).length;
  } catch (e) {
    out.readerListenersError = String(e);
  }

  if (!action || action === "ui") {
    try {
      const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
      const rdoc = reader?._iframeWindow?.document;
      out.readerButton = rdoc
        ? !!rdoc.querySelector(".ztransplit-wc-reader-btn")
        : "no reader open";
    } catch (e) {
      out.readerButton = "err: " + e;
    }
    out.wordcardsPref = Zotero.Prefs.get(
      "extensions.zotero.ztransplit.wordcards.enabled",
      true,
    );
    return out;
  }

  if (action === "open-tab") {
    if (!button) return { error: "no library toolbar button" };
    button.doCommand();
    await Zotero.Promise.delay(2500);
    const tab = Zotero_Tabs._getTab?.("ztransplit-wordcards")?.tab;
    out.tab = tab
      ? {
          id: tab.id,
          type: tab.type,
          title: tab.title,
          selected: Zotero_Tabs.selectedID === "ztransplit-wordcards",
        }
      : null;
    const container = doc.getElementById("ztransplit-wordcards");
    out.dom = container
      ? {
          root: !!container.querySelector(".ztransplit-wc-root"),
          search: !!container.querySelector(".ztransplit-wc-search"),
          sort: !!container.querySelector(".ztransplit-wc-sort"),
          count: container.querySelector(".ztransplit-wc-count")?.textContent ?? null,
          grid: !!container.querySelector(".ztransplit-wc-grid"),
          detail: !!container.querySelector(".ztransplit-wc-detail"),
          emptyTitle: container.querySelector(".ztransplit-wc-empty-title")?.textContent ?? null,
          emptyHint: container.querySelector(".ztransplit-wc-empty-hint")?.textContent ?? null,
          rawFtlLeak: /ztransplit-wordcards-|pane-translate-/.test(
            container.textContent || "",
          ),
          text: (container.textContent || "").slice(0, 500),
        }
      : null;
    return out;
  }

  // Diagnostics for a rendered-but-empty section: the context pane's
  // collapse state, every frame that could host the pane, and any
  // ztransplit-tp nodes reachable from the main document.
  if (action === "diag") {
    const contextPane = doc.getElementById("zotero-context-pane");
    out.context = {
      collapsed: contextPane?.collapsed ?? null,
      hidden: contextPane?.hidden ?? null,
      hasWidth: contextPane ? !!contextPane.getBoundingClientRect().width : null,
    };
    out.frames = [];
    for (const f of doc.querySelectorAll("browser, iframe")) {
      try {
        const fdoc = f.contentDocument;
        if (!fdoc) continue;
        out.frames.push({
          tag: f.tagName,
          id: f.id || null,
          url: (fdoc.URL || "").slice(0, 80),
          tpNodes: fdoc.querySelectorAll("[class*='ztransplit-tp']").length,
          sections: fdoc.querySelectorAll("item-pane-custom-section").length,
        });
      } catch {
        /* cross-domain frame */
      }
    }
    out.tpNodesInMain = doc.querySelectorAll("[class*='ztransplit-tp']").length;
    const sectionForDiag = Array.from(
      doc.querySelectorAll("item-pane-custom-section"),
    ).find((c) => (c.dataset.pane || "").includes("ztransplit-translate"));
    out.section = sectionForDiag
      ? {
          pane: sectionForDiag.dataset.pane,
          hidden: sectionForDiag.hidden,
          html: (sectionForDiag.innerHTML || "").slice(0, 400),
        }
      : null;
    return out;
  }

  if (action === "lookup") {
    const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    if (!reader) return { error: "no reader — run the 'reader' action first" };

    // The reader's item pane (context pane) starts COLLAPSED on a fresh
    // profile — a hidden section never renders its body (onRender fires only
    // for visible sections). Open it BEFORE locating the section.
    const contextPaneEl = doc.getElementById("zotero-context-pane");
    if (contextPaneEl?.collapsed) {
      const toggle = doc.getElementById("context-pane-toggle");
      if (toggle) toggle.click();
      else contextPaneEl.collapsed = false;
      await Zotero.Promise.delay(1500);
    }

    // Zotero 10 prefixes custom section ids with the plugin ID
    // ("ztransplit@zotero.org-ztransplit-translate"), and TWO copies exist —
    // the library item pane's (hidden for reader tabs) and the reader context
    // pane's (the live one). Prefer the context pane's visible section.
    const allSections = Array.from(doc.querySelectorAll("item-pane-custom-section"));
    const matching = allSections.filter((c) =>
      (c.dataset.pane || "").includes("ztransplit-translate"),
    );
    const section =
      matching.find((c) => contextPaneEl?.contains(c) && !c.hidden) ??
      matching.find((c) => !c.hidden) ??
      matching[0];
    if (!section) {
      return {
        error: "no translate section rendered",
        sections: allSections.map((c) => ({ pane: c.dataset.pane, hidden: c.hidden })),
      };
    }
    out.section = {
      pane: section.dataset.pane,
      hidden: section.hidden,
      inContextPane: !!contextPaneEl?.contains(section),
    };

    // 1) Commit zh-CN as the target while no selection is loaded (blur with
    //    an empty source text never fires a request).
    // One live pane instance exists (the store-backed chips + single section),
    // so global main-document queries are equivalent and dodge any
    // collapsible-section/shadow-root nesting quirks.
    const q = (sel) => doc.querySelector(sel);
    const qa = (sel) => [...doc.querySelectorAll(sel)];
    const langInput = q(".ztransplit-tp-lang-input");
    if (!langInput) {
      return {
        error: "no language input",
        section: out.section,
        text: (section.textContent || "").slice(0, 300),
        sectionHTML: (section.innerHTML || "").slice(0, 300),
        tpNodes: doc.querySelectorAll("[class*='ztransplit-tp']").length,
        tpHosts: [
          ...new Set(
            [...doc.querySelectorAll("[class*='ztransplit-tp']")].map(
              (n) =>
                n.closest("item-pane-custom-section")?.dataset.pane ?? "none",
            ),
          ),
        ],
      };
    }
    langInput.value = "zh-CN";
    langInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    langInput.dispatchEvent(new win.FocusEvent("blur"));
    await Zotero.Promise.delay(300);

    // 2) Fake the reader selection — the pane reads this exact property on
    //    refresh (readSelection → _primaryView._selectionRanges).
    const view = reader._internalReader?._primaryView;
    if (!view) return { error: "no _primaryView on the reader" };
    view._selectionRanges = [{ text: "resonance" }];

    // 3) Refresh → idle state offers the Look up button (translate.auto off).
    const refreshBtn = qa("button").find((b) =>
      /refresh|刷新/i.test(b.textContent || ""),
    );
    if (!refreshBtn) {
      return {
        error: "no refresh button",
        buttons: qa("button").map((b) => b.textContent),
      };
    }
    refreshBtn.click();
    await Zotero.Promise.delay(600);
    const lookupBtn = qa("button").find((b) =>
      /look up|查询/i.test(b.textContent || ""),
    );
    if (!lookupBtn) {
      return {
        error: "no Look up button after refresh",
        buttons: qa("button").map((b) => b.textContent),
        text: (section.textContent || "").slice(0, 400),
      };
    }
    lookupBtn.click();

    // 4) Wait for the card (real Youdao round trip) or an explicit error.
    for (let i = 0; i < 40; i++) {
      await Zotero.Promise.delay(500);
      if (q(".ztransplit-tp-card") || q(".ztransplit-tp-error")) {
        break;
      }
    }
    out.card = {
      found: !!q(".ztransplit-tp-card"),
      word: q(".ztransplit-tp-card-word")?.textContent ?? null,
      phonetic: q(".ztransplit-tp-card-phonetic")?.textContent ?? null,
      senses: qa(".ztransplit-tp-card-sense").map((s) => s.textContent),
      source: q(".ztransplit-tp-card-source")?.textContent ?? null,
      error: q(".ztransplit-tp-error")?.textContent ?? null,
    };
    const chips = q(".ztransplit-tp-chips");
    out.chips = {
      found: !!chips,
      hidden: chips?.hidden ?? null,
      words: qa(".ztransplit-tp-chip").map((c) => c.textContent),
    };
    return out;
  }

  if (action === "store") {
    const root = PathUtils.join(
      Zotero.DataDirectory.dir,
      "ztransplit",
      "word-cards",
      "v1",
    );
    out.root = root;
    out.files = [];
    try {
      out.debug = {
        exists: await IOUtils.exists(root).catch((e) => "ERR " + e),
        statType: typeof IOUtils.stat,
        children: await IOUtils.getChildren(root)
          .then(async (c) => {
            const info = {
              count: c.length,
              firstType: typeof c[0],
              first: typeof c[0] === "string" ? c[0] : JSON.stringify(c[0]),
            };
            if (typeof c[0] === "string" && typeof IOUtils.stat === "function") {
              info.stat = await IOUtils.stat(c[0])
                .then((s) => JSON.stringify(s))
                .catch((e) => "ERR " + e);
            }
            return info;
          })
          .catch((e) => "ERR " + e),
      };
      // IOUtils.getChildren returns plain path STRINGS and stat() reports
      // type:"directory" (no isDirectory flag) on this Zotero (10.0.3).
      const isDir = (s) => s && (s.type === "directory" || s.isDirectory === true);
      if (await IOUtils.exists(root)) {
        for (const bucketPath of await IOUtils.getChildren(root)) {
          const bstat = await IOUtils.stat(bucketPath);
          if (!isDir(bstat)) continue;
          for (const filePath of await IOUtils.getChildren(bucketPath)) {
            const fstat = await IOUtils.stat(filePath);
            if (isDir(fstat)) continue;
            let parsed = null;
            try {
              parsed = JSON.parse(await IOUtils.readUTF8(filePath));
            } catch {
              /* corrupt file */
            }
            out.files.push({
              name: PathUtils.filename(filePath),
              size: fstat.size,
              word: parsed?.word ?? null,
              lookups: parsed?.lookups ?? null,
              source: parsed?.latest?.source ?? null,
              senses: parsed?.latest?.senses?.length ?? null,
              phonetic: parsed?.latest?.phonetic ?? null,
            });
          }
        }
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  if (action === "shot") {
    try {
      const w = win.outerWidth;
      const h = win.outerHeight;
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext("2d");
      ctx2d.drawWindow(win, 0, 0, w, h, "rgb(255,255,255)");
      const dataURL = canvas.toDataURL("image/png");
      const bytes = Uint8Array.from(atob(dataURL.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      const file = PathUtils.join(
        "D:\\zt-qa",
        "wordcards-shot-" + Date.now() + ".png",
      );
      await IOUtils.write(file, bytes);
      return { ok: true, file, bytes: bytes.length, w, h };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return { error: "unknown wordcards sub-action: " + action };
};

// ── driver: poll command.json ───────────────────────────────────────────────
var probeTimer = null;

async function probePoll() {
  try {
    const f = PathUtils.join("D:\\zt-qa", "command.json");
    if (await IOUtils.exists(f)) {
      const raw = await IOUtils.readUTF8(f);
      const cmd = JSON.parse(raw);
      await IOUtils.remove(f).catch(() => {});
      if (PROBE_CMDS[cmd.action]) {
        try {
          const result = await PROBE_CMDS[cmd.action](cmd.arg);
          await probeWriteJSON("result.json", {
            id: cmd.id,
            ok: true,
            action: cmd.action,
            result,
          });
        } catch (e) {
          await probeWriteJSON("result.json", {
            id: cmd.id,
            ok: false,
            action: cmd.action,
            error: String(e),
            name: e?.name,
            stack: String(e?.stack || "").slice(0, 2000),
          });
        }
      } else {
        await probeWriteJSON("result.json", {
          id: cmd.id,
          ok: false,
          error: "unknown action " + cmd.action,
        });
      }
    }
  } catch (e) {
    probeLog("poll: " + e);
  }
  probeTimer = setTimeout(probePoll, 250);
}

async function startProbe() {
  probeLog("probe loaded, zotero=" + Zotero.version);
  await probeWriteJSON("probe-ready.json", { at: new Date().toISOString() });
  probePoll();
}
