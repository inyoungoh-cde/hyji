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

HYJI (pronounced *hai-jee*) is a desktop app built for researchers who spend serious time in PDFs. It combines a PDF reader, highlight/annotation tool, structured note-taking panel, and a project management layer — all in one window, all stored locally.

No cloud. No subscriptions. No AI fluff. Just you and your papers.

---

## Features

- **PDF Viewer** — Smooth continuous scroll, zoom, text search, clickable hyperlinks and internal reference links
- **Highlights & Memos** — 5 highlight colors, margin memos, all rendered over the text layer
- **Bidirectional Notes** — Send selected text to Summary / Differentiation / Questions panels; click a linked bullet to jump back to the exact spot in the PDF
- **Project Tree** — Organize papers into folders, drag to reorder or move between projects, inline rename with F2
- **Smart Paste** — Paste a BibTeX entry, citation string, or arXiv ID and HYJI parses all fields automatically
- **Keyword Graph** — D3 force-directed graph of keyword co-occurrence across your library; click a node to filter
- **Export** — BibTeX (per-paper or batch), CSV, JSON, print with highlights burned in, save highlights to PDF
- **Dashboard** — Notion-style home screen with recent papers, reading stats, and quick actions
- **100% Local** — SQLite database in your app data folder; no account, no sync, no tracking

---

## Download

> **Windows only in v1.0. macOS / Linux planned.**

**[⬇ Download latest installer (.msi)](https://github.com/inyoungoh-cde/hyji/releases/latest)**

1. Download `HYJI_x.x.x_x64_en-US.msi` from the Releases page
2. Double-click → Next → Next → Install → Finish
3. Launch HYJI from the Start menu

HYJI checks for updates automatically on launch.

---

## Quick Start

1. **Create a project** — Click `+` in the sidebar header or `File → New Project`
2. **Add a paper** — Drag a PDF onto the window, or `File → Import PDF`
3. **Paste metadata** — Use `Ctrl+N` (Smart Paste) to paste BibTeX or a citation string
4. **Highlight** — Select text in the PDF → right-click → choose a highlight color
5. **Take notes** — Select text → right-click → `Send to Differentiation` or `Send to Questions`; click 🔗 on any linked bullet to jump back to the source

**Keyboard shortcuts:** `Ctrl+/` shows the full list in-app.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri v2 (Rust + WebView2) |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS |
| PDF rendering | pdf.js (Mozilla) |
| Database | SQLite via tauri-plugin-sql |
| State | Zustand |
| Build | Vite |
| Graph | D3.js (force layout) |
| PDF export | pdf-lib |

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

# Run in development mode
npm run tauri dev

# Build a release installer
npm run tauri build
```

The built installer will be at `src-tauri/target/release/bundle/msi/`.

---

## Contributing

Issues and pull requests are welcome.

- **Bug reports:** Open an issue with steps to reproduce
- **Feature requests:** Open an issue describing the use case
- **Pull requests:** Fork the repo, create a branch, submit a PR against `main`

Please keep PRs focused — one feature or fix per PR.

---

## License

MIT License © 2026 HJ & IY — see [LICENSE](./LICENSE) for full text.

---

## Credits

Made by **HJ & IY**
