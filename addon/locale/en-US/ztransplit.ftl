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
##
## Failure copy follows one shape: what happened, the likely cause, and what
## to do next. Never invent a cause; every next step must point at an entry
## that actually exists (a setting, a button or a menu item).

## Shared title (progress-window headlines / dialog titles)
app-title = Z-Transplit

## Engine errors and hints (src/core/translation/translationEngines.ts)
## Key names follow leadero's translation-error-* naming. The `ai-prompt-*`
## keys double as the template rejection reasons reported by
## src/core/translation/promptTemplate.ts (each rule has its own message, both
## for the runtime error and for the settings pane's inline hint).
translation-error-google-empty = Google Translate returned an empty result. This usually means the request was throttled or the language pair is unsupported. Retry later or switch engines.
translation-error-bing-empty = Bing Translator returned an empty result. This usually means the request was throttled or the language pair is unsupported. Retry later or switch engines.
translation-error-deepl-empty = DeepL returned an empty result. This usually means the request was throttled or the free-plan quota is exhausted. Retry later or switch engines.
translation-error-custom-empty = The custom API returned an empty result. This usually means the request was throttled, or the model's output budget was consumed by its reasoning. Raise the single-request output limit in the settings and retry.
translation-error-google-failed = Google translation failed. Check your connection and retry; if the network is fine, the service is likely temporarily unavailable — retry later or switch engines.
translation-error-bing-failed = Bing translation failed. Check your connection and key configuration, then retry.
translation-error-deepl-failed = DeepL translation failed. Check your connection and key configuration, then retry; free plans have a quota.
translation-error-custom-failed = Custom API translation failed. Check the endpoint URL, the key and your connection, then retry.
translation-error-pdf-translate-failed = zotero-pdf-translate translation failed. Check that plugin's translation service settings, or switch to one of this plugin's own engines.
translation-error-bing-not-configured = Bing translation has no API key configured. Fill in the key under Settings → Z-Transplit → Engine and retry.
translation-error-deepl-not-configured = DeepL translation has no API key configured. Fill in the key under Settings → Z-Transplit → Engine and retry.
translation-error-youdao-not-configured = Youdao translation has no app ID or app secret configured. Fill them in under Settings → Z-Transplit → Engine and retry.
translation-error-youdao-failed = Youdao translation failed. Check your connection and retry.
translation-error-youdao-empty = Youdao translation returned an empty result. This usually means the request was throttled — retry later.
translation-error-youdao-sign-unavailable = This environment cannot compute the request signature (no WebCrypto), so Youdao translation is unavailable. Switch to another engine.
translation-error-youdao-code-108 = Youdao translation failed: the app ID is invalid — check it in the Youdao console
translation-error-youdao-code-110 = Youdao translation failed: this app has no access to the text translation service — enable it in the console and try again
translation-error-youdao-code-202 = Youdao translation failed: the signature check failed — check the app secret
translation-error-youdao-code-206 = Youdao translation failed: the timestamp is invalid — check the system clock
translation-error-youdao-code-other = Youdao translation failed (error code { $code }). Check the app configuration, the balance and the service status in the Youdao console.
translation-error-youdao-rate-limited = Youdao translation failed: the endpoint is rate-limiting requests (error code { $code }) — waited and retried, still rejected. Try again later; for long documents, switch to the official Youdao engine or another engine in the settings
translation-error-custom-url-missing = The custom translation API URL is not configured. Fill it in under Settings → Z-Transplit → Engine.
translation-error-unknown = An unknown error occurred. Turn on debug output, reproduce it once, and report the log to the developers.
translation-error-bing-token-unavailable = Could not obtain the Bing translation token (the page structure may have changed). You can switch to the keyless Youdao engine for now and wait for a plugin update.
translation-error-bing-rejected = Bing rejected the request ({ $status }). This usually means the request was throttled or the token went stale — retry later; if it keeps happening, switch engines.
translation-error-pdf-translate-missing = The zotero-pdf-translate plugin is not installed or not enabled. Install and enable it in Zotero's plugin manager, or switch to one of this plugin's own engines.
translation-error-ai-empty = AI translation returned an empty result. The model's output budget was likely consumed by its reasoning — raise the single-request output limit in the settings and retry.
translation-error-ai-failed = AI translation failed. Check the endpoint URL, the key and your connection, then retry.
translation-error-ai-url-missing = The AI translation API URL is not configured. Pick a provider or fill in the URL under Settings → Z-Transplit → Engine.
translation-error-ai-bad-response = The AI engine returned content in an unexpected format. Retry; if it keeps failing, try a different model or check the provider's API documentation.
translation-error-rate-limited = The translation service is rate-limiting requests: waited as instructed and retried once, still rejected. Try again later or lower the batch translation concurrency.
translation-error-rate-limited-wait-too-long = The translation service is rate-limiting requests: the server asked for a wait longer than 120 seconds, so this attempt was abandoned. Try again later or lower the batch translation concurrency.

