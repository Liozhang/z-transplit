/**
 * probe-extra.js — 真机探针补充命令。
 *
 * 由 scripts/qa/real-machine.mjs 的 bootstrap 补丁在 probe.js 之后、
 * startProbe() 之前，以同一个 scope 对象加载——因此本文件直接往既有的
 * PROBE_CMDS 上挂命令即可被同一个轮询分发器（probePoll）看到，无需改动
 * probe.js 本体。
 *
 * 为什么单独一个文件：probe.js 服务的是「既有轮次已定稿」的探针契约，新增
 * 命令单独放，diff 归属清楚。目前挂了三组命令：
 *
 *   biSelect {side, index, via}  在指定侧（original|trans）的第 index 个
 *                                块里造选区并派发 mouseup（插件的监听挂在
 *                                SDT 文档上，见 interleaveView 的
 *                                onDocMouseUp），via:"key" 改派 keyup
 *   biState {}                   只读当前 data-linked 分布与模式类
 *                                （切模式、退出会话之后复查用）
 *   defaults {}                  读设置面板七个常驻复选框的勾选状态与对应
 *                                偏好的「值 + 是否用户显式设过」——新装
 *                                profile 下 hasUserValue 全为 false，读到
 *                                的就是出厂默认本身
 *   popups {}                    枚举当前仍打开的 Zotero 进度弹窗（标题 +
 *                                行文本）。用于验证「事情做完后弹窗自己
 *                                消失」这类回归：跑完流水线/双语会话后轮
 *                                询它，窗口数应为 0
 *   iconcheck {}                 库条目右键菜单图标验证：确保选区含 PDF
 *                                附件（库里没有就从 fixture 导入一个）、
 *                                派发 popupshowing 触发插件的图标断言，
 *                                逐条目报告类名 / CSS 变量 / 图标槽位的
 *                                计算样式（shadowRoot 可达时），再把菜单
 *   iconopen {x,y}               选区含 PDF 后把右键菜单真正弹开并保持
 *                                （供启动器侧做系统级屏幕截取——drawWindow
 *                                画不进独立的弹出窗口）。返回各条目的类名
 *                                与 CSS 变量状态
 *   iconclose {}                 收起 iconopen 弹开的菜单
 *                                行文本）。用于验证「事情做完后弹窗自己
 *                                消失」这类回归：跑完流水线/双语会话后轮
 *                                询它，窗口数应为 0
 */
