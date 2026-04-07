import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";
import { onMenuEvent, emitMenuEvent } from "../../lib/menuEvents";
import { generateBibTeX, papersToWordRefs, papersToCsv } from "../../lib/bibtex";
import type { Paper } from "../../types";

const STATUS_OPTIONS = ["Surveyed", "Fully Reviewed", "Revisit Needed"] as const;
const IMPORTANCE_OPTIONS = ["Noted", "Potentially Relevant", "Must-Cite"] as const;

const statusColors: Record<string, string> = {
  Surveyed: "bg-[#ffd16636] text-[#ffd166] border-[#ffd16644]",
  "Fully Reviewed": "bg-[#06d6a036] text-[#06d6a0] border-[#06d6a044]",
  "Revisit Needed": "bg-[#ff6b6b36] text-[#ff6b6b] border-[#ff6b6b44]",
};
const importanceColors: Record<string, string> = {
  Noted: "bg-[#6c757d36] text-[#6c757d] border-[#6c757d44]",
  "Potentially Relevant": "bg-[#f77f0036] text-[#f77f00] border-[#f77f0044]",
  "Must-Cite": "bg-[#d6282836] text-[#d62828] border-[#d6282844]",
};
const STATUS_SHORT: Record<string, string> = {
  Surveyed: "Srvy", "Fully Reviewed": "Rev", "Revisit Needed": "Rev!",
};
const IMPORTANCE_SHORT: Record<string, string> = {
  Noted: "Ntd", "Potentially Relevant": "Rel", "Must-Cite": "Must",
};

interface PaperControlsProps {
  statusFilter: string | null;
  onStatusFilter: (v: string | null) => void;
  importanceFilter: string | null;
  onImportanceFilter: (v: string | null) => void;
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

async function saveFile(content: string, defaultName: string, filterName: string, ext: string) {
  const path = await save({ defaultPath: defaultName, filters: [{ name: filterName, extensions: [ext] }] });
  if (path) await writeTextFile(path, content);
}

export function PaperControls({
  statusFilter, onStatusFilter,
  importanceFilter, onImportanceFilter,
  sortBy, onSortBy,
  selectMode, onSelectMode,
  selectedIds, onSelectAll, onSelectNone,
  searchQuery, onSearchQuery,
}: PaperControlsProps) {
  const { papers, createPaper, deletePaper } = usePapersStore();
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);

  const [showSearch, setShowSearch] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(exporting);
  const papersRef = useRef(papers);
  useEffect(() => { exportingRef.current = exporting; }, [exporting]);
  useEffect(() => { papersRef.current = papers; }, [papers]);

  const hasFilters = statusFilter || importanceFilter || searchQuery.trim();

  const handleAddPaper = async () => {
    const paper = await createPaper("Untitled Paper", selectedProjectId);
    setActivePaper(paper.id);
  };

  const doExport = async (
    content: (ps: Paper[]) => string,
    filename: string,
    filterName: string,
    ext: string
  ) => {
    if (exportingRef.current) return;
    setExporting(true);
    try {
      const selected = selectedIds.size > 0
        ? papersRef.current.filter((p) => selectedIds.has(p.id))
        : papersRef.current;
      await saveFile(content(selected), filename, filterName, ext);
    } finally {
      setExporting(false);
    }
  };

