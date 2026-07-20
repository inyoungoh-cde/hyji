# HYJI — Current State Document (for external research / LLM context)

> Purpose: paste this document into any research chat (with web search) to get
> grounded feature-gap analysis, competitor comparisons, or implementation
> research for HYJI. It describes exactly what exists today, what is known to
> be missing, and the open research questions.
>
> Last updated: 2026-07-20 · Codebase: post-v1.0.0 working tree (unreleased v1.1.0 changes included)

---

## 1. What HYJI is

- **HYJI** (/hai-jee/) — "Highlight Your Journey of Insights"
- A **local-first Windows desktop research hub** for reading, annotating, and tracking academic papers. The PDF is the primary object; notes, metadata, keywords, and relationships are built around it.
- **MIT-licensed, 100% free, no accounts, no cloud, no AI** (by design for v1.x).
- Target users: researchers (CV/ML and general academia) who read conference/journal PDFs and need a lightweight Zotero-alternative focused on *reading + note-taking*, not just citation management.
- Distribution: GitHub releases, `.msi` installer, Tauri auto-updater.

## 2. Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust + WebView2), ~10MB binary |
| UI | React 18 + TypeScript (strict) + Tailwind CSS, dark-mode-first |
| PDF | pdf.js v5 (canvas render + text layer + annotation layer; cMaps/standard fonts/wasm bundled) |
| PDF write | pdf-lib (standard /Highlight annotation export with appearance streams) |
| DB | SQLite via tauri-plugin-sql (local file `hyji.db`) |
| State | Zustand stores (papers / ui / projects / annotations / keywords) |
| Graph | D3 force layout (keyword co-occurrence) |

## 3. Feature inventory (implemented, working today)

### Library / organization
- Project folder tree (nested), papers inline under folders, drag-to-reorder, drag paper→project, UNASSIGNED section
- Virtual scrolling for large libraries (@tanstack/react-virtual)
- Filters (status: Surveyed/Fully Reviewed/Revisit Needed; importance: Noted/Potentially Relevant/Must-Cite), sort (order/date/year/title/author/importance), sidebar paper search (title/author/venue/summary)
- Dashboard home: greeting, quick actions, recent papers, stats, project shortcuts
- Keyword extraction (PDF XMP/info-dict + title heuristics), manual keywords, D3 keyword graph (sidebar mini + fullscreen Ctrl+G), keyword-click filtering

### PDF viewing
- Continuous-scroll canvas rendering + selectable text layer, lazy per-page render via IntersectionObserver
- **Multi-tab viewing** (browser-style tab strip: per-tab ✕, middle-click close, Ctrl+W, + to import, tab overflow scroll, per-tab zoom memory, per-file scroll-position memory, tabs persist across sessions)
- **Single-instance app**: opening a PDF from Explorer while HYJI runs forwards it to the existing window as a new tab (tauri-plugin-single-instance); `.pdf` file association
- Zoom (fit-width/manual/Ctrl+Wheel), page nav, in-PDF search with match navigation, internal link navigation with flash + "Back to reading" pill, external links → system browser
- **CJK/CID font support**: pdf.js cMaps + standard fonts + wasm decoders bundled (Korean/Japanese/Chinese PDFs render correctly)
- Works from any drive (C:/D:/USB — fs scope covers all local paths)
- Print (Ctrl+P, File menu, toolbar): 3x-scale render with highlights burned in → system print dialog
- Focus Mode (Ctrl+L): hides all panels; startup layout preference (Remember last / Full workspace / Viewer only) in Preferences

### Annotation
- Text highlights (5 colors) via selection + auto context menu; SVG overlay rendering (no overlap artifacts); merged per-line rects (no gaps at spaces)
- Margin memos anchored to selections (editable floating notes)
- **Send to Tracker**: selection → Differentiation/Questions bullet + bidirectional link (🔗 bullet click → PDF scrolls + flashes annotation)
- **Interop export**: "Save annotations to PDF" writes standard `/Highlight` annotations (QuadPoints, Multiply-blend appearance streams, memo text in `/Contents`, author `T=HYJI`) → visible/editable in Adobe Acrobat and other viewers
- **Interop import**: annotations made in other viewers (Adobe etc.) render on the canvas (pdf.js paints their appearance streams)

