# CLAUDE.md — HYJI (Highlight Your Journey of Insights)

## Project identity

- **Name**: HYJI (pronounced /hai-jee/)
- **Tagline**: Highlight Your Journey of Insights
- **What it is**: A desktop research hub for reading, annotating, and tracking academic papers. PDF-centric — the PDF is the primary object, everything else (notes, metadata, relationships) is built around it.
- **Who it's for**: Researchers who read PDFs — computer vision, ML, any academic field. Conference papers (CVPR, NeurIPS) and journal papers (TPAMI, IJCV) equally.
- **License**: Open-source (MIT)
- **Platform**: Windows only (v1.0)

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | **Tauri v2** (Rust + WebView2) | Small binary (~10MB), native perf, auto-updater built-in |
| Frontend | **React 18 + TypeScript** | Component model, ecosystem, familiarity |
| Styling | **Tailwind CSS** | Utility-first, consistent design tokens, dark mode |
| PDF rendering | **pdf.js** (Mozilla) | Industry standard, text layer for selection, runs in WebView |
| Database | **SQLite** via `better-sqlite3` or Tauri's `tauri-plugin-sql` | Local, zero-config, fast, portable |
| State | **Zustand** | Minimal boilerplate, works well with Tauri IPC |
| Build | **Vite** | Fast HMR, Tauri-compatible out of the box |
| Graph viz | **D3.js** (force layout) | Flexible, no heavy deps, good for keyword node graph |
| PDF export | **pdf-lib** | Burn highlights into PDF as standard annotations |
| Installer | Tauri bundler → `.msi` for Windows | Single file install, auto-update via GitHub releases |

---

## Architecture overview

```
hyji/
├── src-tauri/          # Rust backend
│   ├── src/
│   │   ├── main.rs     # Tauri entry
│   │   ├── lib.rs      # Builder setup, menu, PendingOpenFile, BackupState init
│   │   ├── commands.rs # Tauri IPC command handlers (placeholder stubs)
│   │   └── backup.rs   # Auto-backup: config R/W, perform_backup, spawn_backup_loop
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                # React frontend
│   ├── App.tsx         # Root layout (3-panel with splitters)
│   ├── stores/         # Zustand stores
│   │   ├── papers.ts   # Paper CRUD, filters, sort
│   │   ├── ui.ts       # Panel sizes, modal state, active paper
│   │   └── projects.ts # Project/folder tree
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx       # Project tree + keyword graph
│   │   │   ├── PdfViewer.tsx     # pdf.js wrapper with annotation layer
│   │   │   ├── TrackerPanel.tsx  # Metadata + notes panel
│   │   │   └── Splitter.tsx      # Draggable resize handle
│   │   ├── home/
│   │   │   └── Dashboard.tsx     # Notion-style welcome/home screen
│   │   ├── sidebar/
│   │   │   ├── ProjectTree.tsx         # Folder tree + inline paper items (📁/📄)
│   │   │   ├── PaperControls.tsx       # Compact filter/sort/select/export controls
│   │   │   ├── PaperList.tsx           # (legacy — superseded by PaperControls)
│   │   │   ├── KeywordGraph.tsx        # D3 force-directed mini graph
│   │   │   └── KeywordGraphFullscreen.tsx # Full-screen D3 overlay (Ctrl+G)
│   │   ├── pdf/
│   │   │   ├── PdfCanvas.tsx     # pdf.js page rendering
│   │   │   ├── TextLayer.tsx     # Text selection + highlight overlay
│   │   │   ├── HighlightLayer.tsx# Rendered highlights with colors
│   │   │   ├── ContextMenu.tsx   # Right-click: highlight, memo, send to tracker
│   │   │   └── Toolbar.tsx       # Zoom, page nav, search, highlight color picker
│   │   ├── tracker/
│   │   │   ├── MetadataForm.tsx  # Title, authors, year, venue, code link
│   │   │   ├── StatusBar.tsx     # Status, importance, date read
│   │   │   ├── ClassificationBar.tsx # Task, input modality
│   │   │   ├── BulletEditor.tsx  # contenteditable bullet note editor
│   │   │   ├── NoteSection.tsx   # Summary / Differentiation / Questions
│   │   │   └── LinkedBullet.tsx  # Bullet with PDF anchor link
│   │   ├── shared/
│   │   │   ├── SmartPaste.tsx       # BibTeX / citation / arXiv ID / RIS parser modal
│   │   │   ├── ImportDialog.tsx     # PDF import dialog (copy/link, project selector)
│   │   │   ├── ExportDialog.tsx     # Export dialog with citation styles + format options
│   │   │   ├── PreferencesDialog.tsx # Auto-backup & settings dialog
│   │   │   ├── AboutModal.tsx       # About HYJI modal
│   │   │   ├── KeyboardShortcutsModal.tsx # Keyboard shortcuts reference modal
│   │   │   ├── Badge.tsx
│   │   │   ├── Modal.tsx
│   │   │   └── Select.tsx
│   ├── lib/
│   │   ├── parser.ts      # BibTeX / citation / arXiv ID / RIS parsing logic
│   │   ├── bibtex.ts      # Type-aware BibTeX generation from paper metadata
│   │   ├── citations.ts   # Citation formatters: IEEE/ACS/Nature/APA/MLA
│   │   ├── pdfMeta.ts     # Extract title/authors/abstract from PDF first page
│   │   ├── venueMap.ts    # 247-entry venue lookup (full/abbr/abbr_nodots/code)
│   │   ├── venues.json    # Venue data file (ISO 4 / CASSI)
│   │   └── backup.ts      # Frontend wrapper for backup Tauri commands
│   ├── styles/
│   │   └── globals.css    # Tailwind imports + custom CSS variables
│   └── main.tsx
├── package.json
├── tailwind.config.ts
├── vite.config.ts
├── tsconfig.json
└── CLAUDE.md              # This file
```

