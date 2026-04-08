import { create } from "zustand";
import type { Paper } from "../types";
import { getDb } from "../lib/db";

interface PapersState {
  papers: Paper[];
  loading: boolean;
  fetchPapers: (projectId?: string | null) => Promise<void>;
  createPaper: (title: string, projectId?: string | null, pdfPath?: string, pdfStorage?: "copy" | "link") => Promise<Paper>;
  updatePaper: (id: string, fields: Partial<Paper>) => Promise<void>;
  deletePaper: (id: string) => Promise<void>;
  reorderPapers: (orderedIds: string[]) => Promise<void>;
}

export const usePapersStore = create<PapersState>((set, get) => ({
  papers: [],
  loading: false,

  fetchPapers: async () => {
    set({ loading: true });
    const db = await getDb();
    const rows = await db.select<Paper[]>(
      "SELECT * FROM papers ORDER BY sort_order ASC, created_at DESC"
    );
    set({ papers: rows, loading: false });
  },

  createPaper: async (title, projectId = null, pdfPath = "", pdfStorage = "link") => {
    const db = await getDb();
    const maxRows = await db.select<[{ m: number | null }]>(
      "SELECT MAX(sort_order) as m FROM papers"
    );
    const nextOrder = (maxRows[0]?.m ?? -1) + 1;
    await db.execute(
      "INSERT INTO papers (title, project_id, sort_order, pdf_path, pdf_storage) VALUES (?, ?, ?, ?, ?)",
      [title, projectId, nextOrder, pdfPath, pdfStorage]
    );
    const rows = await db.select<Paper[]>(
      "SELECT * FROM papers ORDER BY created_at DESC LIMIT 1"
    );
    const paper = rows[0];
    await get().fetchPapers();
    return paper;
  },

  updatePaper: async (id, fields) => {
    const db = await getDb();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || key === "created_at") continue;
      setClauses.push(`${key} = ?`);
      values.push(value);
    }

    if (setClauses.length === 0) return;

    setClauses.push("updated_at = datetime('now')");
    values.push(id);

    await db.execute(
      `UPDATE papers SET ${setClauses.join(", ")} WHERE id = ?`,
      values
    );
    await get().fetchPapers();
  },

  deletePaper: async (id) => {
    const db = await getDb();
    await db.execute("DELETE FROM papers WHERE id = ?", [id]);
    await get().fetchPapers();
  },

  reorderPapers: async (orderedIds) => {
    const db = await getDb();
    for (let i = 0; i < orderedIds.length; i++) {
      await db.execute("UPDATE papers SET sort_order = ? WHERE id = ?", [
        i,
        orderedIds[i],
      ]);
    }
    await get().fetchPapers();
  },
}));
