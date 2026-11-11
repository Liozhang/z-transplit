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

// ── 解析组件（ODL jar）诊断：设置面板按钮的后端直调 ────────────────────────
PROBE_CMDS.odlStatus = async function () {
  const t0 = Date.now();
  try {
    const status = await Zotero.ZTransplit.odlJar.getStatus();
    return { status, ms: Date.now() - t0 };
  } catch (e) {
    return { error: String((e && e.stack) || e), ms: Date.now() - t0 };
  }
};

PROBE_CMDS.odlInstall = async function () {
  const t0 = Date.now();
  try {
    const p = await Zotero.ZTransplit.odlJar.install();
    const st = await IOUtils.stat(p).catch(() => null);
    return { ok: true, path: p, size: st ? st.size : null, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || e), ms: Date.now() - t0 };
  }
};

/** WebCrypto 可用性与大文件哈希探测（sha256Hex 的底层）。 */
PROBE_CMDS.odlHashProbe = async function () {
  const out = {};
  out.hasCrypto = typeof crypto !== "undefined";
  out.hasSubtle = !!(out.hasCrypto && crypto.subtle && crypto.subtle.digest);
  try {
    const small = new TextEncoder().encode("abc");
    const d = await crypto.subtle.digest("SHA-256", small);
    out.smallDigest = Array.from(new Uint8Array(d))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // 大缓冲：读随包 region remover jar（精简版安装树里就有，约 4.4MB）
    const profD = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
    const cand = profD.parent;
    // 探针不猜路径：直接扫 ProfD/extensions/<id>/core/pdf/lib/
    const ext = profD.clone();
    ext.append("extensions");
    const jar = ext.clone();
    jar.append("ztransplit@zotero.org");
    jar.append("core");
    jar.append("pdf");
    jar.append("lib");
    jar.append("ztransplit-region-text-remover.jar");
    out.jarPath = jar.path;
    if (jar.exists()) {
      const bytes = await IOUtils.read(jar.path);
      out.jarBytes = bytes.byteLength;
      const t0 = Date.now();
      const d2 = await crypto.subtle.digest("SHA-256", bytes);
      out.jarDigestHead = Array.from(new Uint8Array(d2))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
      out.jarDigestMs = Date.now() - t0;
    } else {
      out.jarMissing = true;
    }
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  return out;
};

/** nsIZipReader 真实接口探查：方法面、findEntries 迭代形状、extract 落盘。 */
PROBE_CMDS.odlZipApi = async function () {
  const out = {};
  try {
    const Cc = Components.classes;
    const Ci = Components.interfaces;
    const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
      Ci.nsIZipReader,
    );
    out.methods = [];
    let proto = reader;
    while (proto && proto !== Object.prototype) {
      out.methods.push(...Object.getOwnPropertyNames(proto));
      proto = Object.getPrototypeOf(proto);
    }
    out.methods = [...new Set(out.methods)].sort();
    const zipPath = "D:\\zt-qa\\driver.zip";
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(zipPath);
    reader.open(f);
    const names = [];
    const finder = reader.findEntries("*");
    out.finderType = finder.constructor?.name || typeof finder;
    out.finderMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(finder) || {},
    ).sort();
    while (finder.hasMore() && names.length < 8) {
      const n = finder.getNext();
      names.push({ value: n, type: typeof n });
    }
    out.firstEntries = names;
    // extract 实测：把第一个条目解到数据目录
    if (names.length && typeof names[0].value === "string" && !names[0].value.endsWith("/")) {
      const dest = PathUtils.join(Zotero.DataDirectory.dir, "qa-zip-extract-probe");
      const df = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      df.initWithPath(dest);
      reader.extract(names[0].value, df);
      const st = await IOUtils.stat(dest);
      out.extracted = { entry: names[0].value, dest, size: st.size };
      await IOUtils.remove(dest, { ignoreAbsent: true });
    }
    reader.close();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  return out;
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

  // Since the Z-Transplit submenu unification the payload is ONE top-level
  // item whose `groups` array nests the entries (host renders it as a
  // submenu). Record the tree as-is plus a flat view for the label filters.
  const shape = (item) => ({
    label: item.label,
    checked: item.checked === true,
    groups: Array.isArray(item.groups)
      ? item.groups.map((group) => group.map(shape))
      : undefined,
  });
  const flat = (item) =>
    Array.isArray(item.groups)
      ? item.groups.flat().flatMap(flat)
      : [item.label];
  const labels = appended.flatMap(flat);

  if (!action || action === "labels") {
    return {
      count: cv.length,
      ourHandlers: cv.filter((x) =>
        String(x.pluginID || "").includes("ztransplit"),
      ).length,
      appendedShape: appended.map(shape),
      transplitEntries: labels.filter((l) => /split-screen|translate|双语|分屏|翻译|译文|取消/i.test(l || "")),
      all: labels,
      labels,
    };
  }

  const re =
    action === "split"
      ? /split-screen translation|分屏翻译/i
      : action === "compare"
        ? /split-screen reading|分屏阅读/i
        : null;
  const entry = re
    ? appended
        .flatMap((a) => (Array.isArray(a.groups) ? a.groups.flat() : [a]))
        .find((a) => a.label && re.test(a.label))
    : null;
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
  const items = Array.from(menu.querySelectorAll("menupopup > menuitem"), (m) => ({
    id: m.id,
    label: m.getAttribute("label"),
    type: m.getAttribute("type"),
    checked: m.getAttribute("checked"),
  }));
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

/** Check the Tools-menu entry that opens the word-cards tab. */
PROBE_CMDS.tools = async function (arg) {
  const { win, Zotero_Tabs } = probeWin();
  const doc = win.document;
  const popup =
    doc.getElementById("menu_ToolsPopup") ||
    doc.getElementById("menu-tools-popup") ||
    doc.getElementById("toolsMenu")?.querySelector("menupopup") ||
    doc.getElementById("menu-tools")?.querySelector("menupopup");
  if (!popup) return { error: "tools menu not found (menu_ToolsPopup)" };
  const item = doc.getElementById("ztransplit-tools-wordcards");
  const base = {
    present: !!item,
    label: item?.getAttribute("label") ?? null,
    popupEntries: Array.from(popup.children).map(
      (n) => n.getAttribute?.("label") || n.tagName,
    ),
  };
  if (arg !== "open" || !item) return base;

  // Click the real menu item, then report the opened tab (its data.icon is
  // what the tab bar renders).
  item.doCommand();
  await Zotero.Promise.delay(2500);
  let tab = null;
  try {
    tab = Zotero_Tabs._getTab?.("ztransplit-wordcards")?.tab ?? null;
  } catch (e) {
    base.tabProbeError = String(e);
  }
  base.tabOpen = !!tab;
  base.tabIcon = tab?.data?.icon ?? null;
  try {
    if (tab) Zotero_Tabs.close("ztransplit-wordcards");
  } catch {
    /* best-effort */
  }
  return base;
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
  for (const id of [
      "google",
      "bing",
      "bing-web",
      "deepl",
      "ai",
      "custom",
      "pdftranslate",
    ]) {
    const g = doc.getElementById("ztransplit-pref-engine-" + id);
    groups[id] = g ? !g.hidden : "missing";
  }

  const read = () => ({
    engineValue: doc.getElementById("ztransplit-pref-engine-type")?.value,
    groups: (() => {
      const o = {};
  for (const id of [
      "google",
      "bing",
      "bing-web",
      "deepl",
      "ai",
      "custom",
      "pdftranslate",
    ]) {
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
          path: f?.path ?? null,
          tags: (it.getTags?.() || []).map((t) => t.tag),
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
  await probeScrollSectionIntoView(doc);
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
PROBE_CMDS.focus = async function () {
  const win = Zotero.getMainWindow();
  win.focus();
  return { focused: true };
};

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
  // arg 兼容两种形态：纯子动作（"lookup"），或 JSON（{"sub":"lookup","word":...,
  // "position":{pageIndex,rects},"select":"reading"}）——与 wc 命令同一约定。
  let opts = {};
  if (typeof action === "string" && action.trimStart().startsWith("{")) {
    try {
      opts = JSON.parse(action);
    } catch {
      opts = {};
    }
    action = opts.sub || "";
  }
  const opt = (k, d) => (opts[k] !== undefined ? opts[k] : d);
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
    // opts.select：选中指定词卡，报告「文中例句」区的行（句子 + 来源元信息）。
    const selectWord = opt("select", null);
    if (container && selectWord) {
      const tile = [...container.querySelectorAll(".ztransplit-wc-tile")].find(
        (t) =>
          t.querySelector(".ztransplit-wc-tile-word")?.textContent === selectWord,
      );
      if (tile) {
        tile.click();
        await Zotero.Promise.delay(600);
        const detail = container.querySelector(".ztransplit-wc-detail");
        const rows = [...(detail?.querySelectorAll(".ztransplit-wc-d-ctx") ?? [])];
        out.selected = selectWord;
        out.contextsSection = {
          sectionTitles: [
            ...(detail?.querySelectorAll(".ztransplit-wc-d-section") ?? []),
          ].map((s) => s.textContent),
          rows: rows.map((row) => ({
            sentence:
              row.querySelector(".ztransplit-wc-d-ctx-sentence")?.textContent ??
              null,
            meta:
              row.querySelector(".ztransplit-wc-d-ctx-meta")?.textContent ?? null,
          })),
        };
      } else {
        out.selected = null;
        out.tiles = [
          ...container.querySelectorAll(".ztransplit-wc-tile-word"),
        ].map((w) => w.textContent);
      }
    }
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
    // collapsible-section 的 body 是惰性渲染的：仅 open 属性不足以让面板
    // DOM 出现，需要一次真实的开合交互。开关一次 header 强制渲染周期。
    if (!q(".ztransplit-tp-lang-input")) {
      try {
        const header = section.querySelector(".collapsible-header") ||
          section.querySelector("collapsible-section > div") ||
          section.firstElementChild;
        if (header) {
          header.click();
          await Zotero.Promise.delay(500);
          header.click();
          await Zotero.Promise.delay(900);
        }
      } catch (e) {
        out.headerToggleError = String(e);
      }
    }
    const langInput = q(".ztransplit-tp-lang-input");
    if (!langInput) {
      return {
        error: "no language input",
        section: out.section,
        text: (section.textContent || "").slice(0, 300),
        sectionHTML: (section.innerHTML || "").slice(0, 300),
        tpNodes: doc.querySelectorAll("[class*='ztransplit-tp']").length,
        tpClassDump: [...doc.querySelectorAll("[class*='ztransplit-tp']")]
          .slice(0, 20)
          .map((n) => `${n.tagName}.${n.className}`),
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
    //    refresh (readSelection → _primaryView._selectionRanges). opts.position
    //    （{pageIndex, rects}）存在时按 Zotero 标注定单形状携带，走面板的
    //    区间兜底路径；否则与真机键盘选区一样只有 text。
    const view = reader._internalReader?._primaryView;
    if (!view) return { error: "no _primaryView on the reader" };
    const lookupWord = opt("word", "resonance");
    const lookupPosition = opt("position", null);
    view._selectionRanges = [
      lookupPosition ? { text: lookupWord, position: lookupPosition } : { text: lookupWord },
    ];
    out.rangesShape = Object.keys(view._selectionRanges[0]);

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
              // 例句上下文：数量 + 每条的来源与几何（真机验证核心字段）
              contexts: Array.isArray(parsed?.contexts)
                ? parsed.contexts.map((c) => ({
                    sentence: String(c?.sentence ?? "").slice(0, 120),
                    itemID: c?.itemID ?? null,
                    itemTitle: c?.itemTitle ?? null,
                    pageIndex: c?.pageIndex ?? null,
                    rects: Array.isArray(c?.rects) ? c.rects.length : null,
                    at: c?.at ?? null,
                  }))
                : null,
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

  // 点击详情页第一条例句行，验证跳转：词卡 tab → 文献阅读器，页码应落到
  // 例句捕获时的页。Reader.open（未开）与 navigate（已开）两条路径都覆盖。
  if (action === "jump") {
    const container = doc.getElementById("ztransplit-wordcards");
    if (!container) return { error: "word-cards tab not open" };
    const row = container.querySelector(".ztransplit-wc-d-ctx");
    if (!row) {
      return {
        error: "no context row — open the tab and select a card with contexts first",
        tiles: [...container.querySelectorAll(".ztransplit-wc-tile-word")].map(
          (w) => w.textContent,
        ),
      };
    }
    const pageOf = (reader) => {
      try {
        const iw = reader?._internalReader?._primaryView?._iframeWindow;
        const raw = iw?.wrappedJSObject ?? iw;
        return (
          raw?.PDFViewerApplication?.pdfViewer?.currentPageNumber ?? null
        );
      } catch {
        return null;
      }
    };
    const readerBefore = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    const before = {
      selectedTab: Zotero_Tabs.selectedID,
      selectedType: Zotero_Tabs.selectedType ?? null,
      page: pageOf(readerBefore),
      rowText: (row.textContent || "").slice(0, 200),
      readersShape: (Zotero.Reader?._readers ?? []).map((r) => ({
        itemID: r?.itemID ?? null,
        _itemID: r?._itemID ?? null,
        _attachmentId: r?._attachmentId ?? null,
        attachmentID: r?.attachmentID ?? null,
        tabID: r?.tabID ?? null,
      })),
    };
    row.click();
    await Zotero.Promise.delay(6000); // Reader.open 新开 tab 需要数秒
    const readerAfter = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    return {
      before,
      after: {
        selectedTab: Zotero_Tabs.selectedID,
        selectedType: Zotero_Tabs.selectedType ?? null,
        page: pageOf(readerAfter),
        readerItemID: readerAfter?.itemID ?? null,
      },
    };
  }

  // 页面行分布侦察：按 transform[5] 粗聚出基线行，报告 y / xMin / 文本前段。
  // 为例句捕获的矩形坐标选择提供真实几何依据。
  if (action === "page") {
    const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    const pv = reader?._internalReader?._primaryView;
    const iw = pv?._iframeWindow;
    const raw = iw?.wrappedJSObject ?? iw;
    const app = raw?.PDFViewerApplication;
    const pdfDoc = app?.pdfViewer?.pdfDocument || app?.pdfDocument;
    if (!pdfDoc?.getPage) {
      return {
        error: "no pdfDocument",
        diag: {
          hasReader: !!reader,
          hasPv: !!pv,
          pvKeys: pv ? Object.keys(pv).filter((k) => /iframe|window/i.test(k)) : null,
          iwType: Object.prototype.toString.call(iw),
          hasWrapped: !!iw?.wrappedJSObject,
          rawKeys: raw ? Object.keys(raw).filter((k) => /PDF|viewer|Application/i.test(k)).slice(0, 10) : null,
          hasApp: !!app,
          appKeys: app ? Object.keys(app).slice(0, 20) : null,
          hasViewer: !!app?.pdfViewer,
          viewerKeys: app?.pdfViewer ? Object.keys(app.pdfViewer).filter((k) => /doc|page/i.test(k)) : null,
        },
      };
    }
    const pageIndex = opt("pageIndex", 0);
    const page = await pdfDoc.getPage(pageIndex + 1);
    const rawPage = page?.wrappedJSObject ?? page;
    const content = await rawPage.getTextContent();
    const items = content?.items ?? [];
    const clusters = new Map();
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      if (!Array.isArray(it.transform) || !Number.isFinite(it.transform[5])) continue;
      const key = Math.round(it.transform[5] / 4) * 4;
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(it);
    }
    const rows = [...clusters.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, arr]) => ({
        y,
        x: Math.round(Math.min(...arr.map((i) => i.transform[4]))),
        text: arr.map((i) => i.str).join("").replace(/\s+/g, " ").trim().slice(0, 70),
      }));
    return { pageIndex, numItems: items.length, rows };
  }

  // navigate 形状侦察：直接在当前 reader 上分别用顶层 pageIndex 与
  // position.pageIndex 两种 location 形状导航，读页码变化——确定生产
  // openContextLocation 应传哪种。
  if (action === "navtest") {
    const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
    if (!reader) return { error: "no reader — open one first" };
    const pageOf = (r) => {
      try {
        const iw = r?._internalReader?._primaryView?._iframeWindow;
        const raw = iw?.wrappedJSObject ?? iw;
        return raw?.PDFViewerApplication?.pdfViewer?.currentPageNumber ?? null;
      } catch {
        return null;
      }
    };
    const out = { before: pageOf(reader) };
    try {
      await reader.navigate({ pageIndex: 1 });
      await Zotero.Promise.delay(2500);
      out.afterTopLevelPageIndex = pageOf(reader);
    } catch (e) {
      out.errTopLevel = String(e);
    }
    try {
      await reader.navigate({ position: { pageIndex: 0 } });
      await Zotero.Promise.delay(2500);
      out.afterPositionPageIndex = pageOf(reader);
    } catch (e) {
      out.errPosition = String(e);
    }
    return out;
  }

  return { error: "unknown wordcards sub-action: " + action };
};

// ── Word-cards layout & entry diagnostics ────────────────────────────────────
//   "seed"         write fake card records to the on-disk store (must run in a
//                  fresh process BEFORE anything loads the store index — the
//                  addon caches the index in memory)
//   "layout"       with the tab open: measure the layout chain (deck →
//                  tab-content → root → body/grid/detail), then click a tile
//                  and re-measure — a root-width change is the "jump"
//   "reader-click" with a reader tab open: synthesize one click on the reader
//                  toolbar word-cards button and report whether the tab got
//                  created AND selected (the two-click check)
PROBE_CMDS.wc = async function (action) {
  // arg 兼容两种形态：纯子动作（"lookup"），或 JSON（{"sub":"lookup","word":...,
  // "position":{pageIndex,rects},"select":"resonance"}）。JSON 形态为例句验证
  // 提供：带位置的伪造选区、指定词、选中词卡、跳转。
  let opts = {};
  if (typeof action === "string" && action.trimStart().startsWith("{")) {
    try {
      opts = JSON.parse(action);
    } catch {
      opts = {};
    }
    action = opts.sub || "";
  }
  const opt = (k, d) => (opts[k] !== undefined ? opts[k] : d);
  const { win, Zotero_Tabs } = probeWin();
  const doc = win.document;
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const host = () => doc.getElementById("ztransplit-wordcards");
  const root = () => host()?.querySelector(".ztransplit-wc-root");

  if (action === "seed" || !action) {
    try {
      const words = [
        ["resonance", "/ˈrezənəns/", "the quality in a sound of being deep and long; the ability to evoke associations"],
        ["epistemology", "/ɪˌpɪstəˈmɒlədʒi/", "the branch of philosophy that deals with knowledge, its methods, validity and scope"],
        ["quantum", "/ˈkwɒntəm/", "the smallest discrete quantity of a physical property such as energy or light"],
        ["ostensibly", "/ɒˈstensəbli/", "apparently, but perhaps not in fact; appearing to be true though it may not be"],
        ["paradigm", "/ˈpærədaɪm/", "a typical pattern or model of something; a worldview underlying the theories of a discipline"],
        ["synthesis", "/ˈsɪnθəsɪs/", "the combination of separate elements into a single, coherent whole"],
        ["amplitude", "/ˈæmplɪtjuːd/", "the maximum extent of a vibration or oscillation, measured from the position of equilibrium"],
        ["hypothesis", "/haɪˈpɒθəsɪs/", "a supposition made as a starting point for further investigation from known facts"],
      ];
      const enc = new TextEncoder();
      let written = 0;
      for (const [word, phonetic, meaning] of words) {
        const normalized = word.toLowerCase().replace(/['’]/g, "'");
        const digest = await crypto.subtle.digest(
          "SHA-1",
          enc.encode(`1|${normalized}`),
        );
        const key = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const now = Date.now() - written * 86400000;
        const record = {
          v: 1,
          key,
          word,
          createdAt: now,
          updatedAt: now,
          lookups: 1,
          latest: { word, phonetic, senses: [{ pos: "n.", meaning }], source: "youdao" },
          history: [{ at: now, targetLang: "zh-CN", content: { word, phonetic, senses: [{ pos: "n.", meaning }], source: "youdao" } }],
        };
        // resonance 携带一条「另一篇文献」的预置例句：真机查词后应与新来源的
        // 例句并存（多来源累积），也顺带验证旧记录加新字段的读取兼容。
        if (word === "resonance") {
          record.contexts = [
            {
              sentence: "Preexisting sentence about resonance from an earlier paper.",
              itemID: 999,
              itemTitle: "Earlier resonance paper (seeded)",
              pageIndex: 0,
              rects: [[50, 500, 300, 520]],
              at: now - 60000,
            },
          ];
        }
        const path = PathUtils.join(
          Zotero.DataDirectory.dir,
          "ztransplit",
          "word-cards",
          "v1",
          key.slice(0, 2),
          `${key}.json`,
        );
        const bucket = path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));
        await IOUtils.makeDirectory(bucket, { createDirs: true, ignoreExisting: true });
        await IOUtils.write(path, enc.encode(JSON.stringify(record)));
        written++;
      }
      return { ok: true, written, dir: PathUtils.join(Zotero.DataDirectory.dir, "ztransplit", "word-cards", "v1") };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  if (action === "layout") {
    if (!root()) {
      return { error: "word-cards tab not open", tabs: Zotero_Tabs._tabs.map((t) => t.type) };
    }
    const grid = host().querySelector(".ztransplit-wc-grid");
    const body = host().querySelector(".ztransplit-wc-body");
    const detail = host().querySelector(".ztransplit-wc-detail");
    const tiles = Array.from(host().querySelectorAll(".ztransplit-wc-tile"));
    const out = {
      win: { w: win.innerWidth, h: win.innerHeight },
      deck: rectOf(doc.getElementById("tabs-deck")),
      tabContent: rectOf(host()),
      root: rectOf(root()),
      bar: rectOf(host().querySelector(".ztransplit-wc-bar")),
      body: rectOf(body),
      grid: rectOf(grid),
      detail: rectOf(detail),
      tileCount: tiles.length,
      gridScrollBefore: grid.scrollTop,
    };
    if (tiles.length) {
      const target = tiles[Math.min(3, tiles.length - 1)];
      out.clickedTileWord = target.querySelector(".ztransplit-wc-tile-word")?.textContent;
      target.click();
      await Zotero.Promise.delay(400);
      out.afterClick = {
        root: rectOf(root()),
        gridScrollAfter: grid.scrollTop,
        detailText: (detail?.textContent || "").slice(0, 120),
        detailW: rectOf(detail)?.w,
      };
    }
    return out;
  }

  if (action === "reader-click") {
    const reader =
      Zotero.Reader.getByTabID(Zotero_Tabs.selectedID) ||
      Zotero.Reader._readers?.[0];
    const rdoc = reader?._iframeWindow?.document;
    const btn = rdoc?.querySelector(".ztransplit-wc-reader-btn");
    const before = {
      readerFound: !!reader,
      buttonFound: !!btn,
      selectedID: Zotero_Tabs.selectedID,
      wordcardsTabExisted: !!Zotero_Tabs._getTab?.("ztransplit-wordcards")?.tab,
    };
    if (!btn) return { before, error: "reader button not found" };
    btn.click();
    await Zotero.Promise.delay(2500);
    const tab = Zotero_Tabs._getTab?.("ztransplit-wordcards")?.tab;
    const deck = doc.getElementById("tabs-deck");
    return {
      before,
      after: {
        tabExists: !!tab,
        tabSelected: Zotero_Tabs.selectedID === "ztransplit-wordcards",
        deckSelectedIndex: deck?.selectedIndex,
        deckChildIds: deck ? Array.from(deck.children).map((c) => c.id) : null,
        rootPresent: !!root(),
        root: rectOf(root()),
      },
    };
  }

  return { error: "unknown wc sub-action: " + action };
};

// ── README screenshot staging ───────────────────────────────────────────────
// Commands that stage the exact UI states the README screenshots show and
// capture them. They drive the real addon through the real user paths; the
// only shortcut is the staged reader selection (same as wordcards/lookup).

/**
 * shot — screenshot a Zotero window to an absolute PNG path.
 *   arg: { file, win: "main" | "prefs" }  (win defaults to "main")
 */
PROBE_CMDS.shot = async function (arg) {
  const opts = typeof arg === "string" ? { file: arg } : arg || {};
  let target;
  if (opts.win === "prefs") {
    target = Services.wm.getMostRecentWindow("zotero:pref");
    if (!target) return { ok: false, error: "no prefs window open" };
  } else {
    target = Zotero.getMainWindow();
  }
  const doc = target.document;
  const w = target.outerWidth;
  const h = target.outerHeight;
  // Capture at the device pixel ratio so HiDPI displays give crisp PNGs.
  const dpr = target.devicePixelRatio || 1;
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx2d = canvas.getContext("2d");
  ctx2d.scale(dpr, dpr);
  ctx2d.drawWindow(target, 0, 0, w, h, "rgb(255,255,255)");
  const dataURL = canvas.toDataURL("image/png");
  const bytes = Uint8Array.from(atob(dataURL.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  await IOUtils.write(opts.file, bytes);
  return { ok: true, file: opts.file, bytes: bytes.length, w, h };
};

/**
 * Open the reader context pane. On a fresh profile the pane has no persisted
 * width, so uncollapsing alone leaves it at zero pixels — seed a width first.
 */
async function probeOpenContextPane(doc) {
  const pane = doc.getElementById("zotero-context-pane");
  if (!pane) return null;
  if (pane.collapsed) {
    if (!Number(pane.getAttribute("width") || 0)) {
      pane.setAttribute("width", "470");
    }
    const toggle = doc.getElementById("context-pane-toggle");
    if (toggle) toggle.click();
    else pane.collapsed = false;
    await Zotero.Promise.delay(1200);
  } else if (!Number(pane.getAttribute("width") || 0)) {
    pane.setAttribute("width", "470");
    await Zotero.Promise.delay(800);
  }
  return pane;
}

/** Scroll the visible translate section to the top of the item pane. */
async function probeScrollSectionIntoView(doc) {
  const section = Array.from(doc.querySelectorAll("item-pane-custom-section")).find(
    (c) => (c.dataset.pane || "").includes("transplit") && !c.hidden,
  );
  if (!section) return false;
  try {
    section.scrollIntoView({ block: "start", inline: "nearest" });
  } catch {
    section.scrollIntoView();
  }
  await Zotero.Promise.delay(600);
  return true;
}

/**
 * demoItem — import a fixture PDF as a real item + attachment, open it in the
 * reader, and open the context pane (collapsed on a fresh profile).
 *   arg: { pdf, title, filename }  (pdf defaults to <dataDir>/qa-sample.pdf)
 */
PROBE_CMDS.demoItem = async function (arg) {
  const opts = typeof arg === "string" ? { pdf: arg } : arg || {};
  const dataDir = Zotero.DataDirectory.dir;
  const pdfPath = opts.pdf || PathUtils.join(dataDir, "qa-sample.pdf");
  if (!(await IOUtils.exists(pdfPath))) return { error: "no PDF at " + pdfPath };
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const { ZoteroPane, Zotero_Tabs } = probeWin();

  let item = new Zotero.Item("journalArticle");
  item.setField("title", opts.title || "QA sample paper");
  const itemID = await item.saveTx();
  const att = await Zotero.Attachments.importFromFile({
    file: pdfPath,
    parentItemID: itemID,
    title: opts.filename || "QA sample PDF",
  });
  PROBE_STATE.demo = { itemID, attachmentID: att.id };

  ZoteroPane.selectItem(att.id);
  await Zotero.Promise.delay(500);
  await ZoteroPane.viewAttachment(att.id);
  await Zotero.Promise.delay(5000);
  PROBE_STATE.demoTabID = Zotero_Tabs.selectedID;

  const contextPaneEl = await probeOpenContextPane(doc);
  return {
    itemID,
    attachmentID: att.id,
    tabID: Zotero_Tabs.selectedID,
    contextCollapsed: contextPaneEl?.collapsed ?? null,
    contextWidth: contextPaneEl?.getAttribute("width") ?? null,
  };
};

/**
 * selectTranslate — stage a reader selection and run the pane's Translate
 * through to a settled state (result, error, or timeout).
 *   arg: { text, targetLang }
 */
PROBE_CMDS.selectTranslate = async function (arg) {
  const opts = typeof arg === "string" ? { text: arg } : arg || {};
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const { Zotero_Tabs } = probeWin();
  const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
  if (!reader) return { error: "no reader open" };

  await probeOpenContextPane(doc);

  const q = (sel) => doc.querySelector(sel);
  const qa = (sel) => [...doc.querySelectorAll(sel)];
  const langInput = q(".ztransplit-tp-lang-input");
  if (!langInput) return { error: "no language input" };
  if (opts.targetLang) {
    langInput.value = opts.targetLang;
    langInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    langInput.dispatchEvent(new win.FocusEvent("blur"));
    await Zotero.Promise.delay(300);
  }

  const view = reader._internalReader?._primaryView;
  if (!view) return { error: "no _primaryView" };
  view._selectionRanges = [{ text: opts.text }];

  const refreshBtn = qa("button").find((b) =>
    /refresh selection|刷新选区/i.test(b.textContent || ""),
  );
  if (!refreshBtn) {
    return { error: "no refresh button", buttons: qa("button").map((b) => b.textContent) };
  }
  refreshBtn.click();
  await Zotero.Promise.delay(800);

  const findTranslateBtn = () =>
    qa("button").find((b) => /^(translate|翻译)$/i.test((b.textContent || "").trim()));
  const translateBtn = findTranslateBtn();
  if (translateBtn) translateBtn.click();

  const t0 = Date.now();
  let state = "timeout";
  for (; Date.now() - t0 < 90000; ) {
    await Zotero.Promise.delay(1000);
    if (q(".ztransplit-tp-error")) {
      state = "error";
      break;
    }
    if (q(".ztransplit-tp-result-text")) {
      state = "done";
      break;
    }
    // A language commit or a state reset can bring the idle button back while
    // nothing is in flight — press it again so the run cannot stall idle.
    const again = findTranslateBtn();
    if (again && !q(".ztransplit-tp-shimmer") && !q(".ztransplit-tp-loading")) {
      again.click();
    }
  }
  await probeScrollSectionIntoView(doc);

  // Remove the staged fake: it is a chrome-realm array on a content-realm
  // view object, and Zotero 10.0.6+'s selection layer reads _selectionRanges
  // on reader events — each read throws cross-realm "Permission denied"
  // (reader.js _isSelectionCollapsed/_pushSelection), which accompanies
  // frozen first paints in the split view. Restore the property to absent —
  // exactly what a reader without any selection history looks like.
  try {
    delete view._selectionRanges;
  } catch (e) {
    /* best effort — the shot is already taken */
  }

  return {
    state,
    source: q(".ztransplit-tp-source-text")?.textContent?.slice(0, 150) ?? null,
    result: q(".ztransplit-tp-result-text")?.textContent?.slice(0, 250) ?? null,
    error: q(".ztransplit-tp-error")?.textContent?.slice(0, 250) ?? null,
  };
};

/**
 * bilingualMode — switch an already-running bilingual session's presentation
 * (unlike `bilingual`, which toggles the session on). Current builds expose
 * two mode BUTTONS ("Interleaved …" / "Translation only"); older builds had a
 * <select> dropdown (ztransplit-bc-mode), still supported as a fallback.
 *   arg: "only" | "interleave"  (aliases: "transOnly", "translation only")
 */
PROBE_CMDS.bilingualMode = async function (mode) {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const section = Array.from(
    doc.querySelectorAll("item-pane-custom-section"),
  ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
  if (!section) return { error: "no visible translate section" };
  const wantOnly = /only|仅译文/i.test(mode || "");
  const sel = section.querySelector("select.ztransplit-bc-mode");
  if (!sel) {
    const btn = Array.from(section.querySelectorAll("button")).find((b) =>
      wantOnly
        ? /translation only|仅译文/i.test(b.textContent || "")
        : /interleaved|上下对照/i.test(b.textContent || ""),
    );
    if (!btn) {
      return {
        error: "no mode button or mode select",
        controls: Array.from(section.querySelectorAll("button, select"), (b) =>
          b.tagName + ":" + (b.textContent || b.value || ""),
        ),
      };
    }
    btn.click();
    await Zotero.Promise.delay(2500);
    await probeScrollSectionIntoView(doc);
    return {
      via: "button",
      clicked: btn.textContent,
      sectionText: (section.textContent || "").slice(0, 300),
    };
  }
  const target = wantOnly ? "transOnly" : "interleave";
  const before = sel.value;
  sel.disabled = false;
  sel.value = target;
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  await Zotero.Promise.delay(2500);
  await probeScrollSectionIntoView(doc);
  return {
    before,
    after: sel.value,
    sectionText: (section.textContent || "").slice(0, 300),
  };
};

/**
 * theme — force the CONTENT color-scheme (the SDT reading-mode stylesheet
 * and the bilingual blocks key off prefers-color-scheme; this Firefox root
 * pref overrides it per profile without touching the OS). arg: "dark" |
 * "light".
 */
PROBE_CMDS.theme = async function (mode) {
  const dark = /dark|暗/i.test(mode || "");
  Services.prefs.setIntPref(
    "layout.css.prefers-color-scheme.content-override",
    dark ? 0 : 1,
  );
  // The reader is a privileged document: the content pref above does not
  // reach it. Gecko's per-docShell colorSchemeOverride does — apply it down
  // the frame chain (reader docShell + the nested SDT view's docShell).
  const overrides = [];
  const { Zotero_Tabs } = probeWin();
  const r = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
  const shells = [];
  try {
    shells.push(["reader", r?._iframeWindow?.docShell]);
    const sdtView = r?._internalReader?._primarySDTView;
    const rawView = sdtView?.wrappedJSObject ?? sdtView;
    shells.push(["sdt", rawView?._iframe?.contentWindow?.docShell]);
  } catch (e) {
    overrides.push("collect: " + e);
  }
  for (const [name, shell] of shells) {
    try {
      shell.colorSchemeOverride = dark ? "dark" : "light";
      overrides.push(name + ":ok");
    } catch (e) {
      overrides.push(name + ":" + e);
    }
  }
  await Zotero.Promise.delay(1200);
  const irWin = r?._internalReader?._iframeWindow;
  let contentDark = null;
  try {
    contentDark =
      irWin?.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? null;
  } catch (e) {
    /* ignore */
  }
  return { mode: dark ? "dark" : "light", contentDark, overrides };
};

/**
 * biToggle — click the first visible bilingual block (the paragraph
 * show/hide gesture) so a capture can show the neutral collapsed bar.
 */
/**
 * biPoint — screen coordinates of the first bilingual block plus its
 * collapsed state, so a REAL mouse click (trusted event) can be driven from
 * outside. Synthetic cross-realm dispatchEvent was swallowed by the content
 * realm and never reached the click handler (2026-10-30 real-machine round);
 * trusted clicks are also the faithful test of the user gesture.
 */
PROBE_CMDS.biPoint = async function () {
  const { Zotero_Tabs } = probeWin();
  const r = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
  const internal = r?._internalReader;
  const sdtView = internal?._primarySDTView;
  const rawView = sdtView?.wrappedJSObject ?? sdtView;
  const frameEl = rawView?._iframe;
  const doc = frameEl?.contentDocument;
  const bi = doc?.querySelector("#sdt-content .ztransplit-bi");
  if (!bi) return { error: "no bi block in the reading view" };
  bi.scrollIntoView({ block: "center" });
  await Zotero.Promise.delay(600);
  const rect = bi.getBoundingClientRect();
  let x = rect.left + Math.min(rect.width / 2, 200);
  let y = rect.top + Math.min(rect.height / 2, 12);
  // Compound the iframe chain: the SDT iframe's rect inside the reader doc,
  // then the reader's browser element inside the chrome window.
  try {
    const fr = frameEl.getBoundingClientRect();
    x += fr.left;
    y += fr.top;
    const readerWin = frameEl.ownerDocument.defaultView;
    const readerFrameEl = r._iframeWindow?.frameElement ?? readerWin?.frameElement;
    if (readerFrameEl) {
      const rf = readerFrameEl.getBoundingClientRect();
      x += rf.left;
      y += rf.top;
    }
  } catch (e) {
    /* coordinates stay viewport-relative — the caller sees a bad point */
  }
  const cw = Zotero.getMainWindow();
  const dpr = cw.devicePixelRatio || 1;
  return {
    hidden: bi.hasAttribute("data-hidden"),
    screenX: Math.round(cw.mozInnerScreenX + x * dpr),
    screenY: Math.round(cw.mozInnerScreenY + y * dpr),
    viewport: { top: Math.round(rect.top), h: Math.round(rect.height) },
  };
};

/**
 * openTranslated — open the demo item's `Translated (…)` attachment tab
 * (the pipeline normally auto-opens it; this is the recovery path).
 */
PROBE_CMDS.openTranslated = async function () {
  const { ZoteroPane, Zotero_Tabs } = probeWin();
  const demoID = PROBE_STATE.demo?.itemID;
  if (!demoID) return { error: "no demo item — run demoItem first" };
  const item = await Zotero.Items.getAsync(demoID);
  const atts = item.getAttachments().map((id) => Zotero.Items.get(id));
  const translated = atts.find((a) =>
    /^Translated \(/.test(a.getField("title") || ""),
  );
  if (!translated) {
    return {
      error: "no Translated (…) attachment",
      attachments: atts.map((a) => a.getField("title")),
    };
  }
  await ZoteroPane.viewAttachment(translated.id);
  // A short fixed wait races the reader's first paint: on a slow run the
  // capture caught a blank frame. Wait until pdf.js has actually rendered
  // page 1 (or 12 s, whichever comes first) before reporting success.
  {
    const view = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)?._internalReader?._primaryView;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      await Zotero.Promise.delay(500);
      try {
        const w = view?._iframe?.contentWindow?.wrappedJSObject
          ?? view?._iframe?.contentWindow;
        const status = w?.PDFViewerApplication?.pdfViewer?._pages?.[0]?.renderingState;
        if (status === 3 || status === "finished") break;
      } catch (e) { /* not ready yet — keep polling */ }
    }
  }
  await Zotero.Promise.delay(1500);
  return { opened: translated.getField("title"), tabID: Zotero_Tabs.selectedID };
};

/**
 * frame — set the main-window pane layout for a screenshot.
 *   arg: { contextPane: "open"|"close", collections: "open"|"close",
 *          itemPane: "open"|"close" }   (omitted keys keep the current state)
 */
PROBE_CMDS.frame = async function (arg) {
  let opts = arg || {};
  if (typeof opts === "string") {
    try {
      opts = JSON.parse(opts);
    } catch {
      return { error: "frame arg is not JSON: " + opts };
    }
  }
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const out = {};
  const setCollapsed = async (id, want) => {
    const el = doc.getElementById(id);
    if (!el) return;
    if (want === "open") {
      if (id === "zotero-context-pane") {
        await probeOpenContextPane(doc);
        out[id] = el.collapsed;
        return;
      }
      if (el.collapsed) el.collapsed = false;
    } else if (want === "close") {
      el.collapsed = true;
    }
    out[id] = el.collapsed;
  };
  if (opts.collections) await setCollapsed("zotero-collections-pane", opts.collections);
  if (opts.itemPane) await setCollapsed("zotero-item-pane", opts.itemPane);
  if (opts.contextPane) await setCollapsed("zotero-context-pane", opts.contextPane);
  await Zotero.Promise.delay(800);
  return out;
};

/** prefsOpen — open the settings window on the Z-Transplit pane (stays open). */
PROBE_CMDS.prefsOpen = async function () {
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
  // A readable screenshot size (the default window is ~800x640 and scrolls).
  try {
    win.resizeTo(1300, 1000);
    win.moveTo(
      Math.max(0, (win.screen.availWidth - 1300) / 2),
      Math.max(0, (win.screen.availHeight - 1000) / 2),
    );
  } catch (e) {
    probeLog("prefs resize: " + e);
  }
  await Zotero.Promise.delay(1200);
  const doc = win.document;
  return {
    ok: true,
    paneLoaded: !!doc.getElementById("zotero-prefpane-ztransplit"),
    title: doc.title || null,
  };
};

/** prefsClose — close the settings window opened by prefsOpen. */
PROBE_CMDS.prefsClose = async function () {
  const win = Services.wm.getMostRecentWindow("zotero:pref");
  if (!win) return { ok: false, error: "no prefs window" };
  win.close();
  await Zotero.Promise.delay(500);
  return { ok: true };
};

/**
 * demoTab — switch back to the demo item's source reader tab (the tab demoItem
 * opened), so later commands act on the original PDF rather than a derived tab.
 */
PROBE_CMDS.demoTab = async function () {
  const { Zotero_Tabs } = probeWin();
  const tabID = PROBE_STATE.demoTabID;
  if (!tabID) return { error: "no demo tab recorded — run demoItem first" };
  let via = "recorded";
  const exists = (Zotero_Tabs._tabs || []).some((t) => t.id === tabID);
  if (exists) {
    Zotero_Tabs.select(tabID);
    await Zotero.Promise.delay(1500);
  } else {
    // Pipeline steps can close/replace the original reader tab (observed in
    // the full-text round: after the translated attachment opened, the
    // recorded id no longer resolved and Zotero_Tabs.select threw). Select
    // the tab of the EXISTING reader instance for the attachment first —
    // opening a second reader for the same item confuses the split view
    // (readers stall mid-paint). viewAttachment is the last resort only.
    const attID = PROBE_STATE.demo?.attachmentID;
    if (attID == null) return { error: "demo attachment missing — run demoItem first" };
    let readers = [];
    try {
      readers = Zotero.Reader.getByItemID(attID) || [];
    } catch {
      readers = [];
    }
    const reader = readers.find((r) => r.tabID && (Zotero_Tabs._tabs || []).some((t) => t.id === r.tabID));
    if (reader) {
      Zotero_Tabs.select(reader.tabID);
      await Zotero.Promise.delay(1500);
      via = "reader";
    } else {
      const win = Zotero.getMainWindow();
      await win.ZoteroPane.viewAttachment(attID);
      await Zotero.Promise.delay(2500);
      via = "viewAttachment";
    }
  }
  return {
    selectedID: Zotero_Tabs.selectedID,
    via,
    isDemo: Zotero_Tabs.selectedID === tabID,
    tabs: (Zotero_Tabs._tabs || []).map((t) => [t.id, t.type, t.title]),
  };
};

/**
 * tabReselect — switch away from the selected tab and back, forcing the XUL
 * deck to recompute panel activation on the CURRENT container nodes.
 */
PROBE_CMDS.tabReselect = async function () {
  const win = Zotero.getMainWindow();
  const { Zotero_Tabs } = probeWin();
  const current = Zotero_Tabs.selectedID;
  const other = (Zotero_Tabs._tabs || []).find((t) => t.id !== current);
  if (!other) return { error: "no other tab" };
  Zotero_Tabs.select(other.id);
  await Zotero.Promise.delay(800);
  Zotero_Tabs.select(current);
  await Zotero.Promise.delay(1500);
  return { reselected: current };
};

/**
 * rafCheck — diagnose a stalled split view: for every live reader report
 * whether requestAnimationFrame fires in the pdf.js iframe (refresh driver
 * running?), the docShell activation state, and focus. With --force also
 * flips docShell activation on and asks pdf.js to re-render, so the SAME
 * command can test the hypothesis end to end.
 */
PROBE_CMDS.rafCheck = async function (arg) {
  const force = arg === true || arg === "force";
  const readers = Zotero.Reader._readers || [];
  const out = [];
  for (const r of readers) {
    const iw = r._internalReader?._primaryView?._iframeWindow ?? r._iframeWindow;
    const w = iw?.wrappedJSObject || iw;
    if (!w) {
      out.push({ item: r.itemID, err: "no iframe window" });
      continue;
    }
    let browserEl = null;
    try {
      browserEl = iw.frameElement ?? w.frameElement;
    } catch (e) { /* cross-realm — ignore */ }
    let docShell = null;
    try {
      docShell = browserEl?.docShell ?? null;
    } catch (e) { /* ignore */ }
    const entry = {
      item: r.itemID,
      isActive: (() => { try { return !!docShell?.isActive; } catch (e) { return "err:" + e; } })(),
      hasBrowser: !!browserEl,
      hasFocus: (() => { try { return !!w.document.hasFocus(); } catch (e) { return null; } })(),
    };
    const fired = await new Promise((res) => {
      let done = false;
      try {
        w.requestAnimationFrame(() => { done = true; res(true); });
      } catch (e) { res("throw"); return; }
      setTimeout(() => { if (!done) res(false); }, 2000);
    });
    entry.raf = fired;
    if (force && docShell) {
      try {
        docShell.setIsActive(true);
        entry.forceActive = docShell.isActive;
      } catch (e) { entry.forceActive = "err:" + e; }
      try {
        w.PDFViewerApplication?.pdfViewer?.update?.();
      } catch (e) { /* ignore */ }
    }
    out.push(entry);
  }
  await Zotero.Promise.delay(1500);
  return out;
};

/**
 * splitPoke — nudge every live reader so a stalled split view resumes
 * painting. Observed on Zotero 10.0.6: both split readers freeze after the
 * first canvas chunk (spinner forever, paint state identical at 6 s and
 * 18 s) until some interaction happens. pdf.js's pdfViewer.update() forces
 * re-layout/repaint of the visible pages; a tiny scroll round-trip kicks the
 * refresh driver the way a user's first movement would.
 */
PROBE_CMDS.splitPoke = async function () {
  const readers = Zotero.Reader._readers || [];
  const poked = [];
  for (const r of readers) {
    try {
      const view = r._internalReader?._primaryView;
      const iw = view?._iframeWindow ?? r._iframeWindow;
      const w = iw?.wrappedJSObject || iw;
      if (!w) continue;
      try {
        w.PDFViewerApplication?.pdfViewer?.update?.();
      } catch (e) { /* pdf.js not ready in this pane */ }
      w.scrollBy(0, 40);
      await Zotero.Promise.delay(250);
      w.scrollBy(0, -40);
      poked.push(r.itemID);
    } catch (e) {
      /* reader gone — skip */
    }
  }
  await Zotero.Promise.delay(2500);
  return { poked, readers: readers.length };
};

/**
 * bilingualWait — poll the running bilingual session's progress until it
 * settles (translated count stable for 3 s) or the cap is hit, so a screenshot
 * shows filled blocks rather than mid-run placeholders.
 */
PROBE_CMDS.bilingualWait = async function (capMs) {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const t0 = Date.now();
  const cap = Number(capMs) || 180000;
  let last = "";
  let stable = 0;
  let sample = "";
  while (Date.now() - t0 < cap) {
    await Zotero.Promise.delay(1000);
    const section = Array.from(
      doc.querySelectorAll("item-pane-custom-section"),
    ).find((c) => (c.dataset.pane || "").includes("transplit") && c.hidden === false);
    sample = section ? (section.textContent || "") : "";
    const m = sample.match(/(\d+)\s*\/\s*(\d+)/);
    const cur = m ? m[1] + "/" + m[2] : sample.slice(0, 60);
    if (m && m[1] === m[2]) {
      stable = 99;
      last = cur;
      break;
    }
    if (cur === last) {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
      last = cur;
    }
  }
  return { progress: last, stableFor: stable, ms: Date.now() - t0 };
};

/** 取文档顺序里最后一个分隔条：真实鼠标命中的就是它（绘制在最上层）。
 *  一个条目挂多个 PDF 时批量开屏会产生多个分屏视图，全部叠在同一个
 *  tabs-deck 里，querySelector 取到的第一个往往是被盖住的那个。 */
function visibleResizer(doc) {
  const all = doc.querySelectorAll(".ztransplit-split-resizer");
  return all.length ? all[all.length - 1] : null;
}

/** parseArg — the launcher hands the handler argv[4] as a raw string. */
function parseArg(arg) {
  if (arg && typeof arg === "object") return arg;
  if (typeof arg !== "string" || !arg.trim()) return {};
  try {
    const v = JSON.parse(arg);
    return v && typeof v === "object" ? v : { value: v };
  } catch (e) {
    return { value: arg };
  }
}

/**
 * splitOpenOnce — 与 splitOpen 相同，但只调 doCommand()，不派发 popupshowing。
 * 用来隔离「一次菜单调用打开两个分屏标签」是插件缺陷还是探针调用方式导致：
 * 两种方式各开一次，比较 resizerCount 与 reader 标签数。
 */
PROBE_CMDS.splitOpenOnce = async function (arg) {
  const opts = parseArg(arg);
  const FIXDIR = "D:\\github_code\\z-transplit\\scripts\\qa\\fixtures";
  const left = opts.left || PathUtils.join(FIXDIR, "attention-reading.pdf");
  const right = opts.right || PathUtils.join(FIXDIR, "reading-brain.pdf");
  const dataDir = Zotero.DataDirectory.dir;
  const leftPath = PathUtils.join(dataDir, "split-left.pdf");
  const rightPath = PathUtils.join(dataDir, "split-right.pdf");
  await IOUtils.copy(left, leftPath);
  await IOUtils.copy(right, rightPath);
  const item = new Zotero.Item("journalArticle");
  item.setField("title", "QA split-view pair");
  const itemID = await item.saveTx();
  await Zotero.Attachments.importFromFile({ file: leftPath, parentItemID: itemID, title: "QA split left" });
  await Zotero.Attachments.importFromFile({ file: rightPath, parentItemID: itemID, title: "QA split right" });
  const { ZoteroPane, Zotero_Tabs } = probeWin();
  const doc = Zotero.getMainWindow().document;
  ZoteroPane.selectItem(itemID);
  await Zotero.Promise.delay(600);
  const entry = doc.getElementById("ztransplit-itemmenu-split");
  if (!entry) return { error: "no ztransplit-itemmenu-split" };
  entry.doCommand();   // 注意：没有派发 popupshowing
  const t0 = Date.now();
  let resizer = null;
  while (Date.now() - t0 < 60000) {
    await Zotero.Promise.delay(500);
    resizer = visibleResizer(doc);
    if (resizer) break;
  }
  await Zotero.Promise.delay(3000);
  return {
    invoked: "doCommand only (no popupshowing)",
    resizerCount: doc.querySelectorAll(".ztransplit-split-resizer").length,
    readerTabs: (Zotero_Tabs._tabs || []).filter((t) => t.type === "reader").length,
    tabs: (Zotero_Tabs._tabs || []).map((t) => [t.id, t.type]),
    ms: Date.now() - t0,
  };
};

/** winSize — resize the main window to a fixed logical size (CSS px). */
PROBE_CMDS.winSize = async function (arg) {
  const opts = parseArg(arg);
  const win = Zotero.getMainWindow();
  const doc = win.document;
  win.resizeTo(Number(opts.w) || 1280, Number(opts.h) || 800);
  await Zotero.Promise.delay(900);
  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    window: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio, sizemode: doc.documentElement.getAttribute("sizemode") },
    itemsTree: R(doc.getElementById("zotero-items-tree")),
    itemsToolbox: R(doc.getElementById("zotero-tb-toolbar")),
    tabs: R(doc.getElementById("zotero-tabs")),
    tabpanels: R(doc.getElementById("zotero-tabs")?.querySelector("tabpanels")),
    contextPane: R(doc.getElementById("zotero-context-pane")),
  };
};

/**
 * splitOpen — build the issue's repro: one item with two PDF attachments,
 * then launch the split-screen reading entry from the library item-tree menu.
 * Leaves the split tab open for `divider`.
 *   arg: { left, right }  — source PDF paths (defaults to the repo fixtures)
 */
PROBE_CMDS.splitOpen = async function (arg) {
  const opts = parseArg(arg);
  const FIX = "D:\\github_code\\z-transplit\\scripts\\qa\\fixtures\\";
  const left = opts.left || FIX + "attention-reading.pdf";
  const right = opts.right || FIX + "reading-brain.pdf";
  const dataDir = Zotero.DataDirectory.dir;
  const dest = async (src, name) => {
    const p = PathUtils.join(dataDir, name);
    await IOUtils.copy(src, p);
    return p;
  };
  const leftPath = await dest(left, "split-left.pdf");
  const rightPath = await dest(right, "split-right.pdf");

  const item = new Zotero.Item("journalArticle");
  item.setField("title", "QA split-view pair");
  const itemID = await item.saveTx();
  const leftAtt = await Zotero.Attachments.importFromFile({
    file: leftPath,
    parentItemID: itemID,
    title: "QA split left",
  });
  const rightAtt = await Zotero.Attachments.importFromFile({
    file: rightPath,
    parentItemID: itemID,
    title: "QA split right",
  });

  const { ZoteroPane, Zotero_Tabs } = probeWin();
  const win = Zotero.getMainWindow();
  const doc = win.document;
  ZoteroPane.selectItem(itemID);
  await Zotero.Promise.delay(600);

  const popup = doc.getElementById("zotero-itemmenu");
  popup.dispatchEvent(new win.Event("popupshowing"));
  const entry = doc.getElementById("ztransplit-itemmenu-split");
  if (!entry) {
    return { error: "no ztransplit-itemmenu-split", itemID, leftAtt: leftAtt.id, rightAtt: rightAtt.id };
  }
  entry.doCommand();

  // Wait for the split view to finish building (resizer appears last).
  const t0 = Date.now();
  let resizer = null;
  while (Date.now() - t0 < 60000) {
    await Zotero.Promise.delay(500);
    resizer = visibleResizer(doc);
    if (resizer) break;
  }
  await Zotero.Promise.delay(3000);
  return {
    itemID,
    leftAtt: leftAtt.id,
    rightAtt: rightAtt.id,
    tabID: Zotero_Tabs.selectedID,
    tabType: (Zotero_Tabs._tabs || []).find((t) => t.id === Zotero_Tabs.selectedID)?.type,
    resizerFound: !!resizer,
    ms: Date.now() - t0,
    tabs: (Zotero_Tabs._tabs || []).map((t) => [t.id, t.type]),
  };
};

/**
 * divider — measure how the split-view divider actually tracks the pointer.
 *
 * Drives the resizer's own handlers with synthetic mouse events and records
 * the resulting pane geometry, so the ratio math can be checked against the
 * real layout instead of against what the code assumes.
 *   arg: { step, target, delay }
 *     step   — pointer step in px (default 25)
 *     target — where mousemove is dispatched: "win" (default, the retargeted
 *              path the handler listens on) | "browser" | "resizer"
 */
PROBE_CMDS.divider = async function (arg) {
  const opts = parseArg(arg);
  const step = Number(opts.step) || 25;
  const target = opts.target || "win";
  const delay = Number(opts.delay) || 25;
  const win = Zotero.getMainWindow();
  const doc = win.document;

  const resizer = visibleResizer(doc);
  if (!resizer) {
    return {
      error: "no .ztransplit-split-resizer in the main window",
      tabs: (win.Zotero_Tabs._tabs || []).map((t) => [t.id, t.type]),
    };
  }
  const mainHbox = resizer.parentNode;
  const kids = Array.from(mainHbox.children);
  const browsers = kids.filter((c) => c.localName === "browser");
  if (browsers.length !== 2) {
    return {
      error: "expected 2 browser children",
      children: kids.map((c) => c.localName),
    };
  }
  const leftB = browsers[0];
  const rightB = browsers[1];

  const R = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
    };
  };
  const cs = (el, props) => {
    const s = win.getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = s[p];
    return o;
  };
  const hbox = R(mainHbox);

  const fire = (type, el, clientX, bubbles = true, buttons = 1) => {
    const cy = Math.round(hbox.y + hbox.h / 2);
    el.dispatchEvent(
      new win.MouseEvent(type, {
        bubbles,
        cancelable: true,
        view: win,
        button: 0,
        buttons,
        clientX,
        clientY: cy,
        // installResizer 读 screenX 的位移量（修复本身），合成事件必须带上，
        // 否则 screenX 默认为 0、位移量恒为 0，分隔条不会动。
        screenX: clientX,
        screenY: cy,
      }),
    );
  };
  const moveTarget = (x) =>
    target === "browser"
      ? x < hbox.x + hbox.w / 2
        ? leftB
        : rightB
      : target === "resizer"
        ? resizer
        : win;

  const measure = (cursor) => {
    const rr = R(resizer);
    return {
      cursor,
      leftW: R(leftB).w,
      resizerX: rr.x,
      resizerW: rr.w,
      rightW: R(rightB).w,
      leftGrow: leftB.style.flexGrow,
      rightGrow: rightB.style.flexGrow,
      delta: cursor == null ? null : +(rr.x - cursor).toFixed(1),
    };
  };

  const sweep = async (xs) => {
    const out = [];
    fire("mousedown", resizer, xs[0]);
    for (const x of xs) {
      fire("mousemove", moveTarget(x), x);
      await Zotero.Promise.delay(delay);
      out.push(measure(x));
    }
    fire("mouseup", win, xs[xs.length - 1], true, 0);
    await Zotero.Promise.delay(200);
    return out;
  };

  const lo = Math.ceil(hbox.x + 1);
  const hi = Math.floor(hbox.x + hbox.w - 1);
  const rightXs = [];
  for (let x = lo; x <= hi; x += step) rightXs.push(x);
  if (rightXs[rightXs.length - 1] !== hi) rightXs.push(hi);

  const out = {
    info: {
      window: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio },
      hbox,
      containerStyle: mainHbox.parentNode?.getAttribute("style"),
      hboxStyle: mainHbox.getAttribute("style"),
      children: kids.map((c) => ({
        tag: c.localName,
        cls: String(c.className),
        ...R(c),
      })),
      leftStyle: leftB.getAttribute("style"),
      rightStyle: rightB.getAttribute("style"),
      resizerComputed: cs(resizer, ["width", "minWidth", "maxWidth", "flexGrow", "flexBasis", "flexShrink"]),
      leftComputed: cs(leftB, ["flexGrow", "flexBasis", "flexShrink", "minWidth", "maxWidth"]),
      rightComputed: cs(rightB, ["flexGrow", "flexBasis", "flexShrink", "minWidth", "maxWidth"]),
    },
  };

  out.sweepRight = await sweep(rightXs);
  out.sweepLeft = await sweep(rightXs.slice().reverse());

  // A mouseup that only reaches the pane (bubbles:false mimics the event being
  // consumed by the out-of-process content instead of retargeted to chrome):
  // if the handler never sees it, `dragging` stays true and every later
  // pointer move keeps resizing the panes.
  {
    const mid = Math.round(hbox.x + hbox.w / 2);
    fire("mousedown", resizer, mid);
    fire("mousemove", win, mid + 40);
    await Zotero.Promise.delay(80);
    fire("mouseup", rightB, mid + 40, false, 0);
    await Zotero.Promise.delay(120);
    const before = measure(mid + 40);
    fire("mousemove", win, mid + 200, true, 0); // no button held
    await Zotero.Promise.delay(120);
    const after = measure(mid + 200);
    out.stuckDrag = { before, after, movedWithoutButton: after.leftW !== before.leftW };
    fire("mouseup", win, mid + 200, true, 0);
    await Zotero.Promise.delay(200);
  }
  out.final = measure(null);
  return out;
};

/**
 * dividerGo — park the divider at an absolute clientX (synthetic drag), and
 * report the clientX→screen mapping the real-mouse driver needs.
 *   arg: { x }  — target clientX inside mainHbox
 */
PROBE_CMDS.dividerGo = async function (arg) {
  const opts = parseArg(arg);
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const resizer = visibleResizer(doc);
  if (!resizer) return { error: "no .ztransplit-split-resizer" };
  const mainHbox = resizer.parentNode;
  const browsers = Array.from(mainHbox.children).filter(
    (c) => c.localName === "browser",
  );
  const R = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const hbox = R(mainHbox);
  // 文档里可能同时存在多个分隔条（多个分屏标签），逐个报告它们所在
  // hbox 的两个浏览器宽度，便于判断插件监听到底挂在哪一个上。
  const allRzs = Array.from(doc.querySelectorAll(".ztransplit-split-resizer"));
  const siblingsOf = (el) => {
    const hb = el.parentNode;
    if (!hb) return null;
    const bs = Array.from(hb.children).filter((c) => c.localName === "browser");
    return bs.length === 2
      ? { left: R(bs[0]).w, right: R(bs[1]).w, leftX: R(bs[0]).x }
      : { browsers: bs.length };
  };
  const x = opts.x == null ? Math.round(hbox.x + hbox.w / 2) : Number(opts.x);
  const y = Math.round(hbox.y + hbox.h / 2);
  const fire = (type, el, clientX, buttons) =>
    el.dispatchEvent(
      new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win,
        button: 0,
        buttons,
        clientX,
        clientY: y,
        screenX: clientX,
        screenY: y,
      }),
    );
  fire("mousedown", resizer, x, 1);
  fire("mousemove", win, x, 1);
  await Zotero.Promise.delay(60);
  fire("mouseup", win, x, 0);
  await Zotero.Promise.delay(200);
  const dpr = win.devicePixelRatio || 1;
  return {
    target: x,
    hbox,
    resizer: R(resizer),
    leftW: R(browsers[0]).w,
    rightW: R(browsers[1]).w,
    leftGrow: browsers[0].style.flexGrow,
    rightGrow: browsers[1].style.flexGrow,
    allResizers: allRzs.map((el) => ({
      x: R(el).x,
      sameAsQueried: el.isSameNode(resizer),
      siblings: siblingsOf(el),
    })),
    screen: {
      originX: win.mozInnerScreenX,
      originY: win.mozInnerScreenY,
      dpr,
      toScreen: (cx) => Math.round(win.mozInnerScreenX + cx * dpr),
      toScreenY: Math.round(win.mozInnerScreenY + y * dpr),
    },
  };
};

/**
 * dividerRecord — record what the chrome window actually receives while a REAL
 * mouse drags the divider. Registers window-level mousemove/mouseup/mousedown
 * recorders, then waits `ms` while the caller drives the physical mouse, and
 * returns the event log plus the pane geometry at each event.
 *   arg: { ms }
 */
PROBE_CMDS.dividerRecord = async function (arg) {
  const opts = parseArg(arg);
  const ms = Number(opts.ms) || 12000;
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const resizer = visibleResizer(doc);
  if (!resizer) return { error: "no .ztransplit-split-resizer" };
  const mainHbox = resizer.parentNode;
  const browsers = Array.from(mainHbox.children).filter(
    (c) => c.localName === "browser",
  );
  const leftB = browsers[0];
  const rightB = browsers[1];
  const R = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
    };
  };
  const hbox = R(mainHbox);
  const log = [];
  const rec = (type) => (e) => {
    log.push({
      type,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
      captured,
      buttons: e.buttons,
      target: String(e.target?.localName || e.target?.nodeName),
      leftW: R(leftB).w,
      resizerX: R(resizer).x,
      rightW: R(rightB).w,
      leftGrow: leftB.style.flexGrow,
      rightGrow: rightB.style.flexGrow,
      cls: String(resizer.className),
      sameNode: !!(e.target && e.target.isSameNode && e.target.isSameNode(resizer)),
      at: Date.now(),
    });
  };
  // 真实 mousedown 落在分隔条上时，立刻对其设置指针捕获，然后观察后续
  // 事件的目标与坐标是否都回归 chrome 文档——这决定修复方案能否只靠捕获。
  let captured = false;
  const tryCapture = (e) => {
    if (captured) return;
    if (e.type !== "mousedown") return;
    if (!e.target || !e.target.isSameNode || !e.target.isSameNode(resizer)) return;
    try {
      resizer.setPointerCapture(e.pointerId ?? 1);
      captured = resizer.hasPointerCapture?.(e.pointerId ?? 1) ?? false;
    } catch (err) {
      captured = false;
    }
  };
  const onMove = rec("mousemove");
  const onDown = rec("mousedown");
  const onUp = rec("mouseup");
  // 只挂 win：插件的拖拽处理函数就监听在 state.win 上，挂多了会把
  // 只到达 browser 元素的事件也记下来，混淆「插件到底看到没看到」。
  // 同时挂 capture 与 bubble 两种：插件自己的处理函数是 bubble 阶段，
  // 若只有 capture 收到事件，就说明真实拖拽的事件根本没走完冒泡。
  const onMoveB = rec("mousemove(bubble)");
  const onDownB = rec("mousedown(bubble)");
  const onUpB = rec("mouseup(bubble)");
  win.addEventListener("mousedown", tryCapture, true);
  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("mousedown", onDown, true);
  win.addEventListener("mouseup", onUp, true);
  win.addEventListener("mousemove", onMoveB, false);
  win.addEventListener("mousedown", onDownB, false);
  win.addEventListener("mouseup", onUpB, false);
  const start = {
    window: {
      w: win.innerWidth,
      h: win.innerHeight,
      dpr: win.devicePixelRatio,
      screenX: win.mozInnerScreenX,
      screenY: win.mozInnerScreenY,
    },
    hbox,
    resizerX: R(resizer).x,
    leftW: R(leftB).w,
    rightW: R(rightB).w,
    resizerCount: doc.querySelectorAll(".ztransplit-split-resizer").length,
    allResizers: Array.from(doc.querySelectorAll(".ztransplit-split-resizer")).map((el) => ({
      x: R(el).x,
      parent: el.parentNode ? el.parentNode.localName : null,
      inDoc: doc.contains(el),
      sameAsQueried: el.isSameNode(resizer),
    })),
  };
  // Self-test: a synthetic event must be caught by the very same listeners, so
  // a zero-event log can only mean the real pointer never reached chrome.
  {
    let caught = 0;
    const selfRec = () => {
      caught++;
    };
    win.addEventListener("mousemove", selfRec, true);
    win.dispatchEvent(
      new win.MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        view: win,
        buttons: 1,
        clientX: Math.round(hbox.x + hbox.w / 2),
        clientY: Math.round(hbox.y + hbox.h / 2),
      }),
    );
    win.removeEventListener("mousemove", selfRec, true);
    start.selfTestCaught = caught;
  }
  await Zotero.Promise.delay(ms);
  win.removeEventListener("mousemove", onMove, true);
  win.removeEventListener("mousedown", onDown, true);
  win.removeEventListener("mouseup", onUp, true);
  win.removeEventListener("mousemove", onMoveB, false);
  win.removeEventListener("mousedown", onDownB, false);
  win.removeEventListener("mouseup", onUpB, false);
  return { start, eventCount: log.length, log, captured, end: { leftW: R(leftB).w, resizerX: R(resizer).x, rightW: R(rightB).w } };
};

