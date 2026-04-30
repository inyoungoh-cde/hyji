Update README.md — replace the "What is HYJI?" and "Features" sections with the following:

## What is HYJI?

HYJI (pronounced *hai-jee*) is a desktop app built for researchers who spend serious time in PDFs. It combines a PDF reader, highlight/annotation tool, structured note-taking panel, and a project management layer — all in one window, all stored locally.

No cloud. No subscriptions. No AI fluff. Just you and your papers.

---

## Why HYJI?

Other tools let you manage papers. HYJI lets you **think through** them.

- **Right-click → Send to Differentiation** — Select a sentence in the PDF, right-click, and choose exactly where it goes: Summary, Differentiation, or Questions. The text becomes a linked bullet in your structured notes. No other tool lets you classify annotations into research categories at the moment of reading.

- **Bidirectional anchor links** — Every linked bullet has a 🔗 icon. Click it, and the PDF scrolls to the exact sentence you highlighted — not just the page, the sentence. "Where did I read that?" is no longer a question.

- **Built-in research framework** — Every paper gets three sections: Summary (what it does), Differentiation (what makes it different), Questions (what remains open). After 200 papers, you can instantly compare any two without re-reading either.

- **Keyword graph, zero setup** — Import papers and their keywords are auto-extracted from PDF metadata. A force-directed graph in the sidebar shows how your papers connect. Click a node to filter. No manual tagging required.

---

## Features

- **PDF Viewer** — Continuous scroll, zoom, text search, clickable hyperlinks and internal reference links, Focus Mode (Ctrl+L) for distraction-free reading

- **Highlights & Memos** — 5 highlight colors, margin memos, save highlights to PDF as standard annotations

- **Smart Paste** — Paste BibTeX, citation string, arXiv ID, or RIS — HYJI auto-detects the format and parses all fields. Supports @article, @book, @phdthesis, and more.

- **Export dialog** — Choose output format (LaTeX / Word / CSV / clipboard), citation style (IEEE / ACS / Nature / APA / MLA), journal name format (full / abbreviated), and starting number. Live preview included.

- **Project Tree** — Organize papers into collapsible folders, drag to reorder, inline rename with F2

- **Keyword Graph** — D3 force-directed graph of keyword co-occurrence; click a node to filter papers

- **Auto-backup** — Configure backup folder and interval in Preferences; only backs up when changes are detected

- **Dashboard** — Notion-style home screen with recent papers, reading stats, and quick actions

- **100% Local** — SQLite database on your disk. No account, no cloud, no tracking. Works offline forever.

Then commit and push.



Bump version to 1.0.0 in package.json, src-tauri/tauri.conf.json, 

src-tauri/Cargo.toml, and AboutModal. Update CHANGELOG.md:

## [1.0.0] - 2026-04-30

### Official Release

- All features from v0.1.0 through v0.1.7 are now production-ready

- New app icon: HJ ligature design with amber highlight bar

- PDF internal reference click with return-to-position and flash animation

- Updated README with "Why HYJI?" section highlighting key differentiators

Then commit, push, and tag:

git add .

git commit -m "release: HYJI v1.0.0"

git push origin main

git tag v1.0.0

git push origin v1.0.0