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
 *   iconclose {}                 收起 iconopen 弹开的临时弹窗，并把五个条目挪回原右键子菜单
 *   kindGate {kind, path}        阅读器类型门控验证（readerKind.ts）：导入并
 *                                打开 pdf/snapshot/epub 附件，回报「翻译」区块
 *                                渲染与隐藏态、双语控制条、工具栏按钮、右键
 *                                子菜单在真实宿主里的呈现。fixture 缺省取
 *                                <QA_ROOT>\fixtures\qa-reader-kind.<ext>
 *                                （epub 由 scripts/qa/make_epub_fixture.py 生成）
 *   shotWindow {path}             进程内 drawWindow 截取主窗口存 PNG（启动器
 *                                侧 PrintWindow 对部分合成层不可靠时用）
 *                                行文本）。用于验证「事情做完后弹窗自己
 *                                消失」这类回归：跑完流水线/双语会话后轮
 *                                询它，窗口数应为 0
 *   openShot {id, path}            打开指定附件（译文 PDF）并截取主窗口：
 *                                选中 → viewAttachment → 等阅读器就绪 →
 *                                窗口提前台并加宽 → drawWindow 落盘。
 *                                回报的 items 里每个附件都带 filePath——评测
 *                                基准的真机抽查要拿这条路径取出译文 PDF
 *   pyStatus / envStatus           识别解释器与识别环境的安装状态查询
 *   sidecarInstall / sidecarRepair 识别环境的一键安装与重装。几百兆、会阻塞到
 *                                装完；这是整条扫描件链路里唯一没有自动化覆盖
 *                                的一步（pip 装 paddlepaddle、下模型权重、
 *                                跑 --selftest）
 */