/**
 * dividerZoom — watch both panes' zoom while the divider is dragged, to see
 * whether the sync engine's zoom mirroring fires and re-scales a pane (which
 * would look to the user like the panel "jumping").
 *   arg: { step, dwell }
 */
PROBE_CMDS.dividerZoom = async function (arg) {
  const opts = parseArg(arg);
  const step = Number(opts.step) || 40;
  const dwell = Number(opts.dwell) || 60;
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const resizer = visibleResizer(doc);
  if (!resizer) return { error: "no .ztransplit-split-resizer" };
  const mainHbox = resizer.parentNode;
  const browsers = Array.from(mainHbox.children).filter(
    (c) => c.localName === "browser",
  );
  const readers = browsers.map((b) =>
    (Zotero.Reader._readers || []).find((r) => r._iframe === b),
  );
  const zoomOf = (i) => {
    try {
      const w =
        readers[i]?._internalReader?._primaryView?._iframeWindow
          ?.wrappedJSObject ??
        readers[i]?._internalReader?._primaryView?._iframeWindow;
      const v = w?.PDFViewerApplication?.pdfViewer;
      return {
        mode: v?.currentScaleValue ?? null,
        scale: v?.currentScale ?? null,
      };
    } catch (e) {
      return { mode: null, scale: null, err: String(e) };
    }
  };
  const R = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), w: +r.width.toFixed(1) };
  };
  const hbox = R(mainHbox);
  const y = Math.round(
    mainHbox.getBoundingClientRect().y +
      mainHbox.getBoundingClientRect().height / 2,
  );
  const fire = (type, el, clientX, buttons) =>
    el.dispatchEvent(
      new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win,
        button: 0,
        buttons,
        clientX,
        clientY: y,
        screenX: clientX,
        screenY: y,
      }),
    );
  const snap = (label) => ({
    label,
    leftW: R(browsers[0]).w,
    rightW: R(browsers[1]).w,
    leftZoom: zoomOf(0),
    rightZoom: zoomOf(1),
  });

  const out = { before: snap("before") };
  const xs = [];
  for (let x = Math.round(hbox.x + hbox.w * 0.2); x <= hbox.x + hbox.w * 0.8; x += step) {
    xs.push(x);
  }
  fire("mousedown", resizer, xs[0], 1);
  out.during = [];
  for (const x of xs) {
    fire("mousemove", win, x, 1);
    await Zotero.Promise.delay(dwell);
    out.during.push(snap("during@" + x));
  }
  fire("mouseup", win, xs[xs.length - 1], 0);
  out.afterDrag = snap("afterDrag");
  await Zotero.Promise.delay(400);
  out.after400 = snap("after400ms");
  await Zotero.Promise.delay(1600);
  out.after2000 = snap("after2000ms");
  return out;
};

