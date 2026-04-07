import { create } from "zustand";
import { getDb } from "../lib/db";
import { extractKeywords } from "../lib/keywordExtract";
import { extractKeywordsFromPdf } from "../lib/pdfKeywords";
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

    let changed = false;
    for (const paper of papers) {
      if (papersWithKeywords.has(paper.id)) continue;
      const extracted = await extractBest(paper);
      for (const kw of extracted) {
        await db.execute(
          "INSERT OR IGNORE INTO keywords (paper_id, keyword, source) VALUES (?, ?, 'auto')",
          [paper.id, kw]
        );
      }
      if (extracted.length > 0) changed = true;
    }

    if (changed || rows.length === 0) {
      const updated = await db.select<Keyword[]>("SELECT * FROM keywords");
      set({ keywords: updated });
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
  },

  removeKeyword: async (id) => {
    const db = await getDb();
    await db.execute("DELETE FROM keywords WHERE id = ?", [id]);
    await get().fetchKeywords();
  },
}));
