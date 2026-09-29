import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message } from "@tauri-apps/plugin-dialog";
import { useNetworkStore } from "./network";

/**
 * Update check state (v3.2). Nothing here runs on its own: `runCheck` is
 * called from Help → Check for Updates… or, when the user opted in, once
 * ~5 s after launch (App.tsx). Each check is exactly one HTTPS request to
 * github.com for the release feed (latest.json); offline mode short-circuits
 * before any request is made.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface UpdaterState {
  open: boolean;
  phase: UpdatePhase;
  currentVersion: string;
  update: Update | null;
  /** 0..1 when the content length is known, null otherwise. */
  progress: number | null;
  downloadedBytes: number;
  error: string;
  /** silent = launch-time check: only surfaces when an update exists. */
  runCheck: (opts?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  close: () => void;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export const OFFLINE_UPDATE_MESSAGE =
  "Offline mode is on — turn it off in Preferences to check for updates.";

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  open: false,
  phase: "idle",
  currentVersion: "",
  update: null,
  progress: null,
  downloadedBytes: 0,
  error: "",

  runCheck: async ({ silent = false } = {}) => {
    if (useNetworkStore.getState().offlineMode) {
      if (!silent) await message(OFFLINE_UPDATE_MESSAGE, { title: "Check for Updates", kind: "info" });
      return;
    }
    const { phase, update } = get();
    if (phase === "checking" || phase === "downloading" || phase === "installing") {
      if (!silent) set({ open: true });
      return;
    }
    // A previous result still holds a Rust-side resource — release it first.
    if (update) update.close().catch(() => {});
    set({ phase: "checking", update: null, progress: null, downloadedBytes: 0, error: "", open: !silent });
    try {
      const found = await check({ timeout: 15_000 });
      if (found) {
        set({ phase: "available", update: found, currentVersion: found.currentVersion, open: true });
      } else {
        set({ phase: "up-to-date", open: !silent });
      }
    } catch (e) {
      const text = errorText(e);
      set({ phase: "error", error: text, open: !silent });
      if (!silent) {
        await message(`Could not check for updates.\n\n${text}`, { title: "Check for Updates", kind: "error" });
      }
    }
  },

  install: async () => {
    const { update, phase } = get();
    if (!update || phase !== "available") return;
    set({ phase: "downloading", progress: null, downloadedBytes: 0, open: true });
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          set({ progress: total ? 0 : null });
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          set({ downloadedBytes: done, progress: total ? Math.min(1, done / total) : null });
        } else if (ev.event === "Finished") {
          set({ phase: "installing", progress: 1 });
        }
      });
      // On Windows the installer exits the app itself; this only runs if it
      // returned control (other platforms, or a passive install that didn't).
      await relaunch();
    } catch (e) {
      const text = errorText(e);
      set({ phase: "error", error: text, open: true });
      await message(`The update could not be installed.\n\n${text}`, { title: "Check for Updates", kind: "error" });
    }
  },

  close: () => {
    const { phase, update } = get();
    if (phase === "downloading" || phase === "installing") return;
    if (update) update.close().catch(() => {});
    set({ open: false, phase: "idle", update: null, progress: null, downloadedBytes: 0, error: "" });
  },
}));