/**
 * hitTest — what does Gecko's own hit-testing say is under a set of client
 * points? Real mouse input is delivered to whatever this returns, so a
 * divider that is covered by another element explains a drag that never
 * starts. Also reports pointer-events and stacking context of each hit.
 *   arg: { points: [[x,y],...] }
 */
PROBE_CMDS.hitTest = async function (arg) {
  const opts = parseArg(arg);
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const resizer = visibleResizer(doc);
  if (!resizer) return { error: "no .ztransplit-split-resizer" };
  const mainHbox = resizer.parentNode;
  const browsers = Array.from(mainHbox.children).filter(
    (c) => c.localName === "browser",
  );
  const R = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const hbox = R(mainHbox);
  const res = R(resizer);
  const y = Math.round(res.y + res.h / 2);
  const describe = (el) => {
    if (!el) return null;
    const cs = win.getComputedStyle(el);
    return {
      tag: el.localName,
      id: el.id || null,
      cls: String(el.className || "").slice(0, 80),
      rect: R(el),
      pointerEvents: cs.pointerEvents,
      position: cs.position,
      zIndex: cs.zIndex,
      visibility: cs.visibility,
      opacity: cs.opacity,
      isResizer: el === resizer,
      isBrowser: browsers.includes(el),
    };
  };
  const pts = opts.points || [
    [Math.round(res.x + 2), y],
    [Math.round(res.x), y],
    [Math.round(hbox.x + 10), y],
    [Math.round(hbox.x + hbox.w - 10), y],
    [Math.round(hbox.x + hbox.w / 2), y],
  ];
  return {
    hbox,
    resizer: res,
    resizerStyle: resizer.getAttribute("style"),
    resizerClass: String(resizer.className),
    points: pts.map(([x, yy]) => {
      let hit = null;
      let err = null;
      try {
        hit = doc.elementFromPoint(x, yy);
      } catch (e) {
        err = String(e);
      }
      return { x, y: yy, hit: describe(hit), err };
    }),
    // What covers the resizer's own box?
    resizerStack: (() => {
      const out = [];
      const cx = Math.round(res.x + res.w / 2);
      const cy = Math.round(res.y + res.h / 2);
      let el = doc.elementFromPoint(cx, cy);
      let guard = 0;
      while (el && guard++ < 12) {
        out.push(describe(el));
        el = el.parentElement;
      }
      return out;
    })(),
  };
};