/**
 * 参数归一：启动器把 argv[4] 当原始字符串传进来（real-machine.mjs 的 send
 * 直接 JSON.stringify 整个 arg），处理函数收到的是字符串而非对象——必须在
 * 这里解析，与 probe.js 的 parseArg 同一惯例。
 *
 * 放在文件作用域而不是某个立即执行函数里：本文件按组分成多个立即执行函数
 * （早先的 openShot 就因此取不到它，报 parseOpts is not defined），共用的
 * 归一函数必须让所有组都看得见。
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
(function () {
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
   * 页码范围流水线：走「翻译指定页」那个菜单项，只译给定的页。
   *
   * 为什么单开一条而不是给 pipelineStart 加参数：那条菜单项会弹一个原生输入框
   * 问范围（registerItemTreeMenu 的 promptDialog → Services.prompt.prompt）。
   * 探针把对话框真放出来，再用轮询器自动填值并点确定——菜单 handler、
   * parsePageRangeSpec、opts.pages 一路都是产品自己的代码，连提示框这一跳都是
   * 真的，不是探针代劳。
   *
   * 参数 { range: "2" }（也接受 "1-2"、"1,3" 这类 parsePageRangeSpec 认的写法）。
   * 返回结构与 pipelineStart 一致，另加 accepted 与 seenWindows：前者说明范围
   * 有没有真被送进流水线，后者是等待期间冒出过的窗口，排查"对话框没弹"时看它。
   */
  PROBE_CMDS.pipelineStartPages = async function (payload) {
    // 启动器传进来的是原始字符串，必须先过 parseOpts 才是对象。
    const opts = parseOpts(payload);
    const range = String(opts.range || "").trim();
    if (!range) return { error: "range required" };
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const dataDir = Zotero.DataDirectory.dir;
    const pdfPath = PathUtils.join(dataDir, "qa-sample.pdf");
    if (!(await IOUtils.exists(pdfPath))) return { skipped: "no PDF" };
    const { ZoteroPane, Zotero_Tabs } = probeWin();

    let item = new Zotero.Item("journalArticle");
    item.setField("title", "QA pages pipeline paper " + Date.now());
    const itemID = await item.saveTx();
    const att = await Zotero.Attachments.importFromFile({
      file: pdfPath,
      parentItemID: itemID,
      title: "QA pages pipeline PDF",
    });

    try {
      for (const id of Zotero_Tabs._tabs.slice()) {
        if (typeof id === "string" && id.startsWith("tab-")) Zotero_Tabs.close(id);
      }
      await Zotero.Promise.delay(500);
    } catch (e) {
      probeLog("close tabs: " + e);
    }
    ZoteroPane.selectItem(att.id);
    await Zotero.Promise.delay(600);

    const popup = doc.getElementById("zotero-itemmenu");
    popup.dispatchEvent(new win.Event("popupshowing"));
    const target = doc.getElementById("ztransplit-itemmenu-pages");
    if (!target) return { error: "pages menu item missing" };

    // 范围输入框不打断流程：让它真的弹出来（原生 nsIPromptService，产品自己
    // 的代码），再由一个轮询器自动填值并点确定。这样菜单 handler、
    // parsePageRangeSpec、opts.pages 一路都是产品自己的代码，连提示框这一跳
    // 都是真的，比把 Services.prompt.prompt 换成桩更接近真实用户操作。
    //
    // 为什么不能打桩了事：桩装在探针作用域的 Services 上，插件读到的却是另一份
    // （探针由 bootstrap 用 loadSubScript 载入，与插件同在 ctx 作用域链上，但
    // Services.prompt 是惰性 getter，两次读不一定同一个对象）。与其跟惰性 getter
    // 较劲，不如让原生对话框弹出来再点掉——顺带把"提示框到底弹不弹"这件事本身
    // 测了：产品侧那个 inout 参数传 null 的缺陷就是这样暴露出来的。
    //
    // 轮询器必须在模态对话框的事件循环里还能跑：setTimeout 在嵌套事件循环中
    // 照常触发，所以主线程卡在 promptDialog 里时也能把确定点上。
    const trace = [];
    let accepted = false;
    const watchStart = Date.now();
    const tick = () => {
      try {
        const en = Services.wm.getEnumerator(null);
        while (en.hasMoreElements()) {
          const w = en.getNext();
          const href = String(w.location?.href || "");
          if (w === win || !href) continue;
          if (!/commonDialog/.test(href)) continue;
          const d = w.document;
          const stamp = Date.now() - watchStart;
          if (accepted) continue;
          // 这个宿主上的提示框是 chrome://global/content/commonDialog.xhtml：
          // 根元素是 <window id="commonDialogWindow">，里面套一个 <dialog
          // id="commonDialog">，输入框是 HTML <input id="loginTextbox">。
          // acceptDialog/getButton 在里面的那个 <dialog> 上，不在 documentElement
          // 上——早先照着 documentElement 找，两个方法都是 undefined。
          const dlgEl = d.querySelector("dialog") || d.documentElement;
          const box = d.getElementById("loginTextbox");
          // 只认确定按钮：dlgtype="accept"，或 <dialog>.getButton("accept")。
          // 不要兜底"点第一个按钮"——按钮顺序不保证，点成取消就让整条路径静默失效。
          const acceptBtn =
            d.querySelector('[dlgtype="accept"]') ||
            (typeof dlgEl.getButton === "function" ? dlgEl.getButton("accept") : null);
          const entry = {
            at: stamp,
            root: d.documentElement && d.documentElement.tagName,
            hasAcceptDialogOnDialog:
              typeof (dlgEl && dlgEl.acceptDialog) === "function",
            textbox: box ? box.getAttribute("id") || box.tagName : null,
            acceptButton: acceptBtn
              ? [acceptBtn.tagName, acceptBtn.getAttribute && acceptBtn.getAttribute("id"),
                 acceptBtn.getAttribute && acceptBtn.getAttribute("label")]
              : null,
          };
          trace.push(entry);
          if (!box || !acceptBtn) continue;
          box.value = range;
          try {
            acceptBtn.click();
            entry.clicked = true;
            accepted = true;
          } catch (e) {
            entry.clicked = "失败: " + e;
          }
        }
      } catch (e) {
        trace.push({ at: Date.now() - watchStart, note: "autoanswer: " + e });
      }
      if (!accepted && Date.now() - watchStart < 45000) setTimeout(tick, 150);
    };
    setTimeout(tick, 150);

    const t0 = Date.now();
    try {
      target.doCommand(); // 异步 handler：立刻返回，流水线在后台跑
    } finally {
      // 等流水线起步（菜单 handler 点完确定才继续）再收摊。
      await Zotero.Promise.delay(12000);
    }
    return {
      startedAt: t0,
      attachmentID: att.id,
      parentItemID: itemID,
      range,
      accepted,
      trace,
      selection: ZoteroPane.itemsView.getSelectedItems().map((i) => i.id),
    };
  };

  /**
   * 是否已经出现译文附件（标题匹配译文命名）。与 pipelineStart 配套使用：
   * 点火后轮询它判断流水线是否真的跑完，而不是只看弹窗消失。
   *
   * 附带回报每个附件的磁盘路径：评测基准要把真机产出的译文 PDF 取出来做版
   * 面度量，没有路径就只能去数据目录里翻。路径是 Zotero 自己解析出来的，
   * 比在存储目录里按文件名猜可靠。
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
        let filePath = null;
        try {
          filePath = x.getFilePath() || null;
        } catch (e) {
          filePath = null;
        }
        out.push({
          id,
          title: x.getField("title"),
          parent: x.parentItemID,
          ...(filePath ? { filePath } : {}),
        });
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

  /**
   * shotWindow {path}  用 Zotero 自己的 drawWindow 把主窗口画进 canvas 并
   * 存成 PNG。PrintWindow（启动器侧）对某些 Gecko 合成层不可靠——实测阅读器
   * 画面能抓到、右侧上下文面板抓不到；进程内 drawWindow 画的是屏幕真实合成
   * 的结果。path 缺省 <QA_ROOT>\drawwindow-shot.png。
   */
  PROBE_CMDS.shotWindow = async function (arg) {
    const opts = parseOpts(arg);
    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    if (!doc) return { error: "no main window" };
    const out =
      opts.path || PathUtils.join("D:\\zt-qa", "drawwindow-shot.png");
    const w = win.innerWidth || 1440;
    const h = win.innerHeight || 900;
    const canvas = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // 白色底：drawWindow 的 backgroundColor 参数对透明区域生效。
    ctx.drawWindow(win, 0, 0, w, h, "white");
    const dataURL = canvas.toDataURL("image/png");
    const base64 = dataURL.slice(dataURL.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await IOUtils.write(out, bytes);
    const st = await IOUtils.stat(out);
    return { out, size: st.size, w, h };
  };

  /**
   * kindGate {kind, path}  阅读器类型门控真机验证（src/core/readerKind.ts）。
   *
   * 导入并打开指定类型的附件，回报插件四个读者入口在真实宿主里的呈现：
   *
   *   - 「翻译」区块（ztransplit-translate）：是否渲染、是否被 setEnabled
   *     置为 hidden、双语控制条（.ztransplit-bc-bar）是否存在
   *   - 阅读器工具栏双语按钮（.ztransplit-bc-toolbar，renderToolbar 追加）
   *   - 阅读器右键子菜单（createViewContextMenu 监听器真实跑一遍）
   *   - 阅读器实例自报的 type 与附件 contentType
   *
   * 期望矩阵：pdf → 区块可见且带双语条、工具栏按钮在、子菜单在；
   * snapshot → 区块可见但无双语条、工具栏按钮不在、子菜单不在；
   * epub → 区块不渲染（onItemChange 未启用）。fixture 路径缺省时按
   * <QA_ROOT>\fixtures 下的既定文件名取。
   */
  const KIND_FIXTURES = {
    pdf: "qa-reader-kind.pdf",
    snapshot: "qa-reader-kind.html",
    epub: "qa-reader-kind.epub",
  };
  const kindGateItems = {};

  PROBE_CMDS.kindGate = async function (arg) {
    const opts = parseOpts(arg);
    const kind = String(opts.kind || "");
    const fixture = KIND_FIXTURES[kind];
    if (!fixture) return { error: "kind must be pdf|snapshot|epub", got: kind };

    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    const ZoteroPane = win.ZoteroPane;
    const Zotero_Tabs = win.Zotero_Tabs;
    const file =
      opts.path || PathUtils.join("D:\\zt-qa", "fixtures", fixture);
    if (!(await IOUtils.exists(file))) {
      return { error: "fixture missing", file };
    }

    // 一个父条目 + 每类一个附件；同一会话内重复调用复用已导入的附件。
    if (!kindGateItems.parent) {
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", "QA reader-kind sample");
      kindGateItems.parent = await parent.saveTx();
    }
    if (!kindGateItems[kind]) {
      const att = await Zotero.Attachments.importFromFile({
        file,
        parentItemID: kindGateItems.parent,
        title: "QA reader-kind " + kind,
      });
      kindGateItems[kind] = att.id;
    }
    const attID = kindGateItems[kind];

    // 单选 + 打开：多选时 Zotero 显示"N items in this view"，item-details
    // 根本不渲染，自定义区块也就无从出现（与 probe.js#reader 同惯例）。
    ZoteroPane.selectItem(attID);
    await Zotero.Promise.delay(300);
    await ZoteroPane.viewAttachment(attID);

    // 等阅读器就绪（轮询 tab → reader），再留一段 settle 时间让工具栏与
    // 条目面板渲染完。
    let reader = null;
    for (let i = 0; i < 40; i++) {
      await Zotero.Promise.delay(250);
      reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
      if (reader && reader.itemID === attID) break;
    }
    await Zotero.Promise.delay(2000);

    // 提到前台：启动器侧做系统级屏幕截取时，QA 窗口可能被用户自己的窗口盖住。
    try {
      win.focus();
    } catch {
      /* headless / no window manager */
    }
    // 加宽窗口：QA profile 的默认窗宽窄，条目面板(翻译区块)会被挤出可见
    // 区域。PrintWindow 按窗口矩形捕获，超出屏幕的部分也能拍到。
    try {
      win.resizeTo(1440, 900);
      await Zotero.Promise.delay(600);
    } catch {
      /* resize refused */
    }
    await Zotero.Promise.delay(500);

    const tabID = Zotero_Tabs.selectedID;

    // 上下文面板在 QA profile 里默认折叠，而 item-details 的自定义区块要等
    // 面板展开、进入视口后才渲染（上游 itemDetails 的交叉观察器）。展开并
    // 轮询等待区块体出现（与 probe.js#openContextPane 同思路）。注意只能
    // 用一种方式展开：先置 collapsed=false 再去点切换按钮会把面板重新折上。
    const contextPane = doc.getElementById("zotero-context-pane");
    const zcp = win.ZoteroContextPane;
    let expandAction = "already-open";
    if (contextPane?.collapsed || zcp?.collapsed) {
      if (zcp) {
        zcp.collapsed = false;
        if (typeof zcp.update === "function") zcp.update();
        expandAction = "property";
      }
      await Zotero.Promise.delay(800);
      // 仍折叠（属性设置被忽略）才改用按钮点击——用户的方式。
      const stillCollapsed =
        doc.getElementById("zotero-context-pane")?.collapsed ||
        win.ZoteroContextPane?.collapsed;
      if (stillCollapsed) {
        const btn = doc.getElementById("zotero-tb-context-pane");
        if (btn) {
          btn.click();
          expandAction = "button";
        }
        await Zotero.Promise.delay(800);
      }
    }
    let paneRendered = false;
    for (let i = 0; i < 40; i++) {
      const details = doc.getElementById(tabID + "-context");
      if (details?.querySelector(".ztransplit-tp")) {
        paneRendered = true;
        break;
      }
      await Zotero.Promise.delay(250);
    }
    // 把「翻译」区块滚进可视区：上下文面板默认停在顶部 Info 区，区块在下方，
    // 截图与人工查看都看不见。附件预览等异步内容会在 settle 期间展开、把区块
    // 又挤出去，所以收集状态前再滚一次。
    const scrollToSection = () => {
      try {
        const details = doc.getElementById(tabID + "-context");
        const sectionEl = Array.from(
          details?.querySelectorAll("item-pane-custom-section") || [],
        ).find((c) => (c.dataset.pane || "").includes("transplit"));
        sectionEl?.scrollIntoView({ block: "start" });
      } catch {
        /* scroll refused */
      }
    };
    scrollToSection();
    await Zotero.Promise.delay(600);
    scrollToSection();
    await Zotero.Promise.delay(600);

    // 快照：驱动一次真实选区，验证「选区翻译」端到端可用。DOM 视图监听
    // iframe 文档的 selectionchange（上游 dom-view.tsx），选中后宿主走
    // onSetSelectionPopup → renderTextSelectionPopup 事件 → 插件的选区同步
    // 监听器把文本送进面板（PDF 走的是同一条监听器，只是文本层不同）。
    let selectionDrive = null;
    if (kind === "snapshot") {
      try {
        const pv = reader?._internalReader?._primaryView;
        const iw = pv?._iframeWindow;
        const idoc = pv?._iframeDocument ?? iw?.document;
        const para = idoc?.querySelector("p, h1, h2, li");
        const node = para?.firstChild;
        if (iw && idoc && node && node.textContent) {
          // 上游 dom-view 的 _tryUseTool 只在 _gotPointerUp 为真时才弹划词
          // 浮层（真实指针抬起后设置），程序化派发前先模拟这个状态。
          if (pv) pv._gotPointerUp = true;
          const range = idoc.createRange();
          const len = Math.min(60, node.textContent.length);
          range.setStart(node, 0);
          range.setEnd(node, len);
          const sel = iw.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          idoc.dispatchEvent(new iw.Event("selectionchange", { bubbles: true }));
          selectionDrive = {
            driven: true,
            chars: len,
            sample: node.textContent.slice(0, 50),
          };
        } else {
          selectionDrive = { driven: false, reason: "no text node in view" };
        }
      } catch (e) {
        selectionDrive = { driven: false, error: String(e) };
      }
      await Zotero.Promise.delay(2000);
      // 诊断：宿主是否算出了划词浮层（annotation.text 在这里），以及插件监听
      // 器是否登记在案——用于区分「宿主没处理选区」与「插件没收到事件」。
      try {
        const internal = reader?._internalReader?.wrappedJSObject ?? reader?._internalReader;
        const popup =
          internal?._state?.primaryViewSelectionPopup ??
          internal?._state?.secondaryViewSelectionPopup ??
          null;
        const listeners = Array.from(Zotero.Reader._registeredListeners || []);
        selectionDrive.hostPopup = popup
          ? {
              text: (popup.annotation?.text || "").slice(0, 80),
              hasRect: Array.isArray(popup.rect),
            }
          : null;
        selectionDrive.popupListeners = listeners.filter(
          (l) => l.type === "renderTextSelectionPopup",
        ).length;
        selectionDrive.paneTextNow = (
          doc
            .getElementById(tabID + "-context")
            ?.querySelector(".ztransplit-tp-source-text")?.textContent || ""
        ).slice(0, 120);
      } catch (e) {
        selectionDrive.diagError = String(e);
      }
    }

    reader = Zotero.Reader.getByTabID(tabID);
    const attachment = Zotero.Items.get(attID);

    // ── 「翻译」区块 ──
    // 阅读器标签页的条目面板不在标签页容器里，而在全局的 context-pane 中：
    // item-details#{tabID}-context（上游 elements/contextPane.js 的
    // _addItemContext 创建，deck 切换显示）。库标签页的面板则是
    // item-details#zotero-item-details。按当前标签页类型选对容器再查，
    // 否则会命中另一个标签页的区块。
    const contextDetails = doc.getElementById(tabID + "-context");
    const tabContainer = contextDetails || doc.getElementById(tabID) || doc;
    const scoped = Array.from(
      tabContainer.querySelectorAll("item-pane-custom-section"),
    ).filter((c) => (c.dataset.pane || "").includes("transplit"));
    const global = Array.from(
      doc.querySelectorAll("item-pane-custom-section"),
    ).filter((c) => (c.dataset.pane || "").includes("transplit"));
    const section = scoped[0] || null;
    const sectionInfo = section
      ? {
          found: true,
          hidden: section.hidden,
          bilingualBar: !!section.querySelector(".ztransplit-bc-bar"),
          bilingualToggle: !!section.querySelector(".ztransplit-bc-toggle"),
          paneRoot: !!section.querySelector(".ztransplit-tp"),
          textLength: (section.textContent || "").length,
          textSample: (section.textContent || "").slice(0, 200),
          buttons: Array.from(section.querySelectorAll("button"), (b) => [
            b.className,
            String(b.textContent || "").slice(0, 40),
          ]).slice(0, 12),
        }
      : { found: false };
    // 诊断：全局可见的同类区块数（库标签页的隐藏区块不计入判定）。
    const allSections = global.map((c) => ({
      inActiveTab: tabContainer.contains(c),
      hidden: c.hidden,
      bilingualBar: !!c.querySelector(".ztransplit-bc-bar"),
    }));

    // 诊断：每个区块的祖先链（标签名 + id/class），以及当前标签页容器的
    // 身份——用来确认 item-pane 到底挂在哪个容器里。
    const chain = (el) => {
      const out = [];
      let node = el;
      while (node && node !== doc.body) {
        out.push(
          node.tagName +
            (node.id ? "#" + node.id : "") +
            (node.className && typeof node.className === "string"
              ? "." + node.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
              : ""),
        );
        node = node.parentElement;
      }
      return out;
    };
    const sectionChains = global.map((c) => chain(c));
    const tabContainerInfo = {
      requested: tabID,
      resolved:
        tabContainer === doc
          ? "(document fallback)"
          : tabContainer.id || tabContainer.tagName,
      tag: tabContainer.tagName,
      hasItemPane: !!tabContainer.querySelector("item-pane"),
      libraryViews: Array.from(
        doc.querySelectorAll("library-view"),
        (v) => v.tabID ?? null,
      ),
    };

    // ── 阅读器工具栏双语按钮（renderToolbar 追加进阅读器 iframe 文档）──
    let toolbarButton = null;
    const readerDoc =
      reader?._iframeWindow?.document ??
      reader?._internalReader?._iframeWindow?.document ??
      null;
    if (readerDoc) {
      const btn = readerDoc.querySelector(".ztransplit-bc-toolbar");
      toolbarButton = btn
        ? { found: true, title: btn.getAttribute("title") }
        : { found: false };
    } else {
      toolbarButton = { found: false, reason: "reader document unreachable" };
    }

    // ── 阅读器右键子菜单：把 createViewContextMenu 监听器真实跑一遍 ──
    const registered = Array.from(Zotero.Reader._registeredListeners || []);
    const cv = registered.filter((x) => x.type === "createViewContextMenu");
    const appended = [];
    if (reader) {
      for (const entry of cv) {
        try {
          await entry.handler({ reader, append: (o) => appended.push(o) });
        } catch (e) {
          appended.push({ label: "LISTENER-ERROR", _err: String(e) });
        }
      }
    }
    const menuLabels = appended.flatMap((item) =>
      Array.isArray(item.groups) ? item.groups.flat().flat() : [item],
    ).map((m) => m.label);

    return {
      kind,
      attachmentID: attID,
      contentType: attachment?.attachmentContentType ?? null,
      readerOpen: !!reader,
      readerType: reader?.type ?? null,
      readerItemID: reader?.itemID ?? null,
      tabType: Zotero_Tabs.selectedType ?? null,
      tabID,
      paneRendered,
      contextPane: {
        collapsed: doc.getElementById("zotero-context-pane")?.collapsed ?? null,
        expandAction,
      },
      section: sectionInfo,
      sourceText: section
        ? (section.querySelector(".ztransplit-tp-source-text")?.textContent ||
            "").slice(0, 300)
        : null,
      selectionDrive,
      allSections,
      sectionChains,
      tabContainerInfo,
      paneGeometry: (() => {
        const cp = doc.getElementById("zotero-context-pane");
        const inner = doc.getElementById("zotero-context-pane-inner");
        const details = doc.getElementById(tabID + "-context");
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
          window: { w: win.innerWidth, h: win.innerHeight },
          contextPane: rect(cp),
          contextPaneInner: rect(inner),
          itemDetails: rect(details),
          itemDetailsVisible: details
            ? !!(details.offsetWidth || details.offsetHeight)
            : null,
        };
      })(),
      toolbarButton,
      menu: {
        listenerCount: cv.length,
        appended: appended.length,
        labels: menuLabels,
      },
    };
  };
})();

