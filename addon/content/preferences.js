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
    ["bing-web", "ztransplit-pref-engine-bingweb"],
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

  // ── 网络区域 ────────────────────────────────────────────────────────────

  // 推荐值表必须与 src/utils/region.ts 保持一字不差：面板脚本运行在独立
  // 沙箱里，无法 import 主包，只能镜像这份小表（与 ASSETS_SUBDIR 同一约定）。
  var REGION_PROFILES = {
    global: { engine: "google", bingRegion: "global" },
    cn: { engine: "bing-web", bingRegion: "chinanorth" },
  };
  // 出厂默认值（addon/prefs.js 的镜像）。推荐值只覆盖仍等于这些值的键。
  var REGION_SHIPPED_DEFAULTS = {
    "translate.engineType": "google",
    "translate.bing.region": "",
  };
  var REGION_RECOMMENDED_KEYS = [
    "translate.engineType",
    "translate.bing.region",
  ];

  function regionRecommendation(region, key) {
    var profile = REGION_PROFILES[region];
    if (!profile) return REGION_SHIPPED_DEFAULTS[key];
    return key === "translate.engineType" ? profile.engine : profile.bingRegion;
  }

  /**
   * 套用区域推荐值，返回实际写入的键。守门与 src/utils/region.ts 一致：
   * 只有当前值仍等于出厂默认的键才会被改写——用户显式选过的引擎不被推翻。
   */
  function applyRegionRecommendations(region) {
    var written = [];
    if (!REGION_PROFILES[region]) return written;
    REGION_RECOMMENDED_KEYS.forEach(function (key) {
      var current = getPref(key);
      var currentText =
        current === undefined || current === null ? "" : String(current);
      if (currentText !== REGION_SHIPPED_DEFAULTS[key]) return;
      var next = regionRecommendation(region, key);
      if (currentText === next) return;
      setPref(key, next);
      written.push(key);
    });
    return written;
  }

  /** 应用提示：文案从 xhtml 里隐藏的本地化节点搬运，JS 不写死任何字符串。 */
  function showRegionNote(written) {
    var note = els.regionNote;
    if (!note) return;
    var source = $(written.length
      ? "ztransplit-pref-region-note-applied"
      : "ztransplit-pref-region-note-nochange");
    if (source && source.textContent) note.textContent = source.textContent;
    show(note, Boolean(source && source.textContent));
  }

  function onRegionPicked() {
    var region = "auto";
    if (els.regionList) {
      try {
        region = String(els.regionList.value || "auto");
      } catch (e) {
        region = "auto";
      }
    }
    var written = applyRegionRecommendations(region);
    // 推荐值可能改写了引擎：让引擎下拉与字段分组立即跟上（Zotero 的
    // preference 反向同步时机不保证，这里显式回读 pref）。
    if (written.indexOf("translate.engineType") !== -1 && els.engineList) {
      try {
        els.engineList.value = String(getPref("translate.engineType") || "");
      } catch (e) {
        /* 忽略：下拉值同步失败只影响回显，不影响已写入的 pref */
      }
    }
    syncEngineFields();
    showRegionNote(written);
  }

  // ── AI 服务商预设 ───────────────────────────────────────────────────────

  // 预设表必须与 src/core/ai/providerPresets.ts 一字不差（面板脚本在独立
  // 沙箱里无法 import 主包，与 REGION_PROFILES 镜像同一约束）。tests/unit
  // 下有两侧一致性的对照测试。
  var AI_PROVIDER_PRESETS = [
    { id: "deepseek", apiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { id: "qwen", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { id: "glm", apiUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
    { id: "kimi", apiUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
    { id: "stepfun", apiUrl: "https://api.stepfun.com/v1", model: "step-2-16k" },
    { id: "openai", apiUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    { id: "ollama", apiUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
    { id: "lmstudio", apiUrl: "http://127.0.0.1:1234/v1", model: "" },
    { id: "custom", apiUrl: "", model: "" },
  ];
  var AI_PROVIDER_NONE = "none";

  function findAiPreset(id) {
    for (var i = 0; i < AI_PROVIDER_PRESETS.length; i++) {
      if (AI_PROVIDER_PRESETS[i].id === id) return AI_PROVIDER_PRESETS[i];
    }
    return null;
  }

  /**
   * 把预设写进三个字段。语义与 src/core/ai/providerPresets.ts#applyProviderPreset
   * 一致：none/custom 不动任何字段；模型名只在当前为空或「另一个预设的值」
   * 时才覆盖——用户手工改过的模型名不被预设吞掉。
   */
  function applyAiProviderPreset(id) {
    var preset = findAiPreset(id);
    if (!preset || preset.id === "custom") return;
    var currentUrl = String(getPref("translate.ai.apiUrl") || "");
    var currentModel = String(getPref("translate.ai.model") || "");
    if (preset.apiUrl) setPref("translate.ai.apiUrl", preset.apiUrl);
    var modelIsPresetOwned =
      !currentModel ||
      AI_PROVIDER_PRESETS.some(function (p) {
        return p.model && p.model === currentModel;
      });
    if (preset.model && modelIsPresetOwned) {
      setPref("translate.ai.model", preset.model);
    }
    // 字段被改写即此前的测试结果作废，清掉状态行，避免「连接成功」停在旧
    // 配置上误导用户。
    setAiTestStatus("");
    syncAiProviderEcho(id, currentUrl, currentModel);
  }

  /** 下拉回显：按当前接口地址反查预设，让老用户的界面状态与配置一致。 */
  function detectAiPresetId(apiUrl) {
    var url = String(apiUrl || "").trim().replace(/\/+$/, "").toLowerCase();
    if (!url) return AI_PROVIDER_NONE;
    for (var i = 0; i < AI_PROVIDER_PRESETS.length; i++) {
      var p = AI_PROVIDER_PRESETS[i];
      if (p.apiUrl && p.apiUrl.replace(/\/+$/, "").toLowerCase() === url) {
        return p.id;
      }
    }
    return AI_PROVIDER_NONE;
  }

  function syncAiProviderEcho(id, prevUrl, prevModel) {
    // XUL 的 preference 绑定只覆盖 xhtml 里声明了 preference 的控件；服务商
    // 下拉没有绑定 pref（它是动作而非状态），所以地址/模型改写后要显式回填
    // 三个输入框，否则界面还显示着旧值。
    if (els.aiUrlInput) {
      els.aiUrlInput.value = String(getPref("translate.ai.apiUrl") || "");
    }
    if (els.aiModelInput) {
      els.aiModelInput.value = String(getPref("translate.ai.model") || "");
    }
    if (els.aiProviderList) {
      try {
        els.aiProviderList.value = id;
      } catch (e) {
        /* 忽略：下拉值同步失败只影响回显 */
      }
    }
  }

  function onAiProviderPicked() {
    var id = AI_PROVIDER_NONE;
    if (els.aiProviderList) {
      try {
        id = String(els.aiProviderList.value || AI_PROVIDER_NONE);
      } catch (e) {
        id = AI_PROVIDER_NONE;
      }
    }
    applyAiProviderPreset(id);
  }

  // ── AI 测试连接 ────────────────────────────────────────────────────────
  // 与 Java/解析组件两节同一套路：面板脚本无法 import 主包，测试逻辑（发一个
  // 最小请求并按 HTTP status 分类）在主包的 connectionTest.ts 里，经
  // Zotero.ZTransplit.ai.testConnection 暴露。参数取面板当前表单值——测的
  // 就是用户眼前看到的配置，不等他先保存。

  var aiTestInFlight = false;
  var aiTestStrings = {};

  function aiApi() {
    try {
      var zt = Zotero && Zotero.ZTransplit;
      var api = zt && zt.ai;
      if (api && typeof api.testConnection === "function") return api;
    } catch (e) {
      /* 主包未挂载 */
    }
    return null;
  }

  function setAiTestStatus(text, ok) {
    if (!els.aiTestStatus) return;
    try {
      els.aiTestStatus.textContent = text || "";
      // 成功/失败用颜色区分（class 在 xhtml 的样式表里有定义）；中性态清掉。
      if (ok === true) {
        els.aiTestStatus.setAttribute("style", "color: var(--in-content-item-valid-text-color, #2e7d32);");
      } else if (ok === false) {
        els.aiTestStatus.setAttribute("style", "color: var(--in-content-item-invalid-text-color, #c62828);");
      } else {
        els.aiTestStatus.removeAttribute("style");
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  function setAiTestButtonDisabled(disabled) {
    if (!els.aiTestBtn) return;
    try {
      if (disabled) els.aiTestBtn.setAttribute("disabled", "true");
      else els.aiTestBtn.removeAttribute("disabled");
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 从隐藏的本地化节点取文案（与 javaStrings 同一约定：JS 不写死字符串）。 */
  function loadAiTestStrings() {
    aiTestStrings.checking =
      ($("ztransplit-pref-ai-test-checking-text") || {}).textContent || "";
    aiTestStrings.nobundle =
      ($("ztransplit-pref-ai-test-nobundle-text") || {}).textContent || "";
  }

  function onAiTest() {
    if (aiTestInFlight) return;
    var api = aiApi();
    if (!api) {
      setAiTestStatus(aiTestStrings.nobundle || "", false);
      return;
    }
    aiTestInFlight = true;
    setAiTestButtonDisabled(true);
    setAiTestStatus(aiTestStrings.checking || "");
    Promise.resolve()
      .then(function () {
        // 表单值优先于 pref：用户可能刚改过还没失焦（XUL preference 绑定在
        // 部分平台上要等失焦才落盘）。
        return api.testConnection({
          apiUrl: String(
            (els.aiUrlInput && els.aiUrlInput.value) ||
              getPref("translate.ai.apiUrl") ||
              "",
          ),
          apiKey: String(
            (els.aiKeyInput && els.aiKeyInput.value) ||
              getPref("translate.ai.apiKey") ||
              "",
          ),
          model: String(
            (els.aiModelInput && els.aiModelInput.value) ||
              getPref("translate.ai.model") ||
              "",
          ),
        });
      })
      .then(function (result) {
        var r = result || {};
        setAiTestStatus(String(r.message || ""), r.ok === true);
      })
      .catch(function (e) {
        setAiTestStatus(
          (aiTestStrings.nobundle || "") + " " + String((e && e.message) || e),
          false,
        );
      })
      .then(function () {
        aiTestInFlight = false;
        setAiTestButtonDisabled(false);
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

  // 数据目录占位文案：来自 xhtml 里隐藏的本地化节点（英文界面显示英文），
  // JS 不写死任何字符串。
  var dataDirPlaceholder = "{Data directory}";

  function assetsDir() {
    var dir = "";
    try {
      dir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) || "";
    } catch (e) {
      dir = "";
    }
    if (!dir) return dataDirPlaceholder + "/" + ASSETS_SUBDIR;
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

  // ── Java 运行库：状态检测 + 安装/修复 ───────────────────────────────────
  // 检测与安装都走主包暴露的 Zotero.ZTransplit.java（面板脚本运行在独立
  // 沙箱里，无法 import 主包模块——与 REGION_PROFILES 镜像同一约束）。主包
  // 未加载（bundle 失败 / 插件刚重载）时只提示，不把面板搞成假失败。
  // 检测会 spawn 一次 `java -version` 进程（可能数秒），所以只在点击按钮时
  // 执行；面板加载与面板显示都不自动探测，避免打开设置时卡顿。

  var javaStrings = {};
  /** 「安装 / 修复」按钮的原始 label，安装中态结束后恢复。 */
  var javaInstallLabelBase = "";
  var javaCheckInFlight = false;
  var javaInstallInFlight = false;

  function javaApi() {
    try {
      var zt = Zotero && Zotero.ZTransplit;
      var api = zt && zt.java;
      // 检测与安装按需可用：主包只暴露了其中一半时，另一半单独降级。
      if (
        api &&
        (typeof api.getStatus === "function" ||
          typeof api.install === "function")
      ) {
        return api;
      }
    } catch (e) {
      /* 主包未挂载 */
    }
    return null;
  }

  function javaString(id) {
    var node = $(id);
    return node && node.textContent ? String(node.textContent).trim() : "";
  }

  function setJavaStatusText(text) {
    if (els.javaStatus) els.javaStatus.textContent = text;
  }

  function setJavaButtonsDisabled(disabled) {
    [els.javaCheckBtn, els.javaInstallBtn].forEach(function (btn) {
      if (!btn) return;
      try {
        if (disabled) btn.setAttribute("disabled", "true");
        else btn.removeAttribute("disabled");
      } catch (e) {
        /* 忽略 */
      }
    });
  }

  function setJavaInstallLabel(installing) {
    if (!els.javaInstallBtn) return;
    var label = installing ? javaStrings.btnInstalling : javaInstallLabelBase;
    if (label) {
      try {
        els.javaInstallBtn.setAttribute("label", label);
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /**
   * 占位符填充。本地化值（Fluent）里写 { $version }，静态回退正文里写
   * {version}，这里对两种写法都替换，文案作者两种都安全。
   */
  function fillJavaTemplate(text, vars) {
    var out = String(text || "");
    Object.keys(vars || {}).forEach(function (key) {
      var value = String(vars[key]);
      out = out.split("{" + key + "}").join(value);
      out = out.split("{ $" + key + " }").join(value);
      out = out.split("{$" + key + "}").join(value);
    });
    return out;
  }

  /** 读取 getStatus() 的结果并回显到状态行。 */
  function refreshJavaStatus() {
    var api = javaApi();
    if (!api || typeof api.getStatus !== "function") {
      setJavaStatusText(javaStrings.nobundle);
      return Promise.resolve();
    }
    setJavaStatusText(javaStrings.checking);
    return Promise.resolve()
      .then(function () {
        return api.getStatus();
      })
      .then(function (status) {
        if (status && status.ready) {
          setJavaStatusText(
            fillJavaTemplate(
              status.managed ? javaStrings.readyManaged : javaStrings.readySystem,
              { version: (status && status.version) || "?" },
            ),
          );
        } else {
          // 探测失败的原因串多为英文 JVM 输出，不上墙；通用文案引导下一步。
          setJavaStatusText(javaStrings.missing);
        }
      })
      .catch(function (e) {
        setJavaStatusText(
          fillJavaTemplate(javaStrings.statusError, {
            detail: String((e && e.message) || e),
          }),
        );
      });
  }

  function onJavaCheck() {
    if (javaCheckInFlight) return;
    javaCheckInFlight = true;
    var done = function () {
      javaCheckInFlight = false;
    };
    refreshJavaStatus().then(done, done);
  }

  function onJavaInstall() {
    if (javaInstallInFlight) return;
    var api = javaApi();
    if (!api || typeof api.install !== "function") {
      setJavaStatusText(javaStrings.nobundle);
      return;
    }
    javaInstallInFlight = true;
    setJavaButtonsDisabled(true);
    setJavaInstallLabel(true);
    setJavaStatusText(javaStrings.statusInstalling);
    // 安装在主包内执行（ProgressWindow 显示在主窗口）；无论成败这里都恢复
    // 按钮并重新检测，失败时状态行回到「未检测到」引导重试，主窗口另有无
    // 障碍的失败说明与手动下载页。
    Promise.resolve()
      .then(function () {
        return api.install();
      })
      .catch(function (e) {
        try {
          Zotero.debug(
            "[Z-Transplit] preferences: java install failed: " + e,
          );
        } catch (e2) {
          /* 忽略 */
        }
        return false;
      })
      .then(function () {
        javaInstallInFlight = false;
        setJavaButtonsDisabled(false);
        setJavaInstallLabel(false);
        return refreshJavaStatus();
      });
  }

  function cacheJavaStrings() {
    javaStrings.btnInstalling = javaString(
      "ztransplit-pref-string-java-btn-installing",
    );
    javaStrings.checking = javaString(
      "ztransplit-pref-string-java-status-checking",
    );
    javaStrings.statusInstalling = javaString(
      "ztransplit-pref-string-java-status-installing",
    );
    javaStrings.readyManaged = javaString(
      "ztransplit-pref-string-java-status-ready-managed",
    );
    javaStrings.readySystem = javaString(
      "ztransplit-pref-string-java-status-ready-system",
    );
    javaStrings.missing = javaString(
      "ztransplit-pref-string-java-status-missing",
    );
    javaStrings.statusError = javaString(
      "ztransplit-pref-string-java-status-error",
    );
    javaStrings.nobundle = javaString(
      "ztransplit-pref-string-java-status-nobundle",
    );
    javaInstallLabelBase = els.javaInstallBtn
      ? els.javaInstallBtn.getAttribute("label") || ""
      : "";
  }

  // ── 解析组件：状态检测 + 下载/修复 ─────────────────────────────────────
  // 与 Java 运行库小节同一套路：检测与下载走主包暴露的 Zotero.ZTransplit.odlJar
  // （面板沙箱无法 import 主包模块）。检测只读磁盘（对约 24MB 组件做一次哈希
  // 核对，亚秒级），同样只在点击按钮时执行。下载失败后主包在会话内不再自动
  // 重试，这个按钮是唯一的手动重试入口，因此失败时把错误细节直接上墙。

  var odlStrings = {};
  /** 「下载 / 修复」按钮的原始 label，下载中态结束后恢复。 */
  var odlDownloadLabelBase = "";
  var odlCheckInFlight = false;
  var odlDownloadInFlight = false;

  function odlApi() {
    try {
      var zt = Zotero && Zotero.ZTransplit;
      var api = zt && zt.odlJar;
      if (
        api &&
        (typeof api.getStatus === "function" ||
          typeof api.install === "function")
      ) {
        return api;
      }
    } catch (e) {
      /* 主包未挂载 */
    }
    return null;
  }

  function setOdlStatusText(text) {
    if (els.odlStatus) els.odlStatus.textContent = text;
  }

  function setOdlButtonsDisabled(disabled) {
    [els.odlCheckBtn, els.odlDownloadBtn].forEach(function (btn) {
      if (!btn) return;
      try {
        if (disabled) btn.setAttribute("disabled", "true");
        else btn.removeAttribute("disabled");
      } catch (e) {
        /* 忽略 */
      }
    });
  }

  function setOdlDownloadLabel(downloading) {
    if (!els.odlDownloadBtn) return;
    var label = downloading ? odlStrings.btnDownloading : odlDownloadLabelBase;
    if (label) {
      try {
        els.odlDownloadBtn.setAttribute("label", label);
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  /** 读取 getStatus() 的结果并回显到状态行。 */
  function refreshOdlStatus() {
    var api = odlApi();
    if (!api || typeof api.getStatus !== "function") {
      setOdlStatusText(odlStrings.nobundle);
      return Promise.resolve();
    }
    setOdlStatusText(odlStrings.checking);
    return Promise.resolve()
      .then(function () {
        return api.getStatus();
      })
      .then(function (status) {
        if (status && status.present) {
          var template =
            status.source === "landed"
              ? odlStrings.readyLanded
              : odlStrings.readyBundled;
          setOdlStatusText(
            fillJavaTemplate(template, {
              version: (status && status.version) || "?",
            }),
          );
        } else {
          // 「缺失」与「副本存在但指纹不符」都引导到下载/修复：后者在下次
          // 解析时也会自动重新获取，按钮只是把修复提前。
          setOdlStatusText(odlStrings.missing);
        }
      })
      .catch(function (e) {
        setOdlStatusText(
          fillJavaTemplate(odlStrings.statusError, {
            detail: String((e && e.message) || e),
          }),
        );
      });
  }

  function onOdlCheck() {
    if (odlCheckInFlight) return;
    odlCheckInFlight = true;
    var done = function () {
      odlCheckInFlight = false;
    };
    refreshOdlStatus().then(done, done);
  }

  function onOdlDownload() {
    if (odlDownloadInFlight) return;
    var api = odlApi();
    if (!api || typeof api.install !== "function") {
      setOdlStatusText(odlStrings.nobundle);
      return;
    }
    odlDownloadInFlight = true;
    setOdlButtonsDisabled(true);
    setOdlDownloadLabel(true);
    setOdlStatusText(odlStrings.statusDownloading);
    // 下载在主包内执行（ProgressWindow 显示在主窗口）；无论成败这里都恢复
    // 按钮。失败时状态行显示错误细节（多为网络原因），不再用缺失引导覆盖。
    Promise.resolve()
      .then(function () {
        return api.install();
      })
      .catch(function (e) {
        try {
          Zotero.debug(
            "[Z-Transplit] preferences: component download failed: " + e,
          );
        } catch (e2) {
          /* 忽略 */
        }
        setOdlStatusText(
          fillJavaTemplate(odlStrings.downloadFailed, {
            detail: String((e && e.message) || e),
          }),
        );
        return null;
      })
      .then(function (failed) {
        odlDownloadInFlight = false;
        setOdlButtonsDisabled(false);
        setOdlDownloadLabel(false);
        if (failed === null) return undefined;
        return refreshOdlStatus();
      });
  }

  function cacheOdlStrings() {
    odlStrings.btnDownloading = javaString(
      "ztransplit-pref-string-odl-comp-btn-downloading",
    );
    odlStrings.checking = javaString(
      "ztransplit-pref-string-odl-comp-status-checking",
    );
    odlStrings.statusDownloading = javaString(
      "ztransplit-pref-string-odl-comp-status-downloading",
    );
    odlStrings.readyLanded = javaString(
      "ztransplit-pref-string-odl-comp-status-ready-landed",
    );
    odlStrings.readyBundled = javaString(
      "ztransplit-pref-string-odl-comp-status-ready-bundled",
    );
    odlStrings.missing = javaString(
      "ztransplit-pref-string-odl-comp-status-missing",
    );
    odlStrings.statusError = javaString(
      "ztransplit-pref-string-odl-comp-status-error",
    );
    odlStrings.downloadFailed = javaString(
      "ztransplit-pref-string-odl-comp-download-failed",
    );
    odlStrings.nobundle = javaString(
      "ztransplit-pref-string-odl-comp-status-nobundle",
    );
    odlDownloadLabelBase = els.odlDownloadBtn
      ? els.odlDownloadBtn.getAttribute("label") || ""
      : "";
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
    els.aiProviderList = $("ztransplit-pref-ai-provider");
    els.aiUrlInput = $("ztransplit-pref-ai-url");
    els.aiKeyInput = $("ztransplit-pref-ai-key");
    els.aiModelInput = $("ztransplit-pref-ai-model");
    els.aiTestBtn = $("ztransplit-pref-ai-test-btn");
    els.aiTestStatus = $("ztransplit-pref-ai-test-status");
    els.regionList = $("ztransplit-pref-region");
    els.regionNote = $("ztransplit-pref-region-note");
    els.pdfTranslateItem = $("ztransplit-pref-engine-item-pdftranslate");
    els.aiPromptInput = $("ztransplit-pref-ai-prompt");
    els.aiPromptError = $("ztransplit-pref-ai-prompt-error");
    els.javaCheckBtn = $("ztransplit-pref-pdf-java-check");
    els.javaInstallBtn = $("ztransplit-pref-pdf-java-install");
    els.javaStatus = $("ztransplit-pref-pdf-java-status");
    els.odlCheckBtn = $("ztransplit-pref-odl-comp-check");
    els.odlDownloadBtn = $("ztransplit-pref-odl-comp-download");
    els.odlStatus = $("ztransplit-pref-odl-comp-status");

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
    var dataDirLabel = $("ztransplit-pref-string-datadir");
    if (dataDirLabel && dataDirLabel.textContent) {
      dataDirPlaceholder = String(dataDirLabel.textContent).trim();
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
    if (els.regionList) {
      // 与引擎下拉同理两个事件都听；onRegionPicked 幂等（重复套用第二次
      // 起不再有键可写）。
      els.regionList.addEventListener("select", onRegionPicked);
      els.regionList.addEventListener("command", onRegionPicked);
    }
    if (els.aiProviderList) {
      // 服务商下拉是「动作」而非「状态」：没有 preference 绑定，选中即填
      // 字段。两个事件都听，与引擎/区域同一套路。
      els.aiProviderList.addEventListener("select", onAiProviderPicked);
      els.aiProviderList.addEventListener("command", onAiProviderPicked);
    }
    if (els.aiTestBtn) {
      els.aiTestBtn.addEventListener("command", onAiTest);
    }
    if (els.javaCheckBtn) {
      // XUL button 的激活事件是 command。
      els.javaCheckBtn.addEventListener("command", onJavaCheck);
    }
    if (els.javaInstallBtn) {
      els.javaInstallBtn.addEventListener("command", onJavaInstall);
    }
    if (els.odlCheckBtn) {
      els.odlCheckBtn.addEventListener("command", onOdlCheck);
    }
    if (els.odlDownloadBtn) {
      els.odlDownloadBtn.addEventListener("command", onOdlDownload);
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

      // 服务商下拉按已填地址反查：老用户（或从别处粘贴了地址的用户）打开
      // 面板时，下拉状态与配置保持一致，不会显示成一个误导性的「不预设」。
      if (els.aiProviderList) {
        try {
          els.aiProviderList.value = detectAiPresetId(
            String(getPref("translate.ai.apiUrl") || ""),
          );
        } catch (e) {
          /* 忽略：反查失败只影响回显 */
        }
      }
      loadAiTestStrings();

      syncEngineFields();
      syncPDFTranslateStatus();

      cacheJavaStrings();
      cacheOdlStrings();

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
