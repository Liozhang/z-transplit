/**
 * Z-Transplit 设置面板（编辑 → 设置 → Z-Transplit）行为脚本。
 *
 * 由 Zotero.PreferencePanes.register({ scripts: [...] }) 加载，执行时机早于
 * 面板 DOM 插入设置窗口（见 Zotero_Preferences._loadPane：先加载脚本，再拉取
 * 并解析 xhtml 片段），所以这里不能直接查询元素；入口是片段根元素上的
 * onload="ZTransplitPrefs.onLoad(event)"（Zotero 在 _initImportedNodesPostInsert
 * 里对面板容器每个子元素派发 load 事件）。
 *
 * 约定：
 *   - 面板脚本运行在 Cu.Sandbox(window, { sandboxPrototype: window }) 中，
 *     document / Zotero 都从设置窗口解析；顶层声明不会挂到 window 上，所以
 *     必须显式挂 window.ZTransplitPrefs 才能被 xhtml 里的 oncommand 调用。
 *   - 只用 Zotero.Prefs / Zotero.PDFTranslate / Zotero.DataDirectory 这些
 *     设置窗口里一定存在的 API，不依赖插件主包（Zotero.ZTransplit）是否加载。
 *   - 任何一步失败都不能让面板崩掉：全部 try/catch，且不弹 alert/confirm，
 *     出错只写 Zotero.debug。
 *   - 引擎切换只切 hidden 属性，不重建 DOM、不移动焦点，因此不跳焦也不抖滚动。
 */

