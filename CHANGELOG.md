# Changelog

All notable changes to HYJI will be documented in this file.

## [0.1.1] - 2026-04-06

### Improved
- Questions section color changed to more vivid violet (#7c3aed) for better readability against dark background
- All font sizes converted from px to rem units for consistent scaling across displays

### Added
- Text size options in View menu: Default / Large / X-Large
- About HYJI modal GitHub button now opens repository in browser
- Help → GitHub Repository menu item linked to repository

### Removed
- Text size keyboard shortcuts (Ctrl+Shift+. / Ctrl+Shift+,) removed to avoid conflicts

## [0.1.0] - 2026-04-06

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