/**
 * pyStatus / envStatus — 识别解释器与识别环境的状态查询（真机）。
 *
 * 直调主包暴露的 Zotero.ZTransplit.python.getStatus 与
 * Zotero.ZTransplit.sidecarEnv.getStatus。这两个查询会真的起进程探活，
 * 因此它验证的是单元测试覆盖不到的部分：模块在真实 bundle 里能否加载、
 * 数据目录路径解析、以及 resolveSystemPython 在 Zotero 自己的进程环境里
 * 到底能不能找到 PATH 上的 Python（图形启动的 Zotero 继承的 PATH 与 shell
 * 里的不一定一致，这是"用系统 Python"这条路径最关键、也最只能在真机确认
 * 的假设）。
 */
(function () {
  PROBE_CMDS.pyStatus = async function () {
    const t0 = Date.now();
    try {
      const status = await Zotero.ZTransplit.python.getStatus();
      return { status, ms: Date.now() - t0 };
    } catch (e) {
      return { error: String((e && e.stack) || e), ms: Date.now() - t0 };
    }
  };

  PROBE_CMDS.envStatus = async function () {
    const t0 = Date.now();
    try {
      const status = await Zotero.ZTransplit.sidecarEnv.getStatus();
      return { status, ms: Date.now() - t0 };
    } catch (e) {
      return { error: String((e && e.stack) || e), ms: Date.now() - t0 };
    }
  };

  // sidecarInstall / sidecarRepair — 识别环境的一键安装与重装（真机）。
  //
  // 为什么必须有这两个包装：整条扫描件链路里，唯一没有任何自动化或真机覆盖
  // 的就是"装"这一步——pip 装 paddlepaddle、下模型权重、跑 --selftest。前面
  // 的状态查询只能告诉你"没装"，装不上这件事永远发现不了。入口在
  // src/addon.ts 已经暴露（sidecarEnv.install / .repair），缺的只是探针这一层。
  //
  // 两个实现细节：
  //   - 安装会开进度窗（installSidecarEnvWithProgress），QA 环境有主窗口，
  //     可以直接跑；窗口是模态的，安装期间轮询分发器会被占住，所以这条命令
  //     本身就会阻塞到装完——这正是我们想要的，调用方拿到的就是最终状态。
  //   - 失败时 install 会抛，进度窗已经呈现过；这里把错误原文带回，调用方
  //     （启动器侧）靠它判断卡在哪一步。
  PROBE_CMDS.sidecarInstall = async function () {
    const t0 = Date.now();
    try {
      await Zotero.ZTransplit.sidecarEnv.install();
      const status = await Zotero.ZTransplit.sidecarEnv.getStatus();
      return { installed: true, status, ms: Date.now() - t0 };
    } catch (e) {
      let status = null;
      try {
        status = await Zotero.ZTransplit.sidecarEnv.getStatus();
      } catch {
        /* 状态查询也失败就只回错误本身 */
      }
      return {
        installed: false,
        status,
        error: String((e && e.stack) || e),
        ms: Date.now() - t0,
      };
    }
  };

  PROBE_CMDS.sidecarRepair = async function () {
    const t0 = Date.now();
    try {
      await Zotero.ZTransplit.sidecarEnv.repair();
      const status = await Zotero.ZTransplit.sidecarEnv.getStatus();
      return { repaired: true, status, ms: Date.now() - t0 };
    } catch (e) {
      return {
        repaired: false,
        error: String((e && e.stack) || e),
        ms: Date.now() - t0,
      };
    }
  };
})();

