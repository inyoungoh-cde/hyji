# HYJI — TODO List

## Deferred Features (high priority, needs research)

- [ ] **Spatial drag selection for multi-column PDFs**
  - Native browser selection follows DOM order, not visual order
  - Need rectangle-based text collection that respects column boundaries
  - Tried overlay + span highlighting approach — CSS user-select conflicts in WebView2
  - Revisit with a fresh approach

- [ ] **Internal link tooltip preview**
  - Hover over [7] → show reference 7's full text
  - Challenge: extracting correct reading-order text from double-column PDF layouts
  - Coordinate-based and stream-order approaches both failed for [N]-style refs
  - May need a different strategy (e.g., pre-index all references on PDF load)

## Missing Features (from CLAUDE.md Phase 1.0)

- [ ] **Notion script generator**
  - Generate Python script using `notion-client` to export papers to Notion DB
  - Menu item exists in lib.rs but no frontend/backend implementation

- [ ] **Keyboard Shortcuts modal (Ctrl+/)**
  - Menu item exists, handler not connected
  - Show all shortcuts in a modal dialog

- [ ] **About HYJI modal**
  - Show version, description, license, GitHub link

- [ ] **Project folder settings**
  - Per-project PDF storage location (currently global)
  - Right-click project → set/change/clear PDF folder

- [ ] **Tauri auto-updater + .msi installer**
  - GitHub Actions CI/CD for building .msi
  - Tauri auto-updater checks GitHub Releases on launch

- [ ] **Virtual scrolling for large paper lists**
  - Performance optimization for 100+ papers in sidebar
  - Currently renders all paper items in DOM

## Known Issues

- [ ] **Highlight overlap in viewer**
  - SVG group opacity approach applied but visual overlap may persist in some cases
  - Adjacent span rects from `range.getClientRects()` can slightly overlap

- [ ] **Print highlight position mismatch**
  - Highlight positions in print may differ slightly from viewer
  - Stored rects are in PDF-point space, print renders at scale 3x
  - Minor pixel-level discrepancy possible

## Completed (this session)

- [x] Fix startup bugs (papers not loading, no expand arrows, keyword graph empty)
- [x] F2 rename for project folders (via `lastSidebarClickRef` pattern)
- [x] Send to Diff/Questions: collapse multi-line text to single bullet
- [x] Print: high-res rendering (scale 3x PNG) via hidden iframe
- [x] Print: burn highlights into print output
- [x] Save highlights to PDF (pdf-lib, `fs:allow-write-file` permission)
- [x] PDF annotation layer: clickable hyperlinks (external + internal)
- [x] Internal link scroll + flash indicator at target position
- [x] Custom app icon (HYJI.jfif → RGBA → `Image::new_owned`)
- [x] Highlight rendering: SVG `<g>` group opacity (reduce overlap)
