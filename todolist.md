# HYJI — TODO List

_Last updated: 2026-07-20 (v1.0.2)_

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

---

## Quality / UX Improvements (future)

- [ ] **Export Selected… grayed out in menu when nothing selected**
  - Currently shows a dialog if nothing selected; ideally the menu item itself is disabled
  - Requires dynamic menu state updates from Rust via `set_enabled` on menu item

## Roadmap (from doc/HYJI_STATE_research.md — 2026-07)

- [ ] **v1.0.3 — Annotation write expansion**: Underline/StrikeOut writing (extend pdf-lib Highlight code) + import-to-edit of external annotations into HYJI DB
- [ ] **v1.0.4 — Library full-text search**: SQLite FTS5 + CJK tokenizer (lindera-sqlite preferred; better-trigram fallback); index pdf.js-extracted text; note tauri-plugin-sql extension-loading constraint
- [ ] **v1.0.5 — Online metadata lookup**: DOI/arXiv-ID extraction from PDF → Crossref → arXiv fallback chain (keyless), SQLite caching, confirm-before-overwrite UI
- [ ] **Later (v1.2+)**: dark-mode image counter-invert, citation graph (Semantic Scholar/OpenAlex cache), OCR (verify WinRT package-identity constraint), macOS port

---

## Known Issues

- [ ] **::selection bleed at whitespace spans during drag**
  - PDF.js text layer whitespace spans have large `transform:scaleX` values; the browser's `::selection` background renders at the transformed (scaled) size, causing brief bleed when the cursor crosses a space
  - Partially mitigated: opacity set to 0.3; `clip-path:inset(0)` applied but WebView2 does not honour clip-path on `::selection`
  - This is a structural limitation of DOM-based PDF text layers; Adobe Acrobat avoids it via native canvas rendering
  - Stored highlights are clean (use `mergeToLineRects`); only the live drag preview is affected

- [ ] **Highlight overlap in viewer**
  - SVG group opacity approach applied but visual overlap may persist in some edge cases
  - Adjacent span rects from `range.getClientRects()` can slightly overlap

- [ ] **Print highlight position mismatch**
  - Highlight positions in print may differ slightly from viewer
  - Stored rects are in PDF-point space, print renders at scale 3×
  - Minor pixel-level discrepancy possible

---

## Completed (all sessions)

### v1.0.2 (2026-07-20)
- [x] PDF dark mode (Ctrl+D, View menu, toolbar toggle) — inverted canvas only; highlights/selection colors stay true
- [x] Abstract section in tracker metadata (abstract_text finally has UI)
- [x] DOI ↗ open-in-browser button
- [x] Auto-backup on exit (RunEvent::ExitRequested, dirty-only)
- [x] AboutModal version now read at runtime via getVersion() (was hardcoded "1.0.0")

### v1.0.1 (2026-07-20)
- [x] Multi-tab PDF viewing (tab strip, per-tab zoom/scroll memory, session restore, Ctrl+W)
- [x] Single-instance support — second launch forwards PDF to running window as a tab (Rust-side queue)
- [x] CJK/CID font rendering (bundled cmaps/standard_fonts/wasm)
- [x] Real /Highlight annotation export (Adobe-interop, rotation/CropBox aware); RIS export; Print menu (Ctrl+P)
- [x] Startup layout preference (viewer-only mode); fs scope for all drives
- [x] Interaction-gap fixes: annotations/data loading decoupled from panel visibility, duplicate imports/menus, focus-mode dead-ends, project-delete refresh

### v1.0.0 (2026-04-30)
- [x] Highlight gaps filled — `mergeToLineRects` merges same-line rects; stored highlights show as continuous bands
- [x] Empty bullets hidden in BulletEditor — blank lines no longer render as visible rows
- [x] Tools menu: Reset to Blank (Clear All Data) with double-confirm dialog
- [x] Preferences moved to bottom of Tools menu; removed from File menu
- [x] Internal link flash 3.5s + "Back to reading" floating button
- [x] New app icon (HJ design, all sizes regenerated via sharp)
- [x] Icon cache cleared; icon.rgba verified via preview PNG

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
