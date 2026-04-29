import { create } from "zustand";

export type TextSize = "normal" | "large" | "xlarge";

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
  selectedProjectId: string | null;
  keywordFilter: string | null;
  scrollToAnnotation: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null;
  textSize: TextSize;
  focusMode: boolean;
  preFocusState: PreFocusState | null;

  setSidebarWidth: (w: number) => void;
  setTrackerWidth: (w: number) => void;
  toggleSidebar: () => void;
  toggleTracker: () => void;
  setActivePaper: (id: string | null) => void;
  setSelectedProject: (id: string | null) => void;
  setKeywordFilter: (keyword: string | null) => void;
  setScrollToAnnotation: (req: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null) => void;
  setTextSize: (size: TextSize) => void;
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

function loadTextSize(): TextSize {
  try {
    const v = localStorage.getItem("hyji:text-size");
    if (v === "large" || v === "xlarge") return v;
  } catch { /* ignore */ }
  return "normal";
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarWidth: loadNumber("hyji:sidebar-width", SIDEBAR_DEFAULT),
  trackerWidth: loadNumber("hyji:tracker-width", TRACKER_DEFAULT),
  sidebarVisible: true,
  trackerVisible: true,
  activePaperId: null,
  selectedProjectId: null,
  keywordFilter: null,
  scrollToAnnotation: null,
  textSize: loadTextSize(),
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
    set((s) => ({
      sidebarVisible: !s.sidebarVisible,
      // Manual sidebar toggle while focused -> drop focus mode
      focusMode: s.focusMode ? false : s.focusMode,
      preFocusState: s.focusMode ? null : s.preFocusState,
    })),
  toggleTracker: () =>
    set((s) => ({
      trackerVisible: !s.trackerVisible,
      focusMode: s.focusMode ? false : s.focusMode,
      preFocusState: s.focusMode ? null : s.preFocusState,
    })),
  setActivePaper: (id) => set({ activePaperId: id }),
  setSelectedProject: (id) => set({ selectedProjectId: id }),
  setKeywordFilter: (keyword) => set({ keywordFilter: keyword }),
  setScrollToAnnotation: (req) => set({ scrollToAnnotation: req }),
  setTextSize: (size) => {
    localStorage.setItem("hyji:text-size", size);
    set({ textSize: size });
  },
  enterFocusMode: (snapshot) =>
    set({
      focusMode: true,
      preFocusState: snapshot,
      sidebarVisible: false,
      trackerVisible: false,
    }),
  exitFocusMode: () => {
    const snap = get().preFocusState;
    set({
      focusMode: false,
      preFocusState: null,
      sidebarVisible: snap ? snap.sidebarOpen : get().sidebarVisible,
      trackerVisible: snap ? snap.trackerOpen : get().trackerVisible,
    });
    return snap;
  },
}));