### Tracker panel (right)
- Notes-on-top layout: Summary / ✦Differentiation / ?Questions bullet editors (contenteditable; Enter/Shift+Enter/Backspace semantics; empty bullets hidden)
- Collapsible metadata: title/authors/year/venue (247-entry ISO4/CASSI venue normalization)/status/importance/date/LINK/keywords/ref_type (article/inproceedings/book/inbook/phdthesis/mastersthesis/misc) + publisher/edition/chapter/pages/DOI/abstract
- Copy BibTeX (raw BibTeX preserved verbatim if pasted; else type-aware generation)

### Import / export
- Smart Paste (Ctrl+N): BibTeX / RIS / citation string / arXiv ID / plain title → parsed preview → paper
- PDF import: drag-drop, Ctrl+O, dashboard button; copy-into-project or link-in-place; first-page metadata extraction (title/venue heuristics)
- Duplicate-open dedup: opening an already-imported PDF path activates its existing paper
- Export dialog: **LaTeX .bib / RIS .ris / Word references .txt / CSV / clipboard**, citation styles (IEEE/ACS/Nature/APA/MLA), journal-name format (full/abbr/abbr-no-dots), numbering options, live preview
- Selection mode for bulk export; DB backup/restore; auto-backup (interval, rotation, only-on-change) with Preferences UI

