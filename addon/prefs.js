// Default preferences for Z-Transplit.
//
// Keys are written out in full (extensions.zotero.ztransplit.*) so that this
// file is valid as-is: Zotero loads it through
// Services.scriptloader.loadSubScript(addon.getResourceURI("prefs.js"), { pref })
// and writes every entry into the DEFAULT branch (see Zotero.Plugins#
// setDefaultPrefs in chrome/content/zotero/xpcom/plugins.js).
//
// zotero-plugin-scaffold's build.prefs.prefix (see zotero-plugin.config.ts) is
// set to the same prefix and leaves already-prefixed keys unchanged
// (PrefsManager#getPrefsWithPrefix), so the source and the built copy agree.
//
// NOTE: this file is executed in a scope whose ONLY global is `pref()` — see
// setDefaultPrefs() in plugins.js, which loads it with
// `target: { pref(pref, value) { … } }`. Nothing else (Zotero, Services,
// window, document) is reachable from here, so the preference pane cannot be
// registered from this file. See the pane section at the bottom for where the
// pane lives and who registers it.

// Master switch for text translation in the reader / item pane.
// ON by default so a fresh install runs at full capability: the reader pane
// section registers immediately and every entry point is reachable. Users who
// want the plugin dormant can uncheck it in the preferences pane (the pane
// section then unregisters; the item-menu stays for re-enabling).
pref("extensions.zotero.ztransplit.translate.enabled", true);
// Translate automatically when a reader item/selection opens (needs
// translate.enabled).
pref("extensions.zotero.ztransplit.translate.auto", false);
// Upper bound of characters sent to the engine per request.
pref("extensions.zotero.ztransplit.translate.maxChars", 10000);

// 合并批量的输入上限（估算 token）。全文翻译与双语对照把多个段落合并成一次
// 模型请求，planTranslationChunks 按这个预算打包：下一段会超出预算时提前
// 收批（该批少带一个段落），而不是超限发送。
pref("extensions.zotero.ztransplit.translate.batchMaxTokens", 8192);

// Engine selection + per-engine credentials. Defaults mirror the values the
// translate pipeline is expected to read (single source of truth: this file).
pref("extensions.zotero.ztransplit.translate.engineType", "google");
pref("extensions.zotero.ztransplit.translate.google.apiKey", "");
pref("extensions.zotero.ztransplit.translate.bing.apiKey", "");
pref("extensions.zotero.ztransplit.translate.bing.region", "");
pref("extensions.zotero.ztransplit.translate.deepl.apiKey", "");
pref("extensions.zotero.ztransplit.translate.deepl.useFree", false);
pref("extensions.zotero.ztransplit.translate.custom.apiUrl", "");
pref("extensions.zotero.ztransplit.translate.custom.apiKey", "");
pref("extensions.zotero.ztransplit.translate.custom.model", "");

// AI 引擎（OpenAI 兼容 chat/completions + 用户自建 prompt 模板）。
// prompt 留空 = 使用内置默认模板（src/core/translation/promptTemplate.ts 的
// DEFAULT_AI_PROMPT，即 formulaPreservingPrompt 的模板化版本）：设置面板里的
// 「恢复默认模板」按钮写的就是空串，所以空值必须是合法值而不是错误。
pref("extensions.zotero.ztransplit.translate.ai.apiUrl", "");
pref("extensions.zotero.ztransplit.translate.ai.apiKey", "");
pref("extensions.zotero.ztransplit.translate.ai.model", "");
pref("extensions.zotero.ztransplit.translate.ai.prompt", "");

// Target language for PDF split-view translation ("" = follow Zotero locale).
// The reader translate pane overrides this per request; the PDF pipeline, the
// Zotero 10 bilingual interleave view (src/ui/bilingualControl.ts) and
// read-aloud of the translation all read it as their default target language.
// Declared here so the key is a first-class setting rather
// than an undeclared runtime read (leadero read it undeclared with a "zh-CN"
// fallback — same behaviour, now visible).
pref("extensions.zotero.ztransplit.translate.targetLanguage", "");

// OpenDataLoader parser options (src/core/pdf/OpenDataLoaderPdfClient.ts,
// src/core/pdf/opendataloader-pdf-parser.ts). Defaults mirror leadero's.
pref("extensions.zotero.ztransplit.pdfParser.opendataloader.enabled", true);
pref("extensions.zotero.ztransplit.pdfParser.opendataloader.tableEnable", "default");
pref("extensions.zotero.ztransplit.pdfParser.opendataloader.useStructTree", false);
pref("extensions.zotero.ztransplit.pdfParser.opendataloader.timeout", 300);
pref("extensions.zotero.ztransplit.pdfParser.opendataloader.returnImages", false);