## AI engine prompt template rejections (src/core/translation/promptTemplate.ts)
translation-error-ai-prompt-too-long = The AI prompt template is too long (at most 4000 characters).
translation-error-ai-prompt-unknown-placeholder = The AI prompt template contains an unknown placeholder — only {"{{"}text{"}}"}, {"{{"}sourceLang{"}}"} and {"{{"}targetLang{"}}"} (double braces) are supported.
translation-error-ai-prompt-missing-text = The AI prompt template is missing {"{{"}text{"}}"} — that is where the text to translate goes.
translation-error-ai-prompt-duplicate-text = The AI prompt template contains {"{{"}text{"}}"} more than once — the source text may only be sent once.
translation-error-ai-prompt-missing-source-lang = The AI prompt template is missing {"{{"}sourceLang{"}}"} — that is where the source language name goes.
translation-error-ai-prompt-missing-target-lang = The AI prompt template is missing {"{{"}targetLang{"}}"} — that is where the target language name goes.
translation-error-ai-prompt-unbalanced-braces = The AI prompt template has unbalanced braces — placeholders use double braces ({"{{"}text{"}}"}) while formula markers use single braces ({"{"}v0{"}"}).

## Translation feature readiness (src/core/translation/featureReadiness.ts)
readiness-reason-engine-key = Translation engine API key is missing
readiness-reason-engine-url = Custom translation endpoint URL is missing
readiness-reason-ai-url = Missing AI translation endpoint (pick a provider in the settings to fill it in automatically)
readiness-reason-engine-plugin = The zotero-pdf-translate plugin is not installed or not enabled
readiness-reason-ai-prompt = The AI engine's prompt template is invalid — fix it in the settings pane
readiness-reason-unknown = Unknown reason

## Split view menus (src/core/pdf/splitview/splitViewFactory.ts)
splitview-menu-root = Z-Transplit
splitview-menu-compare = Split-screen reading
splitview-menu-translate = Split-screen translation
splitview-menu-interleave = Interlinear translation
splitview-menu-trans-only = Translation only
splitview-menu-cancel = Cancel translation in progress

