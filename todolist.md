# HYJI — TODO List

_Last updated: 2026-04-30 (v0.1.7)_

---

## Deferred Features (hard problems — needs research)

- [ ] **Spatial drag selection for multi-column PDFs**
  - Native browser selection follows DOM order, not visual order
  - Need rectangle-based text collection that respects column boundaries
  - Tried overlay + span highlighting approach — CSS user-select conflicts in WebView2
  - Revisit with a fresh approach (e.g. canvas-hit-test + reorder by x/y)

- [ ] **Internal link tooltip preview**
  - Hover over `[7]` → show reference 7's full text
  - Challenge: extracting correct reading-order text from double-column PDF layouts
  - Coordinate-based and stream-order approaches both failed for `[N]`-style refs
  - May need a different strategy (e.g. pre-index all references on PDF load)

---

## Missing Features (from original Phase 1.0 spec)

- [ ] **Notion script generator**
  - Generate Python script using `notion-client` to export papers to a Notion DB
  - Fields: title, authors, year, venue, status, importance, summary, differentiation, questions, link, PDF path
  - User sets Notion API token and parent page ID; script handles DB creation + inserts

---

## Quality / UX Improvements (future)

- [ ] **Single-instance support**
  - Double-clicking a second PDF while HYJI is running opens a second instance instead of routing the new file to the existing window
  - Needs `tauri-plugin-single-instance` wired to the `open-file` event path

- [ ] **Export Selected… grayed out in menu when nothing selected**
  - Currently shows a dialog if nothing selected; ideally the menu item itself is disabled
  - Requires dynamic menu state updates from Rust via `set_enabled` on menu item

- [ ] **Auto-backup on exit**
  - If DB is dirty when the window closes, perform one final backup
  - Requires hooking into `tauri::RunEvent::ExitRequested`

- [ ] **Abstract display in tracker panel**
  - `abstract_text` column exists (added v0.1.7) but no UI to display it
  - Add a collapsible Abstract section in the notes area or metadata section

- [ ] **DOI → open in browser**
  - `doi` field exists in tracker but is just a text input
  - Add a "↗" button to open `https://doi.org/{doi}` in system browser

---

## Known Issues

- [ ] **Highlight overlap in viewer**
  - SVG group opacity approach applied but visual overlap may persist in some edge cases
  - Adjacent span rects from `range.getClientRects()` can slightly overlap

- [ ] **Print highlight position mismatch**
  - Highlight positions in print may differ slightly from viewer
  - Stored rects are in PDF-point space, print renders at scale 3×
  - Minor pixel-level discrepancy possible

---

## Completed (all sessions)

### v0.1.7 (2026-04-29)
- [x] Export dialog — format picker (LaTeX/Word/CSV/Clipboard), IEEE/ACS/Nature/APA/MLA citation styles, start-from, no-numbers, journal-name format (full/abbr/abbr_nodots), live preview
- [x] RIS import — `parseRis()` in parser.ts; Smart Paste detects `TY  -` prefix; drag `.ris` opens Smart Paste pre-filled
- [x] Reference types — ref_type + publisher/edition/chapter/pages/doi/abstract_text columns in DB; tracker Type dropdown; conditional fields; type-aware BibTeX output
- [x] Venue/journal abbreviation mapping — 247-entry venues.json (ISO 4/CASSI); `formatVenue(input, format)` resolves any form; imports normalize to full name
- [x] File menu restructure — Selection Mode / Export Selected… / Export All… / Preferences…
- [x] View menu additions — Focus Mode (Ctrl+L), Expand Metadata (Ctrl+M)
- [x] Focus Mode (Ctrl+L) — saves panel state, hides sidebar+tracker, fits width; Esc/Ctrl+L exits; manual toggle auto-deactivates; toolbar Focus pill
- [x] Auto-backup — Rust: BackupConfig, 60s spawn_backup_loop, perform_backup, rotation; frontend markDbDirty in all stores
- [x] Preferences dialog — enable/folder/interval/only-on-change/keep-N; Backup now; last backup timestamp + size

### v0.1.6 (2026-04-29)
- [x] PDF file association — `.pdf` registered; argv path → PendingOpenFile; frontend imports as unassigned paper on mount
- [x] Context menu overflow fix — ClampedMenu: max-height + flip upward + overscroll contain
- [x] Scrollbar visibility — 8px white thumb (40 %/60 % hover)

### v0.1.5 (2026-04-09)
- [x] Keyword graph restart prevention — stable memo key derived from paper IDs only; D3 simulation no longer restarts on note edits

### v0.1.4 (2026-04-09)
- [x] Auto context menu on text drag-select (80ms after mouseup)
- [x] Context menu viewport clamping
- [x] Garbled keyword extraction fix (hyphenated titles, concatenated tokens)

### v0.1.3 (2026-04-08)
- [x] XMP keyword extraction — search raw bytes before pdfjs loads to prevent ArrayBuffer detach

### v0.1.2 (2026-04-07)
- [x] Keyword deduplication race condition fix
- [x] Keyword graph clump fix on Regenerate
- [x] Import PDF icon button in sidebar Projects header

### Earlier sessions
- [x] Fix startup bugs (papers not loading, no expand arrows, keyword graph empty)
- [x] F2 rename for project folders and papers (via `lastSidebarClickRef` pattern)
- [x] Send to Diff/Questions: collapse multi-line text to single bullet
- [x] Print: high-res rendering (scale 3×) via hidden iframe, highlights burned in
- [x] Save highlights to PDF (pdf-lib)
- [x] PDF annotation layer: clickable hyperlinks (external + internal)
- [x] Internal link scroll + flash indicator at target position
- [x] Custom app icon (HYJI.jfif → RGBA)
- [x] Highlight rendering: SVG `<g>` group opacity (reduce overlap)
- [x] About HYJI modal
- [x] Keyboard Shortcuts modal (Ctrl+/)
- [x] Project folder settings (right-click → Set/Change/Clear PDF Folder)
- [x] Tauri auto-updater + GitHub Actions .msi build (release.yml)
- [x] Virtual scrolling for large paper lists (@tanstack/react-virtual in ProjectTree)
- [x] UNASSIGNED section in sidebar (project_id=null papers, drag-to-project)
- [x] Text size presets (Default/Large/X-Large) in View menu
- [x] Database Backup + Restore from Backup (manual, in Tools menu)
