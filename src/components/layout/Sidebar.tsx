import { useState, useEffect } from "react";
import { ProjectTree } from "../sidebar/ProjectTree";
import { PaperControls } from "../sidebar/PaperControls";
import { KeywordGraph } from "../sidebar/KeywordGraph";
import { KeywordGraphFullscreen } from "../sidebar/KeywordGraphFullscreen";
import { onMenuEvent } from "../../lib/menuEvents";

export function Sidebar() {
  const [graphVisible, setGraphVisible] = useState(true);
  const [graphFullscreen, setGraphFullscreen] = useState(false);

  // Shared filter/sort/select state — passed to both ProjectTree and PaperControls
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [importanceFilter, setImportanceFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState("manual");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    const unsub = onMenuEvent("keyword-graph", () => setGraphFullscreen(true));
    return unsub;
  }, []);

  // ESC exits select mode
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectMode]);

  return (
    <>
      <div className="h-full flex flex-col bg-bg-secondary overflow-hidden">

        {/* ── PROJECTS — takes maximum space ── */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ProjectTree
            statusFilter={statusFilter}
            importanceFilter={importanceFilter}
            sortBy={sortBy}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            searchQuery={searchQuery}
          />
        </div>

        <div className="border-t border-border" />

        {/* ── PAPERS filter/sort — compact bottom controls ── */}
        <div className="shrink-0">
          <PaperControls
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            importanceFilter={importanceFilter}
            onImportanceFilter={setImportanceFilter}
            sortBy={sortBy}
            onSortBy={setSortBy}
            selectMode={selectMode}
            onSelectMode={(mode) => { setSelectMode(mode); if (!mode) setSelectedIds(new Set()); }}
            selectedIds={selectedIds}
            onSelectAll={(ids) => setSelectedIds(new Set(ids))}
            onSelectNone={() => setSelectedIds(new Set())}
            searchQuery={searchQuery}
            onSearchQuery={setSearchQuery}
          />
        </div>

        {/* ── KEYWORD GRAPH — very bottom ── */}
        <div className="border-t border-border p-3 shrink-0">
          <div className="flex items-center justify-between w-full">
            <button
              onClick={() => setGraphVisible((v) => !v)}
              className="flex items-center gap-1.5 group flex-1"
            >
              <span className="text-section font-bold uppercase tracking-wider text-text-tertiary group-hover:text-text-secondary transition-colors">
                Keyword Graph
              </span>
              <span className="text-[10px] text-text-tertiary group-hover:text-text-secondary transition-colors">
                {graphVisible ? "▾" : "▸"}
              </span>
            </button>
            <button
              onClick={() => setGraphFullscreen(true)}
              className="text-[11px] text-text-tertiary hover:text-accent transition-colors px-1 py-0.5 rounded hover:bg-bg-tertiary"
              title="Expand full-screen"
            >
              ⤢
            </button>
          </div>
          {graphVisible && <KeywordGraph />}
        </div>
      </div>

      {graphFullscreen && (
        <KeywordGraphFullscreen onClose={() => setGraphFullscreen(false)} />
      )}
    </>
  );
}