## OpenDataLoader pipeline errors (src/core/pdf/splitview/splitViewFactory.ts)
odl-error-java-missing = Translation requires Java 11 or later. Click "Install / repair…" next to the Java runtime under Settings → Z-Transplit → PDF split translation to install it automatically (no administrator rights needed).
odl-error-jar-missing = The parsing component was not found. Click "Download / repair…" next to the parsing component under Settings → Z-Transplit → PDF split translation to fetch it again; if the file keeps disappearing, check your antivirus quarantine.
odl-error-jar-unreadable = The parsing component could not be read (Java cannot open the file). Retry in a moment; if it still fails, restart Zotero and try again.
odl-error-jar-unreadable-path = The parsing component could not be read (Java cannot open the file): { $path }. Retry in a moment; if it still fails and the path contains emoji or other special characters, move the Zotero data directory to a location without them.
odl-error-jar-corrupt = The parsing component file is corrupt (an incomplete download or it was rewritten). Click "Download / repair…" for the parsing component in the settings to fetch it again, then retry.
odl-error-jar-download-failed = The parsing component could not be downloaded automatically. Check the network, then click "Download / repair…" for the parsing component in the settings; if it keeps failing, use the full installer that bundles the component.
odl-error-parse-timeout = The PDF parse timed out. Long documents and slow machines hit this step: raise the parse timeout in the settings, or translate a page range instead.
odl-error-parse-disabled = PDF parsing is turned off in the settings. Enable "OpenDataLoader parsing" under Settings → Z-Transplit → PDF split translation and retry.
odl-jar-download-window = Downloading the OpenDataLoader parsing component
odl-jar-download-probe = Testing mirrors…
odl-jar-download-downloading = Downloading ({ $percent }%)
odl-jar-download-verifying = Verifying and installing…
odl-jar-download-done = ✓ The parsing component is ready
err-jar-load = Could not read the parsing component jar file (invalid path): { $path } ({ $message })
odl-error-file-path = Invalid file path — parsing cannot start. Make sure the PDF and the Zotero data directory sit on paths without special characters, and that the directory is writable.
odl-error-network = Network error: check your connection and proxy settings, then retry. ({ $detail })
odl-error-not-configured = Translation is not configured. Pick a translation engine and fill in its credentials under Settings → Z-Transplit → Engine.
odl-error-parse-empty = { $detail }
odl-error-http-auth = The translation service rejected the request (HTTP { $code }): the API key is invalid or lacks access. Check the key in the Z-Transplit settings.
odl-error-http-rate = The translation service is busy or the quota is exhausted (HTTP { $code }). Try again later.
odl-error-http-other = The translation service returned an error (HTTP { $code }): { $detail }

## Split view errors and progress (splitViewFactory / readerPaneAdapter /
## splitViewCleanup)
splitview-error-dialog-title = Split View (Z-Transplit)
splitview-error-open = Could not open the split view: { $detail }. Reopen this PDF and try again; if it still fails, restart Zotero.
splitview-error-tab-create = Failed to create the split-view tab (container not ready). Retry; if it still fails, restart Zotero.
splitview-error-container-timeout = The split-view tab did not become ready within 2 s. This can happen on a busy machine — retry; if it still fails, restart Zotero.
splitview-error-reader-timeout = The reader did not finish initializing within 10 s; the split view was aborted. This can happen on a busy machine — retry; if it still fails, restart Zotero.
splitview-error-scroll-timeout = The split-view readers' scroll areas did not become ready in time; page sync is unavailable. Retry; if it still fails, restart Zotero.
splitview-error-no-item = Could not resolve the PDF attachment for the current reader. Reopen the item and try again.
splitview-error-in-flight = A translation is already in progress. Use "Cancel translation in progress" in the reader context menu.
splitview-progress-reused = Reused the existing translation "{ $title }"
splitview-tab-title = { $left } | { $right }

## Item tree context menu progress (src/modules/registerItemTreeMenu.ts)
itemtree-progress-attachment = Z-Transplit: Translating full text…
itemtree-dedup-open = An existing translation was found — opening it.
itemtree-split-reuse = An existing translation was found — opening side by side.
itemtree-open-failed = Could not open the translated attachment automatically. Open it manually from the item.
itemtree-interleave = Interlinear translation
itemtree-trans-only = Translation only
itemtree-launch-progress = Z-Transplit: preparing bilingual overlay…
itemtree-launch-done = Bilingual overlay ready
itemtree-launch-no-reader = Could not resolve an open reader for this item. Reopen the PDF and try again.
itemtree-pages-prompt-title = Translate page range
itemtree-pages-prompt-text = Enter the pages to translate, e.g. 1-3,7. Pages outside the range are kept as-is in the output.
itemtree-pages-invalid = Invalid page range: enter pages or ranges, e.g. 1-3,7.
odl-error-page-range = Page out of range: this document has { $count } pages.

## Translated attachment (src/core/pdf/translation/translatedAttachment.ts)
translated-tag = Translated