### App chrome
- Native menu bar (File/Edit/View/Tools/Help) — all items wired to frontend handlers
- Keyboard shortcuts for everything + shortcuts modal (Ctrl+/)
- Text size presets; 8px overlay scrollbars; iOS-clean dark aesthetic (#0d1117 family)

## 4. Known gaps & candidate roadmap (honest assessment)

### Reference-manager side (vs Zotero/Mendeley/EndNote)
- ❌ No online metadata lookup (DOI/Crossref/arXiv/Semantic Scholar fetch) — metadata comes only from the PDF itself or paste
- ❌ No browser extension / "save to HYJI" from the web
- ❌ No full-text search across the whole library (only per-PDF search + metadata search) — SQLite FTS5 is the natural fit
- ❌ No duplicate detection at import beyond exact file-path match (no DOI/title fuzzy dedup)
- ❌ No citation key management for LaTeX (keys auto-generated, not user-editable/stable)
- ❌ One PDF per paper (no supplementary attachments)
- ❌ No collections/tags beyond single project folder + keywords

### PDF-viewer side (vs Adobe/PDF-XChange/Drawboard/Sioyek)
- ❌ No freehand ink, shapes, underline/strikeout/squiggly annotation types (only highlight + anchored memo)
- ❌ No two-page / book spread view, no page rotation, no crop
- ❌ No dark-mode PDF rendering (color inversion for night reading)
- ❌ No OCR for scanned PDFs (text layer empty → no selection/search)
- ❌ No form filling / signatures
- ❌ Interop import is display-only: external annotations render but can't be edited/deleted inside HYJI (no "import to DB" conversion yet)

### Notes/knowledge side (vs Obsidian/Notion/Logseq)
- ❌ Notes are three fixed fields (Summary/Differentiation/Questions) — no free-form markdown pages, no backlinks between papers, no graph of paper↔paper citations
- ❌ No global search across notes
- ❌ Export of notes is limited (papers export covers metadata; notes only via CSV/JSON dumps; Notion export script exists but is one-way)

### Platform / infra
- ❌ Windows only (Tauri is cross-platform; macOS/Linux builds are unbuilt/untested)
- ❌ No cloud sync / multi-device (local-first by design; conflict-free sync is a big lift)
- ❌ No i18n (UI is English-only)
- ⚠️ No automated test suite (manual + ad-hoc headless pdf.js tests only)

## 5. Design positions (do not "fix" these without discussion)
- Local-first, no accounts, no telemetry — differentiator vs Mendeley/ReadCube
- No AI features in v1.x — keep the core fast and offline; AI is a v2 conversation
- PDF-centric (not citation-centric like Zotero) — reading experience is the moat
- Raw BibTeX preserved verbatim — zero round-trip loss

## 6. Research questions (paste-ready prompts)

1. **Library full-text search**: Best practice for SQLite FTS5 with CJK (Korean) tokenization in 2026 — trigram vs ICU vs signal-fts5-extension? How do Zotero 7 and Recoll handle CJK full-text indexing of PDFs?
2. **Metadata lookup**: Current free APIs and rate limits for DOI/arXiv/Semantic Scholar/Crossref/OpenAlex metadata-by-title or by-PDF-hash (2026 status). Which do Zotero translators use for "retrieve metadata from PDF"?
3. **OCR**: Feasible offline OCR pipelines for a Tauri app (tesseract.js wasm vs bundled tesseract vs Windows.Media.Ocr API) — accuracy/speed for two-column academic PDFs, Korean+English mixed.
4. **Dark-mode PDF rendering**: How do viewers implement PDF color inversion that keeps images natural (e.g. Sioyek/Koodo/Xodo custom color modes)? pdf.js-level approaches?
5. **Annotation interop**: Which annotation subtypes (Ink, Underline, StrikeOut, FreeText, Text) does pdf.js render reliably from third-party PDFs, and what writers (pdf-lib alternatives, e.g. mupdf.js) produce Adobe-round-trippable annotations?
6. **Citation graph**: Free APIs for reference/citation edges between papers (Semantic Scholar Graph API, OpenAlex) suitable for a local app; typical quotas.
7. **Competitor matrix**: 2026 feature/pricing snapshot of Zotero 7, Mendeley, Paperpile, ReadCube Papers, Sioyek, SumatraPDF, PDF-XChange, Drawboard, Obsidian+Zotero-integration — which "must-have" features do free tiers actually cover?
8. **Cross-platform**: Gotchas shipping Tauri v2 apps on macOS (notarization, WebKit differences for pdf.js text layer) vs the current Windows/WebView2 build.

## 7. Repository shape (for code-level questions)

```
hyji/
├── src-tauri/            # Rust: menu, single-instance, backup loop, fs scope caps
│   ├── src/lib.rs        # builder, menu defs, PendingOpenFile, single-instance init
│   ├── src/backup.rs     # auto-backup config/loop
│   └── capabilities/default.json  # fs scope (all local paths), dialog, sql, updater
├── src/
│   ├── App.tsx           # 3-panel layout, menu-event bridge, file-association + single-instance listeners
│   ├── stores/           # zustand: papers, ui (tabs/panels/focus), projects, annotations, keywords
│   ├── components/
│   │   ├── layout/       # Sidebar, PdfViewer (tab strip + toolbar + canvas host), TrackerPanel, Splitter
│   │   ├── pdf/          # PdfCanvas (pdf.js), HighlightLayer, ContextMenu, Toolbar, MemoEditor
│   │   ├── tracker/      # MetadataForm, BulletEditor, NoteSection, LinkedBullet
│   │   ├── sidebar/      # ProjectTree, PaperControls, KeywordGraph(+Fullscreen)
│   │   └── shared/       # SmartPaste, ImportDialog, ExportDialog, PreferencesDialog, modals
│   └── lib/              # parser (BibTeX/RIS/citation), bibtex, ris, citations, venueMap(247),
│                         # pdfMeta, pdfKeywords, pdfjsAssets, pdfAnnotExport, openPdf, backup, db
└── vite.config.ts        # copies pdfjs cmaps/standard_fonts/wasm → public/pdfjs
```

DB schema: `projects`, `papers` (biblio + status + notes + pdf_path), `annotations` (rects_json, color, memo), `note_links` (bullet↔annotation), `keywords`. All FK cascade on paper delete.