---

## Database schema (SQLite)

```sql
-- Projects / folders
CREATE TABLE projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Papers (core entity)
CREATE TABLE papers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

  -- Bibliographic
  title TEXT NOT NULL,
  first_author TEXT DEFAULT '',
  authors TEXT DEFAULT '',
  year INTEGER,
  venue TEXT DEFAULT '',           -- normalized to full name (via normalizeVenue)
  link TEXT DEFAULT '',            -- any URL (replaces code_link, task, input_modality)
  raw_bibtex TEXT DEFAULT '',      -- original BibTeX if pasted
  ref_type TEXT DEFAULT 'article', -- article/inproceedings/book/inbook/phdthesis/mastersthesis/misc
  publisher TEXT DEFAULT '',
  edition TEXT DEFAULT '',
  chapter TEXT DEFAULT '',
  pages TEXT DEFAULT '',
  doi TEXT DEFAULT '',
  abstract_text TEXT DEFAULT '',

  -- Reading status
  status TEXT DEFAULT 'Surveyed' CHECK(status IN ('Surveyed','Fully Reviewed','Revisit Needed')),
  importance TEXT DEFAULT 'Noted' CHECK(importance IN ('Noted','Potentially Relevant','Must-Cite')),
  date_read TEXT DEFAULT (date('now')),

  -- Notes (bullet format, newline-separated)
  summary TEXT DEFAULT '',
  differentiation TEXT DEFAULT '',
  questions TEXT DEFAULT '',

  -- PDF
  pdf_path TEXT DEFAULT '',         -- relative path within project folder, or absolute
  pdf_storage TEXT DEFAULT 'copy'   -- 'copy' = copied into project, 'link' = referenced
  CHECK(pdf_storage IN ('copy','link')),

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Removed fields (v1.1): code_link, task, input_modality → replaced by single `link` field

-- PDF highlights and memos
CREATE TABLE annotations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('highlight','memo')),
  page INTEGER NOT NULL,
  -- Selection coordinates (pdf.js text layer positions)
  rects_json TEXT DEFAULT '[]',   -- [{x,y,w,h,pageIndex}]
  selected_text TEXT DEFAULT '',
  color TEXT DEFAULT '#ffd166',    -- highlight color hex
  memo_text TEXT DEFAULT '',       -- for memo type
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bidirectional links: tracker bullet ↔ PDF annotation
CREATE TABLE note_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  note_field TEXT NOT NULL CHECK(note_field IN ('summary','differentiation','questions')),
  bullet_index INTEGER NOT NULL,  -- which bullet in the field (0-based)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Keywords (extracted from PDF metadata or user-tagged)
CREATE TABLE keywords (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  source TEXT DEFAULT 'auto' CHECK(source IN ('auto','manual'))
);

CREATE INDEX idx_papers_project ON papers(project_id);
CREATE INDEX idx_annotations_paper ON annotations(paper_id);
CREATE INDEX idx_keywords_paper ON keywords(paper_id);
CREATE INDEX idx_keywords_keyword ON keywords(keyword);
```