## Java runtime install flow (splitViewFactory / JavaRuntimeManager)
java-dialog-title = Java required
java-dialog-body =
    Java 11 or later is required for "Translate and open side by side".

    "Download and install": fetches the ~40 MB Java runtime and extracts it
    into the plugin's data directory — no administrator rights needed.
    "Open download page": opens https://adoptium.net in your browser so you
    can install manually.
    "Cancel": do nothing for now.
java-dialog-button-download = &Download and install
java-dialog-button-openpage = &Open download page
java-dialog-button-cancel = Cancel
java-progress-install = Installing the Java runtime…
java-progress-download-prepare = Preparing download…
java-progress-retry = ✓ Java installed. Click "Translate and open side by side" again.
java-install-failed =
    Java installation failed: { $detail }
    Check your connection and retry "Install / repair…" in the settings, or install it manually from https://adoptium.net.
java-progress-already-installed = The Java runtime is already installed.
java-progress-self-heal = The managed Java runtime is broken — reinstalling automatically…
java-progress-download-start = Downloading Java { $version } JRE ({ $archive })…
java-progress-probe = Selecting a download source…
err-java-not-found = No usable Java runtime was found. Click "Install / repair…" next to the Java runtime under Settings → Z-Transplit → PDF split translation to install a portable one (no administrator rights needed), or install Java 11 or later yourself.
java-progress-downloading = Downloading… { $percent }%
java-progress-reuse-archive = Reusing the previously downloaded archive (checksum verified) — skipping the download…
java-error-download-failed = Download failed: { $detail }. Check your connection and proxy settings, then retry.
java-error-checksum-mismatch = Installer archive failed checksum verification (SHA-256 mismatch) and was discarded. This usually means an incomplete download or a network problem — please retry.
java-progress-extracting = Extracting…
java-progress-verifying = Verifying the installation…
java-error-extract-failed = Extraction failed: { $detail }. Make sure the disk has enough space, the data directory is writable, and security software is not blocking the extraction — then retry.
java-error-exe-not-found = No java executable found after extraction (in { $dir }). Please install Java manually from https://adoptium.net.

## AI engine "Test connection" result classes (src/core/ai/connectionTest.ts)
ai-test-ok = Connection succeeded: model { $model } responded ({ $ms } ms).
ai-test-auth = Key rejected (401/403). Check the API key; local providers (Ollama, etc.) may leave it empty. If the key is correct, check your account status in the provider's console. Detail: { $detail }
ai-test-not-found = Endpoint not found (404). Check the provider selection, the URL itself, and whether it needs a /v1 suffix. Detail: { $detail }
ai-test-rate-limit = Rate limited (429), please retry later; if it keeps happening, check your quota and balance in the provider's console. Detail: { $detail }
ai-test-network = Cannot reach the endpoint: { $detail }. It may be unreachable, or a proxy may be required.
ai-test-timeout = Connection timed out ({ $ms } ms). The endpoint is unreachable, or a proxy is required.
ai-test-http = Server returned an error (HTTP { $status }): { $detail }. 400 usually means an unsupported parameter; 500 and 503 mean a server-side failure — retry later.
ai-test-empty = The endpoint responded, but the model returned no content. Try a different model name, or raise the single-request output limit in the settings.
ai-test-invalid = Fill in the endpoint URL first, then test.
ai-test-server-default = server default
java-error-probe-failed = The downloaded Java failed to run: { $detail }. Security software may have blocked it, or the extraction was incomplete — retry "Install / repair…"; if it still fails, install Java manually from https://adoptium.net.
java-progress-done = Java installation complete

