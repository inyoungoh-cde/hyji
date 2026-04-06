import { create } from "zustand";
import type { Project } from "../types";
import { getDb } from "../lib/db";

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, parentId?: string | null) => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  setProjectFolder: (id: string, folderPath: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,

  fetchProjects: async () => {
    set({ loading: true });
    const db = await getDb();
    const rows = await db.select<Project[]>(
      "SELECT * FROM projects ORDER BY sort_order, name"
    );
    set({ projects: rows, loading: false });
  },

  createProject: async (name, parentId = null) => {
    const db = await getDb();
    await db.execute(
      "INSERT INTO projects (name, parent_id) VALUES (?, ?)",
      [name, parentId]
    );
    // Get the last inserted project
    const rows = await db.select<Project[]>(
      "SELECT * FROM projects ORDER BY created_at DESC LIMIT 1"
    );
    const project = rows[0];
    await get().fetchProjects();
    return project;
  },

  renameProject: async (id, name) => {
    const db = await getDb();
    await db.execute(
      "UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?",
      [name, id]
    );
    await get().fetchProjects();
  },

  deleteProject: async (id) => {
    const db = await getDb();
    await db.execute("DELETE FROM projects WHERE id = ?", [id]);
    await get().fetchProjects();
  },

  reorderProjects: async (orderedIds) => {
    const db = await getDb();
    for (let i = 0; i < orderedIds.length; i++) {
      await db.execute("UPDATE projects SET sort_order = ? WHERE id = ?", [
        i,
        orderedIds[i],
      ]);
    }
    await get().fetchProjects();
  },

  setProjectFolder: async (id, folderPath) => {
    const db = await getDb();
    await db.execute(
      "UPDATE projects SET folder_path = ?, updated_at = datetime('now') WHERE id = ?",
      [folderPath, id]
    );
    await get().fetchProjects();
  },
}));
