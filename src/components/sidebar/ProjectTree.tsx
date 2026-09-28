import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, Fragment } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useProjectsStore } from "../../stores/projects";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";
import { useDragReorder } from "../../hooks/useDragReorder";
import { usePaperDrag, PAPER_DRAG_UNASSIGNED, SWIPE_MAX } from "../../hooks/usePaperDrag";
import { onMenuEvent, emitMenuEvent } from "../../lib/menuEvents";
import type { Project, Paper } from "../../types";

const IMPORTANCE_ORDER: Record<string, number> = { "Must-Cite": 0, "Potentially Relevant": 1, "Noted": 2 };

function sortPapers(papers: Paper[], sortBy: string): Paper[] {
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

const statusDot: Record<string, string> = {
  Surveyed: "text-[#ffd166]",
  "Fully Reviewed": "text-[#06d6a0]",
  "Revisit Needed": "text-[#ff6b6b]",
};
const statusHex: Record<string, string> = {
  Surveyed: "#ffd166",
  "Fully Reviewed": "#06d6a0",
  "Revisit Needed": "#ff6b6b",
};
const STATUS_CYCLE: Paper["status"][] = ["Surveyed", "Fully Reviewed", "Revisit Needed"];
const nextStatus = (s: string): Paper["status"] =>
  STATUS_CYCLE[(STATUS_CYCLE.indexOf(s as Paper["status"]) + 1) % STATUS_CYCLE.length];

// Swipe geometry (px): the delete button revealed on a left swipe, the
// travel past which a release commits the action, and the full-swipe point
// where the delete confirmation opens without a second click.
const SWIPE_REVEAL = 64;
const SWIPE_ACT = 72;
const SWIPE_FULL = SWIPE_MAX - 12;

const UNASSIGNED_TARGET = PAPER_DRAG_UNASSIGNED;

interface ProjectTreeProps {
  statusFilter: string | null;
  importanceFilter: string | null;
  sortBy: string;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSetSelection: (ids: Set<string>) => void;
  searchQuery: string;
}

interface PaperContextMenu {
  x: number;
  y: number;
  paperId: string;
  /** The paper(s) the menu acts on: the whole selection when the clicked
   *  paper is part of it, otherwise just the clicked paper. */
  targetIds: string[];
}

type FlatRow =
  | { kind: "all-papers"; count: number }
  | { kind: "project"; project: Project; depth: number; isCollapsed: boolean; hasPapersOrChildren: boolean; paperCount: number; isPaperDropTarget: boolean }
  | { kind: "paper"; paper: Paper; indent: number }
  | { kind: "unassigned-header"; isDropTarget: boolean };

export function ProjectTree({
  statusFilter,
  importanceFilter,
  sortBy,
  selectMode,
  selectedIds,
  onToggleSelect,
  onSetSelection,
  searchQuery,
}: ProjectTreeProps) {
  const { projects, fetchProjects, createProject, renameProject, deleteProject, reorderProjects, setProjectFolder } =
    useProjectsStore();
  const { papers, fetchPapers, updatePaper, deletePapers, movePapers } = usePapersStore();
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const setSelectedProject = useUiStore((s) => s.setSelectedProject);
  const activePaperId = useUiStore((s) => s.activePaperId);
  const setActivePaper = useUiStore((s) => s.setActivePaper);

  // Project editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectId: string | null } | null>(null);

  // Paper editing
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [editPaperTitle, setEditPaperTitle] = useState("");
  const [paperContextMenu, setPaperContextMenu] = useState<PaperContextMenu | null>(null);

  // Row left swiped open, delete button showing (iOS-list style)
  const [swipeOpenId, setSwipeOpenId] = useState<string | null>(null);

  // Collapse state
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  // Selection helpers: the latest selection for stable callbacks, and the
  // anchor row for Shift+click ranges.
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const selectionAnchorRef = useRef<string | null>(null);

  // Paper drag (mouse-event based): vertical = move to folder, horizontal = swipe
  const { draggingPaperId, paperDropTarget, ghostPos, swipe, onPaperMouseDown, onDropZoneEnter, consumeGestureClick } =
    usePaperDrag(
      useCallback((paperId, projectId) => {
        // Dragging a selected paper carries the whole selection along.
        const sel = selectedIdsRef.current;
        movePapers(sel.has(paperId) ? [...sel] : [paperId], projectId);
      }, [movePapers]),
      (paperId, dx) => handleSwipeEnd(paperId, dx)
    );

  // Track last sidebar click to resolve F2 target (project vs paper)
  const lastSidebarClickRef = useRef<{ type: "project" | "paper"; id: string } | null>(null);

  const projectInputRef = useRef<HTMLInputElement>(null);
  const paperInputRef = useRef<HTMLInputElement>(null);

  const rootProjects = projects.filter((p) => !p.parent_id);
  const getIds = useCallback(() => rootProjects.map((p) => p.id), [rootProjects]);
  const { dragOverId, draggingId, handleMouseDown, handleMouseEnter } =
    useDragReorder(getIds, reorderProjects);

  useEffect(() => { fetchProjects(); fetchPapers(); }, [fetchProjects, fetchPapers]);

  useEffect(() => {
    return onMenuEvent("new-project", async () => {
      const { createProject: cp } = useProjectsStore.getState();
      const project = await cp("New Folder", null);
      setEditingId(project.id);
      setEditName(project.name);
    });
  }, []);

  // F2 key — rename whichever sidebar item was clicked last (project or paper)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      const last = lastSidebarClickRef.current;
      if (!last) return;
      e.preventDefault();
      if (last.type === "paper") {
        const paper = usePapersStore.getState().papers.find((p) => p.id === last.id);
        if (paper) { setEditingPaperId(last.id); setEditPaperTitle(paper.title); }
      } else {
        const project = useProjectsStore.getState().projects.find((p) => p.id === last.id);
        if (project) { setEditingId(last.id); setEditName(project.name); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (editingId && projectInputRef.current) {
      projectInputRef.current.focus();
      projectInputRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    if (editingPaperId && paperInputRef.current) {
      paperInputRef.current.focus();
      paperInputRef.current.select();
    }
  }, [editingPaperId]);

  useEffect(() => {
    const handler = () => {
      setProjectContextMenu(null);
      setPaperContextMenu(null);
      setSwipeOpenId(null);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // ── Project handlers ──

  const handleProjectContextMenu = (e: React.MouseEvent, projectId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setPaperContextMenu(null);
    setProjectContextMenu({ x: e.clientX, y: e.clientY, projectId });
  };

  const handleNewFolder = async (parentId: string | null) => {
    setProjectContextMenu(null);
    const project = await createProject("New Folder", parentId);
    setEditingId(project.id);
    setEditName(project.name);
  };

  const handleRenameProject = (project: Project) => {
    setProjectContextMenu(null);
    setEditingId(project.id);
    setEditName(project.name);
  };

  const handleDeleteProject = async (id: string) => {
    setProjectContextMenu(null);
    if (selectedProjectId === id) setSelectedProject(null);
    await deleteProject(id);
  };

  const handleSetFolder = async (projectId: string) => {
    setProjectContextMenu(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "Select PDF storage folder" });
    if (selected && typeof selected === "string") {
      await setProjectFolder(projectId, selected);
    }
  };

  const commitProjectRename = async () => {
    if (editingId && editName.trim()) {
      await renameProject(editingId, editName.trim());
    }
    setEditingId(null);
  };

  // ── Paper handlers ──

  const startPaperRename = (paper: Paper) => {
    setPaperContextMenu(null);
    setEditingPaperId(paper.id);
    setEditPaperTitle(paper.title);
  };

  const commitPaperRename = async () => {
    if (editingPaperId && editPaperTitle.trim()) {
      await updatePaper(editingPaperId, { title: editPaperTitle.trim() });
    }
    setEditingPaperId(null);
  };

  const handlePaperContextMenu = (e: React.MouseEvent, paperId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectContextMenu(null);
    setSwipeOpenId(null);
    const targetIds = selectedIds.has(paperId) ? [...selectedIds] : [paperId];
    setPaperContextMenu({ x: e.clientX, y: e.clientY, paperId, targetIds });
  };

  const handleMovePapers = async (ids: string[], projectId: string | null) => {
    setPaperContextMenu(null);
    await movePapers(ids, projectId);
    if (ids.length > 1) onSetSelection(new Set());
  };

  const handleDeletePapers = useCallback(async (ids: string[]) => {
    setPaperContextMenu(null);
    const targets = ids
      .map((id) => papers.find((p) => p.id === id))
      .filter((p): p is Paper => !!p);
    if (targets.length === 0) return;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const one = targets.length === 1;
    const list = targets.slice(0, 5).map((p) => `• ${p.title}`).join("\n")
      + (targets.length > 5 ? `\n… and ${targets.length - 5} more` : "");
    const confirmed = await ask(
      one
        ? `Delete "${targets[0].title}"?\n\nAll notes, highlights, and memos will be permanently removed. The PDF file itself will not be deleted.\n\nThis cannot be undone.`
        : `Delete ${targets.length} papers?\n\n${list}\n\nAll their notes, highlights, and memos will be permanently removed. The PDF files themselves will not be deleted.\n\nThis cannot be undone.`,
      { title: one ? "Delete Paper" : `Delete ${targets.length} Papers`, kind: "warning" }
    );
    if (!confirmed) return;
    const ui = useUiStore.getState();
    for (const p of targets) ui.closePaperTab(p.id);
    await deletePapers(targets.map((p) => p.id));
    onSetSelection(new Set());
  }, [papers, deletePapers, onSetSelection]);

  // Swipe release: far left → delete (confirmation opens directly); part way
  // left → leave the delete button showing; right → advance reading status.
  const handleSwipeEnd = (paperId: string, dx: number) => {
    if (dx <= -SWIPE_FULL) {
      setSwipeOpenId(null);
      handleDeletePapers([paperId]);
      return;
    }
    if (dx <= -SWIPE_REVEAL * 0.6) {
      setSwipeOpenId(paperId);
      return;
    }
    setSwipeOpenId(null);
    if (dx >= SWIPE_ACT) {
      const paper = papers.find((p) => p.id === paperId);
      if (paper) updatePaper(paper.id, { status: nextStatus(paper.status) });
    }
  };

  // Delete removes the multi-selection; Escape clears it (select-mode's own
  // Escape lives in Sidebar) and closes a swiped-open row.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        if (swipeOpenId) setSwipeOpenId(null);
        if (!selectMode && !typing && selectedIds.size > 0) onSetSelection(new Set());
        return;
      }
      if (e.key === "Delete" && !typing && selectedIds.size > 0) {
        e.preventDefault();
        handleDeletePapers([...selectedIds]);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedIds, selectMode, swipeOpenId, onSetSelection, handleDeletePapers]);

  // ── Collapse ──

  const toggleCollapse = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // ── Filter + sort ──

  const getFilteredPapers = useCallback((paperList: Paper[]) => {
    return sortPapers(
      paperList.filter((p) => {
        if (statusFilter && p.status !== statusFilter) return false;
        if (importanceFilter && p.importance !== importanceFilter) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const hay = [p.title, p.authors, p.first_author, p.venue, p.summary].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
      sortBy
    );
  }, [statusFilter, importanceFilter, sortBy, searchQuery]);

  // (Project rendering is now handled inline via flatRows virtualization)

  const unassignedPapers = getFilteredPapers(papers.filter((p) => !p.project_id));
  const allFilteredCount = getFilteredPapers(papers).length;
  const isUnassignedDropTarget = paperDropTarget === UNASSIGNED_TARGET;

  // ── Flatten tree into a single row list for virtualization ──

  const flatRows = useMemo(() => {
    const rows: FlatRow[] = [];

    // "All Papers" row
    rows.push({ kind: "all-papers", count: allFilteredCount });

    // Recursive project flattening
    const flattenProject = (project: Project, depth: number) => {
      const children = projects.filter((p) => p.parent_id === project.id);
      const projectPapers = getFilteredPapers(papers.filter((p) => p.project_id === project.id));
      const isCollapsed = collapsedProjects.has(project.id);
      const hasPapersOrChildren = projectPapers.length > 0 || children.length > 0;
      const isPDT = paperDropTarget === project.id;

      rows.push({
        kind: "project",
        project,
        depth,
        isCollapsed,
        hasPapersOrChildren,
        paperCount: projectPapers.length,
        isPaperDropTarget: isPDT,
      });

      if (!isCollapsed) {
        for (const child of children) {
          flattenProject(child, depth + 1);
        }
        for (const paper of projectPapers) {
          rows.push({ kind: "paper", paper, indent: 12 + (depth + 1) * 16 });
        }
      }
    };

    for (const p of rootProjects) {
      flattenProject(p, 0);
    }

    // Unassigned section — always show when there are unassigned papers OR when dragging
    if (unassignedPapers.length > 0 || draggingPaperId) {
      rows.push({ kind: "unassigned-header", isDropTarget: isUnassignedDropTarget });
      for (const paper of unassignedPapers) {
        rows.push({ kind: "paper", paper, indent: 20 });
      }
    }

    return rows;
  }, [
    allFilteredCount, rootProjects, projects, papers, collapsedProjects,
    paperDropTarget, draggingPaperId, unassignedPapers,
    getFilteredPapers,
  ]);

  // Visible paper order — what Shift+click ranges span.
  const visiblePaperIds = useMemo(
    () => flatRows.flatMap((r) => (r.kind === "paper" ? [r.paper.id] : [])),
    [flatRows]
  );

  const selectRange = (toId: string) => {
    const anchor = selectionAnchorRef.current ?? activePaperId;
    const a = anchor ? visiblePaperIds.indexOf(anchor) : -1;
    const b = visiblePaperIds.indexOf(toId);
    if (a === -1 || b === -1) {
      onSetSelection(new Set([toId]));
      selectionAnchorRef.current = toId;
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    onSetSelection(new Set(visiblePaperIds.slice(lo, hi + 1)));
  };

  // ── Paper item renderer ──

  const renderPaperItem = (paper: Paper, indent = 28) => {
    const isActive = activePaperId === paper.id;
    const isSelected = selectedIds.has(paper.id);
    const isEditingThis = editingPaperId === paper.id;
    const isDraggingThis = draggingPaperId === paper.id;
    const dotColor = statusDot[paper.status] ?? "text-text-tertiary";

    const isSwiping = swipe?.paperId === paper.id;
    const swipeDx = isSwiping ? swipe.dx : swipeOpenId === paper.id ? -SWIPE_REVEAL : 0;
    const next = nextStatus(paper.status);
    const nextHex = statusHex[next];

    return (
      <div className="relative overflow-hidden rounded">
        {/* Revealed under the row while it is swiped */}
        {swipeDx < 0 && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center justify-center gap-1 bg-status-revisit text-white text-caption font-bold"
            style={{ width: SWIPE_REVEAL, opacity: Math.min(1, -swipeDx / SWIPE_REVEAL) }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSwipeOpenId(null); handleDeletePapers([paper.id]); }}
            title="Delete paper"
          >
            🗑 Delete
          </button>
        )}
        {swipeDx > 0 && (
          <div
            className="absolute inset-y-0 left-0 flex items-center pl-2 text-caption font-bold whitespace-nowrap"
            style={{
              width: SWIPE_MAX + 8,
              background: `${nextHex}33`,
              color: nextHex,
              opacity: Math.min(1, swipeDx / SWIPE_ACT),
            }}
          >
            → {next}
          </div>
        )}

        <div
          onMouseDown={(e) => !selectMode && !isEditingThis && onPaperMouseDown(e, paper.id)}
          onClick={(e) => {
            e.stopPropagation();
            if (isEditingThis) return;
            if (consumeGestureClick()) return;
            if (swipeOpenId) { setSwipeOpenId(null); return; }
            if (selectMode) { onToggleSelect(paper.id); return; }
            if (e.ctrlKey || e.metaKey) {
              onToggleSelect(paper.id);
              selectionAnchorRef.current = paper.id;
              return;
            }
            if (e.shiftKey) { selectRange(paper.id); return; }
            if (selectedIds.size > 0) onSetSelection(new Set());
            selectionAnchorRef.current = paper.id;
            setActivePaper(paper.id);
            lastSidebarClickRef.current = { type: "paper", id: paper.id };
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!selectMode && !e.ctrlKey && !e.shiftKey) startPaperRename(paper);
          }}
          onContextMenu={(e) => !selectMode && handlePaperContextMenu(e, paper.id)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer select-none ${
            isSwiping ? "" : "transition-[background-color,color,transform] duration-150"
          } ${
            isDraggingThis
              ? "opacity-40"
              : isSelected
                ? "bg-accent/10 text-accent"
                : isActive && !selectMode
                  ? "bg-bg-tertiary text-text-primary"
                  : "hover:bg-bg-tertiary text-text-secondary hover:text-text-primary"
          }`}
          style={{
            paddingLeft: `${indent}px`,
            transform: swipeDx ? `translateX(${swipeDx}px)` : undefined,
            // A translated row must cover the strip it slides over
            backgroundColor: swipeDx ? "var(--bg-secondary)" : undefined,
          }}
          title={paper.title}
        >
          {selectMode ? (
            <div className={`w-3.5 h-3.5 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
              isSelected ? "bg-accent border-accent" : "border-border bg-bg-tertiary"
            }`}>
              {isSelected && <span className="text-nano text-bg-primary font-bold leading-none">✓</span>}
            </div>
          ) : (
            <span className="text-small flex-shrink-0">📄</span>
          )}

          {isEditingThis ? (
            <input
              ref={paperInputRef}
              value={editPaperTitle}
              onChange={(e) => setEditPaperTitle(e.target.value)}
              onBlur={commitPaperRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.stopPropagation(); commitPaperRename(); }
                if (e.key === "Escape") { e.stopPropagation(); setEditingPaperId(null); }
              }}
              onClick={(e) => e.stopPropagation()}
              className="bg-bg-tertiary text-text-primary text-body border border-accent rounded px-1 py-0 outline-none flex-1 min-w-0 selectable"
            />
          ) : (
            <span className="truncate text-body flex-1 min-w-0">{paper.title}</span>
          )}

          <span className={`text-nano flex-shrink-0 ${dotColor}`}>●</span>
        </div>
      </div>
    );
  };

  // ── Virtual scroller ──

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  const menuTargets = paperContextMenu?.targetIds ?? [];
  const menuTargetPapers = menuTargets
    .map((id) => papers.find((p) => p.id === id))
    .filter((p): p is Paper => !!p);
  // Folder the targets already live in (only when they all share one) —
  // shown as the current location and not offered as a destination.
  const menuCurrentProject = menuTargetPapers.length > 0
    && menuTargetPapers.every((p) => p.project_id === menuTargetPapers[0].project_id)
    ? menuTargetPapers[0].project_id
    : undefined;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
          Projects
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleNewFolder(null)}
            className="flex items-center gap-0.5 text-text-tertiary hover:text-accent transition-colors"
            title="New folder"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 3.5C1 2.95 1.45 2.5 2 2.5h3l1 1.5h5c.55 0 1 .45 1 1v5c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M6.5 6v3M5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            onClick={() => emitMenuEvent("import-pdf")}
            className="flex items-center gap-0.5 text-text-tertiary hover:text-accent transition-colors"
            title="Import PDF (Ctrl+O)"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 1.5h5l3 3v7c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9c0-.55.45-1 1-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M8 1.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M6.5 6v3M5 7.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Tree — virtualized scrollable */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-1"
        onContextMenu={(e) => handleProjectContextMenu(e, null)}
        onClick={() => { setProjectContextMenu(null); setPaperContextMenu(null); setSwipeOpenId(null); }}
      >
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.kind === "all-papers" && (
                  <div
                    className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer text-body transition-colors duration-150 ${
                      selectedProjectId === null ? "bg-bg-tertiary text-text-primary" : "hover:bg-bg-tertiary text-text-secondary"
                    }`}
                    onClick={(e) => { e.stopPropagation(); setSelectedProject(null); }}
                  >
                    <span className="text-caption text-text-tertiary w-3">◉</span>
                    <span>All Papers</span>
                    {row.count > 0 && (
                      <span className="text-caption text-text-tertiary ml-auto">{row.count}</span>
                    )}
                  </div>
                )}

                {row.kind === "project" && (() => {
                  const { project, depth, isCollapsed, hasPapersOrChildren, paperCount, isPaperDropTarget: isPDT } = row;
                  const isEditing = editingId === project.id;
                  const isSelected = selectedProjectId === project.id;
                  const isDragOver = dragOverId === project.id;
                  const isDragging = draggingId === project.id;

                  return (
                    <div
                      onMouseDown={(e) => !isEditing && handleMouseDown(e, project.id)}
                      onMouseEnter={() => { handleMouseEnter(project.id); onDropZoneEnter(project.id); }}
                      className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer group transition-colors duration-150 ${
                        isPDT
                          ? "bg-accent/15 border border-accent/60"
                          : isDragOver
                            ? "bg-accent/10 border border-accent"
                            : isDragging
                              ? "opacity-50"
                              : isSelected
                                ? "bg-bg-tertiary text-text-primary"
                                : "hover:bg-bg-tertiary text-text-secondary"
                      }`}
                      style={{ paddingLeft: `${8 + depth * 16}px` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!draggingId) {
                          setSelectedProject(project.id);
                          lastSidebarClickRef.current = { type: "project", id: project.id };
                          if (hasPapersOrChildren) toggleCollapse(project.id);
                        }
                      }}
                      onContextMenu={(e) => handleProjectContextMenu(e, project.id)}
                    >
                      <span className="text-caption text-text-tertiary w-3 flex-shrink-0">
                        {hasPapersOrChildren ? (isCollapsed ? "▸" : "▾") : ""}
                      </span>
                      <span className="text-small flex-shrink-0">📁</span>
                      {isEditing ? (
                        <input
                          ref={projectInputRef}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={commitProjectRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitProjectRename();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-bg-tertiary text-text-primary text-body border border-accent rounded px-1 py-0 outline-none flex-1 min-w-0 selectable"
                        />
                      ) : (
                        <span className="truncate flex-1 min-w-0">
                          <span className="text-body" onDoubleClick={() => handleRenameProject(project)}>
                            {project.name}
                          </span>
                          {project.folder_path && (
                            <span className="ml-1 text-micro text-accent/60" title={project.folder_path}>📁</span>
                          )}
                        </span>
                      )}
                      {paperCount > 0 && !isPDT && (
                        <span className="text-caption text-text-tertiary flex-shrink-0 ml-1">{paperCount}</span>
                      )}
                      {isPDT && (
                        <span className="text-caption text-accent flex-shrink-0 ml-1">↓</span>
                      )}
                    </div>
                  );
                })()}

                {row.kind === "paper" && renderPaperItem(row.paper, row.indent)}

                {row.kind === "unassigned-header" && (
                  <div
                    onMouseEnter={() => onDropZoneEnter(UNASSIGNED_TARGET)}
                    className={`flex items-center gap-1 px-2 py-1 mt-1 rounded transition-colors ${
                      row.isDropTarget ? "bg-accent/10 border border-accent/40" : ""
                    }`}
                  >
                    <span className="w-3 text-caption text-text-tertiary">—</span>
                    <span className="text-caption font-bold uppercase tracking-wider text-text-tertiary">
                      {row.isDropTarget ? "Drop to unassign" : "Unassigned"}
                    </span>
                  </div>
                )}

              </div>
            );
          })}
        </div>
      </div>

      {/* Project context menu */}
      {projectContextMenu && (
        <ClampedMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          className="fixed z-50 bg-bg-secondary border border-border rounded-[8px] py-1 shadow-lg min-w-[160px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
            onClick={() => handleNewFolder(projectContextMenu.projectId)}>
            New Folder
          </button>
          {projectContextMenu.projectId && (
            <>
              <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
                onClick={() => { const p = projects.find((p) => p.id === projectContextMenu.projectId); if (p) handleRenameProject(p); }}>
                Rename
              </button>
              <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
                onClick={() => handleSetFolder(projectContextMenu.projectId!)}>
                {(() => { const p = projects.find((p) => p.id === projectContextMenu.projectId); return p?.folder_path ? "Change PDF Folder…" : "Set PDF Folder…"; })()}
              </button>
              {(() => {
                const p = projects.find((p) => p.id === projectContextMenu.projectId);
                return p?.folder_path ? (
                  <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-tertiary transition-colors"
                    onClick={() => { setProjectFolder(projectContextMenu.projectId!, ""); setProjectContextMenu(null); }}>
                    Clear PDF Folder
                  </button>
                ) : null;
              })()}
              <div className="border-t border-border my-1" />
              <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-status-revisit transition-colors"
                onClick={() => handleDeleteProject(projectContextMenu.projectId!)}>
                Delete Folder
              </button>
            </>
          )}
        </ClampedMenu>
      )}

      {/* Paper drag ghost */}
      {ghostPos && draggingPaperId && (() => {
        const n = selectedIds.has(draggingPaperId) ? selectedIds.size : 1;
        return (
          <div
            className="fixed z-[9999] pointer-events-none bg-bg-secondary border border-accent/60 rounded px-2 py-1 text-body text-text-primary opacity-80 max-w-[200px] truncate shadow-lg"
            style={{ left: ghostPos.x, top: ghostPos.y }}
          >
            📄 {n > 1 ? `${n} papers` : (papers.find((p) => p.id === draggingPaperId)?.title ?? "")}
          </div>
        );
      })()}

      {/* Paper context menu */}
      {paperContextMenu && (
        <ClampedMenu
          x={paperContextMenu.x}
          y={paperContextMenu.y}
          className="fixed z-50 bg-bg-secondary border border-border rounded-[8px] py-1 shadow-lg min-w-[200px] max-w-[300px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-caption font-bold uppercase tracking-wider text-text-tertiary">
            {menuTargets.length > 1 ? `Move ${menuTargets.length} papers to` : "Move to"}
          </div>
          <MoveTarget
            label="Unassigned"
            icon="—"
            depth={0}
            isCurrent={menuCurrentProject === null}
            onPick={() => handleMovePapers(menuTargets, null)}
          />
          <MoveTree
            projects={projects}
            parentId={null}
            depth={0}
            currentProjectId={menuCurrentProject}
            onPick={(id) => handleMovePapers(menuTargets, id)}
          />
          <div className="border-t border-border my-1" />
          {menuTargets.length === 1 && (
            <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
              onClick={() => { const p = papers.find((p) => p.id === paperContextMenu.paperId); if (p) startPaperRename(p); }}>
              Rename
            </button>
          )}
          <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-status-revisit transition-colors"
            onClick={() => handleDeletePapers(menuTargets)}>
            {menuTargets.length > 1 ? `Delete ${menuTargets.length} Papers` : "Delete Paper"}
          </button>
        </ClampedMenu>
      )}
    </div>
  );
}

// ── Move-to folder tree ──────────────────────────────────────────────────────
// Mirrors the sidebar's folder hierarchy: each nesting level is indented and
// hangs off a guide line, so "KIST ▸ RFP ▸ paper" reads as a path at a glance.

function MoveTarget({
  label,
  icon,
  depth,
  isCurrent,
  onPick,
}: {
  label: string;
  icon: string;
  depth: number;
  isCurrent: boolean;
  onPick: () => void;
}) {
  return (
    <button
      disabled={isCurrent}
      onClick={onPick}
      className={`w-full text-left pr-3 py-1 flex items-center gap-1.5 text-body transition-colors ${
        isCurrent
          ? "text-text-tertiary cursor-default"
          : "text-text-primary hover:bg-bg-tertiary"
      }`}
      style={{ paddingLeft: depth === 0 ? 12 : 8 }}
      title={isCurrent ? "Current folder" : undefined}
    >
      <span className={`flex-shrink-0 ${icon === "—" ? "text-text-tertiary w-3 text-center" : "text-small"}`}>{icon}</span>
      <span className="truncate flex-1 min-w-0">{label}</span>
      {isCurrent && <span className="text-caption text-text-tertiary flex-shrink-0">current</span>}
    </button>
  );
}

function MoveTree({
  projects,
  parentId,
  depth,
  currentProjectId,
  onPick,
}: {
  projects: Project[];
  parentId: string | null;
  depth: number;
  currentProjectId: string | null | undefined;
  onPick: (projectId: string) => void;
}) {
  const children = projects.filter((p) => p.parent_id === parentId);
  if (children.length === 0) return null;
  return (
    <div className={depth > 0 ? "ml-[18px] border-l border-border/70" : ""}>
      {children.map((p) => (
        <Fragment key={p.id}>
          <MoveTarget
            label={p.name}
            icon="📁"
            depth={depth}
            isCurrent={currentProjectId === p.id}
            onPick={() => onPick(p.id)}
          />
          <MoveTree
            projects={projects}
            parentId={p.id}
            depth={depth + 1}
            currentProjectId={currentProjectId}
            onPick={onPick}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ClampedMenu({
  x,
  y,
  children,
  className,
  onClick,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const rect = el.getBoundingClientRect();
    if (y + rect.height > window.innerHeight - margin) {
      el.style.top = `${Math.max(margin, window.innerHeight - rect.height - margin)}px`;
    }
    if (x + rect.width > window.innerWidth - margin) {
      el.style.left = `${Math.max(margin, window.innerWidth - rect.width - margin)}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        left: x,
        top: y,
        maxHeight: "calc(100vh - 40px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
