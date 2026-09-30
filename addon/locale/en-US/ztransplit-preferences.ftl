## Z-Transplit — preferences pane copy (Edit → Settings → Z-Transplit).
##
## Message ids start with `preferences-ztransplit-`, mirroring Zotero's own
## `preferences-*` convention while avoiding collisions with Zotero's message
## ids (plugin FTLs share one Fluent registry with Zotero's — see
## Zotero.Plugins#registerLocales).
##
## Message ids are written WITHOUT the leading `ztransplit-` prefix: the build
## adds it (zotero-plugin-scaffold's build.fluent, prefixFluentMessages default
## on) and reads it back the same way — see the header of ztransplit.ftl.
##
## Conventions:
##   - `<description>` and `<html:h2>` section headings use plain message values
##     (Fluent writes them into the text content);
##   - XUL `<label>` renders its `value` attribute, never the text content, so
##     its message must use `.value`; the static `value` in preferences.xhtml
##     is kept as the fallback for when Fluent is unavailable;
##   - `<checkbox>` / `<button>` / `<menuitem>` must use `.label` (XUL elements
##     only render the label attribute, never the text content);
##   - every adjustable setting gets a `-desc` entry explaining what it does,
##     what an empty value means, and the default behaviour.
##
## The zh-CN locale (addon/locale/zh-CN/) must keep the exact same key set —
## Zotero picks a plugin locale per file and falls back to en-US.

## Section headings
preferences-ztransplit-general = General
preferences-ztransplit-engine = Translation engines
preferences-ztransplit-pdf = PDF split-screen translation

## Pane intro (rendered under the title by Zotero)
preferences-ztransplit-intro = Configure the text translation engines and the runtime requirements for PDF split-screen translation.

## ── General ────────────────────────────────────────────────────────────────
preferences-ztransplit-translate-enabled =
    .label = Enable text translation
preferences-ztransplit-translate-enabled-desc =
    When on, translation entry points appear in the item pane and the reader.
    When off, the translate button and automatic translation are disabled, but
    the engine keys and other settings you entered are kept, so you can
    re-enable it at any time.

preferences-ztransplit-translate-auto =
    .label = Translate automatically when an item opens
preferences-ztransplit-translate-auto-desc =
    Translates as soon as a reader item or a selection opens, without pressing
    the "Translate" button. Requires "Enable text translation" above.
    Automatic translation sends segmented requests within the character limit
    below, so opening long documents produces more network requests.

preferences-ztransplit-translate-max-chars =
    .value = Maximum characters per request
preferences-ztransplit-translate-max-chars-desc =
    Upper bound of characters submitted to the engine per request; 100–50000,
    default 10000. Longer text is segmented automatically, so a larger value
    only reduces the number of segments while making each request bigger; a
    smaller value is more conservative but segments more, which is more likely
    to break the meaning at segment boundaries. Invalid or empty input keeps
    the previous valid value; the setting is not overwritten.
preferences-ztransplit-translate-max-chars-range = Enter an integer between 100 and 50000.

preferences-ztransplit-translate-batch-tokens =
    .value = Merged batch input cap (tokens)
preferences-ztransplit-translate-batch-tokens-desc =
    Full-text translation and bilingual interleave merge several paragraphs
    into one model request; this caps the merged input size in estimated
    tokens, 1000–65536, default 8192. When the next paragraph would exceed the
    budget the batch closes early (one paragraph short) instead of sending an
    over-budget request. Larger batches mean fewer calls and richer context,
    but a reasoning model's thinking overhead grows with batch size, and so
    does the risk of an empty answer from an exhausted output budget.
preferences-ztransplit-translate-batch-tokens-range = Enter an integer between 1000 and 65536.

## ── Translation engines ────────────────────────────────────────────────────
preferences-ztransplit-engine-type =
    .value = Engine
preferences-ztransplit-engine-type-desc =
    Pick the engine used for text translation. Switching engines keeps the
    credentials entered for the other engines, so you can switch back at any
    time; only the currently selected engine is used.

## ── Network region ─────────────────────────────────────────────────────────
preferences-ztransplit-region =
    .value = Network region
preferences-ztransplit-region-auto =
    .label = Automatic (undeclared)
preferences-ztransplit-region-global =
    .label = Global
