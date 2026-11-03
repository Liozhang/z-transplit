/**
 * probe-extra.js — 段落级联动高亮（data-linked）的真机探针补充命令。
 *
 * 由 scripts/qa/real-machine.mjs 的 bootstrap 补丁在 probe.js 之后、
 * startProbe() 之前，以同一个 scope 对象加载——因此本文件直接往既有的
 * PROBE_CMDS 上挂命令即可被同一个轮询分发器（probePoll）看到，无需改动
 * probe.js 本体。
 *
 * 为什么单独一个文件：联动高亮发生在 Zotero 10 SDT 阅读模式的 iframe
 * 文档里（#sdt-content > [data-ref-path] 原文块 + .ztransplit-bi 注入
 * 译文块），probe.js 现有的 selectText 选的是 pdf.js 文本层——SDT 模式
 * 下该层被隐藏，选不中。这里补两个命令：
 *
 *   biSelect {side, index, via}  在指定侧（original|trans）的第 index 个
 *                                块里造选区并派发 mouseup（插件的监听挂在
 *                                SDT 文档上，见 interleaveView 的
 *                                onDocMouseUp），via:"key" 改派 keyup
 *   biState {}                   只读当前 data-linked 分布与模式类
 *                                （切模式、退出会话之后复查用）
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
})();