  // Menu event connections
  useEffect(() => {
    const unsubs = [
      onMenuEvent("select-mode", () => onSelectMode(!selectMode)),
      onMenuEvent("export-selection-mode", () => onSelectMode(true)),
      onMenuEvent("export-all-bib", () =>
        doExport((ps) => ps.map(generateBibTeX).join("\n\n"), "references.bib", "BibTeX", "bib")
      ),
      onMenuEvent("export-all-word", () =>
        doExport((ps) => papersToWordRefs(ps), "references.txt", "Text", "txt")
      ),
      onMenuEvent("export-all-csv", () =>
        doExport((ps) => papersToCsv(ps), "papers.csv", "CSV", "csv")
      ),
      onMenuEvent("find-paper", () => setShowSearch((s) => !s)),
      onMenuEvent("delete-paper", async () => {
        const id = useUiStore.getState().activePaperId;
        if (!id) return;
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const paper = papersRef.current.find((p) => p.id === id);
        const confirmed = await ask(
          `Delete "${paper?.title ?? "this paper"}"?\nThis cannot be undone.`,
          { title: "Delete Paper", kind: "warning" }
        );
        if (confirmed) {
          setActivePaper(null);
          deletePaper(id);
        }
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setShowSearch((s) => !s);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex flex-col">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
          Papers
        </span>
        <div className="flex items-center gap-1.5">
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
          {!selectMode && (
            <button
              onClick={() => emitMenuEvent("import-pdf")}
              className="text-text-tertiary hover:text-accent transition-colors"
              title="Import PDF (Ctrl+O)"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 11h9M6.5 2v7M6.5 9l-2.5-2.5M6.5 9l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {!selectMode && (
            <button
              onClick={handleAddPaper}
              className="text-text-tertiary hover:text-accent text-body transition-colors"
              title="New blank paper"
            >
              +
            </button>
          )}
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

      {/* Filter chips + Sort — single compact row */}
      <div className="px-2 pb-1.5 flex flex-wrap gap-0.5 items-center">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onStatusFilter(statusFilter === s ? null : s)}
            className={`px-1 py-0.5 rounded text-caption font-bold border transition-colors ${
              statusFilter === s
                ? statusColors[s]
                : "bg-transparent text-text-tertiary border-transparent hover:border-border hover:text-text-secondary"
            }`}
          >
            {STATUS_SHORT[s]}
          </button>
        ))}
        <span className="text-border mx-0.5">|</span>
        {IMPORTANCE_OPTIONS.map((imp) => (
          <button
            key={imp}
            onClick={() => onImportanceFilter(importanceFilter === imp ? null : imp)}
            className={`px-1 py-0.5 rounded text-caption font-bold border transition-colors ${
              importanceFilter === imp
                ? importanceColors[imp]
                : "bg-transparent text-text-tertiary border-transparent hover:border-border hover:text-text-secondary"
            }`}
          >
            {IMPORTANCE_SHORT[imp]}
          </button>
        ))}
        {hasFilters && (
          <button
            onClick={() => { onStatusFilter(null); onImportanceFilter(null); onSearchQuery(""); }}
            className="px-1 py-0.5 rounded text-caption border-transparent text-text-tertiary hover:text-accent transition-colors ml-0.5"
          >
            ✕
          </button>
        )}
        <div className="flex-1" />
        <select
          value={sortBy}
          onChange={(e) => onSortBy(e.target.value)}
          className="text-caption bg-bg-tertiary text-text-secondary border border-border rounded px-1 py-0.5 outline-none focus:border-accent/40 cursor-pointer"
        >
          <option value="manual">Order</option>
          <option value="date_read">Date</option>
          <option value="year">Year</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
          <option value="importance">Importance</option>
        </select>
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

      {/* Export buttons in select mode */}
      {selectMode && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {[
            { label: "Export .bib", fn: () => doExport((ps) => ps.map(generateBibTeX).join("\n\n"), "references.bib", "BibTeX", "bib") },
            { label: "Word Refs",   fn: () => doExport((ps) => papersToWordRefs(ps), "references.txt", "Text", "txt") },
            { label: "CSV",         fn: () => doExport((ps) => papersToCsv(ps), "papers.csv", "CSV", "csv") },
          ].map(({ label, fn }) => (
            <button
              key={label}
              onClick={fn}
              disabled={exporting}
              className="w-full flex items-center justify-between px-2 py-1 rounded-[5px] border border-border bg-bg-tertiary hover:border-accent/40 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
            >
              <span className="text-caption font-medium text-text-primary">{label}</span>
              <span className="text-caption text-text-tertiary">
                {selectedIds.size > 0 ? `${selectedIds.size}` : "all"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
