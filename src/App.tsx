import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Sidebar } from "./components/layout/Sidebar";
import { Splitter } from "./components/layout/Splitter";
import { PdfViewer } from "./components/layout/PdfViewer";
import { TrackerPanel } from "./components/layout/TrackerPanel";
import { AboutModal } from "./components/shared/AboutModal";
import { KeyboardShortcutsModal } from "./components/shared/KeyboardShortcutsModal";
import { PreferencesDialog } from "./components/shared/PreferencesDialog";
import { GlobalSearch } from "./components/shared/GlobalSearch";
import { ensureLibraryIndexed } from "./lib/ftsSearch";
import { useUiStore } from "./stores/ui";
import { usePapersStore } from "./stores/papers";
import { useProjectsStore } from "./stores/projects";
import { useKeywordsStore } from "./stores/keywords";
import { emitMenuEvent, onMenuEvent } from "./lib/menuEvents";
import { importOrOpenPdf } from "./lib/openPdf";

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 320;
const TRACKER_MIN = 280;
const TRACKER_MAX = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function App() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const {
    sidebarWidth,
    trackerWidth,
    sidebarVisible,
    trackerVisible,
    setSidebarWidth,
    setTrackerWidth,
    toggleSidebar,
    toggleTracker,
    textSize,
    setTextSize,
  } = useUiStore();

  // Apply text size class to <html> element
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("font-large", "font-xlarge");
    if (textSize === "large")  html.classList.add("font-large");
    if (textSize === "xlarge") html.classList.add("font-xlarge");
  }, [textSize]);

  // App-level data bootstrap. Panels can start hidden (viewer-only layout),
  // so loading papers/projects must never depend on Sidebar being mounted.
  useEffect(() => {
    usePapersStore.getState().fetchPapers().catch(console.error);
    useProjectsStore.getState().fetchProjects().catch(console.error);
  }, []);

  // Keywords follow the paper set: fetch + auto-extract for papers that have
  // none yet. Owned here (not in KeywordGraph) so it runs even when the
  // sidebar or the graph section is hidden.
  const papers = usePapersStore((s) => s.papers);
  const paperIdKey = papers.map((p) => p.id).join(",");
  useEffect(() => {
    const { fetchKeywords, autoExtractForPapers } = useKeywordsStore.getState();
    if (papers.length === 0) {
      fetchKeywords().catch(console.error);
      return;
    }
    fetchKeywords()
      .then(() => autoExtractForPapers(papers))
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperIdKey]);

  // Full-text search index follows the paper set too — new/changed PDFs are
  // indexed in the background a few seconds after the library settles.
  useEffect(() => {
    if (papers.length === 0) return;
    const t = setTimeout(() => {
      ensureLibraryIndexed(papers).catch((e) =>
        console.warn("[hyji fts] background indexing failed:", e)
      );
    }, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperIdKey]);

  // Menu events: toggle panels + modals + text size
  useEffect(() => {
    const unsubs = [
      onMenuEvent("toggle-sidebar", toggleSidebar),
      onMenuEvent("toggle-tracker", toggleTracker),
      onMenuEvent("about", () => setAboutOpen(true)),
      onMenuEvent("shortcuts", () => setShortcutsOpen(true)),
      onMenuEvent("preferences", () => setPreferencesOpen(true)),
      onMenuEvent("find-paper", () => setSearchOpen(true)),
      onMenuEvent("github", () => shellOpen("https://github.com/inyoungoh-cde/hyji")),
      onMenuEvent("text-size-normal", () => setTextSize("normal")),
      onMenuEvent("text-size-large",  () => setTextSize("large")),
      onMenuEvent("text-size-xlarge", () => setTextSize("xlarge")),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [toggleSidebar, toggleTracker, setTextSize]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Listen for Tauri menu events (emitted from Rust via on_menu_event)
  // Use cancelled flag to handle StrictMode double-invoke race:
  // if cleanup runs before the Promise resolves, unlisten is still null
  // and the first Tauri listener leaks — resulting in every event firing twice.
  useEffect(() => {
    // Handlers for these menu items live inside a panel component; if that
    // panel is hidden the handler is unmounted and the click would silently
    // no-op. Show the required panel first, then re-emit after it mounts.
    const PANEL_REQUIRED: Record<string, "sidebar" | "tracker"> = {
      "new-project": "sidebar",
      "selection-mode": "sidebar",
      "export-selected": "sidebar",
      "export-all": "sidebar",
      "keyword-graph": "sidebar",
      "expand-metadata": "tracker",
    };
    const dispatchMenuEvent = (id: string) => {
      const panel = PANEL_REQUIRED[id];
      const ui = useUiStore.getState();
      const hidden =
        panel === "sidebar" ? !ui.sidebarVisible :
        panel === "tracker" ? !ui.trackerVisible : false;
      if (panel && hidden) {
        if (panel === "sidebar") ui.toggleSidebar();
        else ui.toggleTracker();
        // Give React a beat to mount the panel and register its handler
        setTimeout(() => emitMenuEvent(id), 120);
        return;
      }
      emitMenuEvent(id);
    };

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("menu-event", (event) => {
      dispatchMenuEvent(event.payload);
    }).then((fn) => {
      if (cancelled) fn(); // already unmounted — unregister immediately
      else unlisten = fn;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // PDF file association + single instance. PDFs to open arrive in a Rust-side
  // queue: from argv at launch, and from second launches forwarded by the
  // single-instance plugin. Drain it on mount, and again whenever the
  // "open-pdf-external" nudge fires — the pull model means a PDF forwarded
  // before this listener registered is still picked up by the mount drain.
  useEffect(() => {
    let cancelled = false;
    const drainPendingPdfs = async () => {
      try {
        const paths = await invoke<string[]>("take_pending_open_files");
        for (const path of paths) {
          if (cancelled) return;
          await importOrOpenPdf(path);
        }
      } catch (e) {
        console.error("Failed to open pending PDF:", e);
      }
    };

    drainPendingPdfs();

    let unlisten: (() => void) | null = null;
    listen("open-pdf-external", () => { drainPendingPdfs(); })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onSidebarResize = useCallback(
    (delta: number) => {
      const current = useUiStore.getState().sidebarWidth;
      setSidebarWidth(clamp(current + delta, SIDEBAR_MIN, SIDEBAR_MAX));
    },
    [setSidebarWidth]
  );

  const onTrackerResize = useCallback(
    (delta: number) => {
      const current = useUiStore.getState().trackerWidth;
      setTrackerWidth(clamp(current + delta, TRACKER_MIN, TRACKER_MAX));
    },
    [setTrackerWidth]
  );

  return (
    <div className="h-screen flex overflow-hidden bg-bg-primary">
      {sidebarVisible && (
        <>
          <div style={{ width: sidebarWidth }} className="shrink-0 h-full overflow-hidden">
            <Sidebar />
          </div>
          <Splitter onResize={onSidebarResize} direction="left" />
        </>
      )}

      <div className="flex-1 min-w-[200px] h-full overflow-hidden">
        <PdfViewer />
      </div>

      {trackerVisible && (
        <>
          <Splitter onResize={onTrackerResize} direction="right" />
          <div style={{ width: trackerWidth }} className="shrink-0 h-full overflow-hidden">
            <TrackerPanel />
          </div>
        </>
      )}

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      <PreferencesDialog open={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
