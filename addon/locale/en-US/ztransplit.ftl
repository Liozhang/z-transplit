## Z-Transplit — core strings.
##
## Message ids are written WITHOUT the `ztransplit-` prefix on purpose:
## zotero-plugin-scaffold's build.fluent (prefixFluentMessages, default on)
## prefixes every message with `${namespace}-` when it copies these files into
## the build output, and src/utils/locale.ts reads them back with the same
## `${addonRef}-` prefix. Don't hand-add the prefix here.
##
## The zh-CN locale (addon/locale/zh-CN/) must keep the exact same key set —
## Zotero picks a plugin locale per file and falls back to en-US.

## Engine errors and hints (src/core/translation/translationEngines.ts)
## Key names follow leadero's translation-error-* naming; the AI-engine
## variants are gone with the "ai" engine (the custom engine absorbed it).
translation-error-google-empty = Google Translate returned an empty result
translation-error-bing-empty = Bing Translator returned an empty result
translation-error-deepl-empty = DeepL returned an empty result
translation-error-custom-empty = Custom API returned an empty result
translation-error-google-failed = Google translation failed
translation-error-bing-failed = Bing translation failed
translation-error-deepl-failed = DeepL translation failed
translation-error-custom-failed = Custom API translation failed
translation-error-pdf-translate-failed = zotero-pdf-translate translation failed
translation-error-bing-not-configured = Bing translation has no API key configured
translation-error-deepl-not-configured = DeepL translation has no API key configured
translation-error-custom-url-missing = Custom translation API URL is not configured
translation-error-google-fallback-failed = Google translation failed ({ $googleError }); the Bing fallback also failed ({ $bingError })
translation-error-unknown = Unknown error
translation-error-bing-token-unavailable = Could not obtain the Bing translation token (the page structure may have changed)
translation-error-bing-rejected = Bing rejected the request ({ $status })
translation-error-pdf-translate-missing = The zotero-pdf-translate plugin is not installed or not enabled. Install and enable it in Zotero's plugin manager.

## Translation feature readiness (src/core/translation/featureReadiness.ts)
readiness-reason-engine-key = Translation engine API key is missing
readiness-reason-engine-url = Custom translation endpoint URL is missing
readiness-reason-engine-plugin = The zotero-pdf-translate plugin is not installed or not enabled
readiness-reason-unknown = Unknown reason

## Split view menus (src/core/pdf/splitview/splitViewFactory.ts)
splitview-menu-compare = Split-screen comparison (no translation)
splitview-menu-translate = Translate and open side by side
splitview-menu-cancel = Cancel translation in progress

## OpenDataLoader pipeline errors (src/core/pdf/splitview/splitViewFactory.ts)
odl-error-java-missing = Translation requires Java 11 or later.
odl-error-jar-missing = The OpenDataLoader parsing component is missing (jar file not found). Please reinstall the plugin.
odl-error-file-path = Invalid file path: the PDF or Java path is not valid. Check the Zotero data directory permissions, or restart Zotero.
odl-error-network = { $detail }
odl-error-not-configured = Translation is not configured. Pick a translation engine and fill in its credentials in Zotero's Z-Transplit settings.
odl-error-parse-empty = { $detail }

## Split view errors and progress (splitViewFactory / readerPaneAdapter /
## splitViewCleanup)
splitview-error-open = Could not open the split view: { $detail }
splitview-error-tab-create = Failed to create the split-view tab (container not ready).
splitview-error-container-timeout = The split-view container ({ $tabID }) did not appear in the DOM within 2 s.
splitview-error-reader-timeout = The reader did not finish initializing within 10 s; the split view was aborted.
splitview-error-scroll-timeout = The split-view readers' scroll areas did not become ready in time; page sync is unavailable.
splitview-progress-reused = Reused the existing translation (attachment { $attachmentId })

## Item tree context menu progress (src/modules/registerItemTreeMenu.ts)
itemtree-progress-attachment = Z-Transplit: Translating full text…
itemtree-dedup-open = An existing translation was found — opening it.
itemtree-split-reuse = An existing translation was found — opening side by side.
itemtree-open-failed = Could not open the translated attachment automatically. Open it manually from the item.

