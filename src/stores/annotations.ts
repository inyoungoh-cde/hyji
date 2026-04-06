import { create } from "zustand";
import type { Annotation, NoteLink } from "../types";
import { getDb } from "../lib/db";

interface AnnotationsState {
  annotations: Annotation[];
  noteLinks: NoteLink[];
  fetchAnnotations: (paperId: string) => Promise<void>;
  createAnnotation: (ann: {
    paper_id: string;
    type: "highlight" | "memo";
    page: number;
    selected_text: string;
    color: string;
    rects_json?: string;
    memo_text?: string;
  }) => Promise<Annotation>;
  updateAnnotation: (id: string, paperId: string, fields: Partial<Pick<Annotation, "memo_text" | "color">>) => Promise<void>;
  deleteAnnotation: (id: string, paperId: string) => Promise<void>;
  createNoteLink: (link: {
    paper_id: string;
    annotation_id: string;
    note_field: "summary" | "differentiation" | "questions";
    bullet_index: number;
  }) => Promise<void>;
  getNoteLinksForPaper: (paperId: string) => Promise<NoteLink[]>;
  deleteNoteLink: (link: NoteLink) => Promise<void>;
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  annotations: [],
  noteLinks: [],

  fetchAnnotations: async (paperId) => {
    const db = await getDb();
    const annotations = await db.select<Annotation[]>(
      "SELECT * FROM annotations WHERE paper_id = ? ORDER BY page, created_at",
      [paperId]
    );
    const noteLinks = await db.select<NoteLink[]>(
      "SELECT * FROM note_links WHERE paper_id = ? ORDER BY note_field, bullet_index",
      [paperId]
    );
    set({ annotations, noteLinks });
  },

  createAnnotation: async (ann) => {
    const db = await getDb();
    await db.execute(
      `INSERT INTO annotations (paper_id, type, page, selected_text, color, rects_json, memo_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ann.paper_id, ann.type, ann.page, ann.selected_text, ann.color, ann.rects_json ?? "[]", ann.memo_text ?? ""]
    );
    const rows = await db.select<Annotation[]>(
      "SELECT * FROM annotations WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1",
      [ann.paper_id]
    );
    await get().fetchAnnotations(ann.paper_id);
    return rows[0];
  },

  updateAnnotation: async (id, paperId, fields) => {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.memo_text !== undefined) { sets.push("memo_text = ?"); vals.push(fields.memo_text); }
    if (fields.color !== undefined) { sets.push("color = ?"); vals.push(fields.color); }
    if (sets.length === 0) return;
    vals.push(id);
    await db.execute(`UPDATE annotations SET ${sets.join(", ")} WHERE id = ?`, vals);
    await get().fetchAnnotations(paperId);
  },

  deleteAnnotation: async (id, paperId) => {
    const db = await getDb();
    await db.execute("DELETE FROM annotations WHERE id = ?", [id]);
    await get().fetchAnnotations(paperId);
  },

  createNoteLink: async (link) => {
    const db = await getDb();
    await db.execute(
      `INSERT INTO note_links (paper_id, annotation_id, note_field, bullet_index)
       VALUES (?, ?, ?, ?)`,
      [link.paper_id, link.annotation_id, link.note_field, link.bullet_index]
    );
    await get().fetchAnnotations(link.paper_id);
  },

  getNoteLinksForPaper: async (paperId) => {
    const db = await getDb();
    return db.select<NoteLink[]>(
      "SELECT * FROM note_links WHERE paper_id = ? ORDER BY note_field, bullet_index",
      [paperId]
    );
  },

  deleteNoteLink: async (link) => {
    const db = await getDb();
    await db.execute("DELETE FROM note_links WHERE id = ?", [link.id]);
    // Shift down note_links that came after the deleted bullet
    await db.execute(
      `UPDATE note_links SET bullet_index = bullet_index - 1
       WHERE paper_id = ? AND note_field = ? AND bullet_index > ?`,
      [link.paper_id, link.note_field, link.bullet_index]
    );
    await get().fetchAnnotations(link.paper_id);
  },
}));
