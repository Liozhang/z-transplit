## Z-Transplit — reader pane strings.
##
## Message ids are written WITHOUT the `ztransplit-` prefix: the build prefixes
## them (see ztransplit.ftl for why), and src/utils/locale.ts#getLocaleID adds
## the same prefix back when reading them from code.
##
## Consumers:
##   - src/modules/registerTranslateUI.ts — item pane section header/sidenav
##     (NOTE: that module passes the *fully prefixed* id, e.g.
##     `ztransplit-pane-translate`, because it goes through Fluent's DOM
##     overlay via data-l10n-id, not through src/utils/locale.ts).
##   - src/ui/translatePane.ts — every button / placeholder / status line
##     (passes the bare id; getString prefixes it).
##
## The zh-CN locale (addon/locale/zh-CN/) must keep the exact same key set —
## Zotero picks a plugin locale per file and falls back to en-US.

## Pane shell
pane-title = Translate
pane-translate = Translate
pane-translate-sidenav = Translate selected text

## ─── Reader translate pane (src/ui/translatePane.ts) ────────────────────────
## Three-block layout: source text → language bar → result area.

## Block 1 — source text
pane-translate-source = Source text
pane-translate-refresh = Refresh selection
pane-translate-placeholder = Select text in the PDF reader and it will appear here.
pane-translate-empty-selection = The current reader has no selected text. Select some, then click "Refresh selection".
pane-translate-no-reader = No active reader detected: open a PDF first, then use this pane.
pane-translate-selection-unsupported = This Zotero version does not expose the reader selection API (_selectionRanges), so the selection cannot be read. Please upgrade to Zotero 7.

## Block 2 — language bar
pane-translate-lang-auto = Detect automatically
pane-translate-target-placeholder =
    .placeholder = Target language, e.g. en-US

## Block 3 — result area (four states: loading / error / success / idle)
pane-translate-action = Translate
pane-translate-translating = Translating…
pane-translate-copy = Copy
pane-translate-copied = Copied
pane-translate-retry = Retry
pane-translate-copy-failed = Copy failed: { $error }
pane-translate-error = Translation failed: { $error }
pane-translate-error-empty = Empty translation: the service returned nothing usable. Try again, or pick a different target language.
pane-translate-error-service = Translation service unavailable: could not load the engine module ({ $error }). Restart Zotero and try again; if it still fails, check Zotero's debug output.
pane-translate-error-not-ready = Translation is not ready: { $reason }. Complete the setup in the settings and try again.
pane-translate-error-too-long = The selection is { $count } characters, above the { $max }-character limit per request. Narrow the selection and try again.

## Single-word lookup (dictionary card) and the recent-words chip strip
pane-translate-lookup-action = Look up
pane-translate-looking-up = Looking up…
pane-translate-recent = Recent words
pane-translate-card-source-youdao = Source: Youdao Dictionary
pane-translate-card-source-model = Source: model engine
pane-translate-card-source-mt = Source: translation engine

## ─── Word-cards tab (src/ui/wordCardsTab.ts + src/modules/registerWordCardsUI.ts)
wordcards-tab-title = Word Cards
wordcards-toolbar-tooltip = Word cards (words you looked up)
wordcards-search-placeholder =
    .placeholder = Search words or meanings
wordcards-sort-recent = Recent
wordcards-sort-alpha = Alphabetical
wordcards-clear = Clear all
wordcards-clear-confirm = Clear all word cards?
wordcards-count = { $count } cards
wordcards-empty-title = No word cards yet
wordcards-empty-hint = Select a single word in the PDF reader — every lookup accumulates into a card here.
wordcards-disabled-hint = Word card recording is turned off in the settings; new lookups accumulate again once it is re-enabled.
wordcards-history = Lookup history
wordcards-delete = Delete
wordcards-detail-empty = Select a card on the left to see its details.
wordcards-no-match = No matching cards.

## ─── Library item context menu (src/modules/registerItemTreeMenu.ts) ──────
itemtree-menu = Z-Transplit
itemtree-translate-attachment = Translate full text (save as attachment)
itemtree-translate-split = Translate and compare side by side

## ─── Bilingual reading (src/ui/bilingualControl.ts + src/core/pdf/sdt/) ───
bilingual-enable = Bilingual
bilingual-exit = Exit bilingual
bilingual-mode-interleave = Interleaved (original + translation)
bilingual-mode-trans-only = Translation only
bilingual-progress = { $done }/{ $total } paragraphs translated
bilingual-placeholder = Translating…
bilingual-block-failed = Translation failed
bilingual-retry = Retry
bilingual-sdt-loading = Preparing the document structure…
bilingual-sdt-unavailable = Bilingual reading requires the Zotero 10 reading mode. Still available here: side-by-side split view and full-text translation to attachment.
bilingual-sdt-missing = The document-structure session could not be established; bilingual reading is unavailable. The split view and full-text translation remain available.
bilingual-sdt-unpack-failed = The document structure is unavailable ({ $error }). The split view and full-text translation remain available.

## ─── Read aloud (src/core/readAloud/) ──────────────────────────────────────
readaloud-original = Read original
readaloud-translation = Read translation
readaloud-pause = Pause
readaloud-resume = Resume
readaloud-prev = Previous sentence
readaloud-next = Next sentence
readaloud-stop = Stop
readaloud-unsupported = Read aloud is unavailable in this environment (no speech interface). Install a system voice package and retry.
readaloud-no-content = There is no readable text.
readaloud-start-failed = Read aloud failed to start: { $error }

# Full-text pipeline progress / errors (batch translate + ODL client).
pdf-progress-batch-start = Batch translating {count} paragraphs ({chunks} chunk groups){cache}…
pdf-progress-batch-cache = , {hit} from cache
pdf-progress-batch-progress = Batch translation: {done}/{total} chunk groups
pdf-warn-vlm-unconfigured = Formula vision extraction unavailable: no OpenAI-compatible endpoint configured (translate.custom.apiUrl).
err-vlm-empty = Vision model returned an empty result
err-java-unavailable = Java unavailable: {detail}
err-parse-no-pages = Parsing finished but produced no pages
err-java-too-old = Detected Java {version}, but OpenDataLoader requires Java 11+. Install a newer version from https://adoptium.net.
err-jar-load = Failed to load JAR file ({path}): {message}