---

## Core features specification

### 1. Three-panel resizable layout

The main window has three panels separated by draggable splitters:
- **Left**: Sidebar (projects + keyword graph) — default 200px, min 160px, max 320px
- **Center**: PDF viewer — flexible, takes remaining space
- **Right**: Tracker panel — default 320px, min 280px, max 480px

Each splitter is a 6px-wide draggable handle. Cursor changes to `col-resize` on hover. Panel sizes persist in localStorage.

When no paper is open, center shows the **Dashboard** (Notion-style home).

### 2. Dashboard (home screen)

Shown when no paper is selected, or as the initial screen. Inspired by Notion's welcome page:
- Clean greeting: "Good morning" / "Good afternoon" based on time
- **Quick actions**: "Import PDF", "Create project", "Smart Paste"
- **Recently read**: last 5-8 papers as compact cards (title, author, date, status badge)
- **Stats overview**: total papers, by status, must-cite count
- **Project shortcuts**: recently accessed projects

### 3. Sidebar

Three vertical sections. PROJECTS takes maximum space; PAPERS controls and KEYWORD GRAPH stay at bottom.

**PROJECTS** (top, flex-1, maximum space):
- `+` button to create new project
- "All Papers" virtual item at top (sets selectedProjectId = null)
- 📁 folder icon for project folders; ▸/▾ to expand/collapse
- 📄 document icon for paper items shown inline under each folder
- Paper count badge on right side of folder row
- Click paper → opens in center panel
- Right-click project: new subfolder, rename, delete, set/change/clear PDF folder
- Drag-to-reorder projects (root level)
- Filter from PAPERS controls applies to which 📄 items are visible

**PAPERS** (bottom, compact, shrink-0):
- Section header with search (⌕) + Sel button + + add
- Filter chips: Surveyed / Rev / Rev! | Ntd / Rel / Must (abbreviated)
- SORT dropdown: Order / Date / Year / Title / Author / Importance
- Select mode: All / None + export buttons (.bib / Word Refs / CSV)

**KEYWORD GRAPH** (very bottom, shrink-0):
- D3 force-directed, compact (~200x150px)
- ▾/▸ toggle; ⤢ expand to full-screen (Ctrl+G)
- Click node → filters paper display in PROJECTS

### 4. PDF viewer

Built on **pdf.js** running inside a React component.

**Tab bar** (above toolbar):
- Paper title as tab label (with 📄 icon)
- ✕ closes paper → returns to Dashboard
- ＋ triggers PDF import

**Toolbar**:
- Page nav: ‹ N / total ›
- Zoom: − % + 1:1 Fit
- Read-only **Status badge** + **Importance badge**
- Search toggle → inline search with ▲▼ navigation
- 🖨 Print (system print dialog)
- 💾 Save highlights to PDF (pdf-lib, burns highlights only — planned)

**Rendering**:
- Canvas rendering for pages + transparent text layer on top for selection
- Smooth scrolling between pages (continuous scroll mode)
- Zoom: fit-width (default), fit-page, manual (50%-400%), Ctrl+Wheel zoom
- Page navigation: scroll, page number input
- In-PDF text search with match highlighting