## OpenDataLoader pipeline progress and errors
## (opendataloaderSplitAdapter / splitViewFactory / registerItemTreeMenu)
odl-progress-translating = Z-Transplit: Translating full text…
odl-error-dialog-title = Translate and split (OpenDataLoader)
odl-progress-preparing = Preparing…
odl-progress-done-split = Done: opened side by side — "{ $title }"
odl-progress-cancelled = Translation cancelled
odl-error-engine-not-ready = The translation engine is not fully configured: { $gaps }. Complete it under Settings → Z-Transplit → Engine and retry.
odl-progress-parsing = Parsing the PDF layout…
odl-error-source-path = Could not resolve the source PDF file path. The attachment may have been moved, deleted, or not yet downloaded — open it in Zotero to confirm it works.
odl-error-parse-failed = The PDF parse failed: { $detail }. Retry; if it keeps failing, click "Download / repair…" for the parsing component in the settings first, then check the debug output and report the issue.
odl-error-parse-no-pages = The PDF parse returned no pages: the file may be empty, corrupt, encrypted, or a pure scan.
odl-error-parse-no-text = Parsing finished but no text paragraphs were extracted. This PDF may be a pure image scan: enable "Scanned-page recognition" in the settings and install the recognition environment; if it is not a scan, check whether the file is corrupt.
odl-progress-formula-vlm = Extracting formulas with the vision model ({ $count } blocks)…
odl-progress-formula-novlm = { $count } formula blocks detected, but no vision model is configured; formulas will be translated as regular text (may be inaccurate). Configure an OpenAI-compatible endpoint in the settings and translate again.
odl-progress-font-missing = ⚠️ Could not find { $fontFile } or a system default font — translated text will show as "?". Place the font into { $assetsDir }
odl-progress-page = Translating page { $current }/{ $total } ({ $count } paragraphs)…
odl-progress-overlay = Overlaying the translation onto the original PDF (images, tables and layout preserved)…
odl-progress-remove-original = Removing the original text of translated paragraphs…
odl-progress-remove-original-ineffective = The original text could not be removed from the page content stream — covering it with a mask instead.
odl-progress-merging = An existing translated attachment was found — merging this run into it…
odl-progress-merged = Merged into the existing translation: { $count } pages replaced in place. Reopen an open split view to see the new content.
odl-progress-render-white = Rendering the translation (white-page mode)…
odl-error-render-empty = Rendering produced no pages. Retry; if it still fails, restart Zotero and try again — if the problem persists, check the debug output and report the issue.
odl-progress-summary = Done: { $pages } pages, { $paragraphs } paragraphs
odl-progress-summary-failed = ; { $failed } paragraphs failed and keep the original text (usually network or engine issues — translating again retries them)
odl-progress-summary-nosplit = Done: { $pages } pages, { $paragraphs } paragraphs (translation saved, but the split view failed to open)
odl-progress-opening-split = Opening the split view…
odl-error-no-split-opener = The translation was produced, but the split-view component is unavailable (internal error). The translated attachment is saved and can be opened directly; please report this issue to the developers.
odl-progress-crop-reader-missing-skip = Could not open a reader for formula screenshots; skipping formula extraction.
odl-progress-crop-reader-missing-text = Could not open a reader for formula screenshots; formulas will be handled as text.
odl-progress-crop-progress = Formula extraction progress: { $current }/{ $total }
odl-progress-crop-done = Formula extraction finished: { $ok } succeeded
odl-progress-crop-failed = , { $count } failed and keep the original text
odl-progress-shot-progress = Formula screenshot progress: { $current }/{ $total }
odl-progress-shot-done = Formula screenshots finished: { $ok } succeeded
odl-progress-shot-failed = , { $count } failed