/**
 * openShot {id, path} — 打开指定附件（译文 PDF）并截取主窗口。
 *
 * 为"复杂 PDF 翻译截图"这类验证准备：选中附件 → 在阅读器里打开 → 等阅读器
 * 就绪 → 窗口提到前台并加宽（条目面板默认会被挤出可见区）→ drawWindow 落盘。
 * drawWindow 画的是屏幕真实合成结果（PrintWindow 对部分 Gecko 合成层不可靠）。
 */
(function () {
  PROBE_CMDS.openShot = async function (arg) {
    const opts = parseOpts(arg);
    const attID = Number(opts.id);
    if (!attID) return { error: "pass id=<attachment id>" };
    const win = Zotero.getMainWindow();
    const doc = win && win.document;
    if (!doc) return { error: "no main window" };
    const ZoteroPane = win.ZoteroPane;
    const Zotero_Tabs = win.Zotero_Tabs;

    ZoteroPane.selectItem(attID);
    await Zotero.Promise.delay(400);
    await ZoteroPane.viewAttachment(attID);
    let reader = null;
    for (let i = 0; i < 60; i++) {
      await Zotero.Promise.delay(250);
      reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
      if (reader && reader.itemID === attID) break;
    }
    await Zotero.Promise.delay(2500);
    // 指定页先导航：Zotero 10 的 reader.navigate 只认顶层 pageIndex，position
    // .pageIndex 那种形状不生效（见 probe.js 的 navtest 实测）。
    const pageIndex = Number(opts.page);
    if (reader && Number.isFinite(pageIndex) && pageIndex >= 0) {
      try {
        await reader.navigate({ pageIndex });
      } catch (e) {
        probeLog("openShot navigate: " + e);
      }
      await Zotero.Promise.delay(2500);
    }
    try {
      win.focus();
      win.resizeTo(1440, 900);
    } catch {
      /* 窗口管理器拒绝 */
    }
    await Zotero.Promise.delay(800);

    // 默认路径必须是 Windows 反斜杠形式：IOUtils.write 对 "D:/..." 直接报
    // NS_ERROR_FILE_UNRECOGNIZED_PATH（真机实测 2026-11-19）。字面量里的
    // 反斜杠要写成 "\\"——"D:\zt-qa" 会被 JS 当成 "D:zt-qa"。
    const out =
      opts.path || PathUtils.join("D:\\zt-qa", "openshot.png");
    const w = win.innerWidth || 1440;
    const h = win.innerHeight || 900;
    const canvas = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(win, 0, 0, w, h, "white");
    const dataURL = canvas.toDataURL("image/png");
    const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await IOUtils.write(out, bytes);
    const st = await IOUtils.stat(out);
    return {
      out,
      size: st.size,
      w,
      h,
      readerOpen: !!reader,
      readerItemID: reader ? reader.itemID : null,
      tabID: Zotero_Tabs.selectedID,
    };
  };
})();
