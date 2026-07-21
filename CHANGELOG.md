# Changelog

All notable changes to HYJI will be documented in this file.

> **Versioning note (2.0):** releases before 2.0 were renumbered to a simpler two-part
> scheme — `1.0.x` became `1.x` and `0.1.x` became `0.(x+1)` (so 0.1.0→0.1 … 0.1.7→0.8,
> 1.0.0→1.0 … 1.0.7→1.7). The original git tags are kept and noted next to each entry;
> installer files and download links are unchanged.

## [2.4] - 2026-07-21

### Fixed

- **"Fetch metadata" failing with HTTP 429** — Crossref serves requests without a contact address from a shared *anonymous pool* that is intermittently rate-limited; since the v2.0 privacy cleanup removed the developer email from the request signature, lookups landed in that pool and could get 429 on the very first click. Three-part fix:
  - Transient 429/503 responses are now retried automatically (up to 3 attempts, honoring the server's `Retry-After`).
  - If Crossref still fails, HYJI scans the PDF for an arXiv ID and falls back to the arXiv API — previously the fallback was skipped whenever the DOI field was already filled.
  - Preferences → Network & privacy gains an **optional polite-pool email**: if you enter a contact address, it is appended to the request signature and Crossref serves you from a dedicated, generously-limited "polite pool". Strictly opt-in — leave it empty to stay anonymous (the default; nothing extra is sent). The first-lookup notice mentions this.
- The lookup `User-Agent` now reports the real app version automatically (was a hardcoded "2.x").

## [2.3] - 2026-07-21

### Added

- **Adjustable text stroke weight** — Preferences gains a **PDF text rendering** section with four levels: Off / Subtle / Standard / Strong. The stem-darkening pass introduced in 2.2 used one fixed strength; how heavy text should look is a matter of taste (and of the specific monitor), so now you pick. Changes apply instantly to the open PDF — flip through the options and keep what reads best. Default is Standard (the 2.2 behavior); high-DPI monitors (125%+ scale) remain unaffected as before.

## [2.2] - 2026-07-21

### Improved

- **Darker, Acrobat-like text on standard-DPI monitors** — pdf.js draws glyphs with plain grayscale antialiasing and no hinting, so on a 100%-scale monitor (e.g. an FHD portrait display) text rendered noticeably thinner and lighter than Adobe Acrobat's stem-darkened output. HYJI now applies a stem-darkening pass on such displays (the page is multiplied with itself, squaring the midtones): antialiased glyph edges get pulled darker and edge contrast increases, while white paper stays white. Photos and figures are automatically clipped out of the pass (using the same bitmap-region detection as dark mode) so their colors are untouched. High-DPI displays (≥150% scale) don't need it and are skipped. Tuned side-by-side against Acrobat on a 1080×1920 portrait monitor.

## [2.1] - 2026-07-20

### Fixed

- **Sharp PDF rendering when moving between monitors with different display scales** (e.g. a 125% main monitor → a 100% portrait monitor). Two layers of the bug were fixed:
  - Page canvases were cached per zoom level only, so after a monitor move the old bitmap was resampled to the new pixel ratio and every page turned blurry. The render cache now keys on zoom × `devicePixelRatio` and all pages re-render on a ratio change (text layer and highlight overlay rebuilt to match).
  - The ratio change itself was easy to miss: WebView2 can fire the resolution media-query event *before* `devicePixelRatio` reports the new value, and no further signal follows — the stale, blurry canvas then sticks (this is exactly what the first 2.1 build shipped with). Detection now uses three redundant signals (resolution media query, viewport resize, native Windows DPI-change event via Tauri) and re-reads the ratio several times after each until it settles. Verified on a 125% → 100% portrait-monitor move: canvas backing now matches the monitor 1:1 right after the move.
- **Focus Mode stays crisp on resize** — Focus Mode computed its fit-to-width scale once on entry; resizing the window (or moving it to a portrait/secondary monitor) afterwards stretched the existing canvas instead of re-rendering. The viewer now watches its own size while Focus Mode is active and re-renders at the exact new fit-width scale.

## [2.0] - 2026-07-20

### Added

- **Offline mode** — Preferences gains a **Network & privacy** section with an "Offline mode" switch. Turning it on grays out "Fetch metadata" and guarantees HYJI makes no network requests at all. The section also states HYJI's network policy in one paragraph: the only online feature is the user-initiated metadata lookup, which sends a paper's DOI/arXiv ID — nothing else — directly to `api.crossref.org` or `export.arxiv.org`.
- **First-lookup notice** — the first time you click "Fetch metadata", a one-time dialog explains exactly what will be sent and where, and that PDFs, notes, and your library never leave the computer. Confirm once and it never asks again; Cancel sends nothing.

### Changed

- **Versioning simplified** — release numbers move to a two-part scheme (see note above); this release is **2.0**. The Windows build/installer version is `2.0.0` (installers require three-part versions).
- **Cleaner request signature** — online lookups now identify the app by its GitHub repository URL only; the developer's personal email was removed from the `User-Agent`.

## [1.7] - 2026-07-20 *(git tag v1.0.7)*

### Fixed

- **Text-selection highlight visible again while dragging** — the previous whitespace-bleed mitigation (span marking by `scaleX` threshold) over-matched normal word spans, making drag selection nearly invisible in many PDFs. Selection suppression now applies only to whitespace-only spans: you see what you select, and the full-line flash from stretched space spans stays suppressed.

## [1.6] - 2026-07-20 *(git tag v1.0.6)*

### Added

- **Dark mode keeps figures natural** — photos and figures are no longer shown as negatives in PDF dark mode: HYJI locates every bitmap image on the page (via the render operator list) and counter-inverts exactly those regions, so text reads light-on-dark while figures keep their true colors.
- **Search covers your notes** — the library search overlay now also matches Summary, Differentiation, Questions, and Abstract text, not just titles/authors/venues.

### Fixed

- **File → Export Selected…** is now grayed out when nothing is selected (previously it opened an explanatory dialog).

## [1.5] - 2026-07-20 *(git tag v1.0.5)*

### Added

- **Fetch metadata online** — a "🌐 Fetch metadata (DOI / arXiv)" button in the tracker's metadata section looks the paper up on Crossref (falling back to the arXiv API). The DOI or arXiv ID is taken from the paper's DOI field or extracted automatically from the first pages of the PDF. A confirmation dialog shows exactly which fields would change (old value struck through) — untick anything you want to keep, then Apply. Fills title, authors, year, venue (normalized), type, publisher, pages, DOI, abstract, and link.
- Requests go directly from your machine with a polite `User-Agent` (no account, no proxy, no tracking); the feature simply does nothing when offline. This is a deliberate, narrow exception to the "no web scraping" non-goal — lookup only, never bulk downloading.

## [1.4] - 2026-07-20 *(git tag v1.0.4)*

### Added

- **Unified full-text search** — one Spotlight-style overlay searches paper titles/authors/venues *and the actual text of every PDF* (Korean and English; SQLite FTS5 trigram index, with a substring scan for 1–2 character queries). `Ctrl+Shift+F` opens it over the whole library; `Ctrl+F` opens the same overlay pre-scoped with a **"This document only"** checkbox, so in-document search is simply a filter, not a separate feature. Results show the matching page with a highlighted snippet — Enter or click jumps there, and the query carries into the classic in-page match navigator (▲▼) so the hit is highlighted on arrival.
- **Toolbar search box** — the toolbar now shows a persistent Search box; clicking or focusing it summons the overlay scoped to the open document. No retyping, no mode buttons.
- **Background indexing** — PDFs are indexed automatically a few seconds after launch and whenever new papers are imported; opening the document-scoped search indexes that paper on demand if needed. Tools → Rebuild Search Index… re-extracts everything from scratch.

### Changed

- `Ctrl+F` / Edit → Find in PDF now opens the unified overlay (document scope) instead of the small inline bar; the inline bar still appears for stepping through matches after a jump. The sidebar paper filter remains available via the ⌕ button in the PAPERS section.

## [1.3] - 2026-07-20 *(git tag v1.0.3)*

### Added

- **Underline & strikeout** — the selection context menu now offers Underline and Strikeout rows next to Highlight, in the same four colors. They render as clean lines in the viewer, survive printing, and export to PDF as standard `/Underline` and `/StrikeOut` annotations that other viewers understand.
- **Import annotations from other viewers** — Tools → Import Annotations from PDF… finds highlights, underlines, strikeouts, and sticky notes created in Adobe Acrobat (or any other viewer) and imports them into HYJI as native, editable annotations. Comments on highlights and sticky-note text become HYJI memos. After a confirmation, the originals are moved out of the PDF file so nothing displays twice — "Save annotations to PDF" writes everything back in standard form.

## [1.2] - 2026-07-20 *(git tag v1.0.2)*

### Added

- **PDF dark mode** — `Ctrl+D`, View → PDF Dark Mode, or the toolbar moon button inverts the rendered page for night reading (soft 92% inversion so whites don't glare). Highlight colors, text selection, and search matches keep their true colors over the darkened page. The setting persists across sessions.
- **Abstract in the tracker panel** — the abstract stored since v0.8 finally has a UI: an editable Abstract field in the metadata section.
- **DOI quick-open** — a `↗` button next to the DOI field opens the paper on doi.org in the system browser.
- **Backup on exit** — if auto-backup is enabled and the database changed since the last backup, HYJI takes one final backup as it closes (the interval timer alone could miss recent edits).

### Fixed

- **About dialog version** — now read from the app manifest at runtime; it was hardcoded and still showed "1.0.0" after updates.

## [1.1] - 2026-07-20 *(git tag v1.0.1)*

### Added

- **Multi-tab PDF viewing** — Open papers side by side in a browser-style tab strip: one tab per paper, `＋` to import, per-tab `✕`, middle-click close, `Ctrl+W` to close the active tab. Each tab remembers its own zoom level and reading position, and open tabs are restored on the next launch. Double-click the active tab title to rename the paper.
- **Single-instance app** — Opening a PDF from Explorer while HYJI is already running now opens it as a new tab in the existing window instead of launching a second window. Forwarded files are queued Rust-side, so nothing is lost even if the app is still starting up.
- **CJK / CID font rendering** — pdf.js CMap tables, standard fonts, and wasm image decoders are now bundled with the app. Korean/Japanese/Chinese PDFs (Adobe-Korea1, Identity-H CID fonts, etc.) render their text correctly instead of showing an empty layout skeleton.
- **Annotation interoperability** — "Save annotations to PDF" now writes real, standard `/Highlight` annotations (QuadPoints + Multiply-blend appearance streams; memo text stored as the annotation comment) instead of burning opaque rectangles. Highlights and memos made in HYJI are visible and editable in Adobe Acrobat and other viewers; highlights made in other viewers render in HYJI. Page rotation (`/Rotate 90/180/270`) and CropBox offsets are handled correctly.
- **RIS export** — The Export dialog gains an RIS (`.ris`) format alongside BibTeX/Word/CSV, with journal-name formatting (full / abbreviated). Author lists are recovered from the preserved raw BibTeX so `Last, First` names export as correct individual `AU` lines.
- **Print** — File → Print… and `Ctrl+P` print the open PDF (high-resolution render with highlights included), joining the existing toolbar button.
- **Startup layout preference** — Preferences gains a "Startup layout" section: Remember last layout / Full workspace / Viewer only. Viewer-only starts HYJI with all panels closed for people who use it purely as a PDF reader; panel visibility now persists across sessions.
- **Any-drive support** — PDFs on non-C: drives (D:, E:, USB sticks, network paths) now open and import correctly; the file-system permission scope previously covered only the user-profile folders.

### Fixed

- **Annotations not loading with hidden panels** — Highlights now load whenever a paper opens, even in Focus Mode or viewer-only layout (loading was previously tied to the tracker panel being visible).
- **Data loading tied to the sidebar** — Papers, projects, and keywords now load at app level; starting with a hidden sidebar no longer shows an empty Dashboard and empty tab strip.
- **Duplicate imports** — Importing or drag-dropping a PDF that is already in the library now activates the existing paper instead of creating a duplicate entry (which split notes/highlights across two records).
- **Duplicate menu handlers** — Edit → Delete Paper no longer shows two confirmation dialogs; `Ctrl+/` no longer opens two stacked shortcut modals; the dead Edit → Select Mode item was removed.
- **Menu items silently ignored while their panel was hidden** — Export All…, New Project, Find Paper, Keyword Graph (`Ctrl+G`), Expand Metadata (`Ctrl+M`) etc. now auto-show the panel they need instead of doing nothing.
- **Focus Mode dead-ends** — Closing the last tab (or returning to the Dashboard) while in Focus Mode no longer strands the app with all panels hidden and `Esc`/`Ctrl+L` unresponsive.
- **Deleting a project made its papers vanish** — Papers of a deleted project folder now immediately reappear under UNASSIGNED.
- **Stale search state across tabs** — The in-PDF search query and match count reset when switching tabs.
- **RIS field integrity** — Newlines inside abstracts no longer produce malformed RIS records.

## [1.0] - 2026-04-30 *(git tag v1.0.0)*

### Official Release

- All features from v0.1 through v0.8 are now production-ready
- New app icon with improved visibility at small sizes
- PDF internal reference click with return-to-position and extended flash animation (3.5s)
- Updated README with "Why HYJI?" section highlighting key differentiators

### Fixed

- **Highlight gaps at spaces** — Stored highlights now merge adjacent rects per line so word-gap spaces are filled, giving a clean continuous highlight instead of a striped appearance
- **Empty bullet lines visible in note editors** — Blank lines in Summary, Differentiation, and Questions no longer render as visible empty rows; the stored index is preserved so linked bullets remain correctly anchored

### Changed

- **File menu** — Removed "Preferences…" from File menu; now only accessible via Tools menu
- **Tools menu** — Added "Reset to Blank (Clear All Data)…" for wiping the database back to a blank state; Preferences moved to the very bottom of the menu

## [0.8] - 2026-04-29 *(git tag v0.1.7)*

### Added
- **Export dialog with citation styles** — File → Export Selected… / Export All… opens a dialog where you pick output format (LaTeX `.bib`, Word references `.txt`, CSV, or Copy to clipboard), citation style (IEEE / ACS / Nature / APA / MLA), starting number (or no numbers), and journal-name format (full / abbr with dots / abbr no dots). Live preview updates as you change options.
- **RIS import** — Smart Paste detects pasted RIS records (anything starting with `TY  -`); dragging a `.ris` file onto the window also opens Smart Paste pre-filled with the parsed entry. Maps TY/AU/TI/JO/PY/VL/IS/SP/EP/DO/PB/UR/KW/AB to HYJI fields.
- **Reference types** — `papers` table gains `ref_type`, `publisher`, `edition`, `chapter`, `pages`, `doi`, `abstract_text`. The tracker metadata panel now has a Type dropdown (Article / Conference / Book / Book chapter / Thesis / Misc) and shows Publisher/Edition/Chapter conditionally. BibTeX export emits the matching `@article` / `@inproceedings` / `@book` / `@inbook` / `@phdthesis` / `@misc` and includes Pages/DOI fields.
- **Venue/journal abbreviation mapping** — Replaced the inline 40-entry venue map with a 247-entry JSON dataset (`src/lib/venues.json`) covering ISO 4 / CASSI conventions. New `formatVenue(input, "full" | "abbr" | "abbr_nodots")` accepts any form (full, abbreviation, or short code) and returns the requested form. Imports normalize to the full name; exports format on the fly.
- **Focus Mode** — `Ctrl+L` (or View → Focus Mode) hides the sidebar and tracker panel and applies Fit Width on the PDF. Toggle off with `Ctrl+L` again or `Esc`. A small `Focus` pill in the toolbar exits as well. Manually re-opening either panel auto-deactivates focus.
- **Auto-backup** — File / Tools → Preferences… opens a settings dialog with auto-backup options: enable, folder, interval (5/10/30 min or 1 hour), only-on-change, keep last N. The Rust backend writes a `hyji_config.json` next to the database, runs a 60s ticker thread that copies the SQLite file to the backup folder when dirty + interval has elapsed, and rotates old backups.

### Changed
- **File menu restructure** — "Export Selection Mode" → "Selection Mode" (Ctrl+Shift+S); the three "Export All (.bib / Word / CSV)" items collapse into "Export Selected…" and "Export All…", both routed to the new export dialog. Added "Preferences…" above Exit (and a duplicate in Tools).
- **View menu** — Added "Focus Mode" (Ctrl+L) and "Expand Metadata" (Ctrl+M) entries to match what the keyboard shortcuts already supported.

## [0.7] - 2026-04-29 *(git tag v0.1.6)*

### Added
- **PDF file association — open PDFs directly from Windows Explorer** — Setting HYJI as the default `.pdf` handler now works as expected: double-clicking any PDF launches HYJI and auto-imports the file as an unassigned paper. Backend stashes the launch-time argv path in a `PendingOpenFile` state; the frontend invokes `take_pending_open_file` on mount, runs `extractPdfMeta` for the title, and creates the paper with `project_id = null` so it lands under the existing **Unassigned** section. Drag it into a project folder later when you're ready.

### Fixed
- **Sidebar/menu scrollbars were nearly invisible** — Bumped the global scrollbar from 6px / `--border` color to 8px / 40 % white (60 % on hover, 4 px radius). Affects the project tree, tracker panel, PDF viewer, and every popup menu.
- **Right-click "Move to" menu got cut off with many projects** — Both the project and paper context menus now apply `max-height: calc(100vh - 40px)` with `overflow-y: auto`, and a new `ClampedMenu` wrapper measures the menu after render and shifts it upward (and inward) so it never overflows the window edges. Mouse-wheel scrolling is contained to the menu (`overscroll-behavior: contain`).

## [0.6] - 2026-04-09 *(git tag v0.1.5)*

### Fixed
- **Keyword graph shakes while typing notes** — Editing any note field (Summary, Differentiation, Questions) triggered `updatePaper` → `fetchPapers`, which produced a new `papers` array reference. This caused `projectPaperIds` to rebuild a new `Set`, invalidating the `scopedKeywords` → `nodes` memo chain and restarting the D3 simulation on every keystroke. Fixed by deriving a stable string key from paper IDs only; the Set (and everything downstream) now only rebuilds when papers are actually added, removed, or moved — not when their content changes.

## [0.5] - 2026-04-09 *(git tag v0.1.4)*

### Added
- **Auto context menu on text selection** — Dragging to select text in the PDF now shows the highlight/memo/send menu automatically (80 ms after mouse release). Right-click still works as before.
- **Context menu viewport clamping** — Menu is repositioned so it never overflows the screen edge.
- **Selection cleared on menu dismiss** — Clicking outside the context menu now also clears the text selection, consistent with native PDF reader behavior.

### Fixed
- **Garbled keyword extraction from hyphenated PDF titles** — When a PDF's text layer encodes the title without word spaces or with line-break hyphens (e.g. "CORRE- SPONDENCE…"), `extractFromTitle` now joins hyphenated breaks before splitting and returns `[]` for any word longer than 18 chars, preventing word-fragment keywords like `corre`, `turefinetuning` from appearing in the graph.
- **First-page keyword scan rejects concatenated text** — Added `looksGarbled()` validation to the first-page "Keywords:" regex match: if extracted tokens contain obvious word concatenations (token > 18 chars, or token ends with a known multi-syllable suffix with a prefix), the batch is discarded and falls through to the title fallback.
- **Stopword list expanded** — Added `improves`, `improved`, `improving`, `minimal`, `minimum`, `maximum`, `better`, `best`, `good`, `simple`, `without` to reduce noise in title-based keyword extraction.

## [0.4] - 2026-04-08 *(git tag v0.1.3)*

### Fixed
- **XMP keyword extraction** — Keywords stored exclusively in XMP metadata (e.g. Oxford Academic / JCDE journals) were not extracted because pdfjs transfers (detaches) the raw `ArrayBuffer` to its worker thread on load, leaving the bytes empty for subsequent reads. Fixed by searching the raw PDF bytes for `<pdf:Keywords>` **before** passing them to pdfjs, and giving pdfjs a copy (`bytes.slice()`) so the original buffer remains intact.

## [0.3] - 2026-04-07 *(git tag v0.1.2)*

### Fixed
- **Keyword duplication on paper import** — Two React effects (`regenForPaper` in PdfViewer and `autoExtractForPapers` in KeywordGraph) fired concurrently on every paper open, causing a race condition that inserted the same keywords twice. Fixed by removing the redundant auto-regen from PdfViewer, switching all keyword inserts to `INSERT OR IGNORE`, and adding a `UNIQUE(paper_id, keyword)` index with a dedup migration to clean up existing duplicates.
- **Keyword graph nodes clumped after Regenerate Keywords** — After running Tools → Regenerate Keywords, D3 initialized fresh nodes at ~(0, 0) and `forceCenter` pulled them all to the canvas center before `forceManyBody` could push them apart. Fixed by pre-placing new nodes in a circle around the center before handing them to the force simulation.

### Added
- **Import PDF button in sidebar Projects header** — Two icon buttons now sit next to the "PROJECTS" label: a folder icon (📁+) for New Folder and a document icon (📄+) for Import PDF. Removes the need to use File menu or keyboard shortcut for the most common action.

### Removed
- Plain `+` button (New Blank Paper) from the Papers section header — superseded by the Import PDF button in the Projects header.

## [0.2] - 2026-04-06 *(git tag v0.1.1)*

### Improved
- Questions section color changed to more vivid violet (#7c3aed) for better readability against dark background
- All font sizes converted from px to rem units for consistent scaling across displays

### Added
- Text size options in View menu: Default / Large / X-Large
- About HYJI modal GitHub button now opens repository in browser
- Help → GitHub Repository menu item linked to repository

### Removed
- Text size keyboard shortcuts (Ctrl+Shift+. / Ctrl+Shift+,) removed to avoid conflicts

## [0.1] - 2026-04-06 *(git tag v0.1.0)*

### Added
- Three-panel resizable layout (sidebar, PDF viewer, tracker)
- Built-in PDF viewer with zoom, page navigation, text search, continuous scroll, Ctrl+Wheel zoom
- Multi-color text highlighting (yellow, green, blue, pink, orange) with SVG overlay rendering (no overlap artifacts)
- Margin memos on highlighted text — click icon to expand/edit
- Bidirectional PDF-to-notes linking (Send to Differentiation / Send to Questions); click 🔗 on linked bullet to jump back to exact PDF location with flash animation
- Structured research notes: Summary, Differentiation, Questions with contenteditable bullet editor (Enter/Shift+Enter/Backspace behavior)
- Collapsible metadata section with title, authors, year, venue, link, keywords (collapsed by default — notes first)
- Smart Paste: BibTeX, citation string, or arXiv ID auto-parsing with raw BibTeX preserved verbatim on export
- Venue name mapping: long conference names auto-shortened (e.g. CVPR, NeurIPS)
- Project folder tree with collapsible folders, drag-to-reorder, inline F2 rename
- Paper items shown inline under project folders; right-click project for subfolder, rename, delete, PDF folder settings
- Keyword graph in sidebar: D3 force-directed, auto-extracted from PDF metadata and title; click node to filter papers
- BibTeX export: individual "Copy BibTeX" button + batch .bib export via select mode
- JSON / CSV full database export
- Notion database export script generator (Python, notion-client)
- Save highlights to PDF as standard annotations (pdf-lib)
- Print support with highlights rendered (high-res 3x scale via iframe)
- Notion-style dashboard with recent papers, reading stats, and quick actions
- About HYJI dialog with app icon and version info
- Keyboard Shortcuts modal (Ctrl+/)
- Paper filters: by status (Surveyed / Fully Reviewed / Revisit Needed) and importance
- Paper sort: by order, date read, year, title, author, importance
- Paper search: Ctrl+Shift+F searches title, authors, venue, summary
- Auto-save: all changes written to SQLite immediately
- Dark theme with iOS-inspired clean aesthetic
- Auto-updater via GitHub Releases (checks on launch, one-click install)
- Windows .msi installer via Tauri bundler
- PDF drag-and-drop import with copy-into-project or link-from-location choice
- PDF metadata extraction from first page (title, authors, year, venue)
- Clickable hyperlinks in PDF (external URLs → system browser; internal refs → scroll + flash)