**Annotations**:
- **Text highlight**: Select text → right-click → "Highlight" with color picker (yellow, green, blue, pink, orange). Highlights are stored in the `annotations` table and rendered as colored overlays on the text layer.
- **Margin memo**: Right-click on highlighted area → "Add memo" → small floating note icon appears at the margin. Click to expand/edit.
- **Send to Tracker**: Select text → right-click → "Send to Differentiation" or "Send to Questions". This creates:
  1. A highlight annotation in the PDF (with a distinct color, e.g. coral for differentiation, purple for questions)
  2. A new bullet in the corresponding tracker field, prefixed with the selected text (truncated if long)
  3. A `note_links` record connecting the bullet to the annotation
- When user clicks a linked bullet in the tracker panel, the PDF viewer scrolls to the exact page and highlights the linked annotation with a brief flash animation.

**Context menu** (right-click on text selection):
```
┌──────────────────────────┐
│ 🟡 Highlight yellow      │
│ 🟢 Highlight green       │
│ 🔵 Highlight blue        │
│ 🩷 Highlight pink        │
│ ─────────────────────── │
│ 📝 Add memo              │
│ ─────────────────────── │
│ ✦ Send to Differentiation │
│ ? Send to Questions       │
│ ─────────────────────── │
│ 📋 Copy text              │
└──────────────────────────┘
```

### 5. Tracker panel

**REVERSED LAYOUT**: Notes on TOP (most used), metadata on BOTTOM (collapsible).

**Notes section (TOP — flex-1, fills available space)**:

Three bullet editors with visible `border-b border-border` separator lines between them:
- **SUMMARY** — white/secondary header, description hint, bullet editor
- **✦ DIFFERENTIATION** — coral header (`#ff6b35`), linked bullets with 🔗 icon
- **? QUESTIONS** — purple header (`#7209b7`), linked bullets with 🔗 icon

Each section has `px-4 pt-3 pb-3 border-b border-border` padding.  
Clicking 🔗 on a linked bullet → PDF viewer scrolls to annotation with flash animation.

Keyboard in bullet editors:
- `Enter` → new bullet
- `Shift+Enter` → sub-bullet
- `Backspace` at bullet start → merge with previous bullet

**Metadata section (BOTTOM — collapsible, collapsed by default)**:

`▸ METADATA` header button toggles (Ctrl+M). When expanded (max-h-72, overflow-y-auto):
- Title (editable, 15px semibold)
- Authors (editable)
- Year | Journal/Conf. (2-column grid)
- Status | Importance | Date Read (3-column grid, all editable)
- LINK (single URL text input — replaces code_link + task + input_modality)
- Keywords (tag pills with ✕, `+ add` for manual keywords)

**Copy BibTeX (always visible, very bottom)**:
- Always visible below metadata section regardless of collapse state
- Uses `raw_bibtex` verbatim if available; otherwise auto-generates from metadata

### 6. Smart Paste

Modal dialog, triggered by:
- Menu: File → Import → Smart Paste
- Keyboard shortcut: `Ctrl+N`
- Button in sidebar or dashboard

Accepts any of:
- **BibTeX** (`@inproceedings{...}`, `@book{...}`, etc.) → parse all fields, detect ref_type, store raw in `raw_bibtex`
- **RIS** (text starting with `TY  -`) → parse TY/AU/TI/JO/PY/SP/EP/DO/PB/UR tags
- **Citation string** (`Author, "Title." Venue. Year.`) → parse title, authors, year, venue
- **arXiv ID** (`2403.18913`) → store as arXiv reference
- **Plain title** → store as title only

Drag-and-drop `.ris` file onto the window also opens Smart Paste pre-filled.

After parsing, shows preview of detected fields → user clicks "Continue" → tracker panel opens with pre-filled fields.

Venue mapping: inputs are normalized to full venue name for DB storage (via `normalizeVenue`). On export, `formatVenue(venue, format)` converts to the user's chosen abbreviation style.

