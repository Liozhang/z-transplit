# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.14.0] - 2026-10-30

### Added

- Manual translation in bilingual reading mode (issue #3). Selecting text in
  the reading view shows a "Translate this paragraph" pill centered below
  the selection; clicking it translates the block the selection sits in — or
  retranslates it with the cache bypassed when a translation already exists.
  Blocks the session inventory missed (paragraphs the reading view rendered
  late) and containers it skips on purpose (lists, tables) get their
  translation slot injected on the spot, joining the progress count, the
  retry flow and read-aloud like any other block. Reference sections stay
  excluded, exactly like automatic translation.
- An attachment naming template. The new "Translated attachment naming
  template" field in the preferences pane accepts `{lang}`, `{title}` and
  `{date}` placeholders (for example `译文-{title}-{lang}`); leaving it empty
  keeps the built-in `Translated (<lang>) · <name>` shape. Existing
  translations created with the previous template are no longer detected as
  translations after the template changes, so a re-translation produces a
  fresh attachment instead of silently reusing the old one.
- Custom HTTP headers for the AI and custom (OpenAI-compatible) engines. The
  new multi-line fields in the preferences pane accept one `Name: value` per
  line and are sent with every request of that engine; a name that collides
  with a built-in header wins, which is the way to drive gateways that
  require a tenant id or a non-Bearer auth scheme. Invalid lines are rejected
  at the pane and never persisted. Changing the headers produces a different
  cache fingerprint, so affected translations are re-requested instead of
  being served from cache.
- Per-paragraph translation show/hide in interleave bilingual mode. Clicking
  a translation block collapses it to a thin bar so the original can be read
  on its own; clicking the bar brings the translation back. The state belongs
  to interleave mode only — switching to translation-only mode restores every
  block (there a hidden block would blank the paragraph entirely), and a
  drag-selection release never counts as a click.
- Page-range translation. A new "Translate page range…" entry in the item
  tree menu asks for pages such as `1-3,7` (single pages, closed ranges and
  mixes; full-width commas and dashes are tolerated; a malformed input is
  rejected outright instead of translating the wrong pages) and translates
  only those pages. Every other page is carried into the output PDF exactly
  as-is — no mask, no text removal, no formula screenshot — so a rotated or
  figure-only page outside the range no longer aborts the run. The
  VLM formula pass only visits selected pages, and the completion summary
  counts only what was translated. Repeated range runs merge into the
  existing translated attachment instead of accumulating copies: both
  artifacts keep the source's full page list in order, so newly translated
  pages replace the same positions in the existing file (the attachment item
  itself is kept, along with its title and source link) and translated pages
  accumulate in the file content across runs. A page-count mismatch, an
  unreadable file or any merge failure falls back to saving a separate
  attachment — the merged bytes are fully built in memory before anything
  touches the disk, so the existing translation is never at risk.
- A glossary. The new "Glossary" field in the preferences pane takes one
  `source=translation` pair per line (full-width colon accepted, at most 200
  entries) and pins those terms in every request of the AI and custom
  engines — single-paragraph, batched and the per-paragraph fallback alike.
  Terms not listed translate normally. Changing the glossary produces a
  different cache fingerprint, so affected translations are re-requested.
- An explicit output budget. The new "Output limit per request" field caps
  the tokens one model request may generate (0 = automatic). Reasoning-style
  models spend the budget on hidden thinking and can come back empty on the
  automatic ceiling (observed on StepFun step-3.7-flash); an explicit budget
  replaces the derived value on the single-paragraph, batched and
  per-paragraph paths, and the one escalated retry after an empty completion
  never exceeds it — the budget stays a real ceiling instead of being
  silently enlarged by the retry.

### Fixed

- A source PDF whose file name contains characters Windows forbids (for
  example `论文: v2?.pdf`, or a name ending in a dot or space) made the
  translated copy's write fail or produced a fragile name. Source names are
  now sanitized before they feed the translated attachment's disk file name
  and display title: forbidden characters become spaces, trailing dots and
  spaces are stripped, and names longer than 100 characters are truncated.
- A PDF downloaded as `PAPER.PDF` (uppercase extension) could end up with an
  empty content type and was then invisible to every "is this a PDF
  attachment" check, so its translation was skipped. The file-name extension
  is now the fallback signal when the content type is missing.

## [1.13.1] - 2026-10-24

### Added

- A continuous-integration workflow (`.github/workflows/ci.yml`). Every push
  and pull request now runs the full unit suite, the build, and the
  structure / jar-provenance / QA gates on GitHub instead of relying on local
  runs. Pushing a `v*` tag additionally builds both XPI variants (slim and
  full), generates the Zotero auto-update manifests
  (`scripts/make-update-manifests.mjs`), creates the GitHub Release with notes
  taken from CHANGELOG.md, and syncs the manifests onto the `release` tag that
  the plugin's updateURL polls — the step manual releases kept forgetting (the
  manifests sat at 1.8.1 from 1.9.0 through 1.12.2, silently disabling
  auto-update for five releases).

### Fixed