(function () {
  "use strict";

  var PREF_PREFIX = "extensions.zotero.ztransplit.";

  var MAX_CHARS_MIN = 100;
  var MAX_CHARS_MAX = 50000;
  var MAX_CHARS_DEFAULT = 10000;

  // 与 addon/prefs.js 的 translate.batchMaxTokens 默认值对齐。
  var BATCH_TOKENS_MIN = 1000;
  var BATCH_TOKENS_MAX = 65536;
  var BATCH_TOKENS_DEFAULT = 8192;

  /**
   * 字体覆盖目录。与 src/core/pdf/translation/opendataloaderSplitAdapter.ts
   * #translationAssetsDir 保持一字不差：代码读的是 {DataDir}/ztransplit/…，
   * 面板就必须显示同一个路径，否则用户会把字体放错地方。
   */
  var ASSETS_SUBDIR = "ztransplit/translation-assets";

  /** 引擎值 -> 字段组元素 id（与 xhtml 中的 id 对应）。 */
  var ENGINE_GROUPS = [
    ["google", "ztransplit-pref-engine-google"],
    ["bing", "ztransplit-pref-engine-bing"],
    ["deepl", "ztransplit-pref-engine-deepl"],
    ["ai", "ztransplit-pref-engine-ai"],
    ["custom", "ztransplit-pref-engine-custom"],
    ["zotero-pdf-translate", "ztransplit-pref-engine-pdftranslate"],
  ];

  /** 元素引用缓存，load 时填充。 */
  var els = {};

  /** zotero-pdf-translate 下拉项的两种标签（本地化后的）。 */
  var pdfTranslateLabels = { base: "", missing: "" };

  function $(id) {
    try {
      return document.getElementById(id);
    } catch (e) {
      return null;
    }
  }

  function show(el, visible) {
    if (!el) return;
    try {
      if (visible) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "true");
    } catch (e) {
      /* 忽略：元素可能已被替换 */
    }
  }

  function getPref(key) {
    try {
      return Zotero.Prefs.get(PREF_PREFIX + key, true);
    } catch (e) {
      return undefined;
    }
  }

  function setPref(key, value) {
    try {
      Zotero.Prefs.set(PREF_PREFIX + key, value, true);
      return true;
    } catch (e) {
      Zotero.debug("[Z-Transplit] prefs: set " + key + " failed: " + e);
      return false;
    }
  }

  // ── maxChars ────────────────────────────────────────────────────────────

  function readMaxChars() {
    var raw = getPref("translate.maxChars");
    var n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!isFinite(n) || isNaN(n)) return MAX_CHARS_DEFAULT;
    return Math.min(MAX_CHARS_MAX, Math.max(MAX_CHARS_MIN, Math.round(n)));
  }

  function setMaxCharsError(visible) {
    show(els.maxCharsError, visible);
    if (els.maxCharsInput) {
      try {
        if (visible) els.maxCharsInput.setAttribute("aria-invalid", "true");
        else els.maxCharsInput.removeAttribute("aria-invalid");
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /** 解析输入框内容；合法返回整数，否则返回 null。 */
  function parseMaxChars(raw) {
    if (raw === null || raw === undefined) return null;
    var text = String(raw).trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) return null;
    var n = parseInt(text, 10);
    if (!isFinite(n)) return null;
    if (n < MAX_CHARS_MIN || n > MAX_CHARS_MAX) return null;
    return n;
  }

  function onMaxCharsInput() {
    if (!els.maxCharsInput) return;
    var n = parseMaxChars(els.maxCharsInput.value);
    if (n === null) {
      // 输入中途（空串 / 超范围 / 非数字）只提示，不写 pref：
      // 半成品值不该污染设置，也不会触发 Zotero.Prefs.set 的整型转换异常。
      setMaxCharsError(true);
      return;
    }
    setMaxCharsError(false);
    setPref("translate.maxChars", n);
  }

  function onMaxCharsChange() {
    if (!els.maxCharsInput) return;
    var n = parseMaxChars(els.maxCharsInput.value);
    if (n !== null) {
      setMaxCharsError(false);
      setPref("translate.maxChars", n);
      return;
    }
    // 失焦时仍不合法（非纯整数 / 越界 / 负数 / 空串）：恢复为当前 pref 值且
    // 不写 pref —— 与文案承诺一致（“填错或留空时会继续使用上一次的合法值，
    // 不会改写设置”），越界值也不得被夹紧后覆盖设置。
    els.maxCharsInput.value = String(readMaxChars());
    setMaxCharsError(false);
  }

  // ── batchMaxTokens（合并批量输入上限）────────────────────────────────────
  // 与 maxChars 同一套路：INT pref 不写半成品值，读 pref → 校验 → 写 pref。

  function readBatchTokens() {
    var raw = getPref("translate.batchMaxTokens");
    var n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!isFinite(n) || isNaN(n)) return BATCH_TOKENS_DEFAULT;
    return Math.min(BATCH_TOKENS_MAX, Math.max(BATCH_TOKENS_MIN, Math.round(n)));
  }

  function setBatchTokensError(visible) {
    show(els.batchTokensError, visible);
    if (els.batchTokensInput) {
      try {
        if (visible) els.batchTokensInput.setAttribute("aria-invalid", "true");
        else els.batchTokensInput.removeAttribute("aria-invalid");
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /** 解析输入框内容；合法返回整数，否则返回 null。 */
  function parseBatchTokens(raw) {
    if (raw === null || raw === undefined) return null;
    var text = String(raw).trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) return null;
    var n = parseInt(text, 10);
    if (!isFinite(n)) return null;
    if (n < BATCH_TOKENS_MIN || n > BATCH_TOKENS_MAX) return null;
    return n;
  }

  function onBatchTokensInput() {
    if (!els.batchTokensInput) return;
    var n = parseBatchTokens(els.batchTokensInput.value);
    if (n === null) {
      setBatchTokensError(true);
      return;
    }
    setBatchTokensError(false);
    setPref("translate.batchMaxTokens", n);
  }

  function onBatchTokensChange() {
    if (!els.batchTokensInput) return;
    var n = parseBatchTokens(els.batchTokensInput.value);
    if (n !== null) {
      setBatchTokensError(false);
      setPref("translate.batchMaxTokens", n);
      return;
    }
    // 与 maxChars 同一策略：非法值一律恢复为当前 pref 值且不写 pref。
    els.batchTokensInput.value = String(readBatchTokens());
    setBatchTokensError(false);
  }

  // ── AI prompt 模板 ────────────────────────────────────────────────────────
  // 规则与 src/core/translation/promptTemplate.ts#validatePromptTemplate 一字
  // 不差（那里是权威实现，这里是设置面板里的即时反馈；tests/unit/ui/
  // preferencesPane.dom.test.ts 用一个样例矩阵把两份实现的判定钉在一起）。
  // 与 maxChars / ODL timeout 同一套路：不挂 preference 属性，读 pref → 校验 →
  // 写 pref，半成品值不落盘；失焦仍非法则恢复当前 pref 值。

  var AI_PROMPT_MAX = 4000;
  var AI_PLACEHOLDERS = ["text", "sourceLang", "targetLang"];

  /** 与 TS 版同序的七种非法原因 → 隐藏本地化节点 id 后缀。 */
  var AI_PROMPT_STRING_IDS = {
    "too-long": "ztransplit-pref-string-ai-prompt-too-long",
    "unknown-placeholder": "ztransplit-pref-string-ai-prompt-unknown-placeholder",
    "missing-text": "ztransplit-pref-string-ai-prompt-missing-text",
    "duplicate-text": "ztransplit-pref-string-ai-prompt-duplicate-text",
    "missing-source-lang": "ztransplit-pref-string-ai-prompt-missing-source-lang",
    "missing-target-lang": "ztransplit-pref-string-ai-prompt-missing-target-lang",
    "unbalanced-braces": "ztransplit-pref-string-ai-prompt-unbalanced-braces",
  };

  /** @returns {{ok: boolean, reason: string}} reason 为空表示合法。 */
  function checkAIPrompt(raw) {
    var template =
      raw === null || raw === undefined ? "" : String(raw).replace(/^\s+|\s+$/g, "");
    if (template === "") return { ok: true, reason: "" };
    if (template.length > AI_PROMPT_MAX) return { ok: false, reason: "too-long" };

    var names = [];
    var scan = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
    var m;
    while ((m = scan.exec(template)) !== null) names.push(m[1]);
    for (var i = 0; i < names.length; i++) {
      // 拼错的占位符要先报「未知占位符」：{{txt}} 同时触犯两条规则，而这条才
      // 是用户能直接改的那条（与 TS 版同序）。
      if (AI_PLACEHOLDERS.indexOf(names[i]) < 0) {
        return { ok: false, reason: "unknown-placeholder" };
      }
    }
    var residual = template.replace(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/g, "");
    // 不成对的花括号排在「缺失占位符」之前：半成品的 {{text} 同时也丢了
    // {{text}}，而「花括号落单」才是用户能直接改的那个说法（与 TS 版同序）。
    if (residual.indexOf("{{") >= 0 || residual.indexOf("}}") >= 0) {
      return { ok: false, reason: "unbalanced-braces" };
    }
    function count(name) {
      var c = 0;
      for (var i = 0; i < names.length; i++) if (names[i] === name) c++;
      return c;
    }
    if (count("text") === 0) return { ok: false, reason: "missing-text" };
    if (count("text") > 1) return { ok: false, reason: "duplicate-text" };
    if (count("sourceLang") === 0) {
      return { ok: false, reason: "missing-source-lang" };
    }
    if (count("targetLang") === 0) {
      return { ok: false, reason: "missing-target-lang" };
    }
    return { ok: true, reason: "" };
  }

  function setAIPromptError(reason) {
    var errorEl = els.aiPromptError;
    if (!errorEl) return;
    if (!reason) {
      show(errorEl, false);
      if (els.aiPromptInput) {
        try {
          els.aiPromptInput.removeAttribute("aria-invalid");
        } catch (e) {
          /* 忽略 */
        }
      }
      return;
    }
    // 文案从隐藏的本地化节点取，JS 不写死任何字符串（与 pdftranslate 标签同款）。
    var source = AI_PROMPT_STRING_IDS[reason]
      ? $(AI_PROMPT_STRING_IDS[reason])
      : null;
    if (source && source.textContent) errorEl.textContent = source.textContent;
    show(errorEl, true);
    if (els.aiPromptInput) {
      try {
        els.aiPromptInput.setAttribute("aria-invalid", "true");
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  function readPromptInput() {
    if (!els.aiPromptInput) return "";
    var v;
    try {
      v = els.aiPromptInput.value;
    } catch (e) {
      v = undefined;
    }
    // XUL textbox 有 value；非 XUL 渲染（测试台）退回 textContent。
    if (v === undefined || v === null) v = els.aiPromptInput.textContent;
    return v === undefined || v === null ? "" : String(v);
  }

  function writePromptInput(text) {
    if (!els.aiPromptInput) return;
    try {
      els.aiPromptInput.value = text;
    } catch (e) {
      /* 忽略 */
    }
    if (els.aiPromptInput.value !== text) els.aiPromptInput.textContent = text;
  }

  function onAIPromptInput() {
    if (!els.aiPromptInput) return;
    var check = checkAIPrompt(readPromptInput());
    if (check.ok) {
      setAIPromptError("");
      setPref("translate.ai.prompt", readPromptInput());
      return;
    }
    // 半成品值只提示，不写 pref（与 maxChars 同一策略）。
    setAIPromptError(check.reason);
  }

  function onAIPromptChange() {
    if (!els.aiPromptInput) return;
    var check = checkAIPrompt(readPromptInput());
    if (check.ok) {
      setAIPromptError("");
      setPref("translate.ai.prompt", readPromptInput());
      return;
    }
    // 失焦仍非法：恢复为当前 pref 值且不写 pref。
    writePromptInput(String(getPref("translate.ai.prompt") || ""));
    setAIPromptError("");
  }

  /** 「恢复默认模板」按钮：写空串即内置默认模板。 */
  function restoreDefaultPrompt() {
    setPref("translate.ai.prompt", "");
    writePromptInput("");
    setAIPromptError("");
  }

  // ── pdfParser.opendataloader.timeout ─────────────────────────────────────
  // 与 maxChars 同一套路：INT pref 不能写半成品值，所以这个输入框不挂
  // preference 属性，由本脚本读 pref、校验后再写。
  // 取值范围与 addon/prefs.js 的默认值（300 秒）对齐。

  var TIMEOUT_MIN = 30;
  var TIMEOUT_MAX = 3600;
  var TIMEOUT_DEFAULT = 300;

  function readTimeout() {
    var raw = getPref("pdfParser.opendataloader.timeout");
    var n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (!isFinite(n) || isNaN(n)) return TIMEOUT_DEFAULT;
    return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(n)));
  }

  function setTimeoutError(visible) {
    show(els.timeoutError, visible);
    if (els.timeoutInput) {
      try {
        if (visible) els.timeoutInput.setAttribute("aria-invalid", "true");
        else els.timeoutInput.removeAttribute("aria-invalid");
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /** 解析输入框内容；合法返回整数，否则返回 null。 */
  function parseTimeout(raw) {
    if (raw === null || raw === undefined) return null;
    var text = String(raw).trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) return null;
    var n = parseInt(text, 10);
    if (!isFinite(n)) return null;
    if (n < TIMEOUT_MIN || n > TIMEOUT_MAX) return null;
    return n;
  }

  function onTimeoutInput() {
    if (!els.timeoutInput) return;
    var n = parseTimeout(els.timeoutInput.value);
    if (n === null) {
      setTimeoutError(true);
      return;
    }
    setTimeoutError(false);
    setPref("pdfParser.opendataloader.timeout", n);
  }

  function onTimeoutChange() {
    if (!els.timeoutInput) return;
    var n = parseTimeout(els.timeoutInput.value);
    if (n !== null) {
      setTimeoutError(false);
      setPref("pdfParser.opendataloader.timeout", n);
      return;
    }
    // 与 maxChars 同一策略：非法值一律恢复为当前 pref 值且不写 pref。
    els.timeoutInput.value = String(readTimeout());
    setTimeoutError(false);
  }

  // ── 引擎字段组显隐 ──────────────────────────────────────────────────────

  function syncEngineFields() {
    var engine = "";
    if (els.engineList) {
      try {
        engine = String(els.engineList.value || "");
      } catch (e) {
        engine = "";
      }
    }
    if (!engine) engine = String(getPref("translate.engineType") || "google");

    ENGINE_GROUPS.forEach(function (pair) {
      var el = $(pair[1]);
      if (el) show(el, pair[0] === engine);
    });
  }

  // ── zotero-pdf-translate 探测 ───────────────────────────────────────────

  /**
   * 与 src/core/translation/featureReadiness.ts#hasPDFTranslatePlugin 同一判据：
   * Zotero.PDFTranslate.api.translate 存在才算装好。任何宿主差异都不能抛异常。
   */
  function hasPDFTranslate() {
    try {
      if (typeof Zotero === "undefined" || !Zotero) return false;
      var api = Zotero.PDFTranslate && Zotero.PDFTranslate.api;
      return Boolean(api && typeof api.translate === "function");
    } catch (e) {
      return false;
    }
  }

  function syncPDFTranslateStatus() {
    var installed = hasPDFTranslate();
    show($("ztransplit-pref-pdftranslate-installed"), installed);
    show($("ztransplit-pref-pdftranslate-missing"), !installed);

    // 下拉项标签同步：没装插件时标注「（未安装）」，装了就恢复原标签。
    // 文案来自 xhtml 里那个隐藏的本地化节点（Fluent 在 load 之前就翻译完了），
    // JS 不写死任何字符串。
    var item = els.pdfTranslateItem;
    if (item) {
      var label = installed ? pdfTranslateLabels.base : pdfTranslateLabels.missing;
      if (label) item.setAttribute("label", label);
    }
  }

  // ── 字体覆盖目录 ────────────────────────────────────────────────────────

  function assetsDir() {
    var dir = "";
    try {
      dir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) || "";
    } catch (e) {
      dir = "";
    }
    if (!dir) return "{数据目录}/" + ASSETS_SUBDIR;
    // 统一成正斜杠：Windows 上 DataDirectory.dir 带反斜杠，混排很难读。
    return String(dir).replace(/\\/g, "/") + "/" + ASSETS_SUBDIR;
  }

  // ── 密钥显示/隐藏 ───────────────────────────────────────────────────────

  function toggleKeyVisibility(event) {
    var checkbox = event && event.target ? event.target : null;
    if (!checkbox) return;
    var row = null;
    try {
      row = checkbox.closest ? checkbox.closest(".ztransplit-row") : null;
    } catch (e) {
      row = null;
    }
    if (!row) row = checkbox.parentNode;
    if (!row || !row.querySelector) return;
    var input = row.querySelector("input");
    if (!input) return;
    try {
      input.setAttribute("type", checkbox.checked ? "text" : "password");
    } catch (e) {
      /* 忽略 */
    }
  }

  // ── 入口 ────────────────────────────────────────────────────────────────

  function cacheElements() {
    els.maxCharsInput = $("ztransplit-pref-maxchars");
    els.maxCharsError = $("ztransplit-pref-maxchars-error");
    els.batchTokensInput = $("ztransplit-pref-batchtokens");
    els.batchTokensError = $("ztransplit-pref-batchtokens-error");
    els.timeoutInput = $("ztransplit-pref-odl-timeout");
    els.timeoutError = $("ztransplit-pref-odl-timeout-error");
    els.engineList = $("ztransplit-pref-engine-type");
    els.pdfTranslateItem = $("ztransplit-pref-engine-item-pdftranslate");
    els.aiPromptInput = $("ztransplit-pref-ai-prompt");
    els.aiPromptError = $("ztransplit-pref-ai-prompt-error");

    // Zotero 在派发 load 之前已经跑完 document.l10n.translateFragment()，
    // 所以这里读到的 label / textContent 已经是本地化后的文案。
    if (els.pdfTranslateItem) {
      pdfTranslateLabels.base = els.pdfTranslateItem.getAttribute("label") || "";
    }
    var missingLabel = $("ztransplit-pref-string-pdftranslate-missing");
    if (missingLabel && missingLabel.textContent) {
      pdfTranslateLabels.missing = String(missingLabel.textContent).trim();
    }
    if (!pdfTranslateLabels.missing) {
      // Fluent 没生效时退回 menuitem 自身的静态标签，至少不会出现空项。
      pdfTranslateLabels.missing = pdfTranslateLabels.base;
    }
  }

  function bindEvents() {
    if (els.maxCharsInput) {
      els.maxCharsInput.addEventListener("input", onMaxCharsInput);
      // change 在失焦/回车时触发：合法值写 pref，非法值恢复为当前 pref 值。
      els.maxCharsInput.addEventListener("change", onMaxCharsChange);
    }
    if (els.batchTokensInput) {
      els.batchTokensInput.addEventListener("input", onBatchTokensInput);
      els.batchTokensInput.addEventListener("change", onBatchTokensChange);
    }
    if (els.timeoutInput) {
      els.timeoutInput.addEventListener("input", onTimeoutInput);
      els.timeoutInput.addEventListener("change", onTimeoutChange);
    }
    if (els.aiPromptInput) {
      els.aiPromptInput.addEventListener("input", onAIPromptInput);
      els.aiPromptInput.addEventListener("change", onAIPromptChange);
    }
    if (els.engineList) {
      // XUL menulist 选中项变化主要抛 select；command 在某些平台上也会抛，
      // 两个都听，syncEngineFields 是幂等的，重复执行没有副作用。
      els.engineList.addEventListener("select", syncEngineFields);
      els.engineList.addEventListener("command", syncEngineFields);
    }
    // 面板每次显示时重新探测：用户可能开着设置窗口去装了 zotero-pdf-translate。
    var root = $("zotero-prefpane-ztransplit");
    if (root) root.addEventListener("showing", syncPDFTranslateStatus);
  }

  function onLoad() {
    try {
      cacheElements();
      bindEvents();

      if (els.maxCharsInput) {
        // 这个输入框不挂 preference 属性：空串会让 Zotero 的整型 pref 写入抛
        // 异常，所以由本脚本读 pref、校验后再写。
        els.maxCharsInput.value = String(readMaxChars());
      }
      setMaxCharsError(false);

      if (els.batchTokensInput) {
        // 同 maxChars：INT pref 由本脚本读 pref、校验后再写。
        els.batchTokensInput.value = String(readBatchTokens());
      }
      setBatchTokensError(false);

      if (els.timeoutInput) {
        // 同上：pdfParser.opendataloader.timeout 也是 INT pref。
        els.timeoutInput.value = String(readTimeout());
      }
      setTimeoutError(false);

      // prompt 模板：空值 = 内置默认模板，所以输入框留空是合法初始态。
      if (els.aiPromptInput) {
        writePromptInput(String(getPref("translate.ai.prompt") || ""));
      }
      setAIPromptError("");

      syncEngineFields();
      syncPDFTranslateStatus();

      var path = $("ztransplit-pref-pdf-fonts-path");
      if (path) path.textContent = assetsDir();
    } catch (e) {
      Zotero.debug("[Z-Transplit] preferences: onLoad failed: " + e);
    }
  }

  // xhtml 里的 oncommand 在 window 作用域求值，必须挂到 window 上。
  window.ZTransplitPrefs = {
    onLoad: onLoad,
    toggleKeyVisibility: toggleKeyVisibility,
    restoreDefaultPrompt: restoreDefaultPrompt,
  };
})();