### 7. PDF import

Multiple entry points:
- Drag PDF file onto the app window
- File → Import PDF
- Click "Import PDF" on dashboard

On import:
1. User chooses: **copy into project folder** or **link from current location**
2. pdf.js extracts first-page text → attempt to parse title, authors, year, venue, abstract
3. PDF metadata (if present): Title, Author, Keywords, CreationDate
4. Smart Paste modal opens pre-filled with extracted data
5. User confirms/edits → paper record created → PDF viewer opens

### 8. Export features

**BibTeX export**:
- Select mode: click "Select" in toolbar → checkboxes appear on paper cards
- Check desired papers → "Export .bib" → generates `references.bib`
- If paper has `raw_bibtex`, use verbatim; otherwise generate from metadata
- Individual: paper detail → "Copy BibTeX" button

**JSON export**: Full database dump as JSON array

**CSV export**: Flat table of all papers with all fields

**Notion export**: Generates a Python script (using `notion-client`) that:
- Creates a Notion database with matching property schema
- Inserts all papers with properties + page body content
- User just needs to set their Notion API token and parent page ID

### 9. Keyword graph

**Data source**: 
- Auto-extracted from PDF metadata `Keywords` field
- Auto-extracted from title (NLP-style: remove stopwords, extract noun phrases)
- User can manually add/remove keywords per paper

**Visualization** (sidebar, always visible):
- D3 force-directed layout in a compact area (~200x150px)
- Each node = unique keyword, radius proportional to paper count
- Edge = two keywords co-occur in the same paper, thickness = frequency
- Hover node → tooltip shows keyword + count
- Click node → filters paper list to that keyword
- Pastel node colors from a consistent palette
- Gentle force simulation, no jitter

**Full-screen graph** (future: click to expand):
- Same data, larger canvas
- Paper nodes visible alongside keyword nodes
- More interactive: drag nodes, zoom, click paper to open

### 10. Auto-save

- SQLite writes happen immediately on every change (paper edit, annotation create, etc.)
- Project folder: user can designate a folder per project; HYJI writes a `hyji_project.json` manifest there
- When PDF storage = "copy", PDFs are stored in `{project_folder}/pdfs/`
- Database file: `{app_data}/hyji.db` (Tauri app data directory)
- Optional: export full backup as `.hyji` file (just a zip of db + PDFs)

---

## UI / Design system

### Philosophy
- **iOS-friendly clean aesthetic** — inspired by JustPDF, Apple Notes, Notion
- **Dark mode default**, light mode supported
- Flat surfaces, minimal borders, generous whitespace
- Rounded corners (8px default, 12px for cards)
- Subtle hover/focus transitions (150ms ease)
- No heavy shadows — use 1px borders or very subtle box-shadow

### Color palette

```
// Dark mode (default)
--bg-primary: #0d1117
--bg-secondary: #161b22
--bg-tertiary: #21262d
--border: #30363d
--text-primary: #e6edf3
--text-secondary: #8b949e
--text-tertiary: #6e7681
--accent: #58a6ff

// Semantic
--status-surveyed: #ffd166
--status-reviewed: #06d6a0
--status-revisit: #ff6b6b
--importance-noted: #6c757d
--importance-relevant: #f77f00
--importance-mustcite: #d62828

// Highlight colors
--highlight-yellow: #ffd16644
--highlight-green: #06d6a044
--highlight-blue: #58a6ff44
--highlight-pink: #ff6b9d44
--highlight-orange: #ff6b3544

// Differentiation link color
--link-differentiation: #ff6b35
--link-questions: #7209b7
```

### Typography
- Font: system font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
- Monospace (BibTeX, code): `'SF Mono', 'Cascadia Code', 'Fira Code', monospace`
- Paper title in tracker: 18px, weight 600
- Section headers: 12px, weight 700, uppercase, letter-spacing 1px
- Body text: 13px
- Small text / hints: 11px

### Components

**Badge**: Inline pill with colored background (22% opacity), border, bold text. Used for Status, Importance, Task, Input modality.