- ARM64 Linux devices (ARM laptops and boards that run Zotero) downloaded an
  x64 Java runtime that could not execute. The platform descriptor treated
  Linux as x64 unconditionally; it now detects the machine architecture
  (system info service, then the XPCOM ABI string, then `navigator.platform`,
  then `Zotero.isARM`) and fetches Adoptium's aarch64 build, exactly like the
  existing Apple Silicon path.
- The Linux java locator only tried `/usr/bin/java` and `/usr/local/bin/java`.
  It now enumerates `/usr/lib/jvm/*` first — where apt, dnf and pacman all
  install JDKs under unpredictable directory names — so an installed JDK is
  found even when PATH was never configured.
- When the Google engine fell back to the Bing web endpoint, the translation
  appeared with no indication of where it came from. The selection pane now
  shows a note under the result for the rest of the session ("Google was
  unreachable this session; this translation came from the Bing web
  endpoint"), so the provenance of the text is never invisible.
- The session-sticky Google fallback never cleared until a Zotero restart:
  after one failure, switching engines and back still went straight to Bing.
  Creating a translator for any non-Google engine now clears the marker, so
  returning to Google re-probes the real endpoint.
- The English README was missing the 1.13.0 features (the AI provider
  presets, the "Test connection" button and the mirror-racing downloads) that
  the Chinese README documented, and neither README explained that the slim
  installer downloads the parsing component and Java runtime on first use.

## [1.13.0] - 2026-10-23

### Added

- The managed Java runtime now downloads from a domestic mirror when one is
  reachable. The Adoptium assets API stays the source of the checksum (the
  trust anchor) and is itself reachable from inside mainland China, but the
  archive it points at lives on GitHub release assets, where a direct
  connection effectively never completes — the old code had no fallback, so
  "install the portable JRE" simply hung or failed. The downloader probes all
  sources concurrently (1KB range request), ranks them by latency, and takes
  the fastest, so whichever domestic mirror answers first is the one used.
  Two Adoptium mirrors are registered, Nanjing University's and Tsinghua's,
  with the official binary URL last as the global fallback. Mirror bytes are
  verified against the official SHA-256 before anything is extracted, and a
  mismatch or an unreachable mirror falls through to the next source, so a
  polluted or lagging mirror cannot install anything the official checksum
  does not attest. The mirror path is derived from the package name the API
  returns (`{base}/{feature}/jre/{arch}/{os}/{packageName}`), so new upstream
  patch releases need no table update. When the API itself is unreachable
  there is no checksum to verify against, and mirrors are deliberately
  skipped in that case rather than installing unverifiable bytes.
- More sources for the on-demand parsing component (the wheel that carries
  the OpenDataLoader jar). It previously raced the Aliyun PyPI mirror, the
  Tsinghua PyPI mirror, official PyPI, and the GitHub Release; three more
  domestic PyPI mirrors are now registered — Tencent Cloud, Huawei Cloud,
  and USTC — so six sources race concurrently and the fastest wins. All
  five domestic mirrors serve a byte-identical wheel (same SHA-256 as
  official PyPI), which the pinned PROVENANCE fingerprint verifies before
  anything is extracted; a failing or slow source simply loses the race.
  Excluded after testing: USTC's Adoptium mirror (stale — it only carries
  Java 17.0.9 and 404s on current releases) and the Huawei/Tencent/Aliyun
  Adoptium paths (no such path; they serve a portal page), which is why only
  Nanjing University and Tsinghua are registered for the Java runtime.
  Note that Nanjing University's Adoptium mirror has no Apple Silicon
  (aarch64/mac) build, so macOS ARM installs fall through to Tsinghua or the
  official URL — the probe mechanism handles this without a special case.
  Verified end to end on the real network from mainland China
  (`ZT_E2E_NETWORK=1`): the Nanjing University mirror's Windows x64 zip is
  byte-identical to the official checksum, and the full
  download-extract-probe chain completes in about 15 seconds, with the
  install landing under a Chinese (non-ASCII) data directory path and
  `java -version` succeeding from it.
- AI engine provider presets. The engine's three fields (endpoint, key,
  model) used to be free-text-only, so configuring them meant knowing what
  an OpenAI-compatible endpoint is, where to get a key, the exact URL shape,
  and a valid model name — real user feedback was "I don't know how to
  configure the AI API". The settings pane now has a provider dropdown:
  picking DeepSeek, Qwen, Zhipu GLM, Kimi, StepFun, OpenAI, Ollama, or LM
  Studio fills the endpoint and a recommended model name, usually leaving
  only the key to paste (local providers need no key at all). "Custom"
  remains for self-hosted gateways and vLLM. A model name the user edited
  by hand is never overwritten by a preset, and switching to Custom changes
  nothing. The five mainland providers were verified reachable (401/400 =
  endpoint alive, key missing); api.openai.com times out from inside
  mainland China, which is exactly why the presets matter there.
- A "Test connection" button for the AI engine. It sends one minimal request
  with the values currently in the form (not the saved prefs) and classifies
  the outcome into something actionable: key rejected, endpoint not found,
  rate limited, unreachable (the api.openai.com-from-mainland case), empty
  completion, or success. Before this, a misconfiguration only surfaced as a
  raw HTTP error at translation time, with no way to tell which of the three
  fields was wrong.

