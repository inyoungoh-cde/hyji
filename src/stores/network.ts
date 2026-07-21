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

function loadString(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

interface NetworkState {
  offlineMode: boolean;
  fetchConsented: boolean;
  /** Optional contact email appended to the lookup User-Agent (v2.4).
   *  Routes Crossref requests to their "polite pool" with generous rate
   *  limits — the anonymous pool intermittently answers HTTP 429. Empty =
   *  anonymous (the v2.0 default); sent only to api.crossref.org. */
  politeEmail: string;
  setOfflineMode: (on: boolean) => void;
  grantFetchConsent: () => void;
  setPoliteEmail: (email: string) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  offlineMode: loadBool("hyji:offline-mode", false),
  fetchConsented: loadBool("hyji:fetch-consent", false),
  politeEmail: loadString("hyji:polite-email"),

  setOfflineMode: (on) => {
    persistBool("hyji:offline-mode", on);
    set({ offlineMode: on });
  },
  grantFetchConsent: () => {
    persistBool("hyji:fetch-consent", true);
    set({ fetchConsented: true });
  },
  setPoliteEmail: (email) => {
    const v = email.trim();
    try { localStorage.setItem("hyji:polite-email", v); } catch { /* ignore */ }
    set({ politeEmail: v });
  },
}));