/**
 * paneItems — what the split view actually shows.
 *
 * The split tab's title is "{left title} | {right title}" (see
 * splitview-tab-title in the FTL), so it names both panes directly. That is
 * the definitive check for "one split per item, right pane = latest
 * translation": a repro item holding an original plus two translations of
 * different ages must show the original on the left and the NEWER
 * translation on the right, and only ONE reader tab must exist.
 */
PROBE_CMDS.paneItems = async function () {
  const { Zotero_Tabs } = probeWin();
  const doc = Zotero.getMainWindow().document;
  const tabs = (Zotero_Tabs._tabs || []).map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title,
  }));
  return {
    resizerCount: doc.querySelectorAll(".ztransplit-split-resizer").length,
    readerTabs: tabs.filter((t) => t.type === "reader").length,
    tabs,
  };
};

/**
 * splitTriple — the definitive repro: one item holding an original and TWO
 * translations of different ages. The split entry must open ONE reader tab
 * whose title reads "Original | Translated (zh-CN) NEW".
 */
PROBE_CMDS.splitTriple = async function () {
  const dataDir = Zotero.DataDirectory.dir;
  const FIXDIR = PathUtils.join("D:", "github_code", "z-transplit", "scripts", "qa", "fixtures");
  const step = async (label, fn) => {
    try {
      return { label, ok: true, value: await fn() };
    } catch (e) {
      return { label, ok: false, error: String(e) };
    }
  };
  const copies = [];
  for (const [n, src] of [
    ["triple-a.pdf", PathUtils.join(FIXDIR, "attention-reading.pdf")],
    ["triple-b.pdf", PathUtils.join(FIXDIR, "reading-brain.pdf")],
  ]) {
    const dest = PathUtils.join(dataDir, n);
    copies.push(await step("copy " + n, async () => {
      await IOUtils.copy(src, dest);
      return dest;
    }));
  }
  const item = new Zotero.Item("journalArticle");
  item.setField("title", "QA triple pair");
  const itemID = await item.saveTx();
  const specs = [
    ["Original", "triple-a.pdf"],
    ["Translated (zh-CN) OLD", "triple-b.pdf"],
    ["Translated (zh-CN) NEW", "triple-a.pdf"],
  ];
  const made = [];
  for (const [title, file] of specs) {
    made.push(await step("import " + title, async () => {
      const a = await Zotero.Attachments.importFromFile({
        file: PathUtils.join(dataDir, file), parentItemID: itemID, title,
      });
      return a.id;
    }));
  }
  const { ZoteroPane } = probeWin();
  ZoteroPane.selectItem(itemID);
  await Zotero.Promise.delay(600);
  const entry = Zotero.getMainWindow().document.getElementById("ztransplit-itemmenu-split");
  if (!entry) return { error: "no ztransplit-itemmenu-split", copies, made };
  entry.doCommand();
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 45000) {
    await Zotero.Promise.delay(500);
    if (Zotero.getMainWindow().document.querySelector(".ztransplit-split-resizer")) { ok = true; break; }
  }
  await Zotero.Promise.delay(3000);
  const tabs = (probeWin().Zotero_Tabs._tabs || []).map((t) => ({ id: t.id, type: t.type, title: t.title }));
  return {
    copies,
    made,
    resizerAppeared: ok,
    readerTabs: tabs.filter((t) => t.type === "reader").length,
    readerTabTitles: tabs.filter((t) => t.type === "reader").map((t) => t.title),
    siblings: (Zotero.Items.get(itemID).getAttachments() || []).map((id) => {
      const it = Zotero.Items.get(id);
      return {
        id,
        title: typeof it?.getField === "function" ? it.getField("title") : null,
        dateAdded: it?.dateAdded ?? null,
      };
    }),
  };
};

// ── driver: poll command.json ───────────────────────────────────────────────
var probeTimer = null;
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