### Fixed

- Windows: installing the managed JRE no longer fails when the Zotero data
  directory contains non-ASCII characters (a Chinese Windows username, for
  instance). The install path launches its helper commands through a `.bat`
  file, which `cmd.exe` decodes with the console code page — CP936 on a
  Simplified Chinese system — so UTF-8-written Chinese paths arrived as
  mojibake and tar reported "path not found". The batch now starts with
  `chcp 65001`, switching that cmd session to UTF-8 before the command line
  is read. Measured on Windows: UTF-8 without the codepage switch fails on
  Chinese paths and succeeds on ASCII ones; with it, both succeed. (UTF-16LE
  batch files were tried first and do not work at all under this launch
  path — they are never executed.) The parse path itself moved to
  Subprocess/CreateProcessW back in 1.12.0; this covers the install path.
- "Cannot invoke java" no longer happens when Java is installed but not
  where the plugin looks. `java` resolution used to be two drifting copies
  of the same PATH search, each with three hard-coded Windows paths
  (`...\Eclipse Adoptium\jdk-17`, `jdk-11`) that never match a real Temurin
  install — the MSI and winget layouts always carry the patch version
  (`jdk-17.0.20.1-hotspot`). It now lives in one shared module
  (`src/core/pdf/javaLocator.ts`) that reads `JAVA_HOME` first, then
  enumerates the real install locations (Eclipse Adoptium / Java / Microsoft
  / Amazon Corretto / Zulu versioned directories, Android Studio's bundled
  `jbr`, `/Library/Java/JavaVirtualMachines/*.jdk` on macOS, Homebrew
  `openjdk@N` for both Apple Silicon and Intel prefixes), and only then
  falls back to PATH. A `JAVA_HOME` that points at a missing directory is
  skipped quietly instead of poisoning the result.
- macOS: `/usr/bin/java` is a system stub that exists and is executable even
  with no JDK installed, and the old resolver handed it out as if it were a
  working runtime — the user then got a cryptic "No Java runtime present"
  from a parse that could never succeed. The stub is now the last candidate,
  after every real install location.
- The "no java found" error is now a localized, actionable message naming
  both options (install a JDK, or let the plugin install its own portable
  JRE from the settings pane) instead of an English hard-coded string or a
  raw `spawn java ENOENT`.
- Mainland China no longer pays a 10-second Google timeout per paragraph.
  The default engine (Google free endpoint) falls back to the keyless Bing
  web endpoint when Google fails — but that fallback used to fire per
  request, so a 50-paragraph paper waited 50 × 10s before the same Bing
  endpoint that answers in under a second. The failure is now sticky for
  the session: after the first failure, later paragraphs go straight to
  Bing. This is reactive (an observed failure), never predictive — it does
  not guess where the user is, the same stance as region's "auto infers
  nothing" — and a Zotero restart probes Google again, so a recovered
  outage is picked up. Measured: translate.googleapis.com times out
  completely from a mainland connection while www.bing.com answers in
  0.45s.
- The readiness error for an unconfigured AI engine no longer says "missing
  custom endpoint URL" — the message was shared with the custom engine and
  pointed users who picked AI at a setting they never chose. The AI engine
  now has its own message, and the not-ready dialog names the exact settings
  location instead of a vague "complete it in the settings".

### Changed

- `JavaRuntimeManager` and `OpenDataLoaderPdfClient` share one java
  resolution implementation; the duplicated PATH searches are gone.

## [1.12.2] - 2026-10-23

### Fixed

