import { create } from "zustand";

export type TextSize = "normal" | "large" | "xlarge";

// Startup layout preference — what the panels look like when HYJI launches.
// "remember": restore whatever the user had last session.
// "full":     research hub — sidebar + tracker open.
// "viewer":   distraction-free reading — both panels closed (viewer-only).
export type StartupLayout = "remember" | "full" | "viewer";

export function loadStartupLayout(): StartupLayout {
  try {
    const v = localStorage.getItem("hyji:startup-layout");
    if (v === "full" || v === "viewer") return v;
  } catch { /* ignore */ }
  return "remember";
}

export function saveStartupLayout(layout: StartupLayout): void {
  try { localStorage.setItem("hyji:startup-layout", layout); } catch { /* ignore */ }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "1" || v === "0") return v === "1";
  } catch { /* ignore */ }
  return fallback;
}

function initialPanelVisibility(): { sidebar: boolean; tracker: boolean } {
  const layout = loadStartupLayout();
  if (layout === "full") return { sidebar: true, tracker: true };
  if (layout === "viewer") return { sidebar: false, tracker: false };
  return {
    sidebar: loadBool("hyji:sidebar-visible", true),
    tracker: loadBool("hyji:tracker-visible", true),
  };
}

function persistPanel(key: string, visible: boolean): void {
  try { localStorage.setItem(key, visible ? "1" : "0"); } catch { /* ignore */ }
}

// Restores panel visibility from the pre-focus snapshot when focus mode must
// end implicitly (e.g. the last tab closed while focused). Mirrors exitFocusMode.
function focusExitPatch(s: {
  focusMode: boolean;
  preFocusState: PreFocusState | null;
  sidebarVisible: boolean;
  trackerVisible: boolean;
}): Partial<{
  focusMode: boolean;
  preFocusState: PreFocusState | null;
  sidebarVisible: boolean;
  trackerVisible: boolean;
}> {
  if (!s.focusMode) return {};
  const snap = s.preFocusState;
  const sidebarVisible = snap ? snap.sidebarOpen : s.sidebarVisible;
  const trackerVisible = snap ? snap.trackerOpen : s.trackerVisible;
  persistPanel("hyji:sidebar-visible", sidebarVisible);
  persistPanel("hyji:tracker-visible", trackerVisible);
  return { focusMode: false, preFocusState: null, sidebarVisible, trackerVisible };
}

function loadOpenTabs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("hyji:open-tabs") ?? "[]");
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch { /* ignore */ }
  return [];
}

function persistOpenTabs(ids: string[]): void {
  try { localStorage.setItem("hyji:open-tabs", JSON.stringify(ids)); } catch { /* ignore */ }
}

export interface PreFocusState {
  sidebarOpen: boolean;
  trackerOpen: boolean;
  zoomLevel: number;
}

interface UiState {
  sidebarWidth: number;
  trackerWidth: number;
  sidebarVisible: boolean;
  trackerVisible: boolean;
  activePaperId: string | null;
  /** Papers open as viewer tabs, in tab order. Persisted across sessions. */
  openPaperIds: string[];
  selectedProjectId: string | null;
  keywordFilter: string | null;
  scrollToAnnotation: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null;
  /** Pending "open paper at page" request (from global search results).
   *  When query is set, the in-PDF search picks it up so the match is
   *  highlighted on arrival. */
  goToRequest: { paperId: string; page: number; query?: string } | null;
  /** Unified search overlay: null = closed; scope decides the default filter. */
  searchOverlayScope: "library" | "document" | null;
  textSize: TextSize;
  /** Dark-mode PDF rendering (inverted canvas for night reading). */
  pdfDarkMode: boolean;
  /** Stem-darkening strength for PDF text on standard-DPI displays (0 = off).
   *  Compensates for pdf.js's unhinted antialiasing looking thin vs Acrobat. */
  pdfTextDarkening: number;
  focusMode: boolean;
  preFocusState: PreFocusState | null;

  setSidebarWidth: (w: number) => void;
  setTrackerWidth: (w: number) => void;
  toggleSidebar: () => void;
  toggleTracker: () => void;
  setActivePaper: (id: string | null) => void;
  closePaperTab: (id: string) => void;
  setSelectedProject: (id: string | null) => void;
  setKeywordFilter: (keyword: string | null) => void;
  setScrollToAnnotation: (req: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null) => void;
  /** Open a paper as a tab and scroll to the given page once it loads. */
  requestGoTo: (paperId: string, page: number, query?: string) => void;
  clearGoToRequest: () => void;
  openSearchOverlay: (scope: "library" | "document") => void;
  closeSearchOverlay: () => void;
  setTextSize: (size: TextSize) => void;
  togglePdfDarkMode: () => void;
  setPdfTextDarkening: (v: number) => void;
  enterFocusMode: (snapshot: PreFocusState) => void;
  exitFocusMode: () => PreFocusState | null;
}

const SIDEBAR_DEFAULT = 200;
const TRACKER_DEFAULT = 320;

function loadNumber(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    return v ? Number(v) : fallback;
  } catch {
    return fallback;
  }
}

function loadPdfTextDarkening(): number {
  try {
    const v = localStorage.getItem("hyji:pdf-text-darkening");
    if (v !== null) {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 0 && n <= 1) return n;
    }
  } catch { /* ignore */ }
  return 0.65;
}

