import { create } from "zustand";

/**
 * Network & privacy preferences (v2.0).
 * HYJI's only network feature is the user-initiated metadata lookup
 * (Crossref / arXiv). Offline mode is a hard switch that disables it;
 * fetchConsented records that the one-time "what gets sent" notice
 * was shown and accepted before the first lookup.
 */

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "1" || v === "0") return v === "1";
  } catch { /* ignore */ }
  return fallback;
}

function persistBool(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ }
}

interface NetworkState {
  offlineMode: boolean;
  fetchConsented: boolean;
  setOfflineMode: (on: boolean) => void;
  grantFetchConsent: () => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  offlineMode: loadBool("hyji:offline-mode", false),
  fetchConsented: loadBool("hyji:fetch-consent", false),

  setOfflineMode: (on) => {
    persistBool("hyji:offline-mode", on);
    set({ offlineMode: on });
  },
  grantFetchConsent: () => {
    persistBool("hyji:fetch-consent", true);
    set({ fetchConsented: true });
  },
}));