- Native library item context-menu entries no longer lose their text or
  disappear alongside Z-Transplit's submenu. The plugin used to insert its
  「Z-Transplit」submenu and separator at the TOP of the `zotero-itemmenu`
  popup, but Zotero's `buildItemContextMenu` addresses its native entries
  positionally (`menu.childNodes[i]`, identical on Zotero 7.0.15 and 10) to
  rewrite labels, rewrite `oncommand`, toggle Fluent `data-l10n-id`
  bindings, and run its hide/show loop. The two inserted nodes shifted every
  index by two: label writes landed on neighbouring items ("Remove from
  Collection" onto "Add to Collection"), `data-l10n-id` was stripped from
  the wrong node (its label lost for good), entries that should appear
  stayed hidden, and the plugin's own submenu at index 0 had "Show in
  Library" written onto it — the native-label corruption previously worked
  around by re-asserting the label on every popupshowing. The submenu and
  separator are now APPENDED to the end of the popup (separator first):
  native entries keep positions 0-28 and every positional write resolves
  correctly, while the injected nodes sit past the last positional index
  and are never touched by the host. The label re-assertion stays as free
  insurance.

## [1.12.1] - 2026-10-22

### Fixed

- The bilingual reading entries (「上下翻译」/「仅译文」) no longer crash
  Zotero. The interleave view's geometry poll ran on a timer registered on
  the SDT iframe's content window with a chrome-privileged callback; on
  Zotero 10.0.6 that combination aborted xul.dll (exception 0x80000003)
  50-70 seconds after every bilingual session start — 100% reproducible on
  the real-machine harness, absent without the flow. The poll timer now
  lives on the chrome main window, and the queue stops itself once the SDT
  view is torn down (reader tab closed) instead of spinning on dead nodes.
- The item-tree bilingual entries no longer fail silently. Starting a
  session now waits (up to 10 s) for the freshly opened reader to expose its
  SDT entry points — previously a slow reader open raced the session start
  and the flow gave up invisibly, leaving just the plain PDF reader. The
  library menu items now also show progress while preparing, a completion
  line, and the document-structure disclosure / error text on failure
  instead of an unhandled rejection; the reader-menu entries resolve the
  current item through the selected tab like every other flow.

## [1.12.0] - 2026-10-22

### Fixed

- Windows: PDF filenames or directory names containing non-ASCII characters
  (Chinese, Japanese, Korean, Cyrillic, etc.) no longer cause "Process failed
  to launch" errors during split-screen translation. The Windows process
  launcher now uses Zotero's `Subprocess.sys.mjs` (backed by `CreateProcessW`)
  to start Java directly with a raw Unicode argv, instead of writing a UTF-8
  `.bat` file that a CP936/CP932 console code page would mis-decode. The JVM
  is additionally pinned to UTF-8 stdio (`-Dfile.encoding=UTF-8`,
  `-Dstdout.encoding=UTF-8`, `-Dstderr.encoding=UTF-8`), and non-zero exits
  now surface the real exit code plus captured stdout/stderr instead of a
  generic launch-failure message.

## [1.11.0] - 2026-10-16

### Changed

- Word cards now work for any target language, not just Chinese/English: the
  translate pane's default lookup language follows the「目标语言」preference
  (then Zotero's UI locale, then zh-CN) — the same chain the bilingual control,
  the split view and the PDF pipeline already used, so a French/Japanese/Russian
  UI user gets card senses and example translations in their own language
  (model-engine cards; MT简卡 when no AI endpoint is configured). Word read-aloud
  maps the word's own script to a matching voice (kana→ja, hangul→ko, Han→zh,
  Cyrillic→ru, Greek→el, Arabic→ar, Devanagari→hi, Thai→th, Hebrew→he, Latin→en
  fallback) instead of the previous binary Chinese/English choice. The language
  name table feeding the dictionary prompt grew from 9 to ~80 locales with a
  primary-subtag fallback ("pt-BR" → Portuguese), and the all-layers-failed
  error no longer names Youdao, which never participates for non-Chinese
  targets.

## [1.10.0] - 2026-10-15

### Added

- The word-cards book (「生词本」) is now reachable from the main window's
  Tools menu: a new「生词本」/ "Word Cards" entry (`tools-wordcards` Fluent
  key) opens the standalone word-cards tab, which now carries the wordcards
  glyph in the tab bar (`data.icon` was an empty placeholder before). The
  translate pane's recent-words strip becomes the per-item view: when the pane
  is bound to an item it lists only cards whose latest lookup came from that
  item (new `recentWordCardsForItem` store query); without an item it keeps
  the global recents. Note the store keeps only the most recent source per
  card, so a word looked up in several papers surfaces only under the latest
  one.
- Translated PDF attachments are now unmistakable: the disk file is named
  `Translated_<original>.pdf` (via `importFromFile`'s `fileBaseName` —
  previously Zotero's default naming gave both PDFs the parent item's name),
  the attachment title carries the source base name
  (`Translated (zh-CN) · <original name>`, still matching the
  `^(译文|Translated)\s*\(` recognition regex so dedup and split-reuse are
  unaffected), and a「译文」/ "Translated" tag (`translated-tag` Fluent key)
  marks the attachment.
- Menu entries that reflect a live state now carry Zotero's native checkbox
  checkmark, computed fresh on every right-click (the menu is rebuilt per
  open). In the reader menu both split entries checkmark while the current
  tab is a split comparison (either entry produces the same view — the
  "no translation" entry also lands the latest translation on the right pane
  when one exists — so the checkmark means "this tab IS a split comparison"),
  and exactly one bilingual entry checkmark while the session runs on this
  item. The library item menu's entries are checkbox-typed too: the bilingual
  entries checkmark while the session runs on the selected PDF, the split
  entry while a split tab shows it. Backing queries are new exports:
  `getActiveBilingualModeForItem` (bilingualLauncher) and
  `findSplitTabForItem` (splitViewCleanup).

### Changed

- Every reader context-menu entry (translate + split via the OpenDataLoader
  pipeline, the conditional "Cancel translation in progress", the manual
  split-screen comparison, and the two bilingual reading entries) now lives in
  a single「Z-Transplit」submenu instead of five flat items that mixed with
  other plugins' entries. The submenu is one appended item carrying a `groups`
  array; verified against Zotero 7.0.15 and 10 (10.0.6 omni.ja) that the host
  renderer builds a nested menu from `groups` and that its hard validation
  rejects top-level `icon`/`slider` only, so the submenu is safe on both host
  versions. A new `splitview-menu-root` Fluent key ("Z-Transplit") was added
  to both locales; the three per-feature menu registrations were merged into
  one (`registerReaderContextMenu` / `unregisterReaderContextMenu`).
- Context-menu labels shortened (both locales, same concept = same name across
  the reader and library menus): 分屏对照（不翻译）→「分屏阅读」("Split-screen
  reading"), 翻译并分屏打开 / 翻译并分屏对照 →「分屏翻译」("Split-screen
  translation"), 上下对照双语阅读 →「上下翻译」("Interlinear translation"),
  仅译文双语阅读 →「仅译文」("Translation only"). The real-machine probe's
  label filters were updated to the new wording.

## [1.9.0] - 2026-10-13

### Changed

- The bilingual control's semantics are unambiguous at the color level: red
  (#b5343a) now means only "session active" on the toggle, while the current
  presentation mode (上下对照 / 仅译文) is highlighted with a neutral pressed
  style (fill + underline indicator) instead of the brand red.
- The bilingual toggle's label is fixed ("双语阅读" / "Bilingual reading") and
  the session state is expressed by a pressed state (`aria-pressed` attribute)
  instead of swapping the label between "双语对照" and "退出双语"; the now
  unused `bilingual-exit` Fluent key was removed from both locales.
- The mode buttons no longer render dimmed when no session runs. They have
  always been operable outside a session (click = start a session in that
  mode), so the 50% opacity — visual language for "disabled" — contradicted
  the behavior; the buttons now look the same in both states.

### Fixed

- The reader translate pane's source and result areas keep a minimum height
  (`min-height: 4em`), and the result area renders a persistent placeholder
  box ("翻译结果将显示在这里" / "Translation will appear here.") in the idle
  state instead of disappearing entirely. The pane no longer collapses to a
  sliver or jumps vertically as the selection and translation state change.

## [1.8.1] - 2026-10-12

### Added

- The bilingual progress line now surfaces engine failures instead of hiding
  them: when paragraphs fail, it switches to "N/M paragraphs translated, K
  failed: ⟨reason⟩ (click a failed paragraph to retry)", carrying the most
  recent engine error (network unreachable, HTTP status, rate limit) captured
  from the translation chain. Previously a dead engine left every block at
  "Translating…" with only a bare count in the sidebar, and nothing explained
  why.

### Changed

- Split-view page sync is snappier and stops echo-induced jumps: the mirror
  guard that swallows the echo of our own scroll write widens from a
  same-tick clear to 50 ms (pdf.js can re-anchor scrollTop a few ms after the
  write), the post-zoom settle window shrinks from 350 ms to 200 ms, and the
  resizer resume delay shrinks from 200 ms to 100 ms.
- The bilingual control's buttons are visually unambiguous: the toggle wears
  its red active state only while a session is live, and the mode buttons
  (上下对照 / 仅译文) render dimmed with no highlight when no session runs —
  exiting a session clears the mode highlight instead of resetting it to the
  stored default, so the highlight only ever reflects the live presentation.
- The translate pane gives its result more room and clearer contrast: the
  source box grows from 11 em to 16 em and the translation box from 16 em to
  24 em, and both gain a left accent border (gray for source, blue for the
  translation) over a tinted background.
- Scroll-trigger injection failures in the split view now log which pane
  failed, so a side that silently fell back to the 400 ms backstop poll is
  diagnosable from the debug output.

### Fixed

- Read-aloud control buttons (pause / previous / next / stop) were always
  visible, even with playback stopped: the button class's
  `display: inline-flex` overrode the user-agent rule behind the `hidden`
  attribute. An explicit `[hidden] { display: none }` rule restores the
  attribute's meaning (found in on-device testing).
- Selection auto-refresh in the translate pane: clearing the selection now
  drops the stale source text and translation instead of keeping them on
  screen, and a 1-second polling backstop catches selection changes the
  reader's popup event can miss (keyboard selection, certain builds). The
  handler early-returns while the text is unchanged, so the poll idles in
  practice.

## [1.8.0] - 2026-10-11

### Added

- Selection translation now flows through the same persistent paragraph cache
  as the PDF pipeline and the bilingual view. Previously the selection path
  only had the session-scoped in-memory LRU, so a paragraph you translated by
  selecting it was re-translated by every later run; now an exact-text hit
  answers from cache without a network call, and fresh selection results are
  stored back under the shared key space (engine identity + auto-detected
  source + target language), where the document pipelines and the bilingual
  view pick them up. Dictionary-card word lookups stay ephemeral.
- Translation-only mode gains a click-to-peek interaction: clicking a
  translated paragraph temporarily reveals the original block right above it;
  clicking the same block again (or another block, or the empty page) hides it
  again. The peek is cleared on mode switches and on session exit, leaves the
  original content untouched, and is suppressed while a text selection is
  being dragged inside a block so copying translations keeps working. The
  interleaved mode stays free of click behavior.

### Changed

- The bilingual mode buttons (上下对照 / 仅译文) are no longer disabled while
  no session is live. Clicking one now starts the session directly in that
  mode instead of requiring the "enable bilingual first, then pick a mode"
  two-step, and an explicit click is remembered as the value of
  `reader.bilingual.defaultMode`, so the next session starts in the mode last
  used (previously the preference was read but never written). Leaving a
  session resets the mode highlight to that remembered default rather than a
  hardcoded interleaved. Clicking the bilingual toggle now shows the
  "preparing the document structure" status immediately, closing the silent
  gap during reader resolution that could last a few seconds.

## [1.7.2] - 2026-10-10

### Changed

- The plugin icon family adopts the 文/A swap motif that the sidebar and
  item-panel icons already use. The manifest icon (ztransplit-any.svg), the
  README light/dark variants, and the brand logo (logo.svg) replace the
  T-in-a-disc mark with the same diagonal 文/A pair and crimson swap
  arrows: the ink disc stays as the backdrop (the manifest icon must keep
  explicit colors that read on both light and dark hosts), the white strokes
  carry the two languages, and the crimson arrows carry the translation
  act. Icon geometry is the sidebar motif scaled 0.58 about the disc center
  with strokes held at 6 for legibility at 24 px.

### Fixed

- The parse-component download ("Download / repair…" for the OpenDataLoader
  jar) failed on every source in a real host. Mirror probing and the full
  22.5 MB wheel download succeeded; the failure came at the unpack step,
  because Gecko's `nsIZipReader` has no `getEntries()` — entry enumeration
  only offers `findEntries(pattern)`. Every source was discarded with
  "zipReader.getEntries is not a function" and the pane reported a download
  failure. Zip consumers now enumerate with `findEntries("*")` and unpack
  with `nsIZipReader.extract` into a staging file that is SHA-256-verified
  before it atomically replaces the target (extracted files are chmod'd
  back to normal so a later overwrite or cleanup cannot fail on a read-only
  bit). The packed-XPI extraction and the provenance readers share the same
  treatment, and the stream path via a single-argument `readArrayBuffer` —
  a form this host never supported — is gone. Verified end-to-end on a real
  Zotero 10: check reports the component missing, download/repair lands a
  verified 24,102,188-byte jar in the data directory, and a re-check
  reports ready.

## [1.7.1] - 2026-10-09

### Changed

- The plugin now declares Zotero 10 as its support window. The manifest's
  strict_min_version is raised from 7.0 to 10.0 (strict_max_version stays
  10.*), and the update manifests carry the same bound, so the updater on
  Zotero 7–9 keeps those installs on 1.7.0. Introductions were repositioned
  accordingly: the package description, both READMEs (badge, lead paragraph,
  and the note that described the Zotero 7 fallback for the interleaved /
  translation-only modes), and the reader's selection-unsupported message
  that told users to upgrade to Zotero 7 now say Zotero 10. The runtime
  capability probes are unchanged — features still degrade by detected
  capability, not by version.

## [1.7.0] - 2026-10-09

### Added

- Manual repair entry for the OpenDataLoader parsing component. The
  preferences pane's "OpenDataLoader parsing options" section gains a
  component row with "Check status" and "Download / repair…" buttons (plus a
  status line), mirroring the Java runtime section. The status check is
  read-only: it resolves the install root exactly like a real parse and
  reports the component as landed in the data directory or bundled with the
  plugin, with the version from the shipped PROVENANCE file. "Download /
  repair…" clears the session's download-failure latch and re-runs jar
  provisioning — a healthy landed copy returns immediately, a missing or
  hash-mismatched copy is re-extracted from a full build or re-downloaded
  from the mirrors with the progress window on the Zotero main window; on
  failure the status line shows the download error detail instead of the
  generic missing-component advice. This is the manual retry path for slim
  builds whose first-parse download failed (weak network, mirror outage) and
  never retries on its own within a session. The pane surfaces it through
  `Zotero.ZTransplit.odlJar` (`getStatus` / `install`), next to the existing
  `java` API.

### Fixed

- Flaky mirror-ranking unit test: the fake mirrors' probe delays (5ms vs
  20ms) could reorder under full-suite load because of timer granularity on
  Windows; the gaps are widened to 150/300ms so the intended fastest mirror
  always wins.

## [1.6.0] - 2026-10-09

### Added

- Word card read-aloud. The word-card tab's detail area gains a "Read aloud"
  button (speaks the word with a system voice) and a "Read examples" button
  (reads the example sentences' source text in display order — the
  translation is not read; the button only appears on cards that have
  examples). It reuses the reading view's read-aloud infrastructure (Web
  Speech API) and the `readAloud.rate` / `readAloud.voice` preferences, and
  picks a Chinese or English voice based on the word's own script (the
  lookup record's target language belongs to the translation side and does
  not represent the word itself). Clicking the same button while playing
  stops playback; clicking the other button switches directly; closing the
  word-card tab stops playback automatically. Neither button is rendered
  when the environment lacks a speech interface.