**Bullet editor**: contenteditable div. Each bullet is a child div with `text-indent: -16px; padding-left: 16px` for hanging indent. Sub-bullets at 32px padding.

**Context menu**: Floating div positioned at cursor, rounded corners, subtle border, appears on right-click. Dismiss on click-outside or Escape.

**Splitter**: 6px wide vertical bar between panels. `cursor: col-resize`. On drag, updates panel widths. Double-click to reset to default.

**Card**: Paper card in sidebar list or dashboard. Compact: title (1 line), author·year·venue, status+importance badges, summary preview (2 lines).

---

## Menu bar structure

```
File
├── New Project               Ctrl+Shift+N
├── Import PDF...             Ctrl+O
├── Smart Paste               Ctrl+N
├── ──────
├── Selection Mode            Ctrl+Shift+S
├── Export Selected...        (disabled when nothing selected)
├── Export All...
├── ──────
├── Preferences...
└── Exit

Edit
├── Undo                      Ctrl+Z
├── Redo                      Ctrl+Shift+Z
├── ──────
├── Find in PDF               Ctrl+F
├── Find Paper                Ctrl+Shift+F
├── ──────
├── Select Mode               Ctrl+Shift+S
└── Delete Paper

View
├── Toggle Sidebar            Ctrl+B
├── Toggle Tracker Panel      Ctrl+J
├── ──────
├── Focus Mode                Ctrl+L
├── ──────
├── Zoom In                   Ctrl+=
├── Zoom Out                  Ctrl+-
├── Fit Width                 Ctrl+0
├── ──────
├── Dashboard                 Ctrl+H
├── Expand Metadata           Ctrl+M
├── Keyword Graph (expand)    Ctrl+G
├── ──────
├── Text Size: Default
├── Text Size: Large
└── Text Size: X-Large

Tools
├── Extract PDF Metadata
├── Regenerate Keywords
├── ──────
├── Database Backup...
├── Restore from Backup...
└── Preferences...

Help
├── Keyboard Shortcuts        Ctrl+/
├── About HYJI
└── GitHub Repository
```

---

## Development phases

### Phase 0.1 — Skeleton ✅
- [x] Tauri v2 project init with React + TypeScript + Vite
- [x] Tailwind CSS setup with dark mode config
- [x] 3-panel layout with draggable splitters (Sidebar | Center | Right)
- [x] SQLite initialization with full schema (migrations)
- [x] Sidebar: project tree CRUD (create, rename, delete folders)
- [x] Sidebar: paper list with inline papers under project folders
- [x] Window title bar, menu bar with functional items
- [x] Basic Tauri IPC: create_paper, list_papers, update_paper, delete_paper
- [x] Custom app icon (HYJI.jfif → window icon via Rust `set_icon`)

### Phase 0.2 — PDF + Smart Paste ✅
- [x] pdf.js integration: render PDF pages in center panel (canvas + text layer)
- [x] PDF toolbar: zoom (fit-width, manual, Ctrl+Wheel), page navigation, page number display
- [x] PDF text layer: selectable text overlay (native browser selection)
- [x] PDF text search (Ctrl+F) with match highlighting and ▲▼ navigation
- [x] PDF annotation layer: clickable hyperlinks (external URLs → system browser, internal refs → scroll + flash)
- [x] Smart Paste modal: BibTeX / citation / arXiv ID parser
- [x] Venue name mapping (long → short code)
- [x] PDF drag-and-drop import with file copy/link choice
- [x] PDF metadata extraction (title, authors from first page)
- [x] Paper list click → opens PDF in viewer + tracker panel populates

### Phase 0.3 — Tracker + Bidirectional link ✅
- [x] Tracker panel: metadata form (title, authors, year, venue, link)
- [x] Tracker panel: status/importance/date dropdowns
- [x] Bullet editor (contenteditable, Enter/Shift+Enter/Backspace behavior)
- [x] Three note sections: Summary, Differentiation, Questions
- [x] PDF right-click context menu: "Send to Differentiation", "Send to Questions"
- [x] On send: create annotation + bullet + note_link in DB (multi-line text collapsed to single bullet)
- [x] Linked bullet (🔗 icon) → click → PDF scrolls to annotation with flash
- [x] Auto-save all changes to SQLite immediately

