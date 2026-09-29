<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="addon/content/icons/ztransplit-dark.svg" />
    <img src="addon/content/icons/ztransplit-light.svg" width="42" height="42" alt="Z-Transplit logo" align="top" />
  </picture>
  Z-Transplit
</h1>

**English** | [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zotero 7 ~ 10](https://img.shields.io/badge/Zotero-7%20~%2010-CC6633.svg)](https://www.zotero.org/)

**Selection Translation · Layout-preserving PDF Translation · Split-screen · Bilingual Interleave · Translation-only · Read-aloud — an all-in-one Zotero translation plugin.**

Z-Transplit is a standalone Zotero 7 / 10 plugin that puts the whole translation toolkit
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
"译文 (zh-CN)" attachment and opened automatically. Repeat runs are deduplicated: an
existing translation is opened instead of re-running the pipeline.

![Translated attachment](docs/screenshots/translated-attachment.png)

- Layout-preserving: columns, tables and image positions are mapped back, and mixed
  CJK/Latin paragraphs are drawn run-by-run with the matching font
- CJK fonts are resolved automatically — Microsoft YaHei / PingFang / Noto per target
  language — with an explicit notice when none is found instead of tofu glyphs
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
- While a translation runs, the context menu gains "Cancel translation in progress"

### 4. Interleaved Bilingual Reading (Zotero 10)

Turn on "Bilingual" in the reader's Translate section: Zotero 10's SDT reading mode
reflows the PDF into structured text and injects a translation block under every
paragraph, translated lazily as you scroll, with live `3/12 paragraphs translated`
progress.

![Interleaved bilingual](docs/screenshots/bilingual-interleave.png)

### 5. Translation-only Mode

In the same bilingual session switch to "Translation only": original blocks are hidden,
leaving only the translation for smooth reading.

![Translation only](docs/screenshots/translation-only.png)

> Interleaved and translation-only modes rely on Zotero 10's reading mode; on Zotero 7
> the panel states the limitation, while every other feature (selection, full-text,
> split, read-aloud) works on both versions.

### 6. Read-aloud

Both the bilingual session and the Translate section support read-aloud (Windows SAPI /
system TTS) with sentence-level highlight tracking: the original is located via the PDF
text layer, the translation via the bilingual blocks. Pause/resume, previous/next
sentence and stop are all there.

## Translation Engines

Switchable in the settings pane (Edit ▸ Settings ▸ Z-Transplit). All share a
content-addressed cross-session cache: the same text + language pair + engine answers
from cache on the second request, and editing one character re-translates.

| Engine | API key | Notes |
| --- | --- | --- |
| Google | optional | Free endpoint, automatic Bing-web fallback |
| Bing | required | Azure Translator REST API |
| DeepL | required | free / pro endpoint toggle |
| AI | endpoint required, key optional | OpenAI-compatible chat/completions with a user-owned prompt template |
| Custom | required | OpenAI-compatible chat/completions |
| zotero-pdf-translate | — | Delegates to the plugin when detected |

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
- Requests go out per paragraph (no batch JSON), same as any other model backend
  (self-hosted Ollama, vLLM, a gateway, …).

## Entry Points

- The reader's / item's "Translate" section: selection translation, bilingual,
  translation-only, read-aloud
- Reader right-click (PDF view): "Translate and open side by side", "Split-screen
  comparison", "Cancel translation in progress"
- Library right-click: "Translate full text (save as attachment)" and "Translate and
  compare side by side" — visible only when the selection contains a PDF
- Edit ▸ Settings ▸ Z-Transplit: engine, credentials, target language, Java and
  OpenDataLoader options

## Development

Architecture notes, the porting history, and the build / quality-gate / release
workflows live in [docs/development.md](docs/development.md).

## License

MIT — see [LICENSE](LICENSE).
