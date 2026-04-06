import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useProjectsStore } from "../../stores/projects";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";
import { useDragReorder } from "../../hooks/useDragReorder";
import { usePaperDrag, PAPER_DRAG_UNASSIGNED } from "../../hooks/usePaperDrag";
import { onMenuEvent } from "../../lib/menuEvents";
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

const UNASSIGNED_TARGET = PAPER_DRAG_UNASSIGNED;

interface ProjectTreeProps {
  statusFilter: string | null;
  importanceFilter: string | null;
  sortBy: string;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  searchQuery: string;
}

interface PaperContextMenu {
  x: number;
  y: number;
  paperId: string;
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
  searchQuery,
}: ProjectTreeProps) {
  const { projects, fetchProjects, createProject, renameProject, deleteProject, reorderProjects, setProjectFolder } =
    useProjectsStore();
  const { papers, fetchPapers, updatePaper, deletePaper } = usePapersStore();
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

  // Collapse state
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  // Paper drag (mouse-event based)
  const { draggingPaperId, paperDropTarget, ghostPos, onPaperMouseDown, onDropZoneEnter } =
    usePaperDrag(useCallback((paperId, projectId) => updatePaper(paperId, { project_id: projectId }), [updatePaper]));

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
    setPaperContextMenu({ x: e.clientX, y: e.clientY, paperId });
  };

  const handleMovePaper = async (paperId: string, projectId: string | null) => {
    setPaperContextMenu(null);
    await updatePaper(paperId, { project_id: projectId });
  };

  const handleDeletePaper = async (paperId: string) => {
    setPaperContextMenu(null);
    const paper = papers.find((p) => p.id === paperId);
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const confirmed = await ask(
      `Delete "${paper?.title ?? "this paper"}"?\n\nAll notes, highlights, and memos will be permanently removed. The PDF file itself will not be deleted.\n\nThis cannot be undone.`,
      { title: "Delete Paper", kind: "warning" }
    );
    if (!confirmed) return;
    if (activePaperId === paperId) setActivePaper(null);
    await deletePaper(paperId);
  };


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

  // ── Paper item renderer ──

  const renderPaperItem = (paper: Paper, indent = 28) => {
    const isActive = activePaperId === paper.id;
    const isSelected = selectedIds.has(paper.id);
    const isEditingThis = editingPaperId === paper.id;
    const isDraggingThis = draggingPaperId === paper.id;
    const dotColor = statusDot[paper.status] ?? "text-text-tertiary";

    return (
      <div
        onMouseDown={(e) => !selectMode && !isEditingThis && onPaperMouseDown(e, paper.id)}
        onClick={(e) => {
          e.stopPropagation();
          if (isEditingThis) return;
          if (selectMode) onToggleSelect(paper.id);
          else {
            setActivePaper(paper.id);
            lastSidebarClickRef.current = { type: "paper", id: paper.id };
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!selectMode) startPaperRename(paper);
        }}
        onContextMenu={(e) => !selectMode && handlePaperContextMenu(e, paper.id)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors duration-150 select-none ${
          isDraggingThis
            ? "opacity-40"
            : isSelected
              ? "bg-accent/10 text-accent"
              : isActive && !selectMode
                ? "bg-bg-tertiary text-text-primary"
                : "hover:bg-bg-tertiary text-text-secondary hover:text-text-primary"
        }`}
        style={{ paddingLeft: `${indent}px` }}
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
    );
  };

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

  // ── Virtual scroller ──

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
          Projects
        </span>
        <button
          onClick={() => handleNewFolder(null)}
          className="text-text-tertiary hover:text-accent text-body transition-colors"
          title="New folder"
        >
          +
        </button>
      </div>

      {/* Tree — virtualized scrollable */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-1"
        onContextMenu={(e) => handleProjectContextMenu(e, null)}
        onClick={() => { setProjectContextMenu(null); setPaperContextMenu(null); }}
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
        <div
          className="fixed z-50 bg-bg-secondary border border-border rounded-[8px] py-1 shadow-lg min-w-[160px]"
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
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
        </div>
      )}

      {/* Paper drag ghost */}
      {ghostPos && draggingPaperId && (
        <div
          className="fixed z-[9999] pointer-events-none bg-bg-secondary border border-accent/60 rounded px-2 py-1 text-body text-text-primary opacity-80 max-w-[200px] truncate shadow-lg"
          style={{ left: ghostPos.x, top: ghostPos.y }}
        >
          📄 {papers.find((p) => p.id === draggingPaperId)?.title ?? ""}
        </div>
      )}

      {/* Paper context menu */}
      {paperContextMenu && (
        <div
          className="fixed z-50 bg-bg-secondary border border-border rounded-[8px] py-1 shadow-lg min-w-[180px]"
          style={{ left: paperContextMenu.x, top: paperContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-caption font-bold uppercase tracking-wider text-text-tertiary">
            Move to
          </div>
          <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-secondary transition-colors"
            onClick={() => handleMovePaper(paperContextMenu.paperId, null)}>
            — Unassigned
          </button>
          {projects.map((proj) => (
            <button
              key={proj.id}
              className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
              style={{ paddingLeft: proj.parent_id ? "28px" : "12px" }}
              onClick={() => handleMovePaper(paperContextMenu.paperId, proj.id)}
            >
              📁 {proj.name}
            </button>
          ))}
          <div className="border-t border-border my-1" />
          <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-text-primary transition-colors"
            onClick={() => { const p = papers.find((p) => p.id === paperContextMenu.paperId); if (p) startPaperRename(p); }}>
            Rename
          </button>
          <button className="w-full text-left px-3 py-1.5 text-body hover:bg-bg-tertiary text-status-revisit transition-colors"
            onClick={() => handleDeletePaper(paperContextMenu.paperId)}>
            Delete Paper
          </button>
        </div>
      )}
    </div>
  );
}
