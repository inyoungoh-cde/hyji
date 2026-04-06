import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { save, ask } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { usePapersStore } from "../../stores/papers";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { useDragReorder } from "../../hooks/useDragReorder";
import { generateBibTeX, papersToCsv, papersToWordRefs } from "../../lib/bibtex";
import { onMenuEvent } from "../../lib/menuEvents";
import { useKeywordsStore } from "../../stores/keywords";
import type { Paper } from "../../types";

const STATUS_OPTIONS = ["Surveyed", "Fully Reviewed", "Revisit Needed"] as const;
const IMPORTANCE_OPTIONS = ["Noted", "Potentially Relevant", "Must-Cite"] as const;

type SortKey = "manual" | "date_read" | "year" | "title" | "author" | "importance";
const IMPORTANCE_ORDER: Record<string, number> = { "Must-Cite": 0, "Potentially Relevant": 1, "Noted": 2 };

function sortPapers(papers: Paper[], sortBy: SortKey): Paper[] {
  if (sortBy === "manual") return papers;
  return [...papers].sort((a, b) => {
    switch (sortBy) {
      case "date_read": return (b.date_read || "").localeCompare(a.date_read || "");
      case "year": return (b.year ?? 0) - (a.year ?? 0);
      case "title": return a.title.localeCompare(b.title);
      case "author": return (a.first_author || a.authors).localeCompare(b.first_author || b.authors);
      case "importance": return (IMPORTANCE_ORDER[a.importance] ?? 9) - (IMPORTANCE_ORDER[b.importance] ?? 9);
      default: return 0;
    }
  });
}

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
  Surveyed: "Surveyed",
  "Fully Reviewed": "Reviewed",
  "Revisit Needed": "Revisit",
};

const IMPORTANCE_SHORT: Record<string, string> = {
  Noted: "Noted",
  "Potentially Relevant": "Relevant",
  "Must-Cite": "Must-Cite",
};

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${colorClass}`}>
      {label}
    </span>
  );
}

interface PaperContextMenu {
  x: number;
  y: number;
  paperId: string;
}

function PaperCard({
  paper,
  projectName,
  onContextMenu,
  isDragOver,
  isDragging,
  onMouseDown,
  onMouseEnter,
  draggingId,
  selectMode,
  selected,
  onToggleSelect,
}: {
  paper: Paper;
  projectName: string | null;
  onContextMenu: (e: React.MouseEvent, paperId: string) => void;
  isDragOver: boolean;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent, id: string) => void;
  onMouseEnter: (id: string) => void;
  draggingId: string | null;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const activePaperId = useUiStore((s) => s.activePaperId);
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const isActive = activePaperId === paper.id;

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect(paper.id);
    } else if (!draggingId) {
      setActivePaper(paper.id);
    }
  };

  return (
    <div
      onMouseDown={(e) => { if (!selectMode) onMouseDown(e, paper.id); }}
      onMouseEnter={() => onMouseEnter(paper.id)}
      onClick={handleClick}
      onContextMenu={(e) => { if (!selectMode) onContextMenu(e, paper.id); }}
      className={`px-3 py-2 rounded-[8px] border transition-colors duration-150 flex gap-2 items-start ${
        selectMode ? "cursor-pointer" : "cursor-grab"
      } ${
        isDragOver
          ? "border-accent bg-accent/10"
          : isDragging
            ? "opacity-50"
            : selected
              ? "bg-accent/10 border-accent/50"
              : isActive && !selectMode
                ? "bg-bg-tertiary border-accent/40"
                : "bg-transparent border-transparent hover:bg-bg-tertiary/50"
      }`}
    >
      {selectMode && (
        <div className="mt-0.5 flex-shrink-0">
          <div
            className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
              selected ? "bg-accent border-accent" : "border-border bg-bg-tertiary"
            }`}
          >
            {selected && <span className="text-[9px] text-bg-primary font-bold leading-none">✓</span>}
          </div>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-body font-medium text-text-primary truncate">{paper.title}</div>
        <div className="text-small text-text-secondary mt-0.5 truncate">
          {[paper.first_author || paper.authors, paper.year, paper.venue].filter(Boolean).join(" · ")}
        </div>
        {projectName && (
          <div className="text-[10px] text-accent/70 mt-0.5 truncate">{projectName}</div>
        )}
        <div className="flex gap-1 mt-1">
          <Badge label={paper.status} colorClass={statusColors[paper.status] ?? ""} />
          <Badge label={paper.importance} colorClass={importanceColors[paper.importance] ?? ""} />
        </div>
      </div>
    </div>
  );
}

async function saveFile(content: string, defaultName: string, filterName: string, ext: string) {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (path) await writeTextFile(path, content);
}

