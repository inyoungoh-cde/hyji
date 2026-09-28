import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePapersStore } from "../../stores/papers";
import { onMenuEvent } from "../../lib/menuEvents";
import { ExportDialog } from "../shared/ExportDialog";
import type { Paper, Level } from "../../types";
import { LEVELS } from "../../types";
import { LEVEL_COLOR, LEVEL_HINT, REVISIT_COLOR, REVISIT_HINT, levelStars } from "../../lib/level";

interface PaperControlsProps {
  levelFilter: Level | null;
  onLevelFilter: (v: Level | null) => void;
  revisitOnly: boolean;
  onRevisitOnly: (v: boolean) => void;
  sortBy: string;
  onSortBy: (v: string) => void;
  selectMode: boolean;
  onSelectMode: (v: boolean) => void;
  selectedIds: Set<string>;
  onSelectAll: (ids: string[]) => void;
  onSelectNone: () => void;
  searchQuery: string;
  onSearchQuery: (v: string) => void;
}

export function PaperControls({
  levelFilter, onLevelFilter,
  revisitOnly, onRevisitOnly,
  sortBy, onSortBy,
  selectMode, onSelectMode,
  selectedIds, onSelectAll, onSelectNone,
  searchQuery, onSearchQuery,
}: PaperControlsProps) {
  const { papers } = usePapersStore();
  const [showSearch, setShowSearch] = useState(false);
  const [exportPapers, setExportPapers] = useState<Paper[] | null>(null);
  const papersRef = useRef(papers);
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { papersRef.current = papers; }, [papers]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);

  const hasFilters = levelFilter || revisitOnly || searchQuery.trim();

  const openExportDialog = (papersToExport: Paper[]) => {
    if (papersToExport.length === 0) return;
    setExportPapers(papersToExport);
  };

  const handleExportSelected = async () => {
    const ids = selectedIdsRef.current;
    const selected = papersRef.current.filter((p) => ids.has(p.id));
    if (selected.length === 0) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(
        "No papers selected. Ctrl+click / Shift+click papers in the sidebar, or turn on Selection Mode (Ctrl+Shift+S) and check the papers you want to export.",
        { title: "Export Selected", kind: "info" }
      );
      return;
    }
    openExportDialog(selected);
  };

  const handleExportAll = () => {
    if (papersRef.current.length === 0) return;
    openExportDialog(papersRef.current);
  };

  // Menu event connections
  useEffect(() => {
    const unsubs = [
      onMenuEvent("selection-mode", () => onSelectMode(!selectMode)),
      onMenuEvent("export-selected", handleExportSelected),
      onMenuEvent("export-all", handleExportAll),
      // NOTE: "find-paper" opens the global search overlay (App.tsx) as of
      // v1.0.4; the sidebar filter stays reachable via the ⌕ button.
      // "delete-paper" is handled in PdfViewer (which also closes the tab).
    ];
    return () => unsubs.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode]);

  // Ctrl+Shift+S to toggle selection mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        onSelectMode(!selectMode);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectMode, onSelectMode]);

  // Ctrl+Shift+F is owned by the global search overlay (App.tsx).

  // Gray out File > Export Selected... while nothing is selected. Ctrl/Shift
  // click selections count too, not only checkbox (select-mode) ones.
  // Disabled on unmount too: with the sidebar hidden there is no selection.
  useEffect(() => {
    const enabled = selectedIds.size > 0;
    invoke("set_export_selected_enabled", { enabled }).catch(() => undefined);
  }, [selectMode, selectedIds]);
  useEffect(() => () => {
    invoke("set_export_selected_enabled", { enabled: false }).catch(() => undefined);
  }, []);

  return (
    <div className="flex flex-col">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
          Papers
        </span>
        <div className="flex items-center gap-1.5">
          {/* Sort lives in the header so the chip row below never wraps at
              the narrowest sidebar width (a wrapped row moved the chips
              and made the ✕ / ⚑ land on the wrong line). */}
          <select
            value={sortBy}
            onChange={(e) => onSortBy(e.target.value)}
            className="text-caption bg-bg-tertiary text-text-secondary border border-border rounded px-1 py-0 outline-none focus:border-accent/40 cursor-pointer max-w-[72px]"
            title="Sort papers"
          >
            <option value="manual">Order</option>
            <option value="date_read">Date</option>
            <option value="year">Year</option>
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="level">Level ★</option>
            <option value="revisit">Revisit ⚑</option>
          </select>
          <button
            onClick={() => setShowSearch((s) => !s)}
            className={`text-section transition-colors ${showSearch ? "text-accent" : "text-text-tertiary hover:text-text-secondary"}`}
            title="Search papers (Ctrl+Shift+F)"
          >
            ⌕
          </button>
          <button
            onClick={() => { onSelectMode(!selectMode); }}
            className={`text-caption font-bold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${
              selectMode ? "bg-accent text-bg-primary" : "text-text-tertiary hover:text-accent"
            }`}
            title="Select mode for export"
          >
            {selectMode ? "Done" : "Sel"}
          </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-3 pb-1.5">
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchQuery(e.target.value)}
            placeholder="Search papers…"
            className="w-full bg-bg-tertiary border border-border rounded-[6px] px-2 py-0.5 text-small text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/40"
          />
        </div>
      )}

      {/* Filter chips (★ level, ⚑ revisit — same glyphs as the rows) */}
      <div className="px-2 pb-1.5 flex flex-nowrap gap-0.5 items-center">
        {LEVELS.map((lv) => {
          const active = levelFilter === lv;
          const c = LEVEL_COLOR[lv];
          return (
            <button
              key={lv}
              onClick={() => onLevelFilter(active ? null : lv)}
              title={`${LEVEL_HINT[lv]} — click to filter`}
              className={`px-1 py-0.5 rounded text-caption font-bold border transition-colors tracking-tighter ${
                active ? "" : "bg-transparent text-text-tertiary border-transparent hover:border-border hover:text-text-secondary"
              }`}
              style={active ? { color: c, background: `${c}36`, borderColor: `${c}44` } : undefined}
            >
              {levelStars(lv)}
            </button>
          );
        })}
        <span className="text-border mx-0.5">|</span>
        <button
          onClick={() => onRevisitOnly(!revisitOnly)}
          title={`${REVISIT_HINT} — click to show flagged papers only`}
          className={`px-1 py-0.5 rounded text-caption font-bold border transition-colors ${
            revisitOnly ? "" : "bg-transparent text-text-tertiary border-transparent hover:border-border hover:text-text-secondary"
          }`}
          style={revisitOnly ? { color: REVISIT_COLOR, background: `${REVISIT_COLOR}36`, borderColor: `${REVISIT_COLOR}44` } : undefined}
        >
          ⚑
        </button>
        {hasFilters && (
          <button
            onClick={() => { onLevelFilter(null); onRevisitOnly(false); onSearchQuery(""); }}
            className="px-1 py-0.5 rounded text-caption border-transparent text-text-tertiary hover:text-accent transition-colors ml-0.5"
            title="Clear filters"
          >
            ✕
          </button>
        )}
      </div>

      {/* Select mode toolbar */}
      {selectMode && (
        <div className="px-3 pb-1.5 flex items-center gap-2 border-t border-border pt-1.5">
          <button
            onClick={() => onSelectAll(papers.map((p) => p.id))}
            className="text-caption text-accent hover:opacity-80"
          >
            All
          </button>
          <button
            onClick={onSelectNone}
            className="text-caption text-text-tertiary hover:text-text-secondary"
          >
            None
          </button>
          <span className="text-caption text-text-tertiary ml-auto">{selectedIds.size} selected</span>
        </div>
      )}

      {/* Export button in select mode — opens the export dialog */}
      {selectMode && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          <button
            onClick={handleExportSelected}
            disabled={selectedIds.size === 0}
            className="w-full flex items-center justify-between px-2 py-1 rounded-[5px] border border-accent/40 bg-accent/10 hover:bg-accent/20 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <span className="text-caption font-medium text-accent">Export Selected…</span>
            <span className="text-caption text-text-tertiary">{selectedIds.size}</span>
          </button>
        </div>
      )}

      {exportPapers && (
        <ExportDialog
          papers={exportPapers}
          onClose={() => setExportPapers(null)}
        />
      )}
    </div>
  );
}