(function () {
  /**
   * 参数归一：启动器把 argv[4] 当原始字符串传进来（real-machine.mjs 的 send
   * 直接 JSON.stringify 整个 arg），处理函数收到的是字符串而非对象——必须
   * 在这里解析，与 probe.js 的 parseArg 同一惯例。
   */
  function parseOpts(arg) {
    if (arg && typeof arg === "object") return arg;
    if (typeof arg !== "string" || !arg.trim()) return {};
    try {
      const v = JSON.parse(arg);
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * SDT 阅读模式 iframe 的文档与窗口。访问路径与 sdtBridge.ts 一致：
   * reader → _internalReader（运行时 expando，走 wrappedJSObject）→
   * _primarySDTView → _iframe → contentDocument。多候选路径逐个试，
   * 命中 #sdt-content 才算数。
   */
  function sdtDoc() {
    const win = Zotero.getMainWindow();
    const tabID = win.Zotero_Tabs.selectedID;
    const reader = Zotero.Reader.getByTabID(tabID);
    const candidates = [];
    const push = (o) => {
      if (o && !candidates.includes(o)) candidates.push(o);
    };
    push(reader?._internalReader);
    push(reader?.wrappedJSObject?._internalReader);
    push(reader);
    for (const internal of candidates) {
      const raw = internal?.wrappedJSObject ?? internal;
      const view = raw?._primarySDTView;
      const rawView = view?.wrappedJSObject ?? view;
      const iframe = rawView?._iframe;
      const doc = iframe?.contentDocument;
      if (doc?.getElementById?.("sdt-content")) {
        return { doc, win: iframe.contentWindow };
      }
    }
    return { error: "no SDT view with #sdt-content — bilingual session running?" };
  }

  /** 取内容 realm 的原始对象（Xray 会隐藏 expando、干扰跨 realm 传参）。 */
  function rawOf(o) {
    return o?.wrappedJSObject ?? o;
  }

  /** 顶层原文块（排除注入的译文块与 sdt-reference 之外的容器节点）。 */
  function originalBlocks(doc) {
    const container = doc.getElementById("sdt-content");
    if (!container) return [];
    return Array.from(container.children).filter(
      (el) => el.dataset?.refPath && !el.classList.contains("ztransplit-bi"),
    );
  }

  function transBlocks(doc) {
    return Array.from(doc.querySelectorAll(".ztransplit-bi"));
  }

  /** 当前联动状态：每个 refPath 的原文块/译文块是否带 data-linked。 */
  function linkState(doc) {
    const container = doc.getElementById("sdt-content");
    const originals = originalBlocks(doc);
    const trans = transBlocks(doc);
    const refs = [];
    for (const el of [...originals, ...trans]) {
      const ref = el.dataset?.refPath;
      if (ref && !refs.includes(ref)) refs.push(ref);
    }
    return {
      modeClass: container
        ? Array.from(container.classList)
            .filter((c) => c.indexOf("bi-mode") >= 0)
            .join(" ")
        : null,
      blocks: refs.map((ref) => {
        const o = originals.find((el) => el.dataset.refPath === ref);
        const t = trans.find((el) => el.dataset.refPath === ref);
        return {
          ref,
          origChars: o ? (o.textContent || "").trim().length : null,
          transChars: t ? (t.textContent || "").trim().length : null,
          origLinked: !!o?.hasAttribute("data-linked"),
          transLinked: !!t?.hasAttribute("data-linked"),
        };
      }),
      linkedTotal: doc.querySelectorAll("[data-linked]").length,
    };
  }

  PROBE_CMDS.biState = async function () {
    const v = sdtDoc();
    if (v.error) return v;
    const state = linkState(v.doc);
    return {
      ...state,
      linkedBlocks: state.blocks.filter((b) => b.origLinked || b.transLinked),
    };
  };

  /**
   * 在指定侧的块内造选区并派发 mouseup（或 keyup），返回联动后的双侧状态。
   * arg: { side: "original"|"trans", index: 0, via: "mouse"|"key" }
   */
  PROBE_CMDS.biSelect = async function (arg) {
    const opts = parseOpts(arg);
    const v = sdtDoc();
    if (v.error) return v;
    const rawDoc = rawOf(v.doc);
    const rawWin = rawOf(v.win);
    const side = /trans|译/i.test(opts.side || "") ? "trans" : "original";
    const blocks =
      side === "trans" ? transBlocks(rawDoc) : originalBlocks(rawDoc);
    if (!blocks.length) {
      return { error: "no " + side + " blocks in SDT view", side };
    }
    const idx = Math.max(0, Number(opts.index) || 0);
    const el = blocks[Math.min(idx, blocks.length - 1)];
    const ref = el.dataset?.refPath;

    let selectionOk = false;
    let selectionErr = null;
    let eventErr = null;
    try {
      const sel = rawWin.getSelection();
      const range = rawDoc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      selectionOk = sel.rangeCount > 0 && !sel.isCollapsed;
      const type = /key/i.test(opts.via || "") ? "keyup" : "mouseup";
      rawDoc.dispatchEvent(new rawWin.MouseEvent(type, { bubbles: true }));
    } catch (e) {
      if (!selectionOk) selectionErr = String(e);
      else eventErr = String(e);
    }
    // 插件在事件里同步打属性，稍等一拍再读状态（渲染/异步钩子余量）。
    await Zotero.Promise.delay(400);

    const state = linkState(rawDoc);
    const picked = state.blocks.find((b) => b.ref === ref) || null;
    return {
      side,
      index: blocks.indexOf(el),
      ref,
      chars: (el.textContent || "").trim().length,
      selectionOk,
      selectionErr,
      eventErr,
      picked,
      linkedBlocks: state.blocks.filter((b) => b.origLinked || b.transLinked),
      linkedTotal: state.linkedTotal,
      modeClass: state.modeClass,
      blockCount: state.blocks.length,
    };
  };

  /**
   * 设置面板七个常驻复选框 + 对应偏好的实际值。
   *
   * 「勾选状态」读 DOM，「值」读 Zotero.Prefs（true 分支 = 只读 default
   * 分支），「hasUserValue」区分「出厂默认」与「用户显式设过」。新装 profile
   * 下应当全部 hasUserValue=false、value=true——那才是出厂默认的证据，
   * 而不是某条历史遗留。
   *
   * deepl 的「使用 DeepL 免费接口」按引擎条件显隐，只在引擎为 DeepL 时可见，
   * 单独列出来不参与七项断言。
   */
  PROBE_CMDS.defaults = async function () {
    let win = null;
    try {
      Zotero.Utilities.Internal.openPreferences("zotero-prefpane-ztransplit");
      for (let i = 0; i < 40 && !win; i++) {
        await Zotero.Promise.delay(300);
        win = Services.wm.getMostRecentWindow("zotero:pref");
      }
    } catch (e) {
      return { error: "openPreferences: " + e };
    }
    if (!win) return { error: "no prefs window" };
    // 窗口对象一出现不等于面板已注入：首次打开设置窗口时，Zotero 要逐个加载
    // 插件面板（取 XHTML、解析、跑脚本），这之间 getElementById 会扑空。
    // 轮询面板本体，拿到才算就绪（实测：不轮询时首条命令必踩这个时序）。
    let doc = null;
    for (let i = 0; i < 50; i++) {
      const d = win.document;
      if (d && d.getElementById("zotero-prefpane-ztransplit")) {
        doc = d;
        break;
      }
      await Zotero.Promise.delay(300);
    }
    if (!doc) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
      return { error: "pane missing" };
    }

    const boxes = {
      enabled: "ztransplit-pref-enabled",
      auto: "ztransplit-pref-auto",
      wordcards: "ztransplit-pref-wordcards-enabled",
      odlEnabled: "ztransplit-pref-odl-enabled",
      structTree: "ztransplit-pref-odl-structtree",
      images: "ztransplit-pref-odl-images",
      removal: "ztransplit-pref-removal-enabled",
      deeplFree: "ztransplit-pref-deepl-free",
    };
    const keys = {
      enabled: "translate.enabled",
      auto: "translate.auto",
      wordcards: "wordcards.enabled",
      odlEnabled: "pdfParser.opendataloader.enabled",
      structTree: "pdfParser.opendataloader.useStructTree",
      images: "pdfParser.opendataloader.returnImages",
      removal: "pdfParser.originalTextRemoval.enabled",
      deeplFree: "translate.deepl.useFree",
    };

    const out = { checkboxes: {}, prefs: {} };
    for (const [k, id] of Object.entries(boxes)) {
      const el = doc.getElementById(id);
      out.checkboxes[k] = el
        ? { checked: !!el.checked, hidden: !!el.hidden }
        : "missing";
    }
    for (const [k, key] of Object.entries(keys)) {
      const full = "extensions.zotero.ztransplit." + key;
      out.prefs[k] = {
        value: Zotero.Prefs.get(full, true),
        hasUserValue: Zotero.Prefs.prefHasUserValue
          ? Zotero.Prefs.prefHasUserValue(full, true)
          : null,
      };
    }
    try {
      win.close();
    } catch {
      /* ignore */
    }
    return out;
  };

  /**
   * 枚举当前仍打开的 Zotero 进度弹窗（chrome://zotero/content/
   * progressWindow.xhtml），返回标题与每一行的文本。
   *
   * Zotero 的 ProgressWindow 是独立小窗而不是主窗口里的一个节点，所以只能
   * 通过窗口枚举找；startCloseTimer 的剩余时间读不到（闭包内私有），但
   * 「窗口还在不在」本身就是判据：终态计时器到点后窗口必须归零。
   */
  PROBE_CMDS.popups = async function () {
    const out = { scanned: 0, windows: [] };
    let enum_;
    try {
      enum_ = Services.wm.getEnumerator(null);
    } catch (e) {
      return { error: "enumerate: " + e };
    }
    while (enum_.hasMoreElements()) {
      const w = enum_.getNext();
      out.scanned++;
      const href = String(w.location?.href || "");
      if (!/progressWindow/.test(href)) continue;
      try {
        const d = w.document;
        const box = d.getElementById("zotero-progress-text-box");
        out.windows.push({
          href,
          headline:
            d.getElementById("zotero-progress-text-headline")?.textContent?.trim() ||
            null,
          rows: box
            ? Array.from(box.children).map((n) =>
                (n.textContent || "").trim(),
              )
            : [],
        });
      } catch (e) {
        out.windows.push({ href, error: String(e) });
      }
    }
    return out;
  };
  /**
   * 点火后即返回：走真实的文献库右键菜单跑翻译流水线，不等待结果。
   *
   * 为什么不用 probe.js 的 pipeline / pipelineViaMenu：pipeline 依赖从 bundle
   * 作用域里取 translateAndSplitWithOpenDataLoader，而现行 IIFE 产物不把它
   * 暴露到 loadSubScript 的 scope（预置缺陷，与本次改动无关）；pipelineViaMenu
   * 则会占住轮询分发器直到译文附件出现，期间无法再发 popups 采样。这里把
   * doCommand() 的点火与等待拆开——菜单 handler 本身是异步的，点完立刻返回，
   * 之后每几秒采一次 popups，就能看到进度弹窗的整段生命周期（下载进度行 →
   * 批量进度行 → 终态行 → 窗口归零）。
   */
  PROBE_CMDS.pipelineStart = async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const dataDir = Zotero.DataDirectory.dir;
    const pdfPath = PathUtils.join(dataDir, "qa-sample.pdf");
    if (!(await IOUtils.exists(pdfPath))) return { skipped: "no PDF" };
    const { ZoteroPane, Zotero_Tabs } = probeWin();

    let item = new Zotero.Item("journalArticle");
    item.setField("title", "QA pipeline paper " + Date.now());
    const itemID = await item.saveTx();
    const att = await Zotero.Attachments.importFromFile({
      file: pdfPath,
      parentItemID: itemID,
      title: "QA pipeline PDF",
    });

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
    const target = doc.getElementById("ztransplit-itemmenu-attachment");
    if (!target) return { error: "menu item missing" };
    const t0 = Date.now();
    target.doCommand(); // 异步 handler：立刻返回，流水线在后台跑
    return {
      startedAt: t0,
      attachmentID: att.id,
      parentItemID: itemID,
      selection: ZoteroPane.itemsView.getSelectedItems().map((i) => i.id),
    };
  };

  /**
   * 是否已经出现译文附件（标题匹配译文命名）。与 pipelineStart 配套使用：
   * 点火后轮询它判断流水线是否真的跑完，而不是只看弹窗消失。
   */
  PROBE_CMDS.translated = async function () {
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
        out.push({ id, title: x.getField("title"), parent: x.parentItemID });
      }
    }
    return { count: out.length, items: out };
  };

  /**
   * 库条目右键菜单图标验证（见文件头注释）。三步：
   *   1) 选区含 PDF：遍历库找第一个 PDF 附件；没有就复制 fixture 到数据
   *      目录并作为附件导入（幂等：有就不建）。
   *   2) 派发 popupshowing：插件的可见性门控与图标断言（setMenuIcon）都在
   *      这个事件里跑，跑完读每个条目的类名与 CSS 变量——这正是
   *      Zotero MenuManager 的图标注入机制所依赖的两样东西。
   *   3) 真开菜单截屏：图标槽位（.menu-icon）是匿名/shadow 内容，shadowRoot
   *      可达时顺带读计算样式的 content / list-style-image；不可达时靠
   *      截屏做视觉判定。
   */
  PROBE_CMDS.iconcheck = async function (arg) {
    const opts = parseOpts(arg);
    const win = Zotero.getMainWindow();
    if (!win) return { error: "no main window" };
    const doc = win.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) return { error: "zotero-itemmenu missing" };

    // 1) 选区含 PDF
    const search = new Zotero.Search();
    search.libraryID = 1;
    const ids = await search.search();
    let pdf = null;
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (it.isAttachment() && it.attachmentContentType === "application/pdf") {
        pdf = it;
        break;
      }
    }
    let created = null;
    if (!pdf) {
      const FIX = "D:\\github_code\\z-transplit\\scripts\\qa\\fixtures\\attention-reading.pdf";
      if (!await IOUtils.exists(FIX)) return { error: "fixture missing: " + FIX };
      const parent = new Zotero.Item("journalArticle");
      await parent.setField("title", "Icon Check Parent");
      await parent.saveTx();
      const att = await Zotero.Attachments.importFromFile({
        file: FIX,
        parentItemID: parent.id,
      });
      pdf = att;
      created = { parent: parent.id, attachment: att.id };
    }
    try {
      await win.ZoteroPane.itemsView.selectItem(pdf.id);
    } catch (e) {
      return { error: "selectItem: " + e, created };
    }

    // 2) 触发插件断言，读回条目状态
    popup.dispatchEvent(new win.Event("popupshowing"));
    await Zotero.Promise.delay(100);
    const IDS = [
      "ztransplit-itemmenu-attachment",
      "ztransplit-itemmenu-pages",
      "ztransplit-itemmenu-split",
      "ztransplit-itemmenu-interleave",
      "ztransplit-itemmenu-trans-only",
    ];
    const entries = IDS.map((id) => {
      const mi = doc.getElementById(id);
      if (!mi) return { id, missing: true };
      const cs = win.getComputedStyle(mi);
      const slot = mi.shadowRoot
        ? mi.shadowRoot.querySelector(".menu-icon")
        : null;
      const slotCs = slot ? win.getComputedStyle(slot) : null;
      return {
        id,
        label: mi.getAttribute("label"),
        hidden: mi.getAttribute("hidden"),
        checked: mi.getAttribute("checked"),
        iconic: mi.classList.contains("menuitem-iconic"),
        custom: mi.classList.contains("zotero-custom-menu-item"),
        varLight: mi.style.getPropertyValue("--custom-menu-icon-light") || null,
        varLightComputed: cs.getPropertyValue("--custom-menu-icon-light") || null,
        slotFound: !!slot,
        slotContent: slotCs ? slotCs.content : null,
        slotImage: slotCs ? slotCs.listStyleImage : null,
      };
    });
    const menu = doc.getElementById("ztransplit-itemmenu");
    const submenuHidden = menu ? menu.getAttribute("hidden") : null;

    // 3) 真开菜单截屏（菜单关着时匿名图标槽可能根本不渲染）
    const file = opts.file || "D:\\zt-qa\\icon-menu.png";
    let shot = null;
    try {
      popup.openPopupAtScreen(300, 200, true);
      await Zotero.Promise.delay(700);
      const s = await PROBE_CMDS.shot({ file });
      shot = s;
      popup.hidePopup();
    } catch (e) {
      shot = { ok: false, error: String(e) };
    }
    return { created, selection: { id: pdf.id, title: pdf.getField("title") }, submenuHidden, entries, shot };
  };

  /** 找库里的第一个 PDF 附件；没有就从 fixture 导入（iconcheck/iconopen 共用）。 */
  async function ensurePdfSelected(win) {
    const search = new Zotero.Search();
    search.libraryID = 1;
    const ids = await search.search();
    let pdf = null;
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (it.isAttachment() && it.attachmentContentType === "application/pdf") {
        pdf = it;
        break;
      }
    }
    if (!pdf) {
      const FIX = "D:\\github_code\\z-transplit\\scripts\\qa\\fixtures\\attention-reading.pdf";
      if (!await IOUtils.exists(FIX)) return { error: "fixture missing: " + FIX };
      const parent = new Zotero.Item("journalArticle");
      await parent.setField("title", "Icon Check Parent");
      await parent.saveTx();
      pdf = await Zotero.Attachments.importFromFile({
        file: FIX,
        parentItemID: parent.id,
      });
    }
    try {
      await win.ZoteroPane.itemsView.selectItem(pdf.id);
    } catch (e) {
      return { error: "selectItem: " + e };
    }
    return { pdf };
  }

  /**
   * 打开右键菜单的五个条目并保持（配合启动器侧的系统屏幕截取）。
   *
   * 为什么不直接开 zotero-itemmenu：它有 28 个原生条目，在 720p 屏上比屏幕
   * 还高，追加在最底下的子菜单永远在屏幕外，截不到。于是把五个条目临时
   * 挪进一个独立的空 menupopup（图标类与 CSS 变量随节点走，Zotero 的图标
   * 样式按类匹配、不按位置匹配，渲染机制不变），弹在屏幕指定位置；拍完后
   * iconclose 把节点挪回原子菜单。选区照常先备好一个 PDF 附件。
   */
  const ICONCHECK_POPUP_ID = "ztransplit-iconcheck-popup";
  const ICONCHECK_IDS = [
    "ztransplit-itemmenu-attachment",
    "ztransplit-itemmenu-pages",
    "ztransplit-itemmenu-split",
    "ztransplit-itemmenu-interleave",
    "ztransplit-itemmenu-trans-only",
  ];
  PROBE_CMDS.iconopen = async function (arg) {
    const opts = parseOpts(arg);
    const win = Zotero.getMainWindow();
    if (!win) return { error: "no main window" };
    const doc = win.document;
    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) return { error: "zotero-itemmenu missing" };
    const sel = await ensurePdfSelected(win);
    if (sel.error) return sel;
    const x = Number(opts.x ?? 300);
    const y = Number(opts.y ?? 150);
    popup.dispatchEvent(new win.Event("popupshowing"));
    await Zotero.Promise.delay(100);
    // arg: { active: [条目id后缀...] } —— 强制把这些条目的图标换成对勾，
    // 用于验证激活态图标在图标槽位的渲染。真实激活判断（splitOpen /
    // liveMode）需要真的跑流水线才能成立，这里只验渲染，不验状态逻辑。
    if (Array.isArray(opts.active)) {
      for (const id of opts.active) {
        const mi = doc.getElementById("ztransplit-itemmenu-" + id);
        if (mi) {
          mi.style.setProperty("--custom-menu-icon-light", "url(chrome://ztransplit/content/icons/menu-check.svg)");
          mi.style.setProperty("--custom-menu-icon-dark", "url(chrome://ztransplit/content/icons/menu-check.svg)");
        }
      }
    }
    let tmp = doc.getElementById(ICONCHECK_POPUP_ID);
    if (!tmp) {
      tmp = doc.createXULElement("menupopup");
      tmp.id = ICONCHECK_POPUP_ID;
      doc.documentElement.appendChild(tmp);
    }
    const moved = [];
    for (const id of ICONCHECK_IDS) {
      const mi = doc.getElementById(id);
      if (mi) {
        tmp.appendChild(mi); // 移动（appendChild 对已有节点等于搬家）
        moved.push(id);
      }
    }
    tmp.openPopupAtScreen(x, y, true);
    await Zotero.Promise.delay(500);
    const mi = doc.getElementById(ICONCHECK_IDS[0]);
    const rect = mi ? mi.getBoundingClientRect() : null;
    return {
      open: tmp.state,
      moved,
      selection: { id: sel.pdf.id, title: sel.pdf.getField("title") },
      itemRect: rect
        ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        : null,
      dpr: win.devicePixelRatio,
    };
  };

  /** 收起 iconopen 弹开的临时弹窗，并把五个条目挪回原右键子菜单。 */
  PROBE_CMDS.iconclose = async function () {
    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    const popup = doc && doc.getElementById("zotero-itemmenu");
    const tmp = doc && doc.getElementById(ICONCHECK_POPUP_ID);
    if (!tmp) return { restored: false, state: popup ? popup.state : null };
    tmp.hidePopup();
    const host = popup && popup.querySelector("#ztransplit-itemmenu menupopup");
    if (host) {
      for (const id of ICONCHECK_IDS) {
        const mi = tmp.querySelector("#" + id);
        if (mi) host.appendChild(mi);
      }
    }
    tmp.remove();
    return { restored: !!host, state: "closed" };
  };
})();