preferences-ztransplit-region-cn =
    .label = Mainland China
preferences-ztransplit-region-desc =
    Declare your network environment and the plugin writes that region's
    recommended values into settings still at their factory defaults (for
    example, mainland China defaults to the keyless Bing web engine). Engines
    you picked explicitly are never overridden by the region choice; keeping
    "Automatic" changes nothing.
preferences-ztransplit-region-note-applied =
    Recommendations applied for the selected region: settings still at their
    factory defaults were rewritten; engines you picked explicitly were left
    untouched.
preferences-ztransplit-region-note-nochange =
    Nothing changed: the relevant settings already match the selected region's
    recommendations, or you customized them.

preferences-ztransplit-engine-google =
    .label = Google Translate
preferences-ztransplit-engine-bing =
    .label = Bing Translator
preferences-ztransplit-engine-bingweb =
    .label = Bing web (keyless)
preferences-ztransplit-engine-deepl =
    .label = DeepL
preferences-ztransplit-engine-ai =
    .label = AI translation (OpenAI-compatible)
preferences-ztransplit-engine-custom =
    .label = Custom (OpenAI-compatible)
preferences-ztransplit-engine-zotero-pdf-translate =
    .label = zotero-pdf-translate plugin
preferences-ztransplit-engine-zotero-pdf-translate-missing = zotero-pdf-translate plugin (not installed)

## The "Show key" checkbox next to key inputs (temporarily reveals the value;
## never writes it anywhere)
preferences-ztransplit-show-key =
    .label = Show key
    .tooltiptext = Temporarily shows the key in plain text so you can check what you pasted. Affects only this input box; nothing is written to the settings.

## Google
preferences-ztransplit-google-api-key =
    .value = Google API key
preferences-ztransplit-google-api-key-desc =
    Optional. When empty, the keyless free endpoint is used, falling back to
    the keyless Bing web endpoint on failure; with a key, the official API is
    used instead, with better quota and stability. An invalid key produces no
    explicit warning — it just shows up as failed translations — so leaving
    this empty is usually the lower-maintenance choice.

## Bing
preferences-ztransplit-bing-api-key =
    .value = Bing API key
preferences-ztransplit-bing-api-key-desc =
    Required. The key for the Microsoft Translator REST API, from a
    "Translator" resource in the Azure portal. Without it, Bing translation
    fails immediately.
preferences-ztransplit-bing-region =
    .value = Region
preferences-ztransplit-bing-region-desc =
    Optional. Multi-region resources (e.g. chinaeast2) must match the region
    you signed up with; global resources just use "global". A wrong value
    returns an authentication error.

## Bing web translation (keyless)
preferences-ztransplit-engine-bingweb-desc =
    Keyless and configuration-free. Uses the Bing Translator web endpoint — the
    only engine reachable in mainland China without a key. A good pick when you
    know Google is blocked and don't want to pay its timeout on every
    paragraph. The session token refreshes automatically and a failed request
    is retried once.

## DeepL
preferences-ztransplit-deepl-api-key =
    .value = DeepL API key
preferences-ztransplit-deepl-api-key-desc =
    Required. The DeepL API authentication key; without it, DeepL translation
    fails immediately.
preferences-ztransplit-deepl-use-free =
    .label = Use the DeepL free API
preferences-ztransplit-deepl-use-free-desc =
    Free keys (ending in ":fx") must enable this; Pro keys must disable it.
    The wrong choice returns a 401/403 authentication error.

## AI translation (OpenAI-compatible + user-owned prompt template)
preferences-ztransplit-ai-api-url =
    .value = Endpoint URL
preferences-ztransplit-ai-api-url-desc =
    Required. An OpenAI-compatible chat/completions URL, e.g.
    https://api.example.com/v1/chat/completions, or a local model service such
    as http://127.0.0.1:11434/v1. Translation fails when empty.
preferences-ztransplit-ai-api-key =
    .value = API key
preferences-ztransplit-ai-api-key-desc =
    Optional. Usually required for hosted services; local model services
    (Ollama, LM Studio, …) generally need no key, and leaving it empty means no
    Authorization header is sent at all.
preferences-ztransplit-ai-model =
    .value = Model
preferences-ztransplit-ai-model-desc =
    Optional. The model name to call, e.g. gpt-4o-mini, qwen-max, glm-4.7.
    When empty, the server picks its default model, with no guarantee on
    translation quality.