## Java runtime install flow (splitViewFactory / JavaRuntimeManager)
java-dialog-title = Java required
java-dialog-body =
    Java 11 or later is required for "Translate and open side by side".

    Click OK to download and install Java automatically (about 40 MB, extracted
    into the plugin's data directory — no administrator rights needed), or click
    Cancel and download it manually from https://adoptium.net.
java-progress-install = Installing the Java runtime…
java-progress-download-prepare = Preparing download…
java-progress-retry = ✓ Java installed. Click "Translate and open side by side" again.
java-install-failed =
    Java installation failed: { $detail }
    Please download and install it manually from https://adoptium.net, then retry.
java-progress-already-installed = The Java runtime is already installed.
java-progress-download-start = Downloading Java { $version } JRE ({ $archive })…
java-progress-downloading = Downloading… { $percent }%
java-error-download-failed = Download failed: { $detail }
java-error-download-http = Download failed: HTTP { $status }
java-progress-extracting = Extracting…
java-progress-verifying = Verifying the installation…
java-error-extract-failed = Extraction failed: { $detail }
java-error-exe-not-found = No java executable found after extraction (in { $dir }). Please install Java manually from https://adoptium.net.
java-error-probe-failed = The downloaded Java failed to run: { $detail }
java-progress-done = Java installation complete

## OpenDataLoader pipeline progress and errors
## (opendataloaderSplitAdapter / splitViewFactory / registerItemTreeMenu)
odl-progress-translating = Z-Transplit: Translating with OpenDataLoader…
odl-error-dialog-title = Translate and split (OpenDataLoader)
odl-progress-preparing = Preparing…
odl-progress-done-split = Done: opened side by side (attachment { $attachmentId })
odl-progress-cancelled = Translation cancelled
odl-error-engine-not-ready = The translation engine is not fully configured: { $gaps }. Complete the settings in Z-Transplit preferences and retry.
odl-progress-parsing = Parsing the PDF layout…
odl-error-source-path = Could not resolve the source PDF file path.
odl-error-parse-failed = Parsing failed: { $detail }
odl-error-parse-no-pages = The PDF parse returned no pages (the file may be empty or a scanned image).
odl-error-parse-no-text = Parsing finished but no text paragraphs were extracted (the PDF may be pure images).
odl-progress-formula-vlm = Extracting formulas with the vision model ({ $count } blocks)…
odl-progress-formula-novlm = { $count } formula blocks detected, but no vision model is configured; formulas will be translated as regular text (may be inaccurate).
odl-progress-font-missing = ⚠️ Could not find { $fontFile } or a system default font — translated text will show as "?". Place the font into { $assetsDir }
odl-progress-page = Translating page { $current }/{ $total } ({ $count } paragraphs)…
odl-progress-overlay = Overlaying the translation onto the original PDF (images, tables and layout preserved)…
odl-progress-render-white = Rendering the translation (white-page mode)…
odl-error-render-empty = Rendering produced no pages.
odl-progress-summary = Done: { $pages } pages, { $paragraphs } paragraphs
odl-progress-summary-failed = ; { $failed } paragraphs failed and keep the original text
odl-progress-summary-nosplit = Done: { $pages } pages, { $paragraphs } paragraphs (translation saved, but the split view failed to open)
odl-progress-opening-split = Opening the split view…
odl-error-no-split-opener = The split-view opener is unavailable (internal error: the split flow is missing openSplitView).
odl-error-reader-pdf-timeout = The reader's pdf.js did not become ready within 15 s.
odl-progress-crop-reader-missing-skip = Could not open a reader for formula screenshots; skipping formula extraction.
odl-progress-crop-reader-missing-text = Could not open a reader for formula screenshots; formulas will be handled as text.
odl-progress-crop-progress = Formula extraction progress: { $current }/{ $total }
odl-progress-crop-done = Formula extraction finished: { $ok } succeeded
odl-progress-crop-fallback = , { $count } fell back to screenshots
odl-progress-crop-failed = , { $count } failed and keep the original text
odl-progress-shot-progress = Formula screenshot progress: { $current }/{ $total }
odl-progress-shot-done = Formula screenshots finished: { $ok } succeeded
odl-progress-shot-failed = , { $count } failed

## Layout preserving renderer (LayoutPreservingRenderer.ts)
render-error-rotated-page = Rotated pages are not supported yet (/Rotate { $angle }°). Straighten the PDF before translating.
