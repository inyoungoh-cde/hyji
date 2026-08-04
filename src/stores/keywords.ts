import { create } from "zustand";
import { getDb } from "../lib/db";
import { extractKeywords } from "../lib/keywordExtract";
import { extractKeywordsFromPdf } from "../lib/pdfKeywords";
import { markDbDirty } from "./../lib/backup";
import type { Keyword, Paper } from "../types";

interface KeywordsState {
  keywords: Keyword[];
  fetchKeywords: () => Promise<void>;
  autoExtractForPapers: (papers: Paper[]) => Promise<void>;
  regenForPaper: (paper: Paper) => Promise<void>;
  addKeyword: (paperId: string, keyword: string) => Promise<void>;
  removeKeyword: (id: string) => Promise<void>;
}

async function extractBest(paper: Paper): Promise<string[]> {
  // Priority: PDF keywords → BibTeX keywords field → title
  if (paper.pdf_path) {
    const fromPdf = await extractKeywordsFromPdf(paper.pdf_path);
    if (fromPdf.length > 0) return fromPdf;
  }
  return extractKeywords(paper.title, paper.raw_bibtex);
}

// Papers whose auto-extraction already ran but produced nothing leave no
// keyword rows behind — without this record, every launch re-reads their
// entire PDF just to find nothing again (painful on a 60+ paper library).
const ATTEMPTED_KEY = "hyji:kw-extract-attempted";

function loadAttempted(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(ATTEMPTED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveAttempted(ids: Set<string>): void {
  try {
    localStorage.setItem(ATTEMPTED_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

export const useKeywordsStore = create<KeywordsState>((set, get) => ({
  keywords: [],

  fetchKeywords: async () => {
    const db = await getDb();
    const rows = await db.select<Keyword[]>("SELECT * FROM keywords");
    set({ keywords: rows });
  },

  autoExtractForPapers: async (papers) => {
    const db = await getDb();
    const rows = await db.select<Keyword[]>("SELECT * FROM keywords");
    const papersWithKeywords = new Set(rows.map((k) => k.paper_id));
    // Prune ids of deleted papers so the attempted set doesn't grow forever.
    const currentIds = new Set(papers.map((p) => p.id));
    const attempted = new Set([...loadAttempted()].filter((id) => currentIds.has(id)));

    let changed = false;
    let attemptedChanged = false;
    for (const paper of papers) {
      if (papersWithKeywords.has(paper.id) || attempted.has(paper.id)) continue;
      const extracted = await extractBest(paper);
      attempted.add(paper.id);
      attemptedChanged = true;
      for (const kw of extracted) {
        await db.execute(
          "INSERT OR IGNORE INTO keywords (paper_id, keyword, source) VALUES (?, ?, 'auto')",
          [paper.id, kw]
        );
      }
      if (extracted.length > 0) changed = true;
    }
    if (attemptedChanged) saveAttempted(attempted);

    if (changed || rows.length === 0) {
      const updated = await db.select<Keyword[]>("SELECT * FROM keywords");
      set({ keywords: updated });
      if (changed) markDbDirty();
    } else {
      set({ keywords: rows });
    }
  },

  // Regenerate auto keywords for a paper — preserves manual ones
  regenForPaper: async (paper) => {
    const db = await getDb();
    await db.execute("DELETE FROM keywords WHERE paper_id = ? AND source = 'auto'", [paper.id]);
    const extracted = await extractBest(paper);
    for (const kw of extracted) {
      await db.execute(
        "INSERT OR IGNORE INTO keywords (paper_id, keyword, source) VALUES (?, ?, 'auto')",
        [paper.id, kw]
      );
    }
    await get().fetchKeywords();
    markDbDirty();
  },

  addKeyword: async (paperId, keyword) => {
    const db = await getDb();
    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return;
    const existing = get().keywords.find(
      (k) => k.paper_id === paperId && k.keyword === trimmed
    );
    if (existing) return;
    await db.execute(
      "INSERT INTO keywords (paper_id, keyword, source) VALUES (?, ?, 'manual')",
      [paperId, trimmed]
    );
    await get().fetchKeywords();
    markDbDirty();
  },

  removeKeyword: async (id) => {
    const db = await getDb();
    await db.execute("DELETE FROM keywords WHERE id = ?", [id]);
    await get().fetchKeywords();
    markDbDirty();
  },
}));