preferences-ztransplit-ai-prompt =
    .value = Translation prompt template
preferences-ztransplit-ai-prompt-desc =
    What gets sent to the model. Empty means "use the built-in default
    template". The template must contain three placeholders — {"{{"}text{"}}"}
    (the text to translate), {"{{"}sourceLang{"}}"} (the source language name)
    and {"{{"}targetLang{"}}"} (the target language name) — and the plugin
    fills in the language names as readable names such as "Simplified Chinese".
    Formulas are replaced by markers like {"{"}v0{"}"} and {"{"}v1{"}"} before
    translation; the default template asks the model to keep them verbatim. An
    invalid template is never written to the settings, and selecting this
    engine while one is stored is blocked by the readiness check, which points
    back here.
preferences-ztransplit-ai-prompt-restore =
    .label = Restore the default template

## AI prompt template rejection reasons (mirrors the engine's runtime errors,
## shown inline while editing; the JS only copies the localized text)
preferences-ztransplit-ai-prompt-error-too-long =
    The template is too long (at most 4000 characters).
preferences-ztransplit-ai-prompt-error-unknown-placeholder =
    The template contains an unknown placeholder — only {"{{"}text{"}}"}, {"{{"}sourceLang{"}}"} and {"{{"}targetLang{"}}"} (double braces) are supported.
preferences-ztransplit-ai-prompt-error-missing-text =
    The template is missing {"{{"}text{"}}"} — that is where the text to translate goes.
preferences-ztransplit-ai-prompt-error-duplicate-text =
    The template contains {"{{"}text{"}}"} more than once — the source text may only be sent once.
preferences-ztransplit-ai-prompt-error-missing-source-lang =
    The template is missing {"{{"}sourceLang{"}}"} — that is where the source language name goes.
preferences-ztransplit-ai-prompt-error-missing-target-lang =
    The template is missing {"{{"}targetLang{"}}"} — that is where the target language name goes.
preferences-ztransplit-ai-prompt-error-unbalanced-braces =
    The template has unbalanced braces — placeholders use double braces ({"{{"}text{"}}"}), formula markers use single braces ({"{"}v0{"}"}).

## Custom (OpenAI-compatible)
preferences-ztransplit-custom-api-url =
    .value = Endpoint URL
preferences-ztransplit-custom-api-url-desc =
    Required. An OpenAI-compatible chat/completions URL, e.g.
    https://api.example.com/v1/chat/completions. Translation fails when empty.
preferences-ztransplit-custom-api-key =
    .value = API key
preferences-ztransplit-custom-api-key-desc =
    Required. The key for that service, usually sent as
    Authorization: Bearer <key>. Translation fails when empty.
preferences-ztransplit-custom-model =
    .value = Model
preferences-ztransplit-custom-model-desc =
    Optional. The model name to call, e.g. gpt-4o-mini. When empty, the server
    picks its default model, with no guarantee on translation quality.

## zotero-pdf-translate
preferences-ztransplit-pdftranslate-installed =
    The zotero-pdf-translate plugin was detected; text translation requests are
    handed over to it.
preferences-ztransplit-pdftranslate-missing =
    The zotero-pdf-translate plugin was not detected. Install and enable it
    under Zotero's "Tools → Plugins", otherwise selecting this engine fails.

## ── PDF split-screen translation ───────────────────────────────────────────
preferences-ztransplit-pdf-java-title =
    .value = Java runtime
preferences-ztransplit-pdf-java-desc =
    Layout-preserving PDF translation needs Java 11 or later to parse the PDF
    content. Without Java the feature is unavailable: right-click the PDF in
    the reader and choose "Translate and split" — the check runs
    automatically, and when Java is missing a dialog walks you through
    installing a portable runtime (about 40MB, unpacked into the data
    directory, no administrator rights needed). Click the menu again once it is
    installed.

preferences-ztransplit-pdf-fonts-title =
    .value = Font override directory
preferences-ztransplit-pdf-fonts-desc =
    Put custom font files into the directory below to override the default
    fonts used by PDF translation: name the regular face translated-regular.ttf,
    and the bold / italic / bold-italic faces translated-bold.ttf,
    translated-italic.ttf, translated-bold-italic.ttf (.otf / .ttc work too).
    Noto Serif SC matches the serif look of most papers. The directory is
    created automatically when missing; fonts placed there take effect on the
    next translation.
