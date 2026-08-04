import * as pdfjsLib from "pdfjs-dist";
import { readFile } from "@tauri-apps/plugin-fs";
import { getDb } from "./db";
import { PDFJS_ASSET_OPTIONS } from "./pdfjsAssets";
import { getBgPdfWorker } from "./pdfBgWorker";
import type { Paper } from "../types";

/**
 * Library-wide full-text search over PDF contents.
 *
 * Index: one FTS5 row per page, trigram-tokenized — trigram handles CJK
 * substring matching without a dictionary (queries of 3+ characters).
 * Queries shorter than 3 characters fall back to a LIKE scan so 1–2
 * character Korean terms still work. The bundled SQLite (libsqlite3-sys)
 * compiles with SQLITE_ENABLE_FTS5, so no loadable extension is needed.
 */

export interface SearchHit {
  paper_id: string;
  page: number;
  /** Snippet with matches wrapped in ⟪ ⟫. */
  snippet: string;
}

let ftsAvailable: boolean | null = null;

async function ensureTables(): Promise<boolean> {
  if (ftsAvailable !== null) return ftsAvailable;
  const db = await getDb();
  try {
    await db.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(
        paper_id UNINDEXED,
        page UNINDEXED,
        body,
        tokenize='trigram'
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS fts_index_meta (
        paper_id TEXT PRIMARY KEY,
        pdf_path TEXT NOT NULL,
        indexed_at TEXT DEFAULT (datetime('now'))
      );
    `);
    ftsAvailable = true;
  } catch (e) {
    console.warn("[hyji fts] FTS5 unavailable:", e);
    ftsAvailable = false;
  }
  return ftsAvailable;
}

/** Extract per-page plain text from a PDF file. */
async function extractPages(pdfPath: string): Promise<string[]> {
  const bytes = await readFile(pdfPath);
  // Indexing runs on the shared background worker — on the viewer's global
  // worker, a first-run library index queues every page the user opens.
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    worker: getBgPdfWorker(),
    ...PDFJS_ASSET_OPTIONS,
  }).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += (item as { str: string }).str;
        text += (item as { hasEOL?: boolean }).hasEOL ? "\n" : " ";
      }
      pages.push(text.replace(/\s+/g, " ").trim());
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }
  return pages;
}

export async function deletePaperIndex(paperId: string): Promise<void> {
  if (!(await ensureTables())) return;
  const db = await getDb();
  await db.execute("DELETE FROM pdf_fts WHERE paper_id = ?", [paperId]);
  await db.execute("DELETE FROM fts_index_meta WHERE paper_id = ?", [paperId]);
}

export async function indexPaper(paper: Paper): Promise<void> {
  if (!paper.pdf_path || !(await ensureTables())) return;
  const db = await getDb();
  const pages = await extractPages(paper.pdf_path);
  await db.execute("DELETE FROM pdf_fts WHERE paper_id = ?", [paper.id]);
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i]) continue;
    await db.execute(
      "INSERT INTO pdf_fts (paper_id, page, body) VALUES (?, ?, ?)",
      [paper.id, i + 1, pages[i]]
    );
  }
  await db.execute(
    `INSERT INTO fts_index_meta (paper_id, pdf_path, indexed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(paper_id) DO UPDATE SET pdf_path = excluded.pdf_path, indexed_at = datetime('now')`,
    [paper.id, paper.pdf_path]
  );
}

let indexingInFlight = false;

/**
 * Index every paper whose PDF is not indexed yet (or whose file path
 * changed). Runs sequentially in the background; safe to call repeatedly.
 */
export async function ensureLibraryIndexed(papers: Paper[]): Promise<void> {
  if (indexingInFlight || !(await ensureTables())) return;
  indexingInFlight = true;
  try {
    const db = await getDb();
    const meta = await db.select<{ paper_id: string; pdf_path: string }[]>(
      "SELECT paper_id, pdf_path FROM fts_index_meta"
    );
    const indexed = new Map(meta.map((m) => [m.paper_id, m.pdf_path]));
    for (const paper of papers) {
      if (!paper.pdf_path) continue;
      if (indexed.get(paper.id) === paper.pdf_path) continue;
      try {
        await indexPaper(paper);
      } catch (e) {
        // Missing/unreadable file — skip, retry next session
        console.warn(`[hyji fts] index failed for "${paper.title}":`, e);
      }
      // Yield between papers so indexing never blocks the UI
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    indexingInFlight = false;
  }
}

export async function rebuildLibraryIndex(papers: Paper[]): Promise<void> {
  if (!(await ensureTables())) return;
  const db = await getDb();
  await db.execute("DELETE FROM pdf_fts");
  await db.execute("DELETE FROM fts_index_meta");
  await ensureLibraryIndexed(papers);
}

function makeLikeSnippet(body: string, query: string): string {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return body.slice(0, 90);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 50);
  return (
    (start > 0 ? "… " : "") +
    body.slice(start, idx) +
    "⟪" + body.slice(idx, idx + query.length) + "⟫" +
    body.slice(idx + query.length, end) +
    (end < body.length ? " …" : "")
  );
}

/** Index a single paper if it isn't indexed yet (or its file moved). */
export async function ensurePaperIndexed(paper: Paper): Promise<void> {
  if (!paper.pdf_path || !(await ensureTables())) return;
  const db = await getDb();
  const meta = await db.select<{ pdf_path: string }[]>(
    "SELECT pdf_path FROM fts_index_meta WHERE paper_id = ?",
    [paper.id]
  );
  if (meta[0]?.pdf_path === paper.pdf_path) return;
  await indexPaper(paper);
}

export async function searchLibrary(
  query: string,
  limit = 60,
  paperId?: string
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q || !(await ensureTables())) return [];
  const db = await getDb();
  const scope = paperId ? " AND paper_id = ?" : "";

  // Trigram FTS needs 3+ characters; shorter queries scan with LIKE.
  if ([...q].length >= 3) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    const params: unknown[] = paperId ? [phrase, paperId, limit] : [phrase, limit];
    const rows = await db.select<{ paper_id: string; page: number; snip: string }[]>(
      `SELECT paper_id, page, snippet(pdf_fts, 2, '⟪', '⟫', ' … ', 14) AS snip
       FROM pdf_fts WHERE pdf_fts MATCH ?${scope}
       ORDER BY bm25(pdf_fts) LIMIT ?`,
      params
    );
    return rows.map((r) => ({ paper_id: r.paper_id, page: Number(r.page), snippet: r.snip }));
  }

  const escaped = q.replace(/([\\%_])/g, "\\$1");
  const params: unknown[] = paperId ? [`%${escaped}%`, paperId, limit] : [`%${escaped}%`, limit];
  const rows = await db.select<{ paper_id: string; page: number; body: string }[]>(
    `SELECT paper_id, page, body FROM pdf_fts
     WHERE body LIKE ? ESCAPE '\\'${scope} LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    paper_id: r.paper_id,
    page: Number(r.page),
    snippet: makeLikeSnippet(r.body, q),
  }));
}