- On-demand download of the parsing component with mirror racing. The
  default build becomes slim: the XPI no longer bundles the 24 MB
  OpenDataLoader parsing component, shrinking from ~27 MB to ~5 MB. On the
  first parse the plugin downloads the component automatically, keyed by
  the PROVENANCE fingerprint shipped with the package (version and
  SHA-256): all sources are probed concurrently and the full package is
  downloaded from the fastest one; a failing source or a checksum mismatch
  falls through to the next. Sources tested (2026-10, direct connection
  from mainland China): the Aliyun PyPI mirror, the Tsinghua PyPI mirror,
  official PyPI, and the GitHub Release (global fallback). Maven Central
  does not carry the artifact and is not a source. The download shows in a
  progress window; the landed copy is reused after byte-for-byte
  verification, and re-fetched automatically when corrupted or outdated
  after a plugin upgrade. When the download fails, the error says "check
  the network and retry" instead of the misleading "reinstall the plugin".
  Set the environment variable `ZTRANSPLIT_FULL_XPI=1` to build a full
  installer that bundles the component, for distribution to offline
  environments.

### Fixed

- On packaged installs (installing from an XPI file), PDF parsing always
  failed with "The OpenDataLoader parsing component is missing (jar file
  not found). Please reinstall the plugin." The cause: Zotero keeps the
  plugin packaged as an .xpi (a zip archive), so the bundled jar sits
  inside the archive while `java -jar` needs a real file on disk, and
  every disk candidate in the old lookup missed. The suggested reinstall
  could not fix it either, since a reinstall is still a packaged install.
  `getJarPath` now falls back to extracting `core/pdf/lib/*.jar` with the
  platform's `nsIZipReader` into {data directory}/ztransplit/lib/, and
  verifying byte-for-byte against the SHA-256 declared in the packaged
  PROVENANCE*.json before returning it; a landed copy is reused after hash
  verification, and re-extracted automatically when corrupted or outdated
  after an upgrade. Extraction lands through a staging file rename, so an
  interruption never leaves a half-written file. The fallback also covers
  the second bundled component, ztransplit-region-text-remover.jar.