// Persistent paragraph translation cache (src/core/translation/translationCache.ts).
// Content-addressed translation records under
// {DataDir}/ztransplit/translation-cache/, shared across sessions and output
// modes (full-text attachment / split view / bilingual interleave).
pref("extensions.zotero.ztransplit.translate.cache.enabled", true);
// Prune threshold in megabytes; pruning is LRU by last use, down to 70%.
pref("extensions.zotero.ztransplit.translate.cache.maxSizeMB", 200);

// Bilingual interleave view (src/core/pdf/sdt/, Zotero 10 reading mode).
// Default presentation when a bilingual session starts: off | interleave | transOnly.
pref("extensions.zotero.ztransplit.reader.bilingual.defaultMode", "interleave");
// Concurrent paragraph/batch translation requests inside the interleave view.
pref("extensions.zotero.ztransplit.reader.bilingual.concurrency", 2);

// Read-aloud (src/core/readAloud/). Empty voice = the system default voice.
pref("extensions.zotero.ztransplit.readAloud.rate", 1.0);
pref("extensions.zotero.ztransplit.readAloud.voice", "");

// Word cards (src/core/wordcards/wordCardStore.ts, src/ui/translatePane.ts).
// When on, a single-word reader selection is looked up as a dictionary card,
// every lookup is recorded under {DataDir}/ztransplit/word-cards/, and the
// pane shows a recent-words strip. Off = the pane keeps the plain-translation
// behaviour for word selections; the word-cards tab stays reachable and shows
// a disabled hint instead of cards.
pref("extensions.zotero.ztransplit.wordcards.enabled", true);

// ─── Preference pane ───────────────────────────────────────────────────────
// The Z-Transplit settings pane (编辑 → 设置 → Z-Transplit) is a Zotero 7
// native preference pane, i.e. an XUL fragment that Zotero.PreferencePanes
// loads into its own preferences window:
//
//   addon/content/preferences.xhtml   markup — XUL is the default namespace,
//                                     HTML tags are written `html:input` etc.
//                                     (Zotero_Preferences._loadPane parses
//                                     plugin panes with defaultXUL: true).
//                                     Three sections: 常规 / 翻译引擎 /
//                                     PDF 分屏翻译. Every control is bound to
//                                     one of the prefs above with a
//                                     `preference="extensions.zotero.ztransplit.…"`
//                                     attribute (Zotero's own two-way binding
//                                     in _initImportedNodesPostInsert), except
//                                     translate.maxChars, which is validated in
//                                     JS so an empty value can never reach
//                                     Zotero.Prefs.set() on an INT pref.
//   addon/content/preferences.js      behaviour — engine field visibility,
//                                     key show/hide, maxChars / ODL timeout
//                                     validation (on blur an invalid value
//                                     restores the stored one without writing
//                                     the pref), and the in-pane
//                                     zotero-pdf-translate probe
//                                     (same check as
//                                     src/core/translation/featureReadiness.ts
//                                     #hasPDFTranslatePlugin). Exposes
//                                     window.ZTransplitPrefs for the inline
//                                     oncommand/onload handlers, because the
//                                     pane script runs in a Cu.Sandbox whose
//                                     prototype is the window — top-level
//                                     declarations there are NOT window
//                                     properties.
//   addon/content/preferences.css     styling — loaded as a document-wide
//                                     xml-stylesheet by Zotero, so every rule
//                                     is scoped under #zotero-prefpane-ztransplit.
//   addon/locale/{en-US,zh-CN}/ztransplit-preferences.ftl
//                                     all pane copy, linked from the pane via
//                                     <linkset><html:link
//                                     rel="localization" …/></linkset>.
//
// Registration happens in addon/bootstrap.js#startup (the only file outside
// src/ that Zotero executes with a full Zotero/Services scope):
//
//   Zotero.PreferencePanes.register({
//     pluginID: "ztransplit@zotero.org",
//     src: "content/preferences.xhtml",
//     scripts: ["content/preferences.js"],
//     stylesheets: ["content/preferences.css"],
//     id: "zotero-prefpane-ztransplit",
//   });
//
// Relative URIs are resolved against the plugin root by
// Zotero.Plugins.resolveURI. If src/modules/registerPreferences.ts ever takes
// this over, the fixed pane id makes the second registration a no-op instead
// of a duplicate pane.
// ───────────────────────────────────────────────────────────────────────────
