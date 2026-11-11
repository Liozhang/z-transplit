<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="addon/content/icons/ztransplit-dark.svg" />
    <img src="addon/content/icons/ztransplit-light.svg" width="42" height="42" alt="Z-Transplit logo" align="top" />
  </picture>
  Z-Transplit
</h1>

**English** | [中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/Liozhang/z-transplit?color=blue&logo=github)](https://github.com/Liozhang/z-transplit/releases)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/Liozhang/z-transplit/total?color=orange)](https://github.com/Liozhang/z-transplit/releases)
[![Zotero 10](https://img.shields.io/badge/Zotero-10-CC6633.svg)](https://www.zotero.org/)

**Selection Translation · Layout-preserving PDF Translation · Split-screen · Bilingual Interleave · Translation-only · Read-aloud — an all-in-one Zotero translation plugin.**

Z-Transplit is a standalone plugin for Zotero 10 that puts the whole translation toolkit
for reading foreign-language literature in one place: instant translation of the reader's
selection, layout-preserving full-text PDF translation that produces a translated
attachment, side-by-side split reading in one tab, Zotero 10 reading-mode bilingual
interleave with a translation-only mode, plus a cross-session translation cache and
sentence-level read-aloud.

All UI is built with Zotero's native XUL/HTML. No React, no iframe bridge.

## Installation

1. Download the latest `z-transplit.xpi` from [Releases](../../releases);
2. In Zotero: Tools ▸ Add-ons ▸ gear menu ▸ Install Add-on From File, and pick the
   downloaded xpi;
3. Open a PDF — the "Translate" section and the context-menu entries appear.

> The slim installer (the default download) does not bundle the ~24 MB layout-parsing
> component or the ~43 MB Java runtime: on first use they are downloaded automatically
> by racing several mirrors concurrently, and the bytes must pass the official SHA-256
> checksum before anything is installed — no administrator rights needed. For offline
> environments, grab the `*-full.xpi` from the release page instead.

## Features

### 1. Selection Translation

Select any text in the reader and the "Translate" section shows source and translation
with one-click copy. Automatic source-language detection, a target-language box (Enter
or blur commits it; Enter during IME composition only confirms the candidate), and
read-aloud of the result. A failed translation, an empty result, an over-long selection
and an unconfigured engine each get their own explicit message — never a silent blank.

![Selection translate](docs/screenshots/selection-translate.png)

- A "Refresh selection" button re-reads the current reader selection
- The target-language box commits on Enter or blur; Enter while composing an IME
  candidate does not submit
- The result area has four states: translating (a shimmer skeleton), failed (reason +
  retry), success (translation + copy), idle (a "Translate" button when auto-translate
  is off)
- A copy failure keeps the translation on screen and appends a transient failure note
  instead of discarding it
- With "auto-translate" on, a selection starts translating immediately

### 2. Full-text Translation (translated attachment)

Right-click a PDF (in the library or the reader) → "Translate full text (save as
attachment)". OpenDataLoader (local JVM) parses the layout, paragraphs are translated,
and the result is re-rendered preserving the original layout, stored as a
"Translated (zh-CN)" attachment and opened automatically. Repeat runs are deduplicated: an
existing translation is opened instead of re-running the pipeline.

![Translated attachment](docs/screenshots/translated-attachment.png)

- Layout-preserving: columns, tables and image positions are mapped back, and mixed
  CJK/Latin paragraphs are drawn run-by-run with the matching font
- CJK fonts are resolved automatically — Microsoft YaHei / PingFang / Noto per target
  language — with an explicit notice when none is found instead of tofu glyphs; drop a
  `translated-regular.ttf` into `{data dir}/ztransplit/translation-assets/` to override
  (e.g. Noto Serif SC to match the serif look of most papers)
- Formulas (`$…$` / `{v0}`) are swapped for placeholders before translation and painted
  back in position; the default template asks the model to keep them verbatim
- A multi-PDF selection runs the pipeline serially, with ordinal labels in the
  progress window and one failure never stopping the rest

### 3. Split-screen Reading

Right-click (reader or library) → "Translate and open side by side" / "Split-screen
comparison": one tab, two readers side by side, with a 5px drag resizer between them
and bidirectional scroll, page and zoom sync — for close paragraph-by-paragraph reading.

![Split view](docs/screenshots/split-view.png)

- "Split-screen comparison" needs no translation: the current PDF and another PDF
  under the same parent item, side by side
- "Translate and open side by side" runs the full-text pipeline when no translation
  exists yet, and reuses an existing one when it does
- One item opens one split view: an item holding both an original and its
  translation resolves a single source, and the right pane takes the newest
  existing translation
- While a translation runs, the context menu gains "Cancel translation in progress"

### 4. Interleaved Bilingual Reading (Zotero 10)

Turn on "Bilingual reading" in the reader's Translate section: Zotero 10's SDT reading mode
reflows the PDF into structured text and injects a translation block under every
paragraph, translated lazily as you scroll, with live `3/12 paragraphs translated`
progress. The "Interleaved" and "Translation only" buttons also work before a
session starts — one click starts the session straight in that mode, and the
choice is remembered for the next session. A paragraph that was never
translated automatically (a late-rendered block, a list or table) needs no
mode switch either: select it and click the "Translate this paragraph" pill
to translate it on the spot — or to retranslate an existing translation.

In interleave mode, selecting text on either side highlights the matching
block on the other side at the same time: select an original block and its
translation lights up beneath it, select a translation and the original above
it answers in kind. The highlight moves with the selection and clears when you
click empty space. Translation-only mode takes no part in the linking — the
original is hidden wholesale, so there is no other side to correspond to.

Each translation also takes its paragraph's typography from the original above
it: the size is the original's scaled down (so the translation stays the second
voice, with a cap so a display-size title does not produce a second title), the
weight and the slant follow, and the ink follows when it stays readable. What is
deliberately not inherited is the font family — an embedded PDF face may cover
Latin only, and handing it to a Chinese translation would render tofu.

![Interleaved bilingual](docs/screenshots/bilingual-interleave.png)

### 5. Translation-only Mode

In the same bilingual session switch to "Translation only": original blocks are hidden,
leaving only the translation for smooth reading. Click a translated paragraph to
temporarily reveal its original text (click it again, or click another paragraph, to
hide it) — no mode switching needed when a translation is hard to understand.

![Translation only](docs/screenshots/translation-only.png)

> Interleaved and translation-only modes are built on Zotero 10's reading mode;
> every other feature (selection, full-text, split, read-aloud) works everywhere
> in the supported range.

### 6. Read-aloud

Both the bilingual session and the Translate section support read-aloud (Windows SAPI /
system TTS) with sentence-level highlight tracking: the original is located via the PDF
text layer, the translation via the bilingual blocks. Pause/resume, previous/next
sentence and stop are all there.

## Translation Engines

Switchable in the settings pane (Edit ▸ Settings ▸ Z-Transplit). All share a
content-addressed cross-session cache: the same text + language pair + engine answers
from cache on the second request, and editing one character re-translates. The cache
is shared across all four entry points — full-text translation, split view, the
bilingual view and selection translation — so a paragraph translated anywhere is
reused verbatim by every other entry point.

| Engine | API key | Notes |
| --- | --- | --- |
| Google | optional | Free endpoint; a failure is reported as-is |
| Bing | required | Azure Translator REST API |
| Bing web | — | Keyless; the engine to pick where Google is unreachable |
| DeepL | required | free / pro endpoint toggle |
| Youdao | app ID + app secret | Zhiyun text translation, signType=v3; a translation domain and an optional glossary id are configurable |
| Youdao (keyless) | — | The demo endpoint behind Youdao's web translator — reverse-engineered, so it can change or stop without notice |
| AI | endpoint required, key optional | OpenAI-compatible chat/completions with a user-owned prompt template |
| Custom | required | OpenAI-compatible chat/completions |
| zotero-pdf-translate | — | Delegates to the plugin when detected |

No engine substitutes for another. When the selected engine cannot be reached the
translation fails with that engine's own error — never a quiet retry against a
different provider — so the settings always describe what actually answered.

The "Network region" setting decides the initial engine. On first launch it follows
Zotero's interface language: a Simplified Chinese interface is treated as mainland
China (the Google endpoint is unreachable there, so the keyless Bing web engine
becomes the default), any other interface language as global (Google stays the
default). The inferred value is written into the setting, where you can change it
at any time. Afterwards the plugin only writes a region's recommendations into
settings still at their factory defaults, or into the ones the previous region's
recommendation wrote — an engine you picked yourself is never overridden. No IP
lookup and no timezone guessing: only the interface language you chose yourself.

### Configuring the AI engine

With the "AI" engine selected, the settings pane gains a "Provider" dropdown at the
top of the engine section. Picking DeepSeek, Qwen, Zhipu GLM, Kimi, StepFun, OpenAI,
Ollama or LM Studio fills in the endpoint and a recommended model name automatically,
usually leaving only the API key to paste — local providers (Ollama, LM Studio) need
no key at all. "Custom" remains for self-hosted gateways and vLLM. When you are not
sure what to fill in, start by picking a provider here. Then press "Test connection":
the plugin sends one minimal request with the values currently in the form and turns
the outcome into something actionable — key rejected, endpoint not found, unreachable,
rate limited — so a misconfiguration no longer has to be discovered by running a
translation first. A model name you edited by hand is never overwritten by a preset.

![AI engine settings](docs/screenshots/ai-engine.png)

### The AI engine's prompt template

The AI engine hands "what gets sent to the model" to the user, and keeps two things for
itself: the language configuration and the template validation.

- A template must contain three placeholders — `{{text}}` (the text to translate),
  `{{sourceLang}}` and `{{targetLang}}`. They use double braces on purpose: `{v0}` /
  `{v1}` single-brace markers are formula positions in the pipeline, and the default
  template asks the model to keep them verbatim.
- The plugin resolves the language codes to readable names (`zh-CN` → Simplified
  Chinese) instead of sending raw codes.
- The template is validated as you type in the settings pane: misspelled, missing,
  duplicated or unbalanced placeholders and over-long templates each get their own
  inline message, an invalid value is never written to the settings, and a stored
  invalid template is blocked by the readiness check, which points back at the pane.
  An empty field restores the built-in default template.
- The cache invalidates by template fingerprint — editing one character forces a
  re-translation instead of serving results from the old prompt.
- Full-text and bilingual translation pack several paragraphs into one request
  (structured JSON output), and the batch prompt is derived from your template,
  so a custom template governs every segment. A selection translation goes out
  per paragraph.

### The glossary

The "Glossary" field in the settings pane (Edit ▸ Settings ▸ Z-Transplit) pins
how domain terms are translated: one `source=translation` pair per line, for
example `transformer=变换器` (a full-width or half-width colon also works as
the separator).

- Applies to the AI engine and the custom (OpenAI-compatible) engine only.
  Machine-translation endpoints (Google, Bing, DeepL) have no prompt to inject
  into and are unaffected.
- Every request is filtered against the text being translated: only the terms
  that occur in it are injected. Latin terms match case-insensitively as whole
  words, CJK terms as substrings, and a phrase may span a line break; ligatures
  and line-break hyphens from PDF extraction are normalized first.
- Terms the text never mentions cost nothing — a 200-entry table no longer
  dilutes every request. A term's other forms (an English plural, say) need
  their own entry.
- When a term appears, the model must use the listed translation; words not
  listed translate normally.
- At most 200 entries; a malformed line is rejected as a whole by the pane.
- The cache fingerprint folds the whole glossary, so editing it re-requests
  the affected translations instead of serving the old results.

## Entry Points

- The reader's / item's "Translate" section: selection translation, bilingual,
  translation-only, read-aloud
- Reader right-click (PDF view): "Translate and open side by side", "Split-screen
  comparison", "Cancel translation in progress"
- Library right-click: a Z-Transplit submenu with five entries — "Translate full
  text (save as attachment)", "Translate page range…", "Split-screen translation",
  "Interlinear translation" and "Translation only" — visible only when the
  selection contains a PDF. Each entry carries its own icon; while split-screen
  or a bilingual session is live on the selected PDF, that entry's icon swaps
  to a check mark
- Edit ▸ Settings ▸ Z-Transplit: engine, credentials, target language, Java and
  OpenDataLoader options

## Supported Attachments

Zotero opens PDF, EPUB and HTML-snapshot attachments in its reader, and every
other attachment type (docx, images, audio/video, plain text, …) in no reader
at all; notes are separate items edited in the note editor. The plugin serves
the reader kinds accordingly:

- **PDF** — the full feature set (selection translation, full-text translation,
  split view, bilingual interleave, translation-only, read-aloud).
- **HTML snapshot** — selection translation in the reader's Translate section
  only: Zotero's text-selection popup carries the selected text on every reader
  kind, so that path works. The bilingual session, read-aloud and split view
  are PDF-only (Zotero 10's SDT reading mode and the pdf.js internals), so the
  snapshot's section shows selection translation without them.
- **EPUB and everything else** — not served: the Translate section, the reader
  toolbar button and the reader context-menu submenu do not appear, rather
  than appearing and failing.


## Development

Architecture notes, the porting history, and the build / quality-gate / release
workflows live in [docs/development.md](docs/development.md).

## License

Copyright (C) 2026 z-transplit contributors

AGPL-3.0 — see [LICENSE](LICENSE). Same license as Zotero itself.