- The config-directory scan no longer mistakes a `<plugin id>.xpi` file for
  an unpacked plugin directory (the old code assembled impossible paths
  such as `….xpi\core\pdf\lib\…`).
- Error messages now tell two component failures apart: a genuinely missing
  file still suggests reinstalling; a file that exists but Java cannot
  access (antivirus quarantine, permissions, an invalid path) gets the new
  "odl-error-jar-unreadable" wording that points to the quarantine and
  permissions. java.lang.* stack traces that merely mention "jar" are no
  longer misreported as "component missing". Also added the FTL key
  `err-jar-load`, which the code referenced but never defined (old builds
  displayed the raw key name on that branch).
- The reader translate pane could read a stale selection. After selecting a
  long sentence or paragraph, the pane might still see the previous
  single-word selection: both auto-translate and "Refresh selection" looked
  the old word up again — no "translating" indicator appeared, no error was
  raised, the sentence translation was never started, and the previous word
  card was shown again. The selection text carried by the popup event (the
  text the user sees in the popup) now takes priority over re-reading
  `_selectionRanges`; when the two disagree, the popup wins and a debug
  line is logged; popup text left over after clearing the selection on
  blank space no longer revives the cleared selection. Also hardened: a
  pane whose host window has closed no longer responds to reader events.

