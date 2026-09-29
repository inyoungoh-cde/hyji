<div align="center">

# HYJI

### Highlight Your Journey of Insights

**A free, open-source desktop research hub for reading, annotating, and tracking academic papers.**

![HYJI Screenshot](./representative/hyji_rep.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D4.svg)](https://github.com/inyoungoh-cde/hyji/releases)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202-FFC131.svg)](https://tauri.app)
[![GitHub Release](https://img.shields.io/github/v/release/inyoungoh-cde/hyji?label=latest)](https://github.com/inyoungoh-cde/hyji/releases)

</div>

---

## What is HYJI?

HYJI (pronounced *hai-jee*) is a desktop app built for researchers who spend serious time in PDFs. It combines a PDF reader (powered by PDFium, the engine inside Chrome and Edge), a highlight/annotation tool, a structured note-taking panel, and a project management layer — all in one window, all stored locally.

No cloud. No subscriptions. No AI fluff. Just you and your papers.

---

## Why HYJI?

Other tools let you manage papers. HYJI lets you **think through** them.

- **Right-click → Send to Differentiation** — Select a sentence in the PDF, right-click, and choose exactly where it goes: Summary, Differentiation, or Questions. The text becomes a linked bullet in your structured notes. No other tool lets you classify annotations into research categories at the moment of reading.

- **Bidirectional anchor links** — Every linked bullet has a 🔗 icon. Click it, and the PDF scrolls to the exact sentence you highlighted — not just the page, the sentence. "Where did I read that?" is no longer a question.

- **Built-in research framework** — Every paper gets three sections: Summary (what it does), Differentiation (what makes it different), Questions (what remains open). As your library grows, you can instantly compare any two papers without re-reading either.

- **Keyword graph, zero setup** — Import papers and their keywords are auto-extracted from PDF metadata. A force-directed graph in the sidebar shows how your papers connect. Click a node to filter. No manual tagging required.

- **See what [47] is without losing your place** — Hover an in-text citation and a card shows the referenced paper — first author et al., title, venue abbreviation (ECCV, CVPR, TPAMI…) and year. You choose which fields appear; clicking still jumps to the bibliography with a *Back to reading* button.

- **Reads like a real PDF viewer** — Pages are rasterized by PDFium with hinted, pixel-exact text, so a paper is as sharp in Focus Mode on a 100 %-scale portrait monitor as it is in Edge or Acrobat. Dark mode inverts the page but keeps figures in their true colors.

- **One-glance triage** — Every paper carries a level (★ Noted · ★★ Relevant · ★★★ Core) and an optional ⚑ Revisit flag. The same stars and flag appear on sidebar rows, filter chips, the viewer toolbar and the dashboard, so you never need a legend — and a swipe on a row sets the flag.

---

## Features

### Reading

- **PDF viewer** — Continuous scroll, zoom (Ctrl+wheel, Ctrl+= / Ctrl+-, fit width), Focus Mode (Ctrl+L) for distraction-free reading. Papers open fitted to the window by default (Tools → Auto Fit Width on Open; uncheck it to open at 100 %). Clickable web links and internal links to references, figures and sections, with a *Back to reading* button to return. Korean/Japanese/Chinese PDFs render, select and search correctly.
- **Large files** — Proceedings volumes and scanned books (hundreds of MB) open in well under a second: PDFium reads only the parts of the file it needs, so a 736-page, 260 MB volume opens with about 65 MB of app memory, and any zoom level renders.
- **Hinted, pixel-exact text on every monitor** — PDFium draws the pages with font hinting and HYJI puts them on screen 1:1 on device pixels, so stroke weight is uniform and Focus Mode on a 100 %-scale portrait monitor reads like Edge or Acrobat. Text selection, highlights, links and search use the same engine, so highlights land exactly on the glyphs. Pages re-render when the window moves between monitors with different scaling. Preferences → *PDF render engine* can switch to the classic pdf.js renderer for a document that needs it (also the automatic fallback), and *PDF text rendering* adds optional stroke darkening (Off by default — the crispest).
- **PDF dark mode** (Ctrl+D) — Inverted night reading that keeps figures and photos in their true colors; citation cards switch to a light palette to stay readable.
- **Citation preview on hover** — Rest the pointer on a citation like [47] to see the paper it refers to: `[47] Tang et al.` · **Contrastive boundary learning for point cloud segmentation** · `CVPR` 2022. View → Citation Preview on Hover turns each field (authors, title, venue, year) on or off. Works with numbered and author-year reference styles, including two-column bibliographies and entries that continue onto the next column or page; links to figures, tables and sections show their caption or heading. Needs a PDF whose citations are real links (virtually all LaTeX papers).
- **Multi-tab reading** — Several papers in browser-style tabs; each tab remembers its zoom and reading position, and open tabs are restored on the next launch. Double-clicking a PDF in Explorer opens it as a tab in the running app.
- **Print** (Ctrl+P) — High-resolution print with your highlights, underlines, strikeouts and memos in their colors, rendered by the same engine as the screen.

### Annotating & note-taking

- **Highlights, underlines, strikeouts & memos** — Four colors each, margin memos, and an auto-appearing selection menu after you drag-select.
- **Send to Differentiation / Questions** — Selected text becomes a linked bullet in the tracker; the 🔗 icon jumps back to the exact sentence.
- **True two-way interop** — "Save annotations to PDF" writes standard annotations that Adobe Acrobat and other viewers display and edit; annotations made elsewhere are imported as editable HYJI annotations (Tools → Import Annotations from PDF).
- **Structured notes** — Summary / Differentiation / Questions bullet editors on top; collapsible metadata (type, authors, venue, DOI ↗, abstract, keywords) below.

### Organizing

- **Level & Revisit** — ★ / ★★ / ★★★ level plus a ⚑ Revisit flag per paper. Filter chips and sort by either; the dashboard counts them.
- **Project tree** — Collapsible nested folders with papers inline; drag a paper onto a folder, drag folders to reorder, F2 to rename. "Move to" in the context menu shows the real folder hierarchy.
- **Multi-select** — Ctrl+click, Shift+click ranges; right-click to move or delete the whole selection, Delete key, drag them all at once.
- **Swipe gestures** — Drag a paper row left to reveal Delete (all the way for the confirmation directly); drag right to toggle ⚑ Revisit.
- **Keyword graph** — D3 force-directed graph of keyword co-occurrence (auto-extracted from PDF metadata, editable per paper); click a node to filter, Ctrl+G for full screen.
- **Dashboard** — Home screen with recent papers, level/revisit counts, the project folder tree (with paper counts per folder) and quick actions.

### Metadata & export

- **Smart Paste** (Ctrl+N) — Paste BibTeX, a citation string, an arXiv ID or RIS; the format is auto-detected and every field parsed. Reference types (article / conference / book / chapter / thesis / misc) with publisher, edition, chapter, pages, DOI.
- **Fetch metadata** — One click looks the paper up on Crossref/arXiv from its DOI or arXiv ID (auto-detected in the PDF) with a confirm-before-overwrite diff. Strictly user-initiated — see [Privacy & Network Policy](#privacy--network-policy).
- **Export dialog** — LaTeX `.bib` / RIS / Word / CSV / clipboard; citation style (IEEE / ACS / Nature / APA / MLA); journal-name format (full / abbreviated, 302-venue ISO 4 / CASSI map with common aliases — shared with the citation preview); starting number; live preview. Raw pasted BibTeX is exported verbatim.
- **Full-text search** (Ctrl+Shift+F) — One overlay searches metadata, your notes *and* the text inside every PDF (Korean and English), with page-level hits that jump straight to the match; Ctrl+F scopes it to the open document.

### Workspace

- **Three resizable panels** — Sidebar · viewer · tracker with draggable splitters; View → Reset Panel Sizes (or double-click a splitter) restores the defaults. Startup layout preference: research hub or viewer-only.
- **Auto-backup** — Backup folder, interval, only-on-change and keep-last-N rotation in Preferences; a final backup on exit if anything changed.
- **In-app updates** — Help → Check for Updates… shows what's new and installs the next version in place; an automatic check at launch is available but off by default.
- **100% local** — SQLite database on your disk. No account, no cloud, no tracking. Works offline forever — and an **Offline mode** switch in Preferences guarantees it.

---

## Privacy & Network Policy

HYJI is local-first and makes **no automatic network requests** — the optional launch-time update check is off by default. There are exactly two online features, and both run only when you ask. In full:

- **Metadata lookup** ("🌐 Fetch metadata") runs only when you click it. It sends the paper's **DOI or arXiv ID — nothing else** — directly to `api.crossref.org` (Crossref, the non-profit DOI registry) or `export.arxiv.org` (arXiv, Cornell University) and reads back the public bibliographic record. These two domains are hard-coded as an allowlist in the Rust backend; the lookup cannot reach any other host.
- **Your PDFs, notes, highlights, and library never leave your computer.** The citation preview is computed locally from the PDF itself. There is no account, no telemetry, no proxy server — requests go straight from your machine to the non-profit source.
- **Before the first lookup**, a one-time dialog explains exactly what will be sent; Cancel sends nothing.
- **Update check** (Help → Check for Updates…) sends **one request to `github.com`** — the release feed of this repository — and only when you click it. Nothing about you or your library is sent; the reply is the newest version number and its release notes. Installing from that dialog downloads the signed installer from the same GitHub Releases page and verifies its signature before running it.
- **Automatic check at launch is opt-in and off by default** (Preferences → Network & privacy → "Check for updates automatically at launch"). When on, HYJI makes that same single request to `github.com` about 5 s after launch and stays silent unless a newer version exists.
- **Offline mode** (Tools → Preferences… → Network & privacy) disables online features entirely — with it on, HYJI makes zero network requests: metadata lookup is grayed out, and both the manual and the automatic update check are skipped before any request is made.

---

## Download

> **Windows only for now. macOS / Linux planned.**

**[⬇ Download latest installer (.msi)](https://github.com/inyoungoh-cde/hyji/releases/latest)**

1. Download `HYJI_x.x.x_x64_en-US.msi` (or the `-setup.exe`) from the Releases page
2. Double-click → Next → Next → Install → Finish
3. Launch HYJI from the Start menu — or set it as the default `.pdf` app and double-click any PDF

To update, either:

- **Help → Check for Updates…** inside HYJI — one request to `github.com` when you click it; if a newer version exists you see its release notes and can download and install it from the dialog (the app restarts into the new version). An automatic check at launch is available as an opt-in in Preferences → Network & privacy, off by default.
- **Or download the newest `.msi` from the Releases page and run it over the existing installation.** The installer is built as a Windows Installer *major upgrade*: it replaces the previous version in place (no need to uninstall first, and installing an older version is refused). Your library, notes and settings live in your app-data folder and are kept.

In line with the privacy policy above, HYJI never checks for updates unless you click the menu item or turn the launch-time check on.

---

## Quick Start

1. **Create a project** — Click the folder icon in the sidebar header or `File → New Project`
2. **Add a paper** — Drag a PDF onto the window, `File → Import PDF` (Ctrl+O), or double-click a PDF in Explorer
3. **Get the metadata** — `Ctrl+N` (Smart Paste) for BibTeX / citation / arXiv ID / RIS, or **Fetch metadata** in the tracker
4. **Highlight** — Drag-select text in the PDF → the selection menu appears → pick a highlight / underline / strikeout color
5. **Take notes** — In the same menu choose `Send to Differentiation` or `Send to Questions`; click 🔗 on any linked bullet to jump back to the source
6. **Triage** — Set the level (★ / ★★ / ★★★) in the tracker's Metadata section; swipe a sidebar row right to flag it ⚑ Revisit, left to delete it
7. **Follow citations** — Hover a citation like [47] to preview the referenced paper; click it to jump to the bibliography and *Back to reading* to return

### Level & Revisit at a glance

| Mark | Meaning |
|------|---------|
| ★ Noted | Skimmed or background reference (default) |
| ★★ Relevant | Directly related to your work, may cite |
| ★★★ Core | Must cite or compare against |
| ⚑ Revisit | Come back to this paper — a to-do flag independent of the level |

Color is only a secondary cue (gray → orange → red for the level, yellow for the flag); the star count and the flag glyph carry the meaning everywhere: sidebar rows, the PAPERS filter chips, the viewer toolbar, the dashboard and CSV export.

**Keyboard shortcuts:** `Ctrl+/` shows the full list in-app.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri v2 (Rust + WebView2) |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS |
| PDF engine | PDFium (Chromium) via `pdfium-render` — rendering, text layer, links, search, text extraction |
| Classic renderer / fallback | pdf.js (Mozilla) |
| Database | SQLite via tauri-plugin-sql |
| State | Zustand |
| Build | Vite |
| Graph | D3.js (force layout) |
| PDF export / annotation import | pdf-lib |
| Updates | tauri-plugin-updater (signed installers from GitHub Releases) |

---

## Build from Source

**Prerequisites:**
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- [Tauri CLI prerequisites for Windows](https://v2.tauri.app/start/prerequisites/) (WebView2, Visual Studio Build Tools)

```bash
# Clone the repo
git clone https://github.com/inyoungoh-cde/hyji.git
cd hyji

# Install JS dependencies
npm install

# Fetch the PDFium library (once; bundled as an app resource)
npm run pdfium:fetch

# Run in development mode
npm run tauri dev

# Build a release installer
npm run tauri build
```

The built installer will be at `src-tauri/target/release/bundle/msi/`.

---

## Known Issues & Tips

### "Save annotations to PDF" over the original file shows highlights twice

**Cause:** "Save annotations to PDF" writes standard `/Highlight` / `/Underline` / `/StrikeOut` annotations into the file. If you save over the paper's own PDF instead of the suggested `…_annotated.pdf`, the viewer then draws the in-file annotations *and* HYJI's own overlay for the same text.

**Fix:** Save to a separate file (the default), or run **Tools → Import Annotations from PDF** on the overwritten file — it strips the in-file copies and keeps HYJI's editable ones.

### A document renders differently than in another viewer

Preferences → **PDF render engine** → *pdf.js (classic)* switches back to the pre-3.0 renderer for comparison; the setting applies immediately to open tabs. Please open an issue with the PDF if PDFium gets something wrong.

### No citation card appears when hovering a citation

The preview needs the citation to be a real link inside the PDF. Most LaTeX (hyperref) papers have them; some publisher PDFs, scans and Word exports don't — there is nothing to preview in that case. Links that point back to page numbers ("cited on pages 2, 5") also show no card. Check View → Citation Preview on Hover: turning all four fields off disables the card.

### Equations can't be selected or searched in some PDFs

A few LaTeX workflows attach the equation's LaTeX source (`/ActualText`) to formulas. PDFium then reports that source instead of the visible symbols, so such formulas can't be selected or found by search under the default engine. Switch that document to Preferences → PDF render engine → *pdf.js (classic)*.

### Keyword graph shows word fragments (e.g. `corre`, `turefinetuning`)

**Cause:** Some PDFs encode the document title in the text layer without word spaces, or with line-break hyphens (e.g. `"CORRE- SPONDENCE…"`). HYJI extracts the title from this raw text, so the stored title can look like `MULTIVIEWEQUIVARIANCEIMPROVES3D CORRE- SPONDENCE…`. When keyword extraction falls back to the title, it produces word-fragment keywords.

**Fix:**
1. Open the paper in HYJI and edit the **Title** field in the Tracker panel (bottom, expand Metadata) to the correct title.
2. Run **Tools → Regenerate Keywords**.

**Prevention:** Use **Smart Paste** (`Ctrl+N`) to paste a BibTeX entry or citation string when importing a paper — this gives HYJI accurate metadata from the start and avoids relying on PDF text extraction.

> See [#known-issues](https://github.com/inyoungoh-cde/hyji/issues?q=label%3Aknown-issue) on GitHub for the full list.

---

## Contributing

Issues and pull requests are welcome.

- **Bug reports:** Open an issue with steps to reproduce
- **Feature requests:** Open an issue describing the use case
- **Pull requests:** Fork the repo, create a branch, submit a PR against `main`

Please keep PRs focused — one feature or fix per PR.

---

## Changelog

The three most recent releases; every release since 0.1 is in [CHANGELOG.md](./CHANGELOG.md) (releases before 2.0 were renumbered to a two-part scheme there — original git tags are unchanged).

### v3.4 (Sep 2026)
- Hover an in-text citation like [47] to see the referenced paper — first author et al., title, abbreviated venue (e.g. ECCV) and year — in a small card; choose the fields in View → Citation Preview on Hover. Click still jumps to the bibliography with Back to reading
- Bibliography entries found for every reference link in a 12-paper test library (numbered and author-year styles); field split verified at ≥ 99 % on 343 hand-checked entries
- Venue name list extended to 302 entries with common aliases

### v3.3 (Sep 2026)
- Tools → Auto Fit Width on Open (on by default): papers open at fit-width; uncheck to open at 1:1
- Dashboard → Projects shows the folder hierarchy (parent → child, indented, subtree paper counts) instead of flat chips
- First installer with the 3.2 changes (its CI build had failed on a package-version mismatch)

### v3.2 (Sep 2026)
- PDFium is now the viewer's only engine: text selection, highlights, links, search, printing and text extraction all use it (pdf.js stays as the selectable classic renderer / automatic fallback). Selection boxes now come from the same engine that draws the glyphs; papers are no longer parsed twice (260 MB volume: ~65 MB main process + ~210 MB WebView while open); any zoom level renders via strip rendering; printing keeps highlight colours and holds nothing in JS memory
- Help → Check for Updates… (one request to github.com, only when clicked) with in-app download & install; optional check at launch (off by default, disabled in offline mode). Installing a newer .msi over an older one upgrades in place — no uninstall needed

Older releases (3.1 → 0.1) are in the **[full changelog](./CHANGELOG.md)**.

---

## License

MIT License © 2026 HJ & IY — see [LICENSE](./LICENSE) for full text.

---

## Credits

Made by **HJ & IY**