### Phase 0.5 — Polish + Export ✅
- [x] PDF highlight (5 colors) via text selection + right-click
- [x] Highlight rendering: SVG group-level opacity overlay (no overlap artifacts)
- [x] Margin memo: icon at page margin, click to expand/edit
- [x] BibTeX select-and-export: select mode → checkboxes → export .bib
- [x] Individual "Copy BibTeX" in tracker panel
- [x] JSON / CSV full export
- [x] Paper list filters: by status, importance
- [x] Paper search (title, authors, venue, summary — Ctrl+Shift+F)
- [x] Sort: by order, date read, year, title, author, importance
- [x] Print: high-res PDF rendering (scale 3x) via iframe, highlights burned in
- [x] Save highlights to PDF: pdf-lib burns highlight rects → save as new PDF
- [x] F2 rename for both project folders and papers in sidebar

### Phase 1.0 — Full Research Hub ✅ (partial)
- [x] Dashboard (Notion-style home): greeting, recent papers, stats, quick actions, project shortcuts
- [x] Keyword extraction from PDF metadata + title
- [x] Keyword graph in sidebar (D3 force layout)
- [x] Click keyword → filter papers
- [x] Manual keyword add/remove per paper
- [x] Keyboard shortcuts for all major actions (Ctrl+F/N/O/H/G/B/J/M/+/-/0, Ctrl+Shift+F)
- [x] Keyboard Shortcuts modal (Ctrl+/) — ShortcutsModal + KeyboardShortcutsModal
- [x] About HYJI modal — AboutModal.tsx
- [x] Project folder settings: right-click project → Set/Change/Clear PDF Folder
- [x] Tauri auto-updater via GitHub releases — release.yml + tauri-plugin-updater
- [x] Windows .msi installer — GitHub Actions produces signed .msi
- [x] Performance: virtual scrolling for large paper lists — @tanstack/react-virtual in ProjectTree

### Phase 1.1 — Stability + File Association (v0.1.5–v0.1.6) ✅
- [x] Scrollbar visibility — 8px white thumb (40 % / 60 % hover), transparent track
- [x] PDF file association — `.pdf` registered in bundle; argv path stashed in PendingOpenFile; frontend invokes `take_pending_open_file` on mount, imports as unassigned paper
- [x] UNASSIGNED section — papers with project_id=null shown at sidebar bottom; drag-to-project supported
- [x] Context menu overflow fix — ClampedMenu wrapper: max-height calc(100vh-40px), overflow-y:auto, flips upward when near window bottom
- [x] Keyword graph restart prevention — stable memo key derived from IDs only (v0.1.5)
- [x] Auto context menu on text drag-select — 80ms after mouseup (v0.1.4)
- [x] XMP keyword extraction before pdfjs ArrayBuffer detach (v0.1.3)

### Phase 1.2 — Export, Import, Focus Mode, Backup (v0.1.7) ✅
- [x] Export dialog — format picker (LaTeX/Word/CSV/Clipboard), citation style (IEEE/ACS/Nature/APA/MLA), start-from, no-numbers, journal-name format (full/abbr/abbr_nodots), live preview
- [x] RIS import — `parseRis()` in parser.ts; Smart Paste detects `TY  -` prefix; drag-drop `.ris` file opens Smart Paste pre-filled
- [x] Reference types — `ref_type` + publisher/edition/chapter/pages/doi/abstract_text columns; tracker Type dropdown; conditional Publisher/Edition/Chapter fields; type-aware BibTeX `@article/@inproceedings/@book/@inbook/@phdthesis/@misc`
- [x] Venue/journal abbreviation mapping — 247-entry venues.json (ISO 4/CASSI); `formatVenue(input, 'full'|'abbr'|'abbr_nodots')`; imports normalize to full name; exports format on demand
- [x] File menu restructure — Selection Mode (Ctrl+Shift+S), Export Selected…, Export All…, Preferences…
- [x] View menu additions — Focus Mode (Ctrl+L), Expand Metadata (Ctrl+M)
- [x] Focus Mode (Ctrl+L) — saves panel state, hides sidebar+tracker, fits width; Esc/Ctrl+L exits; manual panel toggle auto-deactivates; toolbar Focus pill
- [x] Auto-backup — Rust: BackupConfig (hyji_config.json), spawn_backup_loop (60s thread), perform_backup (file copy + rotation); frontend markDbDirty wired to all stores
- [x] Preferences dialog — enable/folder/interval/only-on-change/keep-N controls; Backup now button; last backup timestamp + size display