## [1.5.0] - 2026-10-09

### Added

- Live selection sync in the reader translate pane. Zotero's official
  "renderTextSelectionPopup" reader event (one shared listener per process,
  fanned out to panes by item identity) re-reads the selection about 250 ms
  after the user completes a selection, so the pane follows the mouse without
  a manual "Refresh selection" click. A re-fire for an unchanged selection is
  a no-op — no duplicate requests, no copy-state resets.
- An "Auto translate" checkbox in the pane's language bar, bound to the
  existing `translate.auto` preference. Turning it on translates the pending
  selection immediately; combined with live sync, a selection produces a
  translation with zero clicks.
- Every bilingual / read-aloud control is now a button. The presentation mode
  (interleave / translation-only) moved from a dropdown to a
  pair of buttons whose active highlight is synced with the session's actual
  mode; the bilingual toggle, mode buttons, and read-aloud buttons share one
  style, with active states in the brand crimson `#b5343a` — same family as
  the pane's primary action and the word-card chips.
- Brand-colored reader-pane icons. The translate section's header and sidenav
  icons adopt a hanzi/A swap motif in the logo's palette (ink = source, crimson =
  translation), replacing the single-color outline glyphs. Zotero switches
  between light and dark variants via `registerSection`'s `darkIcon`, so the
  icons no longer rely on `currentColor`. The QA S7 rule accepts an
  explicitly colored UI icon when a paired `-dark.svg` companion exists.
- A Java runtime install/repair entry point in the settings pane (PDF
  split-screen translation → Java runtime): a status line shows the detected
  state (plugin-managed portable runtime with version, system Java, or not
  found), and "Install / repair…" runs the same progress-window install as
  the missing-Java dialog — reachable at any time, without having to fail a
  translation first. The pane talks to the plugin main bundle through a new
  `Zotero.ZTransplit.java` surface (`getStatus` / `install`); when the bundle
  is not loaded the pane says so instead of failing silently.

### Fixed

- The reader translate pane no longer collapses when the sidebar is dragged
  narrow. The pane (and the bilingual control bar) keep a readable minimum
  width (~248 px); below that the item pane's scroll container shows a
  horizontal scrollbar instead of squeezing the right-hand controls out of
  view, and the language bar wraps.
