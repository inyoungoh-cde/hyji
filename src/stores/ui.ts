import { create } from "zustand";

interface UiState {
  sidebarWidth: number;
  trackerWidth: number;
  sidebarVisible: boolean;
  trackerVisible: boolean;
  activePaperId: string | null;
  selectedProjectId: string | null;
  keywordFilter: string | null;
  scrollToAnnotation: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null;

  setSidebarWidth: (w: number) => void;
  setTrackerWidth: (w: number) => void;
  toggleSidebar: () => void;
  toggleTracker: () => void;
  setActivePaper: (id: string | null) => void;
  setSelectedProject: (id: string | null) => void;
  setKeywordFilter: (keyword: string | null) => void;
  setScrollToAnnotation: (req: { page: number; selectedText: string; noteField?: string; rects_json?: string } | null) => void;
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

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: loadNumber("hyji:sidebar-width", SIDEBAR_DEFAULT),
  trackerWidth: loadNumber("hyji:tracker-width", TRACKER_DEFAULT),
  sidebarVisible: true,
  trackerVisible: true,
  activePaperId: null,
  selectedProjectId: null,
  keywordFilter: null,
  scrollToAnnotation: null,

  setSidebarWidth: (w) => {
    localStorage.setItem("hyji:sidebar-width", String(w));
    set({ sidebarWidth: w });
  },
  setTrackerWidth: (w) => {
    localStorage.setItem("hyji:tracker-width", String(w));
    set({ trackerWidth: w });
  },
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleTracker: () => set((s) => ({ trackerVisible: !s.trackerVisible })),
  setActivePaper: (id) => set({ activePaperId: id }),
  setSelectedProject: (id) => set({ selectedProjectId: id }),
  setKeywordFilter: (keyword) => set({ keywordFilter: keyword }),
  setScrollToAnnotation: (req) => set({ scrollToAnnotation: req }),
}));