function loadTextSize(): TextSize {
  try {
    const v = localStorage.getItem("hyji:text-size");
    if (v === "large" || v === "xlarge") return v;
  } catch { /* ignore */ }
  return "normal";
}

const initialPanels = initialPanelVisibility();

export const useUiStore = create<UiState>((set, get) => ({
  sidebarWidth: loadNumber("hyji:sidebar-width", SIDEBAR_DEFAULT),
  trackerWidth: loadNumber("hyji:tracker-width", TRACKER_DEFAULT),
  sidebarVisible: initialPanels.sidebar,
  trackerVisible: initialPanels.tracker,
  activePaperId: null,
  openPaperIds: loadOpenTabs(),
  selectedProjectId: null,
  keywordFilter: null,
  scrollToAnnotation: null,
  goToRequest: null,
  searchOverlayScope: null,
  textSize: loadTextSize(),
  pdfDarkMode: loadBool("hyji:pdf-dark", false),
  pdfTextDarkening: loadPdfTextDarkening(),
  focusMode: false,
  preFocusState: null,

  setSidebarWidth: (w) => {
    localStorage.setItem("hyji:sidebar-width", String(w));
    set({ sidebarWidth: w });
  },
  setTrackerWidth: (w) => {
    localStorage.setItem("hyji:tracker-width", String(w));
    set({ trackerWidth: w });
  },
  toggleSidebar: () =>
    set((s) => {
      persistPanel("hyji:sidebar-visible", !s.sidebarVisible);
      return {
        sidebarVisible: !s.sidebarVisible,
        // Manual sidebar toggle while focused -> drop focus mode
        focusMode: s.focusMode ? false : s.focusMode,
        preFocusState: s.focusMode ? null : s.preFocusState,
      };
    }),
  toggleTracker: () =>
    set((s) => {
      persistPanel("hyji:tracker-visible", !s.trackerVisible);
      return {
        trackerVisible: !s.trackerVisible,
        focusMode: s.focusMode ? false : s.focusMode,
        preFocusState: s.focusMode ? null : s.preFocusState,
      };
    }),
  // Activating a paper also opens it as a tab (browser-like behavior).
  // Passing null returns to the Dashboard but keeps tabs open.
  setActivePaper: (id) =>
    set((s) => {
      if (id === null) {
        // Landing on the Dashboard while in Focus Mode would strand the user
        // (Esc/Ctrl+L only work with an active paper) — exit focus first.
        return { activePaperId: null, ...focusExitPatch(s) };
      }
      if (s.openPaperIds.includes(id)) return { activePaperId: id };
      const openPaperIds = [...s.openPaperIds, id];
      persistOpenTabs(openPaperIds);
      return { activePaperId: id, openPaperIds };
    }),
  closePaperTab: (id) =>
    set((s) => {
      const idx = s.openPaperIds.indexOf(id);
      if (idx === -1) {
        // Not an open tab; still clear active selection if it pointed here
        return s.activePaperId === id
          ? { activePaperId: null, ...focusExitPatch(s) }
          : {};
      }
      const openPaperIds = s.openPaperIds.filter((x) => x !== id);
      persistOpenTabs(openPaperIds);
      const activePaperId =
        s.activePaperId === id
          ? openPaperIds[Math.min(idx, openPaperIds.length - 1)] ?? null
          : s.activePaperId;
      return {
        openPaperIds,
        activePaperId,
        ...(activePaperId === null ? focusExitPatch(s) : {}),
      };
    }),
  setSelectedProject: (id) => set({ selectedProjectId: id }),
  setKeywordFilter: (keyword) => set({ keywordFilter: keyword }),
  setScrollToAnnotation: (req) => set({ scrollToAnnotation: req }),
  requestGoTo: (paperId, page, query) => {
    get().setActivePaper(paperId);
    set({ goToRequest: { paperId, page, query } });
  },
  clearGoToRequest: () => set({ goToRequest: null }),
  openSearchOverlay: (scope) =>
    set((s) => ({
      // Document scope needs an open paper; fall back to the whole library
      searchOverlayScope: scope === "document" && !s.activePaperId ? "library" : scope,
    })),
  closeSearchOverlay: () => set({ searchOverlayScope: null }),
  setTextSize: (size) => {
    localStorage.setItem("hyji:text-size", size);
    set({ textSize: size });
  },
  setPdfTextDarkening: (v) => {
    try { localStorage.setItem("hyji:pdf-text-darkening", String(v)); } catch { /* ignore */ }
    set({ pdfTextDarkening: v });
  },
  togglePdfDarkMode: () =>
    set((s) => {
      persistPanel("hyji:pdf-dark", !s.pdfDarkMode);
      return { pdfDarkMode: !s.pdfDarkMode };
    }),
  enterFocusMode: (snapshot) =>
    set({
      focusMode: true,
      preFocusState: snapshot,
      sidebarVisible: false,
      trackerVisible: false,
    }),
  exitFocusMode: () => {
    const snap = get().preFocusState;
    const sidebarVisible = snap ? snap.sidebarOpen : get().sidebarVisible;
    const trackerVisible = snap ? snap.trackerOpen : get().trackerVisible;
    persistPanel("hyji:sidebar-visible", sidebarVisible);
    persistPanel("hyji:tracker-visible", trackerVisible);
    set({
      focusMode: false,
      preFocusState: null,
      sidebarVisible,
      trackerVisible,
    });
    return snap;
  },
}));