preferences-ztransplit-pdf-fonts-path =
    .value = Font directory

# Fallback label for the font directory when the data directory is unknown
# (braces escaped per Fluent syntax)
preferences-ztransplit-data-dir-placeholder = {"{"}Data directory{"}"}

preferences-ztransplit-pdf-lang-title =
    .value = Translation language
preferences-ztransplit-pdf-lang =
    .value = Target language
preferences-ztransplit-pdf-lang-desc =
    Target language for PDF split-screen translation; the Zotero 10 bilingual
    view and read-aloud of the translation also use it as their default target
    language. Enter a BCP-47 code such as zh-CN, en-US or ja-JP. When empty it
    follows Zotero's UI language (the default). Text translation in the reader
    pane has its own target-language box and is unaffected by this setting.

## OpenDataLoader parsing options (addon/prefs.js pdfParser.opendataloader.*)
preferences-ztransplit-pdf-odl-title =
    .value = OpenDataLoader parsing options
preferences-ztransplit-pdf-odl-desc =
    These options control the local Java parsing component and affect the
    layout-parsing quality and duration of "Translate and split". Except for
    the timeout, changes take effect on the next translation.
preferences-ztransplit-pdf-odl-enabled =
    .label = Enable OpenDataLoader parsing
preferences-ztransplit-pdf-odl-enabled-desc =
    OpenDataLoader is the only layout-parsing backend used by "Translate and
    split". When off, the feature fails immediately and asks you to re-enable
    it here; unless it genuinely cannot run on your system, keep it on.
preferences-ztransplit-pdf-odl-table =
    .value = Table recognition
preferences-ztransplit-pdf-odl-table-default =
    .label = Default (bordered)
preferences-ztransplit-pdf-odl-table-cluster =
    .label = Cluster (borderless)
preferences-ztransplit-pdf-odl-table-desc =
    Table recognition method. "Default" splits along the table borders and
    suits bordered tables; "Cluster" groups text blocks and suits borderless
    tables, at the cost of longer runs and slightly more mis-detection.
preferences-ztransplit-pdf-odl-structtree =
    .label = Use the structure tree for reading order
preferences-ztransplit-pdf-odl-structtree-desc =
    When the PDF ships a structure tree (StructTree), it decides the reading
    order, which is more accurate for multi-column layouts; PDFs without one
    are unaffected, but parsing is slightly slower.
preferences-ztransplit-pdf-odl-timeout =
    .value = Parsing timeout (seconds)
preferences-ztransplit-pdf-odl-timeout-desc =
    Longest wait for a single layout parse; 30–3600 seconds, default 300. On
    large documents or slow disks a timeout shows up as a failed translation —
    before raising it, make sure Java is actually installed. Invalid or empty
    input keeps the previous valid value; the setting is not overwritten.
preferences-ztransplit-pdf-odl-timeout-range = Enter an integer between 30 and 3600.
preferences-ztransplit-pdf-odl-images =
    .label = Return embedded images
preferences-ztransplit-pdf-odl-images-desc =
    Has the parser output embedded page images so they are pasted back into
    the translation, keeping figures complete; when off, only text is
    translated and image areas are left blank — parsing is faster and the
    output file smaller.
preferences-ztransplit-pdf-removal-enabled =
    .label = Delete the original text of translated paragraphs
preferences-ztransplit-pdf-removal-enabled-desc =
    Before overlaying the translation, actually delete the original text of
    translated paragraphs from the PDF, so the result is searchable and
    copyable without surfacing masked-out originals. If deletion fails, the
    pipeline falls back to white masks automatically; when off, masks are
    always used.

## ── Word cards ─────────────────────────────────────────────────────────────
preferences-ztransplit-wordcards-enabled =
    .label = Record looked-up words (word cards)
preferences-ztransplit-wordcards-enabled-desc =
    When on, a single-word selection in the PDF reader is looked up as a
    dictionary card (phonetics, part of speech, senses, examples) and
    accumulates into the Word Cards tab. When off, single words are translated
    as plain text; existing cards are kept and recording can be re-enabled at
    any time.