- The Word Cards tab now fills its container and no longer reflows when a
  card is selected. The tab root is a child of Zotero's `<tab-content>`, a
  flex-row XUL element, so as a plain flex item it was content-sized — on a
  2560 px window the page measured ~1030 px and hugged the left edge, and
  every tile click re-measured the (different) detail content and resized the
  whole page. The root now takes `flex: 1 1 auto; width: 100%`, and selecting
  a card only toggles the tiles' highlight and rebuilds the detail column —
  the grid keeps its DOM, so focus and scroll position survive the click
  (verified on a real Zotero 10.0.3: root 1032→2560 px on open, unchanged on
  selection).
- Opening the Word Cards tab recovers from a failed `Zotero_Tabs.add()`.
  Zotero's add() appends the container and registers the tab before it
  selects it, so anything throwing in between (its own `_update` icon read or
  another plugin's tab observer) left the tab registered but unselected —
  the first click appeared dead and only the second one got in. The open
  path now resolves the container by id and selects the tab itself whenever
  add() did not complete, so a single click always lands on the page.

- The "missing Java → offer install" classification no longer misses real
  failures. The two pipeline catch sites now consult the structured
  `PdfParseError.reason` first (`isJavaMissingCause`) instead of regex-matching
  the message text, and the signature table adds the shells such errors
  actually arrive in: the health-preflight shell ("Java 不可用：…" /
  "Java unavailable: …"), the `java -version failed` fallback, and the zh-CN
  too-old wording ("…需要 Java 11+"). Previously a failed install that left a
  broken managed runtime could route every later attempt to a generic error —
  the install dialog never reappeared and no manual entry point existed.

## [1.4.0] - 2026-10-04

### Added

- Interruption-safe managed JRE installation. When the plugin downloads its
  bundled Temurin JRE for PDF parsing:
  - The downloaded archive is verified against the official Adoptium SHA-256
    checksum and cached. A retry after a failed or interrupted install reuses
    the verified archive and skips the ~45 MB download entirely.
  - Extraction runs in a staging directory and must pass a `java -version`
    probe before being atomically moved into place, so a process killed
    mid-extract can never leave a half-written runtime that is later served
    as valid.
  - A cached but broken managed JRE is detected by probe at three entry
    points (`downloadJRE`, `getJavaStatus`, `checkHealth`), discarded
    automatically, and on the parse path the system Java is used as an
    immediate fallback (self-healing).
  - Retries while offline reuse the locally recorded checksum when the
    Adoptium metadata API is unreachable; a new upstream patch release
    invalidates the cached archive automatically.
  - A checksum mismatch on download now fails fast with a clear error and
    discards the archive instead of extracting corrupt data.
- Managed JRE discovery also understands the macOS bundle layout
  (`jdk-*/Contents/Home/bin/java`).
- A unit test suite for the installer (8 scenarios) drives the real
  `JavaRuntimeManager` against a faked host boundary (in-memory file system,
  fake `nsIProcess` dispatch, fake HTTP) — covering fresh install, interrupted
  extraction with download-skip on retry, checksum mismatch, upstream patch
  refresh, offline reuse, self-healing, status fallback, and the macOS layout.

### Fixed

- A truncated JRE extraction (for example Zotero killed while unpacking) no
  longer poisons every later parse with cryptic JVM errors: the broken
  runtime is discarded and reinstalled on the next attempt.

### Changed

- License corrected from MIT to AGPL-3.0-only, matching Zotero itself.
  `LICENSE` now carries the full AGPL-3.0 text; package metadata, README
  badges, and the bundled JAR provenance manifests are updated accordingly.

## [1.3.0] - 2026-09-30

### Added

- Sibling-repo feedback round: the Bing web translation engine is directly
  selectable, with rate-limit backoff plus network-zone routing and guard
  mechanisms.

## [1.2.0] - 2026-09-30

### Added

- Original-text removal: translated paragraphs are genuinely deleted from
  the page content stream (replacing the white-mask approach); text inside
  image regions is excluded from translation as a whole.
- Real-machine QA rig expansion (probe commands, screenshot scripts, reading
  fixtures) and refreshed Chinese UI screenshots.

### Changed

- Parse errors are classified by HTTP status code with dedicated messages;
  unified dialog helpers; batch-translation progress is throttled by step.

Releases before 1.2.0 predate this changelog and are not backfilled.

[1.14.0]: https://github.com/Liozhang/z-transplit/compare/v1.13.1...v1.14.0
[1.13.1]: https://github.com/Liozhang/z-transplit/compare/v1.13.0...v1.13.1
[1.9.0]: https://github.com/Liozhang/z-transplit/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/Liozhang/z-transplit/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/Liozhang/z-transplit/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/Liozhang/z-transplit/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/Liozhang/z-transplit/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/Liozhang/z-transplit/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Liozhang/z-transplit/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Liozhang/z-transplit/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Liozhang/z-transplit/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Liozhang/z-transplit/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Liozhang/z-transplit/compare/v1.1.0...v1.2.0