## Scanned-page recognition pipeline (src/core/pdf/scan/**)
scan-progress-start = Recognizing scanned pages ({ $pages } pages)…
scan-progress-resumed = Reusing { $pages } page(s) recognized last time; only the rest need recognition…
scan-progress-batch = Recognized batch { $done }/{ $total }
scan-progress-retry = Batch { $batch } has { $pages } page(s) with little content, retrying at higher resolution…
scan-progress-summary = Scanned-page recognition done: { $recognized } page(s) with content, { $empty } empty, { $skipped } skipped
scan-progress-summary-resumed = ({ $resumed } reused from the last run)
scan-progress-summary-suspect = , { $suspect } still sparse (results kept)
scan-error-sidecar-unconfigured = Scanned pages need recognition, but the recognition environment is not installed yet. Click "Install the recognition environment" in the settings; once installed, these pages are recognized automatically on the next translation — this run keeps their original text.
scan-error-sidecar-failed = The recognition environment is installed, but this run produced no results. Translate again to retry; if it keeps failing, check the debug output or click "Repair (reinstall)…" in the settings to rebuild the environment.
scan-error-disabled = Scanned-page recognition is turned off in the settings; these pages keep their original text. Enable "Scanned-page recognition" in the settings if you need it.
scan-error-rotated-skipped = The scanned document contains rotated pages; they were skipped and keep their original text. To recognize them, straighten the pages, save a new copy, and translate again.

## Python runtime distribution for the recognition sidecar (src/core/pdf/scan/pythonRuntime.ts)
py-progress-window = Installing the recognition runtime
py-progress-checksum = Fetching the artifact checksum list…
py-progress-probing = Probing available mirrors…
py-progress-downloading = Downloading the runtime ({ $percent }%)
py-progress-verifying = Verifying the artifact fingerprint…
py-progress-extracting = Extracting and probing…
py-progress-done = The recognition runtime is installed
py-status-not-installed = Not installed
py-error-install-failed = Installing the recognition runtime failed. Check your connection and retry; if it keeps failing, make sure the disk has enough space and click "Install / repair…" again.
py-error-unsupported-platform = No recognition runtime artifact is available for this platform. You can configure the recognition sidecar command manually as described in the development docs.
py-error-manifest-unavailable = The runtime manifest is missing or corrupt. Reinstall the plugin
py-error-checksum-unavailable = This platform's artifact is absent from the checksum list; the install was stopped. Update the plugin or use the full installer, and report the issue if it persists.

## One-click recognition environment install (src/core/pdf/scan/sidecarEnv.ts)
sidecar-progress-window = Installing the scanned-page recognition environment
sidecar-progress-runtime = Installing the Python runtime…
sidecar-progress-script = Deploying the recognition script…
sidecar-progress-dependencies = Installing recognition dependencies (the first install downloads a few hundred MB and may take several to a dozen minutes)…
sidecar-progress-selftest = Building the recognition engines and self-checking (the first run downloads the model weights)…
sidecar-progress-done = The recognition environment is installed and the command is filled in
sidecar-status-deps-missing = Recognition dependencies are not installed. Click "Install the recognition environment".
sidecar-status-command-missing = Dependencies are installed, but the recognition sidecar command is not filled in. Click "Install the recognition environment" — the command is filled in for you.
sidecar-error-bundle-missing = The plugin package is missing { $file }. Reinstall the plugin
sidecar-error-no-mirror = None of the Python package sources is reachable. Check your connection and try again
sidecar-error-pip = Installing the recognition dependencies failed: { $detail }. Check your connection and proxy; if it keeps failing, make sure the disk has enough space and click "Repair (reinstall)…".
sidecar-error-selftest = The recognition engine self-check did not pass: { $detail }. This may mean low memory or an incompatible machine — retry once; if it still fails, please report this message to the developers.
sidecar-error-timeout = The recognition environment install did not finish within { $minutes } minutes. This is usually a slow connection or restricted model downloads — check your connection and retry.
sidecar-error-pref-write = The recognition environment is ready, but writing the command to the settings failed. Fill the recognition sidecar command in by hand: { $command }

## Reader session (src/core/pdf/scan/readerAccess.ts)
err-reader-pdf-timeout = The reader's pdf.js did not become ready within 15 s.

## Layout preserving renderer (LayoutPreservingRenderer.ts)

## Dictionary card lookup chain (src/core/translation/dictionaryCard.ts)
dictionary-error-all-failed = Dictionary lookup failed: neither the dictionary nor the configured translation engines returned a result ({ $error }). Check your connection and engine configuration, then retry.
dictionary-error-unavailable = Dictionary lookup is unavailable right now, please retry.
