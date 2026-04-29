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
import { useUiStore } from "./stores/ui";
import { usePapersStore } from "./stores/papers";
import { emitMenuEvent, onMenuEvent } from "./lib/menuEvents";
import { extractPdfMeta } from "./lib/pdfMeta";

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

  // Menu events: toggle panels + modals + text size
  useEffect(() => {
    const unsubs = [
      onMenuEvent("toggle-sidebar", toggleSidebar),
      onMenuEvent("toggle-tracker", toggleTracker),
      onMenuEvent("about", () => setAboutOpen(true)),
      onMenuEvent("shortcuts", () => setShortcutsOpen(true)),
      onMenuEvent("preferences", () => setPreferencesOpen(true)),
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
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Listen for Tauri menu events (emitted from Rust via on_menu_event)
  // Use cancelled flag to handle StrictMode double-invoke race:
  // if cleanup runs before the Promise resolves, unlisten is still null
  // and the first Tauri listener leaks — resulting in every event firing twice.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("menu-event", (event) => {
      emitMenuEvent(event.payload);
    }).then((fn) => {
      if (cancelled) fn(); // already unmounted — unregister immediately
      else unlisten = fn;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // PDF file association: if HYJI was launched with a .pdf path
  // (e.g. double-clicked in Explorer), import it as an unassigned
  // paper and open it. Runs once per launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const path = await invoke<string | null>("take_pending_open_file");
        if (cancelled || !path) return;
        const meta = await extractPdfMeta(path).catch(() => ({ title: "" }));
        const filename = path.split(/[/\\]/).pop() ?? "Untitled";
        const title = meta.title || filename.replace(/\.pdf$/i, "");
        const paper = await usePapersStore.getState().createPaper(title, null, path, "link");
        if (!cancelled) useUiStore.getState().setActivePaper(paper.id);
      } catch (e) {
        console.error("Failed to open associated PDF:", e);
      }
    })();
    return () => { cancelled = true; };
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
    </div>
  );
}