---

## Coding conventions

- **TypeScript strict mode**: `"strict": true` in tsconfig
- **No `any`**: Use proper types for all data. Define interfaces in `src/types/`.
- **Component files**: One component per file, PascalCase filename
- **Hooks**: Custom hooks in `src/hooks/`, prefixed with `use`
- **Tauri commands**: All IPC in `src-tauri/src/commands.rs`, invoked via `@tauri-apps/api/core`
- **SQL**: Parameterized queries only, never string interpolation
- **Error handling**: Rust `Result<T, E>` for all commands, frontend shows toast on error
- **Comments**: Minimal — code should be self-documenting. Comment only "why", not "what".
- **Commits**: Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`)

---

## Update / release workflow

1. Push tag `v0.x.y` to GitHub
2. GitHub Actions builds `.msi` installer via Tauri bundler
3. Creates GitHub Release with the `.msi` attached
4. Tauri auto-updater checks GitHub releases on app launch
5. User sees "Update available" notification → one-click update
6. Changelog shown in-app from `CHANGELOG.md`

What to ship per release:
- `.msi` installer (Windows)
- `CHANGELOG.md` entry
- Source code (auto via GitHub)

---

## Key design decisions (rationale)

1. **SQLite over JSON files**: Concurrent writes, indexing, relational queries (keyword co-occurrence). A JSON file would break with 500+ papers.

2. **PDF text layer for annotations**: pdf.js renders a transparent `<div>` layer on top of the canvas with positioned spans matching the PDF text. This allows native text selection. Highlights are CSS overlays on these spans, not burned into the PDF.

3. **Bidirectional links stored in `note_links` table**: Decoupled from both the annotation and the note text. If user edits the bullet, the link persists. If user deletes the annotation, the link is cascade-deleted but the bullet text remains.

4. **Raw BibTeX preserved**: When a user pastes BibTeX, we parse it for display but store the original verbatim. On export, we return exactly what was pasted — no round-trip data loss.

5. **Venue mapping as a separate module**: The mapping from long conference names to short codes is a pure function with a lookup table. Easy to extend, easy to test.

6. **Project-level PDF storage choice**: Some users want portable self-contained project folders (copy). Others have huge PDF libraries and don't want duplicates (link). Per-project setting respects both workflows.

7. **Notes on top, metadata collapsed**: Researchers write notes 90% of the time. Metadata is set once on import. Collapsing metadata by default maximizes note-writing space.

8. **Single LINK field**: Universal — any URL (paper page, code repo, project site). Replaces the CV-specific `code_link` + `task` + `input_modality` triad which was too domain-specific.

9. **Papers inline in project tree**: Papers appear as 📄 items under their project folder. The separate paper card list is replaced by a compact filter/sort/select control bar. Navigation is now file-browser style.

---

## Non-goals for v1.0

- No AI features (no LLM integration, no auto-summarization)
- No cloud sync (purely local)
- No collaborative editing
- No mobile version
- ~~No citation style formatting~~ — **implemented in v0.1.7** (IEEE/ACS/Nature/APA/MLA via Export dialog)
- No PDF editing (no form fill, no page manipulation)
- No web scraping (no auto-download from arXiv/Semantic Scholar)