export function PaperList() {
  const { papers, fetchPapers, createPaper, deletePaper, updatePaper, reorderPapers } =
    usePapersStore();
  const { projects } = useProjectsStore();
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const keywordFilter = useUiStore((s) => s.keywordFilter);
  const setKeywordFilter = useUiStore((s) => s.setKeywordFilter);

  const [contextMenu, setContextMenu] = useState<PaperContextMenu | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [importanceFilter, setImportanceFilter] = useState<string | null>(null);
  const [venueFilter, setVenueFilter] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("manual");
  const [venueOpen, setVenueOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  // Virtual scroll
  const ITEM_HEIGHT = 84;
  const BUFFER = 4;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(400);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Refs so menu handlers always see current values without re-registering
  const papersRef = useRef(papers);
  const selectedIdsRef = useRef(selectedIds);
  const selectModeRef = useRef(selectMode);
  const exportingRef = useRef(exporting);
  useEffect(() => { papersRef.current = papers; }, [papers]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { selectModeRef.current = selectMode; }, [selectMode]);
  useEffect(() => { exportingRef.current = exporting; }, [exporting]);

  // Project filter
  const projectFiltered = selectedProjectId
    ? papers.filter((p) => p.project_id === selectedProjectId)
    : papers;

  // Keyword filter — get paper IDs that have the selected keyword
  const { keywords: allKeywords } = useKeywordsStore();
  const keywordPaperIds = keywordFilter
    ? new Set(allKeywords.filter((k) => k.keyword === keywordFilter).map((k) => k.paper_id))
    : null;

  // Unique venues and tasks for filter chips (from project-filtered papers)
  const uniqueVenues = [...new Set(projectFiltered.map((p) => p.venue).filter(Boolean))].sort();
  const uniqueTasks = [...new Set(projectFiltered.map((p) => p.task).filter(Boolean))].sort();

  // Search + status + importance + venue + task + keyword filter
  const filteredPapers = projectFiltered.filter((p) => {
    if (keywordPaperIds && !keywordPaperIds.has(p.id)) return false;
    if (statusFilter && p.status !== statusFilter) return false;
    if (importanceFilter && p.importance !== importanceFilter) return false;
    if (venueFilter && p.venue !== venueFilter) return false;
    if (taskFilter && p.task !== taskFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const haystack = [p.title, p.authors, p.first_author, p.venue, p.summary, p.differentiation, p.questions]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sortedPapers = sortPapers(filteredPapers, sortBy);

  const virtualRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
    const end = Math.min(sortedPapers.length, Math.ceil((scrollTop + listHeight) / ITEM_HEIGHT) + BUFFER);
    return { start, end };
  }, [scrollTop, listHeight, sortedPapers.length]);

  const getIds = useCallback(() => sortedPapers.map((p) => p.id), [sortedPapers]);
  const { dragOverId, draggingId, handleMouseDown, handleMouseEnter } =
    useDragReorder(getIds, sortBy === "manual" ? reorderPapers : async () => {});

  useEffect(() => { fetchPapers(); }, [fetchPapers]);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Menu event connections — empty deps so listeners register exactly once.
  // Current values accessed via refs to avoid stale closures.
  useEffect(() => {
    const doExport = async (
      content: (ps: typeof papers) => string,
      filename: string,
      filterName: string,
      ext: string,
    ) => {
      if (exportingRef.current) return;
      setExporting(true);
      try {
        await saveFile(content(papersRef.current), filename, filterName, ext);
      } finally {
        setExporting(false);
      }
    };

    const unsubs = [
      onMenuEvent("select-mode", () => {
        setSelectMode((s) => !s);
        setSelectedIds(new Set());
      }),
      onMenuEvent("export-selection-mode", () => {
        setSelectMode(true);
        setSelectedIds(new Set());
      }),
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
    ];
    return () => unsubs.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+Shift+F
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

  const toggleSelectMode = () => {
    setSelectMode((s) => !s);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddPaper = async () => {
    const paper = await createPaper("Untitled Paper", selectedProjectId);
    setActivePaper(paper.id);
  };

  const handleContextMenu = (e: React.MouseEvent, paperId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, paperId });
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const paper = papers.find((p) => p.id === contextMenu.paperId);
    const confirmed = await ask(
      `Delete "${paper?.title ?? "this paper"}"?\nThis cannot be undone.`,
      { title: "Delete Paper", kind: "warning" }
    );
    if (!confirmed) { setContextMenu(null); return; }
    const activePaperId = useUiStore.getState().activePaperId;
    if (activePaperId === contextMenu.paperId) setActivePaper(null);
    await deletePaper(contextMenu.paperId);
    setContextMenu(null);
  };

  const handleMoveToProject = async (projectId: string | null) => {
    if (!contextMenu) return;
    await updatePaper(contextMenu.paperId, { project_id: projectId });
    setContextMenu(null);
  };

  const handleExportBib = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const selected = papers.filter((p) => selectedIds.has(p.id));
      await saveFile(selected.map(generateBibTeX).join("\n\n"), "references.bib", "BibTeX", "bib");
    } finally { setExporting(false); }
  };

  const handleExportWordRefs = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const selected = papers.filter((p) => selectedIds.has(p.id));
      await saveFile(papersToWordRefs(selected), "references.txt", "Text", "txt");
    } finally { setExporting(false); }
  };

  const handleExportCsv = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const selected = papers.filter((p) => selectedIds.has(p.id));
      await saveFile(papersToCsv(selected), "papers.csv", "CSV", "csv");
    } finally { setExporting(false); }
  };

  const hasFilters = statusFilter || importanceFilter || venueFilter || taskFilter || searchQuery.trim() || keywordFilter;

  return (
    <div className="flex flex-col h-full">
      {/* Non-scrollable header sections */}
      <div className="shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 mt-2">
        <div className="flex items-center gap-1.5">
          <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
            Papers
          </span>
          {hasFilters && (
            <span className="text-[10px] text-accent font-medium">
              {sortedPapers.length}/{papers.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSearch((s) => !s)}
            className={`text-[12px] transition-colors ${showSearch ? "text-accent" : "text-text-tertiary hover:text-text-secondary"}`}
            title="Search papers (Ctrl+Shift+F)"
          >
            ⌕
          </button>
          <button
            onClick={toggleSelectMode}
            className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${
              selectMode ? "bg-accent text-bg-primary" : "text-text-tertiary hover:text-accent"
            }`}
            title="Select papers to export"
          >
            {selectMode ? "Done" : "Select"}
          </button>
          {!selectMode && (
            <button
              onClick={handleAddPaper}
              className="text-text-tertiary hover:text-accent text-body transition-colors"
              title="Add paper"
            >
              +
            </button>
          )}
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-3 pb-2">
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search title, authors, notes…"
            className="w-full bg-bg-tertiary border border-border rounded-[6px] px-2 py-1 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/40"
          />
        </div>
      )}

      {/* Filter chips — Status */}
      <div className="px-3 pb-1 flex gap-1 flex-wrap">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter((prev) => (prev === s ? null : s))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              statusFilter === s
                ? statusColors[s]
                : "bg-transparent text-text-tertiary border-border hover:border-accent/30 hover:text-text-secondary"
            }`}
          >
            {STATUS_SHORT[s]}
          </button>
        ))}
      </div>

      {/* Filter chips — Importance */}
      <div className="px-3 pb-2 flex gap-1 flex-wrap">
        {IMPORTANCE_OPTIONS.map((imp) => (
          <button
            key={imp}
            onClick={() => setImportanceFilter((prev) => (prev === imp ? null : imp))}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              importanceFilter === imp
                ? importanceColors[imp]
                : "bg-transparent text-text-tertiary border-border hover:border-accent/30 hover:text-text-secondary"
            }`}
          >
            {IMPORTANCE_SHORT[imp]}
          </button>
        ))}
        {hasFilters && (
          <button
            onClick={() => { setStatusFilter(null); setImportanceFilter(null); setVenueFilter(null); setTaskFilter(null); setSearchQuery(""); setKeywordFilter(null); }}
            className="px-1.5 py-0.5 rounded text-[10px] border border-transparent text-text-tertiary hover:text-accent transition-colors"
          >
            ✕ clear
          </button>
        )}
      </div>

      {/* Collapsible Venue filter */}
      {uniqueVenues.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={() => setVenueOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <span>Venues {venueFilter && <span className="text-accent normal-case font-medium">· {venueFilter}</span>}</span>
            <span className="text-[9px]">{venueOpen ? "▲" : "▼"}</span>
          </button>
          {venueOpen && (
            <div className="pb-1">
              {uniqueVenues.map((v) => (
                <button
                  key={v}
                  onClick={() => setVenueFilter((prev) => (prev === v ? null : v))}
                  className={`w-full text-left px-4 py-1 text-[11px] transition-colors ${
                    venueFilter === v
                      ? "text-accent font-medium"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {venueFilter === v && <span className="mr-1 text-[9px]">✓</span>}{v}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Task filter */}
      {uniqueTasks.length > 0 && (
        <div className="border-t border-border">
          <button
            onClick={() => setTaskOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <span>Tasks {taskFilter && <span className="text-accent normal-case font-medium">· {taskFilter}</span>}</span>
            <span className="text-[9px]">{taskOpen ? "▲" : "▼"}</span>
          </button>
          {taskOpen && (
            <div className="pb-1">
              {uniqueTasks.map((t) => (
                <button
                  key={t}
                  onClick={() => setTaskFilter((prev) => (prev === t ? null : t))}
                  className={`w-full text-left px-4 py-1 text-[11px] transition-colors ${
                    taskFilter === t
                      ? "text-accent font-medium"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {taskFilter === t && <span className="mr-1 text-[9px]">✓</span>}{t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sort bar */}
      <div className="border-t border-border px-3 py-1.5 flex items-center gap-2">
        <span className="text-[10px] text-text-tertiary font-bold uppercase tracking-wider">Sort</span>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="text-[10px] bg-bg-tertiary text-text-secondary border border-border rounded px-1.5 py-0.5 outline-none focus:border-accent/40 cursor-pointer flex-1"
        >
          <option value="manual">Manual</option>
          <option value="date_read">Date Read</option>
          <option value="year">Year</option>
          <option value="title">Title (A–Z)</option>
          <option value="author">Author (A–Z)</option>
          <option value="importance">Importance</option>
        </select>
      </div>

      {/* Select mode toolbar */}
      {selectMode && (
        <div className="px-3 pb-2 flex items-center gap-2">
          <button
            onClick={() => setSelectedIds(new Set(sortedPapers.map((p) => p.id)))}
            className="text-[10px] text-accent hover:opacity-80 transition-opacity"
          >
            All
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            None
          </button>
          <span className="text-[10px] text-text-tertiary ml-auto">{selectedIds.size} selected</span>
        </div>
      )}

      </div>{/* end shrink-0 */}

      {/* Paper list — virtual scroll */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto px-1"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {sortedPapers.length === 0 ? (
          <div className="px-3 py-4 text-small text-text-tertiary text-center">
            {hasFilters ? "No papers match." : selectedProjectId ? "No papers in this project." : "No papers yet. Click + to add one."}
          </div>
        ) : (
          <div style={{ height: sortedPapers.length * ITEM_HEIGHT, position: "relative" }}>
            <div style={{ position: "absolute", top: virtualRange.start * ITEM_HEIGHT, width: "100%" }}>
              <div className="flex flex-col gap-0.5">
                {sortedPapers.slice(virtualRange.start, virtualRange.end).map((paper) => {
                  const proj = projects.find((p) => p.id === paper.project_id);
                  return (
                    <PaperCard
                      key={paper.id}
                      paper={paper}
                      projectName={proj?.name ?? null}
                      onContextMenu={handleContextMenu}
                      isDragOver={sortBy === "manual" && dragOverId === paper.id}
                      isDragging={sortBy === "manual" && draggingId === paper.id}
                      onMouseDown={sortBy === "manual" ? handleMouseDown : () => {}}
                      onMouseEnter={sortBy === "manual" ? handleMouseEnter : () => {}}
                      draggingId={sortBy === "manual" ? draggingId : null}
                      selectMode={selectMode}
                      selected={selectedIds.has(paper.id)}
                      onToggleSelect={toggleSelect}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Export bar */}
      {selectMode && (
        <div className="shrink-0 mt-2 mx-2 border-t border-border pt-2 flex flex-col gap-1">
          {[
            { label: "Export .bib",     handler: handleExportBib },
            { label: "Word References", handler: handleExportWordRefs },
            { label: "Export CSV",      handler: handleExportCsv },
          ].map(({ label, handler }) => (
            <button
              key={label}
              onClick={handler}
              disabled={selectedIds.size === 0 || exporting}
              className="w-full flex items-center justify-between px-3 py-2 rounded-[6px] border border-border bg-bg-tertiary hover:border-accent/40 hover:bg-bg-tertiary/80 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
            >
              <span className="text-[11px] font-medium text-text-primary">{label}</span>
              <span className="text-[10px] text-text-tertiary">{selectedIds.size} papers</span>
            </button>
          ))}
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-secondary border border-border rounded-[8px] py-1 shadow-lg min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {projects.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                Move to
              </div>
              <button
                className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
                onClick={() => handleMoveToProject(null)}
              >
                No Project
              </button>
              {projects.map((proj) => (
                <button
                  key={proj.id}
                  className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
                  onClick={() => handleMoveToProject(proj.id)}
                >
                  {proj.name}
                </button>
              ))}
              <div className="border-t border-border my-1" />
            </>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-status-revisit transition-colors"
            onClick={handleDelete}
          >
            Delete Paper
          </button>
        </div>
      )}
    </div>
  );
}
